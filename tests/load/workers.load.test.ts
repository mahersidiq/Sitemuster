import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { base64UrlEncode, type BroadcastMessage } from '@sitemuster/shared';

import { subscribeProjectChannel } from '../../src/api/supabase-api';
import { ProjectLiveSync } from '../../src/realtime/live-sync';
import { withDb } from '../backend/support/db';
import { assignStaff, fn, scalar } from '../backend/support/operations';
import { staffClient } from '../backend/support/staff';

/**
 * Load test (Milestone 12, spec 10 "Performance: test 100, 1,000 and 10,000 concurrent simulated
 * workers"). Runs against the local stack — real Postgres, PostgREST, Realtime and the real
 * `ingest-location-batch` Edge Function — with LOAD_WORKERS simulated phones (default 100).
 *
 * Scenario (a shift start): every worker's phone uploads its arrival batch (geofence ENTER plus
 * two inside fixes 11 minutes apart, so the 10-minute dwell is met) with LOAD_CONCURRENCY
 * requests in flight. A superintendent follows the private Broadcast channel exactly like the
 * app and the dashboard is read at full size. Then 10 % of the phones resend (lost answers), a
 * muster is started over everyone on site and its board read. Correctness is asserted; timings
 * are measured and written to docs/perf/results/<workers>.json for docs/perf/load-report.md.
 */
const WORKERS = Number(process.env.LOAD_WORKERS ?? 100);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
/** Sites the workers are spread over (round robin); the superintendent watches the first. */
const SITES = Math.max(1, Number(process.env.LOAD_SITES ?? 1));
const RESULTS_DIR =
  process.env.LOAD_RESULTS_DIR ?? join(__dirname, '..', '..', 'docs', 'perf', 'results');
const CENTER = { lat: 29.7499, lng: -95.3601 };

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0,
  );
};
const summary = (values: number[]) => ({
  count: values.length,
  p50_ms: percentile(values, 50),
  p95_ms: percentile(values, 95),
  p99_ms: percentile(values, 99),
  max_ms: values.length ? Math.round(Math.max(...values)) : null,
});

async function pool<T>(items: T[], size: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await work(items[index] as T, index);
      }
    }),
  );
}

interface Phone {
  workerId: string;
  token: string;
  site: number;
  batch: Record<string, unknown>[];
}

