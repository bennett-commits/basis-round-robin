import { loadState, saveState, findAe, requireAdmin, newId, json } from "../../_lib/state.js";

// POST /api/admin/ae   (admin only)
// body: { action: "add", name } | { action: "update", id, patch: {...} } | { action: "remove", id }
export async function onRequestPost({ request, env }) {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const state = await loadState(env);

  if (body.action === "add") {
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "name is required" }, { status: 400 });
    const ae = { id: newId("ae"), name, active: true, weight: 20, bookedRR: 0, heldRR: 0, totalHeld30d: 0 };
    state.aes.push(ae);
    await saveState(env, state);
    return json({ ae });
  }

  if (body.action === "update") {
    const ae = findAe(state, body.id);
    if (!ae) return json({ error: "AE not found" }, { status: 404 });
    const patch = body.patch || {};
    const allowed = ["active", "weight", "bookedRR", "heldRR", "totalHeld30d", "name"];
    allowed.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(patch, key)) ae[key] = patch[key];
    });
    await saveState(env, state);
    return json({ ae });
  }

  if (body.action === "remove") {
    state.aes = state.aes.filter(a => a.id !== body.id);
    await saveState(env, state);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
}
