import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Project {
  name: string;
  path: string;
}

export interface Config {
  projects: Project[];
  claudeBin: string;
  configPath: string;
  configError?: string;
}

export function dataDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_MCP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "claude-code-mcp");
}

export function claudeHome(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_MCP_CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

export function ensureDataDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Config is re-read on every call so edits apply without restarting the server. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const configPath = env.CLAUDE_MCP_CONFIG || path.join(dataDir(env), "config.json");
  const base: Config = { projects: [], claudeBin: env.CLAUDE_MCP_CLAUDE_BIN || "claude", configPath };
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return { ...base, configError: `No config file at ${configPath}. Create it with a "projects" list.` };
  }
  try {
    const json = JSON.parse(raw) as { projects?: unknown; claudeBin?: unknown };
    const projects: Project[] = [];
    for (const entry of Array.isArray(json.projects) ? json.projects : []) {
      const p = typeof entry === "string" ? entry : (entry as { path?: unknown })?.path;
      if (typeof p !== "string" || !p.trim()) continue;
      const abs = path.resolve(expandHome(p.trim()));
      const n = typeof entry === "object" && entry && typeof (entry as { name?: unknown }).name === "string"
        ? ((entry as { name: string }).name)
        : path.basename(abs);
      projects.push({ name: n, path: abs });
    }
    const claudeBin = env.CLAUDE_MCP_CLAUDE_BIN || (typeof json.claudeBin === "string" && json.claudeBin ? expandHome(json.claudeBin) : "claude");
    return { projects, claudeBin, configPath };
  } catch (e) {
    return { ...base, configError: `Config file ${configPath} is not valid JSON: ${(e as Error).message}` };
  }
}

/** Resolve a folder argument (project name or absolute path) to an approved project, or throw. */
export function resolveProject(folder: string, config: Config): Project {
  const wanted = folder.trim();
  const abs = path.resolve(expandHome(wanted));
  const hit = config.projects.find((p) => p.name === wanted) ?? config.projects.find((p) => p.path === abs);
  if (!hit) {
    throw new Error(
      `Folder "${wanted}" is not an approved project. Approved projects come from ${config.configPath}; call claude_projects to list them.`,
    );
  }
  return hit;
}
