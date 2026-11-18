# Web interface

A small local browser app on top of the MCP server. Plain HTML, CSS and vanilla JS; no framework, no extra build step (it reuses the repo's `npm run build`).

- **Chat**: pick an approved project, send a prompt (streamed output), continue a past session, read past sessions.
- **Runs**: active and recent runs, read output, stop a run.
- **Usage**: the 5-hour and weekly windows from `claude_usage` (cached values, with staleness shown).
- **Simplified view**: a plain-language summary of the live conversation, written by a cheaper model.

The page talks only to a local Node process, which starts the MCP server (`dist/src/index.js`) as a child over stdio and calls its tools. The run store, approved-project list, permission rules and secret masking all stay in the server and are not duplicated; the web layer additionally runs the server's `deepMask` over everything it sends to the page. `src/` is untouched.

## Start

```sh
npm install
npm run web            # builds, then starts on http://127.0.0.1:8787
```

Options: `node web/server.mjs --port 9000 --open` (`--open` opens the browser on macOS).

The projects you can pick come from the same `config.json` the MCP server uses (see the main README). Runs started here are children of the MCP server child, so they end (as `interrupted`) when you stop the web process.

## Open in the browser

The start command prints a URL like `http://127.0.0.1:8787/?token=…`. Open it. The page removes the token from the address bar after loading. Re-open from the same printed URL, or read the token from the token file:

```sh
open "http://127.0.0.1:8787/?token=$(cat "$HOME/Library/Application Support/claude-code-mcp/web-token")"
```

## Security

- Binds `127.0.0.1` only (not configurable).
- A random 256-bit token is required on every request (`Authorization: Bearer` or the `token` query parameter for the first page load). It lives in `web-token` in the data dir, created with mode 600; the server refuses to start if the file is group/world readable. Delete the file to rotate it.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; any `Origin` must be the same origin. Anything else gets 403. POSTs must be `application/json`.
- Strict CSP; the page renders server text with `textContent` only. Prompts and output are treated as data.
- New runs default to `plan`. The UI offers `plan` and `acceptEdits`; `bypassPermissions` is still refused by the server unless it runs with its env gate.

## Simplified view and the summarizer

When enabled, the web process takes the conversation text (run output, or the last turns of a session), masks it, caps it (newest ~24k characters kept), wraps it as inert data, and sends it on **stdin** to the local `claude` CLI run as `claude -p --model <model> --tools "" --no-session-persistence` in an empty temp directory with a scrubbed environment. No tools, no files, nothing saved. That model call is the only place the text goes; there is no other network call or logging. The summary is masked again before display.

Model: `haiku` by default. Change it with `CLAUDE_MCP_WEB_SUMMARY_MODEL=sonnet npm run web` (any alias or model id).

## Environment

| Variable | Default |
| --- | --- |
| `CLAUDE_MCP_WEB_PORT` | `8787` |
| `CLAUDE_MCP_WEB_TOKEN_FILE` | `<data dir>/web-token` |
| `CLAUDE_MCP_WEB_SUMMARY_MODEL` | `haiku` |
| `CLAUDE_MCP_*` (data dir, config, claude bin…) | passed through to the MCP server |

## Tests

`npm test` runs the existing server tests plus `web/test/*.test.mjs` (token check, Host/Origin check, summarizer input handling, HTTP routes with a fake tool backend).
