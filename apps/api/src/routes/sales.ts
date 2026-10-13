import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Database } from "../db.js";
import { idSchema, opportunityInputSchema, pipelineInputSchema, updateOpportunitySchema, updatePipelineSchema } from "@venture-studio/contracts";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { inArchivedVenture, notArchived } from "../archive-scope.js";
import { salesCtx } from "../sales/ctx.js";
import { createLead, loadLead, updateLead } from "../sales/leads.js";
import { leadJson } from "../sales/present.js";
import { salesAdminRoutes } from "./sales-admin.js";
import { salesDraftRoutes } from "./sales-drafts.js";
import { salesEnrichRoutes } from "./sales-engine.js";
import { salesSettingsRoutes } from "./sales-settings.js";
import { salesLeadRoutes } from "./sales-leads.js";
import { salesOfferRoutes } from "./sales-offers.js";

/**
 * Sales: the older /pipelines and /opportunities routes (same records as the leads, hiding soft-deleted ones and using
 * the current stages) and everything under /sales (see docs/sales-dealflow.md; offers: docs/sales-offers.md).
 */
export function salesRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  router.get("/pipelines", async (req, res) => {
    const actor = req.actor!; const filter = actor.membership.role === "admin" ? notArchived(actor.membership) : { ventureId: { $in: actor.membership.ventureIds } };
    res.json({ ok: true, data: jsonValue(await db.collection("pipelines").find({ workspaceId: actor.membership.workspaceId, ...filter }).toArray()) });
  });
  router.post("/pipelines", async (req, res) => {
    const actor = req.actor!; const input = pipelineInputSchema.parse(req.body);
    if (inArchivedVenture(actor.membership, input.ventureId) || (actor.membership.role !== "admin" && (actor.membership.role !== "venture_head" || !actor.membership.ventureIds.includes(input.ventureId)))) throw new AppError(403, "FORBIDDEN", "Pipeline access denied");
    const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...input, createdAt: new Date(), updatedAt: new Date() };
    await db.collection("pipelines").insertOne(item); await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "pipeline.create", objectType: "pipeline", objectId: String(item._id), ventureId: input.ventureId, result: "success" });
    res.status(201).json({ ok: true, data: jsonValue(item) });
  });
  router.patch("/pipelines/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const pipeline = await db.collection("pipelines").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!pipeline || inArchivedVenture(actor.membership, pipeline.ventureId) || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(String(pipeline.ventureId)))) throw new AppError(404, "NOT_FOUND", "Pipeline not found");
    if (actor.membership.role !== "admin" && actor.membership.role !== "venture_head") throw new AppError(403, "FORBIDDEN", "Only venture leads may edit pipelines");
    const input = updatePipelineSchema.parse(req.body);
    await db.collection("pipelines").updateOne({ _id: id, workspaceId: actor.membership.workspaceId }, { $set: { ...input, updatedAt: new Date() } });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "pipeline.update", objectType: "pipeline", objectId: id, ventureId: String(pipeline.ventureId), result: "success" });
    res.json({ ok: true, data: jsonValue(await db.collection("pipelines").findOne({ _id: id })) });
  });

  // The older deal routes work on the same records as /sales/leads: soft-deleted ones stay hidden, stage rules and owner rules are shared.
  // Bounded: newest updated first, 500 by default (up to 1000); `offset` pages on. The answer stays a plain array.
  const opportunitiesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(1_000).default(500), offset: z.coerce.number().int().min(0).max(100_000).default(0) });
  router.get("/opportunities", async (req, res) => {
    const actor = req.actor!; const { limit, offset } = opportunitiesQuerySchema.parse(req.query);
    const pipelines = await db.collection("pipelines").find({ workspaceId: actor.membership.workspaceId, ...(actor.membership.role === "admin" ? notArchived(actor.membership) : { ventureId: { $in: actor.membership.ventureIds } }) }).project({ _id: 1 }).toArray();
    res.json({ ok: true, data: (await db.collection("opportunities").find({ workspaceId: actor.membership.workspaceId, pipelineId: { $in: pipelines.map((item) => item._id) }, deletedAt: null }).sort({ updatedAt: -1, _id: 1 }).skip(offset).limit(limit).toArray()).map(leadJson) });
  });
  router.post("/opportunities", async (req, res) => {
    const input = opportunityInputSchema.parse(req.body);
    const { lead, created } = await createLead(salesCtx(database, req), input);
    res.status(created ? 201 : 200).json({ ok: true, data: leadJson(lead) });
  });
  router.patch("/opportunities/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    res.json({ ok: true, data: leadJson(await updateLead(ctx, lead, updateOpportunitySchema.parse(req.body))) });
  });

  router.use("/sales", salesLeadRoutes(database), salesDraftRoutes(database), salesAdminRoutes(database), salesEnrichRoutes(database), salesSettingsRoutes(database), salesOfferRoutes(database));
  return router;
}
