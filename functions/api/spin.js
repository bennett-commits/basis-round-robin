import { loadState, saveState, pickNextAe, newId, json } from "../_lib/state.js";

// POST /api/spin  { bdrName: string }
// Picks the next AE server-side (so two BDRs spinning at once can't both
// "win" the same deficit slot) and appends a log entry.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const bdrName = String(body.bdrName || "").trim();
  if (!bdrName) return json({ error: "bdrName is required" }, { status: 400 });

  const state = await loadState(env);
  const winner = pickNextAe(state);
  if (!winner) return json({ error: "No active AEs configured" }, { status: 409 });

  winner.bookedRR += 1;
  const entry = {
    id: newId("log"),
    aeId: winner.id,
    name: winner.name,
    bdrName,
    accountName: "",
    held: false,
    lost: false,
    oppId: null,
    oppName: null,
    oppStage: null,
    ts: new Date().toISOString()
  };
  state.log.unshift(entry);
  await saveState(env, state);

  return json({ entry, winner: { id: winner.id, name: winner.name } });
}
