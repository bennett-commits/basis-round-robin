// Server-side helpers for the BDR meetings tracker.
// Storage: one JSON document in Cloudflare KV under key "meetings". The
// worker cannot query Salesforce itself; the every-6-hours sync job reads
// Salesforce and posts the full set of BDR-booked meetings here, and this
// module merges it into what is already stored.
//
// The old round-robin document (key "state") is left untouched in KV. It is
// read once, on the first sync, to carry over intro emails it had already
// found, so the tracker doesn't start with every email blank.

const MEETINGS_KEY = "meetings";
const LEGACY_STATE_KEY = "state";

export const STATUSES = ["booked", "held", "no_show"];

export function defaultDoc() {
  return { asOf: null, legacySeeded: false, meetings: [] };
}

export async function loadDoc(env) {
  const raw = await env.RR_KV.get(MEETINGS_KEY);
  if (!raw) return defaultDoc();
  try {
    return Object.assign(defaultDoc(), JSON.parse(raw));
  } catch (e) {
    return defaultDoc();
  }
}

export async function saveDoc(env, doc) {
  await env.RR_KV.put(MEETINGS_KEY, JSON.stringify(doc));
}

// Intro emails the round-robin sync had already found, keyed by opp Id.
async function loadLegacyEmails(env) {
  const raw = await env.RR_KV.get(LEGACY_STATE_KEY);
  const byOpp = {};
  if (!raw) return byOpp;
  let state;
  try { state = JSON.parse(raw); } catch (e) { return byOpp; }
  (state.log || []).forEach(e => {
    if (!e.oppId) return;
    byOpp[e.oppId] = { bdrIntroEmail: e.bdrIntroEmail || null, aeIntroEmail: e.aeIntroEmail || null };
  });
  return byOpp;
}

function str(value, max) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).slice(0, max || 200);
}

function isoOrNull(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return isNaN(t) ? null : new Date(t).toISOString();
}

function dateOnlyOrNull(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : null;
}

function normalizeEmail(value) {
  if (!value || typeof value !== "object" || !value.sentAt) return null;
  return {
    sentAt: String(value.sentAt),
    subject: str(value.subject, 200),
    taskId: str(value.taskId, 40)
  };
}

function normalizeMeeting(m) {
  if (!m || !m.oppId) return null;
  return {
    oppId: String(m.oppId),
    oppName: str(m.oppName),
    accountName: str(m.accountName) || str(m.oppName) || "Unknown account",
    bdrName: str(m.bdrName, 80),
    aeName: str(m.aeName, 80),
    bookedAt: isoOrNull(m.bookedAt),
    // First_Meeting_Date__c is a DATE. Keep it as a bare YYYY-MM-DD so "days
    // until" is plain calendar math and never shifts a day across time zones.
    meetingDate: dateOnlyOrNull(m.meetingDate),
    // Optional exact start time, taken from the matching Salesforce Event.
    meetingAt: isoOrNull(m.meetingAt),
    stage: str(m.stage, 60),
    status: STATUSES.includes(m.status) ? m.status : "booked",
    bdrIntroEmail: normalizeEmail(m.bdrIntroEmail),
    aeIntroEmail: normalizeEmail(m.aeIntroEmail)
  };
}

// Replace the stored meeting set with the one the sync job just read.
// Meetings that left the sync's window drop out. Emails are sticky: once
// found, a later run that doesn't see one (deleted Task, query flake) must
// not un-send it.
export async function applySync(env, doc, body) {
  const previous = {};
  doc.meetings.forEach(m => { previous[m.oppId] = m; });
  const legacy = doc.legacySeeded ? {} : await loadLegacyEmails(env);

  let emailsCarried = 0;
  const meetings = [];
  const seen = new Set();
  (Array.isArray(body.meetings) ? body.meetings : []).forEach(raw => {
    const m = normalizeMeeting(raw);
    if (!m || seen.has(m.oppId)) return;
    seen.add(m.oppId);
    const prior = previous[m.oppId] || legacy[m.oppId] || {};
    ["bdrIntroEmail", "aeIntroEmail"].forEach(key => {
      if (!m[key] && prior[key]) {
        m[key] = normalizeEmail(prior[key]);
        if (m[key]) emailsCarried++;
      }
    });
    meetings.push(m);
  });

  doc.meetings = meetings;
  doc.asOf = isoOrNull(body.asOf) || new Date().toISOString();
  doc.legacySeeded = true;
  return {
    meetings: meetings.length,
    held: meetings.filter(m => m.status === "held").length,
    withBdrIntroEmail: meetings.filter(m => m.bdrIntroEmail).length,
    withAeIntroEmail: meetings.filter(m => m.aeIntroEmail).length,
    emailsCarried
  };
}

export function json(data, init) {
  return new Response(JSON.stringify(data), {
    status: (init && init.status) || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export function requireSyncToken(request, env) {
  const provided = request.headers.get("x-sync-token") || "";
  if (!env.SYNC_TOKEN || provided !== env.SYNC_TOKEN) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
