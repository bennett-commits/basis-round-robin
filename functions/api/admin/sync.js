import { loadState, saveState, findAe, requireSyncToken, PAST_DISCOVERY_STAGES, json } from "../../_lib/state.js";

// POST /api/admin/sync   (requires x-sync-token header, distinct from the human admin password)
// Called by the hourly local scheduled task (same pattern as hourly-call-dashboard-refresh),
// which has real Salesforce access via this machine's authenticated session.
// body: {
//   asOf: "<ISO timestamp>",
//   heldAllSources30d: { "<AE full name>": <count> },
//   matches: [ { accountName, oppId, oppName, stage } ]
// }
export async function onRequestPost({ request, env }) {
  const unauthorized = requireSyncToken(request, env);
  if (unauthorized) return unauthorized;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const state = await loadState(env);
  let matchedCount = 0, heldCount = 0, lostCount = 0, aeUpdated = 0;

  if (body.heldAllSources30d && typeof body.heldAllSources30d === "object") {
    Object.keys(body.heldAllSources30d).forEach(key => {
      const ae = state.aes.find(a => a.name.toLowerCase() === String(key).toLowerCase());
      if (ae) {
        ae.totalHeld30d = Math.max(0, parseInt(body.heldAllSources30d[key], 10) || 0);
        aeUpdated++;
      }
    });
  }

  if (Array.isArray(body.matches)) {
    body.matches.forEach(m => {
      if (!m || !m.accountName) return;
      const target = state.log.find(e =>
        (e.accountName || "").trim().toLowerCase() === String(m.accountName).trim().toLowerCase()
      );
      if (!target) return;
      matchedCount++;
      target.oppId = m.oppId || target.oppId;
      target.oppName = m.oppName || target.oppName;
      target.oppStage = m.stage || target.oppStage;
      target.linkedAt = body.asOf || new Date().toISOString();

      const stage = String(m.stage || "").toLowerCase();
      if (PAST_DISCOVERY_STAGES.indexOf(stage) !== -1 && !target.held) {
        target.held = true;
        const ae = findAe(state, target.aeId);
        if (ae) ae.heldRR += 1;
        heldCount++;
      }
      if (stage === "closed lost" && !target.lost) {
        target.lost = true;
        lostCount++;
      }
    });
  }

  if (body.asOf) state.sfPullDate = body.asOf;
  await saveState(env, state);

  return json({
    matchedCount, heldCount, lostCount, aeUpdated,
    pendingAccountNames: Array.from(new Set(
      state.log.filter(e => !e.oppId && (e.accountName || "").trim()).map(e => e.accountName.trim())
    ))
  });
}
