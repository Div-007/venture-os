# Backend delivery sequence

Backend implementation was unblocked by explicit user approval on 2026-09-23. Derive contracts from approved UI flows and add only the code needed by the current milestone.

## Sequence from Phase 3

1. **Freeze the first use cases.** Convert approved UI flows into shared Zod request, response, error, and event envelopes. Keep presentation-only labels and formatting in the web app.
2. **Establish identity and tenancy.** Add Better Auth session and magic-link flows, then one app-owned authorization path for workspace, venture, group, and inherited channel membership.
3. **Persist the hierarchy.** Add only the MongoDB collections and indexes required by those flows, plus repeatable migrations/backfills and representative seed data.
4. **Complete the HTTP boundary.** Apply shared validation, authorization, structured request logging, audit records, and rate limits at the common boundary rather than per route.
5. **Add collaboration slices.** Ship channel messaging and subscription authorization first, then tasks, mentions, notifications, command preview/execution, and focus sessions as end-to-end slices.
6. **Add durable delivery.** Persist reminders and notification outbox entries with the state change; let the worker claim, retry, and idempotently deliver them with timezone-aware escalation.
7. **Add files, search, and MCP.** Authorize metadata first, issue short-lived R2 URLs second, and expose read-only MCP tools through the same permission checks used by HTTP and realtime access.
8. **Harden proven paths.** Add operational dashboards, recovery rehearsal, audits, browser coverage, and release checks only after the corresponding paths exist.

Authorization must preserve the recorded model: group membership is a subset of venture membership, V1 channels inherit group membership, and direct messages are workspace-wide. Do not introduce private-channel ACLs before a concrete approved use case.

## Frontend contract seams

These are boundaries to agree on, not endpoints to scaffold before the gate:

- **Session bootstrap:** current user, workspace access, effective roles, and selected venture/group context.
- **Hierarchy navigation:** stable opaque IDs and ordered workspace -> venture -> group -> channel summaries; `#general` is returned as ordinary channel data.
- **Dashboard read model:** one coarse response shaped by the approved dashboard, with server timestamps and urgency/status enums; money travels as minor units plus currency, and dates as ISO 8601 values.
- **Lists and detail:** cursor pagination and explicit filter/sort inputs; mutations return the canonical updated resource.
- **Errors:** a discriminated envelope with a stable code, safe message, field issues when applicable, and request ID.
- **Realtime:** a versioned event envelope with event ID, occurred-at time, actor, scope, type, and typed payload; reconnect uses a cursor rather than client time.
- **Commands:** parse to a typed preview, then execute that preview with an idempotency key; both steps expose permission failures and audit identity.
- **Reminders and notifications:** absolute scheduled time, IANA timezone, preference-aware delivery state, and canonical snooze/complete results.
- **Uploads:** create intent, constrained upload metadata, completion confirmation, and authorized short-lived download access; object keys are never treated as authorization.
- **MCP:** scoped PAT creation/revocation stays outside tool calls; tool results use the same resource IDs and authorization semantics as product APIs.

Names and payload fields should be finalized only when their first approved consumer exists.

## Test and review matrix

| Boundary | Smallest check while building | Milestone smoke evidence | Independent correctness/security review |
| --- | --- | --- | --- |
| Shared contracts | Schema accept/reject test plus inferred-type compile check | Web/API contract compatibility and error-envelope smoke | Normal review; Ponytail Review afterward |
| Auth and sessions | Valid, expired, replayed, and wrong-recipient magic-link/session cases | Sign in, refresh, sign out, and unauthenticated rejection | Required |
| Membership permissions | Table test for venture prerequisite, group subset, inherited channel, workspace-wide DM, and cross-tenant denial | Authorized read/write and forbidden subscription across two tenants | Required |
| MongoDB data shape | Unique/index constraint and repeatable migration/backfill check | Seed a clean database and upgrade a prior fixture | Normal review |
| HTTP boundary | Invalid input, request ID, rate-limit, and audit-record check | Representative read and mutation through the real server | Normal review |
| Realtime messaging | Join authorization, reconnect cursor, duplicate event, and fan-out check | Message -> mention -> notification across two clients | Required when permission/realtime boundaries change |
| Commands and tasks | Preview/execute permission, stale preview, and idempotency cases | `/assign` produces one task and one audit trail | Normal review; required if authorization changes |
| Reminder/outbox worker | Atomic state/outbox write, competing claims, retry, duplicate delivery, timezone/DST, snooze, and completion cases | Assignment -> reminder -> retry/escalation -> completion without duplicate delivery | Required |
| Uploads | Type/size constraint, tenant denial, expiry, and abandoned-upload cleanup check | Upload intent -> completion -> authorized download -> expired URL | Required |
| Search | Authorized-scope and deleted-resource exclusion check | Search across permitted messages, tasks, and documents only | Normal review |
| MCP | Scope, revocation, tenant isolation, audit, and API-parity cases | Local PAT read succeeds, forbidden read fails, revoked PAT fails | Required |

At every backend milestone, run lint, typecheck, unit/integration tests, and the complete backend smoke suite. Resolve findings from the independent normal review first; run Ponytail Review last to remove unnecessary complexity without weakening validation, authorization, durability, or error handling.
