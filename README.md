# claude-code-mcp

A local-only MCP server that lets a local app (or Claude Code itself) look at Claude Code sessions, start and follow `claude -p` runs, and read cached usage, on this Mac.

It is not deployed or hosted anywhere. It speaks stdio by default. The optional HTTP transport binds `127.0.0.1` only and requires a bearer token from a local file. It is not a claude.ai connector.

## Tools

| Tool | What it does |
| --- | --- |
| `claude_projects` | Lists the approved project folders from the config file. |
| `claude_sessions` | Recent sessions in a folder: id, start, last activity, first prompt, last assistant reply (shortened), message count. Read from `~/.claude/projects/<encoded-path>/*.jsonl`. |
| `claude_tail` | The last turns of one session (user and assistant text, default 5, max 10), truncated per message. |
| `claude_run` | Starts `claude -p --output-format stream-json` in a folder. Supports `continueSessionId` (`--resume`, plus `--fork-session` unless `fork: false`), `model`, `permissionMode`. Returns a run id at once. |
| `claude_runs` | Lists runs, active and recent, with status, timestamps and folder. |
| `claude_output` | Reads a run's output from `sinceChars`; returns `nextChars` for paging. |
| `claude_stop` | Stops a run by id. |
| `claude_usage` | The 5-hour and weekly windows as Claude Code last cached them, plus local stats. |

## Install

Needs Node 20+ and the `claude` CLI, already logged in.

```sh
git clone https://github.com/saibbykhan/claude-code-mcp.git ~/Documents/claude-code-mcp
cd ~/Documents/claude-code-mcp
npm install && npm run build
```

Then list the folders the server may touch:

```sh
mkdir -p ~/Library/Application\ Support/claude-code-mcp
cp config.example.json ~/Library/Application\ Support/claude-code-mcp/config.json
# edit the "projects" list
```

Each project is `{ "name", "path" }` or just a path string. Every tool that takes a `folder` accepts a project name or its absolute path, and refuses anything not in this list. The file is re-read on every call, so edits apply without a restart.

## Connect from Claude Code (stdio)

```sh
claude mcp add --scope user claude-code-mcp -- node ~/Documents/claude-code-mcp/dist/src/index.js
```

Or put it in an MCP config (`.mcp.json` in a project, or `mcpServers` in `~/.claude.json`):

```json
{
  "mcpServers": {
    "claude-code-mcp": {
      "command": "node",
      "args": ["/Users/you/Documents/claude-code-mcp/dist/src/index.js"]
    }
  }
}
```

Use absolute paths. To allow `bypassPermissions`, add `"env": { "CLAUDE_MCP_ALLOW_BYPASS": "1" }`.

## Connect from a custom local app

**stdio (recommended).** Spawn `node /path/to/dist/src/index.js` and speak MCP over its stdin/stdout. With the official SDK:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: ["/Users/you/Documents/claude-code-mcp/dist/src/index.js"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
}));
const res = await client.callTool({ name: "claude_runs", arguments: {} });
console.log(JSON.parse(res.content[0].text));
```

Every tool returns one text block containing JSON. Errors come back with `isError: true` and `{ "error": "..." }`.

GUI apps often start with a minimal `PATH` that does not include `claude` (for example an nvm install). Either pass a full `PATH`, set `CLAUDE_MCP_CLAUDE_BIN=/full/path/to/claude`, or set `"claudeBin"` in the config.

Runs belong to the server process that started them. When the app closes the server (stdin closes or the process is signalled), its active runs are terminated and marked `interrupted`. Keep the server process alive for as long as you want runs to continue.

**HTTP on 127.0.0.1 (optional).**

```sh
openssl rand -hex 32 > ~/Library/Application\ Support/claude-code-mcp/http-token
chmod 600 ~/Library/Application\ Support/claude-code-mcp/http-token
node dist/src/index.js --http --port 8765
```

POST MCP (Streamable HTTP, stateless) to `http://127.0.0.1:8765/mcp` with `Authorization: Bearer <token>`. The bind address is hard-coded to `127.0.0.1`. Requests with a non-local `Host` or `Origin` are rejected, and the server refuses to start without a token file that is at least 32 characters and not group/world readable.

## Rules the server enforces

- **Permission modes.** `permissionMode` defaults to `plan`. `acceptEdits` only when passed explicitly. `bypassPermissions` is refused unless the server process has `CLAUDE_MCP_ALLOW_BYPASS=1`. Any other mode is refused.
- **Concurrency.** At most 6 active runs; the 7th `claude_run` is refused.
- **Approved folders only.** Sessions are read and runs are started only in configured projects. Session ids and run ids are validated so they cannot point outside their directories.
- **Local storage.** Run metadata is in `~/Library/Application Support/claude-code-mcp/runs.json`, output in `outputs/<runId>.log` (files `0600`, directory `0700`). Nothing is sent anywhere by this server. The 200 most recent runs are kept; output is capped at 20M characters per run.
- **Masking.** Every tool result and all stored run output pass through a masker: API keys and tokens (Anthropic, OpenAI, GitHub, Slack, AWS, Google, JWTs, bearer headers), `key=value` secrets, URL credentials, and private key blocks become `[MASKED]`; email addresses become `j***@example.com`. The server never reads credential or auth files. From `~/.claude.json` it copies out only the cached usage windows. Masking is pattern-based, so treat it as a safety net, not a guarantee.
- **Outputs are data.** The server has no model in it and never acts on text found in transcripts or run output. Results that carry recorded text include a `notice` field telling the client to treat it as untrusted data, and the server's MCP instructions say the same.
- **Prompts go over stdin**, not the command line, so they do not show up in `ps`.

## Usage numbers

`/usage` is an interactive Claude Code command. This server does not run it, and never starts a model call to read usage. `claude_usage` reports:

- `windows`: `cachedUsageUtilization` from `~/.claude.json`: 5-hour and weekly utilization percent and reset time, with `fetchedAt`, `ageMinutes` and a `resetPassed` flag per window. If a reset time has passed, the output says the number is stale.
- `stats`: totals and the last 7 recorded days from `~/.claude/stats-cache.json`, which only covers days up to its `lastComputedDate`.

If either source is missing, the output says so and reports no numbers. To refresh the cache, run `/usage` in an interactive Claude Code session.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CLAUDE_MCP_ALLOW_BYPASS=1` | Allow `permissionMode: "bypassPermissions"`. |
| `CLAUDE_MCP_CLAUDE_BIN` | Path to the `claude` binary (overrides `claudeBin` in config). |
| `CLAUDE_MCP_CONFIG` | Config file path (default `<data dir>/config.json`). |
| `CLAUDE_MCP_DATA_DIR` | Data directory (default `~/Library/Application Support/claude-code-mcp`). |
| `CLAUDE_MCP_CLAUDE_HOME` | Claude Code state directory (default `~/.claude`). |
| `CLAUDE_MCP_HTTP_PORT`, `CLAUDE_MCP_HTTP_TOKEN_FILE` | HTTP mode port (default 8765) and token file. |

## Development

```sh
npm test        # build + unit tests (session parser, run store, permission gate, masking)
npm run smoke   # end-to-end over stdio with a fake claude binary; makes no model calls
```
