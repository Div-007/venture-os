// Accountability and the self-filling queue (docs/sales-reports-and-daybreak.md): the Reports tab (GET /sales/reports) and the
// morning work list a scheduled Claude Code run works through (GET /sales/daybreak). Queries only: nothing here writes.
//
// Honest numbers: every share carries its sample (n); below REPORT_MIN_N a share, median or average has no value (the screen says
// "too few"), below REPORT_SMALL_N it is marked as a small sample.
import type { Document } from "mongodb";
import { CALL_OUTCOMES, EXIT_STAGES, LOST_REASONS, PRE_CONTACT_STAGES, REPLY_TYPES, REPORT_MIN_N, REPORT_SMALL_N, SALES_CHANNELS, WON_STAGES, isoDateSchema, type SalesStage } from "@venture-studio/contracts";
import type { AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { loadVenture, ventureScope } from "./access.js";
import { settingsFor, type SalesCtx } from "./ctx.js";
import { OPEN_DRAFT_STATUSES, needsPersonApproval } from "./drafts.js";
import { offerClause } from "./offers.js";
import { whyFor } from "./present.js";
import { OUTBOUND_KINDS, normalizeStage } from "./rules.js";
import { calendarOf, type SalesSettings } from "./settings.js";
import { DEFAULT_CALENDAR, SALES_TZ, WORK_END_HOUR, WORK_START_HOUR, addWorkingHours, endOfLocalDay, isWorkingDay, localDay, localMoment, shiftDate, startOfLocalDay, workingDaysBetween, type WorkCalendar } from "./workdays.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WON_QUERY = [...WON_STAGES, "won"];
const CLOSED_QUERY = [...EXIT_STAGES, ...WON_QUERY];
/** Working days a recommended lead needs since its first contact before its outcome counts toward Claude's precision. */
export const PRECISION_WAIT_WORKING_DAYS = 10;
/** Replies that want an answer soon: the reply-time promise (SLA) is measured on these. */
const WARM_REPLIES = new Set(["interested", "send_details", "price_first"]);
/** Replies that end the conversation: nobody owes them an answer. */
const NO_ANSWER_NEEDED = new Set(["opt_out", "hostile"]);
const bad = (message: string) => new AppError(400, "BAD_REQUEST", message);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const dateOf = (value: unknown): Date | undefined => { if (!value) return undefined; const date = new Date(value as string | Date); return Number.isNaN(date.getTime()) ? undefined : date; };

// ---- Honest numbers ------------------------------------------------------------------------------------------------------

const round = (value: number, digits: number) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };
/** count of n, with no value below REPORT_MIN_N. */
export function rateOf(count: number, n: number) {
  return { count, n, value: n >= REPORT_MIN_N ? round(Math.min(1, count / n), 3) : null, small: n < REPORT_SMALL_N };
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}
/** A median, percentile or average with its sample, with no value below REPORT_MIN_N. */
export function statOf(values: number[], kind: "median" | "p90" | "mean", digits = 1) {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const raw = kind === "mean" ? sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, n) : percentile(sorted, kind === "median" ? 0.5 : 0.9);
  return { value: n >= REPORT_MIN_N ? round(raw, digits) : null, n, small: n < REPORT_SMALL_N };
}

// ---- Stage groups (the Pipeline columns) ---------------------------------------------------------------------------------

type Group = "new" | "contacted" | "talking" | "meeting" | "proposal" | "won" | "closed";
const GROUP: Record<SalesStage, Group> = {
  identified: "new", researched: "new", approved_for_contact: "new", contacted: "contacted", replied: "talking", thinking: "talking", discovery_booked: "meeting", qualified: "meeting",
  proposal: "proposal", invoice_contract: "won", cash_collected: "won", delivery: "won", retained_referred: "won", lost: "closed", disqualified: "closed",
};
const FUNNEL = ["new", "contacted", "talking", "meeting", "proposal", "won"] as const;
const GROUP_LABEL: Record<Group, string> = { new: "New", contacted: "Contacted", talking: "Talking", meeting: "Meeting", proposal: "Proposal", won: "Won", closed: "Closed" };
/** Position in the funnel (0 new ... 5 won); -1 for lost and disqualified. */
const rankOf = (stage: SalesStage) => (FUNNEL as readonly string[]).indexOf(GROUP[stage]);
const RANK = { contacted: 1, talking: 2, meeting: 3, proposal: 4, won: 5 } as const;

// ---- Labels ---------------------------------------------------------------------------------------------------------------

const CALL_OUTCOME_LABEL: Record<string, string> = {
  interested_book: "Interested: book a call", send_details: "Asked for details", call_back: "Call back later", no_answer: "No answer", busy: "Busy",
  not_interested: "Not interested", wrong_person: "Wrong person", wrong_number: "Wrong number", yes_whatsapp: "Said yes to WhatsApp", not_logged: "No outcome logged",
};
const REPLY_TYPE_LABEL: Record<string, string> = {
  interested: "Interested", send_details: "Wants details", price_first: "Asks the price first", not_now: "Not now", wrong_person: "Wrong person",
  has_system: "Already has a system", opt_out: "Asked us to stop", unclear: "Unclear", hostile: "Hostile", unsorted: "Not sorted yet",
};
const LOST_LABEL: Record<string, string> = {
  price: "Price", no_budget: "No budget", no_need: "No need", timing: "Timing", chose_competitor: "Chose someone else", no_response: "Stopped answering", not_a_fit: "Not a fit", wrong_person: "Wrong person", other: "Other",
};
const DISQUALIFIED_LABEL: Record<string, string> = { opt_out: "Asked us to stop", hostile: "Hostile reply", verdict: "Not a fit (verdict)", ...LOST_LABEL };
const SOURCE_LABEL: Record<string, string> = { engine: "Lead finder", claude: "Claude", manual: "Added in the app", import: "Imported", other: "Other" };

/** A free-text exit reason in one of the lost-reason buckets (for leads closed before the reason categories existed). */
export function bucketExitReason(text: unknown): string {
  const reason = String(text ?? "").toLowerCase();
  if (/price|expensive|cost|rate/.test(reason)) return "price";
  if (/budget|afford|funds/.test(reason)) return "no_budget";
  if (/not interested|no need|don'?t need|not needed|no requirement/.test(reason)) return "no_need";
  if (/later|timing|not now|next (year|month|quarter)|season/.test(reason)) return "timing";
  if (/competitor|another (vendor|agency)|went with|already (has|have|using|uses)|in-house/.test(reason)) return "chose_competitor";
  if (/no (response|reply|answer)|silen|ghost|unresponsive|stopped answering/.test(reason)) return "no_response";
  if (/not a fit|wrong (segment|size)|too (small|big|large)/.test(reason)) return "not_a_fit";
  if (/wrong (person|number|contact)/.test(reason)) return "wrong_person";
  return "other";
}
function disqualifiedBucket(text: unknown): string {
  const reason = String(text ?? "").toLowerCase();
  if (/asked not to be contacted|opt.?out|unsubscribe|stop/.test(reason)) return "opt_out";
  if (/hostile/.test(reason)) return "hostile";
  if (/^not a fit:/.test(reason)) return "verdict";
  return bucketExitReason(reason);
}

const STOP_WORDS = new Set(("the and for with from that this their they them have has had are was were our your its not but all any can will new more also into about than then who what when where which while been being per via " +
  "one two out off own just only very much many most some such each other over under after before again here there these those does did doing done would could should might " +
  "company business site page website web says said shows show showing lists listed listing mentions mentioned mention seen see saw recently recent now since year years month months " +
  "they're it's we're www http https com").split(" "));
/** The words of a verdict's signal that say something: lower case, three letters or more, no stop words or plain numbers. */
export function signalKeywords(signal: unknown): string[] {
  const words = String(signal ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  return [...new Set(words.map((word) => word.replace(/^['-]+|['-]+$/g, "")).filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)))];
}

