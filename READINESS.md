# Readiness Report / Готовност за разполагане

## Live URL
- Live URL: `https://webdev-121326039.onrender.com` (Docker deployment on Render free tier, Frankfurt region).
- How I checked: Verified `GET /health` returns HTTP `200`, served HTML page loads over `https://`, tested Google OAuth sign-in, and confirmed created records persist in Neon PostgreSQL across a manual redeploy.

## Environment variables
- Required at startup: `DATABASE_URL` (Neon PostgreSQL connection string), `SESSION_SECRET` (signing key for `sgm_session` cookie).
- Optional / deployment variables: `PORT` (default `3000`, Render injects `10000`), `PUBLIC_BASE_URL` (`https://webdev-121326039.onrender.com`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, `MODEL_NAME` (`gemini-1.5-flash`), `MCP_TOKEN`.
- How I checked: Verified `.env.example` holds non-secret placeholders, `.env` is ignored/not committed, and Render environment variables are configured for live execution.

## Failure behavior (what happens when things fail)
- Missing `DATABASE_URL` or `SESSION_SECRET`: startup validation in `config.js` fails fast with non-zero exit code so broken instances do not serve silently.
- Database unreachable: `GET /health` returns `503` when `SELECT 1` fails; group/auth endpoints return controlled error responses rather than crashing the process.
- Full group join or unauthenticated write: `joinGroup` rejects over-capacity joins with `409` (`"This group is full"`) and unauthenticated mutations return `401`.
- How I checked: Ran unit/acceptance tests (`npm test` / `npm run coverage`) and verified error status codes and live behavior on Render.

## Screen states (four states)
- Loading: form and fetch actions show active status while requests are in flight.
- Empty: empty group lists display guidance to browse or create a study group instead of a blank area.
- Error: validation, auth, and conflict errors render readable messages rather than raw stack traces.
- Success: creating, joining, or leaving a group updates the displayed state immediately and persists in PostgreSQL.
- How I checked: Exercised flows in browser on `https://webdev-121326039.onrender.com` and reviewed `docs/UI.md`.

## Request waterfall
- Initial page load (`GET /`) returns HTML; client/form actions call `/auth/*` and `/api/groups` or `/api/recommendations`, which query Neon PostgreSQL (`study_groups`, `group_members`, `users`) or call Gemini API with a 5s abort timeout.
- How I checked: Inspected route handlers in `server.js`, service calls in `services/groupService.js` and `services/aiService.js`, and browser network activity.

## Security checks
- Session cookies (`sgm_session`) are signed with `SESSION_SECRET` and marked `HttpOnly`; local passwords use `scrypt` hashing; OAuth callback is registered on `https://webdev-121326039.onrender.com/auth/google/callback`.
- Note: An earlier connection string was pasted during setup chat—rotate the Neon database password in the Neon console as a precaution.
- How I checked: Reviewed `server.js` auth/session handling, Google Cloud Console OAuth settings, and live Google login on Render.

## Known gaps (ranked by risk)
1. **High — Secret rotation after chat paste:** The Neon `DATABASE_URL` string appeared earlier in chat; rotating the DB password in Neon closes any exposure risk.
2. **Medium — Free-tier cold starts & test-mode OAuth:** Render free tier sleeps after inactivity (causing cold-start delay) and Google OAuth consent is restricted to listed test users until published.
3. **Low — AI service function coverage & UI screenshots:** `services/aiService.js` includes an un-triggered `setTimeout` abort callback in unit tests, and visual screenshot files in `docs/screenshots/` are still placeholders.
- How I checked: Audited code coverage output, Render free-instance behavior, and Google Auth Platform consent status.

## Model feature in production
- What data leaves the app: Only the user's study-group preference text prompt is sent in the POST body to `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent` with header `x-goog-api-key`; user passwords and session cookies never leave to the model.
- Cost per call: Priced per token by Gemini API (`gemini-1.5-flash` input/output tokens; e.g. fractions of a cent per typical short recommendation prompt—check current Gemini API pricing page on November 25, 2026 for exact rate).
- When provider is down / rate-limited / timed out: `services/aiService.js` enforces a 5000ms `AbortController` timeout and catches missing API key, non-OK HTTP responses (`429`/`5xx`), or network errors, returning `{ fallback: true, message: "AI recommendations are currently unavailable, please browse groups manually" }`.
- How I checked: Tested `services/aiService.js` with fake fetch clients covering success, non-OK status, and error fallback paths (`npm run coverage`).

## MCP server in production
- Who may call tools: Invoked locally/via stdio (`npm run mcp` -> `node mcp-server/server.js`) by an authorized MCP client/agent process; optional `MCP_TOKEN` env var can gate token-authenticated callers where configured.
- Permissions granted: Exposes MCP tools/resources for the workspace without granting direct shell execution or exposing raw `.env` secrets.
- How I checked: Checked `package.json` `"mcp"` script and `mcp-server/check.mjs` conformance setup.
