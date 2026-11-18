import assert from "node:assert/strict";
import test from "node:test";
import { deepMask, maskSecrets, truncate } from "../src/mask.js";

// Fake credentials are assembled at runtime so no secret-shaped literal lives in the repo.
const j = (...p: string[]) => p.join("");
const CASES: [string, string][] = [
  ["anthropic key", j("sk-", "ant-", "api03-", "A".repeat(40))],
  ["openai key", j("sk-", "proj", "B".repeat(30))],
  ["github token", j("gh", "p_", "c".repeat(36))],
  ["github pat", j("github", "_pat_", "D".repeat(30))],
  ["slack token", j("xox", "b-", "1234567890-abcdefghij")],
  ["aws key id", j("AK", "IA", "ABCDEFGHIJKLMNOP")],
  ["jwt", j("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcDEF123456")],
];

for (const [name, secret] of CASES) {
  test(`masks ${name}`, () => {
    const out = maskSecrets(`before ${secret} after`);
    assert.ok(!out.includes(secret), out);
    assert.ok(out.includes("[MASKED]"));
    assert.ok(out.startsWith("before ") && out.endsWith(" after"));
  });
}

test("masks bearer headers", () => {
  const out = maskSecrets("Authorization: Bearer abcdefghijklmnop123456");
  assert.ok(!out.includes("abcdefghijklmnop123456"));
});

test("masks key=value and JSON secrets", () => {
  for (const s of ['API_KEY=supersecretvalue1', 'password: "hunter2hunter2"', '{"client_secret":"zzzzzzzzzzzz"}', 'export TOKEN=abcdef123456', '{\\"token\\":\\"qqqqqqqqqqqq\\"}']) {
    const out = maskSecrets(s);
    assert.ok(out.includes("[MASKED]"), `${s} -> ${out}`);
    assert.ok(!/supersecretvalue1|hunter2hunter2|zzzzzzzzzzzz|abcdef123456|qqqqqqqqqqqq/.test(out), out);
  }
});

test("masks URL credentials and private keys", () => {
  assert.equal(maskSecrets("postgres://admin:s3cretpw@db.local:5432/x"), "postgres://admin:[MASKED]@db.local:5432/x");
  const pem = j("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEabc\ndef\n-----END RSA ", "PRIVATE KEY-----");
  assert.equal(maskSecrets(`k: ${pem} end`), "k: [MASKED_PRIVATE_KEY] end");
});

test("emails are never returned in full", () => {
  assert.equal(maskSecrets("mail jane.doe+x@example.co.uk now"), "mail j***@example.co.uk now");
});

test("leaves ordinary text alone", () => {
  const s = "Refactor the tokenizer; max_tokens=4096 and 3 files changed in src/app.ts (commit 9fceb02).";
  assert.equal(maskSecrets(s), s);
});

test("deepMask masks nested string leaves and keeps other types", () => {
  const secret = j("gh", "p_", "e".repeat(36));
  const out = deepMask({ a: [`x ${secret}`], b: { c: "u@v.io", n: 3, t: true, z: null } });
  assert.deepEqual(out, { a: ["x [MASKED]"], b: { c: "u***@v.io", n: 3, t: true, z: null } });
});

test("truncate", () => {
  assert.equal(truncate("abc", 5), "abc");
  assert.equal(truncate("abcdefgh", 3), "abc… [truncated 5 chars]");
});
