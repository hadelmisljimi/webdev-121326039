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

## 2026-10-14 · MCP server from scratch
- Goal: Build a custom MCP server from scratch using Node.js without frameworks.
- Delegated: Asked for protocol explanations, readline handling, and error codes.
- Checkpoints: node mcp-server/check.mjs -- npm run --silent mcp (12/12 passed).
- Went wrong: Handling non-existent lectures required isError: true instead of crashing, and logging had to stay out of stdout.
- Changed by hand: Written server.js manually using readline, fs, and path modules, and configured package.json.