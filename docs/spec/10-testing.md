# 10 — Verification, deterministic replays, CI, pilot and release gates

## Testing layers and required tools

- Shared domain and Edge Function unit tests: **Vitest** (frozen clock, fixtures, Zod schema, state transitions).
- React Native components/hooks tests: **Jest + React Native Testing Library** (navigation role views, EN/ES, permission and sync statuses).
- Database migrations/policies: **Supabase CLI + pgTAP** with Docker in GitHub Actions `ubuntu-latest` (`supabase start`, `supabase db reset --local`, `supabase test db` or CLI current equivalent). Never reset production.
- Mobile E2E: **Maestro** for auth mock/development adapters, QR/kiosk, permissions UI, foreman, dashboard, muster. Real provider SMS E2E separate.
- Native location: **deterministic `LocationTraceReplayHarness`** reading GPX/JSON, with exact expected sessions/presence/counts; at least the 55 named fixtures below by Milestone 06.
- Physical devices: owner/manual with signed off steps (Android OEMs and iPhones). A Linux dev environment cannot assert iOS simulator, real walk-through, Expo account or real SMS credentials.
- Security: cross-tenant RLS, privileged Edge service-role scoping, project A/B credential misuse, leaked QR, printed badge weak-proof marker, time log overlap, async race/failures, retention.
- Performance: test 100, 1,000 and 10,000 concurrent simulated workers; specify load generator, peak message rate, resulting counts, DB queue lag, p95 dashboard update latency, cost estimate and test hardware. No guarantee until run.

## Replay harness file contract

`tests/location-traces/<slug>.json` format:

```json
{
  "fixture_version": 1,
  "id": "already-inside-after-restart",
  "project": {"id":"00000000-0000-4000-8000-000000000001","timezone":"America/Chicago","config_version":1,"radius_m":150,"lat":29.7604,"lng":-95.3698},
  "clock_start_utc":"2026-11-03T12:00:00Z",
  "initial_state":"ARMED_OFFSITE",
  "inputs":[{"at_utc":"2026-11-03T12:01:00Z","type":"APP_FOREGROUND"},{"at_utc":"2026-11-03T12:01:10Z","type":"FIX","lat":29.7604,"lng":-95.3698,"accuracy_m":15},{"at_utc":"2026-11-03T12:11:10Z","type":"FIX","lat":29.7604,"lng":-95.3698,"accuracy_m":16}],
  "expected":{"presence":"ONSITE_ESTIMATED","session_count":1,"arrival_at":"2026-11-03T12:01:10Z","counted_worker_count":1,"unresolved_count":0}
}
```

Use Zod schemas shared by test and production service; support fixtures containing: `NETWORK_DOWN/UP`, `PERMISSION_GRANTED/REVOKED`, `EVENT_ENTER/EXIT`, `FIX`, `DEVICE_REBOOT`, `APP_FOREGROUND`, `WORK_WINDOW_CHANGE`, `CONFIG_VERSION_CHANGE`, `ORIENTATION_STATUS_CHANGE`, `DEVICE_REPLACED`, `SERVER_RESPONSE`, `TIME_ADVANCE`, `FOREMAN_ENTRY`, `KIOSK_SCAN`, `MUSTER_RESPONSE`. Assert every emitted event UUID, server state, sessions, uncertainties, aggregated counts and retention behavior when relevant. Freeze clock and pseudo-random UUID generator; no flaky real time sleeps.

## Minimum deterministic suite

1. First inside fix + confirm exactly 600s later; 2. first inside fix + 599s insufficient; 3. first fix 76m accuracy rejected; 4. 75m accepted; 5. GPS jitter; 6. 50m exit hysteresis; 7. pass-through car; 8. pending orientation; 9. approved but pending employer; 10. approved with valid consent; 11. expired consent; 12. revoked consent; 13. outside work window; 14. overtime approval; 15. shift crosses midnight; 16. DST fall fold; 17. DST spring gap; 18. 24/7; 19. long 24/7 session; 20. device dies; 21. missing EXIT; 22. duplicate ENTER; 23. duplicate EXIT; 24. out-of-order EXIT; 25. delayed 72h accepted; 26. >72h manual review; 27. 5m clock skew; 28. >5m clock skew; 29. overlapping sites; 30. >region budget; 31. already inside on arm; 32. already inside after reboot; 33. force-stop simulated unavailable; 34. permission withdrawn; 35. phone swapped; 36. credential expires; 37. credential revoked; 38. offline multiple visits; 39. per-record poison batch; 40. mixed ACK batch; 41. kiosk dynamic token; 42. kiosk dynamic replay; 43. printed badge; 44. foreman bulk duplicate; 45. no-phone worker; 46. manual correction; 47. contractor report disputed; 48. visitor open; 49. two concurrent muster actions; 50. muster self report vs physical verify; 51. offsite data egress rejection; 52. config changed mid-session; 53. two workers one device; 54. project archived; 55. cross-tenant attempted submission; 56. offline HMAC badge with worker phone and kiosk both offline; 57. badge replay across two kiosks; 58. credential rotation with 25 records queued; 59. worker never opens app 30+ days; 60. EXIT with accuracy worse than limit => DEPARTURE_PENDING interval. These >=55 named examples are a minimum; `07-edge-cases.md` remains full coverage source.

## CI pipeline

GitHub Actions on all PRs: `npm ci`; `npm run typecheck`, `lint`, `format:check`, `test:unit`, `test:integration`, `test:security`, `test:i18n`; Supabase local migrations and `supabase test db`; script/shell checks; deterministic replay; dependency audit; `npx expo config --json` validation; optional EAS build for release-specific or credentialed checks. In Milestone 01 create package scripts with real commands once dependencies pinned. **No fake echo tests**. CI skeleton already at `.github/workflows/ci.yml`; make it operational as part of milestone work. PR with red required CI remains draft.

## Human-only tests and evidence

`docs/setup/HUMAN_CHECKLIST.md` covers service credentials. For each feature PR give non-developer step-by-step mobile test and expected screenshot/status; do not require SQL to run it. EAS iOS signing, Apple review, Google Play permission demonstration and real geofence walks require owner's devices and store accounts; Claude Code must mark `NOT_EXECUTED_PHYSICAL_DEVICE` until verified. Physical privacy capture must inspect actual outbound HTTPS payloads using a consented debugging proxy, both entry and after exit/force-close; if raw offsite coords leave device, block live map release.

## Pilot acceptance

Test one site or more, >=2 subcontractors, 30 workdays, mixed iOS/Android, reference manual headcount and site staff reconciliation. Collect events and false positive/negative rates by OS/device; battery %/shift, user adoption by mode, SMS delivery success, kiosk offline recovery, report confirmation rate and day-close time. Explicitly distinguish GPS estimated from physical count. Adoption target >=80% of workers through any method, not a safety accuracy claim. Do not claim certification, verified payroll or guaranteed realtime presence.

## Release blockers

Identity/RLS/tenant leak, privacy offsite coordinate leak, old-device credential acceptance, self-report mistaken as physically verified, missing EN/ES legal approval, broken account deletion, unrecoverable offline events, incorrect DST/shift, green CI absent, missing real device privacy proof or license, unverified background-mode behavior. PR may be completed as implementation-only while release gate remains pending; label accurately.
