# 09 — Security, privacy, legal and operational safety rules

## Threat model and hard controls

Potential attackers: worker impersonator, employee with copied badge, malicious GC/subcontractor, leaked QR token, stolen phone/device credential, credential stuffing/SMS abuse, cross-tenant attacker, privileged operator, GPS spoofer, network observer. Risks: identity theft, stalking/offsite surveillance, safety false positives, timesheet manipulation, leaked emergency contacts, fraudulent crew reports. Require role/RLS enforcement, server-derived IDs, audit, replay-resistant signed tokens, short-lived credentials where applicable, device revocation, rate limits and minimization. RLS alone does not protect service-role Edge Functions: explicit privilege scoping and tests are mandatory.

## Personal tracking and privacy contract

- Before recording, approved project enrollment **and versioned project-specific consent**. Consent locale EN/ES, approved legal text, worker and timestamp; signed in app or supervised documented acknowledgment for no-phone users. If consent revoked, no continued GPS uploads. Kiosk/foreman alternative stays available.
- Offsite detection can use OS-local geofence monitoring but **must never send offsite coordinates to GC or server telemetry**. No employee route history. Native SDK geofence template strips coordinates; any unfiltered location upload after exit is a privacy release blocker. Native network traces mandatory.
- Location visible only to assigned GC/safety roles authorized under `02-roles-permissions.md`, and foreman own workers only by express grant. Platform operator cannot see GPS. Current/latest position has observed_at and accuracy; stale not live.
- Raw onsite fixes removed within 24h of closed session; unresolved raw fixes periodically purged on <=24h schedule. Coordinate-free event receipts and minimum necessary daily records retained under documented policies. Do not include GPS data in Sentry, HTTP error logs, push, notification payloads, crash screenshots, or shared report exports.
- Worker can view their history, request correction and initiate in-app account deletion. Immediate revoke auth/device tokens; identifying profile/contact removed <=30d unless lawfully held. Attendance retained and pseudonymized only with legal/contract basis; otherwise delete. Pseudonymous records are still protected personal data.
- Set project-specific data handling agreements and notice; GC/subcontractor boundaries; independent state law, union CBA, worker monitoring notice and timekeeping review. Do not imply payroll, certified wage tracking, OSHA compliance or guaranteed rescue accountability.

## Session and key management

- Worker: Supabase Phone OTP Twilio; staff: verified email + TOTP MFA. OTP 6 digits /600s, resend 60s; rate-limit by phone, hashed phone, IP, device and organization; do not expose existence of registered accounts.
- Mobile Supabase refresh tokens: encrypted AES-256-GCM (`@noble/ciphers`) SQLite with per-install random key kept via `expo-secure-store` (`AFTER_FIRST_UNLOCK` iOS). Persisted JSON not copied into logs. Logout clears key/session; compromise device resets keys.
- Native uploader: separate 32-byte random bearer secret over HTTPS, SHA-256 hash server-side; current device->worker->project authorized binding, 30d expiry, rotate <=7d before via foreground, silent push or SDK headless task (24h old-token overlap, SDK headers updated via setConfig), revoke immediately on replacement/logout/consent withdrawal. Neither upload credential nor session lives in app source.
- App package IDs provisional until verified brand; no license purchase prematurely. Only server keys in Supabase secrets/GitHub Environments, never `EXPO_PUBLIC_*`. Android Google Maps key may be embedded only with package/SHA signing restriction. All server-side Places/Geocoding keys restricted and proxied.

## Server security

- Default deny Row Level Security for each table and private Realtime Broadcast policy on `realtime.messages`.
- Custom location ingestion Edge Function uses `verify_jwt=false` for **that function only**, authenticates high-entropy bearer credential itself, derives worker/device/projects from DB; every privileged statement scoped to derived IDs. Reject project A credential writing project B; no unrestricted service-role queries. Logs only safe hash/truncated device identifiers and result codes.
- Worker/kiosk/foreman operational API requires JWT, actual membership + event-source permission + specific project/company. No authority from payload `actor_id` alone. Route mutation through signed Edge Function/RPC and transaction.
- Kiosk dynamic badge: offline-capable 30-second HMAC badge (see `11-api-contracts.md` § Offline worker badge); generated on the worker phone with no network, verified server-side on kiosk sync, single-use per (device, step, project), project bound; printed badge opaque ID with attended verification, not strong anti-buddy-punch proof. Session static orientation QR valid during 120-minute orientation only, no approval. Rotation 60s on super screen.
- Rate-limit enrollment, SMS OTP, badge issue/scan, invites, operator functions, attendance ingestion and report exports. On suspicious activity, flag and alert, do not automatically erase evidence.
- Storage restricted by org/project; no public emergency contacts, hidden map data, personally identifying roster dumps, or vulnerable direct file URLs.

## Platform operator restrictions

Operator role exists only in private backend/CLI V1, requires verified account+MFA, least privilege and reason. May search org metadata, revoke credentials, resend invite, view non-sensitive health. Cannot read coordinates, emergency contacts or impersonate users. Every action audited in append-only `platform_operator_actions`.

## Reviewer/demo mode

Seed a synthetic `SITEMUSTER_DEMO` org and explicit reviewer account through staging/controlled production demo environment; server-side allowlist checks demo org ID before simulated entry/exit, no real customer projects. Demonstrate UI without claiming native GPS validation. Do not leave dev simulation features exposed to ordinary production users. Native location permission review video must show actual OS behavior on an appropriate physical device.

## Required legal review and consent

Human bilingual legal review of EN+ES disclosures, union/CBA and Texas/other state workplace monitoring notice, subcontractor data processing and GDPR/CCPA applicability where relevant. Do not assume universal permissibility across states. `docs/legal/TRANSLATION_REVIEW.md` approval blocks production. Provide easy-to-find account deletion within mobile app and worker data access. Maintain security incident response and breach notification process separately, with contacts configured privately during human setup.

## Security release blockers

Cross-project leakage, unauthorized emergency contacts, service-role query misuse, offsite GPS transmission, spoofed privileged role, lack of required notice, uncontrolled printed-badge access or account deletion not functioning are no-go for production. Unit tests alone never certify privacy; real captured network traffic tests and legal sign-off are required.
