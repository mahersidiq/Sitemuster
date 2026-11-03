# Milestone 04 — GC organizations, projects, shifts and circles

## Goal

GC organizations, projects, shifts and circles. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 05 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/05-data-model.md`
- `docs/spec/06-config-defaults.md`
- `docs/spec/08-i18n.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Create mobile org/project wizard, Google Places (New) and geocoding through secure Edge, native map and circle configuration 150–2000m, per-project multiple overnight windows/24-7, immutable config versions, project lifecycle and staff invitations; mock Places adapter for no key.

## Explicitly out of scope

No worker orientation approvals, location monitoring, attendance map markers, floor-plan uploads or polygon fences.

## Acceptance tests

On iPhone/Android test flow create org/project, set timezone/radius/window and reversion; database version v1/v2 immutable with old sessions untouched; overlapping site warning; server key absent from bundle; real Google provider when GC available.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

GC; SB staging; Expo for native builds; no Google key required to run mocked address adapter.

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
