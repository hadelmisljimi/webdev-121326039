# Readiness report: Study Group Manager (`webdev-121326039`)

## 1. Live URL and how to verify it
- Live URL: `https://webdev-121326039.onrender.com`
- Verify `GET /health` returns HTTP `200` with `{"status":"ok","db":"ok"}` and open the app over `https://` without browser TLS warnings.
- Sign in (via local credentials or Google OAuth) and verify study groups list, create/join actions, and AI recommendations.
- How I checked: Checked `GET https://webdev-121326039.onrender.com/health` (`HTTP/1.1 200 OK`), opened the live URL over HTTPS, and ran `node checks/ex4.mjs https://webdev-121326039.onrender.com` (`34/34 checks passed`).

## 2. Environment variables

| Variable | Purpose | Where value comes from | Secret? |
|---|---|---|---|
| `PORT` | Port HTTP server listens on | Render runtime or local `.env` / default `3000` | No |
| `DATABASE_URL` | PostgreSQL connection string for Neon database | Neon project connection string | Yes |
| `SESSION_SECRET` | Signs and verifies session cookies (`sgm_session`) | Generated via `openssl rand -hex 32` | Yes |
| `PUBLIC_BASE_URL` | Public base URL for callbacks and links | Render service URL (`https://webdev-121326039.onrender.com`) | No |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client identifier | Google Cloud Console OAuth credentials | Yes |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret | Google Cloud Console OAuth credentials | Yes |
| `GEMINI_API_KEY` | API key for AI study group recommendations (optional fallback) | Model provider console / environment | Yes |

- Startup checks stop early with a clear message when required variables (`DATABASE_URL`, `SESSION_SECRET`) are missing, while keeping optional fallback behavior when model keys are absent.
- How I checked: Verified `.env.example` lists variables without secrets, `.env` is untracked/gitignored, and startup validation fails cleanly on missing required variables.

## 3. What happens when things fail
- **Database unavailable**: `/health` returns HTTP `503` (`{"status":"error","db":"down"}`) and routes return clean error responses without crashing the process or leaking stack traces.
  - How I checked: Tested unreachable `DATABASE_URL` behavior and verified `503` on `/health` and clean error handling.
- **Bad deploy and rollback**: CI checks run on commits (`After CI Checks Pass` in Render) and Render Events supports rolling back to a previous release.
  - How I checked: Checked GitHub Actions workflow status and Render deployment/rollback controls.
- **Invalid or unauthenticated write requests**: Malformed JSON returns `400` with a single message (never a stack trace) and unauthenticated writes return `401`/`403`.
  - How I checked: Sent malformed JSON and unauthenticated write requests via `curl` and verified status codes without stack traces.

## 4. Four states of one screen
- **Loading**: Shows loading indicator (`loading.jfif`) while study groups and recommendations are fetched.
- **Content (`Success`)**: Shows active study groups, capacity counts, actions, and confirmation state (`success.jfif`).
- **Empty**: Shows empty-state prompt and action button when no groups match or exist (`empty.jfif`).
- **Error**: Shows clear error banner/message when a request fails or group capacity is full (`error.jfif`).
- How I checked: Inspected UI states and added `loading.jfif`, `success.jfif`, `empty.jfif`, and `error.jfif` under `docs/screenshots/`.

## 5. Request waterfall
- Initial page load fetches static assets/HTML and bootstrap state, followed by API requests (`/api/groups`, `/api/auth/me`, recommendations/actions) as client scripts run.
- Disabling cache and throttling network in browser DevTools shows request ordering, sequential dependencies, and total finish time.
- How I checked: Inspected the browser DevTools Network tab with cache disabled and network throttling enabled.

## 6. Security basics checked
- **Secrets scan**: Checked tracked files and full Git history (`git log -p`) for secrets, passwords, tokens, or API keys; no real secrets are present in repository history.
  - How I checked: Ran regex secret scan across `git log -p` and verified `.env` is ignored.
- **HTTPS**: Live application is served over `https://webdev-121326039.onrender.com` with TLS enabled.
  - How I checked: Opened `https://webdev-121326039.onrender.com` in browser and checked `/health` over HTTPS.
- **Authentication & ownership on write endpoints**: Write endpoints require authentication (`401`/`403` without login) and enforce ownership/membership checks before mutating or deleting data.
  - How I checked: Tested write endpoints without authentication and across user accounts.
- **Session cookie flags**: `sgm_session` uses signed session values with `HttpOnly`, `SameSite`, and `Secure` (in HTTPS/production) flags.
  - How I checked: Verified session cookie flags and `Set-Cookie` behavior.

## 7. Known gaps, ranked by risk
1. **Free-tier cold starts and database idle suspend**: Render free web services can sleep after inactivity and Neon compute can suspend when idle, slowing initial requests after pause.
   - Next step: Keep health checks clear and document expected cold-start delay.
   - How I checked: Compared initial cold request time with warm requests on `https://webdev-121326039.onrender.com`.
2. **Brute-force rate limiting on authentication routes**: Login routes do not yet enforce strict rate limiting or temporary lockouts after repeated failed attempts.
   - Next step: Add rate-limiting middleware on `/api/auth/*` routes and add tests.
   - How I checked: Reviewed authentication route handlers for rate-limit enforcement.
3. **Granular ownership/role edge-case tests**: Additional automated tests for cross-user `403` checks across secondary mutation endpoints would harden regression coverage.
   - Next step: Add explicit non-owner/non-member test cases for all write routes.
   - How I checked: Reviewed write route authorization checks across controllers/services.

## 8. Model feature
- **What leaves the app**: Only non-sensitive study-group context/preferences needed for recommendations (no passwords, session secrets, or unnecessary personal data).
- **Cost per request**: Small prompt/response token count; based on Gemini API list pricing (checked November 2026), one call costs well under `$0.001`.
- **When the provider is down**: `services/aiService.js` falls back cleanly to local/rule-based recommendations without breaking the page or group management.
- How I checked: Tested AI service with key set, unset, and fallback path via unit tests (`npm run coverage`).

## 9. MCP
- **Who may call & what it grants**: Only the local developer/client process running `mcp-server/server.js` over stdio may invoke its tools, acting as that local user session and granting read-only access to local course/lecture data (not user accounts, session secrets, or live database mutations).
- **Production stance**: Not exposed on the public production URL (`https://webdev-121326039.onrender.com`), keeping internal tooling isolated.
- How I checked: Inspected `mcp-server/server.js` and ran `node mcp-server/check.mjs -- npm run --silent mcp`.
