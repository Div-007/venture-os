# Live checks for Sales (Dealflow) in Venture OS

These scripts test the running local dev servers (web http://localhost:3000, API http://localhost:4000, dev database
`vso_dealflow_dev`). They create clearly labelled QA records ("QA ...") and delete them at the end. Nothing is ever
sent to anyone. Playwright comes from gstack's bundled copy (`~/.claude/skills/gstack/node_modules`), so nothing is
downloaded.

| Command | What it checks |
|---|---|
| `node tooling/sales-qa/run-all.mjs` | everything below, one summary, then removes the QA records for good (Venture OS `clean-sales-dev.ts --qa`) |
| `node tooling/sales-qa/flow.mjs` | the whole sales flow through the API as admin, venture head, seller, learner and an outsider: permissions, stages, review before send, WhatsApp opt-in, reply handling, won → delivery work, opt-out → do-not-contact, soft delete |
| `node tooling/sales-qa/mcp-flow.mjs` | the Dealflow Sales connector (/mcp/sales) over HTTP, and that Venture Studio (/mcp) has no sales tools: tools listed, no send/approve tools, work session vs review session, verdict → stage, draft → separate review → ready, Claude can't approve a lead for contact |
| `node tooling/sales-qa/ui-flow.mjs [--phone]` | clicks through the real screens: search, lead drawer, log a call, mark a reviewed draft sent, handle a reply in the Inbox, Pipeline |
| `node tooling/sales-qa/consent-flow.mjs [--phone]` | Claude logs "they said yes to WhatsApp" through the connector, WhatsApp stays closed, a person confirms it in the lead drawer, then WhatsApp opens |
| `node tooling/sales-qa/shots.mjs [--as user-shubham] [--only leads,review] [--variants phone-dark]` | screenshots of every Sales page on desktop and phone, light and dark, plus a report of console errors, failed API calls, overflow past the screen edge and small tap targets |

Screenshots go to `%LOCALAPPDATA%\Temp\claude\vso-qa\` unless `QA_OUT` is set. The click-through and screenshot scripts need
Playwright: they load it from gstack's copy; anyone without gstack can `npm i -D playwright` in a scratch folder and point
`createRequire` at it.

Run every command from the Venture OS repo root.

**Run it yourself:** `& .\tooling\sales-qa\start-local.ps1` in PowerShell (from the repo root) starts the
API, web app and notification worker in three windows and opens http://localhost:3000/sales/live (needs the MongoDB
Windows service running). If they're already running it just opens the page.

These scripts are live QA flows (Playwright), separate from the unit tests run by `npm test`; see the root [README.md](../../README.md#tests).
