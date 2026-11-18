import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectLanAddress, isPrivateLanIPv4, lanRequested, resolveBind } from "../lib/lan.mjs";
import { checkRequest, hostOriginOk } from "../lib/security.mjs";
import { createWebServer } from "../server.mjs";

const TOKEN = "d".repeat(64);
const LAN = "192.168.1.50";
const req = (headers, url = "/api/runs") => ({ headers, url });

test("LAN off (default) binds only to 127.0.0.1", () => {
  assert.equal(lanRequested(["node", "server.mjs"], {}), false);
  assert.equal(lanRequested(["node", "server.mjs"], { CLAUDE_MCP_WEB_LAN: "0" }), false);
  const detect = () => { throw new Error("must not even look for a LAN address when off"); };
  assert.deepEqual(resolveBind({ lan: false, detect }), { host: "127.0.0.1", lanAddress: null });
});

test("LAN is requested only by CLAUDE_MCP_WEB_LAN=1 or --lan", () => {
  assert.equal(lanRequested(["node", "s"], { CLAUDE_MCP_WEB_LAN: "1" }), true);
  assert.equal(lanRequested(["node", "s", "--lan"], {}), true);
});

test("LAN on refuses to start without a private address", () => {
  for (const found of [null, "", "8.8.8.8", "0.0.0.0", "127.0.0.1", "169.254.1.1", "172.32.0.1", "100.64.0.1"]) {
    assert.throws(() => resolveBind({ lan: true, detect: () => found }), /Refusing to start/, String(found));
  }
  assert.equal(detectLanAddress({ en0: () => "", interfaces: () => ({ lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }], en5: [{ family: "IPv4", internal: false, address: "8.8.4.4" }] }) }), null);
});

test("LAN address detection: en0 first, then first private interface address", () => {
  const ifs = () => ({ utun: [{ family: "IPv4", internal: false, address: "203.0.113.9" }], en1: [{ family: "IPv4", internal: false, address: "10.1.2.3" }] });
  assert.equal(detectLanAddress({ en0: () => "192.168.0.7\n".trim(), interfaces: ifs }), "192.168.0.7");
  assert.equal(detectLanAddress({ en0: () => "", interfaces: ifs }), "10.1.2.3");
  assert.equal(detectLanAddress({ en0: () => "203.0.113.9", interfaces: ifs }), "10.1.2.3"); // public en0 never accepted
});

test("bind address is never 0.0.0.0 or public", () => {
  for (const a of ["192.168.1.2", "10.0.0.5", "172.16.0.1", "172.31.255.254"]) {
    const b = resolveBind({ lan: true, detect: () => a });
    assert.equal(b.host, a);
    assert.notEqual(b.host, "0.0.0.0");
    assert.equal(isPrivateLanIPv4(b.host), true);
  }
  for (const a of ["0.0.0.0", "8.8.8.8", "::", "192.168.1.256", "192.168.01.1", "172.15.0.1", "1.192.168.1.1"]) assert.equal(isPrivateLanIPv4(a), false, a);
  const src = fs.readFileSync(fileURLToPath(new URL("../server.mjs", import.meta.url)), "utf8");
  assert.equal(src.includes("0.0.0.0"), false);
});

test("Host check accepts loopback and the LAN address, rejects public/unknown", () => {
  const ok = (host, lan = LAN) => hostOriginOk({ host }, 8787, lan).ok;
  assert.equal(ok("127.0.0.1:8787"), true);
  assert.equal(ok("localhost:8787"), true);
  assert.equal(ok(`${LAN}:8787`), true);
  assert.equal(ok("8.8.8.8:8787"), false);
  assert.equal(ok("192.168.1.51:8787"), false);
  assert.equal(ok(`${LAN}:9999`), false);
  assert.equal(ok(LAN), false);
  assert.equal(ok("evil.com:8787"), false);
  assert.equal(ok("0.0.0.0:8787"), false);
  // LAN off: the LAN address is not accepted
  assert.equal(ok(`${LAN}:8787`, null), false);
  // a non-private "lan address" never widens the check
  assert.equal(ok("8.8.8.8:8787", "8.8.8.8"), false);
});

test("Origin must match the same origin in LAN mode", () => {
  const h = { host: `${LAN}:8787` };
  assert.equal(hostOriginOk({ ...h, origin: `http://${LAN}:8787` }, 8787, LAN).ok, true);
  assert.equal(hostOriginOk({ ...h, origin: "http://127.0.0.1:8787" }, 8787, LAN).ok, true);
  assert.equal(hostOriginOk({ ...h, origin: "http://evil.com" }, 8787, LAN).status, 403);
  assert.equal(hostOriginOk({ ...h, origin: "http://192.168.1.51:8787" }, 8787, LAN).status, 403);
  assert.equal(hostOriginOk({ ...h, origin: "null" }, 8787, LAN).status, 403);
  assert.equal(hostOriginOk({ ...h, origin: `http://${LAN}:8787` }, 8787, null).status, 403);
});

test("token still required in LAN mode (unit)", () => {
  const good = { host: `${LAN}:8787`, authorization: `Bearer ${TOKEN}` };
  assert.equal(checkRequest(req(good), 8787, TOKEN, LAN).ok, true);
  assert.equal(checkRequest(req({ host: `${LAN}:8787` }), 8787, TOKEN, LAN).status, 401);
  assert.equal(checkRequest(req({ host: `${LAN}:8787`, authorization: "Bearer nope" }), 8787, TOKEN, LAN).status, 401);
  assert.equal(checkRequest(req({ ...good, host: "8.8.8.8:8787" }), 8787, TOKEN, LAN).status, 403);
});

test("token still required in LAN mode (real server, LAN Host header)", async () => {
  const probe = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const calls = [];
  const server = createWebServer({ port, lanAddress: LAN, token: TOKEN, callTool: async (n) => { calls.push(n); return { content: [{ type: "text", text: "{}" }] }; } });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const get = (headers) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/api/runs", headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
  });
  try {
    assert.equal(await get({ host: `${LAN}:${port}` }), 401);
    assert.equal(await get({ host: `${LAN}:${port}`, authorization: "Bearer wrong" }), 401);
    assert.equal(await get({ host: `8.8.8.8:${port}`, authorization: `Bearer ${TOKEN}` }), 403);
    assert.equal(calls.length, 0);
    assert.equal(await get({ host: `${LAN}:${port}`, authorization: `Bearer ${TOKEN}` }), 200);
  } finally {
    server.close();
  }
});
