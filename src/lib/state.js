// Shared server-side state helpers for the round robin backend.
// Storage: a single JSON document in Cloudflare KV under key "state".
// KV has no atomic read-modify-write, so concurrent writes can race under
// heavy simultaneous use. For a handful of BDRs spinning occasionally this
// is an acceptable tradeoff to stay on the free tier (no Durable Objects).
//
// Two independent round-robin pools share this one document: "core" (the
// original AE rotation) and "ramping" (ramping reps). Every AE and log entry
// carries a `pool` field. Picking, weighting, and hold-rate math all run
// scoped to one pool at a time so the two rotations never affect each other.
// The Salesforce sync endpoints deliberately stay pool-agnostic — they match
// by AE name / account name across the whole roster, so one hourly sync run
// updates both pools without any extra plumbing.

const STATE_KEY = "state";
export const POOLS = ["core", "ramping"];

export function defaultState() {
  return {
    factorHoldRate: { core: false, ramping: false },
    sfPullDate: null,
    aes: [],
    log: []
  };
}

export async function loadState(env) {
  const raw = await env.RR_KV.get(STATE_KEY);
  if (!raw) return defaultState();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return defaultState();
  }
  const state = Object.assign(defaultState(), parsed);

  // Migrate the pre-pools shape: factorHoldRate used to be a plain boolean,
  // and AEs/log entries had no `pool` field (implicitly all "core").
  if (typeof state.factorHoldRate === "boolean") {
    state.factorHoldRate = { core: state.factorHoldRate, ramping: false };
  } else {
    state.factorHoldRate = Object.assign({ core: false, ramping: false }, state.factorHoldRate || {});
  }
  state.aes = (state.aes || []).map(a => ({ pool: "core", ...a }));
  state.log = (state.log || []).map(e => ({ pool: "core", ...e }));

  return state;
}

export async function saveState(env, state) {
  await env.RR_KV.put(STATE_KEY, JSON.stringify(state));
}

export function activeAes(state, pool) {
  return state.aes.filter(a => a.active && a.pool === pool);
}

export function findAe(state, id) {
  return state.aes.find(a => a.id === id);
}

export function findLogEntry(state, id) {
  return state.log.find(e => e.id === id);
}

export function overallHoldRate(state, pool) {
  let b = 0, h = 0;
  state.aes.filter(a => a.pool === pool).forEach(a => { b += a.bookedRR; h += a.heldRR; });
  return b > 0 ? h / b : null;
}

export function qualityFactor(state, ae) {
  if (!state.factorHoldRate[ae.pool]) return 1;
  const overall = overallHoldRate(state, ae.pool);
  if (ae.bookedRR < 3 || overall === null || overall === 0) return 1;
  const rate = ae.heldRR / ae.bookedRR;
  const factor = rate / overall;
  return Math.max(0.5, Math.min(1.5, factor));
}

export function effectiveWeights(state, pool) {
  const list = activeAes(state, pool);
  const raw = list.map(a => Math.max(0, a.weight) * qualityFactor(state, a));
  const sum = raw.reduce((s, v) => s + v, 0);
  if (sum <= 0) return list.map(() => 0);
  return raw.map(v => (v / sum) * 100);
}

// Deficit-based weighted round robin: pick the AE with the largest
// (target share * totalAssigned - assigned) so actual assignments
// converge to target weights over many spins. Scoped to one pool.
export function pickNextAe(state, pool) {
  const list = activeAes(state, pool);
  if (list.length === 0) return null;
  const eff = effectiveWeights(state, pool);
  const totalAssigned = list.reduce((s, a) => s + a.bookedRR, 0);
  let best = null, bestDeficit = -Infinity;
  list.forEach((a, i) => {
    const target = eff[i] / 100;
    const deficit = target * (totalAssigned + 1) - a.bookedRR;
    if (deficit > bestDeficit) { bestDeficit = deficit; best = a; }
  });
  return best;
}

// Simulates the next `count` picks within one pool without touching real
// state — lets the frontend show an upcoming queue (next-up + on-deck) that's
// consistent for everyone, while the actual booking still re-runs
// pickNextAe fresh against real state at the moment someone clicks Book
// Meeting.
export function previewQueue(state, pool, count) {
  const list = activeAes(state, pool);
  if (list.length === 0) return [];
  const eff = effectiveWeights(state, pool);
  const bookedCopy = {};
  list.forEach(a => { bookedCopy[a.id] = a.bookedRR; });

  const queue = [];
  for (let step = 0; step < count; step++) {
    const totalAssigned = list.reduce((s, a) => s + bookedCopy[a.id], 0);
    let best = null, bestDeficit = -Infinity;
    list.forEach((a, i) => {
      const target = eff[i] / 100;
      const deficit = target * (totalAssigned + 1) - bookedCopy[a.id];
      if (deficit > bestDeficit) { bestDeficit = deficit; best = a; }
    });
    if (!best) break;
    queue.push({ id: best.id, name: best.name });
    bookedCopy[best.id] += 1;
  }
  return queue;
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
