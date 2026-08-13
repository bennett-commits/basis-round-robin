import {
  loadState, saveState, activeAes, findAe, findLogEntry,
  overallHoldRate, effectiveWeights, pickNextAe, newId,
  json, requireAdmin, requireSyncToken, PAST_DISCOVERY_STAGES
} from "./lib/state.js";

async function readJson(request) {
  try { return await request.json(); }
  catch (e) { return null; }
}

const routes = {
  "GET /api/state": async ({ env }) => {
    const state = await loadState(env);
    const eff = effectiveWeights(state);
    const act = activeAes(state);
    const effByAeId = {};
    act.forEach((a, i) => { effByAeId[a.id] = eff[i]; });
    return json({ ...state, effectiveWeights: effByAeId, overallHoldRate: overallHoldRate(state) });
  },

  "POST /api/spin": async ({ request, env }) => {
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const bdrName = String(body.bdrName || "").trim();
    if (!bdrName) return json({ error: "bdrName is required" }, { status: 400 });

    const state = await loadState(env);
    const winner = pickNextAe(state);
    if (!winner) return json({ error: "No active AEs configured" }, { status: 409 });

    winner.bookedRR += 1;
    const entry = {
      id: newId("log"), aeId: winner.id, name: winner.name, bdrName,
      accountName: "", held: false, lost: false,
      oppId: null, oppName: null, oppStage: null,
      ts: new Date().toISOString()
    };
    state.log.unshift(entry);
    await saveState(env, state);
    return json({ entry, winner: { id: winner.id, name: winner.name } });
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
    if (ae) {
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
      const ae = { id: newId("ae"), name, active: true, weight: 20, bookedRR: 0, heldRR: 0, totalHeld30d: 0 };
      state.aes.push(ae);
      await saveState(env, state);
      return json({ ae });
    }
    if (body.action === "update") {
      const ae = findAe(state, body.id);
      if (!ae) return json({ error: "AE not found" }, { status: 404 });
      const patch = body.patch || {};
      ["active", "weight", "bookedRR", "heldRR", "totalHeld30d", "name"].forEach(key => {
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
  },

  "POST /api/admin/factor-hold": async ({ request, env }) => {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const body = await readJson(request);
    if (!body) return json({ error: "Invalid JSON body" }, { status: 400 });
    const state = await loadState(env);
    state.factorHoldRate = !!body.value;
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

  "GET /api/admin/pending": async ({ request, env }) => {
    const unauthorized = requireSyncToken(request, env);
    if (unauthorized) return unauthorized;
    const state = await loadState(env);
    const aeNames = state.aes.map(a => a.name);
    const pendingAccountNames = Array.from(new Set(
      state.log.filter(e => !e.oppId && (e.accountName || "").trim()).map(e => e.accountName.trim())
    ));
    return json({ aeNames, pendingAccountNames });
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

        const stage = String(m.stage || "").toLowerCase();
        if (PAST_DISCOVERY_STAGES.indexOf(stage) !== -1 && !target.held) {
          target.held = true;
          const ae = findAe(state, target.aeId);
          if (ae) ae.heldRR += 1;
          heldCount++;
        }
        if (stage === "closed lost" && !target.lost) {
          target.lost = true;
          lostCount++;
        }
      });
    }

    if (body.asOf) state.sfPullDate = body.asOf;
    await saveState(env, state);

    return json({
      matchedCount, heldCount, lostCount, aeUpdated,
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
