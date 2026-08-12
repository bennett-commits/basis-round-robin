import { requireAdmin, json } from "../../_lib/state.js";

// POST /api/admin/login  { password: string }
// Server-side password check so the real password never ships in frontend JS.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body" }, { status: 400 }); }

  const fakeRequest = new Request(request.url, {
    headers: { "x-admin-password": String(body.password || "") }
  });
  const unauthorized = requireAdmin(fakeRequest, env);
  if (unauthorized) return json({ ok: false }, { status: 401 });
  return json({ ok: true });
}
