import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Usage is read ONLY from local Claude Code state:
 *  - ~/.claude.json  -> cachedUsageUtilization (the 5-hour and weekly windows Claude Code last fetched)
 *  - ~/.claude/stats-cache.json -> local activity statistics
 * Nothing here starts a model call or contacts the network. Only whitelisted fields are
 * copied out; account identifiers and everything else in those files are left behind.
 */

interface Window {
  utilizationPercent: number | null;
  resetsAt: string | null;
  resetPassed: boolean | null;
}

function pickWindow(w: any, now: number): Window | null {
  if (!w || typeof w !== "object") return null;
  const resetsAt = typeof w.resets_at === "string" ? w.resets_at : null;
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  return {
    utilizationPercent: typeof w.utilization === "number" ? w.utilization : null,
    resetsAt,
    resetPassed: Number.isNaN(t) ? null : t <= now,
  };
}

export function readUsage(opts: { claudeJsonPath?: string; claudeHomeDir?: string; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const claudeJsonPath = opts.claudeJsonPath ?? path.join(os.homedir(), ".claude.json");
  const statsPath = path.join(opts.claudeHomeDir ?? path.join(os.homedir(), ".claude"), "stats-cache.json");
  const notes: string[] = [
    "/usage is an interactive Claude Code command; this server does not run it and never starts a model call to read usage.",
    "The window numbers are the values Claude Code last cached locally. They are not live.",
  ];

  let windows: Record<string, unknown> = { available: false };
  try {
    const cached = (JSON.parse(fs.readFileSync(claudeJsonPath, "utf8")) as any).cachedUsageUtilization;
    const u = cached?.utilization;
    if (u && typeof u === "object") {
      const fetchedAtMs = typeof cached.fetchedAtMs === "number" ? cached.fetchedAtMs : null;
      const fiveHour = pickWindow(u.five_hour, now);
      const weekly = pickWindow(u.seven_day, now);
      const other: Record<string, Window> = {};
      for (const [k, v] of Object.entries(u)) {
        if (k === "five_hour" || k === "seven_day") continue;
        if (!/^seven_day_[a-z_]+$/.test(k)) continue;
        const w = pickWindow(v, now);
        if (w && w.utilizationPercent !== null) other[k] = w;
      }
      windows = {
        available: true,
        source: "cachedUsageUtilization in ~/.claude.json",
        fetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
        ageMinutes: fetchedAtMs ? Math.round((now - fetchedAtMs) / 60000) : null,
        fiveHour,
        weekly,
        ...(Object.keys(other).length ? { otherWeeklyWindows: other } : {}),
      };
      if (fiveHour?.resetPassed || weekly?.resetPassed) {
        notes.push("At least one window's reset time has already passed, so its cached utilization is stale (the real value is lower or zero).");
      }
    } else {
      notes.push("No cached usage windows were found in local Claude Code state. Open Claude Code and run /usage there to refresh the cache.");
    }
  } catch {
    notes.push("Could not read local Claude Code state for usage windows. No numbers are reported.");
  }

  let stats: Record<string, unknown> = { available: false };
  try {
    const s = JSON.parse(fs.readFileSync(statsPath, "utf8")) as any;
    const daily = Array.isArray(s.dailyActivity) ? s.dailyActivity.slice(-7) : [];
    const tokens = Array.isArray(s.dailyModelTokens) ? s.dailyModelTokens.slice(-7) : [];
    stats = {
      available: true,
      source: "~/.claude/stats-cache.json",
      lastComputedDate: s.lastComputedDate ?? null,
      totalSessions: s.totalSessions ?? null,
      totalMessages: s.totalMessages ?? null,
      last7RecordedDays: daily.map((d: any) => ({
        date: d.date,
        messageCount: d.messageCount,
        sessionCount: d.sessionCount,
        toolCallCount: d.toolCallCount,
      })),
      last7RecordedDaysTokensByModel: tokens.map((d: any) => ({ date: d.date, tokensByModel: d.tokensByModel })),
    };
    notes.push("Stats are Claude Code's own local cache and only cover days up to lastComputedDate.");
  } catch {
    notes.push("Could not read ~/.claude/stats-cache.json. No stats are reported.");
  }

  return { windows, stats, notes };
}
