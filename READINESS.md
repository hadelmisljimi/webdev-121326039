# Readiness Checklist / Готовност за стартиране и разполагане

## Environment Variables / Променливи на средата
- **Required at startup / Задължителни при старт:** `DATABASE_URL`, `SESSION_SECRET` (validated in `config.js`; app exits with `process.exit(1)` if missing).
- **Optional / Опционални:** `PORT` (default `3000`), `PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, `MODEL_NAME` (`gemini-1.5-flash`), `MCP_TOKEN`.
- Never commit `.env` or real secrets; use `.env.example` as template / Никога не качвайте `.env` или истински тайни в Git.

## Database & Health Check / База данни и Health проверка
- PostgreSQL (Neon) connected via `pg` `Pool` (`SELECT 1` on `GET /health` -> `200 OK` when connected, `503` when unreachable).
- Migrations in `migrations/` (`002_study_groups.sql`) and `users` table verified with persistent reads/writes.

## Auth, API & AI Fallback / Автентикация, API и AI резервен вариант
- Signed `HttpOnly` session cookie (`sgm_session`) using `SESSION_SECRET` (`GET /auth/me`, `POST /auth/login`, `POST /auth/register`, `POST /auth/logout`, `GET /auth/google`, `GET /auth/google/callback`).
- Protected group creation (`POST /api/groups` requires session -> `401` when unauthenticated) and AI recommendations (`POST /api/recommendations` falls back cleanly when `GEMINI_API_KEY` is missing or provider fails).
- MCP server (`npm run mcp`) verified (`12/12` checks passing).