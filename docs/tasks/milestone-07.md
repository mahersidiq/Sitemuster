# Milestone 07 — Native tracking and custom device ingestion

## Goal

Native tracking and custom device ingestion. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 08 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/03-location-engine.md`
- `docs/spec/04-attendance-rules.md`
- `docs/spec/05-data-model.md`
- `docs/spec/06-config-defaults.md`
- `docs/spec/07-edge-cases.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/10-testing.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Integrate Transistorsoft v5 with Expo dev builds, offsite geofence-only mode, onsite mode gated, native persistent queue, 32-byte server-revocable device token + 30d expiry, custom POST/25-event 256KiB ingest, whole-batch terminal 200, 401/429/503, one active phone, locked-phone AES session, mock trace driver for CI, device permission state UX.

## Explicitly out of scope

No superintendent map/dashboard (later), no guarantee of force-stop recovery, no floor plans.

## Acceptance tests

Replay + Edge API mixed batch 200/503, cross-project A/B credential rejection, old-device revocation, 2 queues not doubled, no offsite coords in captured wire on real devices before pilot signoff; SDK privacy not verified => live GPS feature release BLOCKED rather than falsely accepted.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

EX, SB staging, TS development integration; TS production license only after brand/bundle clearance; physical devices for final native proof.

When a credential/provider is absent, use the typed development-only adapter documented in `HUMAN_CHECKLIST.md`; record the missing real integration in PR. Do not fake a completed human step or make production silently fall back to mock data.

## Required PR checklist

- [ ] Plain-English summary of changed functionality and files
- [ ] Step-by-step manual phone test for a non-developer, with expected result for each step
- [ ] Screenshots/screen recordings when UI changes
- [ ] Exact test commands, environment and pass/fail output (local vs GitHub Actions)
- [ ] Required CI checks GREEN; otherwise leave draft PR and fix failures
- [ ] Security/privacy/RLS/EN-ES and data migration impact reviewed
- [ ] Any unavailable secrets, accounts, device tests or legal approvals listed as NOT VERIFIED
- [ ] Backward compatibility, rollback steps and release limitations documented
- [ ] **Claude Code did not merge its own PR and stopped at this milestone**
