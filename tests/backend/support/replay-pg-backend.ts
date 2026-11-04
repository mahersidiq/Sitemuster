import type { Client } from 'pg';

import {
  applyVisitorOperation,
  type AttendanceConfig,
  type AttendanceStore,
  changesetFromOutput,
  type EngineOutput,
  type ItemResult,
  type ProjectContext,
  type ReceiptRow,
  type ServiceRpc,
  type SessionRecord,
  sha256Hex,
  type TrackLoad,
  trackLoadFromJson,
  type TrackState,
  type VisitorEvent,
  type VisitRecord,
} from '@sitemuster/shared';

import type {
  BackendSnapshot,
  Eligibility,
  ServerBackend,
  StoredPosition,
} from '../../location-replay/harness/backend';

/**
 * Replay backend over the REAL local Postgres (decision #80). Everything a fixture does runs in one
 * transaction that is rolled back afterwards, so fixtures never collide. The attendance engine
 * talks to the database exactly like an Edge Function would: through the service-role RPCs
 * `edge_attendance_load` / `edge_attendance_commit`, and time passes through the SQL sweep
 * `edge_attendance_sweep` — so every fixture also proves TypeScript ↔ SQL parity of the time rules.
 * World setup (organizations, projects, enrollments, devices) is plain SQL as the test superuser.
 */
type Json = Record<string, unknown>;

function settingsOf(config: AttendanceConfig): Json {
  return {
    geofence_radius_m: config.radiusM,
    exit_hysteresis_m: config.exitHysteresisM,
    entry_dwell_seconds: config.entryDwellSeconds,
    max_horizontal_accuracy_m: config.maxHorizontalAccuracyM,
    location_fresh_seconds: config.locationFreshSeconds,
    presence_unknown_seconds: config.presenceUnknownSeconds,
    queue_auto_reconcile_age_hours: config.lateReviewHours,
    max_device_clock_skew_seconds: config.maxClockSkewSeconds,
    work_window_grace_minutes: config.workWindowGraceMinutes,
    shift_closeout_grace_minutes: config.closeoutGraceMinutes,
    always_open_24h_review_open_hours: config.alwaysOpenReviewHours,
    operates_24_7: config.operates24x7,
    work_windows: config.windows.map((window) => ({
      ...window,
      crosses_midnight: window.local_end_time < window.local_start_time,
    })),
  };
}

export class PgReplayBackend implements ServerBackend, AttendanceStore {
  readonly mode = 'database' as const;
  private ownerId = '';
  private orgId = '';
  private companyId = '';
  private noticeId = '';
  private readonly workers = new Set<string>();
  private readonly enrolled = new Set<string>();
  private readonly visitors = new Map<string, string>();

  constructor(
    private readonly db: Client,
    private readonly seed: string,
    /** false = every call commits on its own, like PostgREST (used by the race test). */
    private readonly transactional = true,
  ) {}

  get store(): AttendanceStore {
    return this;
  }

