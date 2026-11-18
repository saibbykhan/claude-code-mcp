// Approved-folder management for the web UI. Reads/writes the same config.json the MCP server reads.
// Removing a folder only edits the config; nothing on disk is ever deleted here.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 8;

export class FolderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function configPathFor(env = process.env) {
  if (env.CLAUDE_MCP_CONFIG) return env.CLAUDE_MCP_CONFIG;
  const dir = env.CLAUDE_MCP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "claude-code-mcp");
  return path.join(dir, "config.json");
}

function expandTilde(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function readConfigJson(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new FolderError("Could not read the config file.", 500);
  }
  try {
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    return json;
  } catch {
    throw new FolderError("The config file is not valid JSON; fix it by hand before using the picker.", 500);
  }
}

/** Normalised view of config.projects (entries may be plain strings or {name,path}). */
function entriesOf(json, home) {
  const out = [];
  for (const entry of Array.isArray(json.projects) ? json.projects : []) {
    const p = typeof entry === "string" ? entry : entry?.path;
    if (typeof p !== "string" || !p.trim()) continue;
    const abs = path.resolve(expandTilde(p.trim(), home));
    const name = typeof entry === "object" && typeof entry.name === "string" ? entry.name : path.basename(abs);
    out.push({ name, path: abs, raw: entry });
  }
  return out;
}

export function listFolders(configPath, { home = os.homedir() } = {}) {
  const json = readConfigJson(configPath);
  return entriesOf(json, home).map(({ name, path: p }) => ({ name, path: p, exists: fs.existsSync(p) }));
}

/** Write atomically: temp file in the same directory (mode 600), fsync, rename over the target. */
export function writeConfigAtomic(configPath, json) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(json, null, 2) + "\n");
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  try {
    fs.renameSync(tmp, configPath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Bounded walk: every symlink inside `realRoot` must resolve to somewhere inside `realRoot`. Returns the first offender or null. */
function findEscapingSymlink(realRoot) {
  let seen = 0;
  const inside = (t) => t === realRoot || t.startsWith(realRoot + path.sep);
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (++seen > MAX_SCAN_ENTRIES) return null;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target;
        try { target = fs.realpathSync(full); } catch { target = null; } // dangling links point nowhere; harmless
        if (target && !inside(target)) return full;
      } else if (e.isDirectory() && depth < MAX_SCAN_DEPTH) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(realRoot, 0);
}

/** Validate a candidate folder. Returns { realPath } or throws FolderError. */
export function validateFolder(input, { home = os.homedir() } = {}) {
  if (typeof input !== "string" || !input.trim()) throw new FolderError("A folder path is required.");
  if (input.includes("\0")) throw new FolderError("Invalid path.");
  const expanded = expandTilde(input.trim(), home);
  if (!path.isAbsolute(expanded)) throw new FolderError("The path must be absolute (or start with ~/).");
  const resolved = path.resolve(expanded);

  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new FolderError("That path does not exist.");
  }
  if (!st.isDirectory()) throw new FolderError("That path is not a folder.");
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new FolderError("That folder is not readable.");
  }

  const realPath = fs.realpathSync(resolved);
  const realHome = (() => { try { return fs.realpathSync(home); } catch { return path.resolve(home); } })();
  const isRoot = (p) => p === path.parse(p).root;
  for (const p of [resolved, realPath]) {
    if (isRoot(p)) throw new FolderError("The filesystem root cannot be approved.");
    if (p === path.resolve(home) || p === realHome) throw new FolderError("Your home folder itself cannot be approved; choose a folder inside it.");
  }

  const bad = findEscapingSymlink(realPath);
  if (bad) throw new FolderError(`Refused: ${path.relative(realPath, bad)} is a symlink that points outside the chosen folder.`);
  return { realPath };
}

function validateName(name) {
  if (typeof name !== "string" || !name.trim()) throw new FolderError("A name is required.");
  const n = name.trim();
  if (n.length > 64) throw new FolderError("The name is too long (max 64 characters).");
  if (/[\x00-\x1f\x7f/\\]/.test(n)) throw new FolderError("The name must not contain slashes or control characters.");
  return n;
}

export function addFolder(configPath, { path: input, name }, { home = os.homedir() } = {}) {
  const { realPath } = validateFolder(input, { home });
  const finalName = validateName(name === undefined || name === "" ? path.basename(realPath) : name);
  const json = readConfigJson(configPath);
  const existing = entriesOf(json, home);
  if (existing.some((e) => e.name.toLowerCase() === finalName.toLowerCase())) throw new FolderError(`A folder named "${finalName}" already exists.`, 409);
  if (existing.some((e) => e.path === realPath)) throw new FolderError("That folder is already approved.", 409);
  const projects = Array.isArray(json.projects) ? [...json.projects] : [];
  projects.push({ name: finalName, path: realPath });
  writeConfigAtomic(configPath, { ...json, projects });
  return { name: finalName, path: realPath };
}

export function removeFolder(configPath, { name }, { home = os.homedir() } = {}) {
  if (typeof name !== "string" || !name) throw new FolderError("A folder name is required.");
  const json = readConfigJson(configPath);
  const entries = entriesOf(json, home);
  const hit = entries.find((e) => e.name === name);
  if (!hit) throw new FolderError("No such approved folder.", 404);
  const projects = (Array.isArray(json.projects) ? json.projects : []).filter((e) => e !== hit.raw);
  writeConfigAtomic(configPath, { ...json, projects }); // config only; the folder on disk is never touched
  return { ok: true };
}

/** Open the native macOS chooser. execFile with a fixed argument vector; no shell. */
export function chooseFolderMac() {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return reject(new FolderError("The native folder chooser is only available on macOS; type the path instead.", 501));
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Choose a folder Claude Code may work in")'],
      { timeout: 5 * 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          if (/User canceled|-128/.test(String(stderr))) return resolve({ cancelled: true });
          return reject(new FolderError("The folder chooser is unavailable; type the path instead.", 501));
        }
        const p = String(stdout).trim().replace(/(.)\/+$/, "$1");
        resolve(p ? { path: p } : { cancelled: true });
      },
    );
  });
}
