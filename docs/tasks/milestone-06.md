# Milestone 06 — Attendance state machine and deterministic replay

## Goal

Attendance state machine and deterministic replay. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 07 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/04-attendance-rules.md`
- `docs/spec/05-data-model.md`
- `docs/spec/06-config-defaults.md`
- `docs/spec/07-edge-cases.md`
- `docs/spec/10-testing.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Build pure domain event state-machine + transactional reconciler for GEOFENCE, KIOSK, FOREMAN, MANUAL and visitors; 10m dwell, ARRIVING, 75m accuracy, config snapshots, outside-window pending, 24/7 review, 72h late queue review, no invented exit, closeout, basic counts and deterministic LocationTraceReplayHarness with >=55 named fixtures.

## Explicitly out of scope

No native SDK wiring, live UI map, kiosk screens, muster, PDF.

## Acceptance tests

Replay >=55 traces pass and assert arrival first inside/exit observed, duplicate race, DST, overlap, stale, offline, spoof, config change; pgTAP unique open session/tenant tests green; no contradictory state possible.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

SB staging or CI Docker; no native/external location accounts required.

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
