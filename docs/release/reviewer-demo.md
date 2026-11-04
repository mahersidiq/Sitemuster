# Reviewer demo — set-up, use and retirement (Milestone 13)

Apple App Review and Google Play review cannot walk onto a construction site, and must never see a
real customer. The reviewer demo gives them a **synthetic** organization, `SITEMUSTER_DEMO`, on the
**production** backend (the store builds talk to production), with simulated arrivals and
departures. Decisions #140–#143.

## What it is and what it is not

- One organization on a private server-side allowlist (`app_private.demo_organizations`). Only the
  database owner can add it, from the SQL editor. No app screen and no API can.
- One 24/7 site, "Demo Tower (synthetic site)", in downtown Austin, TX, with two companies and
  eight sample people ("Demo Worker A" to "Demo Worker H"). The sample people have no account, no
  phone number and no e-mail; each has a phone record that never receives an upload key.
- **Simulate arrival / departure** (project → Demo: simulate arrivals and departures) sends the
  records a phone would send, built by the server, through the production attendance pipeline, so
  the dashboard, map, roster, muster and reports behave exactly as on a real site. Every simulation
  is checked by the server: demo project, MFA staff, sample person only. It is rate-limited and
  audited.
- Every screen of the demo shows: "DEMO: the people here are synthetic and their locations are
  simulated. This is not real GPS and not a real site." It never claims native GPS was validated.
- It cannot reach a real project, a real person or the reviewer's own phone: the server refuses
  (pgTAP `032_reviewer_demo`, the penetration sweep `031` with the reviewer account as an attacker,
  and `tests/backend/demo.test.ts`).

## Set-up (owner, production project, once)

Prerequisites:
- the Milestone 13 migrations and the `demo-simulate` function are deployed (`deploy-backend`
  workflow, target production);
- the worker location notice is **approved in English and Spanish** (HUMAN_CHECKLIST §9). The seed
  refuses before that (`CONSENT_NOTICE_NOT_APPROVED`), like every real consent in production.

1. **Choose two phone numbers that belong to nobody**, in the fictional range 555-0100 to
   555-0199 (for example +1 512 555 01xx). Never use a real person's number.
2. Supabase dashboard (production) → **Authentication → Providers → Phone → Test phone numbers and
   OTPs**: add both numbers, each with its own random 6-digit code. These numbers never receive an
   SMS; only that code signs them in. Treat the codes as secrets.
3. **Authentication → Users → Add user**, three times:
   - the **demo owner**: an e-mail address on a mailbox you control (it owns the demo organization
     and is never given to a reviewer);
   - **reviewer A**: the first test number, plus an e-mail address on a mailbox you control
     (marked confirmed), so the account can hold the staff roles;
   - **reviewer B**: the second test number only (it exists to test account deletion).
4. SQL editor (production), with the three user ids from the Users list:

   ```sql
   select app_private.seed_reviewer_demo('<demo owner id>', '<reviewer A id>', '<reviewer B id>');
   ```

   It returns the new organization and project ids. It refuses a reviewer account that already
   belongs to anything else, a platform operator account, a second active demo, and unapproved
   notices.
5. On a phone with the **production** build (TestFlight or Play internal testing), sign in as
   reviewer A with the first test number and its code. The app asks to set up an authenticator:
   scan the QR code with your own authenticator app **and copy the setup key** (it goes into the
   store forms below, never into this repository).
6. Check the store-review path in `docs/release/phone-test-checklist.md` §4.

## What the stores receive (entered only in App Store Connect and Play Console)

- **App Store Connect → App Review Information**: sign-in required; user name = reviewer A's
  phone number; password = its fixed code; the notes from `docs/release/apple-review-notes.md`,
  with the authenticator setup key and reviewer B's number and code pasted where the notes say.
- **Play Console → App content → App access**: "All or some functionality is restricted", with the
  same instructions.

Never paste these values into a pull request, an issue, a document in this repository, a
screenshot or a chat.

## Keeping it working

- Every app update is reviewed again: keep the demo seeded and the test numbers configured.
- If App Review deletes account B (that is what it is for), it is processed the next day. To give
  reviewers a fresh account B: create a new user with the same test number after the deletion is
  processed and enrol it with SQL as a worker (or retire and re-seed the whole demo).
- The demo's sample people go "unknown" 20 minutes after a simulated arrival if no departure is
  simulated, exactly like a real phone that went quiet.
- Reports for a day appear once that day has ended (the next day).

## Retiring it

```sql
select app_private.retire_reviewer_demo('<demo organization id>');
```

Simulation stops at once and the demo project is archived. Then delete reviewer A and B in the app
(Profile → Delete my account) or in the dashboard, and remove the two test numbers from the Phone
provider. Retiring never touches a real organization.
