# API

Express 5 API and Socket.IO gateway backed by MongoDB. Better Auth owns identity/session and magic links; `memberships` remains the only application authorization source.

Local setup from the repository root:

```powershell
Copy-Item .env.example .env
$env:MONGODB_URI='mongodb://127.0.0.1:27018/venture_studio_dev?replicaSet=ventureStudio'
$env:MONGODB_DB='venture_studio_dev'
$env:ALLOW_DEV_AUTH='true'
npm run migrate --workspace @venture-studio/api
npm run seed --workspace @venture-studio/api
npm run dev --workspace @venture-studio/api
```

The sanitized seed supports `x-dev-user-id: user-divyansh` only when `APP_MODE=local` and `ALLOW_DEV_AUTH=true`. Never enable it in production.

Primary route groups are documented in [`docs/backend-api.md`](../../docs/backend-api.md). Hosted MCP for Claude Code is served at `/mcp` (Venture Studio) and `/mcp/sales` (Dealflow Sales) with personal access tokens (see [`docs/mcp.md`](../../docs/mcp.md)); OAuth for claude.ai and Claude Desktop is phase 2.

