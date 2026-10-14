# Agent instructions

## Commands
- Install: `npm install`
- Run: `npm run mcp`
- Test: `npm test`

## Conventions
- Write clean and maintainable code.
- Follow existing patterns in the repository.

## The always-ask list
- Do not destroy data.
- Do not change auth logic.
- Do not modify core configuration without asking.

## MCP server
- The project includes an MCP server in `mcp-server/server.js`.
- The agent will add tools; tell it they go through the service layer.