import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./config.js";
import { maskSecrets, truncate } from "./mask.js";
import type { RunRecord, RunStatus, RunStore } from "./runStore.js";

export type TaskState = "queued" | "running" | "waiting_for_you" | "done" | "failed" | "stopped";
export const TASK_STATES: readonly TaskState[] = ["queued", "running", "waiting_for_you", "done", "failed", "stopped"];
export const ACTIVE_STATES: readonly TaskState[] = ["queued", "running", "waiting_for_you"];

export interface Task {
  id: string;
  prompt: string; // masked, capped
  folder: string;
  project: string;
  runId: string | null;
  sessionId: string | null;
  state: TaskState;
  summary: string; // one plain-language line from the summarizer; last good text is kept
  latest: string; // newest one-line update derived from the run output (no model call)
  pinned: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Allowed moves. A finished task may be re-opened (running) when the person replies to it. */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "failed", "stopped"],
  running: ["waiting_for_you", "done", "failed", "stopped"],
  waiting_for_you: ["running", "done", "failed", "stopped"],
  done: ["running"],
  failed: ["running"],
  stopped: ["running"],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export const MAX_KEPT_TASKS = 200;
export const MAX_PROMPT_CHARS = 200;
export const MAX_LINE_CHARS = 160;

/** Collapse to one short masked line. */
export function oneLine(text: string, max = MAX_LINE_CHARS): string {
  return truncate(maskSecrets(String(text)).replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim(), max);
}

/**
 * "Waiting for you": the run's turn ended normally, and the assistant's closing message asks the person
 * something or asks them to confirm/choose. Looks only at the last assistant text, not at tool output.
 */
export function lastAssistantText(output: string): string {
  const i = output.lastIndexOf("[final] ");
  if (i >= 0) return output.slice(i + 8).replace(/\n\[[a-z_ ]+\][\s\S]*$/, "").trim();
  const j = output.lastIndexOf("[assistant] ");
  if (j < 0) return "";
  return output.slice(j + 12).replace(/\n\[[a-z_ ]+\][\s\S]*$/, "").trim();
}

const ASK_PHRASES = [
  /\b(let me know|tell me|please (confirm|choose|advise|clarify|approve))\b/i,
  /\b(would you like|do you want|should i|shall i|want me to|which (one|option|do you)|how would you like)\b/i,
  /\b(waiting (for|on) you|need (your|you to)|before i (proceed|continue|go ahead))\b/i,
  /\b(approve|approval|permission) (is )?(needed|required)\b/i,
];

export function detectWaiting(output: string): boolean {
  const text = lastAssistantText(output);
  if (!text) return false;
  const tail = text.slice(-600).trim();
  if (/\?["')\]*_\s]*$/.test(tail)) return true;
  const lastPara = tail.split(/\n\s*\n/).pop() ?? tail;
  return ASK_PHRASES.some((re) => re.test(lastPara));
}

/** Newest meaningful one-line update from run output. */
export function latestUpdate(output: string): string {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[(assistant|tool_use|final)\]\s*(.*)$/.exec(lines[i]);
    if (m && m[2].trim()) return oneLine(m[1] === "tool_use" ? `Working: ${m[2]}` : m[2]);
  }
  return "";
}

export function stateFromRun(status: RunStatus, output: string): TaskState {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return detectWaiting(output) ? "waiting_for_you" : "done";
    case "stopped":
      return "stopped";
    default:
      return "failed"; // failed, interrupted
  }
}

/**
 * JSON task store: <dir>/tasks.json. Same pattern as RunStore: every mutation re-reads the file and
 * writes it atomically (mode 600), so the MCP server and the web process can share one file.
 */
export class TaskStore {
  private file: string;

  constructor(dir: string, private now: () => Date = () => new Date()) {
    ensureDataDir(dir);
    this.file = path.join(dir, "tasks.json");
  }

