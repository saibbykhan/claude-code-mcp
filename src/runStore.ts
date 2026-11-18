import fs from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./config.js";

export type RunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface RunRecord {
  id: string;
  folder: string;
  project: string;
  promptPreview: string;
  model: string | null;
  permissionMode: string;
  continueSessionId: string | null;
  forked: boolean;
  sessionId: string | null;
  status: RunStatus;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export const MAX_CONCURRENT_RUNS = 6;
const MAX_KEPT_RUNS = 200;
/** Per-run cap on stored output, in characters. */
export const MAX_OUTPUT_CHARS = 20_000_000;

export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * JSON run store: <dir>/runs.json for metadata, <dir>/outputs/<id>.log for output.
 * Every mutation re-reads the file and writes atomically, so several local server
 * instances can share one store.
 */
export class RunStore {
  private file: string;
  private outDir: string;

  constructor(private dir: string) {
    ensureDataDir(dir);
    this.file = path.join(dir, "runs.json");
    this.outDir = path.join(dir, "outputs");
    fs.mkdirSync(this.outDir, { recursive: true, mode: 0o700 });
  }

  private read(): RunRecord[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as { runs?: RunRecord[] };
      return Array.isArray(j.runs) ? j.runs : [];
    } catch {
      return [];
    }
  }

  private write(runs: RunRecord[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Newest first. */
  list(): RunRecord[] {
    return this.read().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): RunRecord | undefined {
    return this.read().find((r) => r.id === id);
  }

  create(rec: RunRecord): void {
    let runs = this.read();
    runs.push(rec);
    if (runs.length > MAX_KEPT_RUNS) {
      runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const finished = runs.filter((r) => r.status !== "running");
      for (const old of finished.slice(0, runs.length - MAX_KEPT_RUNS)) {
        runs = runs.filter((r) => r.id !== old.id);
        fs.rmSync(this.outputPath(old.id), { force: true });
      }
    }
    this.write(runs);
  }

  update(id: string, patch: Partial<RunRecord>): RunRecord | undefined {
    const runs = this.read();
    const r = runs.find((x) => x.id === id);
    if (!r) return undefined;
    Object.assign(r, patch);
    this.write(runs);
    return r;
  }

  /** Mark "running" records whose process is gone as interrupted. */
  reconcile(isAlive: (pid: number | null) => boolean = pidAlive): void {
    const runs = this.read();
    let changed = false;
    for (const r of runs) {
      if (r.status === "running" && !isAlive(r.pid)) {
        r.status = "interrupted";
        r.endedAt = r.endedAt ?? new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.write(runs);
  }

  activeCount(): number {
    return this.read().filter((r) => r.status === "running").length;
  }

  outputPath(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid run id.");
    return path.join(this.outDir, `${id}.log`);
  }

  appendOutput(id: string, text: string): void {
    fs.appendFileSync(this.outputPath(id), text, { mode: 0o600 });
  }

  /** Read output from a character offset. `nextChars` is the offset to pass next time. */
  readOutput(id: string, sinceChars: number, maxChars: number): { output: string; nextChars: number; totalChars: number; more: boolean } {
    const file = this.outputPath(id); // throws on an invalid id
    let all = "";
    try {
      all = fs.readFileSync(file, "utf8");
    } catch {
      /* no output yet */
    }
    const start = Math.min(Math.max(0, Math.floor(sinceChars)), all.length);
    const output = all.slice(start, start + maxChars);
    const nextChars = start + output.length;
    return { output, nextChars, totalChars: all.length, more: nextChars < all.length };
  }
}
