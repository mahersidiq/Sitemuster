# Releasing SiteMuster (Milestone 13)

The path from this repository to the App Store and Google Play, in order. Each step names the
document with the details. Current state: `docs/release/release-readiness.md` (**not ready for
public release; field pilot pending**).

1. **Accounts and keys** — `docs/setup/HUMAN_CHECKLIST.md` §1–§10, in that order. Where each value
   goes, for staging and production separately: `environments.md`.
2. **Brand and legal** — clear the name and app identifiers; counsel approves the English and
   Spanish notices (HUMAN_CHECKLIST §9). Production refuses consent, musters and production builds
   until then.
3. **Backend** — GitHub → Actions → **deploy-backend** → staging, then production
   (`runbooks.md` §2 for rollback). Set the Edge Function secrets per project (`environments.md`
   §3).
4. **Builds** — GitHub → Actions → **release** → `preview` for testers, `production` for the stores
   (`native-builds.md`).
5. **Phone tests** — `phone-test-checklist.md` on the release candidate, including the real-device
   location privacy sign-off (HUMAN_CHECKLIST §12) checked with `npm run privacy:capture-check`.
6. **Reviewer demo** — seed it on production (`reviewer-demo.md`).
7. **Store submission** — `store-submission.md`, `apple-review-notes.md`,
   `play-background-location-video.md`. The release workflow can send a production build to
   TestFlight and to Play internal testing as a draft; publishing is always done by a person in App
   Store Connect and Play Console.
8. **Field pilot** — 30 workdays, `field-pilot-protocol.md`; the owner signs
   `pilot/pilot-sign-off.md`.
9. **After launch** — phased/staged rollout; daily operator health check
   (`docs/ops/observability.md`); incidents and rollback: `runbooks.md`.
