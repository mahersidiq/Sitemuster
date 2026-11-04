# Release-candidate phone test checklist (Milestone 13)

**Status of every item below: `NOT_EXECUTED_PHYSICAL_DEVICE`** until the owner (or a tester the
owner names) runs it on a real phone and fills in the result. Simulators, web renders and the
replay harness never count as a pass here (spec 10).

Use this list for every build you intend to submit to the stores, and repeat the location items
for every new app version (the privacy sign-off is per version, decision #90). The per-milestone
device sections in `docs/setup/HUMAN_CHECKLIST.md` (kiosk, dashboard, reports, muster, privacy,
location privacy sign-off) are part of this checklist; run them too.

## 0. Before you start

- [ ] A **preview** (staging) build of the exact commit you will release, installed from EAS on:
  at least one iPhone (current iOS) and two Android phones, one of them a Samsung or Xiaomi
  (OEM battery management) — HUMAN_CHECKLIST §2.
- [ ] Staging has the current migrations and functions (`deploy-backend` workflow, target staging).
- [ ] A test project on staging whose circle covers a place you can walk to, with one company, its
  foreman, a kiosk attendant and two test workers (one per platform).
- [ ] For the network items: the intercepting proxy from HUMAN_CHECKLIST §10 on the test phones
  only, and the capture checker ready:
  `npm run privacy:capture-check -- <capture.har> --site <lat>,<lng>,<radius_m>`.

Write each result in the table at the end: date, phone model and OS version, app version, PASS or
FAIL, and what you saw.

## 1. Smoke test of the release candidate (both platforms, English and Spanish)

1. Install fresh → the language screen asks English or Spanish (it does not silently follow the
   phone).
2. Worker sign-in by SMS code: wrong code refused; resend waits 60 s; the right code signs in.
3. Staff sign-in by e-mail code, then the authenticator (enrol on first sign-in).
4. Worker: the site notice is shown; location disclosure screen appears **before** the system
   location prompt ("SiteMuster collects location data … even when the app is closed or not in
   use"); "Not now" asks nothing.
5. Badge: the 30-second code changes; it works with the phone in airplane mode.
6. Kiosk scan of that badge; printed badge with face/name check; visitor in/out.
7. Superintendent: Home counts, Workforce, Map (Apple Maps / Google Maps), "Stale, not live"
   markers.
8. Foreman: crew sign-in/out, daily report answer.
9. Muster drill: alert on both phones, I'M SAFE from the lock screen, "Seen at the assembly point",
   close with the acknowledgement, text summary.
10. Profile → Location and consent: off/on per project. Profile → Delete my account (use a
    throw-away account).
11. Switch to Spanish and repeat 4, 7 and 9 quickly: no English left on those screens, no cut-off
    safety buttons.
12. Sentry: trigger the test crash from a development build (HUMAN_CHECKLIST §6) and confirm the
    event has no coordinates, phone numbers, codes or tokens.

## 2. Device validation matrix (docs/spec/03 "Device validation matrix")

Run each on the iPhone and on an Android phone. "Expected" is what must happen; anything else is
a FAIL.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| M1 | foreground | Walk onto the site with the app open | ENTER, then "Arriving: confirming…", counted after about 10 minutes |
| M2 | background | Same with the app in the background | Same, without opening the app |
| M3 | app force-close | Swipe the app away, then arrive | iPhone: arrival noticed after iOS relaunches the app (may be late); Android: noticed. Never a promise after Android "Force stop" (see N5) |
| M4 | reboot | Restart the phone off site, unlock it once, walk in | Arrival noticed after the first unlock |
| M5 | first unlock | Restart, do NOT unlock, wait near the site | Nothing is sent before the first unlock; no error shown as success (see N12) |
| M6 | missed region | Arrive while the phone is off, turn it on inside | The already-inside check notices you (arrival time = the first fix after turning on, never earlier) |
| M7 | already inside | Get approved while standing on site | Counted after 10 minutes from the first fix, never back-dated |
| M8 | permission changed | Change Always → While using in Settings | "Needs location permission"; kiosk/foreman still work; no invented exit |
| M9 | reduced/approximate | Turn Precise / precise location off | Automatic attendance blocked, shown as monitoring unavailable |
| M10 | adjacent projects | Two test projects next to each other | Never counted on both; ambiguous status asks for a choice |
| M11 | poor GPS | Stand where accuracy is worse than 75 m | Not counted from those fixes |
| M12 | airplane mode | Arrive in airplane mode, reconnect later | Records wait on the phone and arrive once, no duplicates |
| M13 | vehicle pass-through | Drive through the site without stopping | Not counted (no 10-minute dwell) |
| M14 | battery savings | Battery saver / Low Power Mode on for a shift | Status stays honest; note battery % per shift |
| M15 | overnight idle | Leave the phone on site overnight (24/7 test project) | Unknown after 20 minutes of silence, review after 16 h; never "left" from silence |
| M16 | false boundary bounce | Walk along the fence line for 10 minutes | No flapping arrivals/departures (50 m exit margin) |
| M17 | SMS logout/re-login | Sign out on site, sign back in | Tracking stops at sign-out, the visit becomes unresolved, nothing is sent while signed out |
| M18 | replacement device | Activate a second phone for the same worker | The first phone is refused at once; the open visit is flagged for review |

## 3. Native-only scenarios from docs/spec/07 (each needs a real phone)

| # | Scenario (spec 07) | What to do | Expected |
|---|---|---|---|
| N1 | Worker denies background location | Deny location at the prompt | Account and orientation work; the app offers kiosk/foreman/manual; never counted as present by GPS |
| N2 | Worker grants foreground-only location | Choose "While using the app" only | The app explains the Always upgrade and does not claim background monitoring |
| N3 | Worker switches iOS Precise OFF or Android approximate | Turn precise location off | Automatic attendance blocked; "monitoring unavailable"; kiosk/foreman still work |
| N4 | Worker closes/terminates iOS app | Force-quit on iPhone, then walk in and out | Behaviour noted honestly (iOS may relaunch for geofences); no guaranteed restart claimed |
| N5 | Android force-stop | Settings → Force stop, then walk in | Nothing until the app is opened again; status becomes unknown; kiosk/foreman available |
| N6 | Android OEM battery killer | On the Samsung/Xiaomi phone, leave default battery settings for a day | Stale signal shown as unknown; follow the OEM instructions shown in the app; note what was lost |
| N7 | Worker reboots phone | Reboot on site | Android resumes after unlock; iPhone after iOS wakes the app; already-inside re-checked |
| N8 | Worker leaves phone in vehicle | Leave the phone in a car parked inside the circle | Counted as an estimate only; the pilot's manual headcount shows the difference |
| N9 | Permission revoked in phone settings | Revoke location while on site | No more positions sent; status unknown; no invented exit |
| N10 | App updated during shift | Install a newer build over the old one while on site | Queued records and the open visit survive the update |
| N11 | Background task runs while iPhone locked | Lock the iPhone on site for 30 minutes | Uploads continue while locked (after first unlock) |
| N12 | iPhone restarted but not first unlocked | Restart and leave locked | No upload claimed before first unlock; resumes after unlock |
| N13 | Native SDK uploads offsite EXIT coordinate | Proxy capture of a full walk out | The EXIT record carries no position; capture checker PASS |
| N14 | Continuous onsite tracking still sends fix after exit | Proxy capture across the exit and 30 minutes after, app open and closed | No position recorded after the EXIT is sent; capture checker PASS |
| N15 | 100 workers arrive at 6:30 AM | 60-minute enrollment rehearsal with several attendants (or as many testers as you can gather) | ≥ 200 sign-ins an hour possible; SMS failures fall back to kiosk/supervised onboarding; bulk approval ≤ 100 at a time |
| N16 | Native device tests unperformed | Before submitting, check this table | Every row above has a dated PASS; any FAIL or blank blocks the store release |

## 4. Store-review path (the exact path App Review will follow)

- [ ] On the **production** build (TestFlight / Play internal testing), sign in with the reviewer
  demo account A from `docs/release/reviewer-demo.md`. The DEMO banner shows on every demo screen.
- [ ] Project → **Demo: simulate arrivals and departures** → simulate an arrival: Home shows one
  more on site within seconds; Map shows the marker inside the demo site.
- [ ] As a worker (same account → Continue as worker): accept the notice under Profile → Location
  and consent; the location disclosure appears before the system prompt.
- [ ] Account B: Profile → Delete my account works; account A is untouched.

## 5. Results

| Item | Date | Phone, OS | App version | Result | Notes / capture file kept at |
|---|---|---|---|---|---|
| (fill in one row per item and platform) | | | | NOT_EXECUTED_PHYSICAL_DEVICE | |
