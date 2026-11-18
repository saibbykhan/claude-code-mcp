#!/usr/bin/env node
// End-to-end smoke test over stdio with a FAKE claude binary (no model calls) and a
// throwaway data dir / claude home. Run after `npm run build`: `npm run smoke`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-smoke-")));
const project = path.join(tmp, "proj");
const home = path.join(tmp, "claude-home");
const sid = "11111111-2222-3333-4444-555555555555";
fs.mkdirSync(project);
const sessDir = path.join(home, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
fs.mkdirSync(sessDir, { recursive: true });
fs.writeFileSync(path.join(sessDir, `${sid}.jsonl`), [
  { type: "user", sessionId: sid, timestamp: "2026-01-01T10:00:00Z", message: { content: "hello from person@example.com" } },
  { type: "assistant", sessionId: sid, timestamp: "2026-01-01T10:00:02Z", message: { content: [{ type: "text", text: "hi there" }] } },
].map((o) => JSON.stringify(o)).join("\n"));
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ projects: [{ name: "proj", path: project }] }));

const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  CLAUDE_MCP_DATA_DIR: path.join(tmp, "data"), CLAUDE_MCP_CONFIG: path.join(tmp, "config.json"),
  CLAUDE_MCP_CLAUDE_HOME: home, CLAUDE_MCP_CLAUDE_JSON: path.join(tmp, "nope.json"),
  CLAUDE_MCP_CLAUDE_BIN: path.join(root, "scripts", "fake-claude.mjs"),
};
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/src/index.js")], env, stderr: "ignore" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), data: JSON.parse(r.content[0].text) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (runId, status) => {
  for (let i = 0; i < 100; i++) {
    const { data } = await call("claude_runs");
    if (data.runs.find((r) => r.runId === runId)?.status === status) return;
    await sleep(100);
  }
  throw new Error(`run ${runId} never reached ${status}`);
};

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
assert.deepEqual(tools, ["claude_projects", "claude_sessions", "claude_tail", "claude_run", "claude_runs", "claude_output", "claude_stop", "claude_usage"]);

assert.equal((await call("claude_projects")).data.projects[0].path, project);
const sessions = (await call("claude_sessions", { folder: "proj" })).data.sessions;
assert.equal(sessions.length, 1);
assert.equal(sessions[0].sessionId, sid);
assert.equal(sessions[0].firstPrompt, "hello from p***@example.com");
assert.equal(sessions[0].messageCount, 2);
assert.equal((await call("claude_tail", { folder: project, sessionId: sid })).data.turns[0].assistant, "hi there");
assert.ok((await call("claude_sessions", { folder: "/etc" })).isError, "unapproved folder must be refused");
assert.ok((await call("claude_tail", { folder: "proj", sessionId: "../../x" })).isError);

assert.ok((await call("claude_run", { folder: "proj", prompt: "x", permissionMode: "bypassPermissions" })).isError, "bypass must be refused");
assert.ok((await call("claude_run", { folder: "proj", prompt: "x", permissionMode: "auto" })).isError);
assert.ok((await call("claude_run", { folder: "/tmp", prompt: "x" })).isError);

const run = (await call("claude_run", { folder: "proj", prompt: "ping", continueSessionId: sid, model: "haiku" })).data;
assert.equal(run.permissionMode, "plan");
assert.equal(run.forked, true);
await waitFor(run.runId, "completed");
{ // the run created a task on the board
  const tasks = JSON.parse(fs.readFileSync(path.join(tmp, "data", "tasks.json"), "utf8")).tasks;
  const t = tasks.find((x) => x.runId === run.runId);
  assert.ok(t && t.id === run.taskId && t.state === "running" && t.prompt === "ping", "claude_run creates a task");
}
const out = (await call("claude_output", { runId: run.runId })).data;
assert.match(out.output, /--permission-mode plan --model haiku --resume \S+ --fork-session/);
assert.match(out.output, /echo: ping key=\[MASKED\] mail s\*\*\*@example\.com/);
assert.ok(!out.output.includes("sk-ant-"));
assert.equal(out.sessionId, "99999999-8888-7777-6666-555555555555");
const page1 = (await call("claude_output", { runId: run.runId, maxChars: 10 })).data;
assert.equal(page1.nextChars, 10);
assert.equal(page1.more, true);
const page2 = (await call("claude_output", { runId: run.runId, sinceChars: page1.nextChars })).data;
assert.equal(page1.output + page2.output, out.output);

const ids = [];
for (let i = 0; i < 6; i++) ids.push((await call("claude_run", { folder: "proj", prompt: "SLEEP", permissionMode: "acceptEdits" })).data.runId);
const seventh = await call("claude_run", { folder: "proj", prompt: "SLEEP" });
assert.ok(seventh.isError && /Concurrency limit/.test(seventh.data.error), "7th concurrent run must be refused");
assert.equal((await call("claude_runs", { activeOnly: true })).data.active, 6);
assert.equal((await call("claude_stop", { runId: ids[0] })).data.stopped, true);
await waitFor(ids[0], "stopped");
assert.equal((await call("claude_stop", { runId: ids[0] })).data.stopped, false);

const usage = (await call("claude_usage")).data;
assert.equal(usage.windows.available, false);
assert.equal(usage.stats.available, false);

await client.close(); // closing stdin must end the remaining 5 runs
await sleep(1500);
const runs = JSON.parse(fs.readFileSync(path.join(tmp, "data", "runs.json"), "utf8")).runs;
assert.equal(runs.filter((r) => r.status === "interrupted").length, 5);
assert.equal(runs.filter((r) => r.status === "running").length, 0);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("smoke: OK");
