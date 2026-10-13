// Lists at scale for Sales: bulk edits, the CSV export, the CSV import (preview, then commit) and each person's saved views.
// Every lead is still checked on its own with the same rules as a single edit; a refused lead is skipped and reported, never half-changed.
import { createHash, randomUUID } from "node:crypto";
import type { Document } from "mongodb";
import type { z } from "zod";
import {
  BULK_MAX, IMPORT_FIELDS, IMPORT_MAX_CHARS, IMPORT_MAX_ROWS, LEGACY_STAGE_MAP, SAVED_VIEW_MAX, STAGE_PROBABILITY, opportunityInputSchema,
  type BulkLeadsInput, type BulkResult, type ImportField, type ImportMapping, type ImportPreview, type ImportResult, type SavedView, type leadListQuerySchema, type savedViewInputSchema,
  type importCommitInputSchema, type importInputSchema,
} from "@venture-studio/contracts";
import { atomic, type AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { assertOwnerInVenture, canSeeVenture, canWriteIn, forbidden, forbidClaude, isHeadOf, notFound, requireWriter } from "./access.js";
import { CSV_BOM, csvRow, detectDelimiter, parseCsv } from "./csv.js";
import { auditSales, type SalesCtx } from "./ctx.js";
import { defined, discardOpenDrafts, requireLeadEditor, updateLead } from "./leads.js";
import { OFFERS, assertVentureOffer, defaultOfferId, offerNames } from "./offers.js";
import { leadMatchFilter } from "./queries.js";
import { isExitStage, isPreContactStage, isWonStage, normalizeStage } from "./rules.js";
import { SUPPRESS_KEYS_VERSION, extractEmails, extractPhones, leadSuppressKeys, normalizePhone, sameCity } from "./suppression.js";
import { SALES_TZ } from "./workdays.js";

// ---- Bulk edits -----------------------------------------------------------------------------------------------------------

const MAX_LISTED = 100;
type Outcome = "changed" | "unchanged";
type UpdateInput = Parameters<typeof updateLead>[2];
type Skipped = { id: string; companyName: string; reason: string };
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Stages that mean contacting the lead: a lead on the do-not-contact list is never moved into one (the single edit refuses it too). */
const CONTACT_STAGES: ReadonlySet<string> = new Set(["approved_for_contact", "contacted", "replied", "discovery_booked", "qualified", "proposal"]);
const DNC_REASON = "Do not contact: it is on the do-not-contact list";
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

/** Deleting follows the single delete: a venture head or admin, or the owner before the first contact. */
async function deleteOne(ctx: SalesCtx, lead: AppDocument): Promise<Outcome> {
  const beforeFirstContact = isPreContactStage(normalizeStage(lead.stage)) && !lead.lastTouchAt;
  if (!isHeadOf(ctx.actor, lead.ventureId) && !(canWriteIn(ctx.actor, lead.ventureId) && lead.ownerId === ctx.actor.id && beforeFirstContact)) {
    throw forbidden("Only a venture head or admin can delete a lead (its owner can until the first contact)");
  }
  const now = new Date();
  await atomic(ctx.database, async (session) => {
    const result = await ctx.db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: ctx.actor.id, updatedAt: now } }, { session });
    if (!result.matchedCount) throw notFound("Lead");
    await discardOpenDrafts(ctx, String(lead._id), "all", "The lead was deleted", now, session);
    await auditSales(ctx, "sales.lead.delete", "lead", String(lead._id), String(lead.ventureId), { bulk: true }, session);
  });
  return "changed";
}

async function applyOne(ctx: SalesCtx, lead: AppDocument, input: BulkLeadsInput): Promise<Outcome> {
  if (input.action === "delete") return deleteOne(ctx, lead);
  // Who may change it comes first: a person who may not edit the lead hears "not allowed", never "already like that".
  requireLeadEditor(ctx, lead, "edit this lead");
  if (input.action === "assign" && !isHeadOf(ctx.actor, lead.ventureId)) throw forbidden("Only a venture head or admin can reassign a lead");
  const edit = async (change: UpdateInput): Promise<Outcome> => { await updateLead(ctx, lead, change); return "changed"; };
  const tags: string[] = Array.isArray(lead.tags) ? lead.tags.map(String) : [];
  switch (input.action) {
    case "assign": return lead.ownerId === input.ownerId ? "unchanged" : edit({ ownerId: input.ownerId });
    case "play": return lead.playId === input.playId ? "unchanged" : edit({ playId: input.playId });
    // Moving to another offer: one of the lead's own venture, not archived (updateLead checks it).
    case "offer": return lead.offerId === input.offerId ? "unchanged" : edit({ offerId: input.offerId });
    case "stage": {
      if (normalizeStage(lead.stage) === input.stage) return "unchanged";
      if (lead.doNotContact === true && CONTACT_STAGES.has(input.stage)) throw new AppError(409, "CONFLICT", DNC_REASON);
      return edit({ stage: input.stage, ...(isExitStage(input.stage) && input.exitReason?.trim() ? { exitReason: input.exitReason.trim() } : {}), ...(input.stage === "lost" && input.lostReason ? { lostReason: input.lostReason } : {}) });
    }
    case "tag": {
      if (tags.some((tag) => tag.toLowerCase() === input.tag.toLowerCase())) return "unchanged";
      if (tags.length >= 20) throw new AppError(400, "BAD_REQUEST", "It already has 20 tags");
      return edit({ tags: [...tags, input.tag] });
    }
    case "untag": {
      const kept = tags.filter((tag) => tag.toLowerCase() !== input.tag.toLowerCase());
      return kept.length === tags.length ? "unchanged" : edit({ tags: kept });
    }
  }
}

/**
 * For a filter call: the leads NOT yet in the state the action leads to (no tag yet, another owner, stage or play...), so running the same
 * change again reaches the leads past the first BULK_MAX instead of looking at the same ones. Null for a delete (every match is to go).
 */
