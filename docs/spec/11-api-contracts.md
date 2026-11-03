# 11 — API contracts, Zod fields, custom device ingestion and Realtime

## API conventions

- Endpoints live at `https://<supabase-project-ref>.supabase.co/functions/v1/<function-name>`; use environment-provided Supabase URL, never commit secrets. All responses `application/json` with `schema_version=1`, `request_id` and machine error code.
- Client actor fields are suggestions only; server derives identity and project/company scope from credential/JWT + stored memberships.
- All operational mutations idempotent on `event_uuid` (UUID v4 or collision-resistant UUID from native SDK). UTC ISO-8601 timestamps. Zod `strictObject` on canonical API; native raw SDK input normalized first. ISO code enums mirrored across DB and `packages/shared` Zod. No direct mobile edits to authoritative attendance or role fields.
- Production transport HTTPS only. Rate limits enforced server-side, not just UI. Non-2xx error responses never claim success.

## Exact native location POST

**Path:** `POST /functions/v1/ingest-location-batch`.

**Auth:** `Authorization: Bearer <32-byte-random-device-upload-token>` (base64url encoding); `verify_jwt=false` **only for this Edge Function**, custom bearer verification mandatory. SHA-256 of raw token stored in `device_upload_credentials`; compare safely, check expiry/revoked, resolve server-side `device_installations`, `worker_profiles`, currently approved `worker_enrollments`, accepted consent, `device_project_bindings` and effective config. Do not trust supplied worker/project/org ID, even in SDK extras/params. **One active personal device per worker.** Device token may allow multiple explicit project bindings; matching opaque `sdk_geofence_identifier` resolves to exactly one authorized project; unbound IDs rejected. Backend writer has service-role powers only within this scoped transaction, never generic data access.

**Limits:** `maxBatchSize=25`, max HTTP entity `262144` bytes, max `60` requests/min/device, max `600` events/hour/device. HTTP 429 includes `Retry-After: 60`. Temporary database/network failures HTTP 503, native SDK retries; 401 on missing/expired/revoked token. 405 other methods, 413 oversized, 415 non-JSON, 422 invalid envelope. Per-record permanently invalid entries are persisted to a restricted quarantine (with bounded, sanitized payload and reason) then returned `rejected` under 200 if all entries achieved terminal outcomes.

**Native SDK config:** `http.url=<endpoint>`, `http.method='POST'`, `http.batchSync=true`, `http.maxBatchSize=25`, `http.autoSync=true`, `http.rootProperty='locations'`, `http.headers.Authorization='Bearer <device-token>'`. Native `persistence.geofenceTemplate` MUST be coordinate-free, containing stable `uuid`, `timestamp`, `event:'geofence'`, `geofence.identifier`, `geofence.action`, REQUIRED `accuracy` (horizontal metres, used to corroborate EXIT) but NO latitude/longitude. Native fence radius = `geofence_radius_m + exit_hysteresis_m`. Native `locationTemplate` carries coordinates ONLY in privacy-validated onsite tracking mode. Disable provider-change synthetic geolocation uploads. Verify captured actual wire schema in SDK v5 before release; the SDK may wrap records under `locations` differently based on params and templates; use fixture captured from development build, not assumptions.

### Native incoming Zod field lists

1. **`SdkBatchEnvelopeSchema`** (strict envelope):
   - `locations`: array of 1–25 `SdkEventWireSchema` objects.
   - Optional `schema_version`: literal `1` if supplied; absence interpreted as 1.
   - No `worker_id` or `project_id` accepted as authority. SDK `params` are treated as untrusted diagnostics only.
