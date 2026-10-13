# Sales (Dealflow) in Venture Studio OS

Status: build spec v1, 2026-10-09. Dealflow is the team's sales channel, built inside Venture OS's Sales area.
Claude (each person's own subscription, through the Dealflow Sales connector at `/mcp/sales`, see section 9) researches leads, judges fit,
drafts messages and reviews drafts in a separate pass; people own the rules, make calls, send messages and
approve. Background and decisions: Prospector repo `docs/SALES_APP_PLAN.md`, `docs/SALES_WORKFLOW.md`,
`docs/WHATSAPP_PLAN.md`, `docs/DESIGN_SYSTEM.md`.

Contracts: `packages/contracts/src/sales.ts`. Web client: `apps/web/src/lib/sales-api.ts`.

### Offers

A venture sells one or more **offers**, each one packet: who it is for, the gates a lead must pass, the signals the lead finder
looks for, what we say, the message rules and the price boundary. Every lead belongs to an offer, and Claude judges it against
that offer's approved packet; the lead finder searches with it. A packet is proposed as a draft version (by a person or Claude)
and a venture head approves it as a whole, in the app. The brain keeps only what every offer shares: notes and venture settings.
The spec (data, API, the connector's tools, the finder, the screens and the migration from the old brain kinds):
**`docs/sales-offers.md`**; contracts `packages/contracts/src/sales-offers.ts`; server `apps/api/src/sales/offers.ts` and
`apps/api/src/routes/sales-offers.ts`; migration `apps/api/scripts/migrate-offers.ts`.

## 1. Hard rules (never break)

- **Nothing is sent to a real person by the app in v1.** "Mark sent" records what a person sent from their
  own mail app or phone. `sentVia` other than `manual` is refused with `503 INTEGRATION_UNAVAILABLE` until
  the email lane (per-person SMTP) and the WhatsApp Cloud API lane are switched on by the owner.
- **No cold first WhatsApp.** A WhatsApp draft can be marked sent only when the lead has `whatsappOptIn`
  (they messaged us, or said yes on a call or by email). First touch is a call, or an email ending with a
  `wa.me` link.
- **One do-not-contact list for every venture.** An opt-out or hostile reply suppresses the company's
  routes and blocks every outbound action on it.
- **Stop on reply.** Any inbound reply on a lead discards its pending follow-up drafts.
- **Claude never approves its own work.** Play approval, offer approval, brain approval and first-batch person approval
  are refused when the request comes through MCP (`via = "claude"`). A Claude review of a Claude draft must
  come from a different session (`sessionId`) than the one that wrote it.
- Business contact data only (published by the company). No logged-in scraping.

## 2. Stages (SLS-01)

identified → researched → approved_for_contact → contacted → replied → discovery_booked → qualified →
proposal → invoice_contract → cash_collected → delivery → retained_referred, plus thinking, lost,
disqualified. Older names are accepted and migrated: `conversation → replied`, `won → invoice_contract`.

- Won = any of invoice_contract, cash_collected, delivery, retained_referred. Entering the first won stage
  sets `wonAt` and notifies the lead owner, the venture's heads and the admins (not the person who moved it): "Won: {company}", with Create delivery work.
- lost and disqualified need `exitReason`.
- UI grouping for the Pipeline board (7 columns): **New** (identified, researched, approved_for_contact),
  **Contacted**, **Talking** (replied, thinking), **Meeting** (discovery_booked, qualified), **Proposal**,
  **Won** (won stages), **Closed** (lost, disqualified; collapsed by default).

## 3. Who can do what (per venture, using Venture OS roles)

| Role | Sales rights |
|---|---|
| admin (owner) | everything in every venture |
| venture_head of the venture | everything in that venture: reassign, delete, approve plays, offers and brain notes, pause, activate or archive offers, override verdicts, first-batch approval, add to the do-not-contact list by hand |
| contributor, reviewer | create leads; on leads they own: edit, log calls and replies, write and send drafts, override the verdict with a reason; review and veto drafts in their ventures; propose offers, brain notes and plays |
| learner | read only |

Leads are visible to members of the venture (archive rules as elsewhere). Claude acts with the
token owner's rights, minus the approvals in §1 and the limits in §5 ("What Claude cannot do").

**Do-not-contact list**: opt-outs and hostile replies add their entries automatically; adding by hand is for a
venture head or admin; **removing an entry is for an admin only, with a written reason** (3-300 characters,
kept in the audit log). Admins see every entry; everyone else sees the entries made from leads of their own
ventures and the ones they made themselves.

## 4. API (all under `/v1/sales`, JSON envelopes `{ ok, data }`)

| Method | Path | Notes |
|---|---|---|
| GET | `/overview?ventureId&owner=me` | Today: replies waiting, calls due, follow-ups due, drafts to review, ready to send, needs you, won to hand over, stage counts, last 7 days |
| GET | `/leads?ventureId&pipelineId&stage=a,b&q&owner&needsYou&playId&verdict&region&city&category&contact&sort&offset&limit` | server-side filter + paging (thousands of leads); `region`, `city`, `category` are exact (any case, `none` = not set), `contact` is `phone` (phone or WhatsApp number), `email`, `whatsapp` (consent recorded) or `none` (no phone, WhatsApp or email route) |
| GET | `/pipeline-value?ventureId&owner=me&tz` | the pipeline in money for the Overview: one row per currency with open deals, open value, open weighted value, the weighted forecast for this and next calendar month (by expected close date; an open deal expected in an earlier month counts in this month), weighted value with no close date, and what was won this month; plus `openWithoutValue` (open leads with no value) and the two month keys. Same venture scoping as the list; months are cut in the Sales time zone (`tz` overrides) |
| GET | `/leads/facets?ventureId&stage&q&owner&region&city&category&contact…` | counts for the filter choices (same filters as the list, no sort or paging): `regions`, `cities` (with their region), `categories`, `contact`, and `notSet`; each group is counted with every other filter applied but not its own, like a shop sidebar. A state and its cities go together: the state counts ignore the chosen city. Case and spacing variants are one value. Same venture scoping as the list |
| POST | `/leads` | create; suppressed routes set `doNotContact`. A deal can carry `valueEstimateMinor` + `currency`, `expectedCloseAt` and `probability` (0 to 100); a lead created as `lost` needs a `lostReason` |
| GET | `/leads/:id` | lead + activities + drafts + verdicts |
| PATCH | `/leads/:id` | edit fields / stage (rules in §5); `expectedCloseAt` and `probability` take `null` to clear them; moving a lead to `lost` needs `exitReason` and a `lostReason` category (Claude's own moves default to `other`), and the category goes when the lead is reopened |
| DELETE | `/leads/:id` | soft delete (`deletedAt`); venture head/admin, or the owner before first contact |
| POST | `/leads/:id/activities` | log call/email/whatsapp/linkedin/meeting/note, in or out (rules in §5); `requestId` makes it idempotent |
| POST | `/activities/:id/handled` | clears an inbound item from the Inbox |
| POST | `/leads/:id/verdicts` | Claude verdict (§5) |
| POST | `/verdicts/:id/override` | person override with reason |
| GET | `/drafts?ventureId&status=a,b&owner=me` | with a small lead summary |
| POST | `/leads/:id/drafts` | create (`submit` true → in_review) |
| PATCH | `/drafts/:id` | edit text → back to in_review (clears review and approval) |
| POST | `/drafts/:id/review` | pass → ready, fail → needs_changes |
| POST | `/drafts/:id/approve` | person approval for a play's first batch (app only) |
| POST | `/drafts/:id/sent` | mark sent (manual only in v1) → out activity |
| POST | `/drafts/:id/veto`, `/drafts/:id/discard` | |
| GET | `/inbox?ventureId&handled&owner=me` | inbound activities with lead cards, unhandled first |
| GET/POST | `/plays`, PATCH `/plays/:id`, POST `/plays/:id/approve` | approve: venture head/admin, app only |
| GET/POST | `/find-runs?queue=true`, POST `/find-runs/:id/cancel`, POST `/find-runs/:id/queue` | plans for the lead finder (built in, §10a; an office PC engine can also work them, §10b). A saved plan (status `planned`, what Claude saves unless the person asked it to run) is queued in the app by its planner or a venture head, never by Claude; the offer must still be usable |
| GET/POST | `/offers?ventureId`, GET `/offers/:id`, PATCH `/offers/versions/:versionId`, POST `/offers/versions/:versionId/approve` and `/discard`, POST `/offers/:id/state` | offers and their packet versions: see `docs/sales-offers.md` (approve and state: venture head or admin, app only) |
| GET/POST | `/brain`, PATCH `/brain/:id`, POST `/brain/:id/approve` | the venture's shared notes and settings (kinds `notes`, `venture_settings`). New proposals of the old kinds `offer`, `target_profile` and `message_rules` are refused (400, pointing to offers), and so is approving an old draft of one. Approve archives the previous approved item with the same venture, kind and title. A proposal may also list `replaces` (up to 20 ids of APPROVED items of the same venture, any kind; else 400; duplicates dropped; a draft's PATCH can change it): approving it retires those still approved in the same transaction (`archivedBy`, `archivedAt`, `replacedBy`; one archived meanwhile is skipped), the answer and the audit carry `retired` (the same-title predecessor not counted), and every item shows `replacesItems` (`{ id, title, kind, version, status }`) |
| GET/POST | `/suppression`, DELETE `/suppression/:id` | workspace-wide list; delete needs an admin and a JSON body `{ reason }` |
| GET/PUT | `/settings?ventureId` | the venture's sales settings (§5); anyone who can open the venture reads (defaults when none are saved); a head or admin saves, in the app only; PUT replaces everything (what the body leaves out takes its default) |
| POST | `/leads/:id/enrich` | asks the lead finder to fill in the lead's contact details: joins the person's queued enrich run in the venture (made on the first request, up to 100 leads) and returns it; the lead's owner, a head or an admin (a person, or Claude as the token owner); refused when `doNotContact` (§10) |
| POST | `/leads/:id/whatsapp-opt-in` | a person records consent (`how`, optional `activityId`: the yes-on-call or the inbound WhatsApp); never Claude; refused when `doNotContact` |
| PATCH | `/activities/:id` | sort an inbound reply into a reply type afterwards (same rules as logging it with the type) |
| POST | `/brain/:id/archive` | head/admin any item; the proposer their own draft; never Claude for an approved item |
| POST | `/leads/:id/delivery-work` | creates a Venture OS task in the venture's first group/channel, assigned to the lead owner (or `assigneeId`), sets `deliveryTaskId` |
| POST | `/leads/bulk` | lists at scale (people only, never Claude): `{ ids }` (1 to 500) or `{ filter }` (the list filters: the 500 most recently updated leads NOT already in the target state, so the same call again reaches the next ones), never both, plus `action`: `assign` + `ownerId` (venture head or admin; the owner must be in the venture), `tag` / `untag` + `tag`, `stage` + `stage` (lost and not a fit need `exitReason`, lost a `lostReason`; won stages are refused in bulk, 400 "mark deals won one at a time"; a do-not-contact lead is skipped for a contact stage), `play` + `playId` (a play of the lead's venture), `offer` + `offerId` (an offer of the lead's venture, not archived), `delete` (the single delete's rule). Each lead is checked like a single edit, permission first, and skipped with a reason when refused. Answer: `{ action, matched, changed, unchanged, skippedCount, skipped (first 100: id, companyName, reason), truncated, remaining? }`; for a filter `unchanged` counts every matching lead already like that, and `remaining` (with `truncated`) the leads still to go. Audited once as `sales.lead.bulk`, plus the usual per-lead entries |
| GET | `/leads/export.csv?<list filters>&sort` | the leads the list filters match as a CSV file (UTF-8 with a byte order mark, CRLF, at most 10,000 rows): business fields only (company, contact person, website, industry, city, state, country, phone, email, stage, offer (its name), owner, next action and date, deal value, currency, expected close, chance, source, tags, do not contact, added). Rows in the list's order (`sort`: updated, next with undated last, relevance, name). A do-not-contact lead goes out without its phone and email; cells a spreadsheet would run as a formula get a leading apostrophe (= + - @, phone numbers with + included, tab, CR, full-width ＝ ＋ － ＠, and a leading space, no-break or zero-width space). Headers `X-Exported-Rows`, `X-Matching-Rows`, `Content-Disposition: attachment; filename="leads-YYYY-MM-DD.csv"`. Not for learners or Claude; audited as `sales.lead.export` |
| POST | `/leads/import/preview` | `{ ventureId, pipelineId?, csv, hasHeader (default true), mapping? }`: reads the file and says what an import would do, creating nothing. Without `mapping` the columns are guessed from the header. An `offer` column names one of the venture's offers (any case; an unknown or archived one keeps the row out); a row without one gets the venture's only usable offer, when there is one. Answer: `{ columns, delimiter, mapping, guessed, missing, total, counts: { ok, duplicate, invalid, doNotContact }, sample (first 10 rows), issues (first 200 rows that are not ok or carry a note, with their problems and what they duplicate), issuesTruncated }`; echoed cell values are cut to 200 characters. At most 5 MB and 5,000 rows; a file with NUL characters is refused (400 "not a text file"); a mapped cell over 2,000 characters (320 for phone and email) is not read and its row is listed as too long |
| POST | `/leads/import/commit` | the same body with `mapping` required and `importDuplicates` (default false): creates the ok rows (and the duplicates when asked) as Identified leads owned by the importer, in the venture's first active pipeline unless `pipelineId` (an active pipeline of the venture) is given; each carries `importBatchId`. 201 `{ batchId, total, created, duplicates, doNotContact, invalid }`. One commit per venture at a time (a `sales_import_locks` row, released at the end, expiring after 10 minutes): 409 "an import is already running for this venture". A file that created leads is recorded in `sales_imports` by a hash of venture, columns and rows; the same file again creates nothing and answers 200 with `alreadyImported: { batchId, at, created }`. Writers of the venture only (not learners, not Claude); audited as `sales.lead.import`. This path takes bodies up to 12 MB (the rest of the API keeps 2 MB) |
| GET/POST | `/views`, DELETE `/views/:id` | each person's saved Leads filters: `{ name (1 to 60), page: leads or pipeline, filters: { key: value } (the URL's filter parameters, at most 20) }`. The same name (any case) replaces the earlier view (200), a new one is 201, a 21st is 409; a unique index on person, page and name (any case) makes two saves of a new name at once one view and one 409 "a view with that name exists". Only the owner lists and deletes; Claude cannot save |

The older `/v1/pipelines` and `/v1/opportunities` routes keep working on the same records (same rules);
`GET /v1/opportunities` is bounded: newest updated first, `limit` (default 500, max 1000) and `offset`.

**Collections** (string `_id`s, `workspaceId` on every row, dates stored as `Date`): `opportunities` (leads;
soft-deleted rows have `deletedAt` and are hidden everywhere, including the older routes and the calendar),
`sales_activities`, `sales_verdicts`, `sales_drafts`, `sales_plays`, `sales_find_runs`,
`sales_brain_items`, `sales_offers` and `sales_offer_versions` (offers and every version of their packets), `sales_suppression`, `sales_views` (saved Leads filters, per person), `sales_imports` (CSV files that created leads, by content hash) and `sales_import_locks` (one running CSV import per venture). Imported rows carry `externalRef: { system, id }` (unique per
venture, so the lead finder can find the same company for two ventures) so imports can be re-run.

## 5. Automatic rules (server side, one place)

**Venture settings** (`sales_settings`, one row per venture, `GET/PUT /v1/sales/settings?ventureId`): the rules below read these,
with the defaults shown, instead of constants.

| Setting | Default | What it does |
|---|---|---|
| `workingDays` | `[1,2,3,4,5,6]` (ISO weekdays, Monday to Saturday) | which days count when follow-ups and next actions are scheduled |
| `blackoutDates` | 2026-10-20 and 2026-11-06 to 2026-11-11 | days on which nothing is scheduled (a venture's own list replaces the default) |
| `followUpAfterWorkingDays` | 4 | a first touch sets `followUpDueAt` this many working days later |
| `replySlaHours` | 2 | a warm reply ("interested") gets a next action this many working hours later (working hours are 10:00-19:00 local); Daybreak's `overSla` and the Reports' promise use it with the venture's working days, blackout and time zone, on warm replies only (interested, send_details, price_first); both responses carry `workRules` (and Daybreak `replySlaHours`, null when ventures differ) |
| `dailyCaps` | email 20, whatsapp 20 | emails and WhatsApp messages one person may send per local day and venture, whether marked sent from a draft or logged by hand (outbound, through the app or Claude); a send counts on the day it happened (`at`), so one logged now for an earlier day does not; more is `409`. Counted atomically in `sales_send_counters` (one row per person, venture, channel and day, never below what was sent that day), so parallel sends cannot pass the cap |
| `approvalMode` | `claude_review_enough` | `person_approves_every_message`: every reviewed draft (not call openers) needs a person's approval before it can be sent, not only a play's first batch; the lead's owner, a head or an admin approves it in the app, never Claude. Only a head's or admin's approval (`personApproval.byHead`) counts toward a play's first batch, in either mode |
| `allowedChannels` | call, email, whatsapp, linkedin | drafts for another channel are refused (`409`), and so is sending one written earlier |
| `timezone` | Asia/Kolkata | where days, midnights, "today" on the Overview and the 10:00 follow-up time are counted |

Default calendar: Monday to Saturday, Asia/Kolkata; festival blackout 2026-10-20 and 2026-11-06 to 2026-11-11
(no follow-ups scheduled on those days).

- **Outbound** call/email/whatsapp/linkedin on a lead in identified/researched/approved_for_contact →
  stage contacted. Sets `lastTouchAt`. A first touch sets `followUpDueAt` = 4 working days later.
  Refused (`409 CONFLICT`) when `doNotContact`.
- **Inbound** (`direction: in`) → stage replied if the lead was contacted or earlier; clears
  `followUpDueAt`; discards pending follow-up drafts (stop on reply); stays in the Inbox until handled.
  Inbound WhatsApp logged by a person sets `whatsappOptIn { how: they_messaged }`; one logged through Claude
  does not: a person records it by marking the message handled (or with the opt-in route). An inbound
  "meeting" is a reply given in person. Nothing is logged as happened more than 1 hour in the future (`400`).
  A `requestId` repeats the first answer; the same id with different content is `409`.
- **Reply types** (inbound): opt_out and hostile → disqualified ("Asked not to be contacted" /
  "Hostile reply"), `doNotContact`, suppression entries for the lead's email and phone routes and company
  name, the company's own (never a shared mail) domain, every unsent draft discarded; "silence" is not a
  reply type (`400`: silence ends a sequence, it is not a message from them); not_now → thinking, next action in 30 days; interested → next action
  "Book the discovery call" due in 2 working hours; send_details → next action "Send details";
  wrong_person → next action "Find the right person"; price_first → next action "Answer price with a
  range and ask for a call".
- **Call outcomes**: interested_book → discovery_booked; send_details → replied, "Send details";
  call_back → next action "Call back" at the given time or next working day; no_answer and busy → next
  action "Call again" next working day (first try also counts as contacted); not_interested → lost
  ("Not interested on call"); wrong_person → "Find the right person"; wrong_number → note only;
  yes_whatsapp → replied, next action "Send details on WhatsApp", and `whatsappOptIn { how: yes_on_call }`
  when a person logs it (Claude's log does not grant it: WhatsApp consent is person-only).
- **Verdicts**: saving updates the lead's `verdict` summary (with who set it: `via`, `by`). Low
  confidence or hold → `needsYou`. On a lead before first contact: recommend (medium/high) →
  approved_for_contact; recommend (low) or hold → researched; reject (medium/high) → disqualified with
  "Not a fit: {summary}" and a stored flag (`disqualifiedByVerdict`); a low-confidence reject only asks a
  person (researched + needs you). Overrides apply the same mapping with the person's decision (treated as
  certain), clear `needsYou`, and count as a person's verdict. Needs-you leads always show on the Overview.
- **Drafts**: draft → in_review → ready | needs_changes; edits return to in_review; mark sent only from
  ready (and with person approval while the play's first batch is not yet reviewed: a head's or admin's). call_opener drafts
  are scripts for call mode and cannot be marked sent. Every draft the API returns in a list, the Overview queues or
  `GET /drafts/:id` (a member of the lead's venture; 404 otherwise or once the lead is deleted) carries `needsPersonApproval` and
  `approvalReason` (`every_message`: the owner or a head approves; `first_batch`: a head or admin approves; else null).
- **Reminders and notices**:
  - One reminder per lead for its next action, for the lead's owner, at `nextActionAt` ("Call again: {company}", the next action
    text, then the company); a new date or text replaces it, a reassignment moves it, and closing, deleting or `doNotContact`
    cancels it. Dates less than a minute ahead (or past) get none.
  - `sales_reply`: the owner is told when someone else (a teammate, or a head's Claude) logs an inbound reply on their lead.
  - `sales_approval`: the venture's heads and admins (not the person who reviewed it) are told once per draft when a draft
    becomes ready and needs a person's approval; hidden again once it is approved, discarded or its lead is deleted.
  - `sales_needs_you`: the owner is told when a verdict lands the lead in "needs you" (once while it stays there; through Claude the
    owner is told too).
  - Notices of a deleted lead, or of a venture the person cannot open, are not shown (like `sales_won`).
- **Suppression**: adding an entry (by hand or from an opt-out) flags matching leads `doNotContact`, discards their unsent drafts and
  cancels their next-action reminders; the same happens when an edit, an enrich run or the importer's `--refresh` finds a match
  (new and edited leads are checked). A do-not-contact lead is never moved into a contact stage (approved for contact to proposal) by
  an edit (`409`); closing it as lost or disqualified is fine. Contact values are read from at most 2,000 characters of text. Matching is by email (lowercase, `+tag` and trailing dot ignored), phone
  (+91 default; spaces, 0 and 91 prefixes, extensions ignored), the company's own domains and website
  (never shared mail or platform domains) and company name (case, punctuation, brackets, "&"/"and" and
  Pvt/Ltd/LLP/Co ignored; trade words like "traders" kept). Emails and numbers inside other route kinds
  (a page note, a `mailto:` or `wa.me` link) count too.
- **What Claude cannot do** (enforced here, not only in the tools): approve anything (plays, brain items,
  first-batch drafts), override a verdict, record WhatsApp consent. Its **stage changes** are limited:
  never to approved_for_contact (except through its own recommend verdict on a lead before first contact),
  never to a won stage, never reopen a lost or disqualified lead (activities on a closed lead are recorded
  but the stage stays; an opt-out still suppresses), never back to an earlier stage, never skipping ahead.
  Direct edits go one step at a time: identified → researched, contacted → replied → discovery_booked →
  qualified → proposal, replied/contacted → thinking, thinking → replied, and closing (lost or disqualified
  with a reason); "contacted" comes from logging the outreach. Moves driven by logged activity follow §5 but
  are held to the same limits (thinking only from replied or contacted). **Verdicts**: Claude cannot replace
  a verdict a person saved or overrode, nor save one while the lead needs a person's decision; on a lead
  already approved for contact, its hold, low recommend or reject leaves the stage and sets `needsYou`;
  a lead a verdict disqualified is reopened by a person's verdict or override only.
- Every write is audited (`audit()`), with `channel` "mcp" for Claude.

### Revenue layer

- A deal is a lead with `valueEstimateMinor` (paise or cents) and `currency` (default INR), an optional `expectedCloseAt`
  (stored as a date; the UI picks a day and sends noon in India) and an optional `probability` (whole percent).
- **Weighted value** = value x chance. The chance is the lead's own `probability` when one was set (0 is a real answer),
  else the stage's default (`STAGE_PROBABILITY` in the contracts: identified 2%, researched 5%, ready to contact 8%,
  contacted 10%, thinking 10%, replied 20%, call booked 35%, qualified 50%, proposal 65%, won (invoice) 90%, paid, in
  delivery and retained 100%, lost and not a fit 0%).
- **Lost reasons** are one of `price`, `no_budget`, `no_need`, `timing`, `chose_competitor`, `no_response`, `not_a_fit`,
  `wrong_person`, `other`, so reports can count them next to the free-text `exitReason`. "Not interested on call" is a lost
  lead with `no_need`.
- `GET /leads?totals=true` adds `totals: { count, byCurrency: [{ currency, count, valueMinor, weightedMinor }] }` for the
  same filter (leads without a value only count in `count`); the Pipeline column heads and the board header use it.
- Money is never added across currencies: every total is one row per currency, and the UI shows them side by side
  ("₹12.4L + $3K"). Short form is ₹12.4L / ₹3.5 Cr for rupees and $12.4K for others; the full amount is in the tooltip.

### Lists at scale

- **Bulk edits** never bypass the single-lead rules: every lead is loaded and changed through the same checks as one
  edit, and a refused lead is skipped with its reason (a contributor tagging a list that holds someone else's lead
  changes their own and reports the other). A lead already in that state counts as `unchanged`, not an error; who may
  change it is checked first (a learner hears "read-only", never "already like that"). Winning a deal is one lead at a
  time, and a do-not-contact lead is never moved into a contact stage.
  "Select all N matching" sends the filters, not ids; the server takes the 500 most recently updated leads that are not
  already in the target state, so running the same change again reaches the next 500. The toast then says "Changed N;
  M were already like that; X still to go — run again", and the bar keeps the selection and the step for that.
- **Export** is the list as it is filtered and sorted on screen, for a spreadsheet: no research notes, verdicts,
  evidence or activity ever leave this way.
- **Import** reads CSV the way spreadsheets write it (byte order mark, comma, semicolon, tab or pipe, quoted cells with
  line breaks). The app reads the file's bytes: UTF-16 ("Unicode Text"), UTF-8, or Windows-1252 when the bytes are not
  UTF-8, and warns when characters still could not be read. Columns are guessed from header names ("Business Name",
  "Mobile", "E-mail"...; the contact person needs "contact" with "name" or "person", so "Contacted?" is not it), each
  column once, and a person can change any of them. Cells lose zero-width characters and a safety apostrophe in front
  of = + - @. Values: phones are normalised (numbers in one cell split on / , ; |; a second number written as its last
  digits, "0771-2345678 / 79", is left out with a note; never "+0..." or outside 8 to 15 digits), a mailto-style email
  cell keeps its first address before "?", emails and websites
  checked, tags split on `,` `;` `|`, a value written as digits ("12,50,000", "₹250000.50") becomes paise (words like "2.5L" are flagged), and the source
  defaults to "CSV import". A row is a **duplicate** when its email, phone or website matches a lead already in the
  venture, or its company name does and the cities do not differ; an earlier row of the same file counts too, and so
  does a lead deleted earlier ("Deleted earlier", never brought back). Rows on the do-not-contact list are never
  imported; rows with problems are skipped and listed with the reason. One import runs per venture at a time, and the
  same file imported again creates nothing.
- **Saved views** are per person and only remember filters; they never share leads or change what a person can see.
- In the app: a checkbox column on the Leads table (and a **Select** mode on phone cards), a banner to "Select all N
  matching", and a bar with **Assign** (heads and admins), **Add tag** (or remove it), **Move to stage**, **Add to
  play** and **Delete**, each a short step that names what will happen before it runs; the answer is one toast
  (changed, already so, skipped with the first reason). The bar floats at the bottom of the list on laptops and is a
  bottom sheet on phones. **Import** opens a drawer (full screen on phones): choose the file (and the venture in All
  ventures), check the counts, columns and rows to look at, then import. **Export** downloads the current list.
  Saved views are chips above the list with "Save this view". Learners see saved views but no bulk bar, import or export.

## 6. Screens (design: Venture OS look, see the high-fidelity screens artifact)

One **Sales** item in the sidebar. `/sales/live` has tabs: **Overview · Leads · Review · Inbox · Pipeline ·
Plays · Brain**, plus **Calls** (call mode) and **Find leads** reached from Overview and Plays.
`?lead=<id>` opens the lead drawer from any tab (links from notifications and Claude).

- Overview (desktop): like Today: greeting line, "Needs you now" queue (replies, calls due, drafts to
  review, needs-you verdicts, won to hand over), last-7-days strip, stage counts, and a **Pipeline** card in
  money (open value, weighted forecast, this and next month, won this month).
- Overview (phone, below `md`): **On the go**: big rows for Replies, Calls today, Ready to send, Review,
  each opening a focused list; quick approve/veto/discard and call buttons (`tel:` links).
- Leads: table (company, city, stage chip, verdict chip, owner, next action, updated) with search and
  filters (stage, verdict, needs you, owner, play, state, city, industry, contact); phone shows cards. Row →
  slide-in lead drawer, top to bottom: an identity header (company, city, industry, website; stage, verdict,
  needs-you and do-not-contact chips; owner; one quiet line "Next: Call again · Tomorrow 10:00" that edits in
  place), **At a glance** tiles (Reach with Call / Email / WhatsApp and the WhatsApp consent prompt, Deal,
  Claude's verdict with "Read evidence", Play and source, Last touch, Follow-up), then tabs **Activity ·
  Claude · Drafts · Details** (`?tab=`; Activity is the default). Details holds every field in groups
  (Company, Contact, Deal, Ownership, About, Danger zone), read as plain facts until Edit is chosen. A bar under
  the drawer logs a call, a reply or a note in a small composer. On a phone the Call button stays in the header.
  Lists at scale on the same screen: row checkboxes, "Select all N matching", the bulk bar, Import and Export
  buttons and saved view chips (see "Lists at scale" in §5).
- Review: mail-style split view: list of drafts (to review, ready to send, needs changes) on the left,
  the draft with Claude's review checks on the right; edit, approve (first batch), mark sent, veto,
  discard. "Copy and open mail app" uses `mailto:`; WhatsApp uses `wa.me` only with opt-in.
- Inbox: replies grouped by lead, reply type chip, suggested response draft, mark handled.
- Pipeline: 7-column board (§2) with drag to change stage; each column head shows its deals and value ("₹12.4L · 6 deals") and the board header the weighted total. Dropping a card on Closed asks for the lost reason category.
- Plays: list and detail (audience, hypothesis, steps, stop rule, stats), approve, first-batch switch.
- Calls: one lead at a time: opener script, contact route, outcome buttons (§5), next lead.
- Find leads: describe the audience, see the plan (places, categories, searches), queue it for the office
  PC; past runs with results.
- Offers (formerly Brain): one card per offer (state, summary, leads, proposals waiting) and "New offer"; the offer page shows the
  packet as readable sections, proposals to compare and approve as a whole, and pause, activate or archive; "Shared for the
  venture" holds the notes and settings (approved version, pending drafts with approve). See `docs/sales-offers.md`.
- Won: notification + Overview card with **Create delivery work**.

## 7. Not in v1

Sending through SMTP or the WhatsApp Cloud API (designed, off), per-venture permission matrix editing, A/B variants, automatic
LinkedIn/X. (The office PC engine bridge, once listed here, is in: §10b.)

## 8. Run it locally (owner's PC, no Docker)

- Database: the local MongoDB service on `127.0.0.1:27017`, database `vso_dealflow_dev` (root `.env`, gitignored;
  `ALLOW_DEV_AUTH=true`, local mode only). Other databases on that server belong to other projects.
- First time: `npm run build:packages`, then `node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/src/seed.ts`
  and `node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/src/migrate.ts`. The API also runs the Sales part of the
  migration (older deal records get the Sales stage names and do-not-contact match keys) in the background a few seconds after
  it starts, so a deployed server needs no manual step; it is safe to repeat and changes nothing the second time.
- Real leads: `node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/scripts/import-dealflow.ts` (reads the
  Dealflow SQLite read-only; see `apps/api/scripts/README-import-dealflow.md`).
- Run: API `node --env-file=.env node_modules/tsx/dist/cli.mjs watch apps/api/src/server.ts` (:4000), web
  `cd apps/web && node ../../node_modules/next/dist/bin/next dev -p 3000`, worker `cd apps/worker && node
  ../../node_modules/tsx/dist/cli.mjs src/index.ts` (delivers notifications; local adapters only).
- Dev identity: the browser acts as `user-divyansh`; `localStorage.setItem("vso-dev-user-id", "user-shubham")` to see
  a learner, `user-adarsh` a venture head, `user-abhinav` a contributor.
- Tests: `TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true' node --import tsx --test test/sales.test.ts`
  from `apps/api` (throwaway databases, dropped after). Five older `api.test.ts` cases need a replica set.
- Live checks (Prospector repo, `tooling/vso-qa/`): `flow.mjs` walks the whole flow through the API as every role;
  `ui-flow.mjs [--phone]` clicks through the screens; `shots.mjs` screenshots every Sales page on desktop and phone,
  light and dark, and lists console errors, failed calls, overflow and small tap targets.

## 9. The Claude connector (Dealflow Sales)

Venture OS has two Claude connectors, so each tool list stays short and the two never conflict. They share one token
model (a personal access token per person, scoped, expiring, revocable; see `docs/mcp.md`), the same rate limits and the
same loopback rule (every tool calls `/v1/...` as the token's owner, only on an allowlist), and each is added to Claude
separately. People's guide to using it: `docs/sales-os-guide.md`.

| Connector | Address | Server name | Token preset | Tools |
|---|---|---|---|---|
| **Venture Studio** | `/mcp` | `venture-studio` | the Studio scopes (read only, or read and update) | tasks, reviews, knowledge, decisions, channels, calendar, reminders; no sales tools |
| **Dealflow Sales** | `/mcp/sales` | `dealflow-sales` | `sales:read` + `sales:write` + `ventures:read` | the sales tools below, plus `list_ventures` and `find_person` |

The Connect Claude page (`/connect/live`) shows both connectors with their address to copy and a one-click key preset,
plus a third preset, **Office PC engine** (`sales:read` + `sales:engine`), for the lead-finding worker (section 10). That
key is not a Claude connection: a token carrying `sales:engine` is refused with `403` on both `/mcp` and `/mcp/sales`.
The new-key dialog switches between the presets and prints the matching `claude mcp add` command:

```
claude mcp add --transport http dealflow-sales https://os.buildory.dev/mcp/sales --header "Authorization: Bearer <token>"
```

A token's scopes still decide which tools it sees on either endpoint (a Studio key has no sales scopes, so it sees
no sales tool; a sales key sees only the sales tools and the two lookups).

### A guided conversation

- **"Start sales".** The server instructions tell Claude to call `start_sales` first. It returns a new `sessionId`, the
  person's role and ventures, today's counts and top items, the eight workflow steps and the rules, plus:
  `say` (a warm greeting by first name, the time of day in Asia/Kolkata, one line of what is waiting) and `next`
  (three options tied to the real counts, the first being the suggestion: "Sort the 2 replies waiting", "Get the 10
  drafts waiting reviewed", "Research the 4 new Raipur leads").
- **Batches, never piles.** An option never asks for more than 25 at once ("Sort the first 25 of 400 replies"). The
  research option counts the new leads (stage identified, no verdict) over the whole set with `GET /v1/sales/leads/facets`
  and names the busiest cities: "Research the newest leads: Indore (101), Raipur (94) or Nagpur (74). Say a city and
  I'll take the first 25".
- **Every result guides.** Every other sales result carries a short `say` and up to three `next` options, so the chat
  stays steady. Claude shows `say`, then `next` as a numbered list, and ends on one plain next step. What the older
  results told Claude to do next (instructions, not for the person) travels as `then`.
- **Refusals are plain.** When the app refuses a write (403 or 409) the result is `{ refused, say, next, url, why }`:
  `say` is one sentence on what only a person can do, `next` offers the app link, `why` keeps the app's own words.
- **The venture's working rules.** `start_sales` adds each venture's settings (working days, blackout dates, follow-up
  and reply timing, daily caps, allowed channels, approval mode; read from `GET /v1/sales/settings`) to `rules`, and
  `save_draft` refuses a channel the venture doesn't allow. People get notified of replies, approvals and verdicts that
  need them (`sales_reply`, `sales_approval`, `sales_needs_you`).
- **Prompts** (slash commands in Claude Code, `/mcp__dealflow-sales__<name>`): `sales` (start), `review_drafts`,
  `find_leads` (asks the area and the kind of business, then `search_companies` and `add_leads`, or `plan_find_run`),
  `todays_calls`, `weekly_review` (calls `weekly_report`), `daybreak` ("Run my morning": call `daybreak`, do its `then`
  plan in order, show the summary as an artifact or table and ask what to do first).

### Data as visuals

- **Cards (MCP Apps).** `start_sales` and `sales_overview` return a session dashboard card (today's counts as badges, the
  top items with buttons, the suggested next steps as buttons), `get_lead` a lead card (stage, verdict, quotes with
  links, contact routes, next action), `find_leads`, `list_drafts`, `inbox` and `search_companies` a list card, and
  `weekly_report` and `daybreak` a report card (counts as badges, the suggested changes or the plan as buttons). The
  tools name one page, `ui://dealflow-sales/card.html` (mime type `text/html;profile=mcp-app`, self-contained, green on
  neutral, light and dark), in `_meta.ui.resourceUri`; the card travels in `structuredContent.card` while the text
  stays as it was, so a chat app without MCP Apps loses nothing. A button either says a prepared request in the chat
  or opens an app page; nothing is saved or sent from a button. When the chat app announced `io.modelcontextprotocol/ui`
  the result also carries `card_shown`, telling Claude to answer in one short line (each request is answered afresh, so
  most connections can't say, and then the note is left out).
- **`view` hint.** List results say how to show them: `{ present, title, rows }`. `card` when the chat app draws cards;
  otherwise `artifact_or_table` and the instructions decide: on claude.ai an artifact (an interactive page in the Venture
  OS look: counts as tiles, lists as a table with stage and verdict chips, buttons that say the next request), updated
  through the session instead of making new ones; in Claude Code or any terminal a compact text table. A single lead is
  a compact card or a short text block. A report is never pasted as prose.

### Tools

Reads need `sales:read`, writes need `sales:write`. Every sales tool accepts a company name instead of an id.

- **Read:** `start_sales`, `sales_overview`, `inbox`, `list_drafts`, `find_leads`, `get_lead`, `list_plays`,
  `list_find_runs`, `get_brain`, `list_offers`, `get_offer`, `search_companies`, `weekly_report`, `daybreak`.
- **Write:** `save_verdict`, `save_verdicts` (up to 25), `save_draft`, `save_drafts` (up to 25), `review_draft`,
  `revise_draft`, `log_reply`, `log_call`, `update_lead`, `add_leads` (up to 25), `enrich_lead`, `propose_play`,
  `plan_find_run`, `propose_brain_change` (shared notes only), `propose_offer`.
- **Offers.** Every lead belongs to one offer: Claude reads its approved packet with `get_offer` before judging or writing, and
  proposes new rules for an offer with `propose_offer` (the whole packet; a venture head approves it in the app). Offers are named
  by name (any case): `find_leads`, `add_leads`, `update_lead`, `plan_find_run`, `propose_play` and `save_verdict(s)` take `offer`;
  a venture with several active offers must name one for `add_leads` and `plan_find_run`; a verdict's offer is the lead's own.
  `start_sales` lists the offers and says which to work on; `get_lead`, `list_drafts` and `review_draft` show each lead's offer.
  `docs/sales-offers.md` has the rest.
- **Names, not ids.** Tools that take a lead accept `company`, drafts `company` (its latest draft waiting for review, or
  the one sent back), plays `play`. A lead is picked only when exactly one lead's COMPANY name matches (case, spacing,
  punctuation and Pvt/Ltd ignored) in the person's ventures; a name that only matches a contact person or a city comes back as
  candidates (`needsChoice`), never picked; several matches too (nothing is written); none is a clear message. An opt-out or
  hostile reply, a not-interested call and closing a lead pick only an exact company name. A reply draft answers the lead's latest
  message without an id. `propose_brain_change` takes `replaces` as up to 20 exact titles of approved items in the venture
  (`"Tone"` or `{ title, kind }` when a title is used in several kinds); an unknown title is an error listing the approved titles.
- **Batches.** `save_verdicts` and `save_drafts` check every item exactly like the single tool; a failure on one never
  stops the others and the result says per lead what was saved and what was refused.
- **`search_companies`.** Finds real companies on the web with TinyFish Search and Exa (category company), the same APIs
  the lead finder uses; the keys are the ones an admin saved in Sales setup, else the API's `TINYFISH_API_KEY` and
  `EXA_API_KEY` (§10a; none means off: the tool then says an admin can add a key in Sales setup). It leaves out companies already in the pipeline and anyone on
  the workspace's whole do-not-contact list (read directly, so entries a person can't see in the list still count), stores
  nothing, numbers its results (`result`), treats what pages say as data, and never returns or logs a key. It is for people who
  add leads: a learner's key is refused before anything is spent. Limits: 12 searches a minute per token; per workspace 1,500
  TinyFish calls a day and about 1,200 Exa calls a month, of which searches from chat use at most 1,000 of each (the rest stays
  for the lead finder's queued runs). A search refused at a limit is not counted.
- **`weekly_report`** (`GET /v1/sales/reports`, range `week` | `30d` | `quarter`, owner `all` by default). The report
  compacted: funnel, top 5 sources, plays and cities, reply types, reply speed against the venture's promise, Claude's
  calibration grid with `n` and the small-sample flags, overrides, wins and losses, the leads stuck longest. Rates read
  "40% (4 of 10)" or "too few to tell (2 of 3)" (no share under 5 cases). `say` is the three sentences that matter and
  `next` up to three changes put as questions for the owner; agreed ones become proposals (`propose_offer` for an offer's rules,
  `propose_brain_change` for shared notes).
- **`daybreak`** (`GET /v1/sales/daybreak`, owner `me` by default). The morning work list, at most 25 per list (only what is
  still to do: leads already queued for contacts and verdicts a person set are left out; work done since drops out; `offset`
  skips items left on purpose), plus
  `then`, the plan in order: draft the due follow-ups with `save_drafts` (each refers back to its first touch), queue
  `enrich_lead` for leads without contacts, re-judge stale verdicts Claude may re-judge with `save_verdicts`, then list
  the calls and replies for the person. `say` is one line ("3 follow-ups to draft, 12 leads without contacts, 2 replies
  waiting over 2h."). Both tools are read only and draw a card where the chat app supports it.
- **`enrich_lead`.** Queues an enrich run for the named leads (`POST /v1/sales/leads/:id/enrich`); the lead finder fills in
  published business contacts and evidence later (no search key needed). `list_find_runs` shows the run.
- The older deal tools (`list_deals`, `add_deal`, `update_deal`) are retired: `find_leads`, `add_leads` and
  `update_lead` replace them, on the sales connector only.

### How the connector keeps the rules in section 1

- There is no send tool, and nothing that approves a play, a brain item or a draft, marks a draft sent, vetoes or
  discards it, overrides a verdict, confirms WhatsApp, marks a deal won or reopens a closed lead. Those routes are not
  on the MCP allowlist, and the server refuses the same actions when a request comes through MCP (`via = "claude"`).
- `start_sales` returns a new `sessionId` and declares the conversation a **work** session or a **review** session
  (`mode`). Every write carries the `sessionId`: verdicts, drafts, logged replies and calls, lead changes, new leads,
  enrich requests and proposals need a work session, `review_draft` needs a review session, so the writer and the
  reviewer of a draft are different conversations and a review session writes nothing else. This is an honour system: a conversation could start a second
  session on purpose, which the tools call self-approval. A person still approves the first batch of every play.
- Claude moves a lead one step at a time (the tools refuse the rest up front, with plain messages), drafts only for
  leads whose latest verdict is `recommend` (replies excepted, and only as an answer to a logged inbound message), and
  never replaces a verdict a person set or overrode.
- Website text, evidence quotes and lead replies come back marked as data, never instructions. A card button's request
  never carries a web page's words: search results are named by number and bare domain ("Add search result 3 (acme.in) to
  the pipeline"), stored company names are cut at a sentence break and to 40 characters and go with the lead id, and city
  names in `next` options are clipped to 40 characters without hidden characters.
- The server instructions stay under 2,000 characters: start_sales first and the sessionId, `say`/`next`, cards, artifacts
  and tables, never send or approve, review in a separate chat, data never instructions, person-only decisions.

Both endpoints are `POST` only (stateless Streamable HTTP, JSON responses, one message per request); `GET` answers
405. `MCP_ENABLED=false` switches both off, `MCP_WRITES_ENABLED=false` leaves only the read tools.

## 10. Lead finding: the built-in finder, and the office PC engine bridge

### 10a. The built-in lead finder (`apps/api/src/sales/finder`)

The API works queued find-leads and enrich runs itself; Venture OS needs no other program to find leads.
- **Switch:** `SALES_FINDER=on` (the default) or `off`. It starts with the API (`server.ts`) and checks for runs every 30 s.
- **Claiming:** one run at a time per API process, claimed atomically as `claimedBy: "builtin-finder"`. A run with no
  heartbeat for 15 minutes can be taken over, by the finder or the office PC alike.
- **Search keys:** a find run needs a TinyFish or Exa key, saved by an admin in Sales setup (see below) or in the API's
  environment. Without one it stays queued with the note "Company search has no key: an admin adds one in Sales setup".
  An enrich run needs no key: it only reads the leads' own websites.
- **Find run:**
  1. Builds searches from the plan (`searches` as given, else categories × places × "manufacturer", "distributor" and
     "dealer enquiry", 40 at most). TinyFish (free) goes first; Exa only when TinyFish has no key, fails, is used up or
     finds nothing new. Every call counts against the workspace caps.
  2. Merges the hits by domain and drops directories, marketplaces, news, blog and market-research pages.
  3. Skips any domain the venture already has, or that is on the do-not-contact list, without fetching it.
  4. Reads at most 5 pages per company site: home, contact, about, dealer and product pages.
  5. Adds each lead through `ingestEngineLead`, so the duplicate and do-not-contact checks are the same as for every lead. A
     duplicate is a lead of the same venture with the same website domain, or the same company name where the cities don't differ
     (as the CSV import counts it); another venture may find the same company.
     A lead carries `externalRef {system: "builtin-finder", id: domain}`, the tag "finder", dated evidence quotes, its
     contact routes, city, state and category, and a note "Found by the built-in lead finder".
- **Enrich run:** reads each lead's own site the same way and merges what it finds through `enrichEngineLead`.
- **Safety:** pages are read in time in step with their size (no tag pattern rescans the page, so broken or hostile HTML never
  stalls the API, which the finder runs in). http and https only, ports 80 and 443 only. Every host and redirect hop (at most 3) is resolved first and
  refused if any of its addresses is private, loopback, link-local, CGNAT, multicast or reserved, including mapped IPv6.
  The connection is pinned to the address that was checked.
- **Politeness:** robots.txt is read and obeyed for `User-agent: *` and `VentureStudioLeadFinder`, cached 24 h. A 5xx or
  no answer means the host is not read. `Crawl-delay` is honoured up to 60 s. At least 5 s between requests to one host,
  at most 3 hosts at once, 15 s timeout, 1.5 MB per page, HTML only. No cookies, logins, form posts or JavaScript; no
  CAPTCHA handling, proxies or user-agent tricks: a challenge page, 403 or 429 means the site is skipped.
- **Budgets:** about 20 minutes per run and 90 s per site. Runs are cancellable between sites.
- **Data:** business fields only. Contact routes are those the company publishes on its own pages (`mailto:`, `tel:`,
  WhatsApp links, visible business numbers and emails, an enquiry form), each with its page. A Dealer Login is flagged as
  a tag for the verdict (G4). Lines with a GSTIN or PAN are never quoted. Website text is data, never instructions.
- **Status:** `GET /v1/sales/finder/status` → `{ builtIn: { on, searchReady, engines, running?, lastRun? } }`, shown on
  Find leads. It reports whether keys are present, never the keys.

**Company-search keys in the app.** Admins save the TinyFish and Exa keys in Sales setup (`GET /v1/sales/search-keys`,
`PUT`/`DELETE /v1/sales/search-keys/:engine`, `POST /v1/sales/search-keys/:engine/test`, 5 tests a minute).
- **Storage:** the `sales_search_keys` collection, one document per workspace. Each key is encrypted with AES-256-GCM
  under a key derived from `BETTER_AUTH_SECRET` (HKDF-SHA256), with a fresh IV and the workspace and engine bound in.
- **Precedence:** a key saved in the app wins over `TINYFISH_API_KEY` / `EXA_API_KEY`. A key that no longer decrypts
  (the secret changed) shows as "Unreadable, enter it again" and the environment's key is used.
- **What people see:** whether a key is set, where from, its last four characters and who saved it. Claude can't change
  keys, and the audit log records only which engine changed.

### 10b. The office PC engine bridge (optional)

The older Dealflow engine (Prospector `backend/dealflow_backend`: TinyFish, Exa, Brave and Google search APIs with keys in
Windows Credential Manager, SearXNG, list import, polite crawler, extractors) can still work runs over this bridge, next
to the built-in finder: whoever claims a run first works it. Venture OS plans, queues and shows the runs; this worker
does the work and posts the leads back.

Auth: a personal access token with scope `sales:engine` (plus `sales:read`), created by the owner on the Connect Claude
page ("Office PC engine" preset). The worker stores it in Windows Credential Manager; it is never typed into a chat.
All writes are audited with channel `engine`. Routes (under `/v1/sales/engine`, Bearer token only, never via MCP):

| Method | Path | Body / result |
|---|---|---|
| GET | `/runs?status=queued` | runs: id, ventureId, playId, request, plan {places, categories, searches, limit}, createdBy, createdAt |
| POST | `/runs/:id/claim` | {workerId} → the run, now `running` (409 if another worker holds it; a claim with no heartbeat for 15 min can be taken over) |
| POST | `/runs/:id/heartbeat` | {progress: {found, crawled, added}, note?} |
| POST | `/runs/:id/leads` | {leads: [≤50 × {companyName, website?, city?, region?, country?, category?, source (URL or list name), observedSignal?, contactRoutes (published by the company on its own pages or an official listing, each with sourceUrl), evidence? [{claim, quote, url}], relevance 0-100?, tags?, externalRef {system: "dealflow-engine", id}}]} → {added: [{id, companyName}], skipped: [{companyName, reason: duplicate \| do_not_contact \| invalid}]} |
| POST | `/runs/:id/finish` | {status: done \| failed, results: {found, added, skipped, note?}} |

A run has `kind`: `find` (new leads, as above) or `enrich` (made by `POST /sales/leads/:id/enrich`; `leadIds` ≤ 100). For an enrich run
the worker gets `targets` in the run (`GET /runs`, claim): `[{leadId, companyName, website?, city?, region?, country?, category?,
observedSignal?, contactRoutes: [{kind, value}]}]` (deleted and do-not-contact leads are left out), and posts what it found per lead to
the same `/runs/:id/leads`: `{leads: [{leadId, website?, city?, region?, country?, category?, observedSignal?, contactRoutes (each with
sourceUrl), evidence?}]}` → `{added: [], updated: [{id, companyName, routesAdded, fieldsFilled, evidenceAdded}], skipped: [{companyName,
reason, id?, detail?}]}`. Nothing is created: routes are merged by value, website/city/region/country/category/signal only fill empty
fields, the evidence becomes a note, and a route the do-not-contact list matches flags the lead.

Leads from a run belong to the run's creator, its venture (first active pipeline) and its play; stage identified;
duplicates (same website domain or normalised name in the venture) and do-not-contact companies are skipped.
Engine rules stay as before: business data only, robots.txt respected, no logged-in sites, no CAPTCHA bypass, proxies or
IP rotation, gentle pacing; contact routes come from `mailto:`, `tel:` and `wa.me` links and text on the company's own pages.