// ---- Working rules ---------------------------------------------------------------------------------------------------------

/** The ventures a report or the morning list covers: the one asked for, or every venture the person can open (not archived). */
async function ventureIdsInScope(ctx: SalesCtx, ventureId: string | undefined): Promise<string[]> {
  if (ventureId) return [ventureId];
  const scope = ventureScope(ctx.actor, undefined, "_id");
  if (!scope) return [];
  return (await ctx.db.collection("ventures").find({ workspaceId: ctx.workspaceId, status: { $ne: "archived" }, ...scope }, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map((row) => String(row._id));
}

/** A venture's working rules as the responses show them: what the reply-time promise and working hours are measured with. */
const workRulesOf = (ventureId: string, settings: SalesSettings) => ({
  ventureId, replySlaHours: settings.replySlaHours, workingDays: [...settings.workingDays], blackoutDates: [...settings.blackoutDates], timezone: settings.timezone, workStartHour: WORK_START_HOUR, workEndHour: WORK_END_HOUR,
});

/** The one reply time every venture shares (the summary can name it), or null when they differ. */
const sharedSlaHours = (rules: { replySlaHours: number }[], fallback: number): number | null => {
  const hours = [...new Set(rules.map((row) => row.replySlaHours))];
  return hours.length === 0 ? fallback : hours.length === 1 ? hours[0]! : null;
};

// ---- Time ------------------------------------------------------------------------------------------------------------------

const zoneCalendar = (timeZone: string): WorkCalendar => ({ ...DEFAULT_CALENDAR, timeZone });
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: string) => { const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value); };
function moment(value: string, cal: WorkCalendar, end: boolean, field: "from" | "to"): Date {
  if (DAY_TEXT.test(value)) {
    if (!realDay(value)) throw bad(`${field} is not a real date`);
    return localMoment(end ? shiftDate(value, 1) : value, 0, 0, cal);
  }
  if (!isoDateSchema.safeParse(value).success) throw bad(`${field} must be a day (YYYY-MM-DD) or an ISO time with its zone`);
  return new Date(value);
}

/** The report period: days are whole days in `tz` (`to` included); default the last 30 days; at most one year. */
export function reportRange(query: { from?: string | undefined; to?: string | undefined }, tz: string, now: Date): { from: Date; to: Date } {
  const cal = zoneCalendar(tz);
  const to = query.to ? moment(query.to, cal, true, "to") : now;
  const from = query.from ? moment(query.from, cal, false, "from") : new Date(to.getTime() - 30 * DAY_MS);
  if (from.getTime() >= to.getTime()) throw bad("from must be before to");
  if (to.getTime() - from.getTime() > 366 * DAY_MS + 2 * HOUR_MS) throw bad("A report covers at most one year: pick a shorter period");
  return { from, to };
}

/** Working hours (the calendar's working days, 10:00 to 19:00 local, no blackout days) between two instants. */
export function workingHoursBetween(a: Date, b: Date, cal: WorkCalendar = DEFAULT_CALENDAR): number {
  if (b.getTime() <= a.getTime()) return 0;
  let total = 0;
  let day = localDay(a, cal);
  const last = localDay(b, cal);
  for (let guard = 0; guard < 800; guard++) {
    if (isWorkingDay(day, cal)) {
      const start = Math.max(a.getTime(), localMoment(day, WORK_START_HOUR, 0, cal).getTime());
      const end = Math.min(b.getTime(), localMoment(day, WORK_END_HOUR, 0, cal).getTime());
      if (end > start) total += end - start;
    }
    if (day >= last) break;
    day = shiftDate(day, 1);
  }
  return total / HOUR_MS;
}

// ---- A lead's history ------------------------------------------------------------------------------------------------------

type Move = { at: Date; from?: SalesStage; to: SalesStage };
type Touch = { at: Date; dir: "in" | "out"; kind: string; callOutcome?: string; replyType?: string };
type History = { moves: Move[]; touches: Touch[]; sent: Date[] };
type Facts = { exists: boolean; stage: SalesStage; rank: number };

const creationStage = (lead: AppDocument, history: History): SalesStage => history.moves[0]?.from ?? normalizeStage(lead.stage);

/** Where a lead stood at `cutoff`: its stage then, and the furthest funnel step it had reached (a reply counts as Talking, an outbound touch as Contacted). */
function factsAt(lead: AppDocument, history: History, cutoff: Date, now: Date): Facts {
  const created = dateOf(lead.createdAt);
  const exists = !created || created.getTime() <= cutoff.getTime();
  const current = cutoff.getTime() >= now.getTime();
  const first = creationStage(lead, history);
  let stage = current ? normalizeStage(lead.stage) : first;
  let rank = Math.max(0, rankOf(first));
  for (const move of history.moves) {
    if (move.at.getTime() > cutoff.getTime()) break;
    if (!current) stage = move.to;
    rank = Math.max(rank, rankOf(move.to));
  }
  for (const touch of history.touches) {
    if (touch.at.getTime() > cutoff.getTime()) break;
    if (touch.dir === "in") rank = Math.max(rank, RANK.talking);
    else if (touch.callOutcome !== "wrong_number") rank = Math.max(rank, RANK.contacted);
  }
  const lastTouch = dateOf(lead.lastTouchAt);
  if (lastTouch && lastTouch.getTime() <= cutoff.getTime()) rank = Math.max(rank, RANK.contacted);
  const wonAt = dateOf(lead.wonAt);
  if (wonAt && wonAt.getTime() <= cutoff.getTime()) rank = RANK.won;
  if (current) rank = Math.max(rank, rankOf(stage));
  return { exists, stage, rank };
}

const LEAD_FIELDS = { _id: 1, ventureId: 1, stage: 1, createdAt: 1, updatedAt: 1, ownerId: 1, playId: 1, externalRef: 1, city: 1, companyName: 1, lastTouchAt: 1, wonAt: 1, valueEstimateMinor: 1, currency: 1, lostReason: 1, exitReason: 1 };

async function loadHistories(ctx: SalesCtx, scope: Document, leads: Map<string, AppDocument>): Promise<Map<string, History>> {
  const histories = new Map<string, History>();
  for (const id of leads.keys()) histories.set(id, { moves: [], touches: [], sent: [] });
  const [activities, sent] = await Promise.all([
    ctx.db.collection("sales_activities").find(
      { workspaceId: ctx.workspaceId, ...scope, $or: [{ stageTo: { $ne: null } }, { direction: { $in: ["in", "out"] } }] },
      { projection: { leadId: 1, at: 1, direction: 1, kind: 1, callOutcome: 1, replyType: 1, stageFrom: 1, stageTo: 1 } },
    ).toArray(),
    ctx.db.collection("sales_drafts").find({ workspaceId: ctx.workspaceId, ...scope, status: "sent", sentAt: { $ne: null } }, { projection: { leadId: 1, sentAt: 1 } }).toArray(),
  ]);
  for (const row of activities) {
    const history = histories.get(String(row.leadId));
    const at = dateOf(row.at);
    if (!history || !at) continue;
    if (row.stageTo) history.moves.push({ at, ...(row.stageFrom ? { from: normalizeStage(row.stageFrom) } : {}), to: normalizeStage(row.stageTo) });
    if (row.direction === "in" || (row.direction === "out" && (OUTBOUND_KINDS as readonly string[]).includes(String(row.kind)))) {
      history.touches.push({ at, dir: row.direction, kind: String(row.kind), ...(row.callOutcome ? { callOutcome: String(row.callOutcome) } : {}), ...(row.replyType ? { replyType: String(row.replyType) } : {}) });
    }
  }
  for (const row of sent) { const at = dateOf(row.sentAt); if (at) histories.get(String(row.leadId))?.sent.push(at); }
  for (const history of histories.values()) {
    history.moves.sort((a, b) => a.at.getTime() - b.at.getTime());
    history.touches.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.dir === b.dir ? 0 : a.dir === "in" ? -1 : 1));
    history.sent.sort((a, b) => a.getTime() - b.getTime());
  }
  return histories;
}

