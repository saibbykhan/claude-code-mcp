import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { maskSecrets, truncate } from "./mask.js";
import type { PermissionMode } from "./permissions.js";
import { MAX_CONCURRENT_RUNS, MAX_OUTPUT_CHARS, RunStore, type RunRecord } from "./runStore.js";

export interface StartRunInput {
  claudeBin: string;
  folder: string;
  project: string;
  prompt: string;
  permissionMode: PermissionMode;
  model?: string;
  continueSessionId?: string;
  fork: boolean;
}

/** Build the argv for `claude`. The prompt itself is sent on stdin, never on the command line. */
export function buildClaudeArgs(i: Pick<StartRunInput, "permissionMode" | "model" | "continueSessionId" | "fork">): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", i.permissionMode];
  if (i.model) args.push("--model", i.model);
  if (i.continueSessionId) {
    args.push("--resume", i.continueSessionId);
    if (i.fork) args.push("--fork-session");
  }
  return args;
}

/** Turn one stream-json line into readable text. Returns the text and a session id if the event carries one. */
export function renderStreamLine(line: string): { text: string; sessionId?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { text: "" };
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return { text: `[raw] ${truncate(trimmed, 2000)}\n` };
  }
  const sessionId = typeof ev.session_id === "string" ? ev.session_id : undefined;
  const out: string[] = [];
  if (ev.type === "system") {
    if (ev.subtype === "init") out.push(`[system] session ${ev.session_id ?? "?"} model ${ev.model ?? "?"} permissionMode ${ev.permissionMode ?? "?"}`);
  } else if (ev.type === "assistant" || ev.type === "user") {
    const content = ev.message?.content;
    if (typeof content === "string") {
      if (ev.type === "assistant") out.push(`[assistant] ${content}`);
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string" && ev.type === "assistant") out.push(`[assistant] ${b.text}`);
        else if (b?.type === "tool_use") out.push(`[tool_use] ${b.name} ${truncate(JSON.stringify(b.input ?? {}), 600)}`);
        else if (b?.type === "tool_result") {
          const c = typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((x: any) => (typeof x?.text === "string" ? x.text : `[${x?.type ?? "block"}]`)).join("\n")
              : "";
          out.push(`[tool_result${b.is_error ? " error" : ""}] ${truncate(c, 1500)}`);
        }
      }
    }
  } else if (ev.type === "result") {
    const meta = [
      ev.subtype,
      ev.is_error ? "is_error" : null,
      typeof ev.num_turns === "number" ? `turns=${ev.num_turns}` : null,
      typeof ev.duration_ms === "number" ? `duration_ms=${ev.duration_ms}` : null,
      typeof ev.total_cost_usd === "number" ? `cost_usd=${ev.total_cost_usd}` : null,
    ].filter(Boolean).join(" ");
    out.push(`[result] ${meta}`);
    if (typeof ev.result === "string" && ev.result) out.push(`[final] ${ev.result}`);
  }
  return { text: out.length ? `${out.join("\n")}\n` : "", sessionId };
}

/** Owns the child processes started by this server instance. */
export class RunManager {
  private children = new Map<string, { child: ChildProcess; stopRequested: boolean; chars: number }>();

  constructor(private store: RunStore) {
    this.store.reconcile();
  }

  start(input: StartRunInput): RunRecord {
    this.store.reconcile();
    if (this.store.activeCount() >= MAX_CONCURRENT_RUNS) {
      throw new Error(`Concurrency limit reached: ${MAX_CONCURRENT_RUNS} runs are already active. Stop one or wait.`);
    }
    const id = randomUUID();
    const args = buildClaudeArgs(input);
    const child = spawn(input.claudeBin, args, { cwd: input.folder, stdio: ["pipe", "pipe", "pipe"], env: process.env });

    const rec: RunRecord = {
      id,
      folder: input.folder,
      project: input.project,
      promptPreview: truncate(maskSecrets(input.prompt), 200),
      model: input.model ?? null,
      permissionMode: input.permissionMode,
      continueSessionId: input.continueSessionId ?? null,
      forked: Boolean(input.continueSessionId) && input.fork,
      sessionId: null,
      status: "running",
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      error: null,
    };
    this.store.create(rec);
    const state = { child, stopRequested: false, chars: 0 };
    this.children.set(id, state);

    const append = (text: string) => {
      if (!text || state.chars >= MAX_OUTPUT_CHARS) return;
      let masked = maskSecrets(text);
      if (state.chars + masked.length > MAX_OUTPUT_CHARS) {
        masked = `${masked.slice(0, MAX_OUTPUT_CHARS - state.chars)}\n[output cap reached; further output dropped]\n`;
      }
      state.chars += masked.length;
      try {
        this.store.appendOutput(id, masked);
      } catch {
        /* never crash the server on a disk error */
      }
    };

    let sessionId: string | null = null;
    const lineReader = (onLine: (l: string) => void) => {
      let buf = "";
      return (chunk: Buffer | string) => {
        buf += chunk.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      };
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", lineReader((line) => {
      const r = renderStreamLine(line);
      if (r.sessionId && r.sessionId !== sessionId) {
        sessionId = r.sessionId;
        this.store.update(id, { sessionId });
      }
      append(r.text);
    }));
    child.stderr?.on("data", lineReader((line) => {
      if (line.trim()) append(`[stderr] ${truncate(line, 2000)}\n`);
    }));

    let finished = false;
    const finish = (patch: Partial<RunRecord>) => {
      if (finished) return;
      finished = true;
      this.children.delete(id);
      this.store.update(id, { endedAt: new Date().toISOString(), pid: null, ...patch });
    };
    child.on("error", (err) => {
      append(`[error] failed to start claude: ${err.message}\n`);
      finish({ status: "failed", error: maskSecrets(err.message) });
    });
    child.on("close", (code, signal) => {
      if (state.stopRequested) finish({ status: "stopped", exitCode: code });
      else if (code === 0) finish({ status: "completed", exitCode: 0 });
      else finish({ status: "failed", exitCode: code, error: signal ? `terminated by ${signal}` : `exit code ${code}` });
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end(input.prompt);
    return rec;
  }

  /** Stop a run started by this server instance. */
  stop(id: string): { stopped: boolean; message: string } {
    const rec = this.store.get(id);
    if (!rec) return { stopped: false, message: "No such run." };
    const state = this.children.get(id);
    if (!state) {
      this.store.reconcile();
      const now = this.store.get(id);
      if (now?.status === "running") {
        return { stopped: false, message: "Run is active but owned by another server instance; stop it from that instance." };
      }
      return { stopped: false, message: `Run is not active (status: ${now?.status}).` };
    }
    state.stopRequested = true;
    state.child.kill("SIGTERM");
    const t = setTimeout(() => {
      if (this.children.has(id)) state.child.kill("SIGKILL");
    }, 5000);
    t.unref();
    return { stopped: true, message: "Stop signal sent." };
  }

  /** Called when the server exits: runs do not outlive the server that started them. */
  shutdown(): void {
    for (const [id, state] of this.children) {
      state.stopRequested = true;
      try {
        state.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.store.update(id, { status: "interrupted", endedAt: new Date().toISOString(), pid: null });
    }
    this.children.clear();
  }
}
