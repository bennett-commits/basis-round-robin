# Basis BDR Meetings Tracker

A shared page listing every BDR-booked meeting: who booked it, which Account
Director (AD) owns it, when the initial meeting is and how many days away,
whether the BDR sent the intro email, whether the AD sent their pre-meeting
follow-up email, and whether the meeting is booked, held or a no-show.

This app used to be the BDR → AE round robin. That was retired on
2026-10-13. Its old KV document (key `state`) is left in place untouched and is
read only once, so the intro emails it had already found carry over.

## How it's put together

- `public/` holds the frontend: `index.html`, `style.css` and `app.js`. No build step.
  `app.js` reads `GET /api/meetings`, then filters and sorts in the browser.
  The default sort is "Days until", with upcoming meetings soonest first and
  then past meetings most recent first.
- `src/worker.js` is a Cloudflare Worker that serves `/api/*` and falls back to `public/`.
- `src/lib/meetings.js` holds the KV read/write and merge rules.

## Data flow

The worker can't query Salesforce. A Claude scheduled task
(`round-robin-hourly-sf-sync`, every 6 hours) reads Salesforce and posts the
full meeting set:

```
POST /api/admin/meetings
x-sync-token: <SYNC_TOKEN>
{ "asOf": "<ISO>", "meetings": [ { "oppId", "oppName", "accountName",
  "bdrName", "aeName", "bookedAt", "meetingDate": "YYYY-MM-DD",
  "meetingAt": "<ISO or null>", "stage", "status": "booked|held|no_show",
  "bdrIntroEmail": {sentAt, subject, taskId} | null,
  "aeIntroEmail":  {sentAt, subject, taskId} | null } ] }
```

The posted set replaces the stored one, so meetings that leave the window drop
off. Emails are sticky per opp: once found, a later `null` never clears them.

## Deploying

Pushing to `main` deploys, because Cloudflare is wired to the GitHub repo.
`wrangler` isn't authenticated locally. For local dev, run `npx wrangler dev`
with `SYNC_TOKEN` set in `.dev.vars`.
