# Exercise 1 · MCP server

Your hand-written MCP server lives in this folder. Write it in any language you like. The full task is on the exercise page; this file is the short version plus your notes.

## What is already here

| File | What it is |
|---|---|
| `lectures.json` | The course lectures. Your first tool reads this file. |
| `messages.jsonl` | The messages a client sends, in order, with what your server must answer. |
| `check.mjs` | The self-check. It starts your server, sends those messages and tells you what is wrong. |

## The two tools

1. **`find_lecture`**: everyone writes this one. Input: `number` (1 to 10). It returns the title and topics of that lecture from `lectures.json`. A number outside the range is not a crash and not a protocol error: it is a result with `isError: true` and a readable message.
2. **One of your own**: anything useful that reads local data. Give it a description a model can choose by. Every tool needs one: the self-check applies the same rule to all of them, because a description is the only thing a model reads when it decides what to call.

## Where this goes next

Do not throw this folder away after Exercise 1. From Exercise 3 it becomes **your project's own MCP server**: the same protocol loop, with the tools rewired from `lectures.json` to your real data. Its tools call exactly the same service functions your HTTP routes call, so a tool obeys the same rules an API request does, and it carries a user (the `MCP_TOKEN` in `.env.example`) so it may do what that person may do and no more.

That is the whole design, and it is one sentence: **one set of rules, two front doors.** An MCP tool that writes its own database query is a second way into your data with none of your rules on it, and Exercise 5 is very good at finding those.

Add an `mcp` script to `package.json` (`"mcp": "node mcp-server/server.js"`) so your agent, CI and the lecturer can all start the server the same way.

## Run the self-check

```bash
node mcp-server/check.mjs -- <your start command>
# for example
node mcp-server/check.mjs -- node mcp-server/server.js
node mcp-server/check.mjs -- python3 mcp-server/server.py
# once you have added the mcp script
node mcp-server/check.mjs -- npm run --silent mcp
```

It prints one line per check. Fix the failures yourself: the agent may explain a message or review your handler, but it must not write the protocol code for you.

## How to start it
<!-- The exact command, so the lecturer can run your server too. -->
npm run --silent mcp

## Session transcript
<!-- Paste one full session: initialize, the reply, tools/list, one good tools/call, one that fails. -->
echo 'Workspace ready. Start the agent with: gemini'
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ echo 'Workspace ready. Start the agent with: gemini'
Workspace ready. Start the agent with: gemini
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ ls mcp-server
README.md  check.mjs  lectures.json  messages.jsonl
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ node mcp-server/check.mjs -- node mcp-server/server.js
ok   initialize answered
ok   notification gets no reply
ok   tools/list returns your tools
ok   find_lecture has an input schema
ok   find_lecture has a real description
ok   a second tool of your own
ok   every tool has a real description
ok   find_lecture returns lecture 5
ok   a lecture that does not exist is a tool error
ok   unknown tool is a protocol error (-32602)
ok   unknown method is a protocol error (-32601)
ok   nothing but protocol on stdout

12/12 checks passed
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ npm init -y
npm pkg set scripts.mcp="node mcp-server/server.js"
Wrote to /workspaces/webdev-121326039/package.json:

{
  "name": "webdev-121326039",
  "version": "1.0.0",
  "description": "This repository is your workspace for the whole course: Exercise 1 in `mcp-server/`, and your project (Exercises 2–5) in the rest of it. Everything runs in your browser through GitHub Codespaces, so nothing needs to be installed on your laptop.",
  "main": "index.js",
  "directories": {
    "doc": "docs"
  },
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/hadelmisljimi/webdev-121326039.git"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "bugs": {
    "url": "https://github.com/hadelmisljimi/webdev-121326039/issues"
  },
  "homepage": "https://github.com/hadelmisljimi/webdev-121326039#readme"
}



@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ node mcp-server/check.mjs -- npm run --silent mcp
ok   initialize answered
ok   notification gets no reply
ok   tools/list returns your tools
ok   find_lecture has an input schema
ok   find_lecture has a real description
ok   a second tool of your own
ok   every tool has a real description
ok   find_lecture returns lecture 5
ok   a lecture that does not exist is a tool error
ok   unknown tool is a protocol error (-32602)
ok   unknown method is a protocol error (-32601)
ok   nothing but protocol on stdout

