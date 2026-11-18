#!/usr/bin/env node
// Local web interface for claude-code-mcp. Talks to the MCP server over stdio (all tools, masking and
// the run store stay in the server). Binds 127.0.0.1 only; every request needs the token and a local Host.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "../dist/src/runStore.js";
import { TaskStore } from "../dist/src/taskStore.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deepMask } from "../dist/src/mask.js";
import { checkRequest, loadOrCreateToken } from "./lib/security.mjs";
import { lanRequested, resolveBind } from "./lib/lan.mjs";
import { TaskSummarizer } from "./lib/boardSummary.mjs";
import { FolderError, addFolder, chooseFolderMac, configPathFor, listFolders, removeFolder } from "./lib/folders.mjs";
import { summarize as defaultSummarize, summaryModel } from "./lib/summarizer.mjs";

const HOST = "127.0.0.1"; // default bind; only the opt-in LAN mode (web/lib/lan.mjs) may use a private LAN address instead
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const MAX_BODY = 300_000;
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const POST_TOOLS = { "/api/run": "claude_run", "/api/stop": "claude_stop" };
const GET_TOOLS = {
  "/api/projects": "claude_projects",
  "/api/sessions": "claude_sessions",
  "/api/tail": "claude_tail",
  "/api/runs": "claude_runs",
  "/api/output": "claude_output",
  "/api/usage": "claude_usage",
};

function parseToolText(result) {
  const text = result?.content?.[0]?.text ?? "{}";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: "Unreadable tool result." };
  }
  return { isError: Boolean(result?.isError), data };
}

function numeric(v) {
  return v === null || v === undefined || v === "" ? undefined : Number(v);
}

/** Build the HTTP server. `callTool(name, args)` returns the MCP CallToolResult; injectable for tests. */
export function createWebServer({ port, lanAddress = null, token, callTool, summarize = defaultSummarize, claudeBin = "claude", env = process.env, configPath = configPathFor(env), home = os.homedir(), chooser = chooseFolderMac, taskStore, runStore, tickMs = 1500, fadeAfterMs = 10 * 60_000 }) {
  const baseHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  };
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === "string";
    res.writeHead(status, {
      "content-type": isStr ? "text/plain; charset=utf-8" : "application/json",
      ...baseHeaders,
      ...headers,
    });
    res.end(isStr ? body : JSON.stringify(deepMask(body)));
  };

  const tool = async (res, name, args) => {
    const { isError, data } = parseToolText(await callTool(name, args));
    send(res, isError ? 400 : 200, data);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reject(Object.assign(new Error("JSON body required."), { status: 415 }));
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("Body too large."), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
        } catch {
          reject(Object.assign(new Error("Invalid JSON."), { status: 400 }));
        }
      });
      req.on("error", reject);
    });

  // Plain text of the live conversation for the summarizer. Tool results are already masked by the server.
  const conversationText = async ({ runId, folder, sessionId }) => {
    if (runId) {
      const r = parseToolText(await callTool("claude_output", { runId: String(runId), sinceChars: 0, maxChars: 100_000 }));
      if (r.isError) throw new Error(r.data.error || "Could not read the run.");
      return r.data.output ?? "";
    }
    if (folder && sessionId) {
      const r = parseToolText(await callTool("claude_tail", { folder: String(folder), sessionId: String(sessionId), turns: 10, maxCharsPerMessage: 2000 }));
      if (r.isError) throw new Error(r.data.error || "Could not read the session.");
      return (r.data.turns ?? []).map((t) => `Person: ${t.user}\nAssistant: ${t.assistant}`).join("\n\n");
    }
    throw new Error("Give a runId, or a folder and sessionId.");
  };

  // ---- task board: reconcile tasks with their runs, summarize in the background, push changes over SSE
  const clients = new Set();
  let lastSnapshot = "";
  const snapshot = () => JSON.stringify(deepMask({ tasks: taskStore ? taskStore.list() : [], fadeAfterMs, serverTime: new Date().toISOString() }));
  const summarizer = taskStore && runStore
    ? new TaskSummarizer({
        summarize: (text) => summarize(text, { claudeBin, env, oneLine: true }),
        getText: (t) => (t.runId ? runStore.readOutput(t.runId, 0, 100_000).output : ""),
        save: (id, line) => taskStore.update(id, { summary: line }),
        onChange: () => tick(),
      })
    : null;
  function tick() {
    if (!taskStore) return;
    try {
      if (runStore) taskStore.reconcile(runStore);
      summarizer?.consider(taskStore.list());
    } catch {
      /* the board must never crash the server */
    }
    const snap = snapshot();
    // serverTime changes every call; compare the tasks part only
    const key = JSON.stringify(JSON.parse(snap).tasks);
    if (key === lastSnapshot) return;
    lastSnapshot = key;
    for (const c of clients) c.write(`event: tasks\ndata: ${snap}\n\n`);
  }
  const timer = setInterval(() => { if (clients.size) tick(); }, tickMs);
  timer.unref();
  const keepAlive = setInterval(() => { for (const c of clients) c.write(": keep-alive\n\n"); }, 15_000);
  keepAlive.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const gate = checkRequest(req, port, token, lanAddress);
      if (!gate.ok) return send(res, gate.status, { error: gate.error });
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      const p = url.pathname;
      const q = url.searchParams;

      if (req.method === "GET" && STATIC[p]) {
        const [file, type] = STATIC[p];
        let body = fs.readFileSync(path.join(here, "public", file), "utf8");
        if (file === "index.html") body = body.replaceAll("__TOKEN__", encodeURIComponent(token)).replaceAll("__SUMMARY_MODEL__", summaryModel(env));
        return send(res, 200, body, { "content-type": type });
      }
      if (req.method === "GET" && GET_TOOLS[p]) {
        const args = {};
        for (const k of ["folder", "sessionId", "runId"]) if (q.get(k)) args[k] = q.get(k);
        for (const k of ["limit", "turns", "sinceChars", "maxChars", "maxCharsPerMessage"]) if (numeric(q.get(k)) !== undefined) args[k] = numeric(q.get(k));
        if (q.get("activeOnly") === "true") args.activeOnly = true;
        return await tool(res, GET_TOOLS[p], args);
      }
      if (req.method === "POST" && POST_TOOLS[p]) {
        const body = await readBody(req);
        // Only forward fields the tools define; the MCP server still validates and gates everything.
        const allowed = p === "/api/run" ? ["folder", "prompt", "continueSessionId", "fork", "model", "permissionMode"] : ["runId"];
        const args = Object.fromEntries(Object.entries(body).filter(([k, v]) => allowed.includes(k) && v !== "" && v !== null));
        return await tool(res, POST_TOOLS[p], args);
      }
      if (p.startsWith("/api/folders")) {
        const FOLDER_ROUTES = { "/api/folders": "GET", "/api/folders/choose": "POST", "/api/folders/add": "POST", "/api/folders/remove": "POST" };
        if (!FOLDER_ROUTES[p]) return send(res, 404, { error: "not found" });
        if (req.method !== FOLDER_ROUTES[p]) return send(res, 405, { error: "method not allowed" });
        try {
          if (p === "/api/folders") return send(res, 200, { folders: listFolders(configPath, { home }), configPath });
          const body = await readBody(req);
          if (p === "/api/folders/choose") return send(res, 200, await chooser());
          if (p === "/api/folders/add") return send(res, 200, addFolder(configPath, { path: body.path, name: body.name }, { home }));
          return send(res, 200, removeFolder(configPath, { name: body.name }, { home }));
        } catch (e) {
          if (e instanceof FolderError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (req.method === "GET" && p === "/api/tasks") {
        tick();
        return send(res, 200, JSON.parse(snapshot()));
      }
      if (req.method === "GET" && p === "/api/tasks/stream") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", ...baseHeaders });
        res.write("retry: 3000\n\n");
        clients.add(res);
        res.on("close", () => clients.delete(res));
        lastSnapshot = "";
        tick();
        if (!lastSnapshot) res.write(`event: tasks\ndata: ${snapshot()}\n\n`);
        return;
      }
      if (req.method === "POST" && p === "/api/task/pin") {
        const body = await readBody(req);
        if (!taskStore || typeof body.taskId !== "string" || typeof body.pinned !== "boolean") return send(res, 400, { error: "taskId and pinned (true/false) are required." });
        if (!taskStore.update(body.taskId, { pinned: body.pinned })) return send(res, 404, { error: "No such task." });
        tick();
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/summarize") {
        const body = await readBody(req);
        try {
          const text = await conversationText(body);
          return send(res, 200, await summarize(text, { claudeBin, env }));
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      return send(res, STATIC[p] || GET_TOOLS[p] || POST_TOOLS[p] || ["/api/summarize", "/api/tasks", "/api/tasks/stream", "/api/task/pin"].includes(p) ? 405 : 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "internal error" });
    }
  });
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(timer);
    clearInterval(keepAlive);
    for (const c of clients) c.end();
    clients.clear();
    return origClose(cb);
  };
  return server;
}

