# import-dealflow

Copies the owner's Dealflow sales data from the local SQLite file into the Venture OS dev database, so the Sales
screens can be built and tested on real data. The SQLite file is opened read-only. Nothing goes over the network.

```
# from the Venture-OS root
node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/scripts/import-dealflow.ts --dry-run   # counts only
node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/scripts/import-dealflow.ts             # import (safe to repeat)
```

Needs Node 22.13+ (built-in `node:sqlite`), the API seed already run (workspace, ventures, users, `pipeline-buildory`, indexes) and the
contracts built (`npm run build:packages`; without them documents are not validated).

| Flag | Meaning |
|---|---|
| `--dry-run` | Build and validate everything, print counts, write nothing (does not connect to MongoDB) |
| `--limit N` | Only the first N leads (worked leads come first) with their activities, drafts and verdicts |
| `--owner user-id` | Owner of imported leads (default `user-divyansh`; must exist in the target database) |
| `--sqlite path` | Other SQLite file (default `~/Documents/Dealflow Data/dealflow.sqlite3`) |
| `--only-worked` | Only the leads that have a CRM row (stage, note, activity), not every discovered company |
| `--include-junk` | Also import leads the engine marked off-topic or excluded (skipped by default) |
| `--refresh` | Also update the descriptive fields of untouched leads (see below). Default: insert only |
| `--allow-db name` | Confirms a target database whose name does not end in `_dev` |
| `--allow-host` | Confirms a `MONGODB_URI` host that is not localhost / 127.0.0.1 / ::1 (any `mongodb+srv` URI counts as remote) |

## Safety

- Refuses to run when `APP_MODE=production`, when the `MONGODB_URI` host is not local (unless `--allow-host`), when `MONGODB_DB` does not
  end in `_dev` (unless `--allow-db <that name>`), and always for `admin`, `config`, `local`, `laxmi_agro` and `library_flow_dev`.
- Writes only to `MONGODB_DB`. Checks the workspace, owner, ventures and pipelines exist first.
- Idempotent: ids are deterministic (`df-lead-<venture>-<lead id>`, `df-act-<id>`, `df-draft-<id>`, `df-verdict-<id>`, `df-brain-<id>`)
  and each row carries `externalRef { system: "dealflow-sqlite", id: "<table>:<key>" }`. Leads are matched by that externalRef and
  suppression entries by `key` (the API's unique indexes), everything else by `_id`. A row that already exists is never rewritten, so
  what people did in the app survives a re-run.
- Every document is checked against `@venture-studio/contracts` before it is written; invalid ones are dropped and reported.

## Contact routes

One route per value: an email route is one plain address, a phone or WhatsApp route is one number, `sourceUrl` is an http(s) page. A
multi-value route is split into separate routes; a route that still fails `contactRouteSchema` is dropped (counted in the output), not
the lead.

## Do-not-contact

`sales_suppression` rows are written with the API's `key` (`email:<address>`), and every lead gets `suppressKeys` from the API's own
`leadSuppressKeys` (imported from `apps/api/src/sales/suppression.ts`, not copied). A new lead is flagged `doNotContact` when one of its keys is
in the suppression list of SQLite or already in the target database (as the app does when it creates a lead).

## What `--refresh` touches

`--refresh` first inserts anything missing, exactly like a plain run. Then, for leads that nobody has edited since the import, it updates
only: `companyName`, `city`, `region`, `country`, `category`, `website`, `contactRoutes`, `observedSignal`, `tags` and the derived
`suppressKeys` (plus `updatedAt` and `importUpdatedAt`, set to the source timestamp). It never changes `stage`, `ownerId`, `nextAction`,
`nextActionAt`, `doNotContact`, `whatsappOptIn`, `verdict`, `needsYou`, `fitBand`, `fitReason`, `exitReason`, `lastTouchAt` or any other lead field,
and it never updates activities, verdicts, drafts (status, text, review, approval, sent/veto), brain items or suppression rows.

A lead counts as untouched when its `updatedAt` still equals the `importUpdatedAt` stored by the importer (every app edit stamps
`updatedAt` with the time of the edit). Leads imported before that marker existed count as untouched while their `updatedAt` is not later
than the first `sales.import` audit event. Soft-deleted leads and leads edited in the app are left alone and counted in the output. The
update is compare-and-set on `updatedAt`, so an edit made during the refresh wins.

## What maps to what

| SQLite | Venture OS |
|---|---|
| `crm_lead_index` (+ `crm_leads` note/stage, engine columns) | `opportunities` (stage `new→identified`, `shortlisted→researched`, `meeting→discovery_booked`, `won→invoice_contract`, `rejected→disqualified`) |
| `company_features` + `pages` (own-site contact pages) | `observedSignal`, `fitReason`, `contactRoutes` (email, phone, WhatsApp, enquiry or dealer form; each with the page URL, `publishedByCompany: true`) |
| `crm_activities` | `sales_activities` (status rows become notes with `stageFrom/stageTo`), `sales_drafts` (kind `draft`), `sales_verdicts` (`[CLAUDE VERDICT v1]` notes), draft `review` (`[CLAUDE REVIEW v1]` notes) |
| `managed_context_items` + versions | `sales_brain_items` (`offer`, `target_profile`; "message rules" playbooks → `message_rules`; the rest → `notes`) |
| `outbound_suppressions` | `sales_suppression` (with `key`) |

Not imported: leads of ventures other than Buildory and EditHood, off-topic/excluded leads (unless `--include-junk`), the legacy
`prospects`, `email_drafts`, `campaigns` and discovery tables.

## Cleaning the dev data (`clean-sales-dev.ts`)

Dev database only (same guards as the import). Every run that writes first saves the touched collections as EJSON under
`~/Documents/Dealflow Data/vso-dev-backups/<time>/`; `--dry-run` writes nothing.

    node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/scripts/clean-sales-dev.ts --qa --dry-run

- `--qa` removes the QA leads the Prospector checks create and delete, with their drafts, activities, verdicts, reminders, notices
  and find runs, and recounts the daily send counters. `tooling/vso-qa/run-all.mjs` runs it at the end.
- `--old-import` (run once on 2026-10-10) discarded the old engine's unsent drafts, put imported "researched" leads without a verdict
  back to "identified", and parked imported leads outside the target (office outside Chhattisgarh / Madhya Pradesh / Maharashtra /
  Odisha, no website, another trade, a directory or article page instead of the own site, or a big brand): tag `old-import-parked`
  + soft delete. 212 kept, 1,320 parked.
- `--restore-parked` brings every parked lead back.
