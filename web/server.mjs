#!/usr/bin/env node
// Local web interface for claude-code-mcp. Talks to the MCP server over stdio (all tools, masking and
// the run store stay in the server). Binds 127.0.0.1 only; every request needs the token and a local Host.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deepMask } from "../dist/src/mask.js";
import { checkRequest, loadOrCreateToken } from "./lib/security.mjs";
import { summarize as defaultSummarize, summaryModel } from "./lib/summarizer.mjs";

const HOST = "127.0.0.1"; // never configurable
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
export function createWebServer({ port, token, callTool, summarize = defaultSummarize, claudeBin = "claude", env = process.env }) {
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === "string";
    res.writeHead(status, {
      "content-type": isStr ? "text/plain; charset=utf-8" : "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
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

  return http.createServer(async (req, res) => {
    try {
      const gate = checkRequest(req, port, token);
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
      if (req.method === "POST" && p === "/api/summarize") {
        const body = await readBody(req);
        try {
          const text = await conversationText(body);
          return send(res, 200, await summarize(text, { claudeBin, env }));
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      return send(res, STATIC[p] || GET_TOOLS[p] || POST_TOOLS[p] || p === "/api/summarize" ? 405 : 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "internal error" });
    }
  });
}

async function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const port = Number(arg("--port") ?? process.env.CLAUDE_MCP_WEB_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const dataDir = process.env.CLAUDE_MCP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "claude-code-mcp");
  const tokenFile = process.env.CLAUDE_MCP_WEB_TOKEN_FILE || path.join(dataDir, "web-token");
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

  const server = createWebServer({ port, token, callTool, claudeBin });
  const shutdown = () => { server.close(); void client.close().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/?token=${token}`;
    console.log(`claude-code-mcp web interface on http://${HOST}:${port}/ (summary model: ${model})`);
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