2. **`SdkEventWireSchema`** (accept vendor wire using a dedicated adapter with strict nested normalization, preserve unknown vendor-only fields for sanitizer but never DB insert):
   - `uuid`: UUID string (required stable event ID).
   - `timestamp`: ISO-8601 UTC string.
   - `event`: `geofence|motionchange|heartbeat|location|providerchange` (the SDK's actual string map is normalized; synthetic provider-change location discarded/quarantined without coords).
   - `geofence?`: `{identifier:string, action:'ENTER'|'EXIT'}` required when geofence event; no lat/lng in wire event by privacy policy.
   - `coords?`: `{latitude:number [-90,90], longitude:number [-180,180], accuracy:number >=0}` onsite only; mutually forbidden for geofence exit and non-onsite event types.
   - `is_moving?`: boolean.
   - `mock?`: boolean; flagged suspicious, never silently accepted as strong evidence.
   - `extras?`: sanitized object, NOT used for tenant authority.
3. **`NormalizedLocationEventSchema`** (server-derived fields, internal only): `event_uuid`, `device_id`, `worker_id`, `project_id`, `organization_id`, `enrollment_id`, `config_version_id`, `kind:'GEOFENCE_ENTER'|'GEOFENCE_EXIT'|'ONSITE_FIX'`, `observed_at`, `received_at`, `accuracy_m?`, `onsite_point?`, `sdk_geofence_identifier?`, `is_mock`, `validity_state`, `source:'GEOFENCE'`. Auth-derived keys cannot be overwritten by payload.

**Runtime rules:** device bound to wrong project => permanently reject with reason `PROJECT_NOT_AUTHORIZED` and do not read/write target project. Config version missing => rejected/needs human reconciliation. An old config version associated with a still-open session is valid for that session's EXIT even if the project now uses a newer version; prevent new arrivals under stale versions. Observed timestamp >5 minutes skew => flagged/review, older than 72 hours => durable manual review, never silent approval. Onsite point must pass project site-coordinate and privacy gate; if not, immediately discard coordinates and mark event rejected/sanitized. Never log raw payload.

### Response schema

**HTTP 200 only when each record is durably `accepted`, `duplicate`, or `rejected`.** Native SDK treats any 2xx as success for **the entire batch** and deletes all queued records: server per-record status DOES NOT selectively ACK SDK queue. If any record cannot be durably committed or quarantined, return 503 for the whole batch (idempotent accepted records become duplicate upon retry).

```json
{
  "schema_version": 1,
  "request_id": "11111111-1111-4111-8111-111111111111",
  "results": [
    {"event_uuid":"22222222-2222-4222-8222-222222222222","status":"accepted","reason":null},
    {"event_uuid":"33333333-3333-4333-8333-333333333333","status":"duplicate","reason":null},
    {"event_uuid":"44444444-4444-4444-8444-444444444444","status":"rejected","reason":"PROJECT_NOT_AUTHORIZED"}
  ]
}
```

Zod response: `schema_version:z.literal(1)`, `request_id:z.string().uuid()`, `results:z.array(z.strictObject({event_uuid:z.string().uuid(),status:z.enum(['accepted','duplicate','rejected']),reason:z.string().nullable()})).min(1).max(25)`. Never return 200 if a quarantined record isn't durable. Duplicate event UUID is guaranteed by `UNIQUE(location_event_receipts.event_uuid)` and idempotent receipt logic. Rejected records persist their reason but never retain unauthorized coordinates or secret tokens.

### Privileged query guard — mandatory

Ingest process: hash credential -> lookup active credential/device -> enumerate approved project bindings -> look up SDK identifier under those bindings -> check consent/config version -> parse/normalize -> transaction insert event receipt + reconcile session/presence + latest onsite fix only if privacy approved -> per-record result. Every privileged query includes server-derived keys or is via a security-definer function with equivalent validated scope. Reject attempts to supply `organization_id`/`worker_id`/`project_id` overrides; no broad service-role SELECT that fetches data merely to post-filter.

**Tenant isolation tests:** Valid token of worker A/project A carrying project B geofence identifier, project B ID in extras, or worker B UUID: 403-like permanent rejection in result, ZERO reads/writes against B (instrument access logs and assert), no B receipt acknowledgment. Revoked device token returns 401 and no ingestion. Device switch race accepts only newly active device. Native client must not treat 401 as valid accepted batch.

## Operational offline outbox contract (separate queue)

**Path:** `POST /functions/v1/ingest-operations` with `Authorization: Bearer <Supabase user JWT>`; `verify_jwt=true` and mandatory staff/worker RBAC. **No device upload credential is accepted here.** Client `expo-sqlite` outbox owns only kiosk, foreman, manual, visitor, muster actions. Request JSON `schema_version:1`, `events:OperationEventSchema[]` (1–100 operations and <=256 KiB). Each event: `event_uuid:uuid`, `project_id:uuid`, `operation_type:'KIOSK_ENTRY'|'KIOSK_EXIT'|'FOREMAN_BULK_ENTRY'|'FOREMAN_BULK_EXIT'|'MANUAL_ATTENDANCE_CORRECTION'|'VISITOR_ENTRY'|'VISITOR_EXIT'|'MUSTER_SELF_REPORT'|'MUSTER_PHYSICAL_VERIFY'`, `observed_at:ISO UTC`, `payload: discriminated Zod object`, `source` derived server-side from type. Return each event `accepted|duplicate|rejected` and human reason. Client removes only accepted or durable rejected/duplicate operations; failed temporary events stay queued. Foreman bulk payload contains named worker UUID list <=100, server produces each worker outcome with child idempotency IDs, not a partial silent success.

**Payload discriminators:** kiosk `{badge_payload:string, badge_kind:'DYNAMIC_APP'|'PRINTED', kiosk_device_id:uuid, direction:'ENTRY'|'EXIT'}`; foreman `{subcontractor_id:uuid, worker_ids:uuid[], direction:'ENTRY'|'EXIT', verification_method:'PHYSICAL_CONFIRMATION'|'FOREMAN_REPORT'}`; manual `{worker_id:uuid, session_id:uuid?, corrected_start_at?:ISO, corrected_end_at?:ISO, reason:string}`; visitor `{visitor_id:uuid?, name?, organization?, host_user_id:uuid, purpose:string, direction:'ENTRY'|'EXIT'}`; muster `{muster_id:uuid, snapshot_member_id:uuid, action:'SELF_REPORT'|'PHYSICAL_VERIFICATION', witness_actor_id?:uuid}`. No client `actor_id` authority: server from JWT, plus membership role.

## Offline worker badge (replaces server-issued badge JWT)

Reason: gate kiosks are where reception is worst; a badge that must be fetched from the server fails exactly where the fallback is needed.

- At `device-activate`, server generates a 32-byte random `badge_secret`, stores it AES-256-GCM encrypted in `device_badge_secrets`, returns it once. App stores it in `expo-secure-store` (`AFTER_FIRST_UNLOCK`). Rotated on device replacement; revoked with the device.
- App renders QR payload `SMB1.<device_id>.<project_id>.<time_step>.<mac>` where `time_step = floor(unix_seconds / 30)` and `mac = base64url(HMAC-SHA256(badge_secret, "SMB1|" + device_id + "|" + project_id + "|" + time_step))[0..22]`. Generated locally every 30 s with no network. Use `@noble/hashes` for HMAC.
- Kiosk does NOT verify the MAC (it never holds secrets). It records `badge_payload`, its own `observed_at`, and queues the operation in the expo-sqlite outbox; UI shows `PENDING_SYNC` until server ACK, then ACCEPTED/REJECTED per person.
- Server on `ingest-operations`: parse, load device → active worker → approved enrollment for that project, recompute MAC with constant-time compare, require `|time_step − floor(kiosk observed_at/30)| ≤ 1`, insert `badge_nonce_redemptions` UNIQUE(project_id, device_id, time_step) (duplicate ⇒ `duplicate` if same kiosk event_uuid else `rejected:BADGE_REPLAY`). Kiosk clock skew > `max_device_clock_skew_seconds` vs received_at ⇒ attendance created as REVIEW_REQUIRED.
- Revoked/replaced device ⇒ `rejected:DEVICE_REVOKED`. Printed badges unchanged (opaque ID, `KIOSK_PRINTED_BADGE`, weaker evidence).
- Zod: `BadgePayloadSchema = z.string().regex(/^SMB1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.\d{8,12}\.[A-Za-z0-9_-]{22}$/)`.

## Other Edge endpoints (authenticated)

| Method / path | Input keys | Output keys / authorization |
|---|---|---|
| `POST /functions/v1/address-search` | `query:string`, `session_token:string` | Places autocomplete candidates, localized, scoped & rate-limited; no Google server key in app |
| `POST /functions/v1/address-resolve` | `place_id:string`, `session_token:string` | normalized address, lat/lng, provider attribution |
| `POST /functions/v1/orientation-session` | `project_id`, `action:START|CLOSE` | session ID, expiry, signed display rotating/print tokens; authorized staff only |
| `POST /functions/v1/enrollment-bulk-approve` | `project_id`, `enrollment_ids:uuid[]` max 100 | per-enrollment result, performed by authorized staff, employer verification separate |
| `POST /functions/v1/device-activate` | authenticated worker + installation attestation available | revoke previous, register new and return upload credential AND 32-byte `badge_secret` over TLS once; server-scoped bindings; both stored by app in SecureStore (AFTER_FIRST_UNLOCK) |
| `POST /functions/v1/device-renew` | current device upload credential (works headless, no Supabase user session needed) OR authenticated worker session | rotate 30d device bearer, old token valid 24h (`rotated_from`); denied after revoke; client MUST call `BackgroundGeolocation.setConfig` with new header before next sync |
| `POST /functions/v1/report-confirm` | `report_id`, `version`, `action`, `reason?` | CONFIRMED/DISPUTED/CORRECTION_REQUESTED, foreman own company only |
| `POST /functions/v1/muster-start` | `project_id`, `incident_label` | new muster ID + immutable snapshot, safety role, idempotent action |
| `POST /functions/v1/muster-close` | `muster_id`, `closure_note` | immutable signed summary fields, safety role only |
| `POST /functions/v1/account-delete` | reauthenticated signed action + deletion confirmation | revoked tokens now, controlled deletion/hold status, max 30d identity removal |

Do not expose privileged APIs through a Vercel layer in V1. Row-level authorization, input validation, audit and rate limits apply uniformly to all endpoints.

## Supabase private Realtime Broadcast contract

**Channel:** `project:{project_uuid}` with `{config:{private:true}}`. Configure `realtime.messages` RLS: SELECT/receive allowed only to staff and explicitly permitted company members of that particular project. No plaintext data in public topics. Use DB trigger `realtime.send()` or `realtime.broadcast_changes()` for minimal invalidation message; **do not** use high-volume Postgres Changes for full worker rows.

```json
{
  "schema_version": 1,
  "type": "WORKFORCE_CHANGED",
  "project_id": "00000000-0000-4000-8000-000000000001",
  "aggregate_version": 148,
  "counts": {"estimated_onsite": 37, "presence_unknown": 2, "approved_roster": 74, "visitors_onsite": 3},
  "changed_ids": ["11111111-1111-4111-8111-111111111111"],
  "occurred_at": "2026-11-03T19:30:00Z"
}
```

Zod `BroadcastSchema`: `schema_version=1`; `type` enum `WORKFORCE_CHANGED|ENROLLMENT_CHANGED|REPORT_CHANGED|MUSTER_CHANGED|PROJECT_CONFIG_CHANGED`; `project_id:uuid`; `aggregate_version: nonnegative integer`; `counts` object with only nonnegative integer aggregates as shown; `changed_ids:uuid[]` max 100; `occurred_at:ISO UTC`. No worker names, contact info, individual coordinates, badge tokens, or personal info. React Query invalidates/refetches **authorized** rows after reconnect/notification; treat DB as source of truth. Membership revocation forces effective RLS denial and auth/channel reset; test immediate read access denial, do not assume an existing cached frame can be removed remotely.

## Request/response auditing

All APIs have `request_id`, bounded safe logs and correlation to audit actions. Never log bearer secrets, raw coordinates, SMS OTP or emergency contacts. The staging API uses synthetic data only. Client must never interpret HTTP success with per-item `rejected` as a successful worker check-in; show per-person reconciliation result.

**Reference SDK behavior:** https://docs.transistorsoft.com/react-native/HttpConfig/ ; `2xx` acknowledges/deletes the whole native HTTP batch, so durable terminal outcome for every record is mandatory.
