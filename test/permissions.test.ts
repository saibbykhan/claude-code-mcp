import assert from "node:assert/strict";
import test from "node:test";
import { resolvePermissionMode } from "../src/permissions.js";

test("defaults to plan", () => {
  assert.deepEqual(resolvePermissionMode(undefined, {}), { ok: true, mode: "plan" });
  assert.deepEqual(resolvePermissionMode("", {}), { ok: true, mode: "plan" });
  assert.deepEqual(resolvePermissionMode("plan", {}), { ok: true, mode: "plan" });
});

test("acceptEdits only when explicitly requested", () => {
  assert.deepEqual(resolvePermissionMode("acceptEdits", {}), { ok: true, mode: "acceptEdits" });
});

test("bypassPermissions refused without the env flag", () => {
  for (const env of [{}, { CLAUDE_MCP_ALLOW_BYPASS: "0" }, { CLAUDE_MCP_ALLOW_BYPASS: "true" }, { CLAUDE_MCP_ALLOW_BYPASS: "" }]) {
    const r = resolvePermissionMode("bypassPermissions", env);
    assert.equal(r.ok, false);
  }
});

test("bypassPermissions allowed with CLAUDE_MCP_ALLOW_BYPASS=1", () => {
  assert.deepEqual(resolvePermissionMode("bypassPermissions", { CLAUDE_MCP_ALLOW_BYPASS: "1" }), { ok: true, mode: "bypassPermissions" });
});

test("the env flag does not change the default", () => {
  assert.deepEqual(resolvePermissionMode(undefined, { CLAUDE_MCP_ALLOW_BYPASS: "1" }), { ok: true, mode: "plan" });
});

test("unknown modes are refused", () => {
  for (const m of ["auto", "dontAsk", "default", "BYPASSPERMISSIONS", "plan --dangerously-skip-permissions"]) {
    assert.equal(resolvePermissionMode(m, { CLAUDE_MCP_ALLOW_BYPASS: "1" }).ok, false, m);
  }
});
