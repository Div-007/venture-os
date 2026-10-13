# Sales reports and Daybreak

Status: v1, 2026-10-10. The accountability and self-filling layer of Sales (Dealflow): a **Reports** tab that shows how the
pipeline is doing and how good Claude's judgement has been, and **Daybreak**, the morning work list a scheduled Claude Code run
(or a person) works through. Both are read only. Spec of the rest of Sales: `docs/sales-dealflow.md`.

Code: `apps/api/src/sales/reports.ts` (queries), `apps/api/src/routes/sales-reports.ts` (routes, mounted at `/v1/sales`),
`packages/contracts/src/sales.ts` (`salesReportSchema`, `daybreakSchema`), `apps/web/src/screens/sales/reports.tsx` and
`apps/web/src/components/sales/report-*.tsx` (the tab at `/sales/live/reports`), `apps/web/src/lib/sales-api.ts`
(`getSalesReport`, `getDaybreak`). Tests: `apps/api/test/sales-reports.test.ts`.

## 1. Honest numbers (every section)

- Every share comes with its sample: `{ count, n, value, small }`. `value` is `count / n` (0 to 1).
- **Below 5 cases no share is shown**: `value` is `null` and the screen prints "too few" with the `n`. The same rule holds for
  medians, the 90th percentile and averages (`{ value, n, small }`).
- **Below 30 cases a number is a small sample** (`small: true`); the screen marks it. High-touch plays send too few messages for
  rates to mean much (Prospector `docs/SALES_WORKFLOW.md` §3 and §7): judge them by account progress (reply, call, proposal, win),
  and read differences between plays, signals or confidence levels as hints until there are hundreds of cases.
- Thresholds travel with the report (`thresholds: { minN: 5, smallN: 30 }`).

## 2. Reports: `GET /v1/sales/reports`

Query: `ventureId` (optional: without it, every venture the person can open), `from`, `to`, `owner=me|all` (default `all`),
`tz` (optional). `from` and `to` are days (`YYYY-MM-DD`, whole days in the time zone, `to` included) or ISO times with a zone. The
default period is the last 30 days up to now; at most one year (`400` otherwise, and when `from` is not before `to`). The time zone
is `tz`, else the venture's sales settings, else Asia/Kolkata. Every member of the venture reads it, learners too; a venture the
person cannot open is `404`. `owner=me` keeps the leads the person owns. Soft-deleted leads never count.

### Funnel (`funnel`)

- **Active leads** (`active`): leads that *moved* in the period: added in it, or anything logged on them (a call, a message sent or
  received, a stage change, a verdict that moved them).
- **Steps** (`stages`): New, Contacted, Talking (replied, thinking), Meeting (call booked, qualified), Proposal, Won (the Pipeline
  columns without Closed). `leads` is how many active leads reached the step **or further** by the end of the period (a reply counts
  as Talking, a logged outbound touch as Contacted, a win as everything before it), so the bars only shrink. `entered` is how many
  got to the step *during* the period. `conversion` is `leads ÷ leads of the step before` (null for New).
- `closed`: active leads that are lost or not a fit at the end of the period.
- **Where leads come from** (`by.source | play | owner | city`): the same active leads split by source, play, owner and city (top
  10, the rest in one "other cities" row; case and spacing variants are one city). Each row: `leads, contacted, replied, meetings,
  proposals, won` (reached or further), `lostOrDisqualified` (closed now) and `replyRate = replied ÷ contacted`.
  Sources: **engine** (`externalRef.system = dealflow-engine`, the office PC), **claude** (created through the Claude connector, i.e.
  audit channel `mcp`, or imported with a `claude` reference), **manual** (created in the app), **import** (any other
  `externalRef`), **other** (no record of how it was made, e.g. seed data).

### Activity (`activity`)

- `days`: per day in the time zone: outbound `call`, `email`, `whatsapp`, `linkedin` (logged or marked sent) and `replies` received.
  `totals` adds them up (`messages` = email + WhatsApp + LinkedIn).
