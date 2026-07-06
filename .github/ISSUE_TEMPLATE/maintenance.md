---
name: "🛠 Scheduled maintenance"
about: "Announce a planned maintenance window (shows a banner on the status page)"
title: "🛠 Scheduled maintenance"
labels: maintenance
---

<!-- start: 2026-06-27T22:00:00+02:00 end: 2026-06-27T23:00:00+02:00 expectedDegraded: api -->

Describe the maintenance here. Edit the HTML comment above before submitting:

- `start` / `end` — ISO datetimes of the window (**required**)
- `expectedDegraded` / `expectedDown` — comma-separated service slugs (optional; suppresses auto-incidents during the window)

Close this issue to clear the banner.
