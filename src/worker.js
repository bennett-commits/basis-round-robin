import { loadDoc, saveDoc, applySync, json, requireSyncToken, loadChecks, setCheck } from "./lib/meetings.js";

async function readJson(request) {
  try { return await request.json(); }
  catch (e) { return null; }
}

const routes = {
  "GET /api/meetings": async ({ env }) => {
    const doc = await loadDoc(env);
    const checks = await loadChecks(env);
    return json({ asOf: doc.asOf, meetings: doc.meetings, checks });
  },

  // Manual "I confirmed this email went out" ticks, one per opp per role.
  // Stored apart from the meetings doc so the 6-hourly full-set sync, which
  // replaces that doc, never wipes them.
  "POST /api/checks": async ({ request, env }) => {
    const body = await readJson(request);
    if (!body || !body.oppId || !["bdr", "ae", "bdrFalse", "aeFalse"].includes(body.role)) {
      return json({ error: "Body must be JSON with oppId and role (bdr, ae, bdrFalse or aeFalse)" }, { status: 400 });
    }
    const checks = await setCheck(env, String(body.oppId), body.role, !!body.checked);
    return json({ ok: true, checks });
  },

  // The every-6-hours Salesforce sync posts the full set of BDR-booked
  // meetings in its window. See src/lib/meetings.js for the merge rules.
  "POST /api/admin/meetings": async ({ request, env }) => {
    const unauthorized = requireSyncToken(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body || !Array.isArray(body.meetings)) {
      return json({ error: "Body must be JSON with a meetings array" }, { status: 400 });
    }
    const doc = await loadDoc(env);
    const summary = await applySync(env, doc, body);
    await saveDoc(env, doc);
    return json({ ok: true, asOf: doc.asOf, ...summary });
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const key = request.method + " " + url.pathname;
      const handler = routes[key];
      if (!handler) return json({ error: "Not found" }, { status: 404 });
      try {
        return await handler({ request, env });
      } catch (err) {
        return json({ error: err.message || "Internal error" }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  }
};
