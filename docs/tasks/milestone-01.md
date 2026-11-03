# Milestone 01 — Clean repository, locked stack and CI

## Goal

Clean repository, locked stack and CI. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 02 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/10-testing.md`
- `docs/spec/09-security-privacy.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Create clean Expo + TypeScript monorepo from empty GitHub repo; initialize Expo Router, EN/ES shells, locked libraries/dependency compatibility audit; capture latest stable SDK/exact versions in CLAUDE.md and npm lockfile; scaffold Supabase CLI (write the exact chosen CLI version to `supabase/.cli-version`; CI reads it and rejects `latest`), Zod shared schemas, dev adapters, Sentry hooks and all GitHub Actions jobs. Never import starter ZIP.

## Explicitly out of scope

No auth screens beyond wireframe shell; no project UI, DB business logic, tracking, payments or V1.1 features.

## Acceptance tests

npm ci/typecheck/lint/format/Vitest/Jest baseline and `expo config --json` succeed; CI checks execute real tests (no echo); package lock pinned; screenshots of EN/ES role shell; PR contains concrete manual smoke instructions.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

GH; EX optional for native development build, no provider secrets required for mocked local compile.

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
