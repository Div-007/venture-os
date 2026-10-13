import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { EXIT_STAGES, PRE_CONTACT_STAGES, WON_STAGES, brainItemInputSchema, brainItemUpdateSchema, findRunInputSchema, idSchema, playInputSchema, playUpdateSchema, suppressionInputSchema } from "@venture-studio/contracts";
import { atomic, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { canSeeVenture, canWriteIn, forbidClaude, forbidden, isHeadOf, notFound, requireHead, requireWriter, ventureScope, loadVenture } from "../sales/access.js";
import { auditSales, salesCtx, type SalesCtx } from "../sales/ctx.js";
import { addSuppression, defined, loadLead } from "../sales/leads.js";
import { LEGACY_BRAIN_KINDS, LEGACY_KIND_REFUSAL, assertUsableOffer, assertVentureOffer, defaultOfferId } from "../sales/offers.js";
import { present } from "../sales/present.js";
import { isSharedDomain, normalizeValue, suppressionKey } from "../sales/suppression.js";

const ok = (data: unknown) => ({ ok: true, data });
const venturesQuerySchema = z.object({ ventureId: idSchema.optional() });
const brainQuerySchema = z.object({ ventureId: idSchema.optional(), status: z.string().max(100).optional() });
const findRunQuerySchema = z.object({ ventureId: idSchema.optional(), queue: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const MEETING_AND_BEYOND = ["discovery_booked", "qualified", "proposal", ...WON_STAGES, "won"];
const REPLIED_AND_BEYOND = ["replied", "thinking", ...MEETING_AND_BEYOND];

/** Plays, find-leads runs, the venture's brain (shared notes and settings; offers are in sales-offers.ts) and the do-not-contact list. */
export function salesAdminRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  // ---- Plays ----------------------------------------------------------------------------------------------------------------

  async function playStats(ctx: SalesCtx, ids: string[]) {
    if (!ids.length) return new Map<string, Record<string, number>>();
    const rows = await db.collection("opportunities").aggregate<{ _id: string; leads: number; contacted: number; replied: number; meetings: number; won: number }>([
      { $match: { workspaceId: ctx.workspaceId, deletedAt: null, playId: { $in: ids } } },
      { $group: {
        _id: "$playId", leads: { $sum: 1 },
        contacted: { $sum: { $cond: [{ $or: [{ $gt: ["$lastTouchAt", null] }, { $not: [{ $in: ["$stage", [...PRE_CONTACT_STAGES, ...EXIT_STAGES]] }] }] }, 1, 0] } },
        replied: { $sum: { $cond: [{ $in: ["$stage", REPLIED_AND_BEYOND] }, 1, 0] } },
        meetings: { $sum: { $cond: [{ $in: ["$stage", MEETING_AND_BEYOND] }, 1, 0] } },
        won: { $sum: { $cond: [{ $in: ["$stage", [...WON_STAGES, "won"]] }, 1, 0] } },
      } },
    ]).toArray();
    return new Map(rows.map((row) => [row._id, { leads: row.leads, contacted: row.contacted, replied: row.replied, meetings: row.meetings, won: row.won }]));
  }
  const playJson = (play: AppDocument, stats?: Map<string, Record<string, number>>) => ({ ...present(play), stats: stats?.get(String(play._id)) ?? { leads: 0, contacted: 0, replied: 0, meetings: 0, won: 0 } });
  async function loadPlay(ctx: SalesCtx, id: string): Promise<AppDocument> {
    const play = await db.collection("sales_plays").findOne({ _id: id, workspaceId: ctx.workspaceId });
    if (!play || !canSeeVenture(ctx.actor, play.ventureId)) throw notFound("Play");
    return play;
  }

  router.get("/plays", async (req, res) => {
    const ctx = salesCtx(database, req);
    const scope = ventureScope(ctx.actor, venturesQuerySchema.parse(req.query).ventureId);
    if (!scope) { res.json(ok([])); return; }
    const plays = await db.collection("sales_plays").find({ workspaceId: ctx.workspaceId, ...scope }).sort({ createdAt: -1, _id: 1 }).limit(200).toArray();
    const stats = await playStats(ctx, plays.map((play) => String(play._id)));
    res.json(ok(plays.map((play) => playJson(play, stats))));
  });

  router.post("/plays", async (req, res) => {
    const ctx = salesCtx(database, req);
    const input = playInputSchema.parse(req.body);
    requireWriter(ctx.actor, input.ventureId, "propose plays");
    await loadVenture(db, ctx.actor, input.ventureId);
    if (input.pipelineId && !await db.collection("pipelines").findOne({ _id: input.pipelineId, workspaceId: ctx.workspaceId, ventureId: input.ventureId }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "That pipeline does not belong to this venture");
    // The offer the play sells: one of the venture, not archived; its name fills offerName.
    const offer = input.offerId ? await assertVentureOffer(ctx, input.ventureId, input.offerId) : undefined;
    const now = new Date();
    const play = defined({ _id: randomUUID(), workspaceId: ctx.workspaceId, ...input, ...(offer ? { offerName: String(offer.name) } : {}), status: "draft", createdBy: ctx.actor.id, createdVia: ctx.via, firstBatchReviewed: false, createdAt: now, updatedAt: now });
    await atomic(database, async (session) => {
      await db.collection("sales_plays").insertOne(play, { session });
      await auditSales(ctx, "sales.play.create", "play", play._id, input.ventureId, undefined, session);
    });
    res.status(201).json(ok(playJson(play)));
  });

  router.patch("/plays/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const play = await loadPlay(ctx, idSchema.parse(req.params.id));
    const input = playUpdateSchema.parse(req.body);
    const head = isHeadOf(ctx.actor, play.ventureId);
    const { status, firstBatchReviewed, pipelineId, ...content } = input;
    if (!head) {
      // A proposer keeps editing their own draft; everything else is for the venture head.
      if (!(canWriteIn(ctx.actor, play.ventureId) && play.createdBy === ctx.actor.id && play.status === "draft")) throw forbidden("Only the venture head or admin can change this play (a proposer can edit their own draft)");
      if (status !== undefined || firstBatchReviewed !== undefined) throw forbidden("Only the venture head or admin can change a play's status or first-batch switch");
    }
    if (firstBatchReviewed !== undefined) forbidClaude(ctx.via, "Marking a play's first batch as reviewed");
    if (status === "approved") throw new AppError(400, "BAD_REQUEST", "Approve a play with the approve action");
    if (status === "running" && !play.approvedAt) throw new AppError(409, "CONFLICT", "A play must be approved before it runs");
    if (pipelineId && !await db.collection("pipelines").findOne({ _id: pipelineId, workspaceId: ctx.workspaceId, ventureId: play.ventureId }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "That pipeline does not belong to this venture");
    const offer = content.offerId !== undefined && content.offerId !== play.offerId ? await assertVentureOffer(ctx, play.ventureId, content.offerId) : undefined;
    if (offer) content.offerName = String(offer.name);
    const now = new Date();
    const $set: Record<string, unknown> = { ...content, ...(pipelineId ? { pipelineId } : {}), ...(status !== undefined ? { status } : {}), ...(firstBatchReviewed !== undefined ? { firstBatchReviewed } : {}), updatedAt: now };
    const $unset: Record<string, ""> = {};
    // Claude changing an approved play's content, or reverting it to draft, takes the approval back: only a person approves.
    const contentChanged = Object.keys(content).length > 0 || Boolean(pipelineId);
    if ((status === "draft" || (contentChanged && ctx.via === "claude")) && play.status !== "draft") { $set.status = "draft"; $unset.approvedBy = ""; $unset.approvedAt = ""; }
    await atomic(database, async (session) => {
      await db.collection("sales_plays").updateOne({ _id: play._id }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) }, { session });
      await auditSales(ctx, "sales.play.update", "play", String(play._id), String(play.ventureId), { fields: Object.keys(input).join(",").slice(0, 200), ...(status ? { status } : {}) }, session);
    });
    const updated = (await db.collection("sales_plays").findOne({ _id: play._id }))!;
    res.json(ok(playJson(updated, await playStats(ctx, [String(play._id)]))));
  });

  // The owner or a venture head approves a play in the app; Claude cannot.
  router.post("/plays/:id/approve", async (req, res) => {
    const ctx = salesCtx(database, req);
    const play = await loadPlay(ctx, idSchema.parse(req.params.id));
    forbidClaude(ctx.via, "Approving a play");
    requireHead(ctx.actor, play.ventureId, "approve a play");
    if (play.status !== "draft") throw new AppError(409, "CONFLICT", "Only a draft play can be approved");
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_plays").updateOne({ _id: play._id, status: "draft" }, { $set: { status: "approved", approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This play changed: reload it and try again");
      await auditSales(ctx, "sales.play.approve", "play", String(play._id), String(play.ventureId), undefined, session);
    });
    const updated = (await db.collection("sales_plays").findOne({ _id: play._id }))!;
    res.json(ok(playJson(updated, await playStats(ctx, [String(play._id)]))));
  });

  // ---- Find-leads runs (the office PC's engine picks queued ones up; nothing runs here) ---------------------------------------

  router.get("/find-runs", async (req, res) => {
    const ctx = salesCtx(database, req);
    const query = findRunQuerySchema.parse(req.query);
    const scope = ventureScope(ctx.actor, query.ventureId);
    if (!scope) { res.json(ok([])); return; }
    const queued = query.queue === "true";
    const runs = await db.collection("sales_find_runs").find({ workspaceId: ctx.workspaceId, ...scope, ...(queued ? { status: "queued" } : {}) }).sort({ createdAt: queued ? 1 : -1, _id: 1 }).limit(query.limit).toArray();
    res.json(ok(runs.map(present)));
  });

  router.post("/find-runs", async (req, res) => {
    const ctx = salesCtx(database, req);
    const input = findRunInputSchema.parse(req.body);
    const queue = z.enum(["true", "false"]).optional().parse(req.query.queue) === "true";
    requireWriter(ctx.actor, input.ventureId, "plan lead searches");
    if (input.kind !== "find" || input.leadIds) throw new AppError(400, "BAD_REQUEST", "This plans a search for new leads; to enrich a lead use POST /sales/leads/:id/enrich");
    await loadVenture(db, ctx.actor, input.ventureId);
    if (input.playId && !await db.collection("sales_plays").findOne({ _id: input.playId, workspaceId: ctx.workspaceId, ventureId: input.ventureId }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "That play does not belong to this venture");
    // The offer to search for: the one named (active, with an approved packet), else the venture's only usable offer.
    if (input.offerId) await assertUsableOffer(ctx, input.ventureId, input.offerId);
    const offerId = input.offerId ?? await defaultOfferId(db, ctx.workspaceId, input.ventureId);
    const now = new Date();
    const run = defined({ _id: randomUUID(), workspaceId: ctx.workspaceId, ...input, ...(offerId ? { offerId } : {}), status: queue ? "queued" : "planned", createdBy: ctx.actor.id, createdVia: ctx.via, createdAt: now, updatedAt: now });
    await atomic(database, async (session) => {
      await db.collection("sales_find_runs").insertOne(run, { session });
      await auditSales(ctx, "sales.find_run.create", "find_run", run._id, input.ventureId, { status: run.status, limit: input.plan.limit, ...(offerId ? { offerId } : {}) }, session);
    });
    res.status(201).json(ok(present(run)));
  });

  router.post("/find-runs/:id/cancel", async (req, res) => {
    const ctx = salesCtx(database, req);
    const run = await db.collection("sales_find_runs").findOne({ _id: idSchema.parse(req.params.id), workspaceId: ctx.workspaceId });
    if (!run || !canSeeVenture(ctx.actor, run.ventureId)) throw notFound("Find run");
    requireWriter(ctx.actor, run.ventureId, "cancel searches");
    if (!isHeadOf(ctx.actor, run.ventureId) && run.createdBy !== ctx.actor.id) throw forbidden("Only the person who planned this search or a venture head can cancel it");
    if (!["planned", "queued", "running"].includes(String(run.status))) throw new AppError(409, "CONFLICT", `A ${run.status} search cannot be cancelled`);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_find_runs").updateOne({ _id: run._id, status: { $in: ["planned", "queued", "running"] } }, { $set: { status: "cancelled", cancelledBy: ctx.actor.id, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This search changed: reload it and try again");
      await auditSales(ctx, "sales.find_run.cancel", "find_run", String(run._id), String(run.ventureId), undefined, session);
    });
    res.json(ok(present((await db.collection("sales_find_runs").findOne({ _id: run._id }))!)));
  });

  // A saved plan (Claude saves one when the person did not ask it to run) is checked by a person and queued here, in the app only.
  router.post("/find-runs/:id/queue", async (req, res) => {
    const ctx = salesCtx(database, req);
    const run = await db.collection("sales_find_runs").findOne({ _id: idSchema.parse(req.params.id), workspaceId: ctx.workspaceId });
    if (!run || !canSeeVenture(ctx.actor, run.ventureId)) throw notFound("Find run");
    forbidClaude(ctx.via, "Queueing a saved search plan");
    requireWriter(ctx.actor, run.ventureId, "queue searches");
    if (!isHeadOf(ctx.actor, run.ventureId) && run.createdBy !== ctx.actor.id) throw forbidden("Only the person who planned this search or a venture head can queue it");
    if (run.status !== "planned") throw new AppError(409, "CONFLICT", `Only a saved plan can be queued; this search is ${String(run.status)}`);
    await loadVenture(db, ctx.actor, run.ventureId);
    // The offer may have been paused or archived since the plan was saved.
    if (typeof run.offerId === "string") await assertUsableOffer(ctx, run.ventureId, run.offerId);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_find_runs").updateOne({ _id: run._id, status: "planned" }, { $set: { status: "queued", queuedBy: ctx.actor.id, queuedAt: now, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This search changed: reload it and try again");
      await auditSales(ctx, "sales.find_run.queue", "find_run", String(run._id), String(run.ventureId), undefined, session);
    });
    res.json(ok(present((await db.collection("sales_find_runs").findOne({ _id: run._id }))!)));
  });

  // ---- Brain ----------------------------------------------------------------------------------------------------------------

  async function loadBrainItem(ctx: SalesCtx, id: string): Promise<AppDocument> {
    const item = await db.collection("sales_brain_items").findOne({ _id: id, workspaceId: ctx.workspaceId });
    if (!item || !canSeeVenture(ctx.actor, item.ventureId)) throw notFound("Brain item");
    return item;
  }
  /** The approved items a proposal says it replaces: duplicates dropped, and each one an approved item of the same venture (any kind), or a 400. */
  async function checkReplaces(ctx: SalesCtx, ventureId: unknown, ids: string[] | undefined): Promise<string[] | undefined> {
    if (!ids) return undefined;
    const unique = [...new Set(ids)];
    const found = unique.length ? await db.collection("sales_brain_items").find({ _id: { $in: unique }, workspaceId: ctx.workspaceId, ventureId, status: "approved" }, { projection: { _id: 1 } }).toArray() : [];
    const bad = unique.filter((id) => !found.some((row) => String(row._id) === id));
    if (bad.length) throw new AppError(400, "BAD_REQUEST", `A proposal can only replace approved items of the same venture; ${bad.length === 1 ? "this one is" : `${bad.length} of these are`} not: ${bad.slice(0, 5).join(", ")}`);
    return unique;
  }
  /** Brain items as API JSON, each naming the items it replaces (title, kind, version and status now) so the app and Claude can show them. */
  async function brainJson(ctx: SalesCtx, items: AppDocument[]): Promise<Record<string, unknown>[]> {
    const ids = [...new Set(items.flatMap((item) => Array.isArray(item.replaces) ? item.replaces.map(String) : []))];
    const named = new Map((ids.length ? await db.collection("sales_brain_items").find({ _id: { $in: ids }, workspaceId: ctx.workspaceId }, { projection: { title: 1, kind: 1, version: 1, status: 1 } }).toArray() : []).map((row) => [String(row._id), row]));
    return items.map((item) => {
      const replaced = (Array.isArray(item.replaces) ? item.replaces.map(String) : []).flatMap((id) => { const row = named.get(id); return row ? [{ id, title: String(row.title), kind: row.kind, version: Number(row.version), status: row.status }] : []; });
      return { ...present(item), ...(replaced.length ? { replacesItems: replaced } : {}) };
    });
  }
  const oneBrainJson = async (ctx: SalesCtx, item: AppDocument) => (await brainJson(ctx, [item]))[0]!;

  router.get("/brain", async (req, res) => {
    const ctx = salesCtx(database, req);
    const query = brainQuerySchema.parse(req.query);
    const scope = ventureScope(ctx.actor, query.ventureId);
    if (!scope) { res.json(ok([])); return; }
    const statuses = query.status ? query.status.split(",").map((item) => item.trim()).filter(Boolean) : ["draft", "approved"];
    const items = await db.collection("sales_brain_items").find({ workspaceId: ctx.workspaceId, ...scope, status: { $in: statuses } }).sort({ ventureId: 1, kind: 1, title: 1, version: -1 }).limit(500).toArray();
    res.json(ok(await brainJson(ctx, items)));
  });

  router.post("/brain", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { replaces: asked, ...input } = brainItemInputSchema.parse(req.body);
    requireWriter(ctx.actor, input.ventureId, "propose brain items");
    // Offers, target profiles and message rules live in offers now (docs/sales-offers.md): the brain keeps shared notes and settings.
    if (LEGACY_BRAIN_KINDS.has(input.kind)) throw new AppError(400, "BAD_REQUEST", LEGACY_KIND_REFUSAL);
    await loadVenture(db, ctx.actor, input.ventureId);
    const replaces = await checkReplaces(ctx, input.ventureId, asked);
    const now = new Date();
    const latest = await db.collection("sales_brain_items").find({ workspaceId: ctx.workspaceId, ventureId: input.ventureId, kind: input.kind, title: input.title }).sort({ version: -1 }).limit(1).toArray();
    const item = { _id: randomUUID(), workspaceId: ctx.workspaceId, ...input, ...(replaces?.length ? { replaces } : {}), status: "draft", version: Number(latest[0]?.version ?? 0) + 1, proposedBy: ctx.actor.id, via: ctx.via, createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      await db.collection("sales_brain_items").insertOne(item, { session });
      await auditSales(ctx, "sales.brain.propose", "brain_item", item._id, input.ventureId, { kind: input.kind, version: item.version, ...(replaces?.length ? { replaces: replaces.length } : {}) }, session);
    });
    res.status(201).json(ok(await oneBrainJson(ctx, item)));
  });

  router.patch("/brain/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const item = await loadBrainItem(ctx, idSchema.parse(req.params.id));
    const { replaces: asked, ...input } = brainItemUpdateSchema.parse(req.body);
    if (!isHeadOf(ctx.actor, item.ventureId) && !(canWriteIn(ctx.actor, item.ventureId) && item.proposedBy === ctx.actor.id)) throw forbidden("Only the person who proposed this item or a venture head can edit it");
    if (item.status !== "draft") throw new AppError(409, "CONFLICT", "Only a draft can be edited: propose a new version of an approved item instead");
    const replaces = await checkReplaces(ctx, item.ventureId, asked);
    const now = new Date();
    await atomic(database, async (session) => {
      await db.collection("sales_brain_items").updateOne({ _id: item._id, status: "draft" }, { $set: { ...input, ...(replaces ? { replaces } : {}), updatedAt: now } }, { session });
      await auditSales(ctx, "sales.brain.update", "brain_item", String(item._id), String(item.ventureId), replaces ? { replaces: replaces.length } : undefined, session);
    });
    res.json(ok(await oneBrainJson(ctx, (await db.collection("sales_brain_items").findOne({ _id: item._id }))!)));
  });

  // Approving archives the previous approved item with the same venture, kind and title, and the approved items the proposal lists in
  // `replaces` (one already archived meanwhile is skipped). A person's decision: Claude cannot.
  router.post("/brain/:id/approve", async (req, res) => {
    const ctx = salesCtx(database, req);
    const item = await loadBrainItem(ctx, idSchema.parse(req.params.id));
    forbidClaude(ctx.via, "Approving a brain item");
    requireHead(ctx.actor, item.ventureId, "approve brain items");
    if (item.status !== "draft") throw new AppError(409, "CONFLICT", "Only a draft can be approved");
    if (LEGACY_BRAIN_KINDS.has(String(item.kind))) throw new AppError(400, "BAD_REQUEST", `This draft is a ${String(item.kind).replaceAll("_", " ")}, which can no longer be approved here. ${LEGACY_KIND_REFUSAL} Archive this draft once it is carried over.`);
    const now = new Date();
    const retire = { status: "archived", archivedBy: ctx.actor.id, archivedAt: now, replacedBy: item._id, updatedAt: now };
    const listed = (Array.isArray(item.replaces) ? item.replaces.map(String) : []).filter((id) => id !== item._id);
    const retired = await atomic(database, async (session) => {
      await db.collection("sales_brain_items").updateMany({ workspaceId: ctx.workspaceId, ventureId: item.ventureId, kind: item.kind, title: item.title, status: "approved", _id: { $ne: item._id } }, { $set: retire }, { session });
      // The same-title predecessor went just above, so `retired` counts only the other items it replaces.
      const replaced = listed.length ? (await db.collection("sales_brain_items").updateMany({ _id: { $in: listed }, workspaceId: ctx.workspaceId, ventureId: item.ventureId, status: "approved" }, { $set: retire }, { session })).modifiedCount : 0;
      const changed = await db.collection("sales_brain_items").updateOne({ _id: item._id, status: "draft" }, { $set: { status: "approved", approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This item changed: reload it and try again");
      await auditSales(ctx, "sales.brain.approve", "brain_item", String(item._id), String(item.ventureId), { version: Number(item.version), retired: replaced }, session);
      return replaced;
    });
    res.json(ok({ ...await oneBrainJson(ctx, (await db.collection("sales_brain_items").findOne({ _id: item._id }))!), retired }));
  });

  // Archiving takes an item out of use: a venture head or admin any item; the proposer their own draft. Claude never archives an approved item.
  router.post("/brain/:id/archive", async (req, res) => {
    const ctx = salesCtx(database, req);
    const item = await loadBrainItem(ctx, idSchema.parse(req.params.id));
    if (item.status === "archived") throw new AppError(409, "CONFLICT", "This item is already archived");
    if (item.status === "approved") { forbidClaude(ctx.via, "Archiving an approved brain item"); requireHead(ctx.actor, item.ventureId, "archive an approved brain item"); }
    else if (!isHeadOf(ctx.actor, item.ventureId) && !(canWriteIn(ctx.actor, item.ventureId) && item.proposedBy === ctx.actor.id)) throw forbidden("Only the person who proposed this draft or a venture head can archive it");
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_brain_items").updateOne({ _id: item._id, status: item.status }, { $set: { status: "archived", archivedBy: ctx.actor.id, archivedAt: now, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This item changed: reload it and try again");
      await auditSales(ctx, "sales.brain.archive", "brain_item", String(item._id), String(item.ventureId), { was: String(item.status) }, session);
    });
    res.json(ok(present((await db.collection("sales_brain_items").findOne({ _id: item._id }))!)));
  });

  // ---- Do-not-contact list (workspace-wide) -----------------------------------------------------------------------------------

  // Admins see every entry; everyone else sees the entries made from leads of their own ventures, and the ones they made themselves.
  router.get("/suppression", async (req, res) => {
    const ctx = salesCtx(database, req);
    const admin = ctx.actor.membership.role === "admin";
    const mine = ctx.actor.membership.ventureIds;
    const rows = await db.collection("sales_suppression").find({ workspaceId: ctx.workspaceId, ...(admin ? {} : { $or: [{ createdBy: ctx.actor.id }, { ventureId: { $in: mine } }, { leadId: { $exists: true } }] }) }).sort({ createdAt: -1, _id: 1 }).limit(2_000).toArray();
    let visible = rows;
    if (!admin) {
      // Older entries carry only the lead they came from: that lead's venture decides.
      const pending = rows.filter((row) => row.createdBy !== ctx.actor.id && !row.ventureId && row.leadId);
      const ventures = new Map((pending.length ? await db.collection("opportunities").find({ _id: { $in: pending.map((row) => String(row.leadId)) }, workspaceId: ctx.workspaceId }, { projection: { ventureId: 1 } }).toArray() : []).map((lead) => [String(lead._id), String(lead.ventureId)]));
      visible = rows.filter((row) => row.createdBy === ctx.actor.id || (row.ventureId ? mine.includes(String(row.ventureId)) : ventures.has(String(row.leadId)) && mine.includes(ventures.get(String(row.leadId))!)));
    }
    res.json(ok(visible.slice(0, 1_000).map(present)));
  });

  // Adding by hand is for a venture head or admin (opt-outs and hostile replies create their entries automatically).
  router.post("/suppression", async (req, res) => {
    const ctx = salesCtx(database, req);
    const input = suppressionInputSchema.parse(req.body);
    const role = ctx.actor.membership.role;
    if (role !== "admin" && role !== "venture_head") throw forbidden("Only a venture head or admin can add to the do-not-contact list by hand");
    let ventureId: string | undefined;
    if (input.leadId) {
      const lead = await loadLead(ctx, input.leadId);
      if (!isHeadOf(ctx.actor, lead.ventureId)) throw forbidden("Only the head of the lead's venture (or an admin) can add to the do-not-contact list for this lead");
      ventureId = String(lead.ventureId);
    }
    const value = normalizeValue(input.kind, input.value);
    if (!value) throw new AppError(400, "BAD_REQUEST", `That is not a valid ${input.kind === "company" ? "company name" : input.kind}`);
    if (input.kind === "domain" && isSharedDomain(value)) throw new AppError(400, "BAD_REQUEST", "That is a shared mail or platform domain: add the individual email addresses instead");
    const key = suppressionKey(input.kind, value);
    const existing = await db.collection("sales_suppression").findOne({ workspaceId: ctx.workspaceId, key });
    const now = new Date();
    const { rows } = await atomic(database, async (session) => {
      const result = await addSuppression(ctx, [{ kind: input.kind, value }], { reason: input.reason, leadId: input.leadId, ventureId }, now, session);
      await auditSales(ctx, "sales.suppression.add", "suppression", String(result.rows[0]?._id ?? key), ventureId, { kind: input.kind, flagged: result.flagged, existing: Boolean(existing) }, session);
      return result;
    });
    res.status(existing ? 200 : 201).json(ok(present(rows[0]!)));
  });

  // Removing an entry is for an admin, with a reason that is kept in the audit log; leads flagged only because of it are cleared again.
  const removeSchema = z.object({ reason: z.string().trim().min(3).max(300) });
  router.delete("/suppression/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    if (ctx.actor.membership.role !== "admin") throw forbidden("Only an admin can remove a do-not-contact entry");
    const { reason } = removeSchema.parse(req.body ?? {});
    const entry = await db.collection("sales_suppression").findOne({ _id: idSchema.parse(req.params.id), workspaceId: ctx.workspaceId });
    if (!entry) throw notFound("Do-not-contact entry");
    const key = typeof entry.key === "string" ? entry.key : (() => { const value = normalizeValue(entry.kind, String(entry.value)); return value ? suppressionKey(entry.kind, value) : ""; })();
    const now = new Date();
    let cleared = 0;
    await atomic(database, async (session) => {
      await db.collection("sales_suppression").deleteOne({ _id: entry._id }, { session });
      const flagged = key ? await db.collection("opportunities").find({ workspaceId: ctx.workspaceId, suppressKeys: key, doNotContact: true, deletedAt: null }, { session, projection: { suppressKeys: 1 } }).toArray() : [];
      for (const lead of flagged) {
        // Only leads that no other remaining entry matches are cleared.
        const stillSuppressed = await db.collection("sales_suppression").countDocuments({ workspaceId: ctx.workspaceId, key: { $in: (lead.suppressKeys ?? []) as string[] } }, { limit: 1, session });
        if (!stillSuppressed) { await db.collection("opportunities").updateOne({ _id: lead._id }, { $set: { doNotContact: false, updatedAt: now } }, { session }); cleared++; }
      }
      await auditSales(ctx, "sales.suppression.remove", "suppression", String(entry._id), entry.ventureId ? String(entry.ventureId) : undefined, { kind: String(entry.kind), cleared, reason }, session);
    });
    res.json(ok({ id: String(entry._id), cleared }));
  });

  return router;
}
