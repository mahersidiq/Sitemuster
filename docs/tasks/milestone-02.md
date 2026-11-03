# Milestone 02 — Database, RLS and role matrix

## Goal

Database, RLS and role matrix. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 03 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/05-data-model.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/10-testing.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Write PostgreSQL migrations, PostGIS geometry/circular geofence structures, organization/worker/project/subcontractor relations, consent, attendance, receipt, credentials, visitor and muster tables; RLS deny by default, minimal privileged role functions, realtime authorization groundwork, test fixtures and pgTAP.

## Explicitly out of scope

No mobile role flows, SMS integration, native GPS, operational dashboard or billing.

## Acceptance tests

Migrations `supabase start` and `supabase test db` pass in GitHub Actions; 2 GC tenant, foreman, worker, revoked device and operator tests prove no cross-tenant/emergency/GPS reads; unique session/event constraints tested.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

SB staging or local-only Docker CI; SB prod not used in tests.

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
