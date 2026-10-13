import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { idSchema, offerProposalInputSchema, offerProposalUpdateSchema, offerStateInputSchema } from "@venture-studio/contracts";
import { atomic, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { canWriteIn, forbidClaude, forbidden, isHeadOf, loadVenture, requireHead, requireWriter, ventureScope } from "../sales/access.js";
import { auditSales, salesCtx, type SalesCtx } from "../sales/ctx.js";
import { OFFERS, OFFER_NAME_COLLATION, OFFER_VERSIONS, loadOffer, loadOfferVersion, offerJson, offerNamed, offersJson, versionJson } from "../sales/offers.js";

const ok = (data: unknown) => ({ ok: true, data });
const listQuerySchema = z.object({ ventureId: idSchema.optional() });
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;
const nameTaken = (name: string) => new AppError(409, "CONFLICT", `Another offer of this venture is called "${name}": pick another name, or propose a new version of that offer instead`);

/**
 * Offers (docs/sales-offers.md), mounted at /v1/sales. Anyone who can open the venture reads them; a writer in the venture (or Claude)
 * proposes a new offer or a new draft version of one; its proposer or a venture head edits or discards a draft; a venture head or admin
 * approves a version as a whole and pauses, activates or archives the offer, in the app only (never Claude).
 *
 * - GET /offers?ventureId: the offers (approved version, proposals waiting, counts). GET /offers/:id: one, with its archived versions.
 * - POST /offers: a new offer with a draft v1, or with `offerId` a new draft version of that offer (201, the version).
 * - PATCH /offers/versions/:versionId, POST /offers/versions/:versionId/approve and /discard, POST /offers/:id/state.
 */
export function salesOfferRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  const offers = db.collection(OFFERS);
  const versions = db.collection(OFFER_VERSIONS);
  /** Edits and discards a draft: its proposer (who can still write in the venture) or a venture head. */
  const requireDraftEditor = (ctx: SalesCtx, version: AppDocument, what: string) => {
    if (!isHeadOf(ctx.actor, version.ventureId) && !(canWriteIn(ctx.actor, version.ventureId) && version.proposedBy === ctx.actor.id)) throw forbidden(`Only the person who proposed this version or a venture head can ${what}`);
  };

  router.get("/offers", async (req, res) => {
    const ctx = salesCtx(database, req);
    const scope = ventureScope(ctx.actor, listQuerySchema.parse(req.query).ventureId);
    if (!scope) { res.json(ok([])); return; }
    const rows = await offers.find({ workspaceId: ctx.workspaceId, ...scope }, { collation: OFFER_NAME_COLLATION }).sort({ ventureId: 1, name: 1, _id: 1 }).limit(200).toArray();
    res.json(ok(await offersJson(ctx, rows)));
  });

  router.get("/offers/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const offer = await loadOffer(ctx, idSchema.parse(req.params.id));
    const history = await versions.find({ workspaceId: ctx.workspaceId, offerId: String(offer._id), status: "archived" }).sort({ version: -1 }).limit(20).toArray();
    res.json(ok({ ...await offerJson(ctx, offer), history: history.map(versionJson) }));
  });

  // A new offer (with its first version as a draft), or the next draft version of an existing offer. Nothing is in force until approved.
  router.post("/offers", async (req, res) => {
    const ctx = salesCtx(database, req);
    const input = offerProposalInputSchema.parse(req.body);
    requireWriter(ctx.actor, input.ventureId, "propose offers");
    await loadVenture(db, ctx.actor, input.ventureId);
    const existing = input.offerId ? await loadOffer(ctx, input.offerId) : undefined;
    if (existing && existing.ventureId !== input.ventureId) throw new AppError(400, "BAD_REQUEST", "That offer belongs to another venture");
    if (existing?.state === "archived") throw new AppError(409, "CONFLICT", "This offer is archived: a venture head activates it in the app before a new version is proposed");
    const same = await offerNamed(db, ctx.workspaceId, input.ventureId, input.name, existing?._id);
    if (same) throw nameTaken(String(same.name));
    const now = new Date();
    const offerId = existing ? String(existing._id) : randomUUID();
    const latest = existing ? await versions.find({ offerId }).sort({ version: -1 }).limit(1).toArray() : [];
    const version = {
      _id: randomUUID(), offerId, workspaceId: ctx.workspaceId, ventureId: input.ventureId, version: Number(latest[0]?.version ?? 0) + 1, status: "draft", name: input.name, packet: input.packet,
      change: input.change, proposedBy: ctx.actor.id, via: ctx.via, createdAt: now, updatedAt: now,
    };
    try {
      await atomic(database, async (session) => {
        if (!existing) await offers.insertOne({ _id: offerId, workspaceId: ctx.workspaceId, ventureId: input.ventureId, name: input.name, state: "active", createdBy: ctx.actor.id, createdVia: ctx.via, createdAt: now, updatedAt: now }, { session });
        await versions.insertOne(version, { session });
        await auditSales(ctx, "sales.offer.propose", "offer_version", version._id, input.ventureId, { offerId, version: version.version, newOffer: !existing }, session);
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw existing ? new AppError(409, "CONFLICT", "Another version of this offer was proposed at the same moment: try again") : nameTaken(input.name);
      throw error;
    }
    res.status(201).json(ok(versionJson(version)));
  });

  router.patch("/offers/versions/:versionId", async (req, res) => {
    const ctx = salesCtx(database, req);
    const version = await loadOfferVersion(ctx, idSchema.parse(req.params.versionId));
    const input = offerProposalUpdateSchema.parse(req.body);
    requireDraftEditor(ctx, version, "edit it");
    if (version.status !== "draft") throw new AppError(409, "CONFLICT", "Only a draft can be edited: propose a new version instead");
    if (input.name) { const same = await offerNamed(db, ctx.workspaceId, version.ventureId, input.name, version.offerId); if (same) throw nameTaken(String(same.name)); }
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await versions.updateOne({ _id: version._id, status: "draft" }, { $set: { ...input, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This version changed: reload it and try again");
      await auditSales(ctx, "sales.offer.update", "offer_version", String(version._id), String(version.ventureId), { offerId: String(version.offerId), fields: Object.keys(input).join(",") }, session);
    });
    res.json(ok(versionJson((await versions.findOne({ _id: version._id }))!)));
  });

  // Approving a version, as a whole, is a person's decision in the app: it archives the version approved before, makes this one the
  // offer's packet and gives the offer this version's name, in one step.
  router.post("/offers/versions/:versionId/approve", async (req, res) => {
    const ctx = salesCtx(database, req);
    const version = await loadOfferVersion(ctx, idSchema.parse(req.params.versionId));
    forbidClaude(ctx.via, "Approving an offer");
    requireHead(ctx.actor, version.ventureId, "approve offers");
    if (version.status !== "draft") throw new AppError(409, "CONFLICT", "Only a draft version can be approved");
    const offer = await loadOffer(ctx, String(version.offerId));
    if (offer.state === "archived") throw new AppError(409, "CONFLICT", "This offer is archived: a venture head activates it before a version is approved");
    const same = await offerNamed(db, ctx.workspaceId, offer.ventureId, String(version.name), offer._id);
    if (same) throw nameTaken(String(same.name));
    const now = new Date();
    const previous = typeof offer.approvedVersionId === "string" ? await versions.findOne({ _id: offer.approvedVersionId }, { projection: { version: 1 } }) : null;
    try {
      await atomic(database, async (session) => {
        await versions.updateMany({ offerId: String(offer._id), status: "approved", _id: { $ne: version._id } }, { $set: { status: "archived", archivedAt: now, archivedBy: ctx.actor.id, replacedBy: version._id, updatedAt: now } }, { session });
        const changed = await versions.updateOne({ _id: version._id, status: "draft" }, { $set: { status: "approved", approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now } }, { session });
        if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This version changed: reload it and try again");
        await offers.updateOne({ _id: offer._id }, { $set: { approvedVersionId: version._id, name: version.name, updatedAt: now } }, { session });
        await auditSales(ctx, "sales.offer.approve", "offer_version", String(version._id), String(version.ventureId), { offerId: String(offer._id), version: Number(version.version), ...(previous ? { replaced: Number(previous.version) } : {}) }, session);
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw nameTaken(String(version.name));
      throw error;
    }
    res.json(ok(await offerJson(ctx, (await offers.findOne({ _id: offer._id }))!)));
  });

  // Discarding a draft archives it; the approved version, if any, stays in force.
  router.post("/offers/versions/:versionId/discard", async (req, res) => {
    const ctx = salesCtx(database, req);
    const version = await loadOfferVersion(ctx, idSchema.parse(req.params.versionId));
    requireDraftEditor(ctx, version, "discard it");
    if (version.status !== "draft") throw new AppError(409, "CONFLICT", "Only a draft can be discarded");
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await versions.updateOne({ _id: version._id, status: "draft" }, { $set: { status: "archived", archivedAt: now, archivedBy: ctx.actor.id, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This version changed: reload it and try again");
      await auditSales(ctx, "sales.offer.discard", "offer_version", String(version._id), String(version.ventureId), { offerId: String(version.offerId), version: Number(version.version) }, session);
    });
    res.json(ok(versionJson((await versions.findOne({ _id: version._id }))!)));
  });

  // Active, paused or archived: a venture head or admin, in the app. A paused or archived offer gets no new leads, verdicts or find runs.
  router.post("/offers/:id/state", async (req, res) => {
    const ctx = salesCtx(database, req);
    const offer = await loadOffer(ctx, idSchema.parse(req.params.id));
    forbidClaude(ctx.via, "Pausing, activating or archiving an offer");
    requireHead(ctx.actor, offer.ventureId, "pause, activate or archive offers");
    const { state } = offerStateInputSchema.parse(req.body);
    if (offer.state !== state) {
      const now = new Date();
      await atomic(database, async (session) => {
        const changed = await offers.updateOne({ _id: offer._id, state: offer.state }, { $set: { state, updatedAt: now } }, { session });
        if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This offer changed: reload it and try again");
        await auditSales(ctx, "sales.offer.state", "offer", String(offer._id), String(offer.ventureId), { from: String(offer.state), to: state }, session);
      });
    }
    res.json(ok(await offerJson(ctx, (await offers.findOne({ _id: offer._id }))!)));
  });

  return router;
}
