# Milestone 08 — Kiosk, foreman, manual and visitor fallbacks

## Goal

Kiosk, foreman, manual and visitor fallbacks. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 09 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/02-roles-permissions.md`
- `docs/spec/04-attendance-rules.md`
- `docs/spec/05-data-model.md`
- `docs/spec/07-edge-cases.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/11-api-contracts.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Build shared attended kiosk UI, offline-capable 30s HMAC badge scan (worker phone and kiosk both offline, verified on sync)/printed badge with flagged source, foreman named bulk own-company sign-in/out, super manual corrections with reason, visitors sign-in/out, separate expo-sqlite operational outbox and combined sync status, server idempotent batch ingestion.

## Explicitly out of scope

No mustering, dashboard charting or advanced exports.

## Acceptance tests

Offline kiosk 20 scans + foreman 20 crew events -> airplane mode on/off -> exact 40 accepted no duplicates; badge replay rejected, printed flag retained, visitor separate from workforce; per-worker batch errors surfaced and no double counting.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

EX for camera/dev build, SB staging; no SMS required for managed no-phone profiles.

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
