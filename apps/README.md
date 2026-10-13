# Apps

| App | What it runs | Start in development |
|---|---|---|
| [`api`](api) | Express HTTP API, Better Auth, Socket.IO, uploads, search, Sales, and the two MCP servers for Claude (`/mcp`, `/mcp/sales`) | `npm run dev --workspace @venture-studio/api` |
| [`web`](web) | Next.js web app (the live app is under `/…/live`) | `npm run dev:web` |
| [`worker`](worker) | Reminders, calendar reminders, and the notification outbox (in-app, Web Push, email) | `npm run dev --workspace @venture-studio/worker` |

Overview, features and tests: [../README.md](../README.md).
