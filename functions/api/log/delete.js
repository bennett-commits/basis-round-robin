import { loadState, saveState, findAe, requireAdmin, json } from "../../_lib/state.js";

// POST /api/log/delete  { id: string }   (admin only)
// Removes a log entry and rolls back that AE's Booked/Held (RR) counts by one.
export async function onRequestPost({ request, env }) {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const state = await loadState(env);
  const index = state.log.findIndex(e => e.id === body.id);
  if (index === -1) return json({ error: "Log entry not found" }, { status: 404 });

  const entry = state.log[index];
  const ae = findAe(state, entry.aeId);
  if (ae) {
    ae.bookedRR = Math.max(0, ae.bookedRR - 1);
    if (entry.held) ae.heldRR = Math.max(0, ae.heldRR - 1);
  }
  state.log.splice(index, 1);
  await saveState(env, state);
  return json({ ok: true });
}
