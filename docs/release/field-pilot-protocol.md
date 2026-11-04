# 30-workday field pilot protocol (Milestone 13)

**Status: `FIELD_PILOT_PENDING`.** The pilot has not been run. Until the owner signs the pilot
sign-off (`docs/release/pilot/pilot-sign-off.md`), SiteMuster must not be described as ready for
public release, and no result below may be claimed (spec 10 "Pilot acceptance"; decision #150).

The pilot answers one question honestly: on a real jobsite, with real crews and phones, how well
do the estimates match a manual reference headcount, and what does it cost the site team? It is an
**adoption and accuracy study, not a safety certification**: GPS-estimated presence is always
reported separately from physical counts.

## 1. Set-up (before day 1)

- **Site**: at least one active project; **at least two subcontractors**; a realistic crew size
  (the planning figure is up to 150 workers across 3 projects, decision #20).
- **Phones**: a mixed fleet — iPhones and Android phones, including at least one Samsung or Xiaomi
  (OEM battery management). Record model and OS version per worker in the device register
  (`pilot/device-register-template.csv`), with no phone numbers or names in the file: use the
  pilot worker code.
- **Build**: the production build from the release workflow (TestFlight / Play testing track), on
  the production backend with approved legal notices. If the real-device privacy sign-off
  (HUMAN_CHECKLIST §12) is not recorded for that build, phones run in TRACKING_LIMITED: that is
  correct and is part of what the pilot measures.
- **People and consent**: every participant goes through the normal orientation and accepts the
  approved site notice; nobody is pressured to allow location (spec 01 "Worker denies tracking").
  Workers without a phone use the kiosk or their foreman.
- **Reference headcount**: name one person per day (not the superintendent being measured) who
  counts who is physically on site at fixed times (start of shift + 60 min, midday, end of shift
  − 30 min) by walking the site or at the gate, without looking at the app.
- **Staff**: kiosk attendants assigned; the safety manager holds the emergency role; one muster
  drill is planned in week 2 and one in week 5 (HUMAN_CHECKLIST "Real-device muster drill").

## 2. Every pilot day (30 workdays)

Fill in one row of `pilot/daily-log-template.csv` per day (the site lead, at day close):

1. The reference counts at the three fixed times, and the app's numbers at the same minutes, split
   into **estimated by GPS**, **kiosk**, **foreman**, **manual**, **uncertain/unknown** and
   **visitors**. Never merge GPS into the physical count.
2. False entries (counted by GPS but not physically there) and false exits (shown as left while
   still there), by platform.
3. Missing events: people physically present but neither counted nor uncertain.
4. Detected-event latency: for three workers per day, the minutes between actually arriving at the
   gate and the app counting them (the 10-minute dwell is expected; anything beyond 20 minutes is
   noted).
5. Battery: % used during the shift on three named test phones (one iPhone, two Android).
6. SMS: codes requested vs. codes that arrived (the site lead asks new workers); fallbacks used.
7. Kiosk: offline periods and whether every queued scan synced afterwards.
8. Reports: daily company reports confirmed, disputed, corrected, NOT_CONFIRMED by the deadline.
9. Day-close time: minutes the superintendent spent on close-out and corrections.
10. Incidents: any privacy concern, wrong headcount reported to a person, crash, or support call.

## 3. Every pilot week

Use `pilot/weekly-review-template.md`: the site lead, the superintendent and the owner review the
week's log, list fixes, and decide whether to continue. Stop the pilot immediately (and fix
before continuing) on any of:
- a severity-0 event (docs/spec/07 "Failure handling escalation"): an off-site position seen by
  anyone, a person's data visible to another company or project, a self-report treated as a
  physical muster verification;
- a severity-1 event: lost or duplicated attendance that cannot be reconciled, a cross-tenant
  leak;
- a worker reporting pressure to keep location on.

## 4. Metrics reported at the end (spec 10 and spec 01)

Per platform and phone model, separately for GPS-estimated and physical sources:
- false positive (false entry) and false negative (missed arrival, false exit) rates against the
  reference counts;
- detected-event latency (median and 90th percentile);
- missing events per 100 worker-days;
- battery % per shift;
- user adoption by mode: GPS, kiosk (dynamic badge / printed badge), foreman, manual — target
  ≥ 80 % of workers recorded through **any** supported method (an adoption target, not a GPS
  accuracy claim);
- SMS delivery success rate and fallback use;
- kiosk offline recovery (queued scans synced / total);
- report confirmation rate and disputes;
- day-close time per day;
- correction burden (manual corrections per 100 worker-days);
- muster drills: time to account for everyone, counts by verification type, alerts that failed.

## 5. Exit criteria

The pilot can be signed only when all hold:
- 30 workdays logged with reference counts (missing days are named, not skipped silently);
- at least two subcontractors and both platforms took part;
- no open severity-0 or severity-1 item;
- the metrics in §4 are written up in the pilot report with the raw daily logs kept (without
  names or phone numbers);
- the owner signs `pilot/pilot-sign-off.md`.

Results never become claims of certification, verified payroll or guaranteed real-time presence
(spec 10). Before inviting more than 10 pilot GCs, collect at least three written expressions of
willingness to pay at a named future per-project price (decision #42); there is no billing in V1.
