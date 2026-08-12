import { loadState, saveState, findLogEntry, findAe, json } from "../../_lib/state.js";

// POST /api/log/held  { id: string }
// Open to any BDR — matches the existing "Mark held" flow.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const state = await loadState(env);
  const entry = findLogEntry(state, body.id);
  if (!entry) return json({ error: "Log entry not found" }, { status: 404 });

  if (!entry.held) {
    entry.held = true;
    const ae = findAe(state, entry.aeId);
    if (ae) ae.heldRR += 1;
    await saveState(env, state);
  }
  return json({ entry });
}
