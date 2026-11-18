// Keeps each task's one-line summary fresh in the background. It never blocks the board:
// at most one summarizer call at a time, throttled per task, and any failure leaves the last good text in place.
export const MIN_GAP_MS = 30_000; // between summaries of one task
export const RETRY_GAP_MS = 60_000; // after a failure
export const GROWTH_CHARS = 1500; // new output needed to re-summarize a running task

export class TaskSummarizer {
  /**
   * @param {object} o
   * @param {(text:string)=>Promise<{summary:string}>} o.summarize
   * @param {(task:object)=>string} o.getText  conversation text for the task (already masked by the run store)
   * @param {(id:string, summary:string)=>void} o.save  must not replace the stored text with blank
   * @param {()=>void} [o.onChange]
   * @param {()=>number} [o.now]
   */
  constructor({ summarize, getText, save, onChange = () => {}, now = Date.now }) {
    Object.assign(this, { summarize, getText, save, onChange, now });
    this.seen = new Map(); // task id -> { key, chars, at }
    this.inflight = false;
    this.failures = 0;
  }

  /** Call on every tick with the current tasks. Returns the promise of any call started (for tests). */
  consider(tasks) {
    if (this.inflight) return undefined;
    for (const task of tasks) {
      if (task.state === "queued") continue;
      let text;
      try { text = this.getText(task); } catch { continue; }
      if (!text) continue;
      const prev = this.seen.get(task.id);
      const key = `${task.runId}:${task.state}`;
      const t = this.now();
      const due = !prev
        || (prev.key !== key && t - prev.at >= 2_000)
        || (task.state === "running" && text.length - prev.chars >= GROWTH_CHARS && t - prev.at >= MIN_GAP_MS);
      if (!due || (prev && t < prev.retryAt)) continue;
      this.inflight = true;
      this.seen.set(task.id, { key, chars: text.length, at: t, retryAt: 0 });
      return this.run(task, text, key);
    }
    return undefined;
  }

  async run(task, text, key) {
    try {
      const r = await this.summarize(text);
      const line = typeof r?.summary === "string" ? r.summary.trim() : "";
      if (!line) throw new Error("empty summary");
      this.save(task.id, line);
      this.failures = 0;
      this.onChange();
    } catch {
      // Keep the last good text. Back off, and let this task be retried later.
      this.failures++;
      const prev = this.seen.get(task.id);
      this.seen.set(task.id, { ...prev, key: "", retryAt: this.now() + RETRY_GAP_MS });
    } finally {
      this.inflight = false;
    }
  }
}
