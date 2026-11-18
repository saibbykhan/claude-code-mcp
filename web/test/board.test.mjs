import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { RunStore } from "../../dist/src/runStore.js";
import { TaskStore } from "../../dist/src/taskStore.js";
import { TaskSummarizer } from "../lib/boardSummary.mjs";
import { createWebServer } from "../server.mjs";

const TOKEN = "d".repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-board-"));
const taskStore = new TaskStore(dir);
const runStore = new RunStore(dir);
let server;
let port;
let summarizeCalls = 0;

function open(p, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, resolve);
    req.on("error", reject);
    req.end(body);
  });
}
async function request(p, opts) {
  const res = await open(p, opts);
  let text = "";
  for await (const d of res) text += d;
  return { status: res.statusCode, text, headers: res.headers };
}
const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  const probe = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  port = probe.address().port;
  await new Promise((r) => probe.close(r));
  server = createWebServer({
    port, token: TOKEN, callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
    summarize: async () => { summarizeCalls++; throw new Error("model down"); },
    taskStore, runStore, tickMs: 50,
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
});
after(() => server.close());

test("task routes need the token, a local Host and a same-origin Origin (JSON and SSE)", async () => {
  for (const p of ["/api/tasks", "/api/tasks/stream"]) {
    assert.equal((await request(p)).status, 401, p);
    assert.equal((await request(p, { headers: { authorization: "Bearer wrong" } })).status, 401, p);
    assert.equal((await request(p, { headers: { ...auth, host: "evil.com" } })).status, 403, p);
    assert.equal((await request(p, { headers: { ...auth, origin: "http://evil.com" } })).status, 403, p);
  }
  const pin = await request("/api/task/pin", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(pin.status, 401);
  const pinBad = await request("/api/task/pin", { method: "POST", headers: { ...auth, "content-type": "application/json", origin: "http://evil.com" }, body: "{}" });
  assert.equal(pinBad.status, 403);
});

test("the SSE stream sends the snapshot, then pushes changes, masked", async () => {
  const res = await open("/api/tasks/stream", { headers: auth });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  assert.match(res.headers["content-security-policy"], /default-src 'self'/);
  let buf = "";
  const waitFor = (re) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re}; got: ${buf}`)), 3000);
    const check = () => { if (re.test(buf)) { clearTimeout(t); resolve(); } };
    res.on("data", (d) => { buf += d; check(); });
    check();
  });
  await waitFor(/event: tasks\ndata: \{"tasks":\[\]/);
  const secret = ["sk-", "ant-", "q".repeat(30)].join("");
  taskStore.create({ prompt: `deploy ${secret}`, folder: "/tmp/p", project: "p", state: "queued" });
  await waitFor(/"state":"queued"/);
  assert.ok(!buf.includes(secret));
  res.destroy();
});

test("polling fallback returns the same tasks and honours pin", async () => {
  const before = JSON.parse((await request("/api/tasks", { headers: auth })).text);
  assert.equal(before.tasks.length, 1);
  assert.equal(typeof before.fadeAfterMs, "number");
  const id = before.tasks[0].id;
  const ok = await request("/api/task/pin", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ taskId: id, pinned: true }) });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse((await request("/api/tasks", { headers: auth })).text).tasks[0].pinned, true);
  const bad = await request("/api/task/pin", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ taskId: id, pinned: "yes" }) });
  assert.equal(bad.status, 400);
  const none = await request("/api/task/pin", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ taskId: "nope", pinned: true }) });
  assert.equal(none.status, 404);
});

test("when the summarizer fails the card keeps its last good text and the board still answers", async () => {
  const t = taskStore.create({ prompt: "second", folder: "/tmp/p", project: "p", runId: "run-s", state: "running" });
  taskStore.update(t.id, { summary: "Reading the config files" });
  runStore.create({ id: "run-s", folder: "/tmp/p", project: "p", promptPreview: "x", model: null, permissionMode: "plan", continueSessionId: null, forked: false, sessionId: null, status: "running", pid: process.pid, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, error: null });
  runStore.appendOutput("run-s", "[assistant] working\n");
  const r = await request("/api/tasks", { headers: auth }); // tick runs the summarizer in the background
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 150));
  assert.ok(summarizeCalls >= 1, "summarizer was attempted");
  assert.equal(taskStore.get(t.id).summary, "Reading the config files");
});

test("TaskSummarizer: failure keeps the last text, backs off, never overlaps; success updates", async () => {
  const saved = new Map([["t1", "last good"]]);
  let now = 1_000_000;
  let fail = true;
  let calls = 0;
  const s = new TaskSummarizer({
    summarize: async () => { calls++; if (fail) throw new Error("boom"); return { summary: "new text" }; },
    getText: () => "x".repeat(10),
    save: (id, line) => saved.set(id, line),
    now: () => now,
  });
  const task = { id: "t1", runId: "r", state: "running" };
  await s.consider([task]);
  assert.equal(calls, 1);
  assert.equal(saved.get("t1"), "last good");
  now += 5_000;
  assert.equal(s.consider([{ ...task, state: "done" }]), undefined, "backs off after a failure");
  now += 61_000;
  fail = false;
  await s.consider([{ ...task, state: "done" }]);
  assert.equal(saved.get("t1"), "new text");
  let release;
  const slow = new TaskSummarizer({ summarize: () => new Promise((r) => (release = r)), getText: () => "abc", save() {}, now: () => now });
  const p = slow.consider([{ id: "a", runId: "1", state: "running" }]);
  assert.equal(slow.consider([{ id: "b", runId: "2", state: "running" }]), undefined, "one call at a time");
  release({ summary: "ok" });
  await p;
  const empty = new TaskSummarizer({ summarize: async () => ({ summary: "  " }), getText: () => "abc", save: (i, l) => saved.set(i, l), now: () => now });
  saved.set("t9", "keep");
  await empty.consider([{ id: "t9", runId: "1", state: "running" }]);
  assert.equal(saved.get("t9"), "keep", "an empty summary is a failure");
});