- `callOutcomes`: outbound calls by the outcome button pressed (every outcome listed, zeros too; `not_logged` when none was).
- `replyTypes`: replies by type (`unsorted` when nobody sorted it yet).
- `firstResponse`: how long a reply waited for **our next call or message** to that lead (an outbound activity, or a draft marked
  sent, after it). A run of replies before we answer counts once, from the first. Opt-outs and hostile replies are left out (no answer
  is owed). `medianHours` is clock time, `medianWorkingHours` counts only working hours. `unanswered`: replies in the period with no
  answer yet.
- `sla`: the reply-time promise on **warm replies** (interested, wants details, asks the price first): answered within the venture's
  `replySlaHours` (default 2) **working hours** (the venture's working days, 10:00 to 19:00 local, no blackout days; `workdays.ts`).
  `rate = within ÷ (within + late + missed)`; `pending` replies are still inside the time and not counted.

### Stage aging (`stageAging`)

Open leads (not won, lost or not a fit), now, whatever the period: per step, how many are open and the median and 90th-percentile
days since they **entered that step** (the last stage change into the step from another step; for leads imported straight into a
step, the first outbound touch for Contacted, the first reply for Talking, else when the lead was added). `oldest`: the 10 leads
(Contacted or further) that have waited longest; leads still New are counted but not listed (there are thousands).

### Claude's calibration (`calibration`)

Claude's verdicts (made through the connector, or imported from the local Dealflow engine) saved in the period, the latest per lead.
People's own verdicts are not Claude's to account for and are left out. Outcomes are where the lead stands **now**:

- `grid`: decision (recommend, hold, reject) × confidence (high, medium, low), nine cells. Each: `n` verdicts, `contacted` (ever),
  then the leads split by where they are: `won`, `lost`, `disqualified`, `meeting` (reached a call or further, still open), `replied`
  (replied, still open), `open` (the rest); `replyRate = replied ever ÷ contacted`; `small` below 30.
- `overridden`: Claude said hold or reject and a person overrode it: what happened to those leads (was the person right?).
- `overrides`: overrides of Claude's verdicts made in the period: `count`, `toRecommend` (a person said go where Claude did not),
  `fromRecommend` (the other way), and the last 20 with the person's reason.
- `precision`: of the leads Claude **recommended** and that were first contacted at least **10 working days ago**, the share that
  replied or booked a call. Leads contacted more recently (`tooRecent`) or not contacted (`notContacted`) are left out, so a
  recommendation is not counted as a miss before it had a chance.
- `signals`: the words of the verdicts' signals (`verdict.signal`; three letters or more, common words dropped), top 10 by leads
  contacted, with how many of those leads replied.

### Wins and losses (`winsLosses`)

- `won`: leads whose won date (`wonAt`) is in the period; `value` sums `valueEstimateMinor` per currency (minor units; INR when no
  currency); `withoutValue` counts wins with no value; `daysToWin` is the average days from when the lead was added to the win.
- `lost`: leads lost in the period (the stage change to lost; or the last update for leads with no recorded change), by `lostReason`
  when a person picked one, else the free-text `exitReason` sorted into the same buckets (price, no budget, no need, timing, chose
  someone else, stopped answering, not a fit, wrong person, other).
- `disqualified`: the same for "not a fit": asked us to stop, hostile reply, not a fit by verdict, or the lost buckets.

### The tab (`/sales/live/reports`)

Reached from the Sales sidebar (and the `reports` entry of the Sales tools). Period: This week (Monday to today), 30 days, Quarter
(the calendar quarter to date) or Custom (two dates, at most a year); Everyone or Mine; the venture from the sidebar. URL keeps the
choices (`range`, `from`, `to`, `owner=me`, `by`). Sections: headline tiles, Funnel (SVG bars), Wins and losses, Where leads come
from (a selector: source, play, owner, city; a table on laptops, rows on phones), Activity (per-day stacked bars by channel with
replies below the line, a "Show the numbers" table, call-outcome and reply-type histograms), Speed (median answer time, the 2-hour
promise, stage aging, the longest waits, each opening the lead), and Claude's calibration (precision, overrides, the decision ×
confidence grid, overrides with reasons, signal words, small-sample notes). Every section says what will appear once there is data.
**Copy as text** puts a plain summary on the clipboard for pasting into a chat or WhatsApp, with the same "too few" rule.