12/12 checks passed
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ node mcp-server/server.js
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"1.0.0"}}}
got: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"lectures","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
got: {"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
got: {"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"find_lecture","description":"Return the title and topics of one course lecture by its number, 1 to 10. Use it when asked what a lecture covers.","inputSchema":{"type":"object","properties":{"number":{"type":"integer","description":"Lecture number, 1 to 10"}},"required":["number"]}},{"name":"list_lectures","description":"List the number and title of every course lecture. Use it when asked what the course covers.","inputSchema":{"type":"object","properties":{}}}]}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":5}}}
got: {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":5}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Lecture 5: What the agent built, part 1. Topics: HTTP, REST vs GraphQL, data modeling, ORM, layers"}],"isError":false}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":99}}}
got: {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":99}}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"There is no lecture 99. The course has lectures 1 to 10."}],"isError":true}}
^C
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $

## The description experiment
<!-- Three sentences: what you changed in the description, whether the model chose the tool differently, and why you think so. -->
ENG
I tested how changing the tool description affects the model choice. When I made the description vague, the model was less likely to select the correct tool automatically. Providing a clear and specific description with clear instructions ensured the model reliably triggered `find_lecture`.
BG
Тествах как промяната в описанието на инструмента влияе върху избора на модела. Когато описанието беше неясно, вероятността моделът автоматично да избере правилния инструмент намаляваше. Предоставянето на ясно и конкретно описание с точни инструкции гарантираше, че моделът надеждно задейства `find_lecture`.
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ node mcp-server/check.mjs -- node mcp-server/server.js
ok   initialize answered
ok   notification gets no reply
ok   tools/list returns your tools
ok   find_lecture has an input schema
ok   find_lecture has a real description
ok   a second tool of your own
ok   every tool has a real description
ok   find_lecture returns lecture 5
ok   a lecture that does not exist is a tool error
ok   unknown tool is a protocol error (-32602)
ok   unknown method is a protocol error (-32601)
ok   nothing but protocol on stdout

12/12 checks passed
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ node mcp-server/server.js
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":5}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":99}}}got: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"lectures","version":"0.1.0"}}}
got: {"jsonrpc":"2.0","method":"notifications/initialized"}
got: {"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"find_lecture","description":"Return the title and topics of one course lecture by its number, 1 to 10. Use it when asked what a lecture covers.","inputSchema":{"type":"object","properties":{"number":{"type":"integer","description":"Lecture number, 1 to 10"}},"required":["number"]}},{"name":"list_lectures","description":"List the number and title of every course lecture. Use it when asked what the course covers.","inputSchema":{"type":"object","properties":{}}}]}}
got: {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":5}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Lecture 5: What the agent built, part 1. Topics: HTTP, REST vs GraphQL, data modeling, ORM, layers"}],"isError":false}}
^C
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ npm init -y
npm pkg set scripts.mcp="node mcp-server/server.js"
Wrote to /workspaces/webdev-121326039/package.json:

{
  "name": "webdev-121326039",
  "version": "1.0.0",
  "description": "This repository is your workspace for the whole course: Exercise 1 in `mcp-server/`, and your project (Exercises 2–5) in the rest of it. Everything runs in your browser through GitHub Codespaces, so nothing needs to be installed on your laptop.",
  "main": "index.js",
  "directories": {
    "doc": "docs"
  },
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1",
    "mcp": "node mcp-server/server.js"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/hadelmisljimi/webdev-121326039.git"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "bugs": {
    "url": "https://github.com/hadelmisljimi/webdev-121326039/issues"
  },
  "homepage": "https://github.com/hadelmisljimi/webdev-121326039#readme"
}



@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ node mcp-server/check.mjs -- npm run --silent mcp
ok   initialize answered
ok   notification gets no reply
ok   tools/list returns your tools
ok   find_lecture has an input schema
ok   find_lecture has a real description
ok   a second tool of your own
ok   every tool has a real description
ok   find_lecture returns lecture 5
ok   a lecture that does not exist is a tool error
ok   unknown tool is a protocol error (-32602)
ok   unknown method is a protocol error (-32601)
ok   nothing but protocol on stdout

12/12 checks passed
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ git add -A
git commit -m "Exercise 1: MCP server"
git push
[main b888bb9] Exercise 1: MCP server
 4 files changed, 46 insertions(+), 16 deletions(-)
Enumerating objects: 13, done.
Counting objects: 100% (13/13), done.
Delta compression using up to 2 threads
Compressing objects: 100% (7/7), done.
Writing objects: 100% (7/7), 1.27 KiB | 1.27 MiB/s, done.
Total 7 (delta 6), reused 0 (delta 0), pack-reused 0 (from 0)
remote: Resolving deltas: 100% (6/6), completed with 6 local objects.
To https://github.com/hadelmisljimi/webdev-121326039
   b1b3a35..b888bb9  main -> main
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ node mcp-server/server.js
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"1.0.0"}}}
got: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"me","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"lectures","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
got: {"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
got: {"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"find_lecture","description":"Return the title and topics of one course lecture by its number, 1 to 10. Use it when asked what a lecture covers.","inputSchema":{"type":"object","properties":{"number":{"type":"integer","description":"Lecture number, 1 to 10"}},"required":["number"]}},{"name":"list_lectures","description":"List the number and title of every course lecture. Use it when asked what the course covers.","inputSchema":{"type":"object","properties":{}}}]}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":5}}}
got: {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":5}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Lecture 5: What the agent built, part 1. Topics: HTTP, REST vs GraphQL, data modeling, ORM, layers"}],"isError":false}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":99}}}
got: {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"find_lecture","arguments":{"number":99}}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"There is no lecture 99. The course has lectures 1 to 10."}],"isError":true}}
^C
@hadelmisljimi ➜ /workspaces/webdev-121326039 (main) $ 
