# App Review notes (paste into App Store Connect → App Review Information → Notes)

Paste the text between the lines. Fill the three items in angle brackets **only inside App Store
Connect** (never in this repository): they come from `docs/release/reviewer-demo.md`. The same text
works for Play Console → App content → App access.

---

SiteMuster is a construction-site attendance app used by general contractors, their
subcontractors and site workers. It estimates who is on a jobsite and supports safety musters.
It is not a payroll system and not a certified life-safety system; the app says so wherever it
matters.

HOW TO SIGN IN
- The app uses one-time codes, no passwords. On the first screen choose English, then "Sign in
  with phone", and enter the demo phone number from the user name field. Enter the code from the
  password field (it is fixed for this demo number; no SMS is sent).
- The app then asks for an authenticator code, because this demo account also holds staff roles
  (superintendent and safety manager), which always require two-step sign-in. Add this setup key to
  any authenticator app (Google Authenticator, Authy, 1Password, Apple Passwords) and enter the
  6-digit code it shows: <authenticator setup key>.
- After sign-in, choose "Continue as site staff" for the superintendent screens, or "Continue as
  worker" for the worker screens.

DEMO DATA AND SIMULATION
- The account belongs to "SiteMuster Demo (synthetic data)". Every person and the site are
  synthetic, and a DEMO banner says so on each screen. No real customer data is reachable from
  this account.
- You cannot be at our demo site in Austin, Texas, so the demo project has "Demo: simulate
  arrivals and departures" (Projects → Demo Tower → Workers and orientation). It moves a synthetic
  worker on or
  off the site through the same server logic a phone uses, including the 10-minute arrival rule.
  The Home dashboard, the Map and the Workforce roster update within seconds. This simulation
  exists only in the demo organization; the server refuses it everywhere else. It is not GPS.

WHY THE APP USES LOCATION "ALWAYS"
- Workers who join a jobsite can let their phone note automatically when they arrive at and leave
  that jobsite, even when the app is closed. This replaces daily phone calls to subcontractor
  foremen to estimate manpower, and keeps the emergency muster roster current.
- Background location is used only for the circular boundaries of the jobsites the worker has
  joined. Away from those sites the app records only "arrived" or "left", never a position, and
  sends no route or trail. On a site, an approximate position may be shown to that project's staff.
- Before the system prompt the app shows its own disclosure explaining this. The worker can switch
  location off for any project at any time (Profile → Location and consent) and use the site
  kiosk or their foreman instead; nothing else in the app depends on location.
- The blue location indicator is shown while location is in use (showsBackgroundLocationIndicator).
- To try it: continue as worker → Profile → Location and consent → read and accept the site
  notice → allow location. Away from Austin you will see "Waiting for you to arrive at a site": correct, because
  nothing is collected off site.

PUSH NOTIFICATIONS
- Used only for emergency musters ("Emergency muster — tap I'M SAFE"), started by the project's
  safety manager. To see one: Projects → Demo Tower → Emergency muster → write "Drill" → Start →
  confirm. "I'M SAFE" is never treated as a physical headcount; the app labels it "Said safe (not
  checked)".

CAMERA
- Used only to scan orientation and badge QR codes (kiosk mode).

ACCOUNT DELETION
- Profile → Delete my account (workers) or More → Delete my account (staff). Please test
  deletion with the second demo account, so the main demo account stays available: phone
  <deletion test phone number>, code <deletion test code>. Deletion signs the phone out at once;
  the identity is removed by the next day.

CONTACT
- <owner contact name, phone and e-mail for App Review>

---

## Before pasting, check

- [ ] The worker notice, muster limitations and deletion notice are approved in English and
      Spanish in production (otherwise sign-in works but consent and muster are refused).
- [ ] The demo is seeded in production and the store-review path in
      `docs/release/phone-test-checklist.md` §4 passed on the exact build you submit.
- [ ] "Sign-in required" is ticked and the user name / password fields hold reviewer A's number
      and fixed code.
