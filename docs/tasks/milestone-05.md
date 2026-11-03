# Milestone 05 — Orientation sessions, badges, approval

## Goal

Orientation sessions, badges, approval. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 06 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/05-data-model.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Implement 120m orientation session, supervisor rotating 60s QR, printed static session QR only while open, worker profile/emergency contacts, employer PENDING confirmation, ORIENTATION_COMPLETED separate APPROVED status, bulk approve <=100, dynamic 30s signed worker badge with jti, opaque printed badges + attended issuance.

## Explicitly out of scope

No actual attendance ingestion/native geofence, advanced reports or platform admin UI.

## Acceptance tests

Real/mock SMS worker joins QR and remains unapproved until GC; expired session rejected; static QR not auto-approved; bulk100 results per person; offline HMAC badge generation with airplane mode on + replay rejection; no-phone managed profile and printed ID. EN/ES screens pass.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

SB staging, TW for real OTP, EX for device QR camera tests.

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
