# Rollback and incident runbooks (Milestone 13)

For the owner and the platform operator. Each runbook says what to do first, what not to do, and
how to confirm it worked. Daily checks and alerts are in `docs/ops/observability.md`; secrets and
where they live in `docs/release/environments.md`. Severity levels are those of docs/spec/07
"Failure handling escalation": **0** security, privacy or a false emergency claim; **1** lost or
duplicated attendance, cross-tenant exposure; **2** a provider is down.

## 1. Roll back the app (a bad store build)

There are no over-the-air updates (decision #147), so rollback happens in the stores.

1. **Stop the spread.** App Store Connect → the version → *Phased Release* → **Pause**. Play
   Console → the release → **Halt rollout**. People who already updated keep the new build.
2. **Decide:** if the previous build is still good, App Store: submit the previous build again as a
   new version number (Apple does not re-release an old build); Play: create a release with the
   previous AAB and a higher version code. Otherwise fix forward with an expedited review.
3. **If the problem is location privacy** (anything sent off site, or after leaving): do runbook 4
   first — it protects people within minutes, before any store review.
4. Confirm: the store shows the halted rollout; Sentry crash rate returns to normal.

## 2. Roll back the backend (a bad migration or Edge Function)

1. Migrations only move forward (`supabase db push`, never `db reset` on a hosted project). Write a
   new migration that restores the previous behaviour (for a function, `create or replace` it with
   its previous definition from git history), open a pull request, wait for CI, then run the
   **deploy-backend** workflow for staging, check, then production.
2. An Edge Function can be redeployed from the previous good commit: check out that commit on a
   trusted computer, `npm ci`, then `supabase functions deploy <name> --project-ref <ref>`.
3. Never delete attendance, muster or audit rows to "undo" a bug; correct them with the app's
   audited corrections.
4. Confirm: `npm run operator -- health --reason "post-rollback check"` shows jobs succeeding.

## 3. Turn off location coordinates for a build at once (privacy kill switch)

Use when any real off-site position may have been sent, a capture check fails, or a phone shows
unexpected tracking (severity 0).

1. Production SQL editor:
   `select app_private.revoke_location_privacy_signoff('<sign-off id>', '<reason>');`
   for the affected platform and app version (list them with
   `select * from app_private.location_privacy_signoffs where revoked_at is null;`).
2. Effect: the server refuses every coordinate from that build (`COORDINATES_NOT_PERMITTED`), and
   phones fall back to TRACKING_LIMITED on their next plan refresh: only coordinate-free arrive/leave
   notes; kiosk and foreman count people (decision #90).
3. Raw on-site fixes are deleted within 24 hours by the hourly job anyway; do not wait for it if a
   leak is confirmed — ask counsel about notification duties (spec 09 breach process).
4. Confirm with a capture (HUMAN_CHECKLIST §12, "Real-device location privacy sign-off") and `npm run privacy:capture-check`.

## 4. Suspected off-site location leak (severity 0)

1. Runbook 3 immediately.
2. Halt the store rollout (runbook 1).
3. Keep the evidence: the capture file and the Sentry event ids, privately. Never paste
   coordinates into an issue or a chat.
4. Fix, re-run the capture with the checker, record a **new** sign-off only for the fixed version.

## 5. Lost or stolen phone, or a leaked device secret

- `npm run operator -- revoke-device <device id> --reason "<ticket>"`. The next upload from that
  phone is refused (pgTAP 031, backend pen-edge test). The worker activates a new phone; the old
  one cannot come back.
- A lost kiosk tablet: the project's attendant or superintendent revokes the kiosk in the app;
  the next scan is refused.

## 6. Staff member lost every authenticator

Verify the person outside the app (call back on a known number), then
`npm run operator -- mfa-reset <user id> --reason "<ticket>"`. They enrol a new authenticator at
next sign-in.

## 7. SMS sign-in codes not arriving (Twilio down or rate-limited, severity 2)

- Workers use supervised onboarding at the kiosk and printed badges; nothing else stops.
- Check Twilio status and the usage alerts; never raise the app's own rate limits to push more
  codes through (they protect against SMS pumping).

## 8. Supabase outage (severity 2 → 1 if it lasts)

- Phones keep their native location queue and the operational outbox; the app shows "Offline" or
  stale data, never false success. Nothing to do on the phones.
- After recovery: the operator `health` check; the attendance sweep and report deadline jobs catch
  up on their next runs.

## 9. Push notifications failing during a muster (severity 2)

The muster works without push: the board, the in-app I'M SAFE, the kiosk assembly scan and the
foreman crew check all keep working. Use the board's "alert failed / no phone registered" list to
check those people physically.

## 10. Account deletion stuck

`health` shows `account_deletions.pending` older than a day: check the `sitemuster-privacy-maintenance`
job runs (`select * from cron.job_run_details order by start_time desc limit 20;`). A legal hold
postpones deletion on purpose (HUMAN_CHECKLIST §9); otherwise fix the job and let it run — never
delete rows by hand.

## 11. Reviewer demo misused or no longer needed

`select app_private.retire_reviewer_demo('<demo organization id>');` stops simulation at once and
archives the demo project. Then rotate or remove the test phone numbers in the Phone provider
(`docs/release/reviewer-demo.md`).

## 12. A secret leaked (key, token, password)

1. Rotate it at its source (Supabase, Twilio, Google, Sentry, Expo, Apple, Google Play), then update
   the one place it lives (`docs/release/environments.md`).
2. `BADGE_SECRET_ENCRYPTION_KEY` is special: rotating it means every worker re-activates their phone
   (badges stop working until then). Plan it out of shift hours.
3. Look for use in the audit and Supabase logs; record a security flag review with the operator CLI.