// ---- Report ----------------------------------------------------------------------------------------------------------------

type ReportQuery = { ventureId?: string | undefined; offerId?: string | undefined; from?: string | undefined; to?: string | undefined; owner: "me" | "all"; tz?: string | undefined };
type Row = { key: string; label: string; leads: number; contacted: number; replied: number; meetings: number; proposals: number; won: number; lostOrDisqualified: number };
type Outcome = "replied" | "meeting" | "won" | "lost" | "disqualified" | "open";
/** 0 for a spelling that starts with a capital ("Raipur"), so it wins a tie against "raipur". */
const capitalFirst = (text: string) => (/^\p{Lu}/u.test(text) ? 0 : 1);

function outcomeOf(facts: Facts): Outcome {
  if (GROUP[facts.stage] === "won") return "won";
  if (facts.stage === "lost") return "lost";
  if (facts.stage === "disqualified") return "disqualified";
  if (facts.rank >= RANK.meeting) return "meeting";
  if (facts.rank >= RANK.talking) return "replied";
  return "open";
}
function outcomes(list: Facts[]) {
  const counts = { n: list.length, contacted: 0, replied: 0, meeting: 0, won: 0, lost: 0, disqualified: 0, open: 0 };
  let repliedEver = 0;
  for (const facts of list) {
    counts[outcomeOf(facts)]++;
    if (facts.rank >= RANK.contacted) counts.contacted++;
    if (facts.rank >= RANK.talking) repliedEver++;
  }
  return { ...counts, replyRate: rateOf(repliedEver, counts.contacted), small: counts.n < REPORT_SMALL_N };
}

