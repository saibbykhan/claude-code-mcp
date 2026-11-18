/**
 * Secret masking. Everything the server returns or stores passes through here.
 * The goal is to never emit tokens, keys, full email addresses or key material.
 * Over-masking is acceptable; under-masking is not.
 */

const MASK = "[MASKED]";

type Rule = [RegExp, string];

const RULES: Rule[] = [
  // PEM private key blocks (also unterminated ones)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[MASKED_PRIVATE_KEY]"],
  // Anthropic / OpenAI style keys
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  // GitHub tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  // Slack tokens
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, MASK],
  // AWS access key ids
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  // Google API keys
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  // Authorization header values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${MASK}`],
  // key = value / "key": "value" pairs with secret-looking key names
  [
    /((?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd|authorization|cookie)\\?["']?\s*[:=]\s*\\?["']?)(?!\[MASKED\]|Bearer |Basic )([^\s"'\\,;&]{6,})/gi,
    `$1${MASK}`,
  ],
  // Credentials embedded in URLs: scheme://user:pass@host
  [/(\/\/[^/\s:@]+:)[^/\s@]+@/g, `$1${MASK}@`],
  // Email addresses: keep first character and the domain only
  [/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, "$1***@$2"],
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

/** Recursively mask every string leaf of a JSON-like value. */
export function deepMask<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepMask(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepMask(v);
    return out as T;
  }
  return value;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}
