import { loadState, saveState, findLogEntry, json } from "../../_lib/state.js";

// POST /api/log/account  { id: string, accountName: string }
// Open to any BDR — no admin password required.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const state = await loadState(env);
  const entry = findLogEntry(state, body.id);
  if (!entry) return json({ error: "Log entry not found" }, { status: 404 });

  entry.accountName = String(body.accountName || "").trim();
  await saveState(env, state);
  return json({ entry });
}
