// Vanilla JS. Everything from the server is untrusted text: only textContent is ever used, never innerHTML.
const token = document.querySelector('meta[name="token"]').content;
history.replaceState(null, "", "/"); // keep the token out of the address bar / history
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const opts = { headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const banner = (msg) => { $("banner").hidden = !msg; $("banner").textContent = msg || ""; };
const guard = (fn) => async (...a) => { try { banner(""); await fn(...a); } catch (e) { banner(e.message); } };
const el = (tag, text, attrs = {}) => Object.assign(document.createElement(tag), { textContent: text ?? "" }, attrs);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "–");

// ---- tabs
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
  for (const t of ["chat", "runs", "usage"]) $(`tab-${t}`).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === "runs") loadRuns();
  if (b.dataset.tab === "usage") loadUsage();
}));

// ---- chat state
let current = { runId: null, sessionId: null, since: 0, timer: null };
const folder = () => $("project").value;

const loadProjects = guard(async () => {
  const d = await api("/api/projects");
  $("project").replaceChildren(...d.projects.map((p) => el("option", p.name, { value: p.name, disabled: !p.exists })));
  if (d.configError) banner(d.configError);
  await loadSessions();
});

const loadSessions = guard(async () => {
  if (!folder()) return;
  const d = await api(`/api/sessions?folder=${encodeURIComponent(folder())}&limit=30`);
  $("sessions").replaceChildren(...d.sessions.map((s) => {
    const li = el("li", s.firstPrompt || "(no prompt)");
    li.append(el("small", `${when(s.lastActivityAt)} · ${s.messageCount} msgs`));
    li.addEventListener("click", () => openSession(s.sessionId, li));
    return li;
  }));
});

const openSession = guard(async (sessionId, li) => {
  stopPolling();
  document.querySelectorAll("#sessions li").forEach((x) => x.classList.toggle("sel", x === li));
  const d = await api(`/api/tail?folder=${encodeURIComponent(folder())}&sessionId=${sessionId}&turns=10&maxCharsPerMessage=4000`);
  current = { runId: null, sessionId, since: 0, timer: null };
  $("convo-title").textContent = `Session ${sessionId.slice(0, 8)}… (next prompt continues it)`;
  $("output").textContent = d.turns.map((t) => `> ${t.user}\n\n${t.assistant}`).join("\n\n────────\n\n");
  $("simple-text").textContent = "";
});

function stopPolling() { clearTimeout(current.timer); $("stop-current").hidden = true; }

async function poll() {
  try {
    const d = await api(`/api/output?runId=${current.runId}&sinceChars=${current.since}&maxChars=50000`);
    if (d.output) { $("output").textContent += d.output; $("output").scrollTop = $("output").scrollHeight; }
    current.since = d.nextChars;
    if (d.sessionId) current.sessionId = d.sessionId;
    if (d.more || d.status === "running") return void (current.timer = setTimeout(poll, d.more ? 0 : 1000));
    $("stop-current").hidden = true;
    $("convo-title").textContent = `Run ${d.status}`;
    loadSessions();
  } catch (e) { banner(e.message); stopPolling(); }
}

$("prompt-form").addEventListener("submit", guard(async (ev) => {
  ev.preventDefault();
  stopPolling();
  const body = { folder: folder(), prompt: $("prompt").value, permissionMode: $("mode").value, model: $("model").value.trim() };
  if (current.sessionId) { body.continueSessionId = current.sessionId; body.fork = false; }
  const run = await api("/api/run", body);
  current = { runId: run.runId, sessionId: current.sessionId, since: 0, timer: null };
  $("output").textContent = `> ${$("prompt").value}\n\n`;
  $("prompt").value = "";
  $("convo-title").textContent = "Running…";
  $("stop-current").hidden = false;
  poll();
}));
$("stop-current").addEventListener("click", guard(async () => { await api("/api/stop", { runId: current.runId }); }));
$("new-convo").addEventListener("click", () => { stopPolling(); current = { runId: null, sessionId: null, since: 0, timer: null }; $("output").textContent = ""; $("simple-text").textContent = ""; $("convo-title").textContent = "New conversation"; });
$("reload-sessions").addEventListener("click", loadSessions);
$("project").addEventListener("change", loadSessions);

// ---- simplified view (summary made locally by the configured cheap model)
const summarize = guard(async () => {
  if (!$("simple-toggle").checked) { $("simple-text").textContent = ""; return; }
  const body = current.runId ? { runId: current.runId } : current.sessionId ? { folder: folder(), sessionId: current.sessionId } : null;
  if (!body) { $("simple-text").textContent = "Nothing to summarize yet."; return; }
  $("simple-text").textContent = "Summarizing…";
  $("simple-text").textContent = (await api("/api/summarize", body)).summary;
});
$("simple-toggle").addEventListener("change", summarize);
$("simple-refresh").addEventListener("click", summarize);

// ---- runs
let shownRun = null;
const loadRuns = guard(async () => {
  const d = await api(`/api/runs?limit=50${$("active-only").checked ? "&activeOnly=true" : ""}`);
  $("runs").replaceChildren(...d.runs.map((r) => {
    const tr = el("tr");
    tr.append(el("td", r.status), el("td", r.project), el("td", when(r.startedAt)), el("td", r.promptPreview || ""));
    const td = el("td");
    const view = el("button", "Output"); view.addEventListener("click", () => showRun(r.runId));
    td.append(view);
    if (r.status === "running") {
      const stop = el("button", "Stop");
      stop.addEventListener("click", guard(async () => { await api("/api/stop", { runId: r.runId }); await loadRuns(); }));
      td.append(stop);
    }
    tr.append(td);
    return tr;
  }));
});
const showRun = guard(async (runId) => {
  shownRun = runId;
  const d = await api(`/api/output?runId=${runId}&maxChars=100000`);
  $("run-title").textContent = `Run ${runId.slice(0, 8)} – ${d.status}`;
  $("run-output").textContent = d.output;
});
$("reload-runs").addEventListener("click", () => { loadRuns(); if (shownRun) showRun(shownRun); });
$("active-only").addEventListener("change", loadRuns);

// ---- usage
const loadUsage = guard(async () => {
  const d = await api("/api/usage");
  const box = $("usage");
  box.replaceChildren();
  const w = d.windows;
  if (!w.available) box.append(el("p", "No cached usage windows found."));
  else {
    box.append(el("p", `Last cached by Claude Code: ${when(w.fetchedAt)} (${w.ageMinutes} min ago)`));
    for (const [label, win] of [["5-hour", w.fiveHour], ["Weekly", w.weekly]]) {
      if (!win) continue;
      const pct = win.utilizationPercent;
      const bar = el("div", "", { className: "bar" });
      const fill = el("div"); fill.style.width = `${Math.min(100, pct ?? 0)}%`; bar.append(fill);
      box.append(el("h3", `${label}: ${pct ?? "?"}%${win.resetPassed ? " (stale – reset passed)" : ""}`), bar, el("small", `Resets ${when(win.resetsAt)}`));
    }
  }
  for (const n of d.notes) box.append(el("p", n, { className: "note" }));
});
$("reload-usage").addEventListener("click", loadUsage);

loadProjects();
