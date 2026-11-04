import {
  type AttendanceConfig,
  base64UrlDecode,
  base64UrlEncode,
  buildBadgePayload,
  configAt,
  configFromSettings,
  daySummary,
  DAY,
  DEFAULT_WORK_WINDOWS,
  deriveUuid,
  distanceMeters,
  type Evidence,
  HOUR,
  IngestOperationsResponseSchema,
  type OperationResult,
  iso,
  type ItemResult,
  type LocationTraceFixture,
  ms,
  projectCounts,
  type ProjectCounts,
  reconcile,
  type ReplayInput,
  selectNativeRegions,
  type SessionRecord,
  TRACKING_DEFAULTS,
  type TrackState,
  windowInstances,
  localDateOf,
  addDays,
  generateDayReports,
  reissueDayReport,
} from '@sitemuster/shared';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  developmentBadgeKey,
  encryptBadgeSecret,
} from '../../../supabase/functions/_shared/badge-crypto';
import {
  type DeviceAuthResult,
  handleIngest,
} from '../../../supabase/functions/_shared/ingest-core';
import {
  handleOperations,
  type OperationsDeps,
  type StoredReceipt,
} from '../../../supabase/functions/_shared/operations-core';
import type { Eligibility, ServerBackend } from './backend';

/**
 * LocationTraceReplayHarness (docs/spec/10-testing.md). Replays one fixture against the production
 * attendance code: the location ingest handler, the operations handler (kiosk, foreman, manual,
 * visitor — Milestone 08), the pure engine, the reconciler and a server backend (memory or the
 * real database). The phone, kiosks and foreman are simulated
 * from the spec (native queue, privacy egress gate, region budget, credentials, offline outbox);
 * their real native behaviour is a physical-device test (NOT_EXECUTED_PHYSICAL_DEVICE).
 * Time and randomness are frozen per fixture: no real clocks, no sleeps.
 */

const BUDGET_DEFAULT = TRACKING_DEFAULTS.ios_native_region_budget;
const CREDENTIAL_LIFETIME = TRACKING_DEFAULTS.device_upload_credential_lifetime_days * DAY;
const RENEW_BEFORE = TRACKING_DEFAULTS.device_upload_renew_before_expiry_days * DAY;
const EXPIRING_FLAG = TRACKING_DEFAULTS.credential_expiring_roster_flag_days * DAY;
const OVERLAP = TRACKING_DEFAULTS.device_upload_rotation_overlap_hours * HOUR;
const MAX_BATCH = TRACKING_DEFAULTS.location_ingest_max_batch_events;

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Deterministic PRNG (mulberry32) seeded from the fixture id. */
class Rng {
  private state: number;
  constructor(seed: string) {
    let h = 2166136261;
    for (const char of seed) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
    this.state = h >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => Math.floor(this.next() * 256));
  }
  uuid(): string {
    const hex = [...this.bytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
  }
}

interface ProjectSim {
  id: string;
  bound: boolean;
  versions: AttendanceConfig[];
  identifiers: Map<string, string>;
}

interface WorkerSim {
  key: string;
  id: string;
  eligibility: { enrollment_status: string; employer_status: string; consent: string };
  printedCode: string | null;
}

interface PhoneSim {
  deviceId: string;
  workerId: string;
  secret: Uint8Array;
  token: string;
  tokenExpiresAt: number;
  revoked: boolean;
  permission: 'ALWAYS' | 'WHEN_IN_USE' | 'NONE';
  precise: boolean;
  network: boolean;
  forceStopped: boolean;
  uploadBlocked: boolean;
  queue: Record<string, unknown>[];
  mode: Map<string, 'OFFSITE' | 'PENDING'>;
  positionCheckPending: boolean;
  forced: number[];
  monitored: Set<string>;
  lastPosition: { lat: number; lng: number } | null;
}

interface KioskOp {
  uuid: string;
  kind: 'DYNAMIC_APP' | 'PRINTED';
  payload: string;
  direction: 'ENTRY' | 'EXIT';
  observedAt: string;
}

interface KioskSim {
  id: string;
  online: boolean;
  offsetMs: number;
  outbox: KioskOp[];
}

export interface ReplayObservation {
  presence: string;
  session_count: number;
  arrival_at: string | null;
  departure_at: string | null;
  departure_earliest_at: string | null;
  departure_latest_at: string | null;
  counted_worker_count: number;
  unresolved_count: number;
  sessions: SessionRecord[];
  counts: ProjectCounts;
  flags: string[];
  results: Map<string, ItemResult>;
  rejected_reasons: string[];
  egress: {
    coordinate_records_sent: number;
    offsite_coordinate_records_sent: number;
    geofence_records_sent: number;
  };
  monitoring: string;
  device_status: string;
  queue_remaining: number;
  stored_positions: number;
  workers: Map<string, { presence: string; sessions: SessionRecord[] }>;
  other_project: { session_count: number; receipts: number } | null;
  visitors: { open: number; closed: number; unresolved: number };
  muster_responses_recorded: number;
  duplicate_responses: number;
  tracks: TrackState[];
  configVersionNumbers: Map<string, number>;
  timezone: string;
  now: string;
  presenceUnknownSeconds: number;
  /** Every stored report version; status as readers see it now (overdue = NOT_CONFIRMED). */
  reports: {
    local_date: string;
    version: number;
    status: string;
    workers: number;
    definite_seconds: number;
    uncertain_seconds: number;
    due_at: string;
  }[];
}

const WINDOWS_DEFAULT = DEFAULT_WORK_WINDOWS.map((w) => ({ ...w }));

export interface HarnessOptions {
  /** Order in which queued phone records are uploaded (the native SDK uses FIFO). */
  uploadOrder?: 'fifo' | 'reverse' | 'shuffle';
  /** Records per upload (the SDK sends up to 25). */
  batchSize?: number;
}

