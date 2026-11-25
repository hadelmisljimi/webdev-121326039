# Defence notes

## What it does

UniCloud is a web application for study groups where students register, sign in, create or join study groups, leave groups, and request study recommendations. It runs on Node.js with PostgreSQL (Neon in production) and includes a custom MCP server over stdio.

## The three files I will open

1. `services/aiService.js`, because it enforces the AI recommendation logic and fallback behavior when the model key is missing or the provider fails.
2. `mcp-server/server.js`, because it shows the boundary between the MCP tool layer and the application/data layer.
3. `server.js`, because it shows how HTTP routes, authentication/session handling, and database access connect in the main app.

## Decisions I can defend

- Stack: Chose Node.js with HTTP routing and PostgreSQL (`pg`) so the web app, tests, and MCP server stay in a single JavaScript runtime. Rejected a separate microservice or heavy frontend framework to keep deployment on Render and local testing straightforward. I would change my mind if concurrent load or complex client state outgrew server-rendered/API routes.
- Where the rules live: Kept core domain/service logic separated from transport/view code rather than scattering raw SQL across route handlers. Rejected putting all business rules inside route handlers because that makes reuse and testing harder. I would change my mind if a rule is purely HTTP/transport-specific (such as status code formatting).
- Authentication and authorization: Used `scrypt` password hashing, session handling, and Google OAuth alongside explicit checks on protected routes. Rejected plaintext or weak custom hashes and unauthenticated mutations. I would change my mind if requirements demanded federated SSO across external organizations or fine-grained RBAC roles.
- The model, and why that one: Integrated Gemini via `services/aiService.js` with a deterministic/safe fallback when `GEMINI_API_KEY` is absent or an upstream call errors. Rejected letting the app crash or expose raw provider errors when the external API is down. I would change my mind if latency or cost limits required switching models or disabling live calls.
- What the MCP server exposes, and what it deliberately does not: Exposes course/lecture tools over stdio (`mcp-server/server.js`) for local tooling. Deliberately does not expose user password hashes, session cookies/secrets, or unrestricted destructive production database writes over public HTTP. I would change my mind only behind strict authentication and explicit least-privilege scopes.
- The database shape: Structured around `users`, `study_groups`, and `group_members` with capacity tracking and foreign keys/constraints so membership and group state stay consistent. Rejected storing relational membership arrays inside a single JSON blob. I would change my mind if analytics or unstructured logs required a separate store.

## How I know it works

Automated tests cover core flows and acceptance criteria (`AC-1` through `AC-13` in `SPEC.md`), and coverage gates verify the service layer and overall project thresholds. Line and branch coverage numbers prove exercised paths, but they do not prove freedom from logic/authorization bugs, UI usability, or live network issues on their own. By hand, I verified `/health` returning `200` on `https://webdev-121326039.onrender.com`, checked UI states (`loading`, `empty`, `error`, `success`) documented in `docs/UI.md`, and ran `node checks/ex4.mjs` (`34/34`).

## What is wrong with it

Ranked by risk from `READINESS.md`:
1. High/Medium risk items around authorization/ownership edge cases on every mutating endpoint and input/error boundary handling that must be verified end-to-end against live data.
2. External dependency risk on Gemini API availability/rate limits and Render free-tier cold starts.
3. Remaining documentation/review items from Exercise 5 once peer review exchange is completed.

## The thing in this repository I did not write and cannot explain

I did not hand-author every line of generated configuration, middleware/session wiring, or test scaffolding produced with an agent, and I have not yet traced every edge case of session/cookie handling or MCP protocol framing line by line. I will inspect those exact lines before the defence so I can explain them accurately or state honestly where I am still verifying.
