# Secrets audit — devices, QR codes, tokens and server keys (Milestone 12)

Scope: every credential or secret value SiteMuster creates, stores or relies on, checked against `docs/spec/09-security-privacy.md` ("Session and key management", "Server security"). This page records how each one is created, stored, limited in time, revoked, deleted and kept out of logs.

The audit is enforced by tests, so it cannot quietly drift:

- `supabase/tests/database/030_secrets_rate_limits.test.sql`
  - Every secret-like column in `public` and `app_private` must be in the inventory below (a new one fails the build).
  - No API role can touch the private secret tables.
  - Hash columns are not readable through the API.
  - Every stored credential hash is a 32-byte SHA-256.
  - The hourly purge deletes expired QR, badge and push secrets.
- `tests/security/crash-report-privacy.test.ts`: crash reports remove tokens, codes, QR codes and coordinates.
- `tests/security/edge-logging.test.ts`: Edge Function logs go through the scrubber.
- `tests/security/bundle-secrets.test.ts`: server keys never reach the app bundle (real iOS and Android bundles built with canary values).
- `tests/security/env-files.test.ts`: no `.env` file is committed except `.env.example`.

## Device and QR secrets (created by SiteMuster)

| Secret | Created | Stored on the server | Lifetime and rotation | Revoked | Deleted |
|---|---|---|---|---|---|
| Phone upload credential (native location uploader) | `device-activate`, 32 random bytes | Only its SHA-256 (`app_private.device_upload_credentials.token_sha256`) | 30 days. Rotated in the last 7 days via `device-renew`; the old token keeps working for 24 h | At once on phone replacement, sign-out, account deletion or operator `revoke-device`. Withdrawn consent ends that project's binding at once (uploads for it are refused) | Hash only. Kept for audit; it cannot be turned back into a token |
| Phone badge key (offline 30-second HMAC badge) | `device-activate`, 32 random bytes | AES-256-GCM encrypted with the Edge secret `BADGE_SECRET_ENCRYPTION_KEY` (`device_badge_secrets.secret_ciphertext`, device id as associated data) | Life of the phone activation | At once with the phone; badges from a revoked phone are refused (`DEVICE_REVOKED`) | **24 h after revocation** (hourly job, new in M12) |
| Printed badge (`SMP1.…`) | `issue_printed_badge`, random | Only its SHA-256 (`worker_badges.opaque_badge_hash`) | Until replaced or revoked; attended kiosk only | `revoke_printed_badge`, account deletion | Hash only |
| Rotating orientation QR (`SMO1.…`, 60 s) | Supervisor phone, from the session's 32-byte rotating key | The key, privately (`orientation_session_secrets.rotating_secret`) | Session ≤ 120 minutes; each code is valid for its minute ±1 | Closing or replacing the session | **When the session closes, or when the hourly job expires it** (before M12 an unclosed session kept its key indefinitely) |
| Printed orientation QR (`SMS1.…`) | `start_orientation_session`, 32 random bytes | Its SHA-256 in `orientation_sessions.static_code_hash`; the plain code privately in `orientation_session_secrets.static_code` so the supervisor can show it again after an app restart | Valid only while the session is open | As above | As above |
| Orientation join pass | Server, after a valid scan | Only its SHA-256 (`orientation_join_grants.token_hash`) | Ends with the session | Session close | **7 days after it expired** (hourly job, new in M12) |
| Staff invitation | `invite_org_admin` / `invite_project_staff` | No bearer token exists: the invitation is accepted in the app by the signed-in person whose verified email matches. `token_hash` is the SHA-256 of 32 random bytes that are never shown to anyone (it only makes each row unique) | 7 days (operator `resend-invite` re-arms for 7 days) | `revoke_invitation` | — |
| Expo push token | The phone (Expo) | Plain text, privately (`app_private.push_tokens.expo_token`); needed to send | Until the phone revokes it or signs out | Sign-out, account deletion, re-registration | **24 h after revocation** (hourly job, new in M12) |
| Kiosk | `register_kiosk` | No separate secret: a kiosk runs under the attendant's own signed-in staff session (email code + authenticator). `device_public_id` is an identifier, not a secret | Attendant's session | `revoke_kiosk`, staff removal | — |

What is never stored anywhere on the server: a plain upload token, a plain badge key, a printed badge code or a join pass. On the phone, the activation result (upload credential and badge key) is kept in `expo-secure-store`.

Column-level protection:
- `app_private` tables cannot be read or written by `anon`, `authenticated` or `service_role`; only reviewed security-definer functions use them.
- Hash columns in shared tables (`token_hash`, `static_code_hash`, `rotating_secret_id`, `opaque_badge_hash`, `hardware_installation_hash`) have no SELECT grant for `anon` or `authenticated`.

