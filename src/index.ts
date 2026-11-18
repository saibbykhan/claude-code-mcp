#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { dataDir } from "./config.js";
import { RunManager } from "./runner.js";
import { RunStore } from "./runStore.js";
import { createServer } from "./server.js";
import { TaskStore } from "./taskStore.js";

const HOST = "127.0.0.1"; // The only address this server ever binds. Not configurable.

function log(msg: string): void {
  process.stderr.write(`[claude-code-mcp] ${msg}\n`); // stdout belongs to the stdio transport
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function readHttpToken(file: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`HTTP mode needs a bearer token file at ${file}. Create it with: openssl rand -hex 32 > "${file}" && chmod 600 "${file}"`);
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`Token file ${file} must not be readable by group/others (chmod 600).`);
  const token = fs.readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error(`Token in ${file} is too short (need at least 32 characters).`);
  return token;
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7).trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function main(): Promise<void> {
  const dir = dataDir();
  const store = new RunStore(dir);
  const manager = new RunManager(store);
  const tasks = new TaskStore(dir);

  let exiting = false;
  const shutdown = (code = 0) => {
    if (exiting) return;
    exiting = true;
    manager.shutdown();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGHUP", () => shutdown(0));

  if (process.argv.includes("--http")) {
    const port = Number(arg("--port") ?? process.env.CLAUDE_MCP_HTTP_PORT ?? 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
    const token = readHttpToken(process.env.CLAUDE_MCP_HTTP_TOKEN_FILE || path.join(dir, "http-token"));
    const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);

    const httpServer = http.createServer(async (req, res) => {
      const deny = (status: number, message: string) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
      };
      try {
        // DNS-rebinding and browser protection: local Host only, no foreign Origin.
        if (!allowedHosts.has(req.headers.host ?? "")) return deny(403, "forbidden host");
        const origin = req.headers.origin;
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return deny(403, "forbidden origin");
        if (!bearerMatches(req.headers.authorization, token)) return deny(401, "unauthorized");
        if ((req.url ?? "").split("?")[0] !== "/mcp") return deny(404, "not found");
        if (req.method !== "POST") return deny(405, "method not allowed");

        // Stateless: a fresh MCP server + transport per request, sharing one run manager.
        const server = createServer({ store, manager, tasks });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        log(`request error: ${(e as Error).message}`);
        if (!res.headersSent) deny(500, "internal error");
      }
    });
    httpServer.listen(port, HOST, () => log(`HTTP transport listening on http://${HOST}:${port}/mcp (bearer token required)`));
    return;
  }

  const server = createServer({ store, manager, tasks });
  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown(0);
  process.stdin.on("end", () => shutdown(0));
  await server.connect(transport);
  log("stdio transport ready");
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