## 3. Daybreak: `GET /v1/sales/daybreak`

Query: `ventureId` (optional), `owner=me|all` (default `me`: the person's own morning), `tz` (optional; "today" ends at local
midnight in it). Members only (learners read it too). **Read only: nothing is written, notified or audited.**

| Field | What it holds |
|---|---|
| `followUpsDue` | Contacted leads (not on the do-not-contact list) whose `followUpDueAt` is by the end of today and that have **no follow-up draft waiting** (draft, in review, ready, needs changes). Each with the **first touch** (the first-touch draft marked sent: subject and body; else the first logged outbound call or message), its `channel`, and the verdict's `signal` (else the lead's observed signal), so a follow-up can refer back to it. Up to 100. |
| `staleVerdicts` | Leads not contacted yet whose verdict is **older than 30 days** or whose **signal was seen more than 60 days ago** (`signalSeenAt`), oldest verdict first, with `reasons`. `setBy` says whether Claude or a person set it; `claudeCanRejudge` is false for a person's verdict (Claude cannot replace it) and for a lead waiting on a person (needs you). |
| `needsContacts` | Open leads with no phone, WhatsApp or email route, newest first (100; the total is in `counts`). `enrichPending` marks leads that already have a queued or running enrich run. |
| `callsToday` | The Overview's calls-due list up to the end of today (approved for contact, or a "call" next action due), each with its phone and WhatsApp numbers and the latest call-opener draft (`callOpenerDraftId`). |
| `repliesWaiting` | Inbound messages not marked handled, oldest first, with the reply type, how long they have waited, whether they are past the venture's reply time in working hours (`overSla`, `slaDueAt`), and the **last thing we sent** them (the latest outbound message or sent draft). |
| `approvalsWaiting` | `drafts`: ready drafts that need a person's approval before they can be sent (the first batch of a play, or a venture that approves every message), with why. `needsYou`: leads waiting for a person's decision, with Claude's verdict. |
| `caps` | Per venture, what the person running Daybreak has sent **today** per channel (counted like the send route: since local midnight, by who logged it) against the venture's daily caps (`sales_settings.dailyCaps`, default 20 email and 20 WhatsApp; calls and LinkedIn have no cap: `null`). |
| `counts` | Totals for each list (`repliesOverSla` too). |
| `summary` | One line, e.g. "1 reply waiting over 2h, 3 calls today, 2 follow-ups to draft, 1 draft to approve, 4 verdicts to re-judge, 12 leads without contacts", or "Nothing waiting: a clear morning." |

## 4. Running Daybreak: the `daybreak` skill step

The MCP agent wires the tools and the skill; this is the contract they follow. Claude acts with the token owner's rights and every
rule in `docs/sales-dealflow.md` §1 and §5 still applies: **nothing is sent, nothing is approved**, drafts go to review.

1. **Call `daybreak`** (`GET /v1/sales/daybreak?ventureId=…&owner=me`) once per venture the person sells for, in a fresh **work**
   session (`start_sales`).
2. **Draft the follow-ups** with `save_drafts` (or `save_draft` one at a time; one draft per lead in `followUpsDue`, `purpose: "follow_up"`, on the first touch's
   channel unless the venture does not allow it). Refer back to `firstTouch` in one line, keep the verdict's `signal` as the reason for
   writing, ask one question, no price, no links (the review checklist). Skip a lead whose follow-up is already drafted (Daybreak
   leaves those out). Drafts never count against the caps (only sends do); `caps.left` tells the person how many they can send today.
