// Lead operations shared by the /sales routes and the older /opportunities routes: load with access rules, create, edit,
// log an activity (with every automatic rule), suppression, and the won notice.
import { createHash, randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { z } from "zod";
import type { activityInputSchema, opportunityInputSchema, updateOpportunitySchema } from "@venture-studio/contracts";
import { atomic, type AppDb, type AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { assertOwnerInVenture, canEditLead, canSeeVenture, canWriteIn, forbidden, isHeadOf, notFound } from "./access.js";
import { auditSales, settingsFor, type SalesCtx } from "./ctx.js";
import { NEXT_ACTION_REMINDER, cancelNextActionReminders, notifyReply, syncNextActionReminder } from "./notify.js";
import { assertVentureOffer, defaultOfferId } from "./offers.js";
import { assertClaudeMayMove, isExitStage, isWonStage, normalizeStage, planActivity, planStageChange, type DraftDiscard } from "./rules.js";
import { calendarOf } from "./settings.js";
import { SUPPRESS_KEYS_VERSION, leadSuppressKeys, normalizeValue, optOutEntries, suppressionKey, type SuppressionKind } from "./suppression.js";
import { localDay, startOfLocalDay } from "./workdays.js";

export const OPEN_DRAFT = ["draft", "in_review", "ready", "needs_changes"];
/** Stages that mean the lead is being (or about to be) contacted: a do-not-contact lead is never moved into one. */
export const CONTACT_STAGES: ReadonlySet<string> = new Set(["approved_for_contact", "contacted", "replied", "discovery_booked", "qualified", "proposal"]);

/** A short stable fingerprint of a request's content (keys sorted), to tell a retry from a different request that reuses a requestId. */
export function payloadHash(value: unknown): string {
  const sorted = (_key: string, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : item;
  return createHash("sha256").update(JSON.stringify(value, sorted)).digest("hex").slice(0, 32);
}

/** Drops undefined values: the driver would store them as null. */
export function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** A live lead the actor can open, or 404 (soft-deleted, other workspace, or other venture all look the same). */
export async function loadLead(ctx: SalesCtx, id: string, session?: ClientSession): Promise<AppDocument> {
  const lead = await ctx.db.collection("opportunities").findOne({ _id: id, workspaceId: ctx.workspaceId, deletedAt: null }, { session });
  if (!lead || !canSeeVenture(ctx.actor, lead.ventureId)) throw notFound("Lead");
  return lead;
}

export function requireLeadEditor(ctx: SalesCtx, lead: AppDocument, what: string) {
  if (canEditLead(ctx.actor, lead)) return;
  if (!canWriteIn(ctx.actor, lead.ventureId)) throw forbidden(`Your role in this venture is read-only: you cannot ${what}`);
  throw forbidden(`Only the lead's owner or a venture head can ${what}`);
}

async function assertPlay(ctx: SalesCtx, playId: string | undefined, ventureId: string) {
  if (playId && !(await ctx.db.collection("sales_plays").findOne({ _id: playId, workspaceId: ctx.workspaceId, ventureId }, { projection: { _id: 1 } }))) throw new AppError(400, "BAD_REQUEST", "That play does not belong to this venture");
}

/** Whether any suppression entry matches these keys. */
export async function suppressedBy(ctx: SalesCtx, keys: string[], session?: ClientSession): Promise<boolean> {
  return keys.length > 0 && (await ctx.db.collection("sales_suppression").countDocuments({ workspaceId: ctx.workspaceId, key: { $in: keys } }, { limit: 1, session })) > 0;
}

// ---- Suppression ----------------------------------------------------------------------------------------------------------

export const DO_NOT_CONTACT_REASON = "The lead is on the do-not-contact list";

/**
 * Stops everything that would still reach leads just flagged do not contact: their unsent drafts are discarded and their waiting
 * next-action reminders cancelled. Every path that flags a lead calls this (an opt-out or hostile reply, a suppression entry, an edit
 * or an enrich run that matches the list, the importer's refresh).
 */
export async function stopContactWork(ctx: Pick<SalesCtx, "db" | "workspaceId">, leadIds: string[], now: Date, session?: ClientSession): Promise<{ drafts: number; reminders: number }> {
  if (!leadIds.length) return { drafts: 0, reminders: 0 };
  const drafts = await ctx.db.collection("sales_drafts").updateMany({ workspaceId: ctx.workspaceId, leadId: { $in: leadIds }, status: { $in: OPEN_DRAFT } }, { $set: { status: "discarded", discardedAt: now, discardedReason: DO_NOT_CONTACT_REASON, updatedAt: now } }, { session });
  const reminders = await ctx.db.collection("reminders").updateMany({ workspaceId: ctx.workspaceId, leadId: { $in: leadIds }, kind: NEXT_ACTION_REMINDER, state: "scheduled" }, { $set: { state: "cancelled", cancelReason: "do_not_contact", updatedAt: now } }, { session });
  return { drafts: drafts.modifiedCount, reminders: reminders.modifiedCount };
}

/**
 * The importer's safety pass (scripts/import-dealflow.ts --refresh): flags the imported leads (by import reference) whose recomputed match keys
 * hit the do-not-contact list, one way (a flag is never cleared here), and stops what would still reach them. A lead nobody edited since the
 * import keeps counting as untouched (its `importUpdatedAt` moves with `updatedAt`). Soft-deleted leads are left alone.
 */
export async function flagImportedDoNotContact(db: AppDb, workspaceId: string, system: string, refs: string[], now: Date): Promise<{ flagged: number; draftsDiscarded: number; remindersCancelled: number }> {
  const outcome = { flagged: 0, draftsDiscarded: 0, remindersCancelled: 0 };
  const leads = db.collection("opportunities");
  for (let start = 0; start < refs.length; start += 500) {
    const ids = (await leads.find({ workspaceId, "externalRef.system": system, "externalRef.id": { $in: refs.slice(start, start + 500) }, deletedAt: null }, { projection: { _id: 1 } }).toArray()).map((row) => String(row._id));
    if (!ids.length) continue;
    const flagged = await leads.updateMany({ _id: { $in: ids }, workspaceId, doNotContact: { $ne: true } }, [
      { $set: { doNotContact: true, updatedAt: now, importUpdatedAt: { $cond: [{ $eq: ["$importUpdatedAt", "$updatedAt"] }, now, "$importUpdatedAt"] } } },
    ]);
    outcome.flagged += flagged.modifiedCount;
    // Every lead the list matches (flagged now or before) has nothing left waiting to reach it.
    const stopped = await stopContactWork({ db, workspaceId }, ids, now);
    outcome.draftsDiscarded += stopped.drafts; outcome.remindersCancelled += stopped.reminders;
  }
  return outcome;
}

/**
 * Adds entries to the one do-not-contact list (existing ones are kept) and flags every matching lead in the workspace; the
 * unsent drafts of the leads it flags are discarded and their next-action reminders cancelled. `ventureId` records which venture
 * the entry came from (who may see it).
 */
export async function addSuppression(ctx: SalesCtx, entries: { kind: SuppressionKind; value: string }[], meta: { reason: string; leadId?: string | undefined; ventureId?: string | undefined }, now: Date, session?: ClientSession): Promise<{ rows: AppDocument[]; flagged: number }> {
  const rows: AppDocument[] = [];
  let flagged = 0;
  for (const entry of entries) {
    const value = normalizeValue(entry.kind, entry.value);
    if (!value) continue;
    const key = suppressionKey(entry.kind, value);
    await ctx.db.collection("sales_suppression").updateOne({ workspaceId: ctx.workspaceId, key }, { $setOnInsert: defined({ _id: randomUUID(), workspaceId: ctx.workspaceId, key, kind: entry.kind, value, reason: meta.reason, leadId: meta.leadId, ventureId: meta.ventureId, createdBy: ctx.actor.id, createdAt: now }) }, { upsert: true, session });
    const row = await ctx.db.collection("sales_suppression").findOne({ workspaceId: ctx.workspaceId, key }, { session });
    if (row) rows.push(row);
    const matching = await ctx.db.collection("opportunities").find({ workspaceId: ctx.workspaceId, suppressKeys: key, deletedAt: null, doNotContact: { $ne: true } }, { session, projection: { _id: 1 } }).toArray();
    if (!matching.length) continue;
    const ids = matching.map((lead) => lead._id);
    flagged += (await ctx.db.collection("opportunities").updateMany({ _id: { $in: ids } }, { $set: { doNotContact: true, updatedAt: now } }, { session })).modifiedCount;
    await stopContactWork(ctx, ids.map(String), now, session);
  }
  return { rows, flagged };
}

// ---- Drafts and the won notice --------------------------------------------------------------------------------------------

export async function discardOpenDrafts(ctx: SalesCtx, leadId: string, mode: DraftDiscard, reason: string, now: Date, session?: ClientSession): Promise<number> {
  if (mode === "none") return 0;
  // Everything about this lead is being closed, deleted or blocked: its waiting next-action reminder stops with its drafts.
  if (mode === "all") await cancelNextActionReminders(ctx, leadId, "lead_closed", now, session);
  const result = await ctx.db.collection("sales_drafts").updateMany(
    { workspaceId: ctx.workspaceId, leadId, status: { $in: OPEN_DRAFT }, ...(mode === "follow_ups" ? { purpose: "follow_up" } : {}) },
    { $set: { status: "discarded", discardedAt: now, discardedReason: reason, updatedAt: now } }, { session });
  return result.modifiedCount;
}

/** "Won: {company}": to the lead owner, the venture's heads and the admins (wins are rare and the owner wants each one), not the person who made the change. */
export async function notifyWon(ctx: SalesCtx, lead: AppDocument, now: Date, session?: ClientSession): Promise<void> {
  const heads = await ctx.db.collection("memberships").find({ workspaceId: ctx.workspaceId, status: "active", $or: [{ role: "venture_head", ventureIds: lead.ventureId }, { role: "admin" }] }, { session, projection: { userId: 1 } }).toArray();
  const recipients = new Set<string>([String(lead.ownerId), ...heads.map((head) => String(head.userId))]);
  recipients.delete(ctx.actor.id);
  for (const userId of recipients) {
    const idempotencyKey = `opportunity:${lead._id}:won:${userId}`;
    await ctx.db.collection("notification_outbox").updateOne({ idempotencyKey }, { $setOnInsert: { _id: randomUUID(), workspaceId: ctx.workspaceId, userId, type: "sales_won", title: `Won: ${lead.companyName}`.slice(0, 200), body: "Hand it over: create the delivery work so the team can start.", resourceType: "opportunity", resourceId: String(lead._id), idempotencyKey, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now } }, { upsert: true, session });
  }
}

/**
 * Marks an inbound activity handled. When a person (not Claude) handles an inbound WhatsApp message, that records the lead's
 * WhatsApp opt-in ("they messaged us") if there is none yet: Claude never grants it, a person confirms it here.
 */
export async function markHandled(ctx: SalesCtx, lead: AppDocument, activity: AppDocument, now: Date, session?: ClientSession): Promise<{ optIn: boolean }> {
  if (!activity.handledAt) await ctx.db.collection("sales_activities").updateOne({ _id: activity._id, handledAt: null }, { $set: { handledAt: now, handledBy: ctx.actor.id } }, { session });
  let optIn = false;
  if (ctx.via === "app" && activity.direction === "in" && activity.kind === "whatsapp" && !lead.whatsappOptIn) {
    const changed = await ctx.db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, whatsappOptIn: null }, { $set: { whatsappOptIn: { at: new Date(activity.at), by: ctx.actor.id, how: "they_messaged" }, updatedAt: now } }, { session });
    optIn = changed.modifiedCount > 0;
  }
  return { optIn };
}

/** A system-made note on the timeline for a stage change that did not come from logging an activity. */
export async function stageNote(ctx: SalesCtx, lead: AppDocument, stageFrom: string, stageTo: string, via: "app" | "claude" | "system", now: Date, session?: ClientSession, body?: string) {
  await ctx.db.collection("sales_activities").insertOne({ _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, actorId: ctx.actor.id, via, kind: "note", body: body ?? `Stage: ${stageFrom} -> ${stageTo}`, at: now, stageFrom, stageTo, createdAt: now }, { session });
}

// ---- Create ---------------------------------------------------------------------------------------------------------------

/**
 * Creates a lead in a pipeline; an import that repeats an `externalRef` gets the existing lead back. The lead is pursued for the offer it
 * names (one of its venture, not archived), else for the venture's only usable offer when there is exactly one (docs/sales-offers.md).
 */
export async function createLead(ctx: SalesCtx, input: z.infer<typeof opportunityInputSchema>): Promise<{ lead: AppDocument; created: boolean }> {
  const { actor, db, workspaceId } = ctx;
  const pipeline = await db.collection("pipelines").findOne({ _id: input.pipelineId, workspaceId });
  if (!pipeline || !canSeeVenture(actor, pipeline.ventureId)) throw notFound("Pipeline");
  const ventureId = String(pipeline.ventureId);
  if (!canWriteIn(actor, ventureId)) throw forbidden("Your role in this venture is read-only: you cannot add leads");
  await assertOwnerInVenture(db, workspaceId, input.ownerId, ventureId);
  if (!isHeadOf(actor, ventureId) && input.ownerId !== actor.id) throw forbidden("You can add leads for yourself; a venture head assigns leads to other people");
  await assertPlay(ctx, input.playId, ventureId);
  if (input.offerId) await assertVentureOffer(ctx, ventureId, input.offerId);
  if (isExitStage(input.stage) && !input.exitReason?.trim()) throw new AppError(400, "BAD_REQUEST", "Say why: a lost or disqualified lead needs an exit reason");
  // A lost lead also carries a reason category the reports count; a person picks it (Claude's tools default to "other").
  if (input.lostReason && input.stage !== "lost") throw new AppError(400, "BAD_REQUEST", "A lost reason only applies to a lost lead");
  if (input.stage === "lost" && !input.lostReason && ctx.via !== "claude") throw new AppError(400, "BAD_REQUEST", "Pick why it was lost: a lost lead needs a reason category");
  if (ctx.via === "claude") assertClaudeMayMove("identified", input.stage);
  const { externalRef, nextActionAt, expectedCloseAt, ...fields } = input;
  // References are unique per venture: the lead finder may find the same company for two ventures.
  const existingFilter = externalRef ? { workspaceId, ventureId, "externalRef.system": externalRef.system, "externalRef.id": externalRef.id } : undefined;
  const existing = async () => {
    const row = existingFilter ? await db.collection("opportunities").findOne(existingFilter) : null;
    if (!row) return null;
    if (row.deletedAt || !canSeeVenture(actor, row.ventureId)) throw new AppError(409, "CONFLICT", "A lead with this import reference already exists");
    return row;
  };
  const prior = await existing();
  if (prior) return { lead: prior, created: false };
  const offerId = input.offerId ?? await defaultOfferId(db, workspaceId, ventureId);
  const now = new Date();
  const keys = leadSuppressKeys(fields);
  const doc = defined({
    _id: randomUUID(), workspaceId, ventureId, ...fields, ...(offerId ? { offerId } : {}), ...(nextActionAt ? { nextActionAt: new Date(nextActionAt) } : {}), ...(expectedCloseAt ? { expectedCloseAt: new Date(expectedCloseAt) } : {}), ...(fields.stage === "lost" && !fields.lostReason ? { lostReason: "other" } : {}), ...(externalRef ? { externalRef } : {}),
    suppressKeys: keys, suppressKeysV: SUPPRESS_KEYS_VERSION, ...(await suppressedBy(ctx, keys) ? { doNotContact: true } : {}), ...(isWonStage(fields.stage) ? { wonAt: now } : {}), createdAt: now, updatedAt: now,
  });
  try {
    await atomic(ctx.database, async (session) => {
      await db.collection("opportunities").insertOne(doc, { session });
      if (doc.nextActionAt) await syncNextActionReminder(ctx, String(doc._id), now, session);
      if (isWonStage(fields.stage)) await notifyWon(ctx, doc, now, session);
      await auditSales(ctx, "sales.lead.create", "lead", doc._id, ventureId, { stage: fields.stage, ...(offerId ? { offerId } : {}), ...(externalRef ? { importSystem: externalRef.system } : {}) }, session);
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) { const raced = await existing(); if (raced) return { lead: raced, created: false }; }
    throw error;
  }
  return { lead: doc, created: true };
}

// ---- Edit -----------------------------------------------------------------------------------------------------------------

/** Edits a lead: fields, owner (venture head), pipeline (same venture), and stage (rules in rules.ts). Returns the updated lead. */
export async function updateLead(ctx: SalesCtx, lead: AppDocument, raw: z.infer<typeof updateOpportunitySchema>): Promise<AppDocument> {
  const { actor, db, workspaceId } = ctx;
  requireLeadEditor(ctx, lead, "edit this lead");
  const { stage, exitReason, nextActionAt, expectedCloseAt, probability, lostReason, pipelineId, ownerId, ...fields } = raw;
  const ventureId = String(lead.ventureId);
  if (ownerId !== undefined && ownerId !== lead.ownerId) {
    if (!isHeadOf(actor, ventureId)) throw forbidden("Only a venture head or admin can reassign a lead");
    await assertOwnerInVenture(db, workspaceId, ownerId, ventureId);
  }
  if (pipelineId !== undefined && pipelineId !== lead.pipelineId) {
    const pipeline = await db.collection("pipelines").findOne({ _id: pipelineId, workspaceId, ventureId });
    if (!pipeline) throw new AppError(400, "BAD_REQUEST", "That pipeline does not belong to this lead's venture");
  }
  await assertPlay(ctx, fields.playId, ventureId);
  // Moving the lead to another offer: one of its venture that is not archived.
  if (fields.offerId !== undefined && fields.offerId !== lead.offerId) await assertVentureOffer(ctx, ventureId, fields.offerId);
  const now = new Date();
  if (stage !== undefined && ctx.via === "claude") assertClaudeMayMove(normalizeStage(lead.stage), stage);
  // Why it was lost: a category, set when a lead is moved to lost (a person must pick it; Claude's updates default to "other") or changed while it stays lost.
  const stageNow = normalizeStage(lead.stage);
  // A lead on the do-not-contact list (or put on it by this very edit, checked below) never moves into a stage that means contacting it;
  // closing it as lost or disqualified is fine.
  const intoContact = stage !== undefined && CONTACT_STAGES.has(stage) && stage !== stageNow;
  const dncStage = () => new AppError(409, "CONFLICT", "This lead is on the do-not-contact list: it can't be moved to a stage that means contacting it (closing it as lost or disqualified is fine)");
  if (intoContact && lead.doNotContact) throw dncStage();
  const stageAfter = stage ?? stageNow;
  const enteringLost = stage === "lost" && stageNow !== "lost";
  if (typeof lostReason === "string" && stageAfter !== "lost") throw new AppError(400, "BAD_REQUEST", "A lost reason only applies to a lost lead");
  if (lostReason === null && stageAfter === "lost") throw new AppError(400, "BAD_REQUEST", "A lost lead keeps its reason: pick another instead of clearing it");
  if (enteringLost && !lostReason && ctx.via !== "claude") throw new AppError(400, "BAD_REQUEST", "Pick why it was lost: a lost lead needs a reason category");
  const change = stage !== undefined ? planStageChange(lead, stage, exitReason, now, { via: ctx.via, actorId: actor.id }, enteringLost ? lostReason ?? "other" : undefined) : undefined;
  const $set: Record<string, unknown> = { ...fields, ...(ownerId !== undefined ? { ownerId } : {}), ...(pipelineId !== undefined ? { pipelineId } : {}), ...(nextActionAt ? { nextActionAt: new Date(nextActionAt) } : {}), ...(expectedCloseAt ? { expectedCloseAt: new Date(expectedCloseAt) } : {}), ...(typeof probability === "number" ? { probability } : {}), ...(typeof lostReason === "string" && !enteringLost ? { lostReason } : {}), ...change?.set, updatedAt: now };
  const $unset: Record<string, ""> = Object.fromEntries((change?.unset ?? []).map((field) => [field, ""]));
  if (exitReason !== undefined && stage === undefined && isExitStage(normalizeStage(lead.stage))) $set.exitReason = exitReason;
  // null clears the next action date.
  if (nextActionAt === null) $unset.nextActionAt = "";
  if (expectedCloseAt === null) $unset.expectedCloseAt = "";
  if (probability === null) $unset.probability = "";
  if (lostReason === null) $unset.lostReason = "";
  if (fields.companyName !== undefined || fields.website !== undefined || fields.contactRoutes !== undefined) {
    const keys = leadSuppressKeys({ companyName: fields.companyName ?? lead.companyName, website: fields.website ?? lead.website, contactRoutes: fields.contactRoutes ?? lead.contactRoutes });
    $set.suppressKeys = keys;
    $set.suppressKeysV = SUPPRESS_KEYS_VERSION;
    if (!lead.doNotContact && await suppressedBy(ctx, keys)) $set.doNotContact = true;
  }
  const flaggedNow = $set.doNotContact === true;
  if (intoContact && flaggedNow) throw dncStage();
  for (const key of Object.keys($unset)) delete $set[key];
  await atomic(ctx.database, async (session) => {
    // A stage change only applies to the stage it was planned from: if the lead moved meanwhile (an opt-out, another edit), nothing is overwritten.
    // ...and a lead flagged do not contact meanwhile is never moved into a contact stage.
    const written = await db.collection("opportunities").updateOne({ _id: lead._id, workspaceId, ...(change?.stageTo ? { stage: lead.stage } : {}), ...(intoContact ? { doNotContact: { $ne: true } } : {}) }, { $set: $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { session });
    if (!written.matchedCount) throw new AppError(409, "CONFLICT", "This lead changed while you were editing it: reload it and try again");
    if (flaggedNow) await stopContactWork(ctx, [String(lead._id)], now, session);
    await syncNextActionReminder(ctx, String(lead._id), now, session);
    if (change?.stageTo) {
      await stageNote(ctx, lead, change.stageFrom, change.stageTo, ctx.via, now, session);
      await discardOpenDrafts(ctx, String(lead._id), change.discardDrafts, `Lead moved to ${change.stageTo}`, now, session);
      if (change.enteredWon) await notifyWon(ctx, { ...lead, ...$set }, now, session);
    }
    await auditSales(ctx, "sales.lead.update", "lead", String(lead._id), ventureId, { fields: Object.keys(raw).join(",").slice(0, 200), ...(change?.stageTo ? { stage: change.stageTo } : {}) }, session);
  });
  return (await db.collection("opportunities").findOne({ _id: lead._id, workspaceId }))!;
}

// ---- Daily caps -----------------------------------------------------------------------------------------------------------

/** Channels with a daily cap per person and venture (the venture's settings). */
export const CAPPED_CHANNELS = ["email", "whatsapp"] as const;
export type CappedChannel = (typeof CAPPED_CHANNELS)[number];
export const isCappedChannel = (kind: unknown): kind is CappedChannel => (CAPPED_CHANNELS as readonly unknown[]).includes(kind);

/**
 * Takes one of today's sends for this person, venture and channel, or refuses (409) when the venture's daily cap is used up. The count lives
 * in one counter row per person, venture, channel and local day (`sales_send_counters`), raised to at least what was already sent today
 * and then taken with one conditional update, so parallel sends can never pass the cap. Returns `release`, which gives the send back when
 * the write that claimed it fails.
 */
export async function claimSendSlot(ctx: SalesCtx, ventureId: string, channel: CappedChannel, now: Date): Promise<() => Promise<void>> {
  const settings = await settingsFor(ctx, ventureId);
  const cap = settings.dailyCaps[channel];
  const refuse = () => new AppError(409, "CONFLICT", `The daily ${channel} limit of ${cap} is reached for this venture: continue tomorrow, or a venture head raises it in the sales settings`);
  if (cap <= 0) throw refuse();
  const day = localDay(now, calendarOf(settings));
  const counters = ctx.db.collection("sales_send_counters");
  const _id = `${ctx.workspaceId}:${ventureId}:${ctx.actor.id}:${channel}:${day}`;
  // What was sent today already (also before this counter existed, or written some other way) is the floor. A send counts on the
  // local day it happened (`at`): a message logged today for an earlier day is not one of today's sends.
  const sent = await ctx.db.collection("sales_activities").countDocuments({ workspaceId: ctx.workspaceId, ventureId, actorId: ctx.actor.id, direction: "out", kind: channel, at: { $gte: startOfLocalDay(now, settings.timezone) } });
  for (let attempt = 0; ; attempt++) {
    try {
      await counters.updateOne({ _id }, { $max: { count: sent }, $setOnInsert: { workspaceId: ctx.workspaceId, ventureId, userId: ctx.actor.id, channel, day, createdAt: now } }, { upsert: true });
      break;
    } catch (error) {
      // Two first sends of the day raced to create the row: the second one finds it now.
      if ((error as { code?: number }).code !== 11000 || attempt > 0) throw error;
    }
  }
  const claimed = await counters.findOneAndUpdate({ _id, count: { $lt: cap } }, { $inc: { count: 1 }, $set: { updatedAt: now } });
  if (!claimed) throw refuse();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await counters.updateOne({ _id, count: { $gt: 0 } }, { $inc: { count: -1 } }).catch(() => undefined);
  };
}

// ---- Activities -----------------------------------------------------------------------------------------------------------

/**
 * Logs one activity on a lead and applies every automatic rule (stage, follow-up date, next action, stop on reply, opt-in,
 * opt-out suppression, won notice). Runs inside the caller's transaction; the caller audits.
 *
 * An outbound email or WhatsApp message a person (or Claude) logs for today takes one of the day's sends under the venture's daily cap,
 * exactly like marking a draft sent (which claims its own send first and passes `sendClaimed`). Imports, and messages logged for an
 * earlier day, do not count against today.
 */
export async function applyActivity(ctx: SalesCtx, lead: AppDocument, input: z.infer<typeof activityInputSchema>, now: Date, session?: ClientSession, via: "app" | "claude" | "import" | "system" = ctx.via, options: { payloadHash?: string; sendClaimed?: boolean } = {}): Promise<{ activity: AppDocument; stageTo?: string }> {
  const settings = await settingsFor(ctx, String(lead.ventureId));
  const plan = planActivity(lead, input, { now, actorId: ctx.actor.id, via, settings });
  const capped = plan.direction === "out" && isCappedChannel(input.kind) && (via === "app" || via === "claude") && !options.sendClaimed && plan.at.getTime() >= startOfLocalDay(now, settings.timezone).getTime();
  const release = capped ? await claimSendSlot(ctx, String(lead.ventureId), input.kind as CappedChannel, now) : undefined;
  const activity = defined({
    _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, actorId: ctx.actor.id, via, kind: input.kind, ...(plan.direction ? { direction: plan.direction } : {}),
    body: input.body, at: plan.at, callOutcome: input.callOutcome, replyType: input.replyType, draftId: input.draftId, nextAction: input.nextAction, nextActionAt: input.nextActionAt ? new Date(input.nextActionAt) : undefined,
    requestId: input.requestId, payloadHash: input.requestId ? options.payloadHash ?? payloadHash({ ...input, requestId: undefined }) : undefined, stageFrom: plan.stageTo ? plan.stageFrom : undefined, stageTo: plan.stageTo, createdAt: now,
  });
  try {
    await ctx.db.collection("sales_activities").insertOne(activity, { session });
  } catch (error) {
    await release?.();
    throw error;
  }
  try {
    const update: Record<string, unknown> = { $set: { ...plan.set, updatedAt: now } };
    if (plan.unset.length) update.$unset = Object.fromEntries(plan.unset.map((field) => [field, ""]));
    // The plan was made from this stage: if the lead moved meanwhile the activity does not overwrite it (an opt-out always applies).
    const written = await ctx.db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, ...(plan.suppress ? {} : { stage: lead.stage }) }, update, { session });
    if (!written.matchedCount) throw new AppError(409, "CONFLICT", "This lead changed while the activity was being logged: reload it and try again");
    await discardOpenDrafts(ctx, String(lead._id), plan.discardDrafts, plan.suppress ? plan.suppress : plan.direction === "in" ? "A reply arrived: the follow-up is stopped" : `Lead moved to ${plan.stageTo}`, now, session);
    if (plan.suppress) await addSuppression(ctx, optOutEntries(lead as { companyName?: string; website?: string; contactRoutes?: { kind: string; value: string }[] }), { reason: plan.suppress, leadId: String(lead._id), ventureId: String(lead.ventureId) }, now, session);
    if (plan.enteredWon) await notifyWon(ctx, { ...lead, ...plan.set }, now, session);
    await syncNextActionReminder(ctx, String(lead._id), now, session);
    if (plan.direction === "in") await notifyReply(ctx, lead, activity, now, session);
  } catch (error) {
    // Without transactions (local development) the activity is already stored: take it back so a failed attempt leaves nothing behind.
    if (!session) await ctx.db.collection("sales_activities").deleteOne({ _id: activity._id }).catch(() => undefined);
    await release?.();
    throw error;
  }
  return { activity, ...(plan.stageTo ? { stageTo: plan.stageTo } : {}) };
}

