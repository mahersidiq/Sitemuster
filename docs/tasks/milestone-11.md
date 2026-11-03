# Milestone 11 — Active Muster Mode

## Goal

Active Muster Mode. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 12 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/05-data-model.md`
- `docs/spec/07-edge-cases.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/11-api-contracts.md`
- `docs/spec/12-muster-mode.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Build safety-triggered muster snapshot, optional push, worker notification action/in-app I'M SAFE, foreman and attended kiosk physical verification, separate visitors, verified/self/unknown/unaccounted live counters, immutable closing report and offline operation queue, bilingual.

## Explicitly out of scope

No emergency dispatch, certified safety guarantee, advanced PDF exports or auto-verification by GPS.

## Acceptance tests

2 workers +1 visitor case, self-safe distinct from physical verified, offline kiosk sync, missing push does not block, only authorized safety triggers/closes, simultaneous trigger idempotence, immutable closure, EN/ES tests.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

EX push credentials for real test, SB staging; Expo Push provider can be mocked for CI.

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