/** `sites` ACTIVE 24/7 projects and `count` approved, consented workers with activated phones. */
async function seed(count: number, sites: number) {
  const projects = Array.from({ length: sites }, (_, index) => ({
    projectId: crypto.randomUUID(),
    configVersionId: crypto.randomUUID(),
    identifier: `sm_${crypto.randomUUID().replace(/-/g, '')}`,
    center: { lat: CENTER.lat + index * 0.01, lng: CENTER.lng },
  }));
  const owner = crypto.randomUUID();
  const org = crypto.randomUUID();
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const phones: Phone[] = Array.from({ length: count }, (_, index) => {
    const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const site = index % sites;
    const { identifier, center } = projects[site] as (typeof projects)[number];
    return {
      workerId: crypto.randomUUID(),
      token,
      site,
      batch: [
        {
          uuid: crypto.randomUUID(),
          timestamp: at(15),
          event: 'geofence',
          geofence: { identifier, action: 'ENTER' },
          accuracy: 10,
        },
        {
          uuid: crypto.randomUUID(),
          timestamp: at(14),
          event: 'location',
          coords: { latitude: center.lat, longitude: center.lng, accuracy: 8 },
          is_moving: false,
        },
        {
          uuid: crypto.randomUUID(),
          timestamp: at(3),
          event: 'location',
          coords: { latitude: center.lat, longitude: center.lng, accuracy: 8 },
          is_moving: false,
        },
      ],
    };
  });
  const started = Date.now();
  await withDb(async (db) => {
    await db.query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), '{}', '{}', now(), now())`,
      [owner, `load-owner-${owner.slice(0, 8)}@example.test`],
    );
    await db.query(
      'insert into public.organizations (id, name, owner_user_id, idempotency_key) values ($1, $2, $3, gen_random_uuid())',
      [org, 'Load GC', owner],
    );
    await db.query(
      "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER')",
      [org, owner],
    );
    for (const [index, project] of projects.entries()) {
      await db.query(
        `insert into public.projects (id, organization_id, name, iana_timezone, status, idempotency_key)
         values ($1, $2, $3, 'America/Chicago', 'ACTIVE', gen_random_uuid())`,
        [project.projectId, org, `Load site ${index + 1}`],
      );
      await db.query(
        `insert into public.project_tracking_config_versions (id, project_id, version_number, effective_at, settings_json, operates_24_7)
         values ($1, $2, 1, now() - interval '1 day', app_private.build_settings(150, 600, 75, true, '[]'::jsonb), true)`,
        [project.configVersionId, project.projectId],
      );
      await db.query(
        `insert into public.project_geofences (config_version_id, project_id, center, radius_m, sdk_identifier)
         values ($1, $2, extensions.st_setsrid(extensions.st_makepoint($3, $4), 4326)::extensions.geography, 150, $5)`,
        [
          project.configVersionId,
          project.projectId,
          project.center.lng,
          project.center.lat,
          project.identifier,
        ],
      );
      await db.query('update public.projects set config_version_id = $1 where id = $2', [
        project.configVersionId,
        project.projectId,
      ]);
    }
    const notice = (
      await db.query<{ id: string }>(
        "select id from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_EN_V1'",
      )
    ).rows[0]?.id;
    const workers = phones.map((p) => p.workerId);
    const workerProjects = phones.map((p) => projects[p.site]?.projectId ?? '');
    const users = phones.map(() => crypto.randomUUID());
    const devices = phones.map(() => crypto.randomUUID());
    const hashes = phones.map((p) =>
      createHash('sha256').update(Buffer.from(p.token, 'base64url')).digest(),
    );
    const installs = phones.map(() => crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'));
    for (let start = 0; start < count; start += 2000) {
      const end = Math.min(count, start + 2000);
      const slice = <T>(values: T[]) => values.slice(start, end);
      await db.query(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', 'load-' || u || '@example.test', now(), '{}', '{}', now(), now()
           from unnest($1::uuid[]) u`,
        [slice(users)],
      );
      await db.query(
        `insert into public.worker_profiles (id, auth_user_id, legal_name, managed_identity)
         select w, u, 'Load Worker ' || o, false from unnest($1::uuid[], $2::uuid[]) with ordinality t(w, u, o)`,
        [slice(workers), slice(users)],
      );
      await db.query(
        `insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id)
         select w, p, now(), $3 from unnest($1::uuid[], $2::uuid[]) t(w, p)`,
        [slice(workers), slice(workerProjects), notice],
      );
      await db.query(
        `insert into public.worker_enrollments (project_id, worker_id, enrollment_status, employer_status, approval_at)
         select p, w, 'APPROVED', 'PENDING_CONFIRMATION', now() from unnest($1::uuid[], $2::uuid[]) t(w, p)`,
        [slice(workers), slice(workerProjects)],
      );
      await db.query(
        `insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at)
         select w, p, $3, 'en-US', 'DIGITAL', now() from unnest($1::uuid[], $2::uuid[]) t(w, p)`,
        [slice(workers), slice(workerProjects), notice],
      );
      await db.query(
        `insert into public.device_installations (id, worker_id, platform, hardware_installation_hash, app_version)
         select d, w, 'IOS', h, '0.12.0' from unnest($1::uuid[], $2::uuid[], $3::text[]) t(d, w, h)`,
        [slice(devices), slice(workers), slice(installs)],
      );
      await db.query(
        `insert into app_private.device_upload_credentials (device_id, token_sha256, expires_at)
         select d, t, now() + interval '30 days' from unnest($1::uuid[], $2::bytea[]) x(d, t)`,
        [slice(devices), slice(hashes)],
      );
    }
  });
  const projectIds = projects.map((project) => project.projectId);
  const bindings = await scalar<number>(
    'select count(*)::int as v from public.device_project_bindings where project_id = any($1::uuid[]) and revoked_at is null',
    [projectIds],
  );
  return {
    projectId: projectIds[0] ?? '',
    projectIds,
    phones,
    seedMs: Date.now() - started,
    bindings,
  };
}

async function upload(phone: Phone) {
  const started = performance.now();
  const response = await fetch(fn('ingest-location-batch'), {
    method: 'POST',
    headers: { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ locations: phone.batch }),
  });
  const body = (await response.json()) as { results?: { status: string }[] };
  return {
    status: response.status,
    ms: performance.now() - started,
    at: Date.now(),
    results: body.results ?? [],
  };
}

