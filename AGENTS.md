# Venture Studio OS agent instructions

Product overview: [README.md](README.md). The problem we solve: [PROBLEM_STATEMENT.md](PROBLEM_STATEMENT.md).

## Shared workflow

- Treat `TODO.md` as the delivery ledger. Update checkboxes only when the matching work and verification are complete.
- Preserve the hierarchy `Workspace -> Ventures -> Groups -> Channels` and the decision log in `docs/architecture.md`.
- Keep changes scoped to the task's ownership area. Do not overwrite unrelated or user-authored changes.
- Before handing off a milestone, run the most relevant lint, typecheck, build, and smoke tests and record any limitation.
- For a create action launched inside an active venture, group, channel, or other scoped context, use that context as the parent automatically. Show the destination read-only for confirmation; do not ask the user to select the same parent again. Test the entry point, submitted parent ID, and resulting scope before handoff.
- Important backend changes require an independent code-review subagent before completion. This is especially required for authentication/authorization, permissions, reminder scheduling, outbox/idempotency, uploads, and MCP access.

## Phase gate

The dashboard direction and whole-app implementation were explicitly approved on 2026-09-23. Continue to update `TODO.md` only after implementation and verification.

