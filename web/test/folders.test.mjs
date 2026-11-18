import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { FolderError, addFolder, removeFolder, validateFolder, listFolders } from "../lib/folders.mjs";
import { createWebServer } from "../server.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folders-test-")));
const home = path.join(tmp, "home");
const proj = path.join(home, "proj");
const outside = path.join(tmp, "outside");
const cfg = path.join(tmp, "data", "config.json");
for (const d of [home, proj, outside]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(proj, "keep.txt"), "keep");
fs.writeFileSync(path.join(tmp, "afile"), "x");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof FolderError && re.test(e.message));
const opts = { home };

test("validation refusals", () => {
  refuses(() => validateFolder(path.join(tmp, "missing"), opts), /does not exist/);
  refuses(() => validateFolder(path.join(tmp, "afile"), opts), /not a folder/);
  refuses(() => validateFolder("relative/dir", opts), /absolute/);
  refuses(() => validateFolder("/", opts), /root/);
  refuses(() => validateFolder(home, opts), /home folder/);
  refuses(() => validateFolder("~", opts), /home folder/);
  refuses(() => validateFolder("", opts), /required/);
});

test("symlink escaping the folder is refused; a link to a sibling inside is fine", () => {
  const p = path.join(home, "linky");
  fs.mkdirSync(path.join(p, "sub"), { recursive: true });
  fs.symlinkSync("sub", path.join(p, "inside"));
  assert.equal(validateFolder(p, opts).realPath, p);
  fs.symlinkSync(outside, path.join(p, "sub", "escape"));
  refuses(() => validateFolder(p, opts), /symlink/);
});

test("add writes valid config atomically with mode 600, ~ expands, duplicates refused", () => {
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([a, b]); return orig(a, b); };
  try {
    const r = addFolder(cfg, { path: "~/proj", name: "Proj" }, opts);
    assert.deepEqual(r, { name: "Proj", path: proj });
  } finally { fs.renameSync = orig; }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], cfg);
  assert.notEqual(renames[0][0], cfg, "written to a temp file first");
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")).projects, [{ name: "Proj", path: proj }]);
  assert.deepEqual(fs.readdirSync(path.dirname(cfg)), ["config.json"], "no temp files left");
  refuses(() => addFolder(cfg, { path: outside, name: "proj" }, opts), /already exists/);
  refuses(() => addFolder(cfg, { path: proj, name: "Other" }, opts), /already approved/);
  assert.equal(listFolders(cfg, opts).length, 1);
});

test("add preserves other config keys and existing entries", () => {
  const c2 = path.join(tmp, "c2.json");
  fs.writeFileSync(c2, JSON.stringify({ claudeBin: "/x/claude", projects: ["~/proj"] }));
  addFolder(c2, { path: outside }, opts);
  const j = JSON.parse(fs.readFileSync(c2, "utf8"));
  assert.equal(j.claudeBin, "/x/claude");
  assert.deepEqual(j.projects, ["~/proj", { name: "outside", path: outside }]);
  assert.equal(j.allowAnyFolder, undefined);
});

test("remove edits config only and never touches the folder on disk", () => {
  removeFolder(cfg, { name: "Proj" }, opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")).projects, []);
  assert.equal(fs.readFileSync(path.join(proj, "keep.txt"), "utf8"), "keep");
  assert.ok(fs.statSync(proj).isDirectory());
  assert.throws(() => removeFolder(cfg, { name: "Proj" }, opts), /No such/);
});

// ---- routes
const TOKEN = "d".repeat(64);
let server, port;
const rcfg = path.join(tmp, "route", "config.json");
const request = (p, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let text = ""; res.on("data", (d) => (text += d)); res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  req.on("error", reject); req.end(body);
});
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };

before(async () => {
  const probe = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  port = probe.address().port;
  await new Promise((r) => probe.close(r));
  server = createWebServer({ port, token: TOKEN, callTool: async () => ({ content: [{ type: "text", text: "{}" }] }), configPath: rcfg, home, chooser: async () => ({ path: proj }) });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
});
after(() => server.close());

const FOLDER_ROUTES = [["/api/folders", "GET"], ["/api/folders/choose", "POST"], ["/api/folders/add", "POST"], ["/api/folders/remove", "POST"]];

test("folder routes refuse missing/wrong token and bad Host/Origin, and never touch config", async () => {
  for (const [p, method] of FOLDER_ROUTES) {
    const body = method === "POST" ? JSON.stringify({ path: proj, name: "x" }) : undefined;
    const ct = method === "POST" ? { "content-type": "application/json" } : {};
    assert.equal((await request(p, { method, headers: ct, body })).status, 401, p);
    assert.equal((await request(p, { method, headers: { ...ct, authorization: "Bearer wrong" }, body })).status, 401, p);
    assert.equal((await request(p, { method, headers: { ...ct, ...auth, host: "evil.com" }, body })).status, 403, p);
    assert.equal((await request(p, { method, headers: { ...ct, ...auth, origin: "http://evil.com" }, body })).status, 403, p);
  }
  assert.ok(!fs.existsSync(rcfg));
});

test("folder routes work end to end with a valid token", async () => {
  assert.deepEqual(JSON.parse((await request("/api/folders", { headers: auth })).text).folders, []);
  const ch = await request("/api/folders/choose", { method: "POST", headers: json, body: "{}" });
  assert.equal(JSON.parse(ch.text).path, proj);
  const bad = await request("/api/folders/add", { method: "POST", headers: json, body: JSON.stringify({ path: "/" }) });
  assert.equal(bad.status, 400);
  const ok = await request("/api/folders/add", { method: "POST", headers: json, body: JSON.stringify({ path: proj, name: "Proj" }) });
  assert.equal(ok.status, 200);
  assert.equal(fs.statSync(rcfg).mode & 0o777, 0o600);
  assert.equal((await request("/api/folders/add", { method: "POST", headers: json, body: JSON.stringify({ path: proj, name: "Proj" }) })).status, 409);
  assert.equal((await request("/api/folders/remove", { method: "POST", headers: json, body: JSON.stringify({ name: "Proj" }) })).status, 200);
  assert.ok(fs.existsSync(path.join(proj, "keep.txt")));
  assert.equal((await request("/api/folders", { method: "POST", headers: json, body: "{}" })).status, 405);
});
