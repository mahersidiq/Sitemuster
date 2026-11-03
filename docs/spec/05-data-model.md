# 05 — PostgreSQL multi-tenant schema and invariants

## Conventions

PostgreSQL/Supabase + PostGIS. Primary keys `uuid`; timestamps `timestamptz` UTC; IANA time zone per project; `created_at`, `updated_at`; all tables private by default with RLS; restrict access via server-derived `auth.uid()` and memberships. Client must never write role, consent approval, authoritative sessions, event processing outcomes or location tables directly. Migration history is immutable; no production reset. Every privileged transaction has request/event UUID for idempotency and auditable actor. Use view/functions designed for employee self-access vs GC vs foreman vs platform operator, with explicit grants and RLS tests.

## Exact conceptual tables and key columns

| Table | Required columns / constraints |
|---|---|
| `organizations` | id, name, address, business_email, phone, owner_user_id FK, status enum, created_at; organization creation idempotency_key unique per authenticated user |
| `organization_members` | id, organization_id, user_id, role enum OWNER/ADMIN, membership_status, added_by; unique active org/user/role; prevent zero owner |
| `organization_invitations` | id, org_id, email/phone target, role, expiry, revoked_at, token_hash, invited_by, used_at |
| `projects` | id, organization_id, name, project_number, address, lat/lng center, geofence_radius_m, iana_timezone, `operates_24_7`, status DRAFT/ACTIVE/PAUSED/COMPLETED/ARCHIVED, assigned superintendent, config_version_id |
| `project_staff` | id, project_id, user_id, role PM/SUPER/SAFETY/ATTENDANT, status, added_by, unique active role binding |
| `project_work_windows` | id, config_version_id, weekday 1–7, local_start_time, local_end_time, crosses_midnight, enabled, order; 24/7 bypasses window requirement |
| `project_tracking_config_versions` | id, project_id, version_number, effective_at, created_by, full jsonb config validated, sha256 digest; unique project/version; immutable, no UPDATE/DELETE by clients |
| `project_geofences` | id, config_version_id, project_id, center geography point, radius_m, sdk_identifier (opaque stable), status; V1 circles only |
| `subcontractor_companies` | id, canonical_name, verified_status, verified_by, contact info, created_at; verification cannot be self granted |
| `project_subcontractors` | id, project_id, subcontractor_id, status, approved_by; unique active project/company |
| `subcontractor_members` | id, company_id, worker_profile_id or user_id, role WORKER/FOREMAN, verification_status, valid_from/until, authorized_by |
| `worker_profiles` | id, auth_user_id nullable for `managed_identity`, legal_name, optional email, phone nullable for no-phone, primary_language en-US/es-US, managed_identity, created_at, deleted_at; uniqueness rules prevent duplicate auth-account mapping |
| `emergency_contacts` | id, worker_profile_id, name, phone, relationship, created_at; restricted encrypted-at-rest field policy where justified, no broad admin read |
| `orientation_sessions` | id, project_id, started_by, starts_at, expires_at (<=120m), status, static_code_hash, rotating_secret_id, revoked_at; only project-bound session token |
| `orientation_invites` | id, session_id, project_id, invite_token_hash, kind ROTATING/STATIC, expires_at, redeemed_at if single-use, revoked_at, audit; static reusable only while session open |
| `orientation_records` | id, worker_profile_id, project_id, session_id, status ORIENTATION_COMPLETED, completed_at, operator_id when supervised, notice_version_id |
| `worker_enrollments` | id, project_id, worker_id, subcontractor_id nullable, enrollment_status PENDING/APPROVED/REJECTED/REVOKED, employer_status PENDING_CONFIRMATION/VERIFIED/REJECTED, approved_by, approval_at, revoked_at, unique active project/worker |
| `tracking_consents` | id, worker_id, project_id, notice_version_id, locale, method DIGITAL/SUPERVISED, accepted_at, withdrawn_at, reviewing_actor, evidence_digest; no implied consent |
| `legal_notice_versions` | id, project_id nullable for standard global notice, locale, document_type, content_hash, review_status DRAFT/REVIEWED/APPROVED, approved_by, published_at; worker consent references approved version |
| `device_installations` | id, worker_id, platform IOS/ANDROID, hardware_installation_hash, app_version, active, activated_at, deactivated_at, replaced_by; unique one active personal device/worker |
| `device_project_bindings` | id, device_id, project_id, enrollment_id, enabled, config_version_id, revoked_at; unique active device/project, must match approved worker membership |
| `device_upload_credentials` | id, device_id, token_sha256 bytea unique, created_at, expires_at 30d, revoked_at, rotated_from, overlap_until (rotation +24h); token never stored plaintext |
| `device_push_tokens` | device_id, expo_push_token, platform, updated_at; used for silent renew push and expiry reminders |
| `kiosk_devices` | id, project_id, assigned_operator_user_id, device_public_id, status, registered_at, last_seen_at, revoked_at; separate from personal tracking devices |
| `worker_badges` | id, worker_id, badge_kind DYNAMIC_APP/PRINTED, opaque_badge_hash, active, issued_by, issued_at, revoked_at; printed badge must not expose PII |
| `badge_nonce_redemptions` | project_id, device_id, time_step, redeemed_at, operator_id, kiosk_device_id; UNIQUE(project_id, device_id, time_step); enforce ±1 step window against kiosk observed time and one-use replay protection |
| `device_badge_secrets` | device_id PK, secret_ciphertext (AES-256-GCM, key derived from `BADGE_SECRET_ENCRYPTION_KEY`), created_at, revoked_at; issued once at device-activate, rotated on device replacement; never returned again after issuance |
| `location_event_receipts` | event_uuid unique, device_id, worker_id, project_id, config_version_id, event_type, observed_at, server_received_at, accuracy_m nullable, qualification_state, terminal_result ACCEPTED/DUPLICATE/REJECTED, rejection_reason, no offsite coord; immutable append-only outcome log |
| `latest_onsite_positions` | project_id, worker_id unique, encrypted or tightly RLS-restricted `geography(Point)`, horizontal_accuracy_m, observed_at, received_at, expiry_at; delete on exit/revoke and freshness TTL |
| `attendance_events` | event_uuid unique, worker_id, project_id, actor_id nullable, kiosk_device_id nullable, config_version_id, source enum, direction ENTRY/EXIT/VERIFY/CORRECT, observed_at, received_at, verification_status, reason, original_payload_digest, immutable audit; visitor events separate |
| `presence_states` | project_id, worker_id unique, presence_state, first_inside_at, last_seen_at, last_confirmed_inside_at, arrival_confirmed_at, confidence enum, changed_at, config_version_id; never boolean presence flag |
| `attendance_sessions` | id, project_id, worker_id, employer_snapshot_id, start_at, end_at nullable, start_source, end_source, config_version_id, status, uncertainty start/end bounds, last_seen_at, created_at, updated_at; partial unique index for one OPEN/UNRESOLVED project/worker session with explicit reconciliation logic |
| `attendance_corrections` | id, session_id, requested_by, approved_by nullable, reason, original_json, proposed_json, status, action_at; append-only history |
| `visitor_records` | id, project_id, name, organization, host_user_id, purpose, contact data minimal, identity_status, created_at; PII restricted, separate from worker roster |
| `visitor_visits` | id, visitor_id, project_id, kiosk_actor_id, checked_in_at, checked_out_at nullable, status, correction audit ID, idempotency key |
| `daily_company_reports` | id, project_id, subcontractor_id, local_date, report_version, summary jsonb, generated_at, status PENDING_CONFIRMATION/CONFIRMED/DISPUTED/NOT_CONFIRMED, due_at; unique project/company/date/version |
| `report_confirmations` | id, report_id, version, foreman_user_id, action CONFIRM/DISPUTE/SUBMIT_CORRECTION, comment, created_at; immutable |
| `muster_events` | id, project_id, triggered_by, triggered_at, ended_at nullable, status ACTIVE/CLOSED, roster_snapshot_hash, closeout_report_digest, config_version_id |
| `muster_snapshot_members` | id, muster_id, worker_id nullable, visitor_id nullable, source and last detection metadata at trigger, canonical_status, unique event/person; encrypted snapshot identity access restricted |
| `muster_responses` | id, muster_id, snapshot_member_id, action SELF_REPORT/PHYSICAL_VERIFICATION/STATUS_UPDATE, responder_id, channel, kiosk_device_id nullable, observed_at, received_at, immutable, reason |
| `push_tokens` | id, auth_user_id, installation_id, expo_token encrypted/restricted, platform, last_validated_at, revoked_at; secure owner-only |
| `operational_outbox_receipts` | event_uuid unique, kiosk_device_id/actor_id, project_id, payload_schema, terminal_status, rejection_reason, accepted_at; no double consumption |
| `platform_operator_actions` | id, platform_user_id, action enum, target_organization_id, reason, executed_at, result; no precise coords/emergency contacts |
| `audit_logs` | id, actor_type, actor_id, org/project IDs, action, resource_id, occurred_at, request_id, safe metadata, no coordinates/tokens/OTP or emergency details |

