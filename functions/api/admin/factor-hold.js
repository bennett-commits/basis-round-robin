import { loadState, saveState, requireAdmin, json } from "../../_lib/state.js";

// POST /api/admin/factor-hold  { value: boolean }   (admin only)
export async function onRequestPost({ request, env }) {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const state = await loadState(env);
  state.factorHoldRate = !!body.value;
  await saveState(env, state);
  return json({ factorHoldRate: state.factorHoldRate });
}