/**
 * Sets (or changes) the reply type of an inbound activity and applies that type's rules to the lead exactly as logging the
 * reply with it would (stage, next action, opt-out suppression, stop on reply). Runs inside the caller's transaction.
 */
export async function applyReplyType(ctx: SalesCtx, lead: AppDocument, activity: AppDocument, replyType: NonNullable<z.infer<typeof activityInputSchema>["replyType"]>, now: Date, session?: ClientSession): Promise<{ stageTo?: string }> {
  const plan = planActivity(lead, { kind: activity.kind, direction: "in", body: "", at: new Date(activity.at).toISOString(), replyType } as z.infer<typeof activityInputSchema>, { now, actorId: ctx.actor.id, via: ctx.via, settings: await settingsFor(ctx, String(lead.ventureId)) });
  await ctx.db.collection("sales_activities").updateOne({ _id: activity._id }, { $set: { replyType } }, { session });
  const update: Record<string, unknown> = { $set: { ...plan.set, updatedAt: now } };
  if (plan.unset.length) update.$unset = Object.fromEntries(plan.unset.map((field) => [field, ""]));
  const written = await ctx.db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, ...(plan.suppress ? {} : { stage: lead.stage }) }, update, { session });
  if (!written.matchedCount) throw new AppError(409, "CONFLICT", "This lead changed while the reply was being sorted: reload it and try again");
  // The stage move belongs to this change, not to the original message: it gets its own note on the timeline.
  if (plan.stageTo) await stageNote(ctx, lead, plan.stageFrom, plan.stageTo, "system", now, session, `Stage: ${plan.stageFrom} -> ${plan.stageTo} after the reply was marked ${replyType}`);
  await discardOpenDrafts(ctx, String(lead._id), plan.discardDrafts, plan.suppress ?? (plan.discardDrafts === "all" ? `Lead moved to ${plan.stageTo}` : "A reply arrived: the follow-up is stopped"), now, session);
  if (plan.suppress) await addSuppression(ctx, optOutEntries(lead as { companyName?: string; website?: string; contactRoutes?: { kind: string; value: string }[] }), { reason: plan.suppress, leadId: String(lead._id), ventureId: String(lead.ventureId) }, now, session);
  if (plan.enteredWon) await notifyWon(ctx, { ...lead, ...plan.set }, now, session);
  await syncNextActionReminder(ctx, String(lead._id), now, session);
  return plan.stageTo ? { stageTo: plan.stageTo } : {};
}
