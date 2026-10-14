# Agent log

One entry per agent session, newest at the bottom. Be honest: what went wrong is the useful part.

<!-- Copy this block for each session:

## YYYY-MM-DD · <short title>
- Goal:
- Delegated:
- Checkpoints:
- Went wrong:
- Changed by hand:

-->
### Session 1 - 2026-10-14
- **Goal:** Build a custom MCP server from scratch using Node.js standard modules without frameworks.
- **Prompts used:** Asked for protocol explanations, reading stdio with `readline`, handling `initialize` handshake, listing tools, and handling protocol errors (-32601 and -32602).
- **Checkpoints used:** `node mcp-server/check.mjs -- node mcp-server/server.js` (12/12 checks passed).
- **What went wrong:** Handling non-existent lectures (required `isError: true` instead of crashing) and preventing stdout output during logging.
- **Manual changes:** Written `mcp-server/server.js` by hand using `readline`, `fs`, and `path`. Configured `package.json` with `--silent` npm execution.