  private id(name: string): string {
    const hex = sha256Hex(`replay-db|${this.seed}|${name}`).slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  private async service<T>(sql: string, params: unknown[]): Promise<T> {
    await this.db.query(
      this.transactional ? 'set local role service_role' : 'set role service_role',
    );
    try {
      const result = await this.db.query<{ value: T }>(sql, params);
      return result.rows[0]?.value as T;
    } finally {
      await this.db.query('reset role');
    }
  }

  async begin(): Promise<void> {
    if (this.transactional) await this.db.query('begin');
    this.ownerId = this.id('owner');
    this.orgId = this.id('org');
    this.companyId = this.id('company');
    await this.db.query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), '{}', '{}', now(), now())`,
      [this.ownerId, `replay-${this.ownerId.slice(0, 8)}@example.test`],
    );
    await this.db.query(
      'insert into public.organizations (id, name, owner_user_id, idempotency_key) values ($1, $2, $3, gen_random_uuid())',
      [this.orgId, 'Replay GC', this.ownerId],
    );
    await this.db.query(
      "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER')",
      [this.orgId, this.ownerId],
    );
    await this.db.query(
      "insert into public.subcontractor_companies (id, canonical_name) values ($1, 'Replay Concrete')",
      [this.companyId],
    );
    const notice = await this.db.query<{ id: string }>(
      "select id from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_EN_V1'",
    );
    this.noticeId = notice.rows[0]?.id ?? '';
  }

  async close(): Promise<void> {
    if (this.transactional) await this.db.query('rollback');
  }

  /** A second connection acting on the same committed world (autocommit mode only). */
  sharing(db: Client): PgReplayBackend {
    const twin = new PgReplayBackend(db, this.seed, false);
    twin.ownerId = this.ownerId;
    return twin;
  }

  async createProject(project: ProjectContext, first: AttendanceConfig): Promise<void> {
    await this.db.query(
      'insert into public.projects (id, organization_id, name, iana_timezone, status, idempotency_key) values ($1, $2, $3, $4, $5, gen_random_uuid())',
      [project.id, this.orgId, 'Replay site', project.timezone, project.status],
    );
    await this.db.query(
      "insert into public.project_subcontractors (project_id, subcontractor_id, status) values ($1, $2, 'APPROVED')",
      [project.id, this.companyId],
    );
    await this.addConfigVersion(first);
  }

  async addConfigVersion(config: AttendanceConfig): Promise<void> {
    await this.db.query(
      `insert into public.project_tracking_config_versions (id, project_id, version_number, effective_at, settings_json, operates_24_7)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        config.configVersionId,
        config.projectId,
        config.versionNumber,
        config.effectiveAt,
        JSON.stringify(settingsOf(config)),
        config.operates24x7,
      ],
    );
    await this.db.query(
      `insert into public.project_geofences (config_version_id, project_id, center, radius_m, exit_hysteresis_m, sdk_identifier)
       values ($1, $2, extensions.st_setsrid(extensions.st_makepoint($3, $4), 4326)::extensions.geography, $5, $6, $7)`,
      [
        config.configVersionId,
        config.projectId,
        config.center.lng,
        config.center.lat,
        config.radiusM,
        config.exitHysteresisM,
        `sm_${config.configVersionId.replace(/-/g, '')}`,
      ],
    );
    await this.db.query('update public.projects set config_version_id = $1 where id = $2', [
      config.configVersionId,
      config.projectId,
    ]);
  }

  async setProjectStatus(projectId: string, status: ProjectContext['status']): Promise<void> {
    await this.db.query('update public.projects set status = $1 where id = $2', [
      status,
      projectId,
    ]);
  }

  private async ensureWorker(workerId: string): Promise<void> {
    if (this.workers.has(workerId)) return;
    await this.db.query(
      "insert into public.worker_profiles (id, legal_name, managed_identity) values ($1, 'Replay worker', true)",
      [workerId],
    );
    await this.db.query(
      "insert into public.subcontractor_members (company_id, worker_profile_id, role, verification_status) values ($1, $2, 'WORKER', 'VERIFIED')",
      [this.companyId, workerId],
    );
    this.workers.add(workerId);
  }

  async enrollWorker(projectId: string, workerId: string, eligibility: Eligibility): Promise<void> {
    await this.ensureWorker(workerId);
    await this.db.query(
      'insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id) values ($1, $2, now(), $3)',
      [workerId, projectId, this.noticeId],
    );
    const approved = eligibility.eligible || eligibility.reason !== 'ENROLLMENT_NOT_APPROVED';
    const verified = eligibility.eligible || eligibility.reason === 'CONSENT_MISSING';
    await this.db.query(
      `insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, enrollment_status, employer_status,
                                              approved_by, approval_at, employer_confirmed_by, employer_confirmed_at)
       values ($1, $2, $3,
               (case when $4::boolean then 'APPROVED' else 'PENDING' end)::public.enrollment_status,
               (case when $5::boolean then 'VERIFIED' else 'PENDING_CONFIRMATION' end)::public.employer_status,
               $6::uuid, case when $4::boolean then now() end,
               case when $5::boolean then $6::uuid end, case when $5::boolean then now() end)`,
      [projectId, workerId, this.companyId, approved, verified, this.ownerId],
    );
    if (eligibility.eligible) {
      await this.db.query(
        "insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at) values ($1, $2, $3, 'en-US', 'DIGITAL', now())",
        [workerId, projectId, this.noticeId],
      );
    }
    this.enrolled.add(`${projectId}|${workerId}`);
  }

  async setEligibility(
    projectId: string,
    workerId: string,
    eligibility: Eligibility,
  ): Promise<void> {
    if (!this.enrolled.has(`${projectId}|${workerId}`)) {
      await this.enrollWorker(projectId, workerId, eligibility);
      return;
    }
    if (eligibility.eligible) {
      await this.db.query(
        `update public.worker_enrollments set enrollment_status = 'APPROVED', approval_at = coalesce(approval_at, now()),
                employer_status = 'VERIFIED', employer_confirmed_by = $3, employer_confirmed_at = coalesce(employer_confirmed_at, now())
          where project_id = $1 and worker_id = $2 and enrollment_status in ('PENDING', 'APPROVED')`,
        [projectId, workerId, this.ownerId],
      );
      await this.db.query(
        `insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at)
         select $1, $2, $3, 'en-US', 'DIGITAL', now()
          where not exists (select 1 from public.tracking_consents where worker_id = $1 and project_id = $2 and withdrawn_at is null)`,
        [workerId, projectId, this.noticeId],
      );
    } else if (eligibility.reason === 'ENROLLMENT_NOT_APPROVED') {
      await this.db.query(
        "update public.worker_enrollments set enrollment_status = 'REVOKED', revoked_at = now() where project_id = $1 and worker_id = $2 and enrollment_status = 'APPROVED'",
        [projectId, workerId],
      );
    } else if (eligibility.reason === 'EMPLOYER_NOT_VERIFIED') {
      await this.db.query(
        "update public.worker_enrollments set employer_status = 'PENDING_CONFIRMATION', employer_confirmed_at = null, employer_confirmed_by = null where project_id = $1 and worker_id = $2",
        [projectId, workerId],
      );
    } else {
      await this.db.query(
        'update public.tracking_consents set withdrawn_at = now() where project_id = $1 and worker_id = $2 and withdrawn_at is null',
        [projectId, workerId],
      );
    }
  }

  async registerDevice(deviceId: string, workerId: string): Promise<void> {
    await this.ensureWorker(workerId);
    await this.db.query(
      "insert into public.device_installations (id, worker_id, platform, hardware_installation_hash, active) values ($1, $2, 'IOS', $3, true)",
      [deviceId, workerId, sha256Hex(deviceId)],
    );
  }

  async deactivateDevice(deviceId: string): Promise<void> {
    await this.db.query(
      'update public.device_installations set active = false, deactivated_at = now() where id = $1',
      [deviceId],
    );
  }

  async registerKiosk(kioskId: string, projectId: string): Promise<void> {
    await this.db.query(
      'insert into public.kiosk_devices (id, project_id, device_public_id) values ($1, $2, $3)',
      [kioskId, projectId, `replay-${kioskId}`],
    );
  }

  async load(
    projectId: string,
    workerId: string,
    eventUuids: readonly string[],
    sessionIds: readonly string[],
  ): Promise<TrackLoad> {
    const json = await this.service<Json>(
      'select public.edge_attendance_load($1, $2, $3, $4) as value',
      [projectId, workerId, eventUuids, sessionIds],
    );
    return trackLoadFromJson(json, projectId, workerId);
  }

  async commit(output: EngineOutput, expectedRevision: number): Promise<'ok' | 'conflict'> {
    return this.service<'ok' | 'conflict'>('select public.edge_attendance_commit($1) as value', [
      JSON.stringify(changesetFromOutput(output, expectedRevision)),
    ]);
  }

  async recordTerminals(
    requestId: string,
    rows: readonly ReceiptRow[],
    quarantine: readonly Record<string, unknown>[],
  ): Promise<void> {
    await this.service('select public.edge_record_location_terminals($1, $2, $3) as value', [
      requestId,
      JSON.stringify(rows),
      JSON.stringify(quarantine),
    ]);
  }

  async receiptOwners(eventUuids: readonly string[]): Promise<Map<string, string>> {
    if (eventUuids.length === 0) return new Map();
    const result = await this.db.query<{ event_uuid: string; device_id: string }>(
      'select event_uuid::text, device_id::text from app_private.location_event_receipts where event_uuid = any($1::uuid[])',
      [eventUuids],
    );
    return new Map(result.rows.map((row) => [row.event_uuid, row.device_id]));
  }

  async insertReceipts(rows: readonly ReceiptRow[]): Promise<void> {
    await this.service('select public.edge_insert_location_receipts($1) as value', [
      JSON.stringify(rows),
    ]);
  }

  async sweep(now: string): Promise<void> {
    await this.service('select public.edge_attendance_sweep($1) as value', [now]);
  }

  /** Service-role RPC by name with named arguments: the transport the Edge Functions use. */
  private readonly rpc: ServiceRpc = async (fn, args) => {
    const names = Object.keys(args);
    const placeholders = names.map((name, i) => name + ' => $' + String(i + 1)).join(', ');
    return this.service(
      'select public.' + fn + '(' + placeholders + ') as value',
      names.map((name) => {
        const value = args[name];
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      }),
    );
  };

  async visitorEvent(event: VisitorEvent): Promise<ItemResult> {
    let visitorId = this.visitors.get(event.visitorKey);
    if (!visitorId) {
      visitorId = this.id(`visitor|${event.visitorKey}`);
      await this.db.query(
        "insert into public.visitor_records (id, project_id, name, purpose) values ($1, $2, $3, 'Replay visit')",
        [visitorId, event.projectId, event.visitorKey.slice(0, 200)],
      );
      this.visitors.set(event.visitorKey, visitorId);
    }
    // The production path: edge_visitor_context → edge_visitor_load → rule → edge_visitor_commit.
    return applyVisitorOperation(this.rpc, {
      ...event,
      visitorKey: visitorId,
      actorId: null,
      kioskDeviceId: null,
    });
  }

  async snapshot(projectId: string): Promise<BackendSnapshot> {
    const workers = await this.db.query<{ worker_id: string }>(
      'select worker_id from public.presence_states where project_id = $1',
      [projectId],
    );
    const tracks: TrackState[] = [];
    for (const { worker_id: workerId } of workers.rows)
      tracks.push((await this.load(projectId, workerId, [], [])).state);
    const sessions = await this.db.query<{ s: Json }>(
      'select app_private.attendance_session_json(s) as s from public.attendance_sessions s where project_id = $1',
      [projectId],
    );
    const counts = await this.db.query<{ receipts: number; events: number }>(
      `select (select count(*)::int from app_private.location_event_receipts where project_id = $1) as receipts,
              (select count(*)::int from public.attendance_events where project_id = $1) as events`,
      [projectId],
    );
    const positions = await this.db.query<StoredPosition>(
      `select extensions.st_y(position::extensions.geometry) as lat, extensions.st_x(position::extensions.geometry) as lng,
              horizontal_accuracy_m::float8 as "accuracyM", observed_at as "observedAt", expiry_at as "expiryAt"
         from public.latest_onsite_positions where project_id = $1`,
      [projectId],
    );
    const visits = await this.service<VisitRecord[]>(
      'select public.edge_visitor_load($1) as value',
      [projectId],
    );
    return {
      tracks,
      sessions: sessions.rows.map((row) => ({ ...(row.s as unknown as SessionRecord) })),
      receipts: counts.rows[0]?.receipts ?? 0,
      events: counts.rows[0]?.events ?? 0,
      positions: positions.rows,
      visits,
    };
  }
}
