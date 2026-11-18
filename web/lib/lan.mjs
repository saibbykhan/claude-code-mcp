import { execFileSync } from "node:child_process";
import os from "node:os";

export const LOOPBACK = "127.0.0.1";

/** True only for RFC1918 private IPv4 literals: 10/8, 172.16/12, 192.168/16. */
export function isPrivateLanIPv4(addr) {
  if (typeof addr !== "string") return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n, i) => n > 255 || String(n) !== m[i + 1])) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

/** LAN mode is opt-in: CLAUDE_MCP_WEB_LAN=1 or --lan. */
export function lanRequested(argv = process.argv, env = process.env) {
  return argv.includes("--lan") || env.CLAUDE_MCP_WEB_LAN === "1";
}

function defaultEn0() {
  try {
    return execFileSync("ipconfig", ["getifaddr", "en0"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** en0 first, then the first private non-internal IPv4 on any interface. Returns null if none. */
export function detectLanAddress({ en0 = defaultEn0, interfaces = os.networkInterfaces } = {}) {
  const primary = en0();
  if (isPrivateLanIPv4(primary)) return primary;
  for (const addrs of Object.values(interfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && isPrivateLanIPv4(a.address)) return a.address;
    }
  }
  return null;
}

/** Decide the bind address. Never returns 0.0.0.0 or a public address; throws if LAN mode has no private address. */
export function resolveBind({ lan, detect = detectLanAddress }) {
  if (!lan) return { host: LOOPBACK, lanAddress: null };
  const addr = detect();
  if (!isPrivateLanIPv4(addr)) throw new Error("LAN mode requested but no private LAN IPv4 address (192.168.x.x, 10.x.x.x, 172.16-31.x.x) was found. Refusing to start.");
  return { host: addr, lanAddress: addr };
}
