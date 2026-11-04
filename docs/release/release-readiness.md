# Release readiness board (Milestone 13)

**Overall: NOT READY FOR PUBLIC RELEASE — `FIELD_PILOT_PENDING`.**

This board lists every release gate from docs/spec/10 "Release blockers", docs/spec/09 "Security
release blockers" and the Milestone 13 acceptance tests, with its current status and its evidence.
`tests/security/release-docs.test.ts` keeps it honest: a gate can only say PASS with evidence, and
the overall line cannot say ready while any gate is open or the pilot is unsigned.

Statuses: **PASS** (evidence named), **NOT VERIFIED** (needs an account or a hosted environment
this build agent does not have), **BLOCKED** (needs a human decision, money or counsel),
**NOT_EXECUTED_PHYSICAL_DEVICE** (needs a real phone), **FIELD_PILOT_PENDING**.

| Gate | Status | Evidence |
|---|---|---|
| No identity, RLS or tenant leak | PASS | pgTAP `031_cross_tenant_pen` (every RPC, table and view as 7 attackers incl. the reviewer account), `010`–`013`; `tests/backend/pen-edge.test.ts`; CI on every PR |
| No cross-project ingestion | PASS | pgTAP `024_device_ingestion`; `supabase/functions/_shared/ingest-core.test.ts`; replay fixture 55 |
| Old-device credential refused | PASS | pgTAP `014_devices_credentials`; `tests/backend/pen-edge.test.ts` (revoked phone refused on the next upload) |
| No off-site coordinate transmitted — automated wire tests | PASS | `src/tracking/tracking.test.ts` (simulated SDK wire for a whole day, with a leaking negative control); `tests/security/location-wire-privacy.test.ts` |
| No off-site coordinate transmitted — real devices (network capture) | NOT_EXECUTED_PHYSICAL_DEVICE | HUMAN_CHECKLIST §10 with `npm run privacy:capture-check`; until signed off production stays TRACKING_LIMITED (decision #90) |
| Background-mode behaviour on real devices | NOT_EXECUTED_PHYSICAL_DEVICE | `docs/release/phone-test-checklist.md` §2–§3 |
| Self-report never shown as physical verification | PASS | pgTAP `028_muster`; `tests/mobile/muster-flows.test.tsx` |
| Offline events recoverable, no duplicates | PASS | replay fixtures (`tests/location-traces`), `src/outbox` tests, `tests/backend/operations.test.ts` |
| DST, midnight and shift rules correct | PASS | replay fixtures 15–19 and `packages/shared/src/attendance/schedule.test.ts` |
| Account deletion works — automated | PASS | pgTAP `029_security_privacy`; `tests/backend/privacy.test.ts`; `tests/mobile/privacy-flows.test.tsx` |
| Account deletion works — real devices | NOT_EXECUTED_PHYSICAL_DEVICE | HUMAN_CHECKLIST "Real-device privacy and account deletion check" |
| EN and ES legal texts approved | BLOCKED | counsel review (`docs/legal/TRANSLATION_REVIEW.md`, HUMAN_CHECKLIST §9); production refuses consent and musters until then |
| Privacy policy URL and deletion web page published | BLOCKED | owner + counsel (`docs/release/store-submission.md` §0) |
| Brand and app identifier clearance | BLOCKED | owner + counsel (HUMAN_CHECKLIST §9); production builds refused until `SITEMUSTER_CLEARED_APP_ID` is set |
| Transistorsoft Android release license | BLOCKED | purchase after clearance (HUMAN_CHECKLIST §10); production builds refused without it |
| Reproducible EAS builds on the owner's account | NOT VERIFIED | `eas.json`, `.github/workflows/release.yml`, `docs/release/native-builds.md`; local `expo prebuild` with production settings passes; needs the Expo account (HUMAN_CHECKLIST §2) |
| Reviewer demo cannot affect real data | PASS | pgTAP `032_reviewer_demo`; `tests/backend/demo.test.ts`; reviewer account in pgTAP `031` |
| App Store and Google Play requirements documented | PASS | `docs/release/store-submission.md`, `docs/release/apple-review-notes.md`, `docs/release/play-background-location-video.md` |
| Google Play background-location video recorded | NOT_EXECUTED_PHYSICAL_DEVICE | script in `docs/release/play-background-location-video.md` |
| Crash reports scrubbed (real Sentry event) | NOT VERIFIED | `tests/security/crash-report-privacy.test.ts` passes; a real event needs the Sentry project (HUMAN_CHECKLIST §6) |
| SMS abuse protection on the provider | NOT VERIFIED | HUMAN_CHECKLIST §4 (Twilio Fraud Guard, geo permissions, usage alerts) |
| Hosted load test | NOT VERIFIED | `docs/perf/load-report.md` (local results); hosted staging run pending |
| Green CI on the release commit | PASS | the `code-quality` and `database` checks; the release workflow refuses a commit without them |
| 30-workday field pilot, owner-signed | FIELD_PILOT_PENDING | `docs/release/field-pilot-protocol.md`, `docs/release/pilot/pilot-sign-off.md` (not signed) |

## What "ready" requires

Every row PASS, and `docs/release/pilot/pilot-sign-off.md` changed to SIGNED by the owner. Only then
may the overall line change, in a reviewed pull request. Until then SiteMuster may be tested on
TestFlight and Play testing tracks (with the reviewer demo and consenting testers), but must not be
described as ready for public release.
