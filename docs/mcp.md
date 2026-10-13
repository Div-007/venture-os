# Hosted MCP for Venture Studio OS

Team members connect Claude Code (and later Claude Desktop and claude.ai) to the workspace so Claude can read their work,
check for new tasks every hour, and make small, safe updates. This document is the plan and the reference.

## Two connectors (2026-10-09)

Claude gets two separate connectors so each tool list stays short and they never conflict. Same token model, rate limits and
loopback allowlist; a token's scopes still decide which tools it sees on either endpoint.

| Connector | Address | Tools |
|---|---|---|
| **Venture Studio** | `POST /mcp` (server `venture-studio`) | everything below: tasks, reviews, knowledge, decisions, channels, calendar, reminders, `list_ventures`, `find_person`. No sales tools, and the older deal tools are retired. |
| **Dealflow Sales** | `POST /mcp/sales` (server `dealflow-sales`) | the sales workflow (`start_sales`, `find_leads`, `get_lead`, `save_verdict`, `save_draft`, `review_draft`, ...) plus `list_ventures` and `find_person`. Prompts `sales` and `review_drafts`. See `docs/sales-dealflow.md` section 9. |

Token presets on the Connect Claude page: Studio (read only, or read and update) and Dealflow Sales (`sales:read` +
`sales:write` + `ventures:read`). The rest of this document describes the Venture Studio connector.

## Decisions

- **One endpoint per connector**: `POST /mcp` on the API, served at `https://os.buildory.dev/mcp` through the web app's existing proxy
  (the Cloudflare Tunnel already reaches the web app). Stateless Streamable HTTP with plain JSON responses: no sessions,
  no SSE, so tunnel and proxy timeouts do not matter. `GET`/`DELETE /mcp` return 405.
- **Tools call the product API, never the database.** Each tool makes an in-process loopback request to `/v1/...` as the
  token's owner, using a per-process internal credential. Every permission rule, archived-venture rule, side effect,
  and audit entry is therefore identical to the app. The old stdio server re-implemented filters and leaked other
  ventures' outcomes and decisions (`get_venture_status`); it is removed.
- **Phase 1 auth is personal access tokens** (replaces the "hosted needs OAuth" rule for Claude Code). A token belongs to
  one person and one membership, is stored as a SHA-256 hash, has scopes, must expire (1-366 days), records last use,
  and can be revoked by its owner. Accepting an invitation revokes the person's older tokens. Phase 2 adds OAuth so
  claude.ai and Claude Desktop connectors can sign in; the same token check sits behind both.
- **Small, purposeful tools with compact output.** Names and short labels instead of raw ids where it helps, a link to
  the app page on every item, capped lists with `truncated`, text fields trimmed, and nulls dropped. Content people
  wrote (titles, comments, documents, messages) is returned inside an untrusted-data envelope, and the server
  instructions tell Claude to treat it as data, never instructions.
- **Cheap polling.** `whats_new` takes an opaque cursor and returns `{"changed":false,"cursor":...}` (about 40 tokens)
  when nothing happened, so an hourly loop costs almost nothing.
- **Writes are narrow and retry-safe.** Only low-risk updates, each through the existing route and its checks.
  Non-idempotent writes take a client `requestId`. The claim is stored before the write, so concurrent retries write
  once; a repeat returns the first result, and the same id with different arguments is refused. If the app timed out
  mid-write the id is marked unknown and Claude is told to check before retrying with a new id.
- **Scopes bound what each tool returns, not only which tools are listed.** `search` drops result types the token
  can't read and never returns direct messages; `venture_status` needs `tasks:read` and only includes decisions with
  `decisions:read`; `whats_new` only includes review requests with `tasks:read`. A write scope needs its read scope,
  and prompts are only offered when their tools are. Tool calls can never reach token, admin, invitation, or setup
  routes, even as the token's owner.
