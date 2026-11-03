# Milestone 10 — Daily reports, foreman confirmation and worker CSV

## Goal

Daily reports, foreman confirmation and worker CSV. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 11 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/04-attendance-rules.md`
- `docs/spec/05-data-model.md`
- `docs/spec/06-config-defaults.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Implement local-day workforce report, company breakout, unresolved closeout, foreman CONFIRM/DISPUTE/CORRECTION due 12:00 next workday, report revision/audit, worker own daily/weekly estimated hours and basic CSV share via expo-sharing; build correction request UI.

## Explicitly out of scope

No certified payroll, contract back-charge determinations, advanced PDF report design or cross-project analytics.

## Acceptance tests

Overnight and DST report math, missed report becomes NOT_CONFIRMED, dispute preserves original version, CSV excludes other worker data and is labeled estimated onsite hours; EN/ES headers; manual test on phone.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

SB staging, EX for share sheet test.

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
