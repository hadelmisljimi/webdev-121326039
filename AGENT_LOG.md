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
- **Goal:** Build and verify MCP server from scratch without frameworks.
- **Prompts used:** Asked for protocol explanation, readline usage, and error handling.
- **Checkpoints used:** `node mcp-server/check.mjs -- node mcp-server/server.js` (12/12 passed).
- **What went wrong:** Handled protocol errors (-32601 and -32602) and missing lectures (`isError: true`).
- **Manual changes:** Implemented `server.js` using native Node.js `readline`, `fs`, and `path` modules.