  private read(): Task[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as { tasks?: Task[] };
      return Array.isArray(j.tasks) ? j.tasks.filter((t) => t && typeof t.id === "string" && TASK_STATES.includes(t.state)) : [];
    } catch {
      return [];
    }
  }

  private write(tasks: Task[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  /** Newest first. */
  list(): Task[] {
    return this.read().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Task | undefined {
    return this.read().find((t) => t.id === id);
  }

  getByRun(runId: string): Task | undefined {
    return this.read().find((t) => t.runId === runId);
  }

  findBySession(sessionId: string): Task | undefined {
    return this.list().find((t) => t.sessionId === sessionId);
  }

  create(input: { prompt: string; folder: string; project: string; runId?: string | null; sessionId?: string | null; state?: TaskState }): Task {
    const t = this.iso();
    const task: Task = {
      id: randomUUID(),
      prompt: truncate(maskSecrets(input.prompt).replace(/\s+/g, " ").trim(), MAX_PROMPT_CHARS),
      folder: input.folder,
      project: input.project,
      runId: input.runId ?? null,
      sessionId: input.sessionId ?? null,
      state: input.state ?? "queued",
      summary: "",
      latest: "",
      pinned: false,
      error: null,
      createdAt: t,
      updatedAt: t,
      finishedAt: null,
    };
    let tasks = this.read();
    tasks.push(task);
    if (tasks.length > MAX_KEPT_TASKS) {
      const droppable = tasks
        .filter((x) => !x.pinned && !ACTIVE_STATES.includes(x.state))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, tasks.length - MAX_KEPT_TASKS)
        .map((x) => x.id);
      tasks = tasks.filter((x) => !droppable.includes(x.id));
    }
    this.write(tasks);
    return task;
  }

  /** Move a task to a new state. Throws on a move the state machine does not allow. */
  transition(id: string, to: TaskState, patch: { runId?: string | null; sessionId?: string | null; error?: string | null; finishedAt?: string | null } = {}): Task | undefined {
    const tasks = this.read();
    const t = tasks.find((x) => x.id === id);
    if (!t) return undefined;
    if (!canTransition(t.state, to)) throw new Error(`Invalid task transition ${t.state} -> ${to}.`);
    const reopening = t.state !== "running" && to === "running";
    t.state = to;
    if (patch.runId !== undefined) t.runId = patch.runId;
    if (patch.sessionId !== undefined) t.sessionId = patch.sessionId ?? t.sessionId;
    if (patch.error !== undefined) t.error = patch.error === null ? null : oneLine(patch.error);
    if (reopening) {
      t.finishedAt = null;
      if (patch.error === undefined) t.error = null;
    } else if (to === "done" || to === "failed" || to === "stopped") {
      t.finishedAt = patch.finishedAt ?? t.finishedAt ?? this.iso();
    }
    t.updatedAt = this.iso();
    this.write(tasks);
    return t;
  }

  /** Set non-state fields. A blank or non-string summary never replaces the last good one. */
  update(id: string, patch: { summary?: string; latest?: string; pinned?: boolean; sessionId?: string }): Task | undefined {
    const tasks = this.read();
    const t = tasks.find((x) => x.id === id);
    if (!t) return undefined;
    let changed = false;
    if (typeof patch.summary === "string") {
      const s = oneLine(patch.summary);
      if (s && s !== t.summary) { t.summary = s; changed = true; }
    }
    if (typeof patch.latest === "string") {
      const l = oneLine(patch.latest);
      if (l !== t.latest) { t.latest = l; changed = true; }
    }
    if (typeof patch.pinned === "boolean" && patch.pinned !== t.pinned) { t.pinned = patch.pinned; changed = true; }
    if (typeof patch.sessionId === "string" && patch.sessionId && patch.sessionId !== t.sessionId) { t.sessionId = patch.sessionId; changed = true; }
    if (changed) {
      t.updatedAt = this.iso();
      this.write(tasks);
    }
    return t;
  }

  /**
   * Bring every active task in line with its run. Runs are the source of truth for process state;
   * this derives queued/running/waiting_for_you/done/failed/stopped from them. Returns true if anything changed.
   */
  reconcile(runs: RunStore): boolean {
    runs.reconcile();
    let changed = false;
    for (const task of this.read()) {
      if (!task.runId) continue;
      const run = runs.get(task.runId);
      if (!run) {
        if (ACTIVE_STATES.includes(task.state)) { this.transition(task.id, "failed", { error: "The run record is gone." }); changed = true; }
        continue;
      }
      const wasActive = task.state === "queued" || task.state === "running";
      let output = "";
      if (run.status === "running" || wasActive) {
        try { output = runs.readOutput(run.id, 0, 5_000_000).output; } catch { /* no output yet */ }
      }
      if (wasActive) {
        const to = stateFromRun(run.status, output);
        if (to !== task.state) {
          this.transition(task.id, to, { sessionId: run.sessionId, error: run.error, finishedAt: run.endedAt ?? undefined });
          changed = true;
        }
      }
      if (run.sessionId && run.sessionId !== task.sessionId) { this.update(task.id, { sessionId: run.sessionId }); changed = true; }
      if (run.status === "running" && output) {
        const latest = latestUpdate(output);
        if (latest && latest !== task.latest) { this.update(task.id, { latest }); changed = true; }
      } else if (wasActive && output) {
        const latest = latestUpdate(output);
        if (latest) this.update(task.id, { latest });
      }
    }
    return changed;
  }
}

export type { RunRecord };
