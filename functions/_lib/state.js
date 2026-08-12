// Shared server-side state helpers for the round robin backend.
// Storage: a single JSON document in Cloudflare KV under key "state".
// KV has no atomic read-modify-write, so concurrent writes can race under
// heavy simultaneous use. For a handful of BDRs spinning occasionally this
// is an acceptable tradeoff to stay on the free tier (no Durable Objects).

const STATE_KEY = "state";

export function defaultState() {
  return {
    factorHoldRate: false,
    sfPullDate: null,
    aes: [],
    log: []
  };
}

export async function loadState(env) {
  const raw = await env.RR_KV.get(STATE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  } catch (e) {
    return defaultState();
  }
}

export async function saveState(env, state) {
  await env.RR_KV.put(STATE_KEY, JSON.stringify(state));
}

export function activeAes(state) {
  return state.aes.filter(a => a.active);
}

export function findAe(state, id) {
  return state.aes.find(a => a.id === id);
}

export function findLogEntry(state, id) {
  return state.log.find(e => e.id === id);
}

export function overallHoldRate(state) {
  let b = 0, h = 0;
  state.aes.forEach(a => { b += a.bookedRR; h += a.heldRR; });
  return b > 0 ? h / b : null;
}

export function qualityFactor(state, ae) {
  if (!state.factorHoldRate) return 1;
  const overall = overallHoldRate(state);
  if (ae.bookedRR < 3 || overall === null || overall === 0) return 1;
  const rate = ae.heldRR / ae.bookedRR;
  const factor = rate / overall;
  return Math.max(0.5, Math.min(1.5, factor));
}

export function effectiveWeights(state) {
  const list = activeAes(state);
  const raw = list.map(a => Math.max(0, a.weight) * qualityFactor(state, a));
  const sum = raw.reduce((s, v) => s + v, 0);
  if (sum <= 0) return list.map(() => 0);
  return raw.map(v => (v / sum) * 100);
}

// Deficit-based weighted round robin: pick the AE with the largest
// (target share * totalAssigned - assigned) so actual assignments
// converge to target weights over many spins.
export function pickNextAe(state) {
  const list = activeAes(state);
  if (list.length === 0) return null;
  const eff = effectiveWeights(state);
  const totalAssigned = list.reduce((s, a) => s + a.bookedRR, 0);
  let best = null, bestDeficit = -Infinity;
  list.forEach((a, i) => {
    const target = eff[i] / 100;
    const deficit = target * (totalAssigned + 1) - a.bookedRR;
    if (deficit > bestDeficit) { bestDeficit = deficit; best = a; }
  });
  return best;
}

export function newId(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
}

export function json(data, init) {
  return new Response(JSON.stringify(data), {
    status: (init && init.status) || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export function requireAdmin(request, env) {
  const provided = request.headers.get("x-admin-password") || "";
  if (!env.ADMIN_PASSWORD || provided !== env.ADMIN_PASSWORD) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export function requireSyncToken(request, env) {
  const provided = request.headers.get("x-sync-token") || "";
  if (!env.SYNC_TOKEN || provided !== env.SYNC_TOKEN) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export const PAST_DISCOVERY_STAGES = ["discovery", "evaluation", "legal & pricing", "pilot", "closed won"];