/** The Reports tab: funnel, activity, speed, stage aging, Claude's calibration, wins and losses, for one venture or all the person can open. */
export async function buildReport(ctx: SalesCtx, query: ReportQuery, now = new Date()) {
  if (query.ventureId) await loadVenture(ctx.db, ctx.actor, query.ventureId);
  const scope = ventureScope(ctx.actor, query.ventureId)!;
  const ventureSettings = query.ventureId ? await settingsFor(ctx, query.ventureId) : undefined;
  const tz = query.tz ?? ventureSettings?.timezone ?? SALES_TZ;
  const { from, to } = reportRange(query, tz, now);
  const inRange = (at: Date | undefined) => !!at && at.getTime() >= from.getTime() && at.getTime() < to.getTime();
  const { db, workspaceId } = ctx;
  // One offer's leads (or the ones with none) when asked: everything below counts only the leads in `base`.
  const base: Document = { workspaceId, deletedAt: null, ...scope, ...(query.owner === "me" ? { ownerId: ctx.actor.id } : {}), ...offerClause(query.offerId) };

  const leadRows = await db.collection("opportunities").find(base, { projection: LEAD_FIELDS }).toArray();
  const leads = new Map(leadRows.map((lead) => [String(lead._id), lead]));
  const histories = await loadHistories(ctx, scope, leads);
  const settingsOf = new Map<string, SalesSettings>();
  for (const ventureId of new Set(leadRows.map((lead) => String(lead.ventureId)))) settingsOf.set(ventureId, await settingsFor(ctx, ventureId));
  // Every venture in the report, with the rules its speed numbers use (also ventures with no leads yet).
  const workRules = await Promise.all((await ventureIdsInScope(ctx, query.ventureId)).map(async (ventureId) => workRulesOf(ventureId, settingsOf.get(ventureId) ?? await settingsFor(ctx, ventureId))));
  const calendarFor = (lead: AppDocument) => calendarOf(settingsOf.get(String(lead.ventureId))!);
  const nowFacts = new Map<string, Facts>();
  for (const [id, lead] of leads) nowFacts.set(id, factsAt(lead, histories.get(id)!, now, now));

  // ---- Funnel: the leads that moved in the period, and how far each got by its end.
  const before = new Date(from.getTime() - 1);
  const active: { lead: AppDocument; facts: Facts }[] = [];
  const entered = FUNNEL.map(() => 0);
  for (const [id, lead] of leads) {
    const history = histories.get(id)!;
    const facts = factsAt(lead, history, to, now);
    if (!facts.exists) continue;
    // Arriving counts as movement, except for rows copied in from the old Dealflow database: a bulk import is not sales activity.
    const arrived = inRange(dateOf(lead.createdAt)) && str(lead.externalRef?.system) !== "dealflow-sqlite";
    const moved = arrived || history.moves.some((move) => inRange(move.at)) || history.touches.some((touch) => inRange(touch.at));
    if (!moved) continue;
    active.push({ lead, facts });
    const earlier = factsAt(lead, history, before, now);
    const rankBefore = earlier.exists ? earlier.rank : -1;
    for (let rank = rankBefore + 1; rank <= facts.rank; rank++) entered[rank]!++;
  }
  const reached = FUNNEL.map((_, rank) => active.filter((item) => item.facts.rank >= rank).length);
  const stages = FUNNEL.map((key, rank) => ({ key, label: GROUP_LABEL[key], leads: reached[rank]!, entered: entered[rank]!, conversion: rank === 0 ? null : rateOf(reached[rank]!, reached[rank - 1]!) }));

  // Where the leads came from: Claude's leads are the ones its connector created (audit channel "mcp") or imported with a "claude" reference.
  const created = new Map<string, string>();
  const unreferenced = active.filter((item) => !item.lead.externalRef?.system).map((item) => String(item.lead._id));
  if (unreferenced.length) {
    const audits = await db.collection("audit_events").find({ workspaceId, action: "sales.lead.create", objectId: { $in: unreferenced } }, { projection: { objectId: 1, channel: 1 } }).toArray();
    for (const row of audits) created.set(String(row.objectId), String(row.channel));
  }
  const sourceOf = (lead: AppDocument) => {
    const system = str(lead.externalRef?.system);
    if (system === "dealflow-engine" || system === "builtin-finder") return "engine";
    if (system === "claude" || created.get(String(lead._id)) === "mcp") return "claude";
    if (system) return "import";
    const channel = created.get(String(lead._id));
    return channel === "api" || channel === "web" || channel === "socket" ? "manual" : channel === "engine" ? "engine" : "other";
  };
  const playIds = [...new Set(active.map((item) => str(item.lead.playId)).filter((id): id is string => !!id))];
  const ownerIds = [...new Set(active.map((item) => String(item.lead.ownerId)))];
  const [plays, people] = await Promise.all([
    playIds.length ? db.collection("sales_plays").find({ _id: { $in: playIds }, workspaceId }, { projection: { name: 1 } }).toArray() : [],
    ownerIds.length ? db.collection("users").find({ _id: { $in: ownerIds } }, { projection: { name: 1 } }).toArray() : [],
  ]);
  const playName = new Map(plays.map((play) => [String(play._id), String(play.name ?? "Play")]));
  const personName = new Map(people.map((person) => [String(person._id), String(person.name ?? "Teammate")]));
  const tally = (keyOf: (lead: AppDocument) => { key: string; label: string }) => {
    const rows = new Map<string, Row & { spellings: Map<string, number> }>();
    for (const { lead, facts } of active) {
      const { key, label } = keyOf(lead);
      let row = rows.get(key);
      if (!row) { row = { key, label, leads: 0, contacted: 0, replied: 0, meetings: 0, proposals: 0, won: 0, lostOrDisqualified: 0, spellings: new Map() }; rows.set(key, row); }
      row.spellings.set(label, (row.spellings.get(label) ?? 0) + 1);
      row.leads++;
      if (facts.rank >= RANK.contacted) row.contacted++;
      if (facts.rank >= RANK.talking) row.replied++;
      if (facts.rank >= RANK.meeting) row.meetings++;
      if (facts.rank >= RANK.proposal) row.proposals++;
      if (facts.rank >= RANK.won) row.won++;
      if (GROUP[facts.stage] === "closed") row.lostOrDisqualified++;
    }
    return [...rows.values()].map(({ spellings, ...row }) => ({ ...row, label: [...spellings.entries()].sort((a, b) => b[1] - a[1] || capitalFirst(a[0]) - capitalFirst(b[0]) || a[0].localeCompare(b[0]))[0]?.[0] ?? row.label }))
      .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));
  };
  const withRate = (row: Row) => ({ ...row, replyRate: rateOf(row.replied, row.contacted) });
  const cityRows = tally((lead) => { const city = str(lead.city)?.trim(); return city ? { key: city.toLowerCase(), label: city } : { key: "none", label: "Not set" }; });
  const topCities: Row[] = cityRows.slice(0, 10);
  if (cityRows.length > 10) {
    const rest = cityRows.slice(10);
    const sum = (field: keyof Omit<Row, "key" | "label">) => rest.reduce((total, row) => total + row[field], 0);
    topCities.push({ key: "other", label: `${rest.length} other ${rest.length === 1 ? "city" : "cities"}`, leads: sum("leads"), contacted: sum("contacted"), replied: sum("replied"), meetings: sum("meetings"), proposals: sum("proposals"), won: sum("won"), lostOrDisqualified: sum("lostOrDisqualified") });
  }
  const by = {
    source: tally((lead) => { const key = sourceOf(lead); return { key, label: SOURCE_LABEL[key]! }; }).map(withRate),
    play: tally((lead) => { const id = str(lead.playId); return id ? { key: id, label: playName.get(id) ?? "Play" } : { key: "none", label: "No play" }; }).map(withRate),
    owner: tally((lead) => ({ key: String(lead.ownerId), label: personName.get(String(lead.ownerId)) ?? "Teammate" })).map(withRate),
    city: topCities.map(withRate),
  };

  // ---- Activity: calls and messages per day and channel, call outcomes, reply types, how fast replies were answered.
  const zone = zoneCalendar(tz);
  const days = new Map<string, { day: string; call: number; email: number; whatsapp: number; linkedin: number; replies: number }>();
  const lastDay = localDay(new Date(to.getTime() - 1), zone);
  for (let day = localDay(from, zone), guard = 0; day <= lastDay && guard < 400; day = shiftDate(day, 1), guard++) days.set(day, { day, call: 0, email: 0, whatsapp: 0, linkedin: 0, replies: 0 });
  const callOutcomes = new Map<string, number>();
  const replyTypes = new Map<string, number>();
  const waits: number[] = [], workingWaits: number[] = [];
  let unanswered = 0;
  const sla = { within: 0, late: 0, missed: 0, pending: 0 };
  for (const [id, history] of histories) {
    const lead = leads.get(id)!;
    const cal = calendarFor(lead);
    const settings = settingsOf.get(String(lead.ventureId)) ?? ventureSettings;
    for (const touch of history.touches) {
      if (!inRange(touch.at)) continue;
      const bucket = days.get(localDay(touch.at, zone));
      if (touch.dir === "in") {
        if (bucket) bucket.replies++;
        const type = touch.replyType && touch.replyType in REPLY_TYPE_LABEL ? touch.replyType : "unsorted";
        replyTypes.set(type, (replyTypes.get(type) ?? 0) + 1);
      } else {
        if (bucket && (touch.kind === "call" || touch.kind === "email" || touch.kind === "whatsapp" || touch.kind === "linkedin")) bucket[touch.kind]++;
        if (touch.kind === "call") { const outcome = touch.callOutcome ?? "not_logged"; callOutcomes.set(outcome, (callOutcomes.get(outcome) ?? 0) + 1); }
      }
    }
    // Our answers: outbound calls and messages, and drafts marked sent.
    const answers = [...history.touches.filter((touch) => touch.dir === "out").map((touch) => touch.at), ...history.sent].sort((a, b) => a.getTime() - b.getTime());
    const nextAnswer = (after: Date) => answers.find((at) => at.getTime() > after.getTime());
    // Time to answer: the first reply of a run of replies waits until our next call or message.
    let waiting: Date | null = null;
    const events = [...history.touches.filter((touch) => touch.dir === "in").map((touch) => ({ at: touch.at, in: true, type: touch.replyType })), ...answers.map((at) => ({ at, in: false, type: undefined }))]
      .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.in === b.in ? 0 : a.in ? -1 : 1));
    for (const event of events) {
      if (event.in) {
        if (event.type && NO_ANSWER_NEEDED.has(event.type)) { waiting = null; continue; }
        waiting ??= event.at;
      } else if (waiting) {
        if (inRange(waiting)) { waits.push((event.at.getTime() - waiting.getTime()) / HOUR_MS); workingWaits.push(workingHoursBetween(waiting, event.at, cal)); }
        waiting = null;
      }
    }
    if (waiting && inRange(waiting)) unanswered++;
    // The reply-time promise on warm replies, in working hours.
    for (const touch of history.touches) {
      if (touch.dir !== "in" || !inRange(touch.at) || !touch.replyType || !WARM_REPLIES.has(touch.replyType)) continue;
      const due = addWorkingHours(touch.at, settings?.replySlaHours ?? 2, cal);
      const answer = nextAnswer(touch.at);
      if (answer) { if (answer.getTime() <= due.getTime()) sla.within++; else sla.late++; }
      else if (now.getTime() > due.getTime()) sla.missed++;
      else sla.pending++;
    }
  }
  const dayRows = [...days.values()];
  const histogram = (counts: Map<string, number>, keys: readonly string[], labels: Record<string, string>) => [...keys, ...[...counts.keys()].filter((key) => !keys.includes(key))]
    .map((key) => ({ key, label: labels[key] ?? key, count: counts.get(key) ?? 0 })).filter((row) => row.count > 0 || keys.includes(row.key));

  // ---- Stage aging: how long open leads have waited in their current step.
  const aging = new Map<Group, number[]>();
  const waitingLeads: { lead: AppDocument; group: Group; days: number; since: Date }[] = [];
  for (const [id, lead] of leads) {
    const stage = normalizeStage(lead.stage);
    const group = GROUP[stage];
    if (group === "won" || group === "closed") continue;
    const history = histories.get(id)!;
    const entry = [...history.moves].reverse().find((move) => GROUP[move.to] === group && (!move.from || GROUP[move.from] !== group))?.at
      ?? (group === "contacted" ? history.touches.find((touch) => touch.dir === "out")?.at : group === "talking" ? history.touches.find((touch) => touch.dir === "in")?.at : undefined)
      ?? dateOf(lead.createdAt) ?? now;
    const waited = Math.max(0, (now.getTime() - entry.getTime()) / DAY_MS);
    (aging.get(group) ?? aging.set(group, []).get(group)!).push(waited);
    if (group !== "new") waitingLeads.push({ lead, group, days: waited, since: entry });
  }
  const stageAging = {
    groups: (["new", "contacted", "talking", "meeting", "proposal"] as const).map((key) => ({ key, label: GROUP_LABEL[key], open: aging.get(key)?.length ?? 0, medianDays: statOf(aging.get(key) ?? [], "median"), p90Days: statOf(aging.get(key) ?? [], "p90") })),
    oldest: waitingLeads.sort((a, b) => b.days - a.days).slice(0, 10).map(({ lead, group, days: waited, since }) => ({
      leadId: String(lead._id), ventureId: String(lead.ventureId), companyName: String(lead.companyName ?? ""), stage: normalizeStage(lead.stage), group, days: round(waited, 1), since, ownerId: String(lead.ownerId),
    })),
  };

  // ---- Claude's calibration: what happened to the leads Claude judged in the period.
  const verdictRows = await db.collection("sales_verdicts").find(
    { workspaceId, ...scope, via: { $in: ["claude", "import"] }, createdAt: { $gte: from, $lt: to } },
    { projection: { leadId: 1, decision: 1, confidence: 1, signal: 1, createdAt: 1, override: 1 } },
  ).sort({ createdAt: 1, _id: 1 }).toArray();
  const latest = new Map<string, AppDocument>();
  for (const verdict of verdictRows) if (leads.has(String(verdict.leadId))) latest.set(String(verdict.leadId), verdict);
  const judged = [...latest.values()];
  const factsOfVerdict = (verdict: AppDocument) => nowFacts.get(String(verdict.leadId))!;
  const grid = (["recommend", "hold", "reject"] as const).flatMap((decision) => (["high", "medium", "low"] as const).map((confidence) => ({
    decision, confidence, ...outcomes(judged.filter((verdict) => verdict.decision === decision && verdict.confidence === confidence).map(factsOfVerdict)),
  })));
  const overridden = outcomes(judged.filter((verdict) => verdict.decision !== "recommend" && verdict.override).map(factsOfVerdict));
  const overrideRows = await db.collection("sales_verdicts").find(
    { workspaceId, ...scope, via: { $in: ["claude", "import"] }, "override.at": { $gte: from, $lt: to } },
    { projection: { leadId: 1, decision: 1, confidence: 1, override: 1 } },
  ).sort({ "override.at": -1, _id: 1 }).toArray();
  const visibleOverrides = overrideRows.filter((verdict) => leads.has(String(verdict.leadId)));
  const overrides = {
    count: visibleOverrides.length,
    toRecommend: visibleOverrides.filter((verdict) => verdict.decision !== "recommend" && verdict.override?.decision === "recommend").length,
    fromRecommend: visibleOverrides.filter((verdict) => verdict.decision === "recommend" && verdict.override?.decision !== "recommend").length,
    recent: visibleOverrides.slice(0, 20).map((verdict) => ({
      verdictId: String(verdict._id), leadId: String(verdict.leadId), companyName: String(leads.get(String(verdict.leadId))?.companyName ?? ""), decision: verdict.decision, confidence: verdict.confidence,
      to: verdict.override.decision, reason: String(verdict.override.reason ?? ""), by: String(verdict.override.by), at: dateOf(verdict.override.at)!,
    })),
  };
  // Precision: recommended leads that replied or booked, of those contacted long enough ago to have had the chance.
  let hits = 0, ripe = 0, tooRecent = 0, notContacted = 0;
  for (const verdict of judged.filter((row) => row.decision === "recommend")) {
    const lead = leads.get(String(verdict.leadId))!;
    const history = histories.get(String(verdict.leadId))!;
    // First contact: the first outbound touch, else the last touch on record, else when a person moved it to Contacted or further.
    const firstTouch = history.touches.find((touch) => touch.dir === "out" && touch.callOutcome !== "wrong_number")?.at ?? dateOf(lead.lastTouchAt) ?? history.moves.find((move) => rankOf(move.to) >= RANK.contacted)?.at;
    if (!firstTouch) { notContacted++; continue; }
    if (workingDaysBetween(firstTouch, now, calendarFor(lead)) < PRECISION_WAIT_WORKING_DAYS) { tooRecent++; continue; }
    ripe++;
    if (factsOfVerdict(verdict).rank >= RANK.talking) hits++;
  }
  const keywordRows = new Map<string, { keyword: string; leads: number; contacted: number; replied: number }>();
  for (const verdict of judged) {
    const facts = factsOfVerdict(verdict);
    for (const keyword of signalKeywords(verdict.signal)) {
      const row = keywordRows.get(keyword) ?? { keyword, leads: 0, contacted: 0, replied: 0 };
      row.leads++;
      if (facts.rank >= RANK.contacted) row.contacted++;
      if (facts.rank >= RANK.talking) row.replied++;
      keywordRows.set(keyword, row);
    }
  }
  const signals = [...keywordRows.values()].sort((a, b) => b.contacted - a.contacted || b.leads - a.leads || a.keyword.localeCompare(b.keyword)).slice(0, 10).map((row) => ({ ...row, replyRate: rateOf(row.replied, row.contacted) }));

  // ---- Wins and losses in the period.
  const wonLeads = leadRows.filter((lead) => inRange(dateOf(lead.wonAt)));
  const value = new Map<string, number>();
  for (const lead of wonLeads) {
    const currency = String(lead.currency ?? "INR").trim().toUpperCase();
    // A value stored with something that is not a three-letter code (before the code was checked) is left out of the money.
    if (typeof lead.valueEstimateMinor === "number" && /^[A-Z]{3}$/.test(currency)) value.set(currency, (value.get(currency) ?? 0) + lead.valueEstimateMinor);
  }
  const closedAt = (lead: AppDocument, stage: SalesStage) => [...histories.get(String(lead._id))!.moves].reverse().find((move) => move.to === stage)?.at ?? dateOf(lead.updatedAt);
  const lostLeads = leadRows.filter((lead) => normalizeStage(lead.stage) === "lost" && inRange(closedAt(lead, "lost")));
  const disqualifiedLeads = leadRows.filter((lead) => normalizeStage(lead.stage) === "disqualified" && inRange(closedAt(lead, "disqualified")));
  const reasonCounts = (rows: AppDocument[], bucket: (lead: AppDocument) => string, labels: Record<string, string>) => {
    const counts = new Map<string, number>();
    for (const lead of rows) { const key = bucket(lead); counts.set(key, (counts.get(key) ?? 0) + 1); }
    return [...counts.entries()].map(([key, count]) => ({ key, label: labels[key] ?? key, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };

  return jsonValue({
    range: { from, to, days: Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS)), tz, owner: query.owner, ...(query.ventureId ? { ventureId: query.ventureId } : {}), ...(query.offerId ? { offerId: query.offerId } : {}) },
    workRules,
    generatedAt: now,
    thresholds: { minN: REPORT_MIN_N, smallN: REPORT_SMALL_N },
    funnel: { active: active.length, stages, closed: { lost: active.filter((item) => item.facts.stage === "lost").length, disqualified: active.filter((item) => item.facts.stage === "disqualified").length }, by },
    activity: {
      days: dayRows,
      totals: { calls: dayRows.reduce((sum, day) => sum + day.call, 0), messages: dayRows.reduce((sum, day) => sum + day.email + day.whatsapp + day.linkedin, 0), replies: dayRows.reduce((sum, day) => sum + day.replies, 0) },
      callOutcomes: histogram(callOutcomes, CALL_OUTCOMES, CALL_OUTCOME_LABEL),
      replyTypes: histogram(replyTypes, REPLY_TYPES.filter((type) => type !== "silence"), REPLY_TYPE_LABEL),
      firstResponse: { medianHours: statOf(waits, "median"), medianWorkingHours: statOf(workingWaits, "median"), unanswered },
      sla: { hours: ventureSettings?.replySlaHours ?? (settingsOf.size === 1 ? [...settingsOf.values()][0]!.replySlaHours : sharedSlaHours(workRules, 2) ?? 2), rate: rateOf(sla.within, sla.within + sla.late + sla.missed), pending: sla.pending, late: sla.late, missed: sla.missed },
    },
    stageAging,
    calibration: { verdicts: judged.length, grid, overridden, overrides, precision: { rate: rateOf(hits, ripe), waitDays: PRECISION_WAIT_WORKING_DAYS, tooRecent, notContacted }, signals },
    winsLosses: {
      won: {
        count: wonLeads.length, value: [...value.entries()].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => b.minor - a.minor),
        withoutValue: wonLeads.filter((lead) => typeof lead.valueEstimateMinor !== "number").length,
        daysToWin: statOf(wonLeads.map((lead) => Math.max(0, (dateOf(lead.wonAt)!.getTime() - (dateOf(lead.createdAt) ?? dateOf(lead.wonAt)!).getTime()) / DAY_MS)), "mean"),
      },
      lost: { count: lostLeads.length, reasons: reasonCounts(lostLeads, (lead) => (LOST_REASONS as readonly string[]).includes(String(lead.lostReason)) ? String(lead.lostReason) : bucketExitReason(lead.exitReason), LOST_LABEL) },
      disqualified: { count: disqualifiedLeads.length, reasons: reasonCounts(disqualifiedLeads, (lead) => disqualifiedBucket(lead.exitReason), DISQUALIFIED_LABEL) },
    },
  });
}

