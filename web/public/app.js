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
  for (const t of ["chat", "tasks", "runs", "usage", "folders"]) $(`tab-${t}`).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === "runs") loadRuns();
  if (b.dataset.tab === "usage") loadUsage();
  if (b.dataset.tab === "folders") loadFolders();
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
let shownInfo = null; // { project, sessionId } of the run in the viewer, used by the reply box
const loadRuns = guard(async () => {
  const d = await api(`/api/runs?limit=50${$("active-only").checked ? "&activeOnly=true" : ""}`);
  $("runs").replaceChildren(...d.runs.map((r) => {
    const tr = el("tr");
    tr.append(el("td", r.status), el("td", r.project), el("td", when(r.startedAt)), el("td", r.promptPreview || ""));
    const td = el("td");
    const view = el("button", "Output"); view.addEventListener("click", () => showRun(r.runId, { project: r.project }));
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
const showRun = guard(async (runId, info) => {
  if (shownRun !== runId) $("reply").value = "";
  shownRun = runId;
  if (info) shownInfo = { ...shownInfo, ...info };
  const d = await api(`/api/output?runId=${runId}&maxChars=100000`);
  shownInfo = { ...shownInfo, sessionId: d.sessionId || shownInfo?.sessionId };
  const pre = $("run-output");
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  $("run-title").textContent = `Run ${runId.slice(0, 8)} – ${d.status}`;
  pre.textContent = d.output;
  if (atEnd) pre.scrollTop = pre.scrollHeight;
  $("run-stop").hidden = d.status !== "running";
  $("reply-form").hidden = d.status === "running" || !shownInfo?.sessionId || !shownInfo?.project;
});
$("run-stop").addEventListener("click", guard(async () => { await api("/api/stop", { runId: shownRun }); await showRun(shownRun); }));
$("reply-form").addEventListener("submit", guard(async (ev) => {
  ev.preventDefault();
  const run = await api("/api/run", { folder: shownInfo.project, prompt: $("reply").value, continueSessionId: shownInfo.sessionId, fork: false, permissionMode: $("reply-mode").value });
  $("reply").value = "";
  await showRun(run.runId);
}));
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

// ---- tasks board (live over Server-Sent Events, polling as the fallback)
const DAY = 24 * 3600 * 1000;
const LABEL = { queued: "Queued", running: "Running", waiting_for_you: "Waiting for you", done: "Done", failed: "Failed", stopped: "Stopped" };
const ACTIVE = ["queued", "running", "waiting_for_you"];
let board = { tasks: [], fadeAfterMs: 600000, skew: 0 };
let knownStates = null; // null until the first snapshot, so opening the page does not fire a notification storm
const elapsedEls = new Map();

const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const serverNow = () => Date.now() + board.skew;
const elapsedOf = (t) => (t.finishedAt ? new Date(t.finishedAt) : serverNow()) - new Date(t.createdAt);

function card(t) {
  const finished = !ACTIVE.includes(t.state);
  const fade = finished && !t.pinned && serverNow() - new Date(t.finishedAt || t.updatedAt) > board.fadeAfterMs;
  const c = el("div", "", { className: `card state-${t.state}${t.pinned ? " pinned" : ""}${fade ? " faded" : ""}`, tabIndex: 0 });
  c.setAttribute("role", "button");
  const pin = el("button", t.pinned ? "Unpin" : "Pin", { className: "pin", title: "Keep this card at the top" });
  pin.addEventListener("click", guard(async (ev) => { ev.stopPropagation(); await api("/api/task/pin", { taskId: t.id, pinned: !t.pinned }); }));
  const meta = el("div", "", { className: "meta" });
  const elapsed = el("span", fmtElapsed(elapsedOf(t)));
  if (!t.finishedAt) elapsedEls.set(elapsed, t);
  meta.append(el("span", LABEL[t.state], { className: "state" }), elapsed, el("span", t.project || t.folder, { title: t.folder }));
  c.append(pin, el("h3", t.prompt || "(no prompt)"), meta);
  const line = t.error && t.state === "failed" ? t.error : t.summary || t.latest;
  if (line) c.append(el("div", line, { className: "update" }));
  const open = () => openTask(t);
  c.addEventListener("click", open);
  c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  return c;
}

function openTask(t) {
  document.querySelector('nav button[data-tab="runs"]').click();
  if (t.runId) showRun(t.runId, { project: t.project, sessionId: t.sessionId });
}

function renderBoard() {
  elapsedEls.clear();
  const byNewest = (a, b) => b.createdAt.localeCompare(a.createdAt);
  const rank = (t) => (t.pinned ? 0 : t.state === "waiting_for_you" ? 1 : 2);
  const active = board.tasks.filter((t) => ACTIVE.includes(t.state) || t.pinned).sort((a, b) => rank(a) - rank(b) || byNewest(a, b));
  const recent = board.tasks.filter((t) => !active.includes(t) && serverNow() - new Date(t.finishedAt || t.updatedAt) < DAY).sort(byNewest);
  $("board-active").replaceChildren(...(active.length ? active.map(card) : [el("p", "Nothing active right now.")]));
  $("board-recent").replaceChildren(...recent.map(card));
  const waiting = board.tasks.filter((t) => t.state === "waiting_for_you").length;
  $("badge").hidden = !waiting;
  $("badge").textContent = String(waiting);
  document.title = `${waiting ? `(${waiting}) ` : ""}Claude Code – local`;
}

function notifyNewWaiting(tasks) {
  const states = new Map(tasks.map((t) => [t.id, t.state]));
  if (knownStates) {
    for (const t of tasks) {
      if (t.state === "waiting_for_you" && knownStates.get(t.id) !== "waiting_for_you" && "Notification" in window && Notification.permission === "granted") {
        try { new Notification("Claude is waiting for you", { body: t.prompt.slice(0, 120) }); } catch { /* ignore */ }
      }
    }
  }
  knownStates = states;
}

function applySnapshot(d) {
  board = { tasks: d.tasks, fadeAfterMs: d.fadeAfterMs, skew: new Date(d.serverTime) - Date.now() };
  notifyNewWaiting(d.tasks);
  renderBoard();
  if (!$("tab-runs").hidden && shownRun) showRun(shownRun);
}

setInterval(() => { for (const [span, t] of elapsedEls) span.textContent = fmtElapsed(elapsedOf(t)); }, 1000);

if ("Notification" in window && Notification.permission === "default") {
  $("enable-notify").hidden = false;
  $("enable-notify").addEventListener("click", async () => { await Notification.requestPermission(); $("enable-notify").hidden = Notification.permission !== "default"; });
}

// Stream with fetch (not EventSource) so the token stays in the Authorization header, never in a URL.
async function liveBoard() {
  for (;;) {
    try {
      const res = await fetch("/api/tasks/stream", { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      $("live-state").textContent = "Live";
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (block.includes("event: tasks") && data) applySnapshot(JSON.parse(data));
        }
      }
    } catch { /* fall through to polling */ }
    $("live-state").textContent = "Reconnecting (polling)…";
    for (let n = 0; n < 5; n++) { // polling fallback while the stream is down
      try { applySnapshot(await api("/api/tasks")); } catch { /* keep trying */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
liveBoard();

// ---- folders
const loadFolders = guard(async () => {
  const d = await api("/api/folders");
  $("folders-config").textContent = `Config: ${d.configPath}`;
  $("folders").replaceChildren(...(d.folders.length ? d.folders.map((f) => {
    const tr = el("tr");
    const rm = el("button", "Remove");
    rm.addEventListener("click", guard(async () => {
      if (!confirm(`Remove "${f.name}" from the approved list? Files on disk are not touched.`)) return;
      await api("/api/folders/remove", { name: f.name });
      await loadFolders();
      await loadProjects();
    }));
    const td = el("td"); td.append(rm);
    tr.append(el("td", f.name), el("td", f.exists ? f.path : `${f.path} (missing)`), td);
    return tr;
  }) : [(() => { const tr = el("tr"); tr.append(el("td", "No approved folders yet.", { colSpan: 3 })); return tr; })()]));
});

function showFolderForm(p) {
  $("folder-form").hidden = false;
  $("folder-path").value = p || "";
  $("folder-name").value = p ? p.split("/").filter(Boolean).pop() || "" : "";
  $("folder-path").focus();
}
$("add-folder").addEventListener("click", guard(async () => {
  $("choose-note").textContent = "Waiting for the macOS folder chooser…";
  try {
    const d = await api("/api/folders/choose", {});
    if (d.path) showFolderForm(d.path);
    else $("choose-note").textContent = "Cancelled.";
    if (d.path) $("choose-note").textContent = "Check the name, then press Add.";
  } catch (e) {
    $("choose-note").textContent = "";
    showFolderForm("");
    throw e; // shows the banner; the path field stays available as the fallback
  }
}));
$("folder-path").addEventListener("input", () => {
  if (!$("folder-name").dataset.touched) $("folder-name").value = $("folder-path").value.split("/").filter(Boolean).pop() || "";
});
$("folder-name").addEventListener("input", () => { $("folder-name").dataset.touched = "1"; });
$("folder-cancel").addEventListener("click", () => { $("folder-form").hidden = true; $("choose-note").textContent = ""; });
$("folder-form").addEventListener("submit", guard(async (ev) => {
  ev.preventDefault();
  await api("/api/folders/add", { path: $("folder-path").value, name: $("folder-name").value });
  $("folder-form").hidden = true;
  $("choose-note").textContent = "Added.";
  delete $("folder-name").dataset.touched;
  await loadFolders();
  await loadProjects();
}));