describe(`load: ${WORKERS} simulated workers on ${SITES} site(s) (local stack)`, () => {
  it('a shift start: every arrival counted once, the dashboard follows, resends add nothing', async () => {
    const site = await seed(WORKERS, SITES);
    expect(site.bindings).toBe(WORKERS);
    // The watched site (the first) and its share of the workers.
    const watched = site.phones.filter((phone) => phone.site === 0).length;

    // The superintendent's phone, with the production live sync (src/realtime/live-sync.ts):
    // a Broadcast message only says "something changed"; the dashboard is refetched (at once,
    // then at most every 2 s) and the refetched count is what the person sees.
    const superintendent = await staffClient();
    await assignStaff(superintendent.client, site.projectId, 'SUPER');
    const messages: { receivedAt: number; message: BroadcastMessage }[] = [];
    const views: { at: number; onsite: number }[] = [];
    const refresh = async () => {
      const read = await superintendent.client.rpc('project_dashboard', {
        p_project_id: site.projectId,
      });
      const onsite = (read.data as { counts?: { estimated_onsite?: number } } | null)?.counts
        ?.estimated_onsite;
      if (typeof onsite === 'number') views.push({ at: Date.now(), onsite });
    };
    const sync = new ProjectLiveSync(site.projectId, {
      subscribe: (id, listener) =>
        subscribeProjectChannel(superintendent.client, id, {
          onMessage: (message) => {
            messages.push({ receivedAt: Date.now(), message });
            listener.onMessage(message);
          },
          onStatus: (status) => listener.onStatus(status),
        }),
      refresh: () => void refresh(),
      now: () => Date.now(),
      setTimer: (work, ms) => setTimeout(work, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    sync.start();
    const stop = () => sync.stop();
    const deadline = Date.now() + 20_000;
    while (sync.status !== 'LIVE' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sync.status).toBe('LIVE');

    try {
      // 1. Arrival burst.
      const outcomes: Awaited<ReturnType<typeof upload>>[] = new Array(WORKERS);
      const burstStart = Date.now();
      await pool(site.phones, CONCURRENCY, async (phone, index) => {
        outcomes[index] = await upload(phone);
      });
      const burstMs = Date.now() - burstStart;
      const statusCounts = outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.status] = (acc[o.status] ?? 0) + 1;
        return acc;
      }, {});
      const perSecond = new Map<number, number>();
      for (const o of outcomes)
        perSecond.set(Math.floor(o.at / 1000), (perSecond.get(Math.floor(o.at / 1000)) ?? 0) + 1);
      const peakRequestsPerSecond = Math.max(...perSecond.values());

      // 2. The dashboard catches up, as the person sees it (refetched counts).
      const catchUpDeadline = Date.now() + 120_000;
      while (!views.some((v) => v.onsite >= watched) && Date.now() < catchUpDeadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const watchedOutcomes = outcomes.filter((_, index) => site.phones[index]?.site === 0);
      const lastUploadAt = Math.max(...watchedOutcomes.map((o) => o.at));
      const fullAt = views.find((v) => v.onsite >= watched)?.at ?? null;
      // Upload k (in completion order) is visible once a refetched dashboard shows >= k on site;
      // a view completed before the upload's own HTTP answer reached the phone counts as 0 ms.
      const completions = watchedOutcomes.map((o) => o.at).sort((x, y) => x - y);
      const visibility: number[] = [];
      for (const [k, doneAt] of completions.entries()) {
        const seen = views.find((v) => v.onsite >= k + 1);
        if (seen) visibility.push(Math.max(0, seen.at - doneAt));
      }
      // Broadcast pipeline lag: commit (message `occurred_at`) → delivered to the phone.
      const queueLag = messages.map((m) => m.receivedAt - Date.parse(m.message.occurred_at));
      const staleCounts = messages.filter(
        (m, index) =>
          index === messages.length - 1 && (m.message.counts.estimated_onsite ?? 0) < watched,
      ).length;

      // 3. Correctness at full size.
      const openSessions = await scalar<number>(
        "select count(*)::int as v from public.attendance_sessions where project_id = any($1::uuid[]) and status = 'OPEN'",
        [site.projectIds],
      );
      const receipts = await scalar<number>(
        "select count(*)::int as v from app_private.location_event_receipts r join public.device_installations d on d.id = r.device_id join public.worker_enrollments e on e.worker_id = d.worker_id where e.project_id = any($1::uuid[]) and r.terminal_result = 'accepted'",
        [site.projectIds],
      );

      // 4. Dashboard and roster reads at full size.
      const timed = async (work: () => PromiseLike<{ error: unknown }>) => {
        const started = performance.now();
        const result = await work();
        expect(result.error).toBeNull();
        return performance.now() - started;
      };
      const dashboardMs: number[] = [];
      const rosterMs: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        dashboardMs.push(
          await timed(() =>
            superintendent.client.rpc('project_dashboard', { p_project_id: site.projectId }),
          ),
        );
        rosterMs.push(
          await timed(() =>
            superintendent.client.rpc('workforce_roster', { p_project_id: site.projectId }),
          ),
        );
      }
      const dashboard = await superintendent.client.rpc('project_dashboard', {
        p_project_id: site.projectId,
      });
      const counted = (dashboard.data as { counts: { estimated_onsite: number } }).counts
        .estimated_onsite;

      // 5. 10 % of phones resend (their answer was lost): duplicates only, nothing new.
      const resend = site.phones.filter((_, i) => i % 10 === 0);
      const resendOutcomes: Awaited<ReturnType<typeof upload>>[] = [];
      await pool(resend, CONCURRENCY, async (phone) => {
        resendOutcomes.push(await upload(phone));
      });
      const openAfterResend = await scalar<number>(
        "select count(*)::int as v from public.attendance_sessions where project_id = any($1::uuid[]) and status = 'OPEN'",
        [site.projectIds],
      );

      // 6. A muster over everyone on site, and the commander's board.
      const safety = await staffClient();
      await withDb(async (db) =>
        db.query(
          "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, (select id from auth.users where email = $2), 'SAFETY', true)",
          [site.projectId, safety.email],
        ),
      );
      const musterStarted = performance.now();
      const start = await fetch(fn('muster-start'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${(await safety.client.auth.getSession()).data.session?.access_token ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schema_version: 1,
          project_id: site.projectId,
          incident_label: 'Load drill',
          idempotency_key: crypto.randomUUID(),
        }),
      });
      const musterStartMs = performance.now() - musterStarted;
      expect(start.status).toBe(200);
      const musterId = ((await start.json()) as { muster_id: string }).muster_id;
      const snapshot = await scalar<number>(
        'select count(*)::int as v from public.muster_snapshot_members where muster_id = $1 and worker_id is not null',
        [musterId],
      );
      const boardMs: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        boardMs.push(
          await timed(() => safety.client.rpc('muster_board', { p_muster_id: musterId })),
        );
      }

      const report = {
        workers: WORKERS,
        sites: SITES,
        workers_on_watched_site: watched,
        concurrency: CONCURRENCY,
        recorded_at: new Date().toISOString(),
        hardware: {
          cpus: cpus().length,
          cpu_model: cpus()[0]?.model ?? 'unknown',
          memory_gb: Math.round(totalmem() / 2 ** 30),
        },
        seed_ms: site.seedMs,
        arrival_burst: {
          requests: WORKERS,
          events: WORKERS * 3,
          wall_ms: burstMs,
          requests_per_second: Math.round((WORKERS / burstMs) * 1000 * 10) / 10,
          events_per_second: Math.round(((WORKERS * 3) / burstMs) * 1000 * 10) / 10,
          peak_requests_per_second: peakRequestsPerSecond,
          status_counts: statusCounts,
          latency: summary(outcomes.map((o) => o.ms)),
        },
        counts: {
          open_sessions: openSessions,
          accepted_receipts: receipts,
          dashboard_estimated_onsite: counted,
          open_sessions_after_resend: openAfterResend,
          muster_snapshot_workers: snapshot,
        },
        broadcast: {
          messages_received: messages.length,
          dashboard_refetches: views.length,
          last_message_count_was_stale: staleCounts === 1,
          queue_lag: summary(queueLag),
          dashboard_update_latency: summary(visibility),
          uploads_with_measured_visibility: visibility.length,
          full_count_visible_after_last_upload_ms: fullAt === null ? null : fullAt - lastUploadAt,
        },
        reads_at_full_size: {
          project_dashboard: summary(dashboardMs),
          workforce_roster: summary(rosterMs),
          muster_board: summary(boardMs),
        },
        muster_start_ms: Math.round(musterStartMs),
        resend: {
          requests: resend.length,
          all_duplicate: resendOutcomes.every(
            (o) => o.status === 200 && o.results.every((r) => r.status === 'duplicate'),
          ),
          latency: summary(resendOutcomes.map((o) => o.ms)),
        },
      };
      mkdirSync(RESULTS_DIR, { recursive: true });
      const name = SITES > 1 ? `${WORKERS}-${SITES}-sites` : String(WORKERS);
      writeFileSync(join(RESULTS_DIR, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);

      expect(statusCounts).toEqual({ '200': WORKERS });
      expect(outcomes.every((o) => o.results.every((r) => r.status === 'accepted'))).toBe(true);
      expect(openSessions).toBe(WORKERS);
      expect(receipts).toBe(WORKERS * 3);
      expect(counted).toBe(watched);
      expect(report.resend.all_duplicate).toBe(true);
      expect(openAfterResend).toBe(WORKERS);
      expect(snapshot).toBe(watched);
    } finally {
      stop();
    }
  });
});
