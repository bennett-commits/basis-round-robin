import { loadState, effectiveWeights, overallHoldRate, activeAes, json } from "../_lib/state.js";

// GET /api/state — public read of the full shared state, plus derived
// fairness numbers so the frontend doesn't need to duplicate the math.
export async function onRequestGet({ env }) {
  const state = await loadState(env);
  const eff = effectiveWeights(state);
  const act = activeAes(state);
  const effByAeId = {};
  act.forEach((a, i) => { effByAeId[a.id] = eff[i]; });
  return json({
    ...state,
    effectiveWeights: effByAeId,
    overallHoldRate: overallHoldRate(state)
  });
}
