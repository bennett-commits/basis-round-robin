# Basis AE Round Robin

A shared, live tool for BDRs to weight-randomly assign inbound deals to AEs.
Everyone who opens the page sees the same roster, weights, and assignment log
in real time (polled every ~4s) — this replaced an earlier version that only
worked in one browser at a time.

## How it's put together

- `public/index.html` / `public/style.css` / `public/app.js` — the frontend.
  No build step, no framework. `app.js` polls `/api/state` and talks to the
  other endpoints below instead of `localStorage`.
- `src/worker.js` — a single [Cloudflare
  Worker](https://developers.cloudflare.com/workers/) that handles every
  `/api/*` route, and falls back to serving the files in `public/` (via the
  `ASSETS` binding) for everything else.
- `src/lib/state.js` — shared server-side logic (the fairness/weighting math,
  KV read/write helpers, auth checks) imported by `worker.js`.
- Storage is a single JSON document in **Cloudflare KV** (a free key-value
  store bound to the Worker as `RR_KV`). Good enough for a small team's
  request volume; not built for high write concurrency.

### Why a Worker with static assets, not "Pages"

Cloudflare has been folding Pages into this model — when you connect a repo
today, its dashboard creates a Worker, not a classic Pages project. Fighting
that (trying to force a Pages-style deploy command) is more fragile than just
building to what the platform actually creates: one Worker serving both the
static frontend and the `/api/*` backend, with KV for storage.

## Weighting cycles (30 days)

The deficit queue converges on target weights using each AE's accumulated
`bookedRR`. Left unbounded those counters carry all-time history, so a weight
change, a rep going inactive, or a roster change stays "priced in" long after
it stopped being true — the queue keeps paying back an old imbalance instead
of tracking today's weights.

So the per-AE counters (`bookedRR` / `heldRR`) reset to zero every 30 days:

- The cycle start is stored as `cycleStartedAt`. On every read, `maybeRollCycle`
  advances it by whole 30-day periods and zeroes the counters if a boundary has
  passed — no cron trigger needed. It is a pure function of
  (`cycleStartedAt`, now), so it is idempotent and only persists on the next write.
- **Nothing else resets.** Configured `weight`, the roster, the assignment log,
  and each entry's held/lost/opp linkage all survive. Only the counters clear.
- Log entries from earlier cycles no longer move the counters: deleting a
  pre-reset entry won't claw back from the new cycle, and a late Salesforce sync
  on a pre-reset booking marks the entry held without crediting `heldRR`
  (which would otherwise push held above booked and distort hold rate).
- To reset early, `POST /api/admin/reset-cycle` with either the admin password
  (`x-admin-password`) or the sync token (`x-sync-token`). It returns the
  pre-reset counters so a reset can be audited or undone.

The admin tab shows the current cycle window and the days remaining.

## Manual admin overrides

Two escape hatches for when reality diverges from the rotation. Both live in
the admin tab and both require the admin password.

### Force the next assignment

Per pool, an admin can pick who takes the **next** booking, bypassing the
deficit queue (`POST /api/admin/next-override` with `{pool, aeId}`; send a null
`aeId` to clear).

- It is **one-shot**. The next booking in that pool consumes it and the normal
  rotation resumes — there is no sticky "always pick this person" mode.
- The forced booking still increments `bookedRR`, so the deficit queue hands
  that AE correspondingly less over the following spins. An override changes
  the *order* of assignments, never anyone's target share over the cycle.
- The stored id is re-validated on every read, so an AE who is deactivated,
  moved to the other pool, or removed while queued up simply voids the
  override rather than wedging the rotation. Removing an AE clears it outright.
- It is visible to everyone, not just the admin who set it: the spin reel
  reads "Next up · set by admin", and the resulting log entry carries a
  `Manual` pill.

### Retroactively reassign a deal

The AE column in the admin assignment log (and in Flagged for review) is a
dropdown — changing it moves that deal to another AE
(`POST /api/log/reassign` with `{id, aeId}`).

- The counters follow the deal: the old owner is debited `bookedRR` (and
  `heldRR` if it had already held), the new owner credited. As with deletes,
  this only applies when the entry is inside the current weighting cycle, so
  reassigning an older booking moves the record without distorting counters
  the present cycle never included.
- Reassigning **across pools** is allowed — the options are grouped by pool so
  it is a deliberate choice — and the entry's `pool` follows its new owner, so
  a moved deal doesn't sit in the wrong rotation's log or hold rate.
- The entry keeps `reassignedFrom` / `reassignedAt`, surfaced in the log as
  "↳ reassigned from <name>" so the original attribution isn't silently lost.
- An entry whose original AE has since been removed from the roster shows a
  "(no longer on roster)" placeholder rather than defaulting to whoever sits
  first in the list.

## Intro activity columns

Recent assignments shows three extra columns per deal, filled in by the
Salesforce sync once the entry is linked to an opp:

- **Intro meeting**: the first meeting date on the opp (bold while upcoming).
- **BDR intro email**: the BDR's email introducing the contact to the AE.
- **AE intro email**: the AE's pre-meeting email with discovery questions
  (ERP, AI readiness, ...).

The worker can't query Salesforce itself, so `GET /api/admin/pending` returns
`trackedOpps`, meaning linked entries (last 45 days, not flagged) whose meeting
is still in the future or that are missing either email. The sync job re-reads
those every run and posts them back as `activity` on `/api/admin/sync`.
Found emails are sticky: a later run that doesn't see one won't clear it. The
meeting date overwrites, so reschedules show up. A cell reads "…" until the
first check, then "Not yet" / "Not set" if nothing was found.

## One-time setup

### 1. Push this to GitHub

Already done if you're reading this from the repo — `git log` shows the
commits. If starting fresh elsewhere: create an **empty** repo on github.com
(no README/.gitignore/license, this folder already has those), then:

```bash
git remote add origin <the repo URL github gives you>
git branch -M main
git push -u origin main
```

### 2. Connect the repo in Cloudflare

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) if you don't
   already have an account.
