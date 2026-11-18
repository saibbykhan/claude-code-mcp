import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildClaudeArgs, renderStreamLine } from "../src/runner.js";
import { RunStore, type RunRecord } from "../src/runStore.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-store-"));
const rec = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, folder: "/tmp/p", project: "p", promptPreview: "hi", model: null, permissionMode: "plan",
  continueSessionId: null, forked: false, sessionId: null, status: "running", pid: 1,
  startedAt: new Date().toISOString(), endedAt: null, exitCode: null, error: null, ...over,
});

test("create, get, update, list newest first, persists across instances", () => {
  const dir = tmp();
  const s = new RunStore(dir);
  s.create(rec("a", { startedAt: "2026-01-01T00:00:00Z" }));
  s.create(rec("b", { startedAt: "2026-01-02T00:00:00Z" }));
  assert.deepEqual(s.list().map((r) => r.id), ["b", "a"]);
  assert.equal(s.update("a", { status: "completed", exitCode: 0 })?.status, "completed");
  assert.equal(s.update("nope", { status: "failed" }), undefined);
  const again = new RunStore(dir);
  assert.equal(again.get("a")?.exitCode, 0);
  assert.equal(again.activeCount(), 1);
  assert.equal(fs.statSync(path.join(dir, "runs.json")).mode & 0o077, 0);
});

test("reconcile marks dead running runs as interrupted", () => {
  const s = new RunStore(tmp());
  s.create(rec("alive", { pid: 111 }));
  s.create(rec("dead", { pid: 222 }));
  s.create(rec("done", { pid: null, status: "completed" }));
  s.reconcile((pid) => pid === 111);
  assert.equal(s.get("alive")?.status, "running");
  assert.equal(s.get("dead")?.status, "interrupted");
  assert.ok(s.get("dead")?.endedAt);
  assert.equal(s.get("done")?.status, "completed");
  assert.equal(s.activeCount(), 1);
});

test("output paging by character offset", () => {
  const s = new RunStore(tmp());
  s.create(rec("r"));
  assert.deepEqual(s.readOutput("r", 0, 10), { output: "", nextChars: 0, totalChars: 0, more: false });
  s.appendOutput("r", "hello ");
  s.appendOutput("r", "wörld!");
  const p1 = s.readOutput("r", 0, 5);
  assert.deepEqual(p1, { output: "hello", nextChars: 5, totalChars: 12, more: true });
  const p2 = s.readOutput("r", p1.nextChars, 100);
  assert.deepEqual(p2, { output: " wörld!", nextChars: 12, totalChars: 12, more: false });
  assert.deepEqual(s.readOutput("r", 999, 10), { output: "", nextChars: 12, totalChars: 12, more: false });
});

test("rejects run ids that could escape the output directory", () => {
  const s = new RunStore(tmp());
  assert.throws(() => s.outputPath("../x"));
  assert.throws(() => s.readOutput("a/b", 0, 1));
});

test("prunes old finished runs past the cap but keeps running ones", () => {
  const s = new RunStore(tmp());
  s.create(rec("keep-running", { startedAt: "2020-01-01T00:00:00.000Z" }));
  for (let i = 0; i < 205; i++) {
    s.create(rec(`f${i}`, { status: "completed", startedAt: new Date(Date.UTC(2021, 0, 1) + i * 1000).toISOString() }));
  }
  const all = s.list();
  assert.equal(all.length, 200);
  assert.ok(s.get("keep-running"));
  assert.equal(s.get("f0"), undefined);
  assert.ok(s.get("f204"));
});

test("buildClaudeArgs: plan default shape, resume and fork", () => {
  assert.deepEqual(buildClaudeArgs({ permissionMode: "plan", fork: true }), ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"]);
  const sid = "11111111-2222-3333-4444-555555555555";
  assert.deepEqual(buildClaudeArgs({ permissionMode: "acceptEdits", model: "sonnet", continueSessionId: sid, fork: true }).slice(5), ["acceptEdits", "--model", "sonnet", "--resume", sid, "--fork-session"]);
  assert.ok(!buildClaudeArgs({ permissionMode: "plan", continueSessionId: sid, fork: false }).includes("--fork-session"));
});

test("renderStreamLine renders events and captures the session id", () => {
  const init = renderStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m", permissionMode: "plan" }));
  assert.equal(init.sessionId, "s1");
  assert.match(init.text, /^\[system\] session s1 model m/);
  const a = renderStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read", input: { file_path: "/x" } }] } }));
  assert.equal(a.text, '[assistant] hi\n[tool_use] Read {"file_path":"/x"}\n');
  const r = renderStreamLine(JSON.stringify({ type: "result", subtype: "success", num_turns: 1, result: "done" }));
  assert.equal(r.text, "[result] success turns=1\n[final] done\n");
  assert.equal(renderStreamLine("not json").text, "[raw] not json\n");
  assert.equal(renderStreamLine("  ").text, "");
});
