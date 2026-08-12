import { loadState, requireSyncToken, json } from "../../_lib/state.js";

// GET /api/admin/pending   (requires x-sync-token header)
// What the hourly scheduled task reads before it runs its Salesforce lookups:
// which AEs to compute 30-day held counts for, and which account names still
// need an Opportunity match.
export async function onRequestGet({ request, env }) {
  const unauthorized = requireSyncToken(request, env);
  if (unauthorized) return unauthorized;

  const state = await loadState(env);
  const aeNames = state.aes.map(a => a.name);
  const pendingAccountNames = Array.from(new Set(
    state.log.filter(e => !e.oppId && (e.accountName || "").trim()).map(e => e.accountName.trim())
  ));
  return json({ aeNames, pendingAccountNames });
}
