# Google Play background-location video — script (Milestone 13)

Google Play requires a short video for the **Location permissions** declaration (Play Console →
App content → Sensitive app permissions → Location). It must show, on a **real Android phone**
with the **release build** (Play internal testing), the in-app disclosure, the permission prompts
and the feature that needs background location. Status: `NOT_EXECUTED_PHYSICAL_DEVICE`.

Rules for the recording (decision #38, spec 09 "Native location permission review video must show
actual OS behavior on an appropriate physical device"):
- Record the phone's own screen (Android screen recorder), 30–90 seconds, no editing that changes
  what the app does. Captions may be added.
- Use the reviewer demo account A (synthetic data only; `docs/release/reviewer-demo.md`). No real
  worker, project or position may appear.
- Do not fake the arrival: use the demo's server simulation for the dashboard part, and say on
  screen that it is a simulation. The permission flow itself is real.
- English UI. Android 11 or newer (so the "Allow all the time" Settings step is shown).

## Shot list

| # | Seconds | Show | Caption |
|---|---|---|---|
| 1 | 0–5 | App icon → app opens on the worker Home | "SiteMuster: jobsite attendance for construction crews" |
| 2 | 5–15 | Profile → Location and consent → the site notice → **I have read and accept it** | "Workers accept a site notice for each jobsite they join" |
| 3 | 15–25 | Home → automatic attendance → **Allow location** → the disclosure card "Before you allow location" with its full text visible; pause 3 seconds | "Prominent disclosure before any permission request" |
| 4 | 25–30 | **Continue** → Android dialog → **While using the app** | "Foreground permission first" |
| 5 | 30–40 | The SiteMuster dialog "Allow location all the time?" → **Change to "Allow all the time"** → Android Settings → **Allow all the time** → back | "Background location, only with the user's explicit choice" |
| 6 | 40–48 | The status card: "Waiting for you to arrive at a site" | "Away from jobsites only arriving or leaving is noted, never a position" |
| 7 | 48–60 | Continue as site staff → Projects → Demo Tower → Demo: simulate arrivals and departures → **Simulate arrival** → Home count goes up | "Simulation for review only: a crew member arriving is counted on site (estimated)" |
| 8 | 60–70 | Map: the marker inside the site circle; Profile → Location and consent → switch location **off** | "Workers can switch location off per project at any time" |

## Narration / description text (paste into the declaration's description field)

SiteMuster estimates which workers are on a construction site so that superintendents no longer
phone each subcontractor for headcounts, and so the emergency muster roster is current.
Background location lets a worker's phone note arriving at and leaving the jobsites that worker
joined, even when the app is closed. Only the circular boundary of each joined jobsite is
monitored. Away from those jobsites the app records only "arrived" or "left", never the worker's
position, route or trail. On a jobsite an approximate position may be shown to that project's
staff. Workers see a disclosure before any permission request, accept a site notice per project,
can switch location off per project at any time, and can always sign in at the site kiosk or with
their foreman instead. The app uses a foreground-service notification while it tracks on site.

## Declaration answers (Play Console)

- **Does your app access location in the background?** Yes.
- **Core functionality**: automatic jobsite attendance (arrival and departure at the jobsites the
  worker joined) and emergency muster accuracy.
- **Why foreground-only is not enough**: workers do not keep the app open while working; arrivals
  and departures happen with the phone in a pocket.
- **Prominent disclosure**: in-app card "Before you allow location", shown before the system
  prompt every time (`app/tracking.tsx`, `tracking.disclosure.*` in both languages).
- **Foreground service type**: `location`, only while tracking on a site, with a visible
  notification.
