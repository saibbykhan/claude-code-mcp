import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createWebServer } from "../server.mjs";

const TOKEN = "c".repeat(64);
const FAKE_KEY = ["sk-", "ant-", "y".repeat(30)].join("");
const calls = [];
let server;
let port;

const toolText = (data, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(data) }] });
const callTool = async (name, args) => {
  calls.push([name, args]);
  if (name === "claude_runs") return toolText({ runs: [{ promptPreview: `mail bob@example.com ${FAKE_KEY}` }] }); // unmasked on purpose: web layer masks again
  if (name === "claude_output") return toolText({ output: "[assistant] did the thing", status: "completed" });
  if (name === "claude_run") return toolText({ error: "not approved" }, true);
  return toolText({ ok: true });
};

function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  // Port is only known after listen; the Host check uses it, so listen first on an ephemeral port then rebuild.
  const probe = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  port = probe.address().port;
  await new Promise((r) => probe.close(r));
  server = createWebServer({ port, token: TOKEN, callTool, summarize: async (text) => ({ model: "haiku", truncatedChars: 0, summary: `summary of ${text.length} chars` }) });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
});
after(() => server.close());

test("every route rejects a missing or wrong token", async () => {
  for (const p of ["/", "/app.js", "/style.css", "/api/runs", "/api/usage", "/api/projects"]) {
    assert.equal((await request(p)).status, 401, p);
    assert.equal((await request(p, { headers: { authorization: "Bearer wrong" } })).status, 401, p);
  }
  const post = await request("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 401);
  assert.equal(calls.length, 0, "no tool may be called without a valid token");
});

test("foreign Host or Origin is rejected even with a valid token", async () => {
  assert.equal((await request("/api/runs", { headers: { ...auth, host: "evil.com" } })).status, 403);
  assert.equal((await request("/api/runs", { headers: { ...auth, host: `evil.com:${port}` } })).status, 403);
  assert.equal((await request("/api/runs", { headers: { ...auth, origin: "http://evil.com" } })).status, 403);
  assert.equal((await request("/api/runs", { headers: { ...auth, origin: "null" } })).status, 403);
  assert.equal((await request("/api/runs", { headers: { ...auth, origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test("page is served with the token embedded and strict headers", async () => {
  const r = await request(`/?token=${TOKEN}`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(TOKEN) && !r.text.includes("__TOKEN__") && !r.text.includes("__SUMMARY_MODEL__"));
  assert.match(r.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(r.headers["cache-control"], "no-store");
});

test("responses are masked again at the web layer", async () => {
  const r = await request("/api/runs", { headers: auth });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(FAKE_KEY) && !r.text.includes("bob@example.com"));
  assert.match(r.text, /b\*\*\*@example\.com/);
});

test("POST needs JSON content-type; only known fields are forwarded; tool errors become 400", async () => {
  const bad = await request("/api/run", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" });
  assert.equal(bad.status, 415);
  calls.length = 0;
  const r = await request("/api/run", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ folder: "p", prompt: "hi", claudeBin: "/bin/evil", cwd: "/", model: "" }),
  });
  assert.equal(r.status, 400);
  assert.deepEqual(calls[0], ["claude_run", { folder: "p", prompt: "hi" }]);
});

test("summarize reads the run output and returns the summary; bad input is a 400", async () => {
  const ok = await request("/api/summarize", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ runId: "r1" }) });
  assert.equal(ok.status, 200);
  assert.match(JSON.parse(ok.text).summary, /^summary of \d+ chars$/);
  const none = await request("/api/summarize", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  assert.equal(none.status, 400);
});

test("unknown paths are 404 and static traversal is impossible", async () => {
  assert.equal((await request("/../package.json", { headers: auth })).status, 404);
  assert.equal((await request("/api/nope", { headers: auth })).status, 404);
});