3. **Queue enrich runs** with `enrich_lead` for leads in `needsContacts` that have `enrichPending: false` (newest first, at most 25 a
   morning so the office PC is not flooded). The office PC engine fills in published business contacts later.
4. **Re-judge stale verdicts** where `claudeCanRejudge` is true: fetch the company's pages again, quote fresh evidence with today's
   `seenAt`/`signalSeenAt`, and save a new verdict (`save_verdict`). List the others (a person's verdict, or needs-you) for a person.
5. **Post the summary**: the `summary` line plus what was done ("drafted 3 follow-ups, queued 12 enrich runs, re-judged 4") in the
   conversation, and, when the run is scheduled, in the venture's sales channel through the Venture Studio connector (`post_message`,
   labelled "via Claude"). Replies waiting, calls today and approvals stay with people: the summary points to them (`/sales/live`).

A **separate review session** (`/mcp__dealflow-sales__review_drafts`) then reviews the new drafts; a person sends them.

### What the MCP agent adds (exact routes)

| Tool | Route | Scope | Notes |
|---|---|---|---|
| `daybreak` | `GET /v1/sales/daybreak?ventureId&owner=me\|all&tz` | `sales:read` | Read only. Returns `daybreakSchema`. |
| `weekly_report` | `GET /v1/sales/reports?ventureId&from&to&owner=me\|all&tz` | `sales:read` | Read only. Returns `salesReportSchema`; default period the last 30 days; for the weekly learning step pass `from` = Monday (7 days back) and `to` = today. |

Both GET routes must be added to the MCP loopback allowlist (`isMcpRoute` in `apps/api/src/mcp/http.ts`). Neither needs anything
else on the server: they read with the token owner's venture access, and refuse ventures the owner cannot open (`404`).

**Weekly learning** (Prospector `docs/SALES_WORKFLOW.md` §4 step 8) with `weekly_report`: results by play, source and signal, Claude's
hit rate (`calibration.precision`, the grid, overrides and their reasons), then at most three suggested changes as brain drafts
(`propose_brain_change`) and a next play (`propose_play`); the owner approves in the app. Claude must quote the `n` behind every
number it uses and must not call a difference real when a cell is a small sample.

## 5. Scheduling it on the office PC (the owner switches it on)

Claude never schedules this itself. When the owner wants Daybreak every working morning, a Windows scheduled task can run Claude Code
headless at 08:30, Monday to Saturday, from the Prospector folder (where the `dealflow-sales` skill and the connector are set up):

```bat
schtasks /Create /TN "Dealflow Daybreak" /SC WEEKLY /D MON,TUE,WED,THU,FRI,SAT /ST 08:30 ^
  /TR "cmd /c cd /d \"C:\Users\hp\Documents\DIVYANSH PROJECTS\Prospector\" && claude -p \"Run the daybreak step for Buildory\" --allowedTools mcp__dealflow-sales__start_sales,mcp__dealflow-sales__daybreak,mcp__dealflow-sales__get_lead,mcp__dealflow-sales__save_drafts,mcp__dealflow-sales__save_verdict,mcp__dealflow-sales__enrich_lead,mcp__venture-studio__post_message >> \"%LOCALAPPDATA%\dealflow-daybreak.log\" 2>&1"
```

- Use the tool names the MCP agent ships (the list above is the shape: reads, drafts, verdicts, enrich, one post; **no** send,
  approve, override or stage tools).
- Festival blackout days and Sundays: Daybreak still answers (it reads), but follow-ups are not due on them, so the run is short.
- To stop it: `schtasks /Change /TN "Dealflow Daybreak" /DISABLE` (or delete it in Task Scheduler). The log file shows each morning's
  summary line.