function notYetDone(input: BulkLeadsInput): Document | null {
  switch (input.action) {
    case "assign": return { ownerId: { $ne: input.ownerId } };
    case "play": return { playId: { $ne: input.playId } };
    case "offer": return { offerId: { $ne: input.offerId } };
    // Rows not migrated yet may still carry an older name of the same stage.
    case "stage": return { stage: { $nin: [input.stage, ...Object.entries(LEGACY_STAGE_MAP).filter(([, stage]) => stage === input.stage).map(([legacy]) => legacy)] } };
    case "tag": return { tags: { $not: new RegExp(`^${escapeRegExp(input.tag)}$`, "i") } };
    case "untag": return { tags: new RegExp(`^${escapeRegExp(input.tag)}$`, "i") };
    case "delete": return null;
  }
}
const both = (...clauses: (Document | null)[]): Document => ({ $and: clauses.filter((clause): clause is Document => clause !== null) });

type Targets = { leads: AppDocument[]; missing: string[]; truncated: boolean; filter?: Document; notYet?: Document | null; already: number; blocked: AppDocument[]; blockedCount: number };

/**
 * The leads a bulk call names: by id (the ones the person cannot open are reported as not found) or by the list filters. A filter call takes
 * the BULK_MAX most recently updated leads that are not already in the target state (those are counted, not touched); a move into a stage
 * that means contacting leaves the do-not-contact leads out of that window and reports them as skipped.
 */
async function bulkTargets(ctx: SalesCtx, input: BulkLeadsInput): Promise<Targets> {
  const leads = ctx.db.collection("opportunities");
  if (input.ids) {
    const ids = [...new Set(input.ids)];
    const found = await leads.find({ _id: { $in: ids }, workspaceId: ctx.workspaceId, deletedAt: null }).toArray();
    const byId = new Map(found.filter((lead) => canSeeVenture(ctx.actor, lead.ventureId)).map((lead) => [String(lead._id), lead]));
    return { leads: ids.flatMap((id) => byId.get(id) ?? []), missing: ids.filter((id) => !byId.has(id)), truncated: false, already: 0, blocked: [], blockedCount: 0 };
  }
  const filter = leadMatchFilter(ctx, input.filter!);
  if (!filter) return { leads: [], missing: [], truncated: false, already: 0, blocked: [], blockedCount: 0 };
  const notYet = notYetDone(input);
  const already = notYet ? await leads.countDocuments(both(filter, { $nor: [notYet] })) : 0;
  const dnc = input.action === "stage" && CONTACT_STAGES.has(input.stage);
  const rows = await leads.find(both(filter, notYet, dnc ? { doNotContact: { $ne: true } } : null)).sort({ updatedAt: -1, _id: 1 }).limit(BULK_MAX + 1).toArray();
  const blockedFilter = both(filter, notYet, { doNotContact: true });
  const blocked = dnc ? await leads.find(blockedFilter, { projection: { companyName: 1 } }).sort({ updatedAt: -1, _id: 1 }).limit(MAX_LISTED).toArray() : [];
  const blockedCount = dnc ? (blocked.length < MAX_LISTED ? blocked.length : await leads.countDocuments(blockedFilter)) : 0;
  return { leads: rows.slice(0, BULK_MAX), missing: [], truncated: rows.length > BULK_MAX, filter, notYet, already, blocked, blockedCount };
}

/**
 * Assign, tag, untag, move to a stage, add to a play, move to an offer or delete many leads. One audit entry for the call, plus the usual one per lead edited.
 * A filter call that matched more than BULK_MAX leads also says how many are still to go (run it again for the next ones).
 */
export async function bulkLeads(ctx: SalesCtx, input: BulkLeadsInput): Promise<BulkResult> {
  forbidClaude(ctx.via, "A bulk change");
  if (input.action === "stage") {
    // Winning a deal sets its value, invoice and delivery in motion: that is one lead at a time, from the lead itself.
    if (isWonStage(input.stage)) throw new AppError(400, "BAD_REQUEST", "Mark deals won one at a time, from the lead");
    if (isExitStage(input.stage) && !input.exitReason?.trim()) throw new AppError(400, "BAD_REQUEST", "Say why: a lost or not-a-fit lead needs a reason");
    if (input.stage === "lost" && !input.lostReason) throw new AppError(400, "BAD_REQUEST", "Pick why it was lost: a lost lead needs a reason category");
    if (input.lostReason && input.stage !== "lost") throw new AppError(400, "BAD_REQUEST", "A lost reason only applies to a lost lead");
  }
  if (input.action === "offer") {
    // The offer must exist and be open to leads; each lead is then checked to be of the offer's venture.
    const offer = await ctx.db.collection(OFFERS).findOne({ _id: input.offerId, workspaceId: ctx.workspaceId }, { projection: { ventureId: 1 } });
    if (!offer || !canSeeVenture(ctx.actor, offer.ventureId)) throw new AppError(400, "BAD_REQUEST", "That offer does not exist");
    await assertVentureOffer(ctx, offer.ventureId, input.offerId);
  }
  const targets = await bulkTargets(ctx, input);
  const { leads, missing, truncated } = targets;
  const skipped: Skipped[] = missing.map((id) => ({ id, companyName: "", reason: "Lead not found" }));
  let skippedCount = skipped.length;
  let changed = 0;
  let unchanged = targets.already;
  for (const lead of leads) {
    try {
      if (await applyOne(ctx, lead, input) === "changed") changed++; else unchanged++;
    } catch (error) {
      skipped.push({ id: String(lead._id), companyName: String(lead.companyName ?? ""), reason: error instanceof AppError ? error.message : "Could not be changed" });
      skippedCount++;
    }
  }
  for (const lead of targets.blocked) skipped.push({ id: String(lead._id), companyName: String(lead.companyName ?? ""), reason: DNC_REASON });
  skippedCount += targets.blockedCount;
  // Still to go: what the filters match that is not done yet, leaving out the leads refused in this call (another run would refuse them again).
  let remaining: number | undefined;
  if (targets.filter && truncated) {
    const refused = skipped.map((item) => item.id);
    remaining = await ctx.db.collection("opportunities").countDocuments(both(targets.filter, targets.notYet ?? null, refused.length ? { _id: { $nin: refused } } : null, targets.blockedCount ? { doNotContact: { $ne: true } } : null));
  }
  const matched = leads.length + targets.blockedCount;
  const ventures = new Set(leads.map((lead) => String(lead.ventureId)));
  await auditSales(ctx, "sales.lead.bulk", "lead_bulk", randomUUID(), ventures.size === 1 ? [...ventures][0] : undefined, { action: input.action, matched, changed, unchanged, skipped: skippedCount, truncated, ...(remaining !== undefined ? { remaining } : {}) });
  return { action: input.action, matched, changed, unchanged, skippedCount, skipped: skipped.slice(0, MAX_LISTED), truncated, ...(remaining !== undefined ? { remaining } : {}) };
}

