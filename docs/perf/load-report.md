# Load test report — 100, 1,000 and 10,000 simulated workers (Milestone 12)

Spec 10 requires 100, 1,000 and 10,000 concurrent simulated workers, reporting:
- the load generator;
- the peak message rate;
- the resulting counts;
- the database queue lag;
- the p95 dashboard update latency;
- a cost estimate and the test hardware.

Nothing is guaranteed until run. Everything below was run on 2026-11-04; the raw results are in `docs/perf/results/*.json`.

## In plain English

- **Correct at every size.** Every arrival was counted exactly once. A phone resending after a lost answer never added anyone, and the dashboard always ended on the right total. A muster over everyone on site started in under a second, even with 10,000 people.
- **Fast enough, with a wide margin for real use.**
  - Measured capacity: the test machine handled about 60 arrivals a second. With 10,000 workers on a single site it handled 26 a second.
  - Real demand: 10,000 workers arriving over 30 minutes is about 6 arrivals a second.
  - Dashboard: a superintendent saw each arrival on the dashboard within 1.4–3.0 s (p95).
- **One limit was found.** Each upload recomputes its site's headcount for the live update, so a single huge site gets slower per arrival. Spread over 20 sites, there was no slowdown at all.
  - V1 does not need a change: the pilot is ≤ 150 workers per site.
  - Before any one site exceeds about 2,000 workers with full GPS tracking, the counts in the live message should be throttled (decision #138).
- **Hosted performance is not measured here.** These numbers come from one small machine that runs the whole stack. A staging run on hosted Supabase is still to do (NOT VERIFIED).

## How it was run

**Load generator.** `tests/load/workers.load.test.ts` (Vitest project `load`) against the local stack.

```bash
LOAD_WORKERS=10000 LOAD_SITES=1 LOAD_CONCURRENCY=50 npm run test:load
```

`LOAD_SITES` spreads the workers round-robin over that many sites. CI runs the 100-worker case on every pull request (database job, "Load smoke test").

**A simulated worker** is a real worker as far as the server can tell: a sign-in account, an approved enrollment, the accepted site notice, an activated phone and its upload credential (32 random bytes; only the SHA-256 is stored), and the derived phone↔project binding, all seeded directly in the database. Its phone uploads the batch a real phone sends on arrival, through the **real** pipeline:
- the batch: a coordinate-free geofence ENTER plus two inside fixes 11 minutes apart, so the 10-minute dwell is met;
- the pipeline: `ingest-location-batch` Edge Function → device authentication → rate limit → receipts → the attendance engine → `edge_attendance_commit` → Broadcast.

The run is a shift start:
1. All workers upload, 50 requests in flight.
2. 10% of phones then resend their batch (lost answers).
3. A muster is started over everyone on the watched site, and the commander's board is read.

**The watcher** is a superintendent signed in with MFA. They follow the site's private Broadcast channel through the production `ProjectLiveSync` (`src/realtime/live-sync.ts`): every message triggers a dashboard refetch at once, then at most one every 2 s. The time until the **refetched** dashboard shows an arrival is the dashboard update latency.

**Not simulated:** the native SDK and phone networks; hosted Supabase (separate machines for Postgres, PostgREST, Realtime and Edge Functions); real geography. Production phones start in TRACKING_LIMITED, which sends only the coordinate-free arrive/leave record, a lighter load (decision #90).

## Test hardware

One Linux VM with 4 vCPUs (Intel Xeon @ 2.10 GHz) and 16 GB RAM, running Docker 29.9.2 and the Supabase CLI 2.122.1 local stack: Postgres 17.11, PostgREST, Realtime, the Edge Runtime and Kong. The load generator ran on the same 4 vCPUs.

During the runs, PostgREST used one full core and the Postgres backends shared the rest. All absolute numbers are therefore a floor for production, not a ceiling.

## Results

| | 100 | 1,000 | 10,000 on 1 site | 10,000 on 20 sites |
|---|---|---|---|---|
| Arrival uploads (location events) | 100 (300) | 1,000 (3,000) | 10,000 (30,000) | 10,000 (30,000) |
| Wall time | 1.7 s | 17.5 s | 383 s | 165 s |
| Average rate, uploads/s (events/s) | 57.7 (173) | 57.3 (172) | 26.1 (78) | 60.6 (182) |
| **Peak message rate**, uploads in one second | 68 | 65 | 67 | 81 |
| Upload latency p50 / p95 / p99 / max | 0.70 / 1.36 / 1.52 / 1.56 s | 0.80 / 1.52 / 2.08 / 2.87 s | 1.63 / 4.08 / 5.80 / 10.5 s | 0.77 / 1.44 / 1.83 / 2.85 s |
| HTTP 200 | 100% | 100% | 100% | 100% |
| **Resulting counts**: open sessions / accepted events | 100 / 300 | 1,000 / 3,000 | 10,000 / 30,000 | 10,000 / 30,000 |
| Dashboard total at the end (watched site) | 100 | 1,000 | 10,000 | 500 of 500 |
| Resends (10%): all answered "duplicate", no new session | yes (10) | yes (100) | yes (1,000) | yes (1,000) |
| **DB → phone queue lag** (Broadcast) p50 / p95 / max | 9 / 25 / 34 ms | 10 / 28 / 68 ms | 10 / 29 / 147 ms | 10 / 33 / 74 ms |
| **Dashboard update latency** p50 / p95 / max | 0.74 / **1.40** / 1.52 s | 1.04 / **1.98** / 2.46 s | 1.49 / **2.95** / 4.85 s | 1.11 / **2.03** / 2.54 s |
| Full total visible after the last upload | 0.23 s | 0.52 s | 1.06 s | 1.04 s |
| Dashboard read at full size p50 / p95 | 15 / 25 ms | 40 / 71 ms | 301 / 366 ms | 33 / 47 ms |
| Workforce roster read p50 / p95 | 16 / 21 ms | 75 / 95 ms | 719 / 749 ms | 44 / 67 ms |
| Muster start (frozen list of everyone on site) | 76 ms | 222 ms | 877 ms | 194 ms (500) |
| Muster board read p50 / p95 | 13 / 16 ms | 42 / 54 ms | 325 / 373 ms | 23 / 24 ms |
| Resend latency p95 | 55 ms | 323 ms | 365 ms | 417 ms |

Measurement notes:
- **Queue lag** runs from the commit (the message's `occurred_at`) to its arrival on the watcher's phone, through `realtime.messages` and the Realtime server.
- **Dashboard update latency** is per arrival: from the upload's HTTP answer until a refetched dashboard counted it. It includes the app's 2-second refresh window.
- **The 10,000 single-site seed** took 21 s; the 20-site seed took 33 s.
- **The 100-worker result** is the latest run on a freshly reset database. The 1,000 and 10,000 single-site runs shared the database with up to about 2,100 workers of earlier runs (other sites).

## Findings

1. **Correctness held everywhere.** Each worker got exactly one open session and each record one receipt. Resends were duplicates, the final dashboard counts were exact, and the frozen muster lists were complete.

2. **Message counts can be stale; the app is not.**
   - Concurrent commits each compute their site's counts before the others are visible. So the last Broadcast message can carry a slightly low number: at 1,000 and 10,000 the last message was short of the full total.
   - The app never shows message counts. It refetches the dashboard on each message, plus a refresh every minute, and the refetched total was exact within about 1 s of the last upload.
   - This confirms decision #19 (messages say "something changed"; the database stays the source of truth).

3. **Per-site cost grows with site size (decision #138).** Every attendance commit recomputes its whole site's counts for the Broadcast message.
   - At 500 workers per site this took about 17 ms per commit (`pg_stat_statements`). The 20-site run kept the 1,000-worker speed (61 uploads/s).
   - With 10,000 on one site, throughput halved (26 uploads/s) and p95 upload latency rose to 4.1 s.
   - Every arrival was still correct, and reads stayed under 0.8 s.

4. **Machine bottleneck.** On this 4-vCPU machine the shared CPU was the limit. PostgREST used a full core and the attendance commit averaged about 74 ms under 50-way concurrency. Each upload makes about five database calls (authenticate, rate limit, receipts, load, commit).

## Expected production load

| Situation | Uploads per worker | 10,000 workers |
|---|---|---|
| Shift start (arrivals over 30 minutes) | 1 | ≈ 6 uploads/s, about 10% of measured capacity |
| TRACKING_LIMITED (the production default until the privacy sign-off, decision #90) | about 2–4 a day (arrive/leave) | < 1 upload/s on average |
| Full on-site tracking after sign-off: one sample every 5 minutes while stationary (`stationary_sample_target_seconds`) | up to about 120 per 10-hour shift | ≈ 33 uploads/s on average. On one 10,000-worker site that exceeds this test machine. Spread over sites it is about half its capacity |

## Cost estimate (indicative — verify before relying on it)

Assumptions:
- 22 working days a month, 10-hour shifts;
- 3 staff watching the dashboard per project;
- Supabase list prices as last known: Pro $25 per project per month with 2 M Edge Function invocations included ($2 per extra million), 5 M Realtime messages included ($2.50 per extra million), compute add-ons from about $10 to $210 a month.

Prices change; decision #20 says costs are indicative and no price is promised.

| Scenario | Edge invocations a month | Realtime messages a month | Compute (from this test) | Indicative Supabase total |
|---|---|---|---|---|
| **Pilot**: 3 projects, 150 workers, TRACKING_LIMITED | < 0.02 M | < 0.1 M | smallest add-on | about $35 a month for staging plus production (Pro plan plus one more small instance), in line with decision #20's $51–$120 including SMS and other services |
| **10,000 workers**, TRACKING_LIMITED | about 0.9 M (included) | about 2.6 M (included) | Small–Medium | about $40–$90 |
| **10,000 workers**, full tracking | about 26 M (about $49 extra) | up to about 80 M while dashboards stay open (about $190 extra) | Large or more; one 10,000-worker site needs decision #138 first | about $300–$500 |

Not included:
- Twilio SMS (sign-in codes; Twilio pricing per message);
- Expo push (free tier);
- Sentry;
- storage and egress (small: no files or photos in V1).

## Not verified here

- The same scenario against **hosted staging**, where Postgres, PostgREST, Realtime and Edge Functions run on separate infrastructure (needs the SB account). The command is unchanged: point `API_URL`, `ANON_KEY`, `DB_URL` and `MAILPIT_URL` at a staging copy. The backend test helpers refuse remote URLs, so this needs a deliberate, reviewed change first.
- Real phones and networks: native SDK batching, retries on weak signal (HUMAN_CHECKLIST real-device sections).
- Cost figures against a real bill.
