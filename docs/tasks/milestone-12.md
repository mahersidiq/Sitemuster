# Milestone 12 — Security, privacy, resilience and operator CLI

## Goal

Security, privacy, resilience and operator CLI. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 13 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/03-location-engine.md`
- `docs/spec/05-data-model.md`
- `docs/spec/07-edge-cases.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/10-testing.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Finalize versioned human-approved legal notice gates, consent/re-consent, in-app deletion & 30d purge, raw fix 24h cleanup, device/QR secrets audit, minimal MFA-guarded platform admin CLI, Sentry redaction, rate limits, system observability, cross-tenant penetration-style tests, concurrency/load tests.

## Explicitly out of scope

No platform admin UI, floor plans, payment systems or feature expansion.

## Acceptance tests

Security/RLS/Edge tests green; operator denied coords; revoke immediate; delete identity flows; EN/ES approval gate enforced; 100/1000/10000 simulated worker load report; 24h purge; absence of approved legal text blocks production.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

SE, SB staging/prod for deployment configuration, human-approved legal notices; EX for device checks.

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
