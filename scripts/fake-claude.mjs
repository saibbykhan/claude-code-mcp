#!/usr/bin/env node
// Stand-in for the `claude` binary, used only by scripts/smoke.mjs. Makes no model calls.
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  emit({ type: "system", subtype: "init", session_id: "99999999-8888-7777-6666-555555555555", model: "fake", permissionMode: process.argv[process.argv.indexOf("--permission-mode") + 1] });
  emit({ type: "assistant", message: { content: [{ type: "text", text: `argv: ${process.argv.slice(2).join(" ")}` }] } });
  emit({ type: "assistant", message: { content: [{ type: "text", text: `echo: ${prompt} key=${["sk-", "ant-", "x".repeat(30)].join("")} mail someone@example.com` }] } });
  if (prompt.includes("SLEEP")) await new Promise((r) => setTimeout(r, 60000));
  emit({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done" });
});