// ---- Daybreak --------------------------------------------------------------------------------------------------------------

type DaybreakQuery = { ventureId?: string | undefined; offerId?: string | undefined; owner: "me" | "all"; tz?: string | undefined };
const LIST = 100;
const brief = (lead: AppDocument) => ({
  id: String(lead._id), ventureId: String(lead.ventureId), ...(str(lead.offerId) ? { offerId: String(lead.offerId) } : {}), companyName: String(lead.companyName ?? ""), contactName: String(lead.contactName ?? ""),
  ...(str(lead.city) ? { city: String(lead.city) } : {}), stage: normalizeStage(lead.stage), ownerId: String(lead.ownerId),
});
const firstPerLead = <T extends AppDocument>(rows: T[]) => { const map = new Map<string, T>(); for (const row of rows) if (!map.has(String(row.leadId))) map.set(String(row.leadId), row); return map; };
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The morning work list: follow-ups to draft, verdicts to re-judge, leads without contacts, today's calls, replies waiting, what waits
 * for a person's approval, today's sends against the daily caps, and a one-line summary. Read only.
 */
export async function buildDaybreak(ctx: SalesCtx, query: DaybreakQuery, now = new Date()) {
  if (query.ventureId) await loadVenture(ctx.db, ctx.actor, query.ventureId);
  const scope = ventureScope(ctx.actor, query.ventureId)!;
  const { db, workspaceId } = ctx;
  const ventureSettings = query.ventureId ? await settingsFor(ctx, query.ventureId) : undefined;
  const tz = query.tz ?? ventureSettings?.timezone ?? SALES_TZ;
  const endOfToday = endOfLocalDay(now, tz);
  const dayStart = startOfLocalDay(now, tz);
  const base: Document = { workspaceId, deletedAt: null, ...scope, ...(query.owner === "me" ? { ownerId: ctx.actor.id } : {}), ...offerClause(query.offerId) };
  // The same narrowing for replies and drafts, joined to their lead.
  const ofLead: Document = { "lead.deletedAt": null, ...(query.owner === "me" ? { "lead.ownerId": ctx.actor.id } : {}), ...offerClause(query.offerId, "lead.offerId") };
  const open: Document = { stage: { $nin: CLOSED_QUERY } };
  const leads = db.collection("opportunities");
  const drafts = db.collection("sales_drafts");
  const activities = db.collection("sales_activities");
  const settingsOfLead = (lead: AppDocument) => settingsFor(ctx, String(lead.ventureId));

  const callsFilter: Document = {
    ...base, ...open, doNotContact: { $ne: true }, contactRoutes: { $elemMatch: { kind: { $in: ["phone", "whatsapp"] } } },
    $or: [{ nextActionAt: { $lt: endOfToday }, nextAction: /call/i }, { stage: "approved_for_contact", $or: [{ nextActionAt: null }, { nextActionAt: { $lt: endOfToday } }] }],
  };
  const noRoute: Document = { ...base, ...open, doNotContact: { $ne: true }, contactRoutes: { $not: { $elemMatch: { kind: { $in: ["phone", "whatsapp", "email"] } } } } };
  const verdictCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const signalCutoff = new Date(now.getTime() - 60 * DAY_MS);
  const preContact: Document = { ...base, stage: { $in: [...PRE_CONTACT_STAGES] }, doNotContact: { $ne: true } };

  const [followCandidates, oldVerdictLeads, staleSignals, contactRows, contactCount, callRows, callCount, replyFacet, readyDrafts, needsRows, needsCount] = await Promise.all([
    leads.find({ ...base, stage: "contacted", doNotContact: { $ne: true }, followUpDueAt: { $lte: endOfToday } }).sort({ followUpDueAt: 1, _id: 1 }).limit(1_000).toArray(),
    leads.find({ ...preContact, "verdict.at": { $lt: verdictCutoff } }).sort({ "verdict.at": 1, _id: 1 }).limit(1_000).toArray(),
    db.collection("sales_verdicts").find({ workspaceId, ...scope, signalSeenAt: { $lt: signalCutoff } }, { projection: { _id: 1 } }).limit(5_000).toArray(),
    leads.find(noRoute).sort({ createdAt: -1, _id: 1 }).limit(LIST).toArray(), leads.countDocuments(noRoute),
    leads.find(callsFilter).sort({ nextActionAt: 1, _id: 1 }).limit(LIST).toArray(), leads.countDocuments(callsFilter),
    activities.aggregate<{ items: (AppDocument & { lead: AppDocument })[]; total: { n: number }[] }>([
      { $match: { workspaceId, direction: "in", handledAt: null, ...scope } },
      { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
      { $match: ofLead },
      { $sort: { at: 1, _id: 1 } },
      { $facet: { items: [{ $limit: 1_000 }], total: [{ $count: "n" }] } },
    ]).toArray(),
    drafts.aggregate<AppDocument & { lead: AppDocument }>([
      { $match: { workspaceId, status: "ready", $or: [{ personApproval: null }, { "personApproval.byHead": false }], channel: { $ne: "call_opener" }, ...scope } },
      { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
      { $match: { ...ofLead, "lead.doNotContact": { $ne: true } } },
      { $sort: { updatedAt: 1, _id: 1 } }, { $limit: 2_000 },
    ]).toArray(),
    leads.find({ ...base, needsYou: true }).sort({ updatedAt: -1, _id: 1 }).limit(LIST).toArray(), leads.countDocuments({ ...base, needsYou: true }),
  ]);

  // Follow-ups: due by the end of today, with no follow-up draft waiting already.
  const waitingFollowUps = new Set((followCandidates.length ? await drafts.find({ workspaceId, leadId: { $in: followCandidates.map((lead) => String(lead._id)) }, purpose: "follow_up", status: { $in: [...OPEN_DRAFT_STATUSES] } }, { projection: { leadId: 1 } }).toArray() : []).map((row) => String(row.leadId)));
  const followAll = followCandidates.filter((lead) => !waitingFollowUps.has(String(lead._id)));
  const follow = followAll.slice(0, LIST);
  const followIds = follow.map((lead) => String(lead._id));
  const verdictIdsOf = (rows: AppDocument[]) => rows.map((lead) => str(lead.verdict?.verdictId)).filter((id): id is string => !!id);

  // Stale verdicts: older than 30 days, or the signal they rest on was seen more than 60 days ago.
  const staleSignalLeads = staleSignals.length ? await leads.find({ ...preContact, "verdict.verdictId": { $in: staleSignals.map((row) => String(row._id)) } }).limit(1_000).toArray() : [];
  const staleMap = new Map<string, AppDocument>();
  for (const lead of [...oldVerdictLeads, ...staleSignalLeads]) staleMap.set(String(lead._id), lead);
  const staleAll = [...staleMap.values()].sort((a, b) => (dateOf(a.verdict?.at)?.getTime() ?? 0) - (dateOf(b.verdict?.at)?.getTime() ?? 0));
  const stale = staleAll.slice(0, LIST);

  const [firstDrafts, firstActivities, verdictDocs, enrichRuns, openers] = await Promise.all([
    followIds.length ? drafts.find({ workspaceId, leadId: { $in: followIds }, status: "sent", purpose: "first_touch" }).sort({ sentAt: 1, _id: 1 }).toArray() : [],
    followIds.length ? activities.find({ workspaceId, leadId: { $in: followIds }, direction: "out", kind: { $in: [...OUTBOUND_KINDS] }, callOutcome: { $ne: "wrong_number" } }).sort({ at: 1, _id: 1 }).toArray() : [],
    db.collection("sales_verdicts").find({ workspaceId, _id: { $in: [...verdictIdsOf(follow), ...verdictIdsOf(stale)] } }, { projection: { signal: 1, signalSeenAt: 1 } }).toArray(),
    contactRows.length ? db.collection("sales_find_runs").find({ workspaceId, kind: "enrich", status: { $in: ["queued", "running"] }, leadIds: { $in: contactRows.map((lead) => String(lead._id)) } }, { projection: { leadIds: 1 } }).toArray() : [],
    callRows.length ? drafts.find({ workspaceId, leadId: { $in: callRows.map((lead) => String(lead._id)) }, channel: "call_opener", status: { $nin: ["discarded", "vetoed"] } }).sort({ updatedAt: -1, _id: 1 }).toArray() : [],
  ]);
  const firstDraft = firstPerLead(firstDrafts);
  const firstActivity = firstPerLead(firstActivities);
  const verdictById = new Map(verdictDocs.map((row) => [String(row._id), row]));
  const pendingEnrich = new Set(enrichRuns.flatMap((run) => (run.leadIds as string[] | undefined) ?? []));
  const opener = firstPerLead(openers);

  const followUpsDue = follow.map((lead) => {
    const draft = firstDraft.get(String(lead._id));
    const activity = firstActivity.get(String(lead._id));
    const firstTouch = draft
      ? { draftId: String(draft._id), channel: String(draft.channel), ...(str(draft.subject) ? { subject: String(draft.subject) } : {}), body: String(draft.body ?? ""), at: dateOf(draft.sentAt) ?? dateOf(draft.updatedAt)! }
      : activity ? { activityId: String(activity._id), channel: String(activity.kind), body: String(activity.body ?? ""), at: dateOf(activity.at)! } : undefined;
    const verdict = verdictById.get(String(lead.verdict?.verdictId ?? ""));
    return {
      ...brief(lead), followUpDueAt: dateOf(lead.followUpDueAt)!, ...(dateOf(lead.lastTouchAt) ? { lastTouchAt: dateOf(lead.lastTouchAt) } : {}),
      channel: firstTouch?.channel ?? "email", signal: String(str(verdict?.signal) ?? lead.observedSignal ?? ""), ...(firstTouch ? { firstTouch } : {}),
    };
  });

  const staleVerdicts = stale.map((lead) => {
    const summary = lead.verdict as Record<string, any>;
    const doc = verdictById.get(String(summary.verdictId));
    const at = dateOf(summary.at) ?? now;
    const seen = dateOf(doc?.signalSeenAt);
    const setBy: "claude" | "person" = summary.via === "app" || summary.overridden ? "person" : "claude";
    const reasons = [
      ...(at.getTime() < verdictCutoff.getTime() ? [`Verdict is ${Math.floor((now.getTime() - at.getTime()) / DAY_MS)} days old`] : []),
      ...(seen && seen.getTime() < signalCutoff.getTime() ? [`Signal was seen ${Math.floor((now.getTime() - seen.getTime()) / DAY_MS)} days ago`] : []),
    ];
    return {
      ...brief(lead), verdict: { id: String(summary.verdictId), decision: summary.decision, confidence: summary.confidence, at, signal: String(doc?.signal ?? ""), ...(seen ? { signalSeenAt: seen } : {}), setBy },
      reasons, claudeCanRejudge: setBy === "claude" && lead.needsYou !== true,
    };
  });

  const needsContacts = contactRows.map((lead) => ({ ...brief(lead), createdAt: dateOf(lead.createdAt) ?? now, ...(str(lead.website) ? { website: String(lead.website) } : {}), enrichPending: pendingEnrich.has(String(lead._id)) }));

  const callsToday = callRows.map((lead) => {
    const phones = ((lead.contactRoutes as AppDocument[] | undefined) ?? []).filter((route) => route.kind === "phone" || route.kind === "whatsapp")
      .map((route) => ({ kind: route.kind as "phone" | "whatsapp", value: String(route.value), ...(str(route.label) ? { label: String(route.label) } : {}) }));
    const script = opener.get(String(lead._id));
    return { ...brief(lead), why: whyFor(lead, { kind: "call", now, dayStart }), nextAction: String(lead.nextAction ?? ""), ...(dateOf(lead.nextActionAt) ? { nextActionAt: dateOf(lead.nextActionAt) } : {}), phones, ...(script ? { callOpenerDraftId: String(script._id) } : {}) };
  });

  // Replies waiting (oldest first) with the last thing we sent them, and whether they have waited past the reply time.
  const replyItems = replyFacet[0]?.items ?? [];
  const replyCount = replyFacet[0]?.total[0]?.n ?? 0;
  const replyLeadIds = [...new Set(replyItems.slice(0, LIST).map((row) => String(row.leadId)))];
  const [lastOut, lastSent] = await Promise.all([
    replyLeadIds.length ? activities.aggregate<AppDocument>([{ $match: { workspaceId, leadId: { $in: replyLeadIds }, direction: "out", body: { $nin: ["", null] } } }, { $sort: { at: -1, _id: -1 } }, { $group: { _id: "$leadId", doc: { $first: "$$ROOT" } } }]).toArray() : [],
    replyLeadIds.length ? drafts.aggregate<AppDocument>([{ $match: { workspaceId, leadId: { $in: replyLeadIds }, status: "sent" } }, { $sort: { sentAt: -1, _id: -1 } }, { $group: { _id: "$leadId", doc: { $first: "$$ROOT" } } }]).toArray() : [],
  ]);
  const lastOutBy = new Map(lastOut.map((row) => [String(row._id), row.doc as AppDocument]));
  const lastSentBy = new Map(lastSent.map((row) => [String(row._id), row.doc as AppDocument]));
  let overSlaCount = 0;
  const replyRows = await Promise.all(replyItems.map(async ({ lead, ...activity }) => {
    const settings = await settingsOfLead(lead);
    const at = dateOf(activity.at) ?? now;
    const due = addWorkingHours(at, settings.replySlaHours, calendarOf(settings));
    // The promise is on warm replies only (interested, wants details, asks the price), in the venture's working hours, days and zone.
    const overSla = WARM_REPLIES.has(String(activity.replyType)) && now.getTime() > due.getTime();
    if (overSla) overSlaCount++;
    return { lead, activity, at, due, overSla };
  }));
  const repliesWaiting = replyRows.slice(0, LIST).map(({ lead, activity, at, due, overSla }) => {
    const out = lastOutBy.get(String(lead._id));
    const sent = lastSentBy.get(String(lead._id));
    const outAt = dateOf(out?.at), sentAt = dateOf(sent?.sentAt);
    const lastOutbound = sent && sentAt && (!outAt || sentAt.getTime() >= outAt.getTime())
      ? { kind: String(sent.channel), body: String(sent.body ?? ""), at: sentAt, draftId: String(sent._id) }
      : out && outAt ? { kind: String(out.kind), body: String(out.body ?? ""), at: outAt, ...(str(out.draftId) ? { draftId: String(out.draftId) } : {}) } : undefined;
    return {
      activityId: String(activity._id), at, kind: String(activity.kind), ...(activity.replyType ? { replyType: activity.replyType } : {}), body: String(activity.body ?? ""),
      waitingHours: round(Math.max(0, (now.getTime() - at.getTime()) / HOUR_MS), 1), slaDueAt: due, overSla, lead: brief(lead), ...(lastOutbound ? { lastOutbound } : {}),
    };
  });

  // Drafts that wait for a person's approval before they can be sent (first batch of a play, or a venture that approves every message).
  const playIds = [...new Set(readyDrafts.map((row) => str(row.playId)).filter((id): id is string => !!id))];
  const plays = new Map((playIds.length ? await db.collection("sales_plays").find({ _id: { $in: playIds }, workspaceId }).toArray() : []).map((play) => [String(play._id), play]));
  const approvalRows: { draft: AppDocument; settings: SalesSettings }[] = [];
  for (const { lead, ...draft } of readyDrafts) {
    const settings = await settingsFor(ctx, String(draft.ventureId));
    if (needsPersonApproval(draft as AppDocument, plays.get(String(draft.playId)), settings)) approvalRows.push({ draft: { ...(draft as AppDocument), companyName: lead.companyName }, settings });
  }
  const approvals = approvalRows.slice(0, LIST).map(({ draft, settings }) => {
    const play = plays.get(String(draft.playId));
    return {
      draftId: String(draft._id), leadId: String(draft.leadId), ventureId: String(draft.ventureId), companyName: String(draft.companyName ?? ""), channel: draft.channel, purpose: String(draft.purpose ?? "other"),
      ...(str(draft.subject) ? { subject: String(draft.subject) } : {}), body: String(draft.body ?? ""), ...(str(draft.playId) ? { playId: String(draft.playId) } : {}),
      why: settings.approvalMode === "person_approves_every_message" ? "This venture approves every message before it is sent" : `First batch of the play "${String(play?.name ?? "")}": a person reads it before it goes`,
    };
  });
  const needsYou = needsRows.map((lead) => {
    const verdict = lead.verdict as Record<string, any> | undefined;
    return { ...brief(lead), why: whyFor(lead, { kind: "needsYou" }), ...(verdict?.verdictId ? { verdict: { verdictId: String(verdict.verdictId), decision: verdict.decision, confidence: verdict.confidence, summary: String(verdict.summary ?? "") } } : {}) };
  });

  // Today's sends by the person running Daybreak, against each venture's daily caps (counted like the send route: since local midnight).
  const ventureIds = await ventureIdsInScope(ctx, query.ventureId);
  const workRules = await Promise.all(ventureIds.map(async (ventureId) => workRulesOf(ventureId, await settingsFor(ctx, ventureId))));
  const replySlaHours = ventureSettings ? ventureSettings.replySlaHours : sharedSlaHours(workRules, 2);
  const caps = await Promise.all(ventureIds.map(async (ventureId) => {
    const settings = await settingsFor(ctx, ventureId);
    const sentToday = await activities.aggregate<{ _id: string; n: number }>([
      // Counted like the caps: the sends that happened today (by `at`), whenever they were logged.
      { $match: { workspaceId, ventureId, actorId: ctx.actor.id, direction: "out", at: { $gte: startOfLocalDay(now, settings.timezone) } } }, { $group: { _id: "$kind", n: { $sum: 1 } } },
    ]).toArray();
    const used = new Map(sentToday.map((row) => [String(row._id), row.n]));
    return {
      ventureId, channels: SALES_CHANNELS.map((channel) => {
        const cap = channel === "email" || channel === "whatsapp" ? settings.dailyCaps[channel] : null;
        const count = used.get(channel) ?? 0;
        return { channel, used: count, cap, left: cap === null ? null : Math.max(0, cap - count) };
      }),
    };
  }));

  const counts = {
    followUpsDue: followAll.length, staleVerdicts: staleAll.length, needsContacts: contactCount, callsToday: callCount, repliesWaiting: replyCount,
    repliesOverSla: overSlaCount, draftsToApprove: approvalRows.length, needsYou: needsCount,
  };
  const over = replySlaHours === null ? "over the reply time" : `over ${replySlaHours}h`;
  const parts: string[] = [];
  if (counts.repliesWaiting) parts.push(counts.repliesOverSla === counts.repliesWaiting ? `${plural(counts.repliesWaiting, "reply", "replies")} waiting ${over}` : `${plural(counts.repliesWaiting, "reply", "replies")} waiting${counts.repliesOverSla ? ` (${counts.repliesOverSla} ${over})` : ""}`);
  if (counts.callsToday) parts.push(`${plural(counts.callsToday, "call", "calls")} today`);
  if (counts.followUpsDue) parts.push(`${plural(counts.followUpsDue, "follow-up", "follow-ups")} to draft`);
  if (counts.draftsToApprove) parts.push(`${plural(counts.draftsToApprove, "draft", "drafts")} to approve`);
  if (counts.needsYou) parts.push(`${plural(counts.needsYou, "lead needs", "leads need")} a decision`);
  if (counts.staleVerdicts) parts.push(`${plural(counts.staleVerdicts, "verdict", "verdicts")} to re-judge`);
  if (counts.needsContacts) parts.push(`${plural(counts.needsContacts, "lead", "leads")} without contacts`);
  const summary = parts.length ? parts.join(", ") : "Nothing waiting: a clear morning.";

  return jsonValue({
    generatedAt: now, today: localDay(now, zoneCalendar(tz)), tz, owner: query.owner, ...(query.ventureId ? { ventureId: query.ventureId } : {}), ...(query.offerId ? { offerId: query.offerId } : {}),
    replySlaHours, workRules, counts, followUpsDue, staleVerdicts, needsContacts, callsToday, repliesWaiting, approvalsWaiting: { drafts: approvals, needsYou }, caps, summary,
  });
}