## Sessions on the phone

- The Supabase session (refresh token) is AES-256-GCM encrypted in SQLite with a per-install random key held in `expo-secure-store` (`AFTER_FIRST_UNLOCK` on iOS), using `@noble/ciphers`. Sign-out deletes both.
- The upload credential and badge key are kept in `expo-secure-store` (`src/device/device-store.ts`) and are separate from the session. The native uploader can be revoked without signing the person out.
- TOTP secrets are held by Supabase Auth (`auth.mfa_factors`). The app never logs the setup link; the scrubber removes `otpauth://` links and base32 secrets.

## Server keys (human setup; never in the app or the repository)

| Key | Where it lives | Notes |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase (provided to Edge Functions) | Never in the app bundle (bundle canary test). Edge Functions use it only for `edge_*` functions with server-derived ids |
| `BADGE_SECRET_ENCRYPTION_KEY` | Supabase Edge secret per project | Without it, `device-activate` and `ingest-operations` fail closed on staging and production; the fixed development key is refused there too. Losing it means every worker re-activates their phone |
| `GOOGLE_PLACES_SERVER_KEY`, `GOOGLE_GEOCODING_SERVER_KEY` | Supabase Edge secrets | API-restricted, quota-limited; proxied by authenticated Edge Functions |
| `GOOGLE_MAPS_ANDROID_API_KEY` | EAS environment (sensitive) | Client key, restricted to the package and signing certificates; `app.config.ts` refuses a server key here |
| Twilio credentials | Supabase Auth provider settings | Never in GitHub or the app |
| `EXPO_ACCESS_TOKEN` (optional) | Supabase Edge secret | Only with Expo "enhanced push security" |
| `SENTRY_AUTH_TOKEN` | EAS/GitHub protected secret | Source maps only. The DSN is public (`EXPO_PUBLIC_SENTRY_DSN`) |
| `TS_ANDROID_LICENSE_KEY` | EAS production secret | Build-time only |
| `SITEMUSTER_ENV` | Supabase Edge secret | `staging` / `production` on hosted projects; `development` there would switch to labelled fakes, so the checklist forbids it |

`DEVICE_CREDENTIAL_PEPPER` is **not used** (decision #135). Upload tokens are 256-bit random values, so their plain SHA-256 cannot be guessed offline. A pepper would add a key to manage without adding protection.

## Logs and crash reports

- Edge Functions log only through `supabase/functions/_shared/log.ts`, which runs the shared scrubber on entries that already hold only request ids, outcome codes, counts and truncated ids.
- Mobile crash reports (Sentry) go through the same scrubber (`beforeSend` / `beforeBreadcrumb`), with no screenshots, no view hierarchy and no default PII. It removes:
  - coordinates, phone numbers, emails and contact or name fields;
  - JWTs, bearer tokens and query-string credentials;
  - one-time codes, including `{ code: '123456' }`;
  - badge payloads (`SMB1`, `SMP1`), orientation QR codes (`SMO1`, `SMS1`) and Expo push tokens;
  - authenticator links and secrets, installation ids, and long random secrets.

## Findings fixed in Milestone 12

1. **Unclosed orientation sessions kept their QR secrets.**
   - Problem: a session that simply ran past its 120 minutes stayed `OPEN` in the database with its rotating key and printed code.
   - Fix: the hourly job now marks it `EXPIRED` (or `REVOKED`) and deletes both secrets.
2. **Revoked badge keys and push tokens were kept forever.** Both are now deleted 24 hours after revocation.
3. **Expired orientation join passes were kept forever.** They are now deleted after 7 days.
4. **Phone activation was not rate-limited**, and someone who had asked to delete their account could still activate a phone with a not-yet-expired access token.
   - Activation is now limited to 10 an hour per person.
   - It is refused once deletion has been requested.
   - A refused activation leaves no new device or credential.
5. **Edge Function logs were not scrubbed** (they relied on each entry being built safely). Every log line now passes the scrubber, and a test blocks raw `console` calls.
6. **Gaps in the crash-report scrubber**: the rotating orientation QR code, Expo push tokens, authenticator links and secrets, and one-time codes stored under a `code` key. All are now removed and tested.

## Still to verify with real accounts (NOT VERIFIED here)

- Hosted Supabase secrets are set per project and differ between staging and production (`HUMAN_CHECKLIST.md` §3).
- A real Sentry project receives a crash from a development build and the event shows no coordinates, tokens or codes (`HUMAN_CHECKLIST.md` §6).
- A captured network trace from a real phone shows the upload credential only in the `Authorization` header of HTTPS requests to the ingest function (release gate, decision #90).
