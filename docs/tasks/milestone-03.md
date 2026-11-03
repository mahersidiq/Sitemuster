# Milestone 03 — Authentication, MFA and English/Spanish

## Goal

Authentication, MFA and English/Spanish. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 04 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Implement Supabase Phone OTP/Twilio primary worker auth (6 digits/600s/60s resend); staff verified email + TOTP MFA, protected session encryption, profile language picker, role-aware route access, passwordless account recovery, supervised no-phone identity design and mocked SMS adapter.

## Explicitly out of scope

No attendance/geofence functions, dashboards or V1.1.

## Acceptance tests

With mock provider run complete worker SMS and staff MFA end-to-end; invalid/expired/rate-limited OTP tested; EN/ES keys parity; Expo reboot/session restoration tests; real Twilio delivery explicitly marked unverified until keys present.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

SB staging, TW (real provider validation), EX only for EAS build verification.

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
