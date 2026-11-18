import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunStore, type RunRecord } from "../src/runStore.js";
import { canTransition, detectWaiting, latestUpdate, TASK_STATES, TaskStore, type TaskState } from "../src/taskStore.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-tasks-"));
const FAKE_KEY = ["sk-", "ant-", "z".repeat(30)].join("");
const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, folder: "/tmp/p", project: "p", promptPreview: "hi", model: null, permissionMode: "plan",
  continueSessionId: null, forked: false, sessionId: null, status: "running", pid: process.pid,
  startedAt: new Date().toISOString(), endedAt: null, exitCode: null, error: null, ...over,
});

test("state machine allows the documented moves and rejects the rest", () => {
  const ok: [TaskState, TaskState][] = [
    ["queued", "running"], ["queued", "failed"], ["running", "waiting_for_you"], ["running", "done"],
    ["running", "failed"], ["running", "stopped"], ["waiting_for_you", "running"], ["done", "running"], ["failed", "running"], ["stopped", "running"],
  ];
  for (const [a, b] of ok) assert.ok(canTransition(a, b), `${a} -> ${b}`);
  const bad: [TaskState, TaskState][] = [["done", "failed"], ["done", "waiting_for_you"], ["stopped", "done"], ["queued", "done"], ["failed", "done"]];
  for (const [a, b] of bad) assert.ok(!canTransition(a, b), `${a} -> ${b}`);
  for (const s of TASK_STATES) assert.ok(canTransition(s, s));
});

test("create, transition with finished time, reopen on reply, persist with mode 600", () => {
  const dir = tmp();
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const s = new TaskStore(dir, () => new Date(clock));
  const t = s.create({ prompt: `fix it ${FAKE_KEY}`, folder: "/tmp/p", project: "p" });
  assert.equal(t.state, "queued");
  assert.ok(!t.prompt.includes(FAKE_KEY), "prompt is masked");
  clock += 5000;
  assert.equal(s.transition(t.id, "running", { runId: "r1" })?.runId, "r1");
  assert.equal(s.get(t.id)?.finishedAt, null);
  clock += 5000;
  const done = s.transition(t.id, "done");
  assert.equal(done?.finishedAt, "2026-01-01T00:00:10.000Z");
  assert.throws(() => s.transition(t.id, "failed"), /Invalid task transition done -> failed/);
  const reopened = s.transition(t.id, "running", { runId: "r2" });
  assert.equal(reopened?.finishedAt, null);
  assert.equal(new TaskStore(dir).get(t.id)?.runId, "r2");
  assert.equal(fs.statSync(path.join(dir, "tasks.json")).mode & 0o077, 0);
  assert.equal(s.transition("nope", "running"), undefined);
});

test("waiting-for-you detection looks at the closing assistant message only", () => {
  assert.equal(detectWaiting("[assistant] Done. All tests pass.\n[result] success\n[final] Done. All tests pass.\n"), false);
  assert.equal(detectWaiting("[assistant] I found two options.\n[final] I found two options. Which one do you prefer?\n"), true);
  assert.equal(detectWaiting("[final] Plan ready. Let me know if I should proceed with the edits.\n"), true);
  assert.equal(detectWaiting("[assistant] Should I continue?\n[tool_use] Read {}\n[assistant] Finished the refactor.\n"), false);
  assert.equal(detectWaiting("[tool_result] Do you want this?\n[assistant] ok.\n"), false, "tool output is not a question to the person");
  assert.equal(detectWaiting(""), false);
  assert.equal(latestUpdate("[assistant] one\n[tool_use] Edit {\"f\":1}\n"), 'Working: Edit {"f":1}');
});

test("reconcile derives running / waiting_for_you / done / failed / stopped from runs", () => {
  const dir = tmp();
  const runs = new RunStore(dir);
  const tasks = new TaskStore(dir);
  const mk = (id: string, status: RunRecord["status"], out: string, extra: Partial<RunRecord> = {}) => {
    runs.create(run(id, { status, endedAt: status === "running" ? null : "2026-01-01T00:00:09.000Z", ...extra }));
    runs.appendOutput(id, out);
    return tasks.create({ prompt: id, folder: "/tmp/p", project: "p", runId: id, state: "running" });
  };
  const a = mk("run-a", "running", "[assistant] working on it\n");
  const b = mk("run-b", "completed", "[final] Which file should I change?\n", { sessionId: "11111111-1111-4111-8111-111111111111" });
  const c = mk("run-c", "completed", "[final] All done.\n");
  const d = mk("run-d", "failed", "", { error: "exit code 1" });
  const e = mk("run-e", "stopped", "");
  assert.equal(tasks.reconcile(runs), true);
  const state = (id: string) => tasks.get(id)?.state;
  assert.deepEqual([a, b, c, d, e].map((t) => state(t.id)), ["running", "waiting_for_you", "done", "failed", "stopped"]);
  assert.equal(tasks.get(a.id)?.latest, "working on it");
  assert.equal(tasks.get(b.id)?.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(tasks.get(c.id)?.finishedAt, "2026-01-01T00:00:09.000Z");
  assert.equal(tasks.reconcile(runs), false, "second pass changes nothing");
  // the run finishes later
  runs.update("run-a", { status: "completed", endedAt: new Date().toISOString() });
  runs.appendOutput("run-a", "[final] Finished.\n");
  tasks.reconcile(runs);
  assert.equal(state(a.id), "done");
});

test("a blank summary never replaces the last good one; pin persists", () => {
  const s = new TaskStore(tmp());
  const t = s.create({ prompt: "x", folder: "/f", project: "p" });
  s.update(t.id, { summary: "Fixing the login bug" });
  s.update(t.id, { summary: "   " });
  assert.equal(s.get(t.id)?.summary, "Fixing the login bug");
  s.update(t.id, { summary: `see ${FAKE_KEY}` });
  assert.ok(!s.get(t.id)?.summary.includes(FAKE_KEY));
  s.update(t.id, { pinned: true });
  assert.equal(s.get(t.id)?.pinned, true);
});
