# Milestone 13 — Native release preparation, review demo and field pilot

## Goal

Native release preparation, review demo and field pilot. This is **one Claude Code task and one PR**. After opening the ready-for-review PR, **stop; do not begin Milestone 14 automatically**.

## Mandatory reading before any edit

- `CLAUDE.md`
- `docs/spec/00-decision-log.md`
- `docs/spec/01-product.md`
- `docs/spec/03-location-engine.md`
- `docs/spec/07-edge-cases.md`
- `docs/spec/08-i18n.md`
- `docs/spec/09-security-privacy.md`
- `docs/spec/10-testing.md`
- `docs/spec/12-muster-mode.md`
- `docs/setup/HUMAN_CHECKLIST.md`
- `docs/legal/TRANSLATION_REVIEW.md` (if legal, consent or translated user text is touched)

## Exact scope

Configure iOS/Android native builds, store permissions, brand/package clearance, license, EAS release pipelines, staging vs prod secrets, dedicated server-gated synthetic reviewer demo, Apple Review notes, Google background-location video script, human phone test checklist, 30-workday field pilot protocol, rollback/runbooks.

## Explicitly out of scope

No marketing website, Vercel implementation, pricing, advanced reports or unapproved V1.1 work.

## Acceptance tests

Reproducible EAS builds on owner account, reviewer demo cannot affect real data, physical offsite network trace privacy pass, no release blockers, App Store/Play submission requirements documented, field test logs owner-signed. If pilot not run, label FIELD_PILOT_PENDING and do not claim public readiness.

**Test discipline:** Run local checks available in the Claude Code environment. GitHub Actions must run all required Docker/Supabase tests on ubuntu. Report both separately; simulated location is not proof of physical-device behavior. Security/privacy failures block PR readiness. CI green, no placeholders, no hardcoded production mock success.

## Human-checklist dependencies

GH, EX, SB staging/prod, TW, GC, SE, AP, GP, finalized brand IDs, TS release key, legal approval, physical iOS/Android devices.

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
