(function () {
  "use strict";

  const TZ = "America/Los_Angeles";
  const DAY_MS = 24 * 60 * 60 * 1000;

  let meetings = [];
  let sortDir = "asc";

  const $ = id => document.getElementById(id);

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem("bdrTrackerFilters") || "{}"); }
    catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem("bdrTrackerFilters", JSON.stringify({
        timing: $("fTiming").value, status: $("fStatus").value, bdrEmail: $("fBdrEmail").value, sortDir
      }));
    } catch (e) { /* storage unavailable; filters just won't persist */ }
  }

  // Today's calendar date in Pacific, as YYYY-MM-DD.
  function todayPacific() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date());
  }

  function dateToUtcMs(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function daysUntil(meetingDate, today) {
    if (!meetingDate) return null;
    return Math.round((dateToUtcMs(meetingDate) - dateToUtcMs(today)) / DAY_MS);
  }

  function fmtMeeting(m) {
    if (!m.meetingDate) return "—";
    const [y, mo, d] = m.meetingDate.split("-").map(Number);
    const datePart = new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-US",
      { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
    if (!m.meetingAt) return datePart;
    const timePart = new Date(m.meetingAt).toLocaleTimeString("en-US",
      { timeZone: TZ, hour: "numeric", minute: "2-digit" });
    return datePart + " · " + timePart + " PT";
  }

  function fmtShortDate(iso) {
    return new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
  }

  function daysLabel(n) {
    if (n === null) return "—";
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n > 0) return n + " days";
    if (n === -1) return "Yesterday";
    return Math.abs(n) + " days ago";
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function emailCell(email, days) {
    const td = el("td");
    if (email) {
      const pill = el("span", "pill ok", "Sent " + fmtShortDate(email.sentAt));
      if (email.subject) pill.title = email.subject;
      td.appendChild(pill);
    } else if (days !== null && days >= 0) {
      td.appendChild(el("span", "pill warn", "Not yet"));
    } else {
      td.appendChild(el("span", "pill muted", "None"));
    }
    return td;
  }

  const STATUS_LABEL = { booked: "Booked", held: "Held", no_show: "No show" };

  // Default order: upcoming meetings soonest first, then past meetings most
  // recent first. Descending reverses the whole list.
  function sortKey(days) {
    if (days === null) return Number.MAX_SAFE_INTEGER;
    return days >= 0 ? days : 100000 - days;
  }

  // For the this-week stat, Timing and BDR-email filters are ignored: it still
  // counts earlier days of the week under "Upcoming", and a sent/not-sent
  // filter would pin its rate at 100% or 0%.
  function filtered(today, forWeekStat) {
    const timing = forWeekStat ? "all" : $("fTiming").value;
    const bdrEmail = forWeekStat ? "all" : $("fBdrEmail").value;
    const status = $("fStatus").value;
    const bdr = $("fBdr").value;
    const ae = $("fAe").value;
    const q = $("fSearch").value.trim().toLowerCase();
    return meetings
      .map(m => Object.assign({}, m, { days: daysUntil(m.meetingDate, today) }))
      .filter(m => {
        if (timing === "upcoming" && !(m.days !== null && m.days >= 0)) return false;
        if (timing === "past" && !(m.days !== null && m.days < 0)) return false;
        if (status !== "all" && m.status !== status) return false;
        if (bdrEmail === "sent" && !m.bdrIntroEmail) return false;
        if (bdrEmail === "not_sent" && m.bdrIntroEmail) return false;
        if (bdr !== "all" && m.bdrName !== bdr) return false;
        if (ae !== "all" && m.aeName !== ae) return false;
        if (q && !(m.accountName || "").toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const diff = sortKey(a.days) - sortKey(b.days);
        return sortDir === "asc" ? diff : -diff;
      });
  }

  // Monday..Sunday (Pacific) of the week containing `today`, as day offsets.
  function thisWeekRange(today) {
    const dow = new Date(dateToUtcMs(today)).getUTCDay();
    const start = -((dow + 6) % 7);
    return { start, end: start + 6 };
  }

  function weekLabel(today, range) {
    const fmt = offset => new Date(dateToUtcMs(today) + offset * DAY_MS)
      .toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
    return fmt(range.start) + "–" + fmt(range.end);
  }

  function renderStats(rows, today) {
    const stats = $("stats");
    stats.textContent = "";
    const upcoming = rows.filter(m => m.days !== null && m.days >= 0);
    const scope = upcoming.length ? upcoming : rows;
    const scopeLabel = upcoming.length ? "upcoming" : "shown";
    const bdrSent = scope.filter(m => m.bdrIntroEmail).length;
    const aeSent = scope.filter(m => m.aeIntroEmail).length;
    const pct = (n, d) => d ? Math.round((n / d) * 100) + "%" : "—";
    const range = thisWeekRange(today);
    const thisWeek = filtered(today, true).filter(m => m.days !== null && m.days >= range.start && m.days <= range.end);
    const weekSent = thisWeek.filter(m => m.bdrIntroEmail).length;
    [
      ["BDR intro sent · meetings this week (" + weekLabel(today, range) + ")",
        pct(weekSent, thisWeek.length) + " · " + weekSent + " of " + thisWeek.length],
      ["Meetings shown", String(rows.length)],
      ["Next 7 days", String(rows.filter(m => m.days !== null && m.days >= 0 && m.days <= 7).length)],
      ["BDR intro sent (" + scopeLabel + ")", bdrSent + " · " + pct(bdrSent, scope.length)],
      ["AE follow-up sent (" + scopeLabel + ")", aeSent + " · " + pct(aeSent, scope.length)],
      ["Held", String(rows.filter(m => m.status === "held").length)]
    ].forEach(([label, value]) => {
      const card = el("div", "stat");
      card.appendChild(el("div", "stat-value", value));
      card.appendChild(el("div", "stat-label", label));
      stats.appendChild(card);
    });
  }

  function render() {
    const today = todayPacific();
    const rows = filtered(today);
    const tbody = $("rows");
    tbody.textContent = "";
    rows.forEach(m => {
      const tr = el("tr");

      const acct = el("td", "acct");
      acct.appendChild(el("div", "acct-name", m.accountName));
      if (m.bookedAt) acct.appendChild(el("div", "sub", "Booked " + fmtShortDate(m.bookedAt)));
      tr.appendChild(acct);

      tr.appendChild(el("td", "nowrap", m.bdrName || "—"));
      tr.appendChild(el("td", "nowrap", m.aeName || "—"));
      tr.appendChild(el("td", "nowrap", fmtMeeting(m)));

      const days = el("td", "days nowrap", daysLabel(m.days));
      if (m.days !== null && m.days < 0) days.classList.add("past");
      tr.appendChild(days);

      tr.appendChild(emailCell(m.bdrIntroEmail, m.days));
      tr.appendChild(emailCell(m.aeIntroEmail, m.days));

      const st = el("td");
      st.appendChild(el("span", "status " + m.status, STATUS_LABEL[m.status] || m.status));
      if (m.stage) st.title = "Stage: " + m.stage;
      tr.appendChild(st);

      tbody.appendChild(tr);
    });
    $("empty").hidden = rows.length > 0;
    renderStats(rows, today);
    $("sortArrow").textContent = sortDir === "asc" ? "↑" : "↓";
    $("sortDays").setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
  }

  function fillSelect(select, values) {
    const current = select.value;
    while (select.options.length > 1) select.remove(1);
    values.forEach(v => select.appendChild(new Option(v, v)));
    if (values.includes(current)) select.value = current;
  }

  async function load() {
    try {
      const res = await fetch("/api/meetings", { cache: "no-store" });
      const data = await res.json();
      meetings = data.meetings || [];
      $("asOf").textContent = data.asOf
        ? "Salesforce as of " + new Date(data.asOf).toLocaleString("en-US",
            { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT"
        : "Waiting for the first Salesforce sync";
      const uniq = key => Array.from(new Set(meetings.map(m => m[key]).filter(Boolean))).sort();
      fillSelect($("fBdr"), uniq("bdrName"));
      fillSelect($("fAe"), uniq("aeName"));
      render();
    } catch (e) {
      $("asOf").textContent = "Couldn't load meetings. Refresh to try again.";
    }
  }

  const prefs = readPrefs();
  if (prefs.timing) $("fTiming").value = prefs.timing;
  if (prefs.status) $("fStatus").value = prefs.status;
  if (prefs.bdrEmail) $("fBdrEmail").value = prefs.bdrEmail;
  if (prefs.sortDir === "desc") sortDir = "desc";

  ["fTiming", "fStatus", "fBdrEmail", "fBdr", "fAe"].forEach(id => $(id).addEventListener("change", () => { savePrefs(); render(); }));
  $("fSearch").addEventListener("input", render);
  $("sortDays").querySelector("button").addEventListener("click", () => {
    sortDir = sortDir === "asc" ? "desc" : "asc";
    savePrefs();
    render();
  });

  load();
})();