export class ReplayHarness {
  private readonly rng: Rng;
  private readonly orderRng: Rng;
  private duplicateResponses = 0;
  private now: number;
  private readonly project: ProjectSim;
  private readonly projects = new Map<string, ProjectSim>();
  private readonly workers = new Map<string, WorkerSim>();
  private phone: PhoneSim | null = null;
  private readonly oldPhones: PhoneSim[] = [];
  private readonly kiosks = new Map<string, KioskSim>();
  private readonly credentials = new Map<
    string,
    { deviceId: string; expiresAt: number; revokedAt: number | null }
  >();
  private readonly tokenByHash = new Map<string, string>();
  private readonly devices = new Map<
    string,
    { workerId: string; active: boolean; ciphertext: Uint8Array }
  >();
  private readonly redemptions = new Map<string, string>();
  /** ingest-operations receipts (the production handler reads and writes them through deps). */
  private readonly outboxReceipts = new Map<string, StoredReceipt>();
  private readonly visitorProjects = new Map<string, string>();
  private projectStatus = 'ACTIVE';
  private readonly companyId: string;
  private readonly scanPayloads = new Map<string, string>();
  private readonly results = new Map<string, ItemResult>();
  private readonly sentCoordinates = new Set<string>();
  private readonly sentOffsite = new Set<string>();
  private readonly sentGeofence = new Set<string>();
  /** Privacy classification at capture time (a later unenrollment does not make it a leak). */
  private readonly capturedOffsite = new Set<string>();
  private musterResponses = 0;
  private readonly badgeKey = developmentBadgeKey();
  private readonly attendantId: string;
  private readonly foremanId: string;
  private readonly superId: string;
  private readonly timezone: string;

  constructor(
    private readonly fixture: LocationTraceFixture,
    private readonly backend: ServerBackend,
    private readonly options: HarnessOptions = {},
  ) {
    this.rng = new Rng(fixture.id);
    this.orderRng = new Rng(`${fixture.id}|order`);
    this.now = ms(fixture.clock_start_utc);
    this.timezone = fixture.project.timezone;
    this.attendantId = this.rng.uuid();
    this.foremanId = this.rng.uuid();
    this.superId = this.rng.uuid();
    this.companyId = deriveUuid('replay-company', fixture.id);
    this.project = { id: fixture.project.id, bound: true, versions: [], identifiers: new Map() };
  }

  // -------------------------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------------------------

  private config(
    project: ProjectSim,
    version: number,
    fields: {
      lat: number;
      lng: number;
      radius: number;
      dwell?: number;
      windows?: unknown[];
      operates24x7?: boolean;
    },
    effectiveAt: number,
  ): AttendanceConfig {
    const config = configFromSettings({
      configVersionId: deriveUuid('replay-config', `${this.fixture.id}|${project.id}|${version}`),
      projectId: project.id,
      versionNumber: version,
      effectiveAt: iso(effectiveAt),
      settings: {
        geofence_radius_m: fields.radius,
        entry_dwell_seconds: fields.dwell ?? TRACKING_DEFAULTS.entry_dwell_seconds,
        operates_24_7: fields.operates24x7 ?? false,
        work_windows: fields.windows ?? WINDOWS_DEFAULT,
      },
      center: { lat: fields.lat, lng: fields.lng },
    });
    project.identifiers.set(
      config.configVersionId,
      `sm_${config.configVersionId.replace(/-/g, '').slice(0, 24)}`,
    );
    return config;
  }

  private eligibilityOf(worker: WorkerSim): Eligibility {
    if (worker.eligibility.enrollment_status !== 'APPROVED')
      return { eligible: false, reason: 'ENROLLMENT_NOT_APPROVED' };
    if (worker.eligibility.employer_status !== 'VERIFIED')
      return { eligible: false, reason: 'EMPLOYER_NOT_VERIFIED' };
    if (worker.eligibility.consent !== 'VALID')
      return { eligible: false, reason: 'CONSENT_MISSING' };
    // Sessions record the employer at opening (company reports, Milestone 10).
    return { eligible: true, reason: null, employerId: this.companyId };
  }

  async setup(): Promise<void> {
    const f = this.fixture;
    const start = this.now - DAY;
    const main = this.config(
      this.project,
      f.project.config_version,
      {
        lat: f.project.lat,
        lng: f.project.lng,
        radius: f.project.radius_m,
        dwell: f.project.dwell_seconds,
        windows: f.project.work_windows,
        operates24x7: f.project.operates_24_7,
      },
      start,
    );
    this.project.versions.push(main);
    this.projects.set(this.project.id, this.project);
    await this.backend.createProject(
      { id: this.project.id, status: f.project.status ?? 'ACTIVE', timezone: this.timezone },
      main,
    );

    for (const other of f.other_projects ?? []) {
      const sim: ProjectSim = {
        id: other.id,
        bound: other.bound ?? true,
        versions: [],
        identifiers: new Map(),
      };
      const config = this.config(
        sim,
        1,
        { lat: other.lat, lng: other.lng, radius: other.radius_m },
        start,
      );
      sim.versions.push(config);
      this.projects.set(sim.id, sim);
      await this.backend.createProject(
        { id: sim.id, status: 'ACTIVE', timezone: this.timezone },
        config,
      );
    }
    for (let i = 0; i < (f.device?.extra_enrolled_projects ?? 0); i += 1) {
      const id = deriveUuid('replay-extra-project', `${f.id}|${i}`);
      const sim: ProjectSim = { id, bound: true, versions: [], identifiers: new Map() };
      const config = this.config(
        sim,
        1,
        { lat: f.project.lat + 0.05 * (i + 1), lng: f.project.lng, radius: 150 },
        start,
      );
      sim.versions.push(config);
      this.projects.set(id, sim);
      await this.backend.createProject({ id, status: 'ACTIVE', timezone: this.timezone }, config);
    }

    const primary: WorkerSim = {
      key: 'A',
      id: deriveUuid('replay-worker', `${f.id}|A`),
      eligibility: {
        enrollment_status: f.worker?.enrollment_status ?? 'APPROVED',
        employer_status: f.worker?.employer_status ?? 'VERIFIED',
        consent: f.worker?.consent ?? 'VALID',
      },
      printedCode: f.worker?.printed_badge ? this.printedCode() : null,
    };
    this.workers.set('A', primary);
    for (const other of f.other_workers ?? []) {
      this.workers.set(other.key, {
        key: other.key,
        id: deriveUuid('replay-worker', `${f.id}|${other.key}`),
        eligibility: {
          enrollment_status: other.enrollment_status ?? 'APPROVED',
          employer_status: other.employer_status ?? 'VERIFIED',
          consent: other.consent ?? 'VALID',
        },
        printedCode: other.printed_badge ? this.printedCode() : null,
      });
    }
    for (const worker of this.workers.values()) {
      for (const project of this.projects.values()) {
        if (!project.bound) continue;
        const eligibility =
          project.id === this.project.id
            ? this.eligibilityOf(worker)
            : { eligible: true, reason: null };
        await this.backend.enrollWorker(project.id, worker.id, eligibility);
      }
    }
    if (f.worker?.has_phone !== false) {
      this.phone = await this.newPhone(
        primary,
        this.now - (f.device?.credential_age_days ?? 0) * DAY,
      );
      const armed = f.initial_state !== 'NOT_ARMED';
      this.phone.permission = armed ? 'ALWAYS' : 'NONE';
      this.reselectRegions();
    }
    for (const id of ['K1', 'K2']) {
      const kioskId = deriveUuid('replay-kiosk', `${f.id}|${id}`);
      await this.backend.registerKiosk(kioskId, this.project.id);
      this.kiosks.set(id, {
        id: kioskId,
        online: true,
        offsetMs: 0,
        outbox: [],
      });
    }
  }

