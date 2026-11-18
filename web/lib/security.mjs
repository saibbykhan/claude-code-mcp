import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Read the token file, creating it (mode 600, random 256-bit) if missing. Refuses loose permissions. */
export function loadOrCreateToken(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, randomBytes(32).toString("hex") + "\n");
    } finally {
      fs.closeSync(fd);
    }
  }
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`Token file ${file} must not be readable by group/others (chmod 600).`);
  const token = fs.readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error(`Token in ${file} is too short (need at least 32 characters).`);
  return token;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Token comes from `Authorization: Bearer` or, for the first page load only, a `token` query parameter. */
export function tokenFromRequest(headers, url) {
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  try {
    return new URL(url ?? "/", "http://x").searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

export function tokenOk(provided, token) {
  return Boolean(provided) && safeEqual(provided, token);
}

/** Host must be exactly this server's loopback address; Origin (if sent) must be the same origin. */
export function hostOriginOk(headers, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(headers.host ?? "")) return { ok: false, status: 403, error: "forbidden host" };
  const origin = headers.origin;
  if (origin !== undefined) {
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (!allowedOrigins.has(origin)) return { ok: false, status: 403, error: "forbidden origin" };
  }
  return { ok: true };
}

/** Full gate applied to every request, in order: host/origin, then token. */
export function checkRequest(req, port, token) {
  const h = hostOriginOk(req.headers, port);
  if (!h.ok) return h;
  if (!tokenOk(tokenFromRequest(req.headers, req.url), token)) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}
