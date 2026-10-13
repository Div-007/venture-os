# Backend agent instructions

- Use the installed `$ponytail` skill in full mode for backend implementation. Do not simplify away validation, authorization, durability, security, error handling, or the required smoke check.
- Use `$ponytail-review` as an additional over-engineering pass after the normal correctness/security review; it does not replace that review.
- The Phase 1 dashboard direction was approved on 2026-09-23; backend implementation is unblocked. Continue to derive contracts from approved product flows and avoid speculative features.
- Spawn an independent code-review subagent for important backend boundaries: authentication/authorization, membership permissions, reminder/outbox/idempotency, uploads, and MCP access.
- Run the smallest relevant runnable check during development, then the complete backend smoke suite before milestone handoff.

