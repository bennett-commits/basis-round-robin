import {
  loadState, saveState, activeAes, findAe, findLogEntry,
  overallHoldRate, effectiveWeights, pickNextAe, previewQueue, newId,
  json, requireAdmin, requireSyncToken, requireAdminOrSyncToken,
  resetCycleCounters, cycleEndsAt, inCurrentCycle,
  takeNextOverride, clearNextOverride,
  needsActivityCheck, applyActivity,
  PAST_DISCOVERY_STAGES, POOLS, CYCLE_DAYS
} from "./lib/state.js";

async function readJson(request) {
  try { return await request.json(); }
  catch (e) { return null; }
}

function normalizePool(value) {
  return POOLS.includes(value) ? value : "core";
}

const PREVIEW_QUEUE_LENGTH = 4; // 1 next-up + 3 on-deck

const routes = {
  "GET /api/state": async ({ env }) => {
    const state = await loadState(env);
    const effectiveWeightsByPool = {};
    const nextQueueByPool = {};
    const overallHoldRateByPool = {};
    POOLS.forEach(pool => {
      const eff = effectiveWeights(state, pool);
      const act = activeAes(state, pool);
      const map = {};
      act.forEach((a, i) => { map[a.id] = eff[i]; });
      effectiveWeightsByPool[pool] = map;
      nextQueueByPool[pool] = previewQueue(state, pool, PREVIEW_QUEUE_LENGTH);
      overallHoldRateByPool[pool] = overallHoldRate(state, pool);
    });
    return json({
      ...state,
      cycleDays: CYCLE_DAYS,
      cycleEndsAt: cycleEndsAt(state),
      effectiveWeights: effectiveWeightsByPool,
      overallHoldRate: overallHoldRateByPool,
      nextQueue: nextQueueByPool
    });
  },

  "POST /api/spin": async ({ request, env }) => {
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const bdrName = String(body.bdrName || "").trim();
    const pool = normalizePool(body.pool);
    if (!bdrName) return json({ error: "bdrName is required" }, { status: 400 });

    const state = await loadState(env);
    // A pending admin override wins this one booking and is consumed here;
    // every later spin falls straight back to the deficit queue.
    const forced = takeNextOverride(state, pool);
    const winner = forced || pickNextAe(state, pool);
    if (!winner) return json({ error: "No active AEs configured for this pool" }, { status: 409 });

    winner.bookedRR += 1;
    const entry = {
      id: newId("log"), aeId: winner.id, name: winner.name, bdrName, pool,
      accountName: "", held: false, lost: false, flagged: false,
      oppId: null, oppName: null, oppStage: null,
      forced: !!forced,
      ts: new Date().toISOString()
    };
    state.log.unshift(entry);
    await saveState(env, state);
    return json({ entry, winner: { id: winner.id, name: winner.name }, forced: !!forced });
  },

  "POST /api/log/account": async ({ request, env }) => {
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const state = await loadState(env);
    const entry = findLogEntry(state, body.id);
    if (!entry) return json({ error: "Log entry not found" }, { status: 404 });
    entry.accountName = String(body.accountName || "").trim();
    await saveState(env, state);
    return json({ entry });
  },

  "POST /api/log/flag": async ({ request, env }) => {
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const state = await loadState(env);
    const entry = findLogEntry(state, body.id);
    if (!entry) return json({ error: "Log entry not found" }, { status: 404 });
    entry.flagged = !entry.flagged;
    await saveState(env, state);
    return json({ entry });
  },

  // Retroactively move an assignment to a different AE. The counters follow
  // the deal: the old owner gives back the booked (and held) credit and the
  // new owner takes it on — but only when the entry falls inside the current
  // weighting cycle, mirroring the delete path. Reassigning an older booking
  // must not move counters the present cycle never counted in the first place.
  "POST /api/log/reassign": async ({ request, env }) => {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const state = await loadState(env);
    const entry = findLogEntry(state, body.id);
    if (!entry) return json({ error: "Log entry not found" }, { status: 404 });
    const target = findAe(state, body.aeId);
    if (!target) return json({ error: "AE not found" }, { status: 404 });
    if (target.id === entry.aeId) return json({ entry });

    // May be undefined if the original AE has since been removed from the
    // roster — the deal still moves, there is just nothing to debit.
    const previous = findAe(state, entry.aeId);
    if (inCurrentCycle(state, entry)) {
      if (previous) {
        previous.bookedRR = Math.max(0, previous.bookedRR - 1);
        if (entry.held) previous.heldRR = Math.max(0, previous.heldRR - 1);
      }
      target.bookedRR += 1;
      if (entry.held) target.heldRR += 1;
    }

    entry.reassignedFrom = (previous && previous.name) || entry.name;
    entry.reassignedAt = new Date().toISOString();
    entry.aeId = target.id;
    entry.name = target.name;
    // The deal belongs to whichever rotation its new owner books for, so the
    // entry follows them across pools — otherwise a cross-pool move would
    // leave a core deal sitting in the ramping log and counting against the
    // wrong pool's hold rate.
    entry.pool = target.pool;

    await saveState(env, state);
    return json({ entry });
  },

  "POST /api/log/delete": async ({ request, env }) => {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const state = await loadState(env);
    const index = state.log.findIndex(e => e.id === body.id);
    if (index === -1) return json({ error: "Log entry not found" }, { status: 404 });
    const entry = state.log[index];
    const ae = findAe(state, entry.aeId);
    // Only debit counters if this entry is actually part of what they count.
    // Deleting a pre-reset entry must not claw back from the new cycle.
    if (ae && inCurrentCycle(state, entry)) {
      ae.bookedRR = Math.max(0, ae.bookedRR - 1);
      if (entry.held) ae.heldRR = Math.max(0, ae.heldRR - 1);
    }
    state.log.splice(index, 1);
    await saveState(env, state);
    return json({ ok: true });
  },

  "POST /api/admin/ae": async ({ request, env }) => {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const state = await loadState(env);

    if (body.action === "add") {
      const name = String(body.name || "").trim();
      if (!name) return json({ error: "name is required" }, { status: 400 });
      const pool = normalizePool(body.pool);
      const email = String(body.email || "").trim();
      const ae = { id: newId("ae"), name, pool, email, active: true, weight: 20, bookedRR: 0, heldRR: 0, totalHeld30d: 0 };
      state.aes.push(ae);
      await saveState(env, state);
      return json({ ae });
    }
    if (body.action === "update") {
      const ae = findAe(state, body.id);
      if (!ae) return json({ error: "AE not found" }, { status: 404 });
      const patch = body.patch || {};
      ["active", "weight", "bookedRR", "heldRR", "totalHeld30d", "name", "email"].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(patch, key)) ae[key] = patch[key];
      });
      await saveState(env, state);
      return json({ ae });
    }
    if (body.action === "remove") {
      state.aes = state.aes.filter(a => a.id !== body.id);
      // Drop any override queued up for the AE who just left the roster.
      POOLS.forEach(p => { if (state.nextOverride[p] === body.id) clearNextOverride(state, p); });
      await saveState(env, state);
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, { status: 400 });
  },

  // Queue a specific AE to take the next booking in one pool, or clear a
  // pending override by sending a null/absent aeId.
  "POST /api/admin/next-override": async ({ request, env }) => {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const pool = normalizePool(body.pool);
    const state = await loadState(env);

    if (!body.aeId) {
      clearNextOverride(state, pool);
      await saveState(env, state);
      return json({ ok: true, nextOverride: state.nextOverride });
    }

    const ae = findAe(state, body.aeId);
    if (!ae) return json({ error: "AE not found" }, { status: 404 });
    // Refuse rather than silently no-op: an override that resolves to nothing
    // would leave the admin believing the next deal is routed when it is not.
    if (ae.pool !== pool) return json({ error: "That AE is not in this pool" }, { status: 400 });
    if (!ae.active) return json({ error: "That AE is not currently in the round robin" }, { status: 400 });

    state.nextOverride[pool] = ae.id;
    await saveState(env, state);
    return json({ ok: true, nextOverride: state.nextOverride, ae: { id: ae.id, name: ae.name } });
  },

  "POST /api/admin/factor-hold": async ({ request, env }) => {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const pool = normalizePool(body.pool);
    const state = await loadState(env);
    state.factorHoldRate[pool] = !!body.value;
    await saveState(env, state);
    return json({ factorHoldRate: state.factorHoldRate });
  },

  "POST /api/admin/login": async ({ request, env }) => {
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const fakeRequest = new Request(request.url, { headers: { "x-admin-password": String(body.password || "") } });
    const unauthorized = requireAdmin(fakeRequest, env);
    if (unauthorized) return json({ ok: false }, { status: 401 });
    return json({ ok: true });
  },

  // Force a new weighting cycle immediately, instead of waiting for the
  // 30-day boundary. Counters go to zero; weights, roster and log survive.
  "POST /api/admin/reset-cycle": async ({ request, env }) => {
    const unauthorized = requireAdminOrSyncToken(request, env);
    if (unauthorized) return unauthorized;
    const state = await loadState(env);
    const before = state.aes.map(a => ({
      name: a.name, pool: a.pool, bookedRR: a.bookedRR, heldRR: a.heldRR
    }));
    const startedAt = new Date().toISOString();
    resetCycleCounters(state, startedAt);
    await saveState(env, state);
    return json({
      ok: true,
      cycleStartedAt: startedAt,
      cycleEndsAt: cycleEndsAt(state),
      cycleDays: CYCLE_DAYS,
      aesReset: before.length,
      before
    });
  },

  "GET /api/admin/pending": async ({ request, env }) => {
    const unauthorized = requireSyncToken(request, env);
    if (unauthorized) return unauthorized;
    const state = await loadState(env);
    const aeNames = state.aes.map(a => a.name);
    const pendingAccountNames = Array.from(new Set(
      state.log.filter(e => !e.oppId && (e.accountName || "").trim()).map(e => e.accountName.trim())
    ));
    // Linked deals whose intro meeting / intro emails aren't settled yet.
    // The sync job re-reads these from Salesforce every run (see
    // needsActivityCheck) and posts them back as `activity`.
    const now = Date.now();
    const trackedOpps = state.log.filter(e => needsActivityCheck(e, now)).map(e => ({
      oppId: e.oppId,
      accountName: e.accountName,
      aeName: e.name,
      bdrName: e.bdrName,
      assignedAt: e.ts,
      introMeetingAt: e.introMeetingAt || null,
      hasBdrIntroEmail: !!e.bdrIntroEmail,
      hasAeIntroEmail: !!e.aeIntroEmail
    }));
    return json({ aeNames, pendingAccountNames, trackedOpps });
  },

  "POST /api/admin/sync": async ({ request, env }) => {
    const unauthorized = requireSyncToken(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const state = await loadState(env);
    let matchedCount = 0, heldCount = 0, lostCount = 0, aeUpdated = 0;

    if (body.heldAllSources30d && typeof body.heldAllSources30d === "object") {
      Object.keys(body.heldAllSources30d).forEach(key => {
        const ae = state.aes.find(a => a.name.toLowerCase() === String(key).toLowerCase());
        if (ae) {
          ae.totalHeld30d = Math.max(0, parseInt(body.heldAllSources30d[key], 10) || 0);
          aeUpdated++;
        }
      });
    }

    if (Array.isArray(body.matches)) {
      body.matches.forEach(m => {
        if (!m || !m.accountName) return;
        const target = state.log.find(e =>
          (e.accountName || "").trim().toLowerCase() === String(m.accountName).trim().toLowerCase()
        );
        if (!target) return;
        matchedCount++;
        target.oppId = m.oppId || target.oppId;
        target.oppName = m.oppName || target.oppName;
        target.oppStage = m.stage || target.oppStage;
        target.linkedAt = body.asOf || new Date().toISOString();

        // "Held" means the opp ever reached Discovery — a historical fact
        // that must survive a later stage change. Checking only the CURRENT
        // stage is wrong: a deal that reached Discovery and then Closed Lost
        // would show as Lost only, never Held, understating real held rate.
        // reachedDiscovery is the authoritative signal (from
        // Timestamp_Discovery__c on the Salesforce side); current-stage
        // membership in PAST_DISCOVERY_STAGES is kept only as a fallback for
        // callers that don't send it.
        const stage = String(m.stage || "").toLowerCase();
        const reachedDiscovery = m.reachedDiscovery === true || PAST_DISCOVERY_STAGES.indexOf(stage) !== -1;
        if (reachedDiscovery) {
          if (!target.held) {
            // The log entry's held flag is a permanent historical fact, so it
            // is always set. The AE's heldRR is per-cycle, so a booking made
            // before the current cycle must not credit it — otherwise a late
            // sync could push heldRR above bookedRR and distort hold rate.
            target.held = true;
            const ae = findAe(state, target.aeId);
            if (ae && inCurrentCycle(state, target)) ae.heldRR += 1;
            heldCount++;
          }
          // A deal that reached Discovery and later died is normal sales
          // attrition, not a "no show" — clear any earlier no-show flag now
          // that we know better (this also corrects records synced before
          // this reachedDiscovery signal existed).
          if (target.lost) target.lost = false;
        } else if (stage === "closed lost" && !target.lost) {
          // Closed dead without ever reaching Discovery — a true no-show,
          // not a normal loss further down the funnel.
          target.lost = true;
          lostCount++;
        }
      });
    }

    // Runs after `matches`, so an opp linked in this same payload can carry
    // its activity in the same request.
    let activityUpdated = 0;
    if (Array.isArray(body.activity)) {
      const checkedAt = body.asOf || new Date().toISOString();
      body.activity.forEach(a => {
        if (!a || !a.oppId) return;
        state.log.filter(e => e.oppId === a.oppId).forEach(e => {
          applyActivity(e, a, checkedAt);
          activityUpdated++;
        });
      });
    }

    if (body.asOf) state.sfPullDate = body.asOf;
    await saveState(env, state);

    return json({
      matchedCount, heldCount, lostCount, aeUpdated, activityUpdated,
      pendingAccountNames: Array.from(new Set(
        state.log.filter(e => !e.oppId && (e.accountName || "").trim()).map(e => e.accountName.trim())
      ))
    });
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const key = request.method + " " + url.pathname;
      const handler = routes[key];
      if (!handler) return json({ error: "Not found" }, { status: 404 });
      try {
        return await handler({ request, env });
      } catch (err) {
        return json({ error: err.message || "Internal error" }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  }
};