  private printedCode(): string {
    return `SMP1.${[...this.rng.bytes(24)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32)}`;
  }

  private async newPhone(worker: WorkerSim, issuedAt: number): Promise<PhoneSim> {
    const deviceId = this.rng.uuid();
    const secret = this.rng.bytes(32);
    this.devices.set(deviceId, {
      workerId: worker.id,
      active: true,
      ciphertext: await encryptBadgeSecret(this.badgeKey, secret, deviceId),
    });
    await this.backend.registerDevice(deviceId, worker.id);
    const token = this.issueToken(deviceId, issuedAt);
    return {
      deviceId,
      workerId: worker.id,
      secret,
      token,
      tokenExpiresAt: issuedAt + CREDENTIAL_LIFETIME,
      revoked: false,
      permission: 'ALWAYS',
      precise: true,
      network: true,
      forceStopped: false,
      uploadBlocked: false,
      queue: [],
      mode: new Map(),
      positionCheckPending: false,
      forced: [],
      monitored: new Set(),
      lastPosition: null,
    };
  }

  private issueToken(deviceId: string, issuedAt: number): string {
    const token = base64UrlEncode(this.rng.bytes(32));
    this.tokenByHash.set(hexOf(sha256(base64UrlDecode(token))), token);
    this.credentials.set(token, {
      deviceId,
      expiresAt: issuedAt + CREDENTIAL_LIFETIME,
      revokedAt: null,
    });
    return token;
  }

  // -------------------------------------------------------------------------------------------
  // Phone model (Milestone 07 contract: native queue, privacy egress gate, region budget)
  // -------------------------------------------------------------------------------------------

  private armed(phone: PhoneSim): boolean {
    return (
      phone.permission === 'ALWAYS' && phone.precise && !phone.forceStopped && !phone.uploadBlocked
    );
  }

  private boundProjects(): ProjectSim[] {
    const worker = this.workers.get('A') as WorkerSim;
    return [...this.projects.values()].filter(
      (project) =>
        project.bound && (project.id !== this.project.id || this.eligibilityOf(worker).eligible),
    );
  }

  private currentConfig(project: ProjectSim): AttendanceConfig {
    return configAt(project.versions, iso(this.now)) as AttendanceConfig;
  }

  private reselectRegions(): void {
    const phone = this.phone;
    if (!phone) return;
    const candidates = this.boundProjects().map((project) => {
      const config = this.currentConfig(project);
      const next = windowInstances(
        config,
        this.timezone,
        addDays(localDateOf(this.now, this.timezone), -1),
        9,
      ).find((window) => window.end > this.now);
      return {
        projectId: project.id,
        distanceM: phone.lastPosition ? distanceMeters(phone.lastPosition, config.center) : null,
        activeSession: phone.mode.get(project.id) === 'PENDING',
        nextShiftInMs: config.operates24x7 ? 0 : next ? Math.max(0, next.start - this.now) : null,
      };
    });
    const budget = this.fixture.device?.region_budget ?? BUDGET_DEFAULT;
    phone.monitored = new Set(selectNativeRegions(candidates, budget).monitored);
  }

  private fenceContaining(
    point: { lat: number; lng: number },
    onlyMonitored: boolean,
  ): ProjectSim | null {
    const phone = this.phone;
    for (const project of this.boundProjects()) {
      if (onlyMonitored && phone && !phone.monitored.has(project.id)) continue;
      const config = this.currentConfig(project);
      if (distanceMeters(point, config.center) <= config.radiusM + config.exitHysteresisM)
        return project;
    }
    return null;
  }

  private insideAnyBoundFence(point: { lat: number; lng: number }): boolean {
    return this.boundProjects().some((project) =>
      project.versions.some(
        (config) => distanceMeters(point, config.center) <= config.radiusM + config.exitHysteresisM,
      ),
    );
  }

  private enqueue(record: Record<string, unknown>): void {
    const coords = record.coords as { latitude: number; longitude: number } | undefined;
    if (coords && !this.insideAnyBoundFence({ lat: coords.latitude, lng: coords.longitude })) {
      this.capturedOffsite.add(String(record.uuid));
    }
    this.phone?.queue.push(record);
  }

  private async flush(): Promise<void> {
    const phone = this.phone;
    if (!phone || phone.forceStopped || phone.uploadBlocked) return;
    while (phone.network && phone.queue.length > 0) {
      const size = Math.min(this.options.batchSize ?? MAX_BATCH, MAX_BATCH);
      const order = this.options.uploadOrder ?? 'fifo';
      let candidates = [...phone.queue];
      if (order === 'reverse') candidates.reverse();
      if (order === 'shuffle') {
        candidates = candidates
          .map((record) => ({ record, sort: this.orderRng.next() }))
          .sort((a, b) => a.sort - b.sort)
          .map(({ record }) => record);
      }
      const batch = candidates.slice(0, size);
      for (const record of batch) this.noteEgress(record);
      const forced = phone.forced.shift();
      if (forced !== undefined && forced !== 200) {
        if (forced === 401) {
          phone.uploadBlocked = true;
          return;
        }
        // 504: the server processed the batch but the reply was lost; the SDK will resend it.
        if (forced === 504) await this.ingest(phone.token, batch);
        return; // 429 / 503 / 504: the SDK keeps the batch and retries later
      }
      const response = await this.ingest(phone.token, batch);
      if (response.status === 401) {
        phone.uploadBlocked = true;
        return;
      }
      if (response.status !== 200) return; // 429 / 503: the SDK keeps the batch and retries
      phone.queue = phone.queue.filter((record) => !batch.includes(record));
    }
  }

