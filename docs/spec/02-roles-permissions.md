# 02 — Roles and exact permission matrix

## Identity principles

`auth.users` authenticates a person; `worker_profiles` describes an individual; `organization_members` / `project_staff` give access; `worker_enrollments` authorize site participation; `subcontractor_members` represent employer identity. These are separate. Users may have several concurrent roles and GC affiliations. A QR code never confers a role. The authenticated request context determines tenant, not a client-provided UUID.

## Permissions

Legend: **O** organization owner/admin (admin has delegated restrictions); **P** PM; **S** superintendent; **H** safety manager; **F** verified subcontractor foreman; **W** individual worker; **A** platform operator. A denied column means the backend rejects the operation, even if a hidden UI path invokes it.

| Operation | O | P | S | H | F | W | A |
|---|---|---|---|---|---|---|---|
| Create GC organization | Owner-account only | No | No | No | No | No | No |
| Invite organization admins | Yes | No | No | No | No | No | No |
| Create/configure project | Yes | Delegated | Assigned project | No | No | No | No |
| Assign/remove project staff | Yes | Assigned+delegated | No | No | No | No | No |
| Create orientation session | Yes | Assigned | Assigned | Assigned | No | No | No |
| Review project enrollments | Yes | Assigned | Assigned | Assigned | Own workers: propose only | Own: view | No |
| Bulk project approve <=100 | Yes | Assigned | Assigned | Assigned | No | No | No |
| Confirm company affiliation | Yes | Assigned | Assigned | Assigned | Own company authorized representative | No | No |
| Read all approved project worker roster | Assigned/owner | Assigned | Assigned | Assigned | Own employees only | Self only | No |
| Read exact/latest onsite location | Assigned/owner authorized | Assigned | Assigned | Assigned | Own employees only if GC explicitly grants | Own only | Never |
| Read emergency contacts | Assigned when designated emergency role | No by default | Assigned when emergency role | Assigned | Own crew if emergency-role delegated | Own only | Never |
| Kiosk sign-in/out | Assigned kiosk attendant | Assigned kiosk attendant | Assigned kiosk attendant | Assigned kiosk attendant | Own crew if kiosk role delegated | No | No |
| Foreman crew sign-in/out | No unless also assigned | No | No | No | Own approved roster | No | No |
| Manual attendance/correction approval | Owner with assigned project | Assigned | Assigned | Assigned if delegated | Submit request own company | Submit own request | No |
| Company report confirm/dispute | No (see result) | No | No | No | Own company only | No | No |
| Trigger/close muster | Assigned designated safety role | No by default | Assigned designated role | Assigned | No | No | No |
| Mark physical muster accounted | Assigned designated role | No | Assigned designated role | Assigned | Own crew physically checked | No | No |
| Respond I’M SAFE | Self if participating | Self | Self | Self | Self | Self | No |
| Delete own account | Yes | Yes | Yes | Yes | Yes | Yes | No |
| Platform org lookup, revoke device, resend invite | No | No | No | No | No | No | Scoped only |

Authorization is implemented in SQL RLS plus privileged transactions for complex writes. Privileged functions must derive `auth.uid()`, check actual memberships and assigned project and company, not believe a `role` input. Don't grant all org admins emergency contacts by default: designate those responsible for emergency response.

## MFA, special identities and device modes

- Staff O/P/S/H and platform A: verified email + mandatory TOTP MFA before privileged actions. A worker who also has staff role follows stronger staff auth for staff operations.
- Worker W: verified Supabase/Twilio SMS six-digit OTP; email optional. Every auth challenge is throttled; SMS abuse budgets and throughput tested.
- No-phone: supervised `worker_profiles` created with `managed_identity=true`, without a fabricated auth user or phone. Attendance authorized through separately verified kiosk/foreman actor; claiming the managed record requires verified linking and GC or employer confirmation. Prevent duplicate worker identities.
- Kiosk attendant is authenticated staff/sub foreman, bound to one specific project. Kiosk device has unique device registration and cannot browse another GC's roster. PIN/biometric reauthentication on resuming a shared kiosk screen is an additional control, not a replacement for staff login.
- `platform_admin` may use an audited CLI/service but has no read permission for coordinates/emergency contact/personally identifying attendance. Sensitive operator operations require MFA and reason codes.

## Access revocation contract

Revoke membership/enrollment or device -> invalidate server credentials immediately, stop accepting new events, revoke Realtime subscriptions/effective read via RLS, remove cached protected screen data on next client sync, and flag active attendance for reconciliation. History remains under documented retention rules. A queued event from a revoked device is rejected, not accepted based solely on its old timestamp; preserve rejection reason and audit for reconciliation.

## Security tests required

- GC A owner cannot read/edit GC B records by guessed IDs, Realtime topic or Storage URL.
- Foreman A cannot view foreman B trade roster, visitor contacts, coordinates or make attendance corrections to their workers.
- Worker cannot promote themselves, approve own enrollment, approve company affiliation or edit authoritative attendance.
- Member whose access is revoked cannot retain realtime access, mutate through Edge Functions or use kiosk credentials.
- Platform admin cannot query any precise locations or emergency contact fields (including via RPC, logs, views and exports).
- Valid location credential of project A cannot create/read/acknowledge events for project B even if request body carries B's ID.
