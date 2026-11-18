/** Permission gate for claude_run. Pure, so it can be unit tested. */

export const PERMISSION_MODES = ["plan", "acceptEdits", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "plan";
export const BYPASS_ENV = "CLAUDE_MCP_ALLOW_BYPASS";

export type GateResult = { ok: true; mode: PermissionMode } | { ok: false; error: string };

/**
 * - omitted            -> "plan"
 * - "acceptEdits"      -> allowed only because it was passed explicitly
 * - "bypassPermissions"-> allowed only when CLAUDE_MCP_ALLOW_BYPASS=1 in the server's environment
 * - anything else      -> refused
 */
export function resolvePermissionMode(
  requested: string | undefined | null,
  env: Record<string, string | undefined> = process.env,
): GateResult {
  if (requested === undefined || requested === null || requested === "") {
    return { ok: true, mode: DEFAULT_PERMISSION_MODE };
  }
  if (!(PERMISSION_MODES as readonly string[]).includes(requested)) {
    return {
      ok: false,
      error: `permissionMode "${requested}" is not allowed. Allowed: ${PERMISSION_MODES.join(", ")}.`,
    };
  }
  if (requested === "bypassPermissions" && env[BYPASS_ENV] !== "1") {
    return {
      ok: false,
      error: `permissionMode "bypassPermissions" is refused: the server was not started with ${BYPASS_ENV}=1.`,
    };
  }
  return { ok: true, mode: requested as PermissionMode };
}
