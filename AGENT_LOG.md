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
## 2026-11-25 · Exercise 4 deployment and readiness report
- Goal: Deploy to Render with Neon PostgreSQL, enforce coverage gates, and complete READINESS.md and UI state evidence.
- Delegated: Drafted Dockerfile, .dockerignore, coverage gate script, READINESS.md structure, SPEC.md screen rendering table, and UI state screenshots.
- Checkpoints: Verified GET /health on https://webdev-121326039.onrender.com, added screenshots under docs/screenshots/, and ran node checks/ex4.mjs.
- Went wrong: Relying on container local disk or Render free temporary database assumptions would lose data across redeploys, so Neon PostgreSQL was used instead; initial combined screenshots were split into individual loading, error, empty, and success images.
- Changed by hand: Verified environment variables, checked git log -p for secrets, confirmed Render deployment and OAuth redirect URI, and inspected git diff --staged before pushing.

## 2026-11-25 · Exercise 5 preparation and defence notes
- Goal: Prepare Exercise 5 artifacts on own repository (`DEFENSE.md`, test/coverage checks, and session logs) while awaiting peer assignment.
- Delegated: Drafted `DEFENSE.md` sections and ran peer-review prompts; discarded the failed Gemini CLI call that returned `API_KEY_INVALID` (400).
- Checkpoints: Verified no leftover `peer-app`/`review-db` containers, checked `DEFENSE.md` placeholders, and ran `npm test`, `npm run coverage`, and `node checks/ex5.mjs`.
- Went wrong: Cannot complete peer review or `test(Rn)`/`fix(Rn)` commits for a partner before a partner is assigned, and the Gemini CLI session in the other environment failed with `API_KEY_INVALID`.
- Changed by hand: Authored `DEFENSE.md` in own words, verified `git status`, and logged sessions in `AGENT_LOG.md` and `USAGE.md`.
- R1 follow-up (`fix(R1)`): Verified ownership guard logic in `test/groups.test.js` while keeping all `AC-1`..`AC-13` tests intact.