// ---- CSV export -----------------------------------------------------------------------------------------------------------

export const EXPORT_MAX = 10_000;
const STAGE_NAMES: Record<string, string> = {
  identified: "Identified", researched: "Researched", approved_for_contact: "Ready to contact", contacted: "Contacted", replied: "Replied", discovery_booked: "Call booked", qualified: "Qualified", proposal: "Proposal",
  invoice_contract: "Won - invoice", cash_collected: "Won - paid", delivery: "In delivery", retained_referred: "Retained", thinking: "Thinking", lost: "Lost", disqualified: "Not a fit",
};
const EXPORT_COLUMNS = ["Company", "Contact person", "Website", "Industry", "City", "State", "Country", "Phone", "Email", "Stage", "Offer", "Owner", "Next action", "Next action date", "Deal value", "Currency", "Expected close", "Chance (%)", "Source", "Tags", "Do not contact", "Added"];

const dayIn = (value: unknown) => value instanceof Date ? new Intl.DateTimeFormat("en-CA", { timeZone: SALES_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(value) : "";
function dateTimeIn(value: unknown): string {
  if (!(value instanceof Date)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: SALES_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}
const amount = (minor: unknown) => typeof minor === "number" && minor > 0 ? String(Number((minor / 100).toFixed(2))) : "";

type ExportQuery = Omit<z.infer<typeof leadListQuerySchema>, "offset" | "limit" | "totals">;

/**
 * The leads the list filters match as CSV: business fields only (no verdicts, evidence, activity or notes), UTF-8 with a byte order
 * mark so spreadsheets read the accents, at most EXPORT_MAX rows. A do-not-contact lead is exported without its phone and email.
 * People who can only read (learners) cannot export.
 */
export async function exportLeads(ctx: SalesCtx, query: ExportQuery): Promise<{ csv: string; rows: number; matching: number }> {
  forbidClaude(ctx.via, "Exporting a list");
  if (query.ventureId) requireWriter(ctx.actor, query.ventureId, "export leads");
  else if (ctx.actor.membership.role === "learner") throw forbidden("Your role is read-only: you cannot export leads");
  const filter = leadMatchFilter(ctx, query);
  const lines = [csvRow(EXPORT_COLUMNS)];
  let rows = 0;
  let matching = 0;
  if (filter) {
    const leads = ctx.db.collection("opportunities");
    matching = await leads.countDocuments(filter);
    // The same order as the Leads list (queries.ts listLeads): next action first with undated leads last, name, best fit or recently updated.
    let found: AppDocument[];
    if (query.sort === "next") {
      found = await leads.aggregate<AppDocument>([
        { $match: filter }, { $addFields: { _sortAt: { $ifNull: ["$nextActionAt", new Date("9999-12-31T00:00:00Z")] } } },
        { $sort: { _sortAt: 1, updatedAt: -1, _id: 1 } }, { $limit: EXPORT_MAX }, { $project: { _sortAt: 0 } },
      ], { allowDiskUse: true }).toArray();
    } else {
      const sort: Record<string, 1 | -1> = query.sort === "name" ? { companyName: 1, _id: 1 } : query.sort === "relevance" ? { relevance: -1, updatedAt: -1, _id: 1 } : { updatedAt: -1, _id: 1 };
      found = await leads.find(filter, { ...(query.sort === "name" ? { collation: { locale: "en", strength: 2 } } : {}), allowDiskUse: true }).sort(sort).limit(EXPORT_MAX).toArray();
    }
    const people = await ctx.db.collection("users").find({ _id: { $in: [...new Set(found.map((lead) => String(lead.ownerId)))] } }, { projection: { name: 1 } }).toArray();
    const names = new Map(people.map((person) => [String(person._id), String(person.name ?? "")]));
    const offers = await offerNames(ctx.db, ctx.workspaceId, found.map((lead) => lead.offerId));
    for (const lead of found) {
      const routes: { kind: string; value: string }[] = Array.isArray(lead.contactRoutes) ? lead.contactRoutes : [];
      const blocked = lead.doNotContact === true;
      const stage = normalizeStage(lead.stage);
      lines.push(csvRow([
        lead.companyName, lead.contactName, lead.website, lead.category, lead.city, lead.region, lead.country,
        blocked ? "" : routes.find((route) => route.kind === "phone")?.value, blocked ? "" : routes.find((route) => route.kind === "email")?.value,
        STAGE_NAMES[stage] ?? stage, offers.get(String(lead.offerId)) ?? "", names.get(String(lead.ownerId)) ?? "", lead.nextAction, dateTimeIn(lead.nextActionAt), amount(lead.valueEstimateMinor), amount(lead.valueEstimateMinor) ? String(lead.currency ?? "INR").toUpperCase() : "",
        dayIn(lead.expectedCloseAt), typeof lead.probability === "number" ? lead.probability : STAGE_PROBABILITY[stage], lead.source, Array.isArray(lead.tags) ? lead.tags.join("; ") : "", blocked ? "Yes" : "", dayIn(lead.createdAt),
      ]));
      rows++;
    }
  }
  await auditSales(ctx, "sales.lead.export", "lead_export", randomUUID(), query.ventureId, { rows, matching });
  return { csv: `${CSV_BOM}${lines.join("\r\n")}\r\n`, rows, matching };
}

// ---- CSV import -----------------------------------------------------------------------------------------------------------

type ImportInput = z.infer<typeof importInputSchema>;
type ImportCommitInput = z.infer<typeof importCommitInputSchema>;
type RowStatus = "ok" | "duplicate" | "invalid" | "do_not_contact";
type DuplicateOf = { leadId?: string; row?: number; companyName: string; match: string };
/** `problems` keep a row out; `notes` are worth a look but the row still imports (a second phone number written as "/ 79"). */
type ImportRow = { row: number; status: RowStatus; problems: string[]; notes: string[]; values: Record<string, string>; duplicateOf?: DuplicateOf; lead?: z.infer<typeof opportunityInputSchema>; keys: string[] };

/** A mapped cell longer than this is not read at all (no address or number hunting in it): the row is listed with "too long". */
const CELL_MAX = 2_000;
/** Phone and email cells: no real one is longer. */
const CONTACT_CELL_MAX = 320;
/** Cell values the preview echoes back are cut to this. */
const ECHO_MAX = 200;
/** Zero-width characters and stray byte order marks at the start of a cell (they hide in files pasted together). */
const LEADING_INVISIBLE = /^[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]+/;
/** The apostrophe a spreadsheet export (ours included) puts in front of a cell that would otherwise run as a formula. */
const SAFETY_APOSTROPHE = /^'(?=[=+\-@\s\u200b-\u200f\u2060-\u2064\uff0b\uff0d\uff1d\uff20])/;
/** One cell as the import reads it: trimmed, without invisible characters or a safety apostrophe in front. */
export function cleanCell(value: string): string {
  return value.replace(LEADING_INVISIBLE, "").trim().replace(SAFETY_APOSTROPHE, "").replace(LEADING_INVISIBLE, "").trim();
}

const FIELD_LABELS: Record<string, string> = { companyName: "Company", contactName: "Contact person", website: "Website", category: "Industry", city: "City", region: "State", country: "Country", contactRoutes: "Phone or email", tags: "Tags", valueEstimateMinor: "Value", source: "Source", offerId: "Offer" };
/** Header names a column is recognised by, best first. */
const SYNONYMS: Record<ImportField, string[]> = {
  company: ["company", "company name", "business name", "business", "organisation", "organization", "firm", "firm name", "name"],
  contactName: ["contact", "contact name", "contact person", "person", "owner name", "decision maker", "poc"],
  website: ["website", "web", "web site", "url", "site", "domain", "website url", "web address"],
  category: ["industry", "category", "sector", "segment", "business type", "type"],
  city: ["city", "town", "location"],
  region: ["state", "region", "province"],
  country: ["country"],
  phone: ["phone", "phone number", "mobile", "mobile number", "telephone", "tel", "contact number", "whatsapp", "cell"],
  email: ["email", "e mail", "email address", "mail", "email id"],
  source: ["source", "lead source", "origin", "found at"],
  tags: ["tags", "tag", "labels", "label"],
  value: ["value", "deal value", "amount", "budget", "deal size"],
  offer: ["offer", "offer name"],
};
/** Second pass: a header that contains one of these. The contact person needs "contact" with "name" or "person" ("Contacted?" is a yes/no column). */
const CONTAINS: Partial<Record<ImportField, (string | ((name: string) => boolean))[]>> = {
  company: ["company", "business", "firm", "organi"], contactName: [(name) => name.includes("contact") && (name.includes("name") || name.includes("person"))], website: ["website", "url", "site"],
  category: ["industry", "category", "sector"], city: ["city", "town"], region: ["state", "region"], phone: ["phone", "mobile", "tel"], email: ["mail"], source: ["source"], tags: ["tag", "label"], value: ["value", "amount"], offer: ["offer"],
};
const norm = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A first guess at which column holds what, from the header names. Each column is used once. */
export function guessMapping(columns: string[]): ImportMapping {
  const names = columns.map(norm);
  const used = new Set<number>();
  const mapping: ImportMapping = {};
  const take = (field: ImportField, pick: (name: string) => boolean) => {
    const index = names.findIndex((name, position) => !used.has(position) && pick(name));
    if (index >= 0) { used.add(index); mapping[field] = index; return true; }
    return false;
  };
  for (const field of IMPORT_FIELDS) for (const synonym of SYNONYMS[field]) if (take(field, (name) => name === synonym)) break;
  for (const field of IMPORT_FIELDS) if (mapping[field] === undefined) for (const part of CONTAINS[field] ?? []) if (take(field, typeof part === "string" ? (name) => name.includes(part) : part)) break;
  for (const field of IMPORT_FIELDS) if (mapping[field] === undefined) mapping[field] = null;
  return mapping;
}

const WEB_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const IMPORT_LABELS: Record<ImportField, string> = { company: "Company", contactName: "Contact person", website: "Website", category: "Industry", city: "City", region: "State", country: "Country", phone: "Phone", email: "Email", source: "Source", tags: "Tags", value: "Value", offer: "Offer" };

/** The venture's offers by name (any case, spaces folded) for the Offer column, and the offer a row without one gets. */
type ImportOffers = { byName: Map<string, { id: string; name: string; archived: boolean }>; names: string[]; fallback?: string | undefined };
const offerKey = (name: string) => name.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
async function importOffers(ctx: SalesCtx, ventureId: string): Promise<ImportOffers> {
  const rows = await ctx.db.collection(OFFERS).find({ workspaceId: ctx.workspaceId, ventureId }, { projection: { name: 1, state: 1 } }).toArray();
  return {
    byName: new Map(rows.map((row) => [offerKey(String(row.name)), { id: String(row._id), name: String(row.name), archived: row.state === "archived" }])),
    names: rows.filter((row) => row.state !== "archived").map((row) => String(row.name)).sort(), fallback: await defaultOfferId(ctx.db, ctx.workspaceId, ventureId),
  };
}

/** A whole cell that is one number written with digits, spaces, brackets, dashes and a plus ("/" and "." separate numbers: "0771-2345678 / 79"). */
const ONE_NUMBER = /^[+()\d\s-]{6,40}$/;
const NUMBER_SEPARATORS = /[/,;|\n]|\s(?:or|and)\s/i;
const EXTENSION = /\b(?:ext|extn|extension|x)\.?\s*\d+.*$/i;
/** A number worth keeping: 8 to 15 digits after the plus, and never "+0..." (a trunk 0 read as a country code). */
const fullNumber = (phone: string | null): phone is string => !!phone && !phone.startsWith("+0") && phone.length >= 9 && phone.length <= 16;

/** The phone numbers in an import cell (at most three) and what to say about the rest. */
export function readPhoneCell(text: string): { phones: string[]; problems: string[]; notes: string[] } {
  const whole = ONE_NUMBER.test(text) ? normalizePhone(text) : null;
  const phones = fullNumber(whole) ? [whole] : [...new Set(extractPhones(text))].filter(fullNumber);
  if (!phones.length) return { phones, problems: [`Phone number not recognised: ${text.slice(0, 40)}`], notes: [] };
  // Pieces with a few digits only ("0771-2345678 / 79"): the second number is not written in full, so it is left out.
  const pieces = whole ? [] : text.replace(/https?:\/\/\S+/gi, " ").split(NUMBER_SEPARATORS).map((piece) => piece.replace(EXTENSION, "").trim()).filter((piece) => { const digits = piece.replace(/\D/g, "").length; return digits > 0 && digits < 8; });
  const notes = pieces.length ? [`Second number incomplete: “${pieces[0]!.slice(0, 20)}” was left out (write it in full to keep it)`] : [];
  return { phones: phones.slice(0, 3), problems: [], notes };
}

/** The email addresses in an import cell (at most three). A mailto-style cell ("a@x.in?cc=b@y.in") keeps only its first address, before the "?". */
export function readEmailCell(text: string): string[] {
  const mailto = /^mailto:/i.test(text) || /[?&](?:cc|bcc|subject|body)=/i.test(text);
  if (!mailto) return extractEmails(text).slice(0, 3);
  return extractEmails(text.replace(/^mailto:/i, "").split("?")[0]!).slice(0, 1);
}

function buildRow(rowNumber: number, cells: string[], mapping: ImportMapping, pipelineId: string, ownerId: string, offers: ImportOffers): ImportRow {
  const raw: Partial<Record<ImportField, string>> = {};
  for (const field of IMPORT_FIELDS) { const index = mapping[field]; if (index !== null && index !== undefined && cells[index]) raw[field] = cells[index]; }
  // Long cells are refused before anything looks inside them: hunting for addresses in a huge cell is slow.
  const tooLong = IMPORT_FIELDS.filter((field) => (raw[field]?.length ?? 0) > (field === "phone" || field === "email" ? CONTACT_CELL_MAX : CELL_MAX));
  const values: Record<string, string> = {};
  const read: Partial<Record<ImportField, string>> = {};
  for (const field of IMPORT_FIELDS) {
    const text = raw[field];
    if (text === undefined) continue;
    const clean = tooLong.includes(field) ? text.slice(0, ECHO_MAX + 1) : cleanCell(text);
    if (clean) { values[field] = clean.length > ECHO_MAX ? `${clean.slice(0, ECHO_MAX - 1)}…` : clean; read[field] = clean; }
  }
  if (tooLong.length) {
    const problems = tooLong.map((field) => `${IMPORT_LABELS[field]} is too long (over ${(field === "phone" || field === "email" ? CONTACT_CELL_MAX : CELL_MAX).toLocaleString("en-US")} characters)`);
    return { row: rowNumber, status: "invalid", problems, notes: [], values, keys: [] };
  }
  const cell = (field: ImportField) => read[field] ?? "";
  const problems: string[] = [];
  const notes: string[] = [];
  const routes: { kind: "phone" | "email"; value: string; publishedByCompany: boolean }[] = [];

  const phoneText = cell("phone");
  if (phoneText) {
    const found = readPhoneCell(phoneText);
    problems.push(...found.problems);
    notes.push(...found.notes);
    for (const value of found.phones) routes.push({ kind: "phone", value, publishedByCompany: true });
  }
  const emailText = cell("email");
  if (emailText) {
    const emails = readEmailCell(emailText);
    if (!emails.length) problems.push(`Email address not recognised: ${emailText.slice(0, 60)}`);
    for (const value of emails) routes.push({ kind: "email", value, publishedByCompany: true });
  }
  const tags = [...new Set(cell("tags").split(/[,;|]/).map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length > 20) problems.push("More than 20 tags");
  if (tags.some((tag) => tag.length > 40)) problems.push("A tag is longer than 40 characters");
  const valueText = cell("value").replace(/[\s,₹$€£]/g, "");
  let valueMinor: number | undefined;
  if (valueText) { if (AMOUNT.test(valueText)) valueMinor = Math.round(Number(valueText) * 100); else problems.push(`Value is not an amount: ${cell("value").slice(0, 30)}`); }
  const website = cell("website");
  if (website && WEB_SCHEME.test(website) && !/^https?:\/\//i.test(website)) problems.push("Website must be a web address, like example.com");
  if (!cell("company")) problems.push("Company name is missing");
  // The Offer column names one of the venture's offers; an empty cell takes the venture's only usable offer, when there is one.
  const offerText = cell("offer");
  const offer = offerText ? offers.byName.get(offerKey(offerText)) : undefined;
  if (offerText && !offer) problems.push(`Offer not found: ${offerText.slice(0, 60)} (${offers.names.length ? `this venture's offers: ${offers.names.slice(0, 5).join(", ")}` : "this venture has no offers yet"})`);
  if (offer?.archived) problems.push(`Offer ${offer.name} is archived`);
  const offerId = offerText ? offer?.id : offers.fallback;

  const parsed = opportunityInputSchema.safeParse({
    pipelineId, companyName: cell("company"), contactName: cell("contactName"), source: cell("source") || "CSV import", ownerId, stage: "identified",
    ...(website && !problems.some((problem) => problem.startsWith("Website")) ? { website } : {}), ...(cell("category") ? { category: cell("category") } : {}), ...(cell("city") ? { city: cell("city") } : {}),
    ...(cell("region") ? { region: cell("region") } : {}), ...(cell("country") ? { country: cell("country") } : {}), contactRoutes: routes, tags: tags.slice(0, 20).filter((tag) => tag.length <= 40),
    ...(valueMinor !== undefined ? { valueEstimateMinor: valueMinor, currency: "INR" } : {}), ...(offerId ? { offerId } : {}),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const label = FIELD_LABELS[String(issue.path[0] ?? "")] ?? "Row";
      const message = `${label}: ${issue.message}`;
      if (!problems.some((problem) => problem.startsWith(label))) problems.push(message);
    }
  }
  if (problems.length || !parsed.success) return { row: rowNumber, status: "invalid", problems, notes, values, keys: [] };
  return { row: rowNumber, status: "ok", problems: [], notes, values, lead: parsed.data, keys: leadSuppressKeys(parsed.data) };
}

const MATCH_WORDS: Record<string, string> = { email: "the same email", phone: "the same phone number", domain: "the same website", company: "the same company name" };
const matchWord = (key: string) => MATCH_WORDS[key.slice(0, key.indexOf(":"))] ?? "the same details";
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

// A match on an email, phone or website is a duplicate; a match on the company name alone counts unless both have a city and the cities differ (sameCity).

/**
 * Marks the rows that match the do-not-contact list, or a lead of the venture (one deleted earlier included: it is reported, never brought
 * back), or an earlier row of the same file.
 */
async function markDuplicates(ctx: SalesCtx, ventureId: string, rows: ImportRow[]): Promise<void> {
  const open = rows.filter((row) => row.status === "ok");
  const keys = [...new Set(open.flatMap((row) => row.keys))];
  const suppressed = new Set<string>();
  type Known = { id: string; companyName: string; city: unknown; deleted: boolean };
  const existing = new Map<string, Known[]>();
  for (const part of chunks(keys, 500)) {
    const wanted = new Set(part);
    for (const entry of await ctx.db.collection("sales_suppression").find({ workspaceId: ctx.workspaceId, key: { $in: part } }, { projection: { key: 1 } }).toArray()) suppressed.add(String(entry.key));
    for (const lead of await ctx.db.collection("opportunities").find({ workspaceId: ctx.workspaceId, ventureId, suppressKeys: { $in: part } }, { projection: { companyName: 1, city: 1, suppressKeys: 1, deletedAt: 1 } }).toArray()) {
      const known: Known = { id: String(lead._id), companyName: String(lead.companyName ?? ""), city: lead.city, deleted: !!lead.deletedAt };
      for (const key of Array.isArray(lead.suppressKeys) ? lead.suppressKeys.map(String) : []) if (wanted.has(key)) existing.set(key, [...(existing.get(key) ?? []), known]);
    }
  }
  // A lead that is still there is the better answer than one deleted earlier.
  for (const list of existing.values()) list.sort((a, b) => Number(a.deleted) - Number(b.deleted));
  const earlier = new Map<string, ImportRow>();
  for (const row of open) {
    if (row.keys.some((key) => suppressed.has(key))) { row.status = "do_not_contact"; row.problems = ["On the do-not-contact list"]; continue; }
    const city = row.lead?.city;
    const strong = row.keys.filter((key) => !key.startsWith("company:"));
    const company = row.keys.filter((key) => key.startsWith("company:"));
    let match: Known | undefined;
    let found: DuplicateOf | undefined;
    for (const key of strong) { match = existing.get(key)?.[0]; if (match) { found = { companyName: match.companyName, match: matchWord(key) }; break; } }
    if (!found) for (const key of company) { match = existing.get(key)?.find((candidate) => sameCity(candidate.city, city)); if (match) { found = { companyName: match.companyName, match: matchWord(key) }; break; } }
    if (found && match && !match.deleted) found.leadId = match.id;
    if (!found) for (const key of strong) { const first = earlier.get(key); if (first) { found = { row: first.row, companyName: first.lead?.companyName ?? "", match: matchWord(key) }; break; } }
    if (!found) for (const key of company) { const first = earlier.get(key); if (first && sameCity(first.lead?.city, city)) { found = { row: first.row, companyName: first.lead?.companyName ?? "", match: matchWord(key) }; break; } }
    if (found) {
      row.status = "duplicate"; row.duplicateOf = found;
      row.problems = [found.row ? `Same as row ${found.row} (${found.match})` : match?.deleted ? `Deleted earlier from this venture: ${found.companyName} (${found.match})` : `Already in this venture as ${found.companyName} (${found.match})`];
      continue;
    }
    for (const key of row.keys) if (!earlier.has(key)) earlier.set(key, row);
  }
}

async function importTarget(ctx: SalesCtx, input: ImportInput) {
  forbidClaude(ctx.via, "Importing a list");
  requireWriter(ctx.actor, input.ventureId, "import leads");
  await assertOwnerInVenture(ctx.db, ctx.workspaceId, ctx.actor.id, input.ventureId);
  const pipelines = ctx.db.collection("pipelines");
  const active = { workspaceId: ctx.workspaceId, ventureId: input.ventureId, status: "active" };
  const pipeline = input.pipelineId ? await pipelines.findOne({ _id: input.pipelineId, ...active }) : await pipelines.find(active).sort({ createdAt: 1 }).limit(1).next();
  if (!pipeline) throw new AppError(400, "BAD_REQUEST", input.pipelineId ? "That pipeline is not an active pipeline of this venture" : "This venture has no active pipeline yet: create one before importing");
  return { pipelineId: String(pipeline._id) };
}

/** Reads the file into rows (nothing compared with the venture's leads yet). */
async function readImport(ctx: SalesCtx, input: ImportInput, chosen?: ImportMapping) {
  if (Buffer.byteLength(input.csv, "utf8") > IMPORT_MAX_CHARS) throw new AppError(400, "BAD_REQUEST", "The file is larger than 5 MB: split it into smaller files");
  // NUL characters only appear in binary files (a workbook saved as .xlsx, a UTF-16 file read as UTF-8 ...).
  if (input.csv.includes("\u0000")) throw new AppError(400, "BAD_REQUEST", "This is not a text file: in your spreadsheet choose File > Download (or Save as) > CSV, then import that file");
  const { pipelineId } = await importTarget(ctx, input);
  const offers = await importOffers(ctx, input.ventureId);
  const delimiter = detectDelimiter(input.csv);
  const grid = parseCsv(input.csv, delimiter);
  if (!grid.length) throw new AppError(400, "BAD_REQUEST", "The file is empty");
  const data = input.hasHeader ? grid.slice(1) : grid;
  if (data.length > IMPORT_MAX_ROWS) throw new AppError(400, "BAD_REQUEST", `The file has ${data.length} rows: import up to ${IMPORT_MAX_ROWS} at a time`);
  const width = Math.max(...grid.map((cells) => cells.length));
  const columns = input.hasHeader ? Array.from({ length: width }, (_, index) => cleanCell(grid[0]![index] ?? "").slice(0, 80) || `Column ${index + 1}`) : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const guessed = !chosen;
  const mapping: ImportMapping = chosen ?? guessMapping(columns);
  for (const field of IMPORT_FIELDS) if (mapping[field] === undefined) mapping[field] = null;
  const missing: ImportField[] = mapping.company === null || mapping.company === undefined || mapping.company >= width ? ["company"] : [];
  const first = input.hasHeader ? 2 : 1;
  const rows = data.map((cells, index) => buildRow(first + index, cells, mapping, pipelineId, ctx.actor.id, offers));
  return { pipelineId, delimiter, columns, mapping, guessed, missing, rows, data };
}

const rowJson = (row: ImportRow) => ({ row: row.row, status: row.status, problems: [...row.problems, ...row.notes], values: row.values, ...(row.duplicateOf ? { duplicateOf: defined(row.duplicateOf) } : {}) });

/** Reads the file and says what an import would do, row by row, without creating anything. Without a mapping the columns are guessed from the header. */
export async function previewImport(ctx: SalesCtx, input: ImportInput): Promise<ImportPreview> {
  const { delimiter, columns, mapping, guessed, missing, rows } = await readImport(ctx, input, input.mapping);
  await markDuplicates(ctx, input.ventureId, rows);
  const counts = { ok: 0, duplicate: 0, invalid: 0, doNotContact: 0 };
  for (const row of rows) { if (row.status === "ok") counts.ok++; else if (row.status === "duplicate") counts.duplicate++; else if (row.status === "invalid") counts.invalid++; else counts.doNotContact++; }
  // Rows to look at: the ones that will not import, and ready rows that carry a note.
  const issues = rows.filter((row) => row.status !== "ok" || row.notes.length > 0);
  return { columns, delimiter, mapping, guessed, missing, total: rows.length, counts, sample: rows.slice(0, 10).map(rowJson), issues: issues.slice(0, 200).map(rowJson), issuesTruncated: issues.length > 200 };
}

/** How long a commit may hold its venture's import lock before another may take it over (a commit that died never releases it). */
const IMPORT_LOCK_MS = 10 * 60_000;

/** One import at a time per venture: a second one gets 409 until the first is done. Returns the release. */
async function lockImports(ctx: SalesCtx, ventureId: string): Promise<() => Promise<void>> {
  const locks = ctx.db.collection("sales_import_locks");
  const _id = `${ctx.workspaceId}:${ventureId}`;
  const token = randomUUID();
  const now = new Date();
  try {
    // Takes a missing or expired lock; a live one makes the upsert collide on _id (unique), which is the 409.
    await locks.updateOne({ _id, expiresAt: { $lt: now } }, { $set: { workspaceId: ctx.workspaceId, ventureId, token, userId: ctx.actor.id, at: now, expiresAt: new Date(now.getTime() + IMPORT_LOCK_MS) } }, { upsert: true });
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError(409, "CONFLICT", "An import is already running for this venture: wait for it to finish, then check the Leads list before trying again");
    throw error;
  }
  return async () => { await locks.deleteOne({ _id, token }); };
}

/** A row's lead id, the same each time this file (`recordId`: venture and content) is committed: a retry finds the leads made before. */
function importLeadId(recordId: string, row: number): string {
  const hex = createHash("sha256").update(`${recordId}:${row}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The same rows read with the same columns into the same venture: line ends, quoting and the byte order mark do not change it. */
function importHash(ventureId: string, data: string[][], mapping: ImportMapping): string {
  // An unmapped Offer column leaves the hash as it was before offers existed, so a file imported then is still recognised.
  const columns = IMPORT_FIELDS.filter((field) => field !== "offer" || (mapping.offer ?? null) !== null).map((field) => mapping[field] ?? null);
  return createHash("sha256").update(JSON.stringify([ventureId, columns, data])).digest("hex");
}

/**
 * Creates the leads the file describes, owned by the person importing: stage Identified, in the venture's pipeline, on the do-not-contact
 * list check, skipping rows with problems, rows on the do-not-contact list and (unless asked) rows that match a lead of the venture.
 * One import runs at a time per venture (409 otherwise), and a file imported before (same rows, columns and venture) creates nothing
 * again and says so (`alreadyImported`). Leads carry `importBatchId`; one audit entry records the counts.
 */
export async function commitImport(ctx: SalesCtx, input: ImportCommitInput): Promise<ImportResult> {
  const { pipelineId, missing, rows, data, mapping } = await readImport(ctx, input, input.mapping);
  if (missing.length) throw new AppError(400, "BAD_REQUEST", "Pick the column that holds the company name");
  const hash = importHash(input.ventureId, data, mapping);
  const release = await lockImports(ctx, input.ventureId);
  try {
    await markDuplicates(ctx, input.ventureId, rows);
    const count = (status: RowStatus) => rows.filter((row) => row.status === status).length;
    const imports = ctx.db.collection("sales_imports");
    const recordId = `${ctx.workspaceId}:${input.ventureId}:${hash}`;
    const before = await imports.findOne({ _id: recordId });
    if (before) {
      const alreadyImported = { batchId: String(before.batchId), at: (before.createdAt as Date).toISOString(), created: Number(before.created ?? 0) };
      return { batchId: alreadyImported.batchId, total: rows.length, created: 0, duplicates: count("duplicate"), doNotContact: count("do_not_contact"), invalid: count("invalid"), alreadyImported };
    }
    const batchId = randomUUID();
    const now = new Date();
    const importing = rows.filter((row) => row.lead && (row.status === "ok" || (input.importDuplicates && row.status === "duplicate")));
    const docs = importing.map((row) => defined({
      _id: importLeadId(recordId, row.row), workspaceId: ctx.workspaceId, ventureId: input.ventureId, ...row.lead!, pipelineId, suppressKeys: row.keys, suppressKeysV: SUPPRESS_KEYS_VERSION, importBatchId: batchId, createdAt: now, updatedAt: now,
    }));
    // A commit that died part way left some of these leads already made, under the same ids: those are skipped, never added twice.
    let created = 0;
    for (const part of chunks(docs, 250)) {
      try { created += (await ctx.db.collection("opportunities").insertMany(part, { ordered: false })).insertedCount; }
      catch (error) {
        const failed = error as { writeErrors?: { code?: number }[] | { code?: number }; insertedCount?: number };
        const errors = [failed.writeErrors ?? []].flat();
        if (!errors.length || errors.some((item) => item.code !== 11000)) throw error;
        created += Number(failed.insertedCount ?? part.length - errors.length);
      }
    }
    const result = { batchId, total: rows.length, created, duplicates: input.importDuplicates ? 0 : count("duplicate"), doNotContact: count("do_not_contact"), invalid: count("invalid") };
    // Only a file that created something counts as imported: one that created nothing (all duplicates) may come back with "import those too".
    if (created) await imports.insertOne({ _id: recordId, workspaceId: ctx.workspaceId, ventureId: input.ventureId, hash, batchId, userId: ctx.actor.id, created, total: rows.length, createdAt: now });
    await auditSales(ctx, "sales.lead.import", "lead_import", batchId, input.ventureId, { ...result });
    return result;
  } finally {
    await release();
  }
}

// ---- Saved views ----------------------------------------------------------------------------------------------------------

type ViewInput = z.infer<typeof savedViewInputSchema>;
const viewJson = (doc: AppDocument): SavedView => ({ id: String(doc._id), name: String(doc.name), page: doc.page === "pipeline" ? "pipeline" : "leads", filters: doc.filters ?? {}, createdAt: (doc.createdAt as Date).toISOString() });

export async function listViews(ctx: SalesCtx): Promise<SavedView[]> {
  const rows = await ctx.db.collection("sales_views").find({ workspaceId: ctx.workspaceId, userId: ctx.actor.id }).sort({ createdAt: 1, _id: 1 }).limit(SAVED_VIEW_MAX).toArray();
  return rows.map(viewJson);
}

/** Names compare without case, matching the unique index on { workspaceId, userId, page, name } (indexes.ts). */
const VIEW_NAME_COLLATION = { locale: "en", strength: 2 } as const;

/** Saves a view for the person. The same name (any case) on the same page replaces the earlier view. At most SAVED_VIEW_MAX per person. */
export async function saveView(ctx: SalesCtx, input: ViewInput): Promise<{ view: SavedView; created: boolean }> {
  forbidClaude(ctx.via, "Saving a view");
  const views = ctx.db.collection("sales_views");
  const mine = { workspaceId: ctx.workspaceId, userId: ctx.actor.id };
  const same = await views.findOne({ ...mine, page: input.page, name: input.name }, { collation: VIEW_NAME_COLLATION });
  if (same) {
    await views.updateOne({ _id: same._id }, { $set: { name: input.name, filters: input.filters, updatedAt: new Date() } });
    return { view: viewJson({ ...same, name: input.name, filters: input.filters }), created: false };
  }
  if ((await views.countDocuments(mine)) >= SAVED_VIEW_MAX) throw new AppError(409, "CONFLICT", `You can keep ${SAVED_VIEW_MAX} saved views: delete one first`);
  const now = new Date();
  const doc = { _id: randomUUID(), ...mine, name: input.name, page: input.page, filters: input.filters, createdAt: now, updatedAt: now };
  try {
    await views.insertOne(doc);
  } catch (error) {
    // Two saves of the same new name at once: the unique index keeps one.
    if (isDuplicateKey(error)) throw new AppError(409, "CONFLICT", "A view with that name exists: pick another name, or save again to replace it");
    throw error;
  }
  return { view: viewJson(doc), created: true };
}

export async function deleteView(ctx: SalesCtx, id: string): Promise<void> {
  const result = await ctx.db.collection("sales_views").deleteOne({ _id: id, workspaceId: ctx.workspaceId, userId: ctx.actor.id });
  if (!result.deletedCount) throw notFound("View");
}