`location_event_receipts` is *not* a raw location history. If short-lived raw onsite fixes are needed for dwell/replay investigations, use `raw_onsite_fixes` partitioned with `expires_at<=session_closed_at+24h`, strict RLS and scheduled purge, keeping coordinate-free immutable event receipts.

## DB safety constraints and indices

- `CHECK (-90<=latitude<=90)` and `-180..180` where numeric; canonical PostGIS SRID 4326; radius >=150 <=2000; accuracy >=0.
- One active personal device per worker partial unique index `device_installations(worker_id) WHERE active=true`.
- One active approved enrollment per project/worker; approved requires accepted project notice and separately confirmed company if claimed.
- One open attendance interval per project/worker; use advisory/row lock and transaction to prevent race. Source must be enums from `04-attendance-rules.md`.
- `UNIQUE(location_event_receipts.event_uuid)` and `UNIQUE(attendance_events.event_uuid)` and separate operational outbox receipt UUID.
- Critical joins must include `organization_id/project_id` and verify parent ownership in DB, not just application filters.
- Index `project_id, observed_at`, `project_id, worker_id`, `device_id, received_at`, `project_id, local_date`; no unbounded Realtime subscriptions to raw event tables.
- Soft-delete or archive according to record type; `project_tracking_config_versions` and audit outcomes immutable, backups managed in Supabase Pro.

## Data retention and deletion

- Latest onsite coordinates disappear after exit/revoke, and stale previews are clearly marked; raw coordinate records purged within 24h of closed session and regularly even if unresolved.
- Attendance default **two years only if there is documented legal/contractual basis**; otherwise use documented shorter project policy and deletion. Do not automatically hold everything forever.
- In-app worker deletion: revoke tokens immediately, remove profile/emergency contacts within 30d, legal-hold exception documented; pseudonymize retained attendance with non-identifying public label `Deleted worker #xxxx`, retain secure restricted mapping only where law/hold requires. Pseudonymization isn't anonymization.
- Visitor records follow a specific project-approved retention policy and emergency response needs; never inherit workforce payroll assumptions.
- Audit of deletions, exports and hold changes is itself minimal-data and immutable.

## Migration/test requirement

Every new table gets RLS and explicit INSERT/UPDATE/DELETE/SELECT tests under worker, foreman, GC A, GC B, safety, and platform role; CI runs pgTAP migrations with Docker Supabase. No global `USING (true)` policy for sensitive tables. Security-definer functions set safe `search_path`, validate auth-derived actor and restrict grants.
