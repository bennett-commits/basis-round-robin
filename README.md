# Basis AE Round Robin

A shared, live tool for BDRs to weight-randomly assign inbound deals to AEs.
Everyone who opens the page sees the same roster, weights, and assignment log
in real time (polled every ~4s) — this replaced an earlier version that only
worked in one browser at a time.

## How it's put together

- `index.html` / `style.css` / `app.js` — the frontend. No build step, no
  framework. `app.js` polls `/api/state` and talks to the other endpoints
  below instead of `localStorage`.
- `functions/api/*` — [Cloudflare Pages
  Functions](https://developers.cloudflare.com/pages/functions/): small
  serverless handlers, one per route, deployed automatically alongside the
  static files.
- `functions/_lib/state.js` — shared server-side logic (the fairness/weighting
  math, KV read/write helpers, auth checks).
- Storage is a single JSON document in **Cloudflare KV** (a free
  key-value store bound to the Pages project as `RR_KV`). Good enough for a
  small team's request volume; not built for high write concurrency.

### Why Cloudflare Pages specifically

It's the option that lets a plain GitHub repo become a live site with a real
backend and free shared storage, with no server to patch or pay for at this
scale: push to GitHub, Cloudflare auto-deploys, `RR_KV` gives every visitor
the same data.

## One-time setup

### 1. Push this to GitHub

```bash
cd /Users/bennettmayrock/basis-round-robin
git init
git add .
git commit -m "Initial commit: Basis AE round robin"
```

Then create an empty repo on github.com (no README/gitignore, this already
has them), and:

```bash
git remote add origin <the repo URL github gives you>
git branch -M main
git push -u origin main
```

### 2. Create a free Cloudflare account and connect the repo

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) if you don't
   already have an account.
2. **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
3. Build settings: framework preset **None**, build command **empty**,
   output directory **`/`** (repo root). There's nothing to compile.
4. Deploy. Cloudflare gives you a URL like
   `https://basis-round-robin.pages.dev` — that's the live, shareable link.

### 3. Create the KV namespace and bind it

In the same Pages project:

1. **Settings → Functions → KV namespace bindings → Add binding**.
2. Variable name: `RR_KV`. Create a new namespace (e.g. also named
   `RR_KV`) and select it.
3. Redeploy (Cloudflare → Deployments → retry latest, or just push any
   commit) so the binding takes effect.

### 4. Set the two secrets

**Settings → Environment variables** (mark both as **Encrypt**, i.e.
secrets, not plain text):

| Name | Used for |
|---|---|
| `ADMIN_PASSWORD` | The human admin password (Admin button on the page). Set it to whatever you want — it no longer needs to match anything hardcoded in the old version. |
| `SYNC_TOKEN` | A long random string (e.g. `openssl rand -hex 32`). Used only by the hourly Salesforce sync job below — never shown in the browser. |

Redeploy once more after setting these so the Functions pick them up.

### 5. Wire up the hourly Salesforce sync

This reuses the same mechanism as the existing `hourly-call-dashboard-refresh`
scheduled task — a local Claude Code scheduled task with your already
-authenticated Salesforce (Satellite) access, run hourly, that:

1. `GET https://<your-pages-url>/api/admin/pending` with header
   `x-sync-token: <SYNC_TOKEN>` → returns `{ aeNames, pendingAccountNames }`.
2. For each AE name, counts Opportunities they own that reached the
   `Discovery` stage in the trailing 30 days (same SOQL pattern used before:
   `Timestamp_Discovery__c >= LAST_N_DAYS:30`).
3. For each pending account name, looks up the matching Opportunity (owner,
   Id, Name, StageName).
4. `POST https://<your-pages-url>/api/admin/sync` with header
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

Opens the site at `http://localhost:8788` with Functions and KV emulated
locally (uses `wrangler`, installed as a dev dependency).

## What's intentionally simple here

- **No login for BDRs** — anyone with the link can spin and edit account
  names on the Spin tab. Only the roster/weights/delete actions are
  password-gated.
- **KV, not a "real" database** — fine for this team's size; if this grows
  well past a handful of BDRs spinning concurrently, move to D1 (Cloudflare's
  SQLite) for real transactional writes.
- **Polling, not WebSockets** — a 4-second poll is plenty responsive for a
  spin-and-see tool and avoids the complexity of realtime connections.
