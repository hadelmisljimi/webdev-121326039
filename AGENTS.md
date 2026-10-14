# Agent instructions

## Commands
- Install: `npm install`
- Run: `npm run mcp`
- Test: `npm test`

## Conventions
- Always write clean, well-commented JavaScript code using modern ES6+ syntax.
- Ensure all acceptance criteria are thoroughly tested and tracked.
- Never hardcode secrets or API keys; always use environment variables via `.env`.

## The always-ask list
- Asking before deleting code or data, modifying database schemas, or changing authentication/security logic.

## MCP server
- The project includes a hand-written MCP server located in `mcp-server/server.js`, started via `npm run --silent mcp`.
- The agent will add tools; tell it they go through the service layer.