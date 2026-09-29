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

// Weighting runs in fixed 30-day cycles. The deficit queue converges on target
// weights using each AE's accumulated bookedRR, so without a reset those
// counters carry all-time history forever: a weight change, a rep going
// inactive for a stretch, or a mid-quarter roster change stays "priced in"
// long after it stopped being true. Zeroing bookedRR/heldRR every 30 days
// makes the rotation converge on the CURRENT weights within a bounded window.
// Only the per-AE counters reset — configured `weight`, the assignment log,
// and each entry's held/lost history are untouched.
export const CYCLE_DAYS = 30;
export const CYCLE_MS = CYCLE_DAYS * 24 * 60 * 60 * 1000;

export function defaultState() {
  return {
    factorHoldRate: { core: false, ramping: false },
    nextOverride: { core: null, ramping: null },
    sfPullDate: null,
    cycleStartedAt: null,
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
  state.nextOverride = Object.assign({ core: null, ramping: null }, state.nextOverride || {});
  state.aes = (state.aes || []).map(a => ({ pool: "core", ...a }));
  state.log = (state.log || []).map(e => ({ pool: "core", ...e }));

  // Roll the 30-day cycle on read so every caller sees a correctly-scoped
  // state. This is deliberately NOT persisted here: maybeRollCycle is a pure
  // function of (cycleStartedAt, now) that advances by whole 30-day periods,
  // so recomputing it on each load is idempotent and the next write persists
  // it. That keeps reads free of KV writes.
  maybeRollCycle(state);

  return state;
}

export async function saveState(env, state) {
  await env.RR_KV.put(STATE_KEY, JSON.stringify(state));
}

// Zero the per-cycle counters and stamp a new cycle start. Deliberately does
// not touch `weight`, the log, or any entry's held/lost flags.
export function resetCycleCounters(state, startedAt) {
  state.aes.forEach(a => { a.bookedRR = 0; a.heldRR = 0; });
  state.cycleStartedAt = startedAt;
  return state;
}

// Advance the cycle if one or more full 30-day periods have elapsed. The new
// start is the old start plus a whole number of periods (never "now"), so the
// cycle boundaries stay on a fixed cadence and the result is identical no
// matter how many times this runs within the same period. Returns true if
// counters were actually reset.
export function maybeRollCycle(state, now) {
  const nowMs = typeof now === "number" ? now : Date.now();
  const start = Date.parse(state.cycleStartedAt || "");
  if (!Number.isFinite(start)) {
    // First run after this feature shipped (or a corrupt value): start the
    // clock now without wiping anything. An explicit reset is a separate act.
    state.cycleStartedAt = new Date(nowMs).toISOString();
    return false;
  }
  const elapsed = nowMs - start;
  if (elapsed < CYCLE_MS) return false;
  const periods = Math.floor(elapsed / CYCLE_MS);
  resetCycleCounters(state, new Date(start + periods * CYCLE_MS).toISOString());
  return true;
}

export function cycleEndsAt(state) {
  const start = Date.parse(state.cycleStartedAt || "");
  if (!Number.isFinite(start)) return null;
  return new Date(start + CYCLE_MS).toISOString();
}

// Whether a log entry belongs to the cycle currently being counted. Entries
// from earlier cycles must not move bookedRR/heldRR, or a delete (or a late
// Salesforce sync) would credit/debit a counter that never included them.
export function inCurrentCycle(state, entry) {
  const start = Date.parse(state.cycleStartedAt || "");
  const ts = Date.parse((entry && entry.ts) || "");
  if (!Number.isFinite(start) || !Number.isFinite(ts)) return true;
  return ts >= start;
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

// --- Manual "next up" override -------------------------------------------
// An admin can force one specific AE to take the next booking in a pool,
// bypassing the deficit queue. The override is deliberately ONE-SHOT: the
// next booking in that pool consumes it and the normal rotation resumes
// immediately. The forced booking still increments bookedRR, so the deficit
// queue hands that AE correspondingly less over the following spins — an
// override changes the ORDER of assignments, never anyone's target share.
//
// The stored id is re-validated on every read rather than trusted, so an AE
// who is deactivated, moved to the other pool, or deleted while queued up
// simply voids the override instead of wedging the rotation.
export function resolveNextOverride(state, pool) {
  const id = state.nextOverride && state.nextOverride[pool];
  if (!id) return null;
  const ae = findAe(state, id);
  if (!ae || !ae.active || ae.pool !== pool) return null;
  return ae;
}

export function clearNextOverride(state, pool) {
  if (state.nextOverride) state.nextOverride[pool] = null;
}

// Resolve and consume in one step — used by the booking path. Clears even a
// stale/invalid id so a dead override can't linger in the document forever.
export function takeNextOverride(state, pool) {
  const ae = resolveNextOverride(state, pool);
  clearNextOverride(state, pool);
  return ae;
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
  // A pending override owns the first slot; the rest of the queue is then
  // simulated from the state that booking would leave behind, so the on-deck
  // names shown are the ones that will really come next.
  const forced = resolveNextOverride(state, pool);
  if (forced) {
    queue.push({ id: forced.id, name: forced.name, forced: true });
    bookedCopy[forced.id] += 1;
  }

  for (let step = queue.length; step < count; step++) {
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

// The reset is a maintenance action reachable two ways: a human admin in the
// UI, or the Salesforce sync job's token (which already has write access to
// these very counters, so this grants it nothing new).
export function requireAdminOrSyncToken(request, env) {
  if (!requireAdmin(request, env)) return null;
  return requireSyncToken(request, env);
}

export function requireSyncToken(request, env) {
  const provided = request.headers.get("x-sync-token") || "";
  if (!env.SYNC_TOKEN || provided !== env.SYNC_TOKEN) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export const PAST_DISCOVERY_STAGES = ["discovery", "evaluation", "legal & pricing", "pilot", "closed won"];

// --- Intro activity (meeting date + intro emails) -------------------------
// Three per-deal facts the sync job reads off Salesforce once an entry is
// linked to an opp: when the first meeting is on the calendar, whether the
// BDR sent the contact an intro email, and whether the AE followed up with a
// pre-meeting discovery email (ERP, AI readiness, ...). The worker cannot
// query Salesforce itself, so linked entries are handed back to the sync job
// on every run until all three are settled — emails typically land hours or
// days AFTER the opp is first matched, so checking only at match time would
// leave them blank forever.
export const ACTIVITY_TRACK_DAYS = 45;

function settledMeeting(entry, now) {
  // A meeting still in the future can be rescheduled, so keep re-reading it
  // until it has actually passed.
  return !!entry.introMeetingAt && Date.parse(entry.introMeetingAt) <= now;
}

export function needsActivityCheck(entry, now) {
  if (!entry.oppId || entry.flagged) return false;
  if (now - Date.parse(entry.ts) > ACTIVITY_TRACK_DAYS * 24 * 60 * 60 * 1000) return false;
  return !settledMeeting(entry, now) || !entry.bdrIntroEmail || !entry.aeIntroEmail;
}

function normalizeEmail(value) {
  if (!value || typeof value !== "object" || !value.sentAt) return null;
  return {
    sentAt: String(value.sentAt),
    subject: value.subject ? String(value.subject).slice(0, 200) : null,
    taskId: value.taskId ? String(value.taskId) : null
  };
}

// Apply one activity record from the sync job. Emails are sticky: once one
// has been found, a later run that happens not to see it (deleted Task,
// query flake) must not un-send it. The meeting date overwrites, because a
// reschedule is real information.
export function applyActivity(entry, record, checkedAt) {
  if (Object.prototype.hasOwnProperty.call(record, "introMeetingAt") && record.introMeetingAt) {
    const t = Date.parse(record.introMeetingAt);
    if (!isNaN(t)) entry.introMeetingAt = new Date(t).toISOString();
  }
  const bdr = normalizeEmail(record.bdrIntroEmail);
  if (bdr && !entry.bdrIntroEmail) entry.bdrIntroEmail = bdr;
  const ae = normalizeEmail(record.aeIntroEmail);
  if (ae && !entry.aeIntroEmail) entry.aeIntroEmail = ae;
  entry.activityCheckedAt = checkedAt;
}