2. **Compute (Workers) → Workers & Pages → Create → Connect to Git**, pick
   this repo.
3. Cloudflare detects `wrangler.toml` and `main = "src/worker.js"`
   automatically — the deploy command it runs (`npx wrangler deploy`) is
   correct as-is now that the project is actually shaped like a Worker.
4. Deploy. Cloudflare gives you a URL like
   `https://basis-round-robin.<your-subdomain>.workers.dev` — that's the
   live, shareable link.

### 3. Create the KV namespace and bind it

On this Worker's page in the dashboard:

1. **Settings → Bindings → Add → KV Namespace**.
2. Variable name: `RR_KV`. Create a new namespace (e.g. also named
   `RR_KV`) and select it.
3. Redeploy (Deployments → retry latest, or push any commit) so the binding
   takes effect.

### 4. Set the two secrets

**Settings → Variables and Secrets → Add** (choose type **Secret**, not
plain text, for both):

| Name | Used for |
|---|---|
| `ADMIN_PASSWORD` | The human admin password (Admin button on the page). Set it to whatever you want. |
| `SYNC_TOKEN` | A long random string (e.g. `openssl rand -hex 32`). Used only by the hourly Salesforce sync job below — never shown in the browser. |

Redeploy once more after setting these so the Worker picks them up.

### 5. Wire up the hourly Salesforce sync

This reuses the same mechanism as the existing `hourly-call-dashboard-refresh`
scheduled task — a local Claude Code scheduled task with your already
-authenticated Salesforce (Satellite) access, run hourly, that:

1. `GET https://<your-worker-url>/api/admin/pending` with header
   `x-sync-token: <SYNC_TOKEN>` → returns `{ aeNames, pendingAccountNames }`.
2. For each AE name, counts Opportunities they own that reached the
   `Discovery` stage in the trailing 30 days (same SOQL pattern used before:
   `Timestamp_Discovery__c >= LAST_N_DAYS:30`).
3. For each pending account name, looks up the matching Opportunity (owner,
   Id, Name, StageName).
4. `POST https://<your-worker-url>/api/admin/sync` with header
   `x-sync-token: <SYNC_TOKEN>` and body:
   ```json
   {
     "asOf": "2026-08-12T18:00:00Z",
     "heldAllSources30d": { "Dhruv Madappa": 21, "Nick Ardakani": 19 },
     "matches": [
       { "accountName": "Acme Corp", "oppId": "006...", "oppName": "Acme Corp - New Business", "stage": "Discovery" }
     ]
   }
   ```

Once the site is deployed and you have its URL and `SYNC_TOKEN`, tell Claude
and it will create the scheduled task (mirroring
`hourly-call-dashboard-refresh`'s `SKILL.md`) so this runs automatically every
hour without you doing anything further.

## Local development (optional)

```bash
npm install
npm run dev
```

Opens the site locally with the Worker and KV emulated (uses `wrangler`,
installed as a dev dependency).

## What's intentionally simple here

- **No login for BDRs** — anyone with the link can spin and edit account
  names on the Spin tab. Only the roster/weights/delete actions are
  password-gated.
- **KV, not a "real" database** — fine for this team's size; if this grows
  well past a handful of BDRs spinning concurrently, move to D1 (Cloudflare's
  SQLite) for real transactional writes.
- **Polling, not WebSockets** — a 4-second poll is plenty responsive for a
  spin-and-see tool and avoids the complexity of realtime connections.
