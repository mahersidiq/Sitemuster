# Milestone 09 — Mobile superintendent dashboard and map

## Goal

Mobile superintendent dashboard and map. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 10 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/03-location-engine.md`
- `docs/spec/04-attendance-rules.md`
- `docs/spec/06-config-defaults.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Role-aware GC/PM/super mobile dashboard: estimated onsite vs unknown vs manual confirmed, company/trade counts, worker roster, recently qualified location markers with timestamps/accuracy, circle overlay, private project Broadcast trigger & TanStack Query refetch, stale/empty/offline statuses and approval queue.

## Explicitly out of scope

No web dashboard, no indoor floor positioning, no raw GPS history views.

## Acceptance tests

Seeded real database: counts match sessions, duplicate events not counted, stale markers labeled, org B denied worker map, realtime reconnect resync; screen recording EN/ES on phone, maps failure retains attendance.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

SB staging, GC map key for Android release, EX for native map test.

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
