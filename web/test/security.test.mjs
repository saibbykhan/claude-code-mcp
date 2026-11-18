import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkRequest, hostOriginOk, loadOrCreateToken, tokenFromRequest, tokenOk } from "../lib/security.mjs";

const TOKEN = "a".repeat(64);
const req = (headers, url = "/api/runs") => ({ headers, url });

test("token file is created with mode 600 and reused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccweb-"));
  const file = path.join(dir, "sub", "web-token");
  const t1 = loadOrCreateToken(file);
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadOrCreateToken(file), t1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("token file with loose permissions or short content is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccweb-"));
  const file = path.join(dir, "t");
  fs.writeFileSync(file, TOKEN, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadOrCreateToken(file), /chmod 600/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "short");
  assert.throws(() => loadOrCreateToken(file), /too short/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("token: bearer header and query param accepted, wrong/missing/length-mismatch rejected", () => {
  assert.equal(tokenOk(tokenFromRequest({ authorization: `Bearer ${TOKEN}` }, "/"), TOKEN), true);
  assert.equal(tokenOk(tokenFromRequest({}, `/?token=${TOKEN}`), TOKEN), true);
  assert.equal(tokenOk(tokenFromRequest({ authorization: `Bearer ${"b".repeat(64)}` }, "/"), TOKEN), false);
  assert.equal(tokenOk(tokenFromRequest({ authorization: "Bearer short" }, "/"), TOKEN), false);
  assert.equal(tokenOk(tokenFromRequest({ authorization: `Basic ${TOKEN}` }, "/"), TOKEN), false);
  assert.equal(tokenOk(tokenFromRequest({}, "/"), TOKEN), false);
  assert.equal(tokenOk("", TOKEN), false);
});

test("Host: only this server's loopback host:port", () => {
  for (const host of ["127.0.0.1:8787", "localhost:8787"]) assert.equal(hostOriginOk({ host }, 8787).ok, true);
  for (const host of [undefined, "", "evil.com", "evil.com:8787", "127.0.0.1", "127.0.0.1:9999", "127.0.0.1:8787.evil.com", "0.0.0.0:8787", "[::1]:8787"]) {
    const r = hostOriginOk({ host }, 8787);
    assert.equal(r.ok, false, String(host));
    assert.equal(r.status, 403);
  }
});

test("Origin: absent or same-origin ok; foreign, other-port, https and null rejected", () => {
  assert.equal(hostOriginOk({ host: "127.0.0.1:8787" }, 8787).ok, true);
  assert.equal(hostOriginOk({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, 8787).ok, true);
  assert.equal(hostOriginOk({ host: "localhost:8787", origin: "http://localhost:8787" }, 8787).ok, true);
  for (const origin of ["http://evil.com", "http://127.0.0.1:9999", "https://127.0.0.1:8787", "null", "", "http://127.0.0.1:8787.evil.com"]) {
    assert.equal(hostOriginOk({ host: "127.0.0.1:8787", origin }, 8787).ok, false, origin);
  }
});

test("checkRequest: host/origin checked before token; bad token is 401", () => {
  const good = { host: "127.0.0.1:8787", authorization: `Bearer ${TOKEN}` };
  assert.equal(checkRequest(req(good), 8787, TOKEN).ok, true);
  assert.equal(checkRequest(req({ ...good, host: "evil.com" }), 8787, TOKEN).status, 403);
  assert.equal(checkRequest(req({ ...good, origin: "http://evil.com" }), 8787, TOKEN).status, 403);
  assert.equal(checkRequest(req({ host: "127.0.0.1:8787" }), 8787, TOKEN).status, 401);
  assert.equal(checkRequest(req({ host: "127.0.0.1:8787", authorization: "Bearer nope" }), 8787, TOKEN).status, 401);
});
