// Read side of Sales: the lead list (server-side filtering and paging), the Overview ("what needs you today"), the Inbox and
// the draft queues. Filters run in MongoDB; the few rules that need several collections (drafts and their plays) run in code.
import type { Document } from "mongodb";
import type { z } from "zod";
import { EXIT_STAGES, SALES_STAGES, WON_STAGES, LEGACY_STAGE_MAP, type leadFacetsQuerySchema, type leadListQuerySchema } from "@venture-studio/contracts";
import type { AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { canSeeVenture, ventureScope } from "./access.js";
import type { SalesCtx } from "./ctx.js";
import { approvalNeed, canSendNow, needsPersonApproval } from "./drafts.js";
import { settingsFor } from "./ctx.js";
import { leadCard, leadJson, leadSummary, present, whyFor } from "./present.js";
import { offerClause, offerNames } from "./offers.js";
import { leadTotals } from "./revenue.js";
import { OUTBOUND_KINDS } from "./rules.js";
import { calendarOf } from "./settings.js";
import { SALES_TZ, endOfLocalDay } from "./workdays.js";

const LIST_LIMIT = 20;
const DAY_MS = 86_400_000;
const WON_QUERY = [...WON_STAGES, "won"];
const CLOSED_QUERY = [...EXIT_STAGES, ...WON_QUERY];
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type LeadListQuery = z.infer<typeof leadListQuerySchema>;
type LeadFacetsQuery = z.infer<typeof leadFacetsQuerySchema>;
const ownerOf = (ctx: SalesCtx, owner: string | undefined) => (owner === "me" ? ctx.actor.id : owner);

// ---- Lead list ------------------------------------------------------------------------------------------------------------

/** Everything about the lead list except the where/what/how-to-reach filters (those are clauses, so the facets can leave one out). Null: no venture the person can open. */
function leadBaseFilter(ctx: SalesCtx, query: LeadFacetsQuery): Document | null {
  const scope = ventureScope(ctx.actor, query.ventureId);
  if (!scope) return null;
  const filter: Document = { workspaceId: ctx.workspaceId, deletedAt: null, ...scope };
  if (query.pipelineId) filter.pipelineId = query.pipelineId;
  if (query.stage) {
    const stages = [...new Set(query.stage.split(",").map((item) => item.trim()).filter(Boolean).map((item) => LEGACY_STAGE_MAP[item] ?? item))];
    const unknown = stages.filter((item) => !(SALES_STAGES as readonly string[]).includes(item));
    if (unknown.length) throw new AppError(400, "BAD_REQUEST", `Unknown stage: ${unknown.join(", ")}`);
    // Rows not migrated yet still carry the older names.
    filter.stage = { $in: [...stages, ...(stages.includes("replied") ? ["conversation"] : []), ...(stages.includes("invoice_contract") ? ["won"] : [])] };
  }
  const owner = ownerOf(ctx, query.owner);
  if (owner) filter.ownerId = owner;
  if (query.needsYou === "true") filter.needsYou = true;
  if (query.needsYou === "false") filter.needsYou = { $ne: true };
  if (query.playId) filter.playId = query.playId;
  if (query.verdict) filter["verdict.decision"] = query.verdict === "none" ? null : query.verdict;
  if (query.q) { const pattern = new RegExp(escapeRegExp(query.q), "i"); filter.$or = [{ companyName: pattern }, { contactName: pattern }, { city: pattern }]; }
  return filter;
}

// A text field holds a value when it is a string with something other than spaces in it.
const NOT_SET = (field: string): Document => ({ $or: [{ [field]: null }, { [field]: "" }, { [field]: /^\s*$/ }] });
/** One exact value, ignoring case and spaces around it; "none" is "not set". */
const exactText = (field: string, value: string): Document => value.toLowerCase() === "none" ? NOT_SET(field) : { [field]: new RegExp(String.raw`^\s*${escapeRegExp(value)}\s*$`, "i") };
const HAS_ROUTE = (kinds: string[]): Document => ({ contactRoutes: { $elemMatch: { kind: { $in: kinds } } } });
const CONTACT_CLAUSES: Record<"phone" | "email" | "whatsapp" | "none", Document> = {
  phone: HAS_ROUTE(["phone", "whatsapp"]),
  email: HAS_ROUTE(["email"]),
  whatsapp: { whatsappOptIn: { $ne: null } },
  none: { contactRoutes: { $not: { $elemMatch: { kind: { $in: ["phone", "whatsapp", "email"] } } } } },
};
type FacetKey = "region" | "city" | "category" | "contact" | "offer";
/** The where/what/how-to-reach filters and the offer (an id, or "none" for no offer), one clause per kind. */
function facetClauses(query: LeadFacetsQuery): Partial<Record<FacetKey, Document>> {
  return {
    ...(query.offerId ? { offer: offerClause(query.offerId) } : {}),
    ...(query.region ? { region: exactText("region", query.region) } : {}), ...(query.city ? { city: exactText("city", query.city) } : {}),
    ...(query.category ? { category: exactText("category", query.category) } : {}), ...(query.contact ? { contact: CONTACT_CLAUSES[query.contact] } : {}),
  };
}
/** The base filter with every clause (or every clause but the `leave` ones, for the facets), plus an optional extra clause. */
function withClauses(base: Document, clauses: Partial<Record<FacetKey, Document>>, leave: FacetKey[] = [], extra?: Document): Document {
  const kept = (Object.entries(clauses) as [FacetKey, Document][]).filter(([key]) => !leave.includes(key)).map(([, clause]) => clause);
  if (extra) kept.push(extra);
  return kept.length ? { ...base, $and: kept } : base;
}

/** The Mongo filter for the leads these list filters match (no sorting or paging): bulk edits and the CSV export use it. Null: no venture the person can open. */
export function leadMatchFilter(ctx: SalesCtx, query: LeadFacetsQuery): Document | null {
  const base = leadBaseFilter(ctx, query);
  return base ? withClauses(base, facetClauses(query)) : null;
}

export async function listLeads(ctx: SalesCtx, query: LeadListQuery) {
  const empty = { items: [], total: 0, offset: query.offset, limit: query.limit };
  const base = leadBaseFilter(ctx, query);
  if (!base) return empty;
  const filter = withClauses(base, facetClauses(query));
  const leads = ctx.db.collection("opportunities");
  const total = await leads.countDocuments(filter);
  let rows: AppDocument[];
  if (query.sort === "next") {
    // Leads without a next action date go last.
    rows = await leads.aggregate<AppDocument>([
      { $match: filter }, { $addFields: { _sortAt: { $ifNull: ["$nextActionAt", new Date("9999-12-31T00:00:00Z")] } } },
      { $sort: { _sortAt: 1, updatedAt: -1, _id: 1 } }, { $skip: query.offset }, { $limit: query.limit }, { $project: { _sortAt: 0 } },
    ], { allowDiskUse: true }).toArray();
  } else {
    const sort: Record<string, 1 | -1> = query.sort === "name" ? { companyName: 1, _id: 1 } : query.sort === "relevance" ? { relevance: -1, updatedAt: -1, _id: 1 } : { updatedAt: -1, _id: 1 };
    rows = await leads.find(filter, { ...(query.sort === "name" ? { collation: { locale: "en", strength: 2 } } : {}), allowDiskUse: true }).sort(sort).skip(query.offset).limit(query.limit).toArray();
  }
  return { items: rows.map(leadJson), total, offset: query.offset, limit: query.limit, ...(query.totals === "true" ? { totals: await leadTotals(ctx, filter, total) } : {}) };
}

// ---- Lead facets ----------------------------------------------------------------------------------------------------------

const textOrEmpty = (field: string): Document => ({ $cond: [{ $eq: [{ $type: `$${field}` }, "string"] }, { $trim: { input: `$${field}` } }, ""] });
const FACET_LIMIT = { regions: 500, cities: 1500, categories: 500 };
type FacetRow = { value: string; count: number };
type CityRow = FacetRow & { region?: string };

/** Counts per text value, case and spacing variants merged (shown as the most common spelling); empty values are returned apart as "not set". */
function textFacet(field: "region" | "category", match: Document, limit: number): Document[] {
  return [
    { $match: match }, { $project: { raw: textOrEmpty(field) } }, { $addFields: { key: { $toLower: "$raw" } } },
    { $group: { _id: { key: "$key", raw: "$raw" }, count: { $sum: 1 } } }, { $sort: { count: -1, "_id.raw": 1 } },
    { $group: { _id: "$_id.key", count: { $sum: "$count" }, value: { $first: "$_id.raw" } } }, { $sort: { count: -1, _id: 1 } }, { $limit: limit + 1 },
  ];
}
function cityFacet(match: Document, limit: number): Document[] {
  return [
    { $match: match }, { $project: { city: textOrEmpty("city"), region: textOrEmpty("region") } }, { $addFields: { cityKey: { $toLower: "$city" }, regionKey: { $toLower: "$region" } } },
    { $group: { _id: { cityKey: "$cityKey", regionKey: "$regionKey", city: "$city", region: "$region" }, count: { $sum: 1 } } }, { $sort: { count: -1, "_id.city": 1 } },
    { $group: { _id: { cityKey: "$_id.cityKey", regionKey: "$_id.regionKey" }, count: { $sum: "$count" }, city: { $first: "$_id.city" }, region: { $first: "$_id.region" } } }, { $sort: { count: -1, "_id.regionKey": 1 } },
    { $group: { _id: "$_id.cityKey", count: { $sum: "$count" }, value: { $first: "$city" }, region: { $first: "$region" } } }, { $sort: { count: -1, _id: 1 } }, { $limit: limit + 1 },
  ];
}

/**
 * Counts for the filter choices on the lead list, for the leads the person can open. Each group is counted with every other active
 * filter applied but not its own, like a shop sidebar, so the numbers say what choosing a value would leave. A state and its cities
 * go together: the state counts ignore the chosen city, so a state can still be switched while a city is picked.
 */
export async function leadFacets(ctx: SalesCtx, query: LeadFacetsQuery) {
  const none = { total: 0, regions: [] as FacetRow[], cities: [] as CityRow[], categories: [] as FacetRow[], offers: [] as (FacetRow & { name: string })[], notSet: { regions: 0, cities: 0, categories: 0, offers: 0 }, contact: { phone: 0, email: 0, whatsappOptIn: 0, none: 0 } };
  const base = leadBaseFilter(ctx, query);
  if (!base) return none;
  const leads = ctx.db.collection("opportunities");
  const clauses = facetClauses(query);
  const [offerRows, total, regions, cities, categories, phone, email, whatsappOptIn, noRoute] = await Promise.all([
    leads.aggregate<{ _id: string | null; count: number }>([{ $match: withClauses(base, clauses, ["offer"]) }, { $group: { _id: { $ifNull: ["$offerId", null] }, count: { $sum: 1 } } }]).toArray(),
    leads.countDocuments(withClauses(base, clauses)),
    leads.aggregate<{ _id: string } & FacetRow>(textFacet("region", withClauses(base, clauses, ["region", "city"]), FACET_LIMIT.regions)).toArray(),
    leads.aggregate<{ _id: string; count: number; value: string; region: string }>(cityFacet(withClauses(base, clauses, ["city"]), FACET_LIMIT.cities)).toArray(),
    leads.aggregate<{ _id: string } & FacetRow>(textFacet("category", withClauses(base, clauses, ["category"]), FACET_LIMIT.categories)).toArray(),
    ...(["phone", "email", "whatsapp", "none"] as const).map((kind) => leads.countDocuments(withClauses(base, clauses, ["contact"], CONTACT_CLAUSES[kind]))),
  ]);
  const split = <T extends { _id: string; count: number }>(rows: T[], limit: number) => ({ set: rows.filter((row) => row._id !== "").slice(0, limit), notSet: rows.find((row) => row._id === "")?.count ?? 0 });
  const region = split(regions, FACET_LIMIT.regions), city = split(cities, FACET_LIMIT.cities), category = split(categories, FACET_LIMIT.categories);
  // Leads per offer, by name (most leads first); leads with no offer are "not set".
  const named = await offerNames(ctx.db, ctx.workspaceId, offerRows.map((row) => row._id));
  const offers = offerRows.filter((row): row is { _id: string; count: number } => typeof row._id === "string").map((row) => ({ value: row._id, name: named.get(row._id) ?? "Offer", count: row.count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    total,
    regions: region.set.map(({ value, count }) => ({ value, count })),
    cities: city.set.map(({ value, count, region: where }) => ({ value, count, ...(where ? { region: where } : {}) })),
    categories: category.set.map(({ value, count }) => ({ value, count })),
    offers,
    notSet: { regions: region.notSet, cities: city.notSet, categories: category.notSet, offers: offerRows.find((row) => row._id === null)?.count ?? 0 },
    contact: { phone, email, whatsappOptIn, none: noRoute },
  };
}

// ---- Inbox ----------------------------------------------------------------------------------------------------------------

/** Inbound activities with the lead they belong to (live leads only), unhandled first, newest first. */
export async function listInbox(ctx: SalesCtx, query: { ventureId?: string | undefined; handled?: "true" | "false" | undefined; owner?: string | undefined; limit: number }) {
  const scope = ventureScope(ctx.actor, query.ventureId);
  if (!scope) return [];
  const owner = ownerOf(ctx, query.owner);
  const rows = await ctx.db.collection("sales_activities").aggregate<AppDocument & { lead: AppDocument }>([
    { $match: { workspaceId: ctx.workspaceId, direction: "in", ...scope, ...(query.handled === "true" ? { handledAt: { $ne: null } } : query.handled === "false" ? { handledAt: null } : {}) } },
    { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
    { $match: { "lead.deletedAt": null, ...(owner ? { "lead.ownerId": owner } : {}) } },
    { $addFields: { _handled: { $cond: [{ $ifNull: ["$handledAt", false] }, 1, 0] } } },
    { $sort: { _handled: 1, at: -1, _id: -1 } }, { $limit: query.limit },
  ]).toArray();
  const now = new Date();
  return rows.map(({ lead, _handled, ...activity }) => ({ activity: present(activity as AppDocument), lead: leadCard(lead, whyFor(lead, { kind: "reply", activity: activity as AppDocument, now })) }));
}

// ---- Drafts ---------------------------------------------------------------------------------------------------------------

type DraftRow = AppDocument & { lead: AppDocument };

type Approval = ReturnType<typeof approvalNeed>;
/** A draft with its lead summary and whether it waits for a person's approval (computed here, so every screen shows Approve the same way). */
export const draftWithLead = ({ lead, ...draft }: DraftRow, approval: Approval) => ({ ...present(draft as AppDocument), lead: leadSummary(lead), ...approval });

/** The plays and venture settings the drafts' approval rules need, loaded once for a list. */
async function approvalContext(ctx: SalesCtx, rows: AppDocument[]) {
  const playIds = [...new Set(rows.map((row) => row.playId).filter((id): id is string => typeof id === "string"))];
  const plays = new Map((playIds.length ? await ctx.db.collection("sales_plays").find({ _id: { $in: playIds }, workspaceId: ctx.workspaceId }).toArray() : []).map((play) => [String(play._id), play]));
  const settings = new Map(await Promise.all([...new Set(rows.map((row) => String(row.ventureId)))].map(async (id) => [id, await settingsFor(ctx, id)] as const)));
  return { plays, settings, approval: (row: AppDocument) => approvalNeed(row, plays.get(String(row.playId)), settings.get(String(row.ventureId))) };
}

/** Drafts with a small lead summary (live leads only), newest first. Statuses default to the ones still in play. */
export async function listDrafts(ctx: SalesCtx, query: { ventureId?: string | undefined; status?: string | undefined; owner?: string | undefined; limit: number }) {
  const scope = ventureScope(ctx.actor, query.ventureId);
  if (!scope) return [];
  const statuses = query.status ? query.status.split(",").map((item) => item.trim()).filter(Boolean) : ["draft", "in_review", "ready", "needs_changes"];
  const owner = ownerOf(ctx, query.owner);
  const rows = await ctx.db.collection("sales_drafts").aggregate<DraftRow>([
    { $match: { workspaceId: ctx.workspaceId, status: { $in: statuses }, ...scope } },
    { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
    { $match: { "lead.deletedAt": null, ...(owner ? { "lead.ownerId": owner } : {}) } },
    { $sort: { updatedAt: -1, _id: -1 } }, { $limit: query.limit },
  ]).toArray();
  const { approval } = await approvalContext(ctx, rows);
  return rows.map((row) => draftWithLead(row, approval(row)));
}

/** One draft as the lists show it (lead summary, approval need), for anyone who can open its venture; 404 when it is not theirs or its lead is deleted. */
export async function getDraftWithLead(ctx: SalesCtx, id: string) {
  const scope = ventureScope(ctx.actor, undefined);
  const [row] = scope ? await ctx.db.collection("sales_drafts").aggregate<DraftRow>([
    { $match: { _id: id, workspaceId: ctx.workspaceId, ...scope } },
    { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
    { $match: { "lead.deletedAt": null } },
  ]).toArray() : [];
  if (!row || !canSeeVenture(ctx.actor, row.lead.ventureId)) throw new AppError(404, "NOT_FOUND", "Draft not found");
  const { approval } = await approvalContext(ctx, [row]);
  return draftWithLead(row, approval(row));
}

// ---- Overview -------------------------------------------------------------------------------------------------------------

const emptyCounts = { replies: 0, callsDue: 0, followUpsDue: 0, toReview: 0, readyToSend: 0, needsYou: 0, wonToHandOver: 0, openLeads: 0, totalLeads: 0 };

/** Today for one person or venture (optionally one offer, or `none`): what needs a person now, the stage counts and the last seven days. */
export async function buildOverview(ctx: SalesCtx, query: { ventureId?: string | undefined; owner?: string | undefined; offerId?: string | undefined; tz?: string | undefined }, now = new Date()) {
  const stageCounts: Record<string, number> = Object.fromEntries(SALES_STAGES.map((stage) => [stage, 0]));
  const scope = ventureScope(ctx.actor, query.ventureId);
  const blank = { counts: emptyCounts, replies: [], callsDue: [], followUpsDue: [], needsYou: [], wonToHandOver: [], toReview: [], readyToSend: [], stageCounts, week: { contacted: 0, replied: 0, meetings: 0, proposals: 0, won: 0 } };
  if (!scope) return blank;
  const { db, workspaceId } = ctx;
  const owner = ownerOf(ctx, query.owner);
  const base: Document = { workspaceId, deletedAt: null, ...scope, ...(owner ? { ownerId: owner } : {}), ...offerClause(query.offerId) };
  // The same narrowing for rows joined to their lead (replies, drafts, activity).
  const ofLead: Document = { "lead.deletedAt": null, ...(owner ? { "lead.ownerId": owner } : {}), ...offerClause(query.offerId, "lead.offerId") };
  const leads = db.collection("opportunities");
  // "Today" is in the venture's time zone (its sales settings) unless the request names one.
  const tz = query.tz ?? (query.ventureId ? (await settingsFor(ctx, query.ventureId)).timezone : SALES_TZ);
  const endOfToday = endOfLocalDay(now, tz);
  const dayStart = new Date(endOfToday.getTime() - DAY_MS);
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const open: Document = { stage: { $nin: CLOSED_QUERY } };
  const callsDue: Document = {
    ...base, ...open, doNotContact: { $ne: true }, contactRoutes: { $elemMatch: { kind: { $in: ["phone", "whatsapp"] } } },
    $or: [{ nextActionAt: { $lt: endOfToday }, nextAction: /call/i }, { stage: "approved_for_contact", $or: [{ nextActionAt: null }, { nextActionAt: { $lt: endOfToday } }] }],
  };
  const followUps: Document = { ...base, stage: "contacted", doNotContact: { $ne: true }, followUpDueAt: { $lte: now } };
  // Every lead that waits for a person's decision, whatever its stage; and only deals that are in a won stage wait for delivery work.
  const needsYou: Document = { ...base, needsYou: true };
  const wonOpen: Document = { ...base, stage: { $in: [...WON_STAGES] }, deliveryTaskId: null };
  const sorted = (filter: Document, sort: Record<string, 1 | -1>) => leads.find(filter).sort(sort).limit(LIST_LIMIT).toArray();

  const [stageRows, callRows, callCount, followRows, followCount, needsRows, needsCount, wonRows, wonCount, replyFacet, draftRows, weekFacet, wonWeek] = await Promise.all([
    leads.aggregate<{ _id: string; count: number }>([{ $match: base }, { $group: { _id: "$stage", count: { $sum: 1 } } }]).toArray(),
    sorted(callsDue, { nextActionAt: 1, _id: 1 }), leads.countDocuments(callsDue),
    sorted(followUps, { followUpDueAt: 1, _id: 1 }), leads.countDocuments(followUps),
    sorted(needsYou, { updatedAt: -1, _id: 1 }), leads.countDocuments(needsYou),
    sorted(wonOpen, { wonAt: -1, _id: 1 }), leads.countDocuments(wonOpen),
    db.collection("sales_activities").aggregate<{ items: (AppDocument & { lead: AppDocument })[]; total: { n: number }[] }>([
      { $match: { workspaceId, direction: "in", handledAt: null, ...scope } },
      { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
      { $match: ofLead },
      { $sort: { at: -1, _id: -1 } },
      { $facet: { items: [{ $limit: LIST_LIMIT }], total: [{ $count: "n" }] } },
    ]).toArray(),
    db.collection("sales_drafts").aggregate<DraftRow>([
      { $match: { workspaceId, status: { $in: ["in_review", "needs_changes", "ready"] }, ...scope } },
      { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
      { $match: ofLead },
      { $sort: { updatedAt: -1, _id: -1 } }, { $limit: 5_000 },
    ]).toArray(),
    db.collection("sales_activities").aggregate<Record<string, { _id: string }[]>>([
      { $match: { workspaceId, at: { $gte: since }, ...scope } },
      { $lookup: { from: "opportunities", localField: "leadId", foreignField: "_id", as: "lead" } }, { $unwind: "$lead" },
      { $match: ofLead },
      { $facet: {
        contacted: [{ $match: { direction: "out", kind: { $in: [...OUTBOUND_KINDS] }, callOutcome: { $ne: "wrong_number" } } }, { $group: { _id: "$leadId" } }],
        replied: [{ $match: { direction: "in" } }, { $group: { _id: "$leadId" } }],
        meetings: [{ $match: { stageTo: "discovery_booked" } }, { $group: { _id: "$leadId" } }],
        proposals: [{ $match: { stageTo: "proposal" } }, { $group: { _id: "$leadId" } }],
      } },
    ]).toArray(),
    leads.countDocuments({ ...base, wonAt: { $gte: since } }),
  ]);

  for (const row of stageRows) {
    const stage = (LEGACY_STAGE_MAP[row._id] ?? row._id) as string;
    stageCounts[stage] = (stageCounts[stage] ?? 0) + row.count;
  }
  const totalLeads = Object.values(stageCounts).reduce((sum, count) => sum + count, 0);
  const openLeads = totalLeads - [...EXIT_STAGES, ...WON_STAGES].reduce((sum, stage) => sum + (stageCounts[stage] ?? 0), 0);

  // Each draft follows its own venture's approval mode and allowed channels.
  const { plays, settings: settingsByVenture, approval } = await approvalContext(ctx, draftRows);
  const toReview = draftRows.filter((row) => row.status === "in_review" || row.status === "needs_changes" || needsPersonApproval(row, plays.get(String(row.playId)), settingsByVenture.get(String(row.ventureId))));
  const readyToSend = draftRows.filter((row) => canSendNow(row, row.lead, plays.get(String(row.playId)), settingsByVenture.get(String(row.ventureId))));

  const replies = replyFacet[0];
  const week = weekFacet[0] ?? {};
  const size = (key: string) => week[key]?.length ?? 0;
  return {
    counts: { replies: replies?.total[0]?.n ?? 0, callsDue: callCount, followUpsDue: followCount, toReview: toReview.length, readyToSend: readyToSend.length, needsYou: needsCount, wonToHandOver: wonCount, openLeads, totalLeads },
    replies: (replies?.items ?? []).map(({ lead, ...activity }) => ({ activity: present(activity as AppDocument), lead: leadCard(lead, whyFor(lead, { kind: "reply", activity: activity as AppDocument, now })) })),
    callsDue: callRows.map((lead) => leadCard(lead, whyFor(lead, { kind: "call", now, dayStart }))),
    followUpsDue: await Promise.all(followRows.map(async (lead) => { const settings = await settingsFor(ctx, String(lead.ventureId)); return leadCard(lead, whyFor(lead, { kind: "followUp", now, calendar: calendarOf(settings), followUpDays: settings.followUpAfterWorkingDays })); })),
    needsYou: needsRows.map((lead) => leadCard(lead, whyFor(lead, { kind: "needsYou" }))),
    wonToHandOver: wonRows.map((lead) => leadCard(lead, whyFor(lead, { kind: "won" }))),
    toReview: toReview.slice(0, LIST_LIMIT).map((row) => draftWithLead(row, approval(row))), readyToSend: readyToSend.slice(0, LIST_LIMIT).map((row) => draftWithLead(row, approval(row))),
    stageCounts, week: { contacted: size("contacted"), replied: size("replied"), meetings: size("meetings"), proposals: size("proposals"), won: wonWeek },
  };
}