- **Switches and limits.** `MCP_ENABLED` and `MCP_WRITES_ENABLED` env flags; the production stack keeps MCP off unless
  `deploy\.env` sets `MCP_ENABLED=true`. Per-token rate limits (requests 120/min, writes 30/min) on top of the API's
  own per-person limits, which MCP calls count in a separate bucket so Claude never throttles the person's browser;
  30/min per IP before authentication. One JSON-RPC message per request (no batches), bodies up to 64 KB. Requests
  with an unexpected `Origin` header are refused (DNS-rebinding defence); command-line clients send none. Control
  characters and bidi overrides are stripped from people-written text.

## Tools (phase 1)

| Tool | Kind | Scope | Purpose |
|---|---|---|---|
| `whats_new` | read | `notifications:read` | New notifications and reviews waiting on me since a cursor; empty when nothing changed |
| `my_plate` | read | `tasks:read` | My open work (assigned to me and waiting for my review), grouped overdue / today / upcoming |
| `list_tasks` | read | `tasks:read` | Filter tasks by venture, status, assignee, blocked |
| `get_task` | read | `tasks:read` | One task with recent comments and evidence |
| `list_ventures` | read | `ventures:read` | Ventures I can open, with my role |
| `venture_status` | read | `ventures:read` + `tasks:read` | Task counts, overdue, blockers, active outcomes, recent decisions (with `decisions:read`) |
| `search` | read | `knowledge:read` | Search knowledge, plus tasks and channel messages when the token has those scopes |
| `get_document` | read | `knowledge:read` | One knowledge document (trimmed) |
| `decisions` | read | `decisions:read` | Recent decisions, optionally for one venture |
| `read_channel` | read | `messages:read` | Latest messages in a channel I belong to |
| `my_reminders` | read | `reminders:read` | My upcoming reminders |
| `set_task_status` | write | `tasks:write` | Move my task to another status (with a blocker note when blocked) |
| `add_task_comment` | write | `tasks:write` | Comment on a task |
| `add_evidence` | write | `tasks:write` | Attach a link or note as evidence |
| `set_reminder` | write | `reminders:write` | Remind me at a time, optionally about a task |
| `snooze_reminder` | write | `reminders:write` | Snooze one of my reminders (with `requestId`) |
| `mark_notifications_read` | write | `notifications:write` | Mark my notifications read |

Prompts (slash commands in Claude Code): `today`, `standup`, `triage`.

Not exposed here: deleting or archiving anything, membership and admin changes, DMs without their scope, and anything sales (that is the Dealflow Sales connector).

## Supporting API changes

- `GET /v1/tasks` accepts `reviewerId`.
- `POST /v1/reminders` lets a member set a personal reminder (optionally on a task they can open).
- `GET/POST /v1/pats`, `POST /v1/pats/:id/revoke` work in production when MCP is enabled; tokens carry the membership id.

## Connecting (shown in the app on the Connect Claude page)

```
claude mcp add --transport http venture-studio https://os.buildory.dev/mcp --header "Authorization: Bearer <token>"
claude mcp add --transport http dealflow-sales https://os.buildory.dev/mcp/sales --header "Authorization: Bearer <token>"
```

The first is the Venture Studio connector, the second Dealflow Sales; add either or both.

Hourly check in Claude Code: `/loop 1h use whats_new and tell me only if something changed`. In Claude Desktop, a
scheduled task with the same prompt shows a desktop notification.

## Phases

1. **Now**: everything above, tested locally, then deployed on approval.
2. **OAuth and in-chat views**: OAuth 2.1 (protected-resource metadata, authorization-server metadata, PKCE S256,
   dynamic client registration) so claude.ai and Claude Desktop connectors work per person; allow Anthropic's egress
   range (160.79.104.0/21) through Cloudflare; one MCP App "Today" view for claude.ai and Desktop (Claude Code shows
   text only).
3. **More writes**: post to a channel, create tasks (leads), with confirmation on anything broad.

## Test plan

- API tests: token create, list, revoke, expiry, scopes, invitation-accept revocation; MCP auth failures (missing,
  wrong, revoked, expired, inactive membership); every tool's permission boundary (other venture, archived venture,
  other person's reminder); write tools including idempotent retries; `whats_new` cursor behaviour; Origin check;
  rate limit; kill switches.
- Live checks with a real MCP client against the local dev server and dummy data, driven by test agents, covering every
  tool and prompt plus token cost of typical calls.
