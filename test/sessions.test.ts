import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeProjectPath, isValidSessionId, listSessionFiles, parseSessionFile, parseSessionLines } from "../src/sessions.js";

const SID = "11111111-2222-3333-4444-555555555555";
const L = (o: object) => JSON.stringify(o);
const user = (text: unknown, ts: string, extra: object = {}) => L({ type: "user", sessionId: SID, timestamp: ts, message: { role: "user", content: text }, ...extra });
const asst = (content: unknown, ts: string, extra: object = {}) => L({ type: "assistant", sessionId: SID, timestamp: ts, message: { role: "assistant", content }, ...extra });

test("encodeProjectPath matches Claude Code's folder naming", () => {
  assert.equal(encodeProjectPath("/Users/me/Documents/site.sync_ai mono"), "-Users-me-Documents-site-sync-ai-mono");
});

test("isValidSessionId rejects traversal", () => {
  assert.ok(isValidSessionId(SID));
  assert.ok(!isValidSessionId("../../etc/passwd"));
  assert.ok(!isValidSessionId(`${SID}/x`));
});

test("parses a session summary", () => {
  const s = parseSessionLines([
    L({ type: "session-owner", sessionId: SID, accountUuid: "x" }),
    user("first prompt", "2026-01-01T10:00:00Z"),
    asst([{ type: "thinking", thinking: "hmm" }], "2026-01-01T10:00:01Z"),
    asst([{ type: "tool_use", id: "t1", name: "Bash", input: {} }], "2026-01-01T10:00:02Z"),
    user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }], "2026-01-01T10:00:03Z"),
    asst([{ type: "text", text: "reply one" }], "2026-01-01T10:00:04Z"),
    "this is not json",
    "",
    user([{ type: "text", text: "second prompt" }], "2026-01-01T11:00:00Z"),
    asst([{ type: "text", text: "part a" }], "2026-01-01T11:00:05Z"),
    asst([{ type: "text", text: "part b" }], "2026-01-01T11:00:09Z"),
    L({ type: "last-prompt", sessionId: SID, lastPrompt: "second prompt" }),
  ]);
  assert.equal(s.sessionId, SID);
  assert.equal(s.startedAt, "2026-01-01T10:00:00Z");
  assert.equal(s.lastActivityAt, "2026-01-01T11:00:09Z");
  assert.equal(s.firstPrompt, "first prompt");
  assert.equal(s.lastAssistantReply, "part b");
  assert.equal(s.messageCount, 5); // 2 prompts + 3 assistant text messages
  assert.deepEqual(s.turns, [
    { timestamp: "2026-01-01T10:00:00Z", user: "first prompt", assistant: "reply one" },
    { timestamp: "2026-01-01T11:00:00Z", user: "second prompt", assistant: "part a\n\npart b" },
  ]);
});

test("skips sidechain, meta and harness-injected entries", () => {
  const s = parseSessionLines([
    user("<command-name>/clear</command-name>", "2026-01-01T09:00:00Z"),
    user("meta", "2026-01-01T09:00:01Z", { isMeta: true }),
    user("sub agent prompt", "2026-01-01T09:00:02Z", { isSidechain: true }),
    asst([{ type: "text", text: "sub agent reply" }], "2026-01-01T09:00:03Z", { isSidechain: true }),
    user("real", "2026-01-01T09:00:04Z"),
  ]);
  assert.equal(s.firstPrompt, "real");
  assert.equal(s.messageCount, 1);
  assert.equal(s.lastAssistantReply, null);
});

test("keeps only the last 10 turns", () => {
  const lines: string[] = [];
  for (let i = 0; i < 25; i++) {
    lines.push(user(`p${i}`, `2026-01-01T10:00:${String(i).padStart(2, "0")}Z`), asst([{ type: "text", text: `r${i}` }], `2026-01-01T10:00:${String(i).padStart(2, "0")}Z`));
  }
  const s = parseSessionLines(lines);
  assert.equal(s.turns.length, 10);
  assert.equal(s.turns[0].user, "p15");
  assert.equal(s.turns[9].assistant, "r24");
  assert.equal(s.firstPrompt, "p0");
  assert.equal(s.messageCount, 50);
});

test("empty input", () => {
  const s = parseSessionLines([]);
  assert.equal(s.messageCount, 0);
  assert.equal(s.firstPrompt, null);
  assert.deepEqual(s.turns, []);
});

test("parseSessionFile and listSessionFiles read from disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-sess-"));
  const older = path.join(dir, "aaaaaaaa-0000-0000-0000-000000000000.jsonl");
  const newer = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(older, "");
  fs.writeFileSync(newer, [user("hi", "2026-01-01T10:00:00Z"), asst([{ type: "text", text: "hello" }], "2026-01-01T10:00:01Z")].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  fs.utimesSync(older, new Date(1000), new Date(1000));
  const files = listSessionFiles(dir);
  assert.deepEqual(files.map((f) => path.basename(f.file)), [`${SID}.jsonl`, "aaaaaaaa-0000-0000-0000-000000000000.jsonl"]);
  const s = await parseSessionFile(newer);
  assert.equal(s.lastAssistantReply, "hello");
  assert.equal((await parseSessionFile(older)).sessionId, "aaaaaaaa-0000-0000-0000-000000000000");
  assert.deepEqual(listSessionFiles(path.join(dir, "missing")), []);
  fs.rmSync(dir, { recursive: true });
});