  private noteEgress(record: Record<string, unknown>): void {
    const uuid = String(record.uuid);
    const coords = record.coords as { latitude: number; longitude: number } | undefined;
    if (record.event === 'geofence') this.sentGeofence.add(uuid);
    if (coords) {
      this.sentCoordinates.add(uuid);
      if (this.capturedOffsite.has(uuid)) this.sentOffsite.add(uuid);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Server side (production modules)
  // -------------------------------------------------------------------------------------------

  /**
   * Fences the server derives for this device (production rule, decision #89): the CURRENT
   * version of every bound project, plus the version of a still-open session.
   */
  private async fences(workerId: string) {
    const out = [];
    for (const project of this.boundProjects()) {
      const current = this.currentConfig(project);
      const track = await this.backend.store.load(project.id, workerId, [], []);
      const open = track.state.current;
      const versions = new Set([current.configVersionId]);
      if (open && ['OPEN', 'PENDING_APPROVAL', 'UNRESOLVED'].includes(open.status)) {
        versions.add(open.configVersionId);
      }
      for (const config of project.versions.filter((c) => versions.has(c.configVersionId))) {
        out.push({
          projectId: project.id,
          configVersionId: config.configVersionId,
          identifier: project.identifiers.get(config.configVersionId) as string,
          center: config.center,
          nativeRadiusM: config.radiusM + config.exitHysteresisM,
        });
      }
    }
    return out;
  }

  /** One native HTTP upload through the PRODUCTION ingest handler (ingest-location-batch). */
  private async ingest(
    token: string,
    batch: Record<string, unknown>[],
  ): Promise<{ status: number }> {
    const response = await handleIngest(
      new Request('http://replay.invalid/functions/v1/ingest-location-batch', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ locations: batch }),
      }),
      {
        now: () => iso(this.now),
        requestId: () => this.rng.uuid(),
        authenticate: async (hash): Promise<DeviceAuthResult> => {
          const presented = this.tokenByHash.get(hexOf(hash));
          const credential = presented ? this.credentials.get(presented) : undefined;
          if (!credential) return { status: 'INVALID' };
          const device = this.devices.get(credential.deviceId);
          if (credential.revokedAt !== null || !device?.active) return { status: 'REVOKED' };
          if (credential.expiresAt <= this.now) return { status: 'EXPIRED' };
          return {
            status: 'OK',
            device: {
              deviceId: credential.deviceId,
              workerId: device.workerId,
              coordinatesAllowed: true,
              fences: await this.fences(device.workerId),
            },
          };
        },
        rateLimit: async () => true,
        receipts: async (deviceId, uuids) => {
          const owners = await this.backend.receiptOwners(uuids);
          return new Map([...owners].map(([uuid, owner]) => [uuid, owner === deviceId]));
        },
        recordTerminals: (requestId, rows, quarantine) =>
          this.backend.recordTerminals(
            requestId,
            rows,
            quarantine as unknown as readonly Record<string, unknown>[],
          ),
        store: this.backend.store,
        onResults: (results) => {
          for (const result of results) this.record(result);
        },
      },
    );
    return { status: response.status };
  }

  private async applyServer(evidence: Evidence[]): Promise<void> {
    if (evidence.length === 0) return;
    const outcome = await reconcile(this.backend.store, evidence, iso(this.now));
    for (const result of outcome.values()) this.record(result);
  }

  /**
   * The production ingest-operations handler, as one signed-in role of the fixture world. Its
   * permission context mirrors operation_context: the attendant runs the kiosk and visitor desk,
   * the foreman signs their own company's crew, the superintendent corrects attendance.
   */
  private operationsDeps(role: 'ATTENDANT' | 'FOREMAN' | 'SUPER'): OperationsDeps {
    const actorId =
      role === 'ATTENDANT' ? this.attendantId : role === 'FOREMAN' ? this.foremanId : this.superId;
    const own = (projectId: string) => projectId === this.project.id;
    return {
      now: () => this.now,
      badgeKey: this.badgeKey,
      context: async (projectId) => ({
        userId: actorId,
        projectId: own(projectId) ? projectId : null,
        projectStatus: own(projectId) ? this.projectStatus : null,
        kiosk: role === 'ATTENDANT' && own(projectId) ? 'ALL' : null,
        visitors: role === 'ATTENDANT' && own(projectId),
        correct: role === 'SUPER' && own(projectId),
        foremanCompanyIds: role === 'FOREMAN' && own(projectId) ? [this.companyId] : [],
      }),
      rateLimit: async () => true,
      receipts: async (uuids) =>
        uuids.flatMap((id) => {
          const receipt = this.outboxReceipts.get(id);
          return receipt ? [receipt] : [];
        }),
      recordReceipts: async (_requestId, rows) => {
        for (const row of rows) {
          if (this.outboxReceipts.has(row.event_uuid)) continue;
          this.outboxReceipts.set(row.event_uuid, {
            eventUuid: row.event_uuid,
            actorId: row.actor_id,
            projectId: row.project_id,
            status: row.status,
            reason: row.reason,
            workerId: row.worker_id,
            children: row.children,
            review: row.review,
          });
        }
      },
      kiosk: async (kioskDeviceId) => {
        const kiosk = [...this.kiosks.values()].find((k) => k.id === kioskDeviceId);
        return kiosk ? { id: kiosk.id, projectId: this.project.id } : null;
      },
      loadBadgeDevice: async (deviceId) => {
        const device = this.devices.get(deviceId);
        return device
          ? { active: device.active, workerId: device.workerId, ciphertext: device.ciphertext }
          : null;
      },
      redeemBadgeStep: async ({ projectId, deviceId, timeStep, eventUuid }) => {
        const k = `${projectId}|${deviceId}|${timeStep}`;
        const owner = this.redemptions.get(k);
        if (owner === undefined) {
          this.redemptions.set(k, eventUuid);
          return 'accepted';
        }
        return owner === eventUuid ? 'duplicate' : 'replay';
      },
      printedBadge: async (hashHex) => {
        const worker = [...this.workers.values()].find(
          (w) =>
            w.printedCode &&
            bytesToHex(sha256(new TextEncoder().encode(w.printedCode))) === hashHex,
        );
        return worker ? { workerId: worker.id, active: true } : null;
      },
      workers: async (projectId, ids) =>
        ids.map((id) => {
          const sim = [...this.workers.values()].find((w) => w.id === id);
          const enrolled = !!sim && own(projectId);
          return {
            workerId: id,
            enrolled,
            approved: enrolled && sim.eligibility.enrollment_status === 'APPROVED',
            eligible: enrolled && this.eligibilityOf(sim).eligible,
            companyId: enrolled ? this.companyId : null,
          };
        }),
      registerVisitor: async ({ projectId, visitorId }) => {
        const owner = this.visitorProjects.get(visitorId);
        if (owner && owner !== projectId) return 'VISITOR_ID_CONFLICT';
        this.visitorProjects.set(visitorId, projectId);
        return 'ok';
      },
      applyVisitor: (input) =>
        this.backend.visitorEvent({
          eventUuid: input.eventUuid,
          projectId: input.projectId,
          visitorKey: input.visitorKey,
          direction: input.direction,
          observedAt: input.observedAt,
        }),
      store: this.backend.store,
    };
  }

  /** Posts operations through the production handler; null when nothing was acknowledged. */
  private async operate(
    role: 'ATTENDANT' | 'FOREMAN' | 'SUPER',
    events: Record<string, unknown>[],
    clockOffsetMs = 0,
  ): Promise<OperationResult[] | null> {
    const response = await handleOperations(
      new Request('https://replay.test/functions/v1/ingest-operations', {
        method: 'POST',
        headers: { authorization: 'Bearer replay', 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          client_sent_at: iso(this.now + clockOffsetMs),
          events,
        }),
      }),
      this.operationsDeps(role),
    );
    if (response.status !== 200) return null;
    const results = IngestOperationsResponseSchema.parse(await response.json()).results;
    for (const result of results) {
      this.record({
        eventUuid: result.event_uuid,
        status: result.status,
        reason: result.reason,
        review: result.review ?? false,
      });
      for (const child of result.children ?? []) {
        this.record({
          eventUuid: child.child_event_uuid,
          status: child.status,
          reason: child.reason,
          review: false,
        });
      }
    }
    return results;
  }

  private async syncKiosk(kiosk: KioskSim): Promise<void> {
    if (!kiosk.online || kiosk.outbox.length === 0) return;
    const events = kiosk.outbox.map((op) => ({
      event_uuid: op.uuid,
      project_id: this.project.id,
      operation_type: op.direction === 'ENTRY' ? 'KIOSK_ENTRY' : 'KIOSK_EXIT',
      observed_at: op.observedAt,
      payload: {
        badge_payload: op.payload,
        badge_kind: op.kind,
        kiosk_device_id: kiosk.id,
        direction: op.direction,
      },
    }));
    // The kiosk clock offset travels as the request's send time (decision #84).
    if ((await this.operate('ATTENDANT', events, kiosk.offsetMs)) !== null) kiosk.outbox = [];
  }

  /** Keeps the first terminal result per event; later duplicates are only counted. */
  private record(result: ItemResult): void {
    const existing = this.results.get(result.eventUuid);
    if (result.status === 'duplicate') this.duplicateResponses += 1;
    if (!existing) this.results.set(result.eventUuid, result);
  }

  private workerByKey(key: string | undefined): WorkerSim {
    const worker = this.workers.get(key ?? 'A');
    if (!worker) throw new Error(`fixture ${this.fixture.id}: unknown worker ${key}`);
    return worker;
  }

  private async sessionRef(
    worker: WorkerSim,
    ref: 'CURRENT' | 'LAST' | undefined,
  ): Promise<string | null> {
    if (!ref) return null;
    const snapshot = await this.backend.snapshot(this.project.id);
    if (ref === 'CURRENT') {
      return snapshot.tracks.find((track) => track.workerId === worker.id)?.current?.id ?? null;
    }
    const sessions = snapshot.sessions
      .filter((session) => session.workerId === worker.id && session.status !== 'VOID')
      .sort((a, b) => ms(b.startAt) - ms(a.startAt));
    return sessions[0]?.id ?? null;
  }

  private async newConfigVersion(
    fields: Partial<{
      radius: number;
      dwell: number;
      lat: number;
      lng: number;
      windows: unknown[];
      operates24x7: boolean;
      version: number;
    }>,
  ): Promise<void> {
    const latest = [...this.project.versions].sort(
      (a, b) => b.versionNumber - a.versionNumber,
    )[0] as AttendanceConfig;
    const config = this.config(
      this.project,
      fields.version ?? latest.versionNumber + 1,
      {
        lat: fields.lat ?? latest.center.lat,
        lng: fields.lng ?? latest.center.lng,
        radius: fields.radius ?? latest.radiusM,
        dwell: fields.dwell ?? latest.entryDwellSeconds,
        windows: fields.windows ?? latest.windows,
        operates24x7: fields.operates24x7 ?? latest.operates24x7,
      },
      this.now,
    );
    this.project.versions.push(config);
    await this.backend.addConfigVersion(config);
    this.reselectRegions();
  }

  private renew(phone: PhoneSim): boolean {
    const old = this.credentials.get(phone.token);
    if (!old || old.revokedAt !== null || phone.revoked) return false;
    const token = this.issueToken(phone.deviceId, this.now);
    old.expiresAt = Math.min(Math.max(old.expiresAt, this.now), this.now + OVERLAP); // 24 h overlap
    phone.token = token;
    phone.tokenExpiresAt = this.now + CREDENTIAL_LIFETIME;
    phone.uploadBlocked = false;
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------------------------

  async step(input: ReplayInput): Promise<void> {
    this.now = ms(input.at_utc);
    const phone = this.phone;
    const uuid = () =>
      'event_uuid' in input && input.event_uuid ? input.event_uuid : this.rng.uuid();
    switch (input.type) {
      case 'NETWORK_DOWN':
      case 'NETWORK_UP': {
        const up = input.type === 'NETWORK_UP';
        if (input.target === 'KIOSK') {
          for (const kiosk of this.kiosks.values()) {
            kiosk.online = up;
            if (up) await this.syncKiosk(kiosk);
          }
        } else if (phone) {
          phone.network = up;
          if (up) await this.flush();
        }
        break;
      }
      case 'PERMISSION_GRANTED': {
        if (!phone) break;
        phone.permission = input.level ?? 'ALWAYS';
        phone.precise = input.precise ?? true;
        this.enqueue({
          uuid: this.rng.uuid(),
          timestamp: input.at_utc,
          event: 'providerchange',
          provider: {
            enabled: true,
            gps: true,
            status: phone.permission === 'ALWAYS' ? 3 : 4,
            accuracyAuthorization: phone.precise ? 0 : 1,
          },
        });
        phone.positionCheckPending = this.armed(phone);
        this.reselectRegions();
        await this.flush();
        break;
      }
      case 'PERMISSION_REVOKED': {
        if (!phone) break;
        phone.permission = 'NONE';
        this.enqueue({
          uuid: this.rng.uuid(),
          timestamp: input.at_utc,
          event: 'providerchange',
          provider: { enabled: true, gps: true, status: 2 },
        });
        await this.flush();
        break;
      }
      case 'EVENT_ENTER':
      case 'EVENT_EXIT': {
        if (!phone) break;
        const target = this.projects.get(input.project_id ?? this.project.id);
        if (!target)
          throw new Error(`fixture ${this.fixture.id}: unknown project ${input.project_id}`);
        const forged = !target.bound; // a tampered client claiming another tenant's fence
        if (!forged && (!this.armed(phone) || !phone.monitored.has(target.id))) break;
        const config = this.currentConfig(target);
        const record: Record<string, unknown> = {
          uuid: uuid(),
          timestamp: input.at_utc,
          event: 'geofence',
          geofence: {
            identifier: target.identifiers.get(config.configVersionId),
            action: input.type === 'EVENT_ENTER' ? 'ENTER' : 'EXIT',
          },
          accuracy: input.accuracy_m ?? 20,
        };
        if (input.type === 'EVENT_EXIT' && input.leak_coordinates) {
          record.coords = {
            latitude: config.center.lat + 0.01,
            longitude: config.center.lng,
            accuracy: 10,
          };
        }
        phone.mode.set(target.id, input.type === 'EVENT_ENTER' ? 'PENDING' : 'OFFSITE');
        this.enqueue(record);
        await this.flush();
        break;
      }
      case 'FIX': {
        if (!phone) break;
        const point = { lat: input.lat, lng: input.lng };
        if (!input.force_transmit && !this.armed(phone)) break;
        const check = phone.positionCheckPending;
        if (check) {
          phone.positionCheckPending = false;
          phone.lastPosition = point;
          this.reselectRegions();
        }
        const fence = this.fenceContaining(point, true);
        const allowed =
          input.force_transmit === true ||
          (fence !== null && (check || phone.mode.get(fence.id) === 'PENDING'));
        if (fence && check) phone.mode.set(fence.id, 'PENDING');
        if (!allowed) break; // the privacy egress gate drops it on the phone
        phone.lastPosition = point;
        this.enqueue({
          uuid: uuid(),
          timestamp: input.device_clock_utc ?? input.at_utc,
          event: 'location',
          coords: { latitude: input.lat, longitude: input.lng, accuracy: input.accuracy_m },
          is_moving: true,
          ...(input.mock ? { mock: true } : {}),
        });
        await this.flush();
        break;
      }
      case 'DEVICE_REBOOT': {
        if (!phone) break;
        phone.forceStopped = false;
        if (this.armed(phone)) {
          this.enqueue({
            uuid: this.rng.uuid(),
            timestamp: input.at_utc,
            event: 'heartbeat',
            extras: { sitemuster_monitoring: 'RESTARTED' },
          });
          phone.positionCheckPending = true;
        }
        await this.flush();
        break;
      }
      case 'APP_FOREGROUND': {
        if (!phone) break;
        phone.forceStopped = false;
        if (phone.tokenExpiresAt - this.now <= RENEW_BEFORE || phone.uploadBlocked)
          this.renew(phone);
        if (this.armed(phone)) phone.positionCheckPending = true;
        await this.flush();
        break;
      }
      case 'APP_FORCE_STOPPED': {
        if (phone) phone.forceStopped = true;
        break;
      }
      case 'SILENT_PUSH': {
        if (phone && input.delivered && phone.tokenExpiresAt - this.now <= RENEW_BEFORE) {
          this.renew(phone);
          await this.flush();
        }
        break;
      }
      case 'WORK_WINDOW_CHANGE':
        await this.newConfigVersion({ windows: input.windows, operates24x7: input.operates_24_7 });
        break;
      case 'CONFIG_VERSION_CHANGE':
        await this.newConfigVersion({
          version: input.config_version,
          radius: input.radius_m,
          dwell: input.dwell_seconds,
          lat: input.lat,
          lng: input.lng,
        });
        break;
      case 'ORIENTATION_STATUS_CHANGE': {
        const worker = this.workerByKey(input.worker);
        const before = this.eligibilityOf(worker).eligible;
        worker.eligibility = {
          enrollment_status: input.enrollment_status ?? worker.eligibility.enrollment_status,
          employer_status: input.employer_status ?? worker.eligibility.employer_status,
          consent: input.consent ?? worker.eligibility.consent,
        };
        const after = this.eligibilityOf(worker);
        await this.backend.setEligibility(this.project.id, worker.id, after);
        if (before && !after.eligible) {
          await this.applyServer([
            {
              kind: 'SYSTEM',
              eventUuid: this.rng.uuid(),
              projectId: this.project.id,
              workerId: worker.id,
              observedAt: input.at_utc,
              receivedAt: input.at_utc,
              change: 'ELIGIBILITY_LOST',
              reason: after.reason ?? 'ELIGIBILITY_LOST',
            },
          ]);
        }
        if (worker.key === 'A' && phone) {
          this.reselectRegions();
          if (!before && after.eligible && this.armed(phone)) phone.positionCheckPending = true;
        }
        break;
      }
      case 'DEVICE_REPLACED': {
        if (!phone) break;
        const worker = this.workerByKey('A');
        const old = this.devices.get(phone.deviceId);
        if (old) old.active = false;
        await this.backend.deactivateDevice(phone.deviceId);
        const oldCredential = this.credentials.get(phone.token);
        if (oldCredential) oldCredential.revokedAt = this.now;
        phone.revoked = true;
        this.oldPhones.push(phone);
        // The old phone's undelivered queue is refused (401) and never counted.
        if (phone.queue.length > 0 && phone.network)
          await this.ingest(phone.token, phone.queue.slice(0, MAX_BATCH));
        const next = await this.newPhone(worker, this.now);
        next.permission = phone.permission;
        next.precise = phone.precise;
        next.network = phone.network;
        next.positionCheckPending = this.armed(next);
        this.phone = next;
        this.reselectRegions();
        await this.applyServer(
          this.boundProjects().map((project) => ({
            kind: 'MONITORING' as const,
            eventUuid: this.rng.uuid(),
            projectId: project.id,
            workerId: worker.id,
            deviceId: next.deviceId,
            observedAt: input.at_utc,
            receivedAt: input.at_utc,
            change: 'REPLACED' as const,
            reason: 'DEVICE_REPLACED',
          })),
        );
        break;
      }
      case 'CREDENTIAL_REVOKED': {
        if (!phone) break;
        const credential = this.credentials.get(phone.token);
        if (credential) credential.revokedAt = this.now;
        phone.revoked = true;
        await this.flush();
        break;
      }
      case 'SERVER_RESPONSE':
        if (phone)
          for (let i = 0; i < (input.count ?? 1); i += 1) phone.forced.push(input.http_status);
        break;
      case 'TIME_ADVANCE':
        await this.flush();
        for (const kiosk of this.kiosks.values()) await this.syncKiosk(kiosk);
        break;
      case 'FOREMAN_ENTRY': {
        const keys = input.workers ?? ['A'];
        await this.operate('FOREMAN', [
          {
            event_uuid: uuid(),
            project_id: this.project.id,
            operation_type:
              input.direction === 'ENTRY' ? 'FOREMAN_BULK_ENTRY' : 'FOREMAN_BULK_EXIT',
            observed_at: input.at_utc,
            payload: {
              subcontractor_id: this.companyId,
              worker_ids: keys.map((key) => this.workerByKey(key).id),
              direction: input.direction,
              verification_method: input.method ?? 'PHYSICAL_CONFIRMATION',
            },
          },
        ]);
        break;
      }
      case 'KIOSK_SCAN': {
        const kiosk = this.kiosks.get(input.kiosk ?? 'K1') as KioskSim;
        kiosk.offsetMs = (input.kiosk_clock_offset_s ?? 0) * 1000;
        const worker = this.workerByKey(input.worker);
        const opUuid = uuid();
        let payload: string;
        if (input.replay_of) {
          payload = this.scanPayloads.get(input.replay_of) ?? '';
        } else if (input.badge_kind === 'DYNAMIC_APP') {
          const device = worker.key === 'A' ? this.phone : null;
          if (!device)
            throw new Error(`fixture ${this.fixture.id}: worker ${worker.key} has no phone badge`);
          payload = buildBadgePayload(
            device.secret,
            device.deviceId,
            this.project.id,
            Math.floor(this.now / 1000),
          );
        } else {
          payload = worker.printedCode ?? 'SMP1.unknown-printed-badge-0000';
        }
        this.scanPayloads.set(opUuid, payload);
        kiosk.outbox.push({
          uuid: opUuid,
          kind: input.badge_kind,
          payload,
          direction: input.direction,
          observedAt: iso(this.now + kiosk.offsetMs),
        });
        await this.syncKiosk(kiosk);
        break;
      }
      case 'MUSTER_RESPONSE':
        // Muster is separate from attendance (docs/spec/04, 12): recorded, never changes sessions.
        this.musterResponses += 1;
        break;
      case 'MANUAL_ATTENDANCE': {
        const worker = this.workerByKey(input.worker);
        const sessionId = await this.sessionRef(worker, input.session);
        await this.operate('SUPER', [
          {
            event_uuid: uuid(),
            project_id: this.project.id,
            operation_type: 'MANUAL_ATTENDANCE_CORRECTION',
            observed_at: input.at_utc,
            payload: {
              worker_id: worker.id,
              ...(sessionId ? { session_id: sessionId } : {}),
              ...(input.corrected_start_utc
                ? { corrected_start_at: input.corrected_start_utc }
                : {}),
              ...(input.corrected_end_utc ? { corrected_end_at: input.corrected_end_utc } : {}),
              reason: input.reason,
            },
          },
        ]);
        break;
      }
      case 'APPROVE_UNSCHEDULED': {
        const worker = this.workerByKey('A');
        const sessionId = await this.sessionRef(worker, input.session);
        await this.applyServer([
          {
            kind: 'APPROVE_UNSCHEDULED',
            eventUuid: uuid(),
            projectId: this.project.id,
            workerId: worker.id,
            observedAt: input.at_utc,
            receivedAt: input.at_utc,
            actorId: this.superId,
            sessionId: sessionId ?? deriveUuid('missing', this.fixture.id),
          },
        ]);
        break;
      }
      case 'VISITOR': {
        await this.operate('ATTENDANT', [
          {
            event_uuid: uuid(),
            project_id: this.project.id,
            operation_type: input.direction === 'ENTRY' ? 'VISITOR_ENTRY' : 'VISITOR_EXIT',
            observed_at: input.at_utc,
            payload: {
              visitor_id: deriveUuid('replay-visitor', `${this.fixture.id}|${input.visitor}`),
              name: input.visitor,
              host_user_id: this.superId,
              purpose: 'Replay visit',
              direction: input.direction,
            },
          },
        ]);
        break;
      }
      case 'DAILY_REPORT':
        await generateDayReports(
          this.backend.reports,
          this.project.id,
          input.local_date,
          iso(this.now),
        );
        break;
      case 'REPORT_RESPONSE': {
        const versions = (await this.backend.reportRows(this.project.id))
          .filter((row) => row.localDate === input.local_date)
          .sort((a, b) => b.version - a.version);
        const target = input.version
          ? versions.find((row) => row.version === input.version)
          : versions[0];
        if (!target)
          throw new Error(`fixture ${this.fixture.id}: no report for ${input.local_date}`);
        const eventUuid = uuid();
        const answer = await this.backend.answerReport({
          reportId: target.reportId,
          version: target.version,
          action: input.action,
          comment: input.reason ?? null,
          eventUuid,
          actorId: this.foremanId,
          now: iso(this.now),
        });
        this.record({
          eventUuid,
          status: answer.ok ? (answer.duplicate ? 'duplicate' : 'accepted') : 'rejected',
          reason: answer.ok ? null : answer.code,
          review: false,
        });
        break;
      }
      case 'REPORT_REISSUE': {
        const versions = (await this.backend.reportRows(this.project.id)).filter(
          (row) => row.localDate === input.local_date,
        );
        const companyId = versions[0]?.companyId;
        if (!companyId) throw new Error(`fixture ${this.fixture.id}: nothing to reissue`);
        await reissueDayReport(this.backend.reports, {
          projectId: this.project.id,
          companyId,
          localDate: input.local_date,
          reason: input.reason,
          actorId: this.superId,
          now: iso(this.now),
        });
        break;
      }
      case 'PROJECT_STATUS_CHANGE': {
        await this.backend.setProjectStatus(this.project.id, input.status);
        this.projectStatus = input.status;
        if (input.status !== 'ACTIVE') {
          const snapshot = await this.backend.snapshot(this.project.id);
          await this.applyServer(
            snapshot.tracks.map((track) => ({
              kind: 'SYSTEM' as const,
              eventUuid: this.rng.uuid(),
              projectId: this.project.id,
              workerId: track.workerId,
              observedAt: input.at_utc,
              receivedAt: input.at_utc,
              change: 'PROJECT_INACTIVE' as const,
              reason: 'PROJECT_NOT_ACTIVE',
            })),
          );
        }
        break;
      }
    }
    await this.backend.sweep(iso(this.now));
  }

  // -------------------------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------------------------

  async observe(): Promise<ReplayObservation> {
    const snapshot = await this.backend.snapshot(this.project.id);
    const primary = this.workerByKey('A');
    const track = snapshot.tracks.find((t) => t.workerId === primary.id) ?? null;
    const byStart = (a: SessionRecord, b: SessionRecord) => ms(a.startAt) - ms(b.startAt);
    const live = snapshot.sessions.filter((s) => s.status !== 'VOID');
    const mine = live.filter((s) => s.workerId === primary.id).sort(byStart);
    const last = mine[mine.length - 1] ?? null;
    const approved = [...this.workers.values()].filter(
      (w) => this.eligibilityOf(w).eligible,
    ).length;
    const counts = projectCounts({
      tracks: snapshot.tracks,
      sessions: live,
      visits: snapshot.visits,
      approvedRoster: approved,
    });
    const workers = new Map<string, { presence: string; sessions: SessionRecord[] }>();
    for (const worker of this.workers.values()) {
      workers.set(worker.key, {
        presence: snapshot.tracks.find((t) => t.workerId === worker.id)?.presence ?? 'OFFSITE',
        sessions: live.filter((s) => s.workerId === worker.id).sort(byStart),
      });
    }
    const other = (this.fixture.other_projects ?? []).find((p) => p.bound === false);
    let otherProject: ReplayObservation['other_project'] = null;
    if (other) {
      const otherSnapshot = await this.backend.snapshot(other.id);
      otherProject = {
        session_count: otherSnapshot.sessions.length,
        receipts: otherSnapshot.receipts,
      };
    }
    const phone = this.phone;
    let deviceStatus = 'ACTIVE';
    if (!phone) deviceStatus = 'NOT_ARMED';
    else if (phone.revoked) deviceStatus = 'CREDENTIAL_REVOKED';
    else if (phone.tokenExpiresAt <= this.now) deviceStatus = 'CREDENTIAL_EXPIRED';
    else if (phone.tokenExpiresAt - this.now <= EXPIRING_FLAG) deviceStatus = 'CREDENTIAL_EXPIRING';
    else if (!this.armed(phone)) deviceStatus = 'NOT_ARMED';
    const rejected = [...this.results.values()]
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason ?? '')
      .sort();
    const latestConfig = configAt(this.project.versions, iso(this.now)) as AttendanceConfig;
    const reports = (await this.backend.reportRows(this.project.id))
      .sort((a, b) => a.localDate.localeCompare(b.localDate) || a.version - b.version)
      .map((row) => ({
        local_date: row.localDate,
        version: row.version,
        status:
          row.status === 'PENDING_CONFIRMATION' && ms(row.dueAt) <= this.now
            ? 'NOT_CONFIRMED'
            : row.status,
        workers: row.summary.totals.workers,
        definite_seconds: row.summary.totals.definite_seconds,
        uncertain_seconds: row.summary.totals.uncertain_seconds,
        due_at: iso(ms(row.dueAt)),
      }));
    return {
      presence: track?.presence ?? 'OFFSITE',
      session_count: mine.length,
      arrival_at: last?.startAt ?? null,
      departure_at: last?.endAt ?? null,
      departure_earliest_at: last?.endEarliestAt ?? null,
      departure_latest_at: last?.endLatestAt ?? null,
      counted_worker_count: counts.estimated_onsite,
      unresolved_count: counts.unresolved_sessions,
      sessions: mine,
      counts,
      flags: track?.flags ?? [],
      results: this.results,
      rejected_reasons: rejected,
      egress: {
        coordinate_records_sent: this.sentCoordinates.size,
        offsite_coordinate_records_sent: this.sentOffsite.size,
        geofence_records_sent: this.sentGeofence.size,
      },
      monitoring: track?.monitoring ?? 'ACTIVE',
      device_status: deviceStatus,
      queue_remaining: phone?.queue.length ?? 0,
      stored_positions: snapshot.positions.length,
      workers,
      other_project: otherProject,
      visitors: {
        open: snapshot.visits.filter((v) => v.status === 'OPEN').length,
        closed: snapshot.visits.filter((v) => v.status === 'CLOSED').length,
        unresolved: snapshot.visits.filter((v) => v.status === 'UNRESOLVED').length,
      },
      muster_responses_recorded: this.musterResponses,
      duplicate_responses: this.duplicateResponses,
      tracks: snapshot.tracks,
      configVersionNumbers: new Map(
        this.project.versions.map((v) => [v.configVersionId, v.versionNumber]),
      ),
      timezone: this.timezone,
      now: iso(this.now),
      presenceUnknownSeconds: latestConfig.presenceUnknownSeconds,
      reports,
    };
  }

  daySummaries(observation: ReplayObservation, snapshotSessions: SessionRecord[], dates: string[]) {
    return dates.map((date) =>
      daySummary(
        snapshotSessions,
        date,
        this.timezone,
        observation.now,
        observation.presenceUnknownSeconds,
      ),
    );
  }
}

export async function runFixture(
  fixture: LocationTraceFixture,
  backend: ServerBackend,
  options: HarnessOptions = {},
): Promise<{
  harness: ReplayHarness;
  observation: ReplayObservation;
  allSessions: SessionRecord[];
}> {
  const harness = new ReplayHarness(fixture, backend, options);
  await harness.setup();
  for (const input of fixture.inputs) await harness.step(input);
  const observation = await harness.observe();
  const snapshot = await backend.snapshot(fixture.project.id);
  return {
    harness,
    observation,
    allSessions: snapshot.sessions.filter((s) => s.status !== 'VOID'),
  };
}