async function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const port = Number(arg("--port") ?? process.env.CLAUDE_MCP_WEB_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const dataDir = process.env.CLAUDE_MCP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "claude-code-mcp");
  const tokenFile = process.env.CLAUDE_MCP_WEB_TOKEN_FILE || path.join(dataDir, "web-token");
  const { host: bindHost, lanAddress } = resolveBind({ lan: lanRequested() }); // throws (refuses to start) if LAN mode has no private address
  const token = loadOrCreateToken(tokenFile);
  const model = summaryModel(); // fail early on a bad model setting

  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "PATH" || k === "HOME" || k.startsWith("CLAUDE_MCP_")));
  const client = new Client({ name: "claude-code-mcp-web", version: "0.1.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "src", "index.js")],
    env: childEnv,
    stderr: "inherit",
  }));
  const callTool = (name, args) => client.callTool({ name, arguments: args });
  const claudeBin = process.env.CLAUDE_MCP_CLAUDE_BIN || "claude";

  const fadeMin = Number(process.env.CLAUDE_MCP_BOARD_FADE_MINUTES ?? 10);
  const server = createWebServer({
    port, lanAddress, token, callTool, claudeBin,
    taskStore: new TaskStore(dataDir), runStore: new RunStore(dataDir),
    fadeAfterMs: (Number.isFinite(fadeMin) && fadeMin > 0 ? fadeMin : 10) * 60_000,
  });
  const shutdown = () => { server.close(); void client.close().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.listen(port, bindHost, () => {
    const url = `http://${bindHost}:${port}/?token=${token}`;
    console.log(`claude-code-mcp web interface on http://${bindHost}:${port}/ (summary model: ${model})`);
    if (lanAddress) {
      console.log(`LAN mode: reachable only on this Wi-Fi/LAN at ${url}`);
      console.log("WARNING: other devices on this network that have the token can reach this page. Do not share the URL.");
    }
    console.log(`Token file: ${tokenFile} (mode 600)`);
    console.log(`Open: ${url}`);
    if (process.argv.includes("--open")) execFile("open", [url], () => {});
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`fatal: ${e.message}`);
    process.exit(1);
  });
}
