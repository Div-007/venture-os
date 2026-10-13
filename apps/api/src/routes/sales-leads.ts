import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { activityInputSchema, activityReplyTypeInputSchema, deliveryWorkInputSchema, idSchema, leadFacetsQuerySchema, leadListQuerySchema, pipelineValueQuerySchema, opportunityInputSchema, timezoneSchema, updateOpportunitySchema, verdictInputSchema, verdictOverrideInputSchema, whatsappOptInInputSchema } from "@venture-studio/contracts";
import { atomic, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { canWriteIn, forbidClaude, forbidden, isHeadOf, notFound } from "../sales/access.js";
import { auditSales, salesCtx, settingsFor } from "../sales/ctx.js";
import { approvalNeed } from "../sales/drafts.js";
import { createDeliveryWork } from "../sales/delivery.js";
import { applyActivity, applyReplyType, createLead, discardOpenDrafts, loadLead, markHandled, payloadHash, requireLeadEditor, stageNote, updateLead } from "../sales/leads.js";
import { leadJson, present } from "../sales/present.js";
import { pipelineValue } from "../sales/revenue.js";
import { notifyNeedsYou } from "../sales/notify.js";
import { verdictOffer } from "../sales/offers.js";
import { buildOverview, leadFacets, listInbox, listLeads } from "../sales/queries.js";
import { isPreContactStage, normalizeStage, planOverride, planVerdict } from "../sales/rules.js";
import { SALES_TZ } from "../sales/workdays.js";

const overviewQuerySchema = z.object({ ventureId: idSchema.optional(), owner: z.union([z.literal("me"), idSchema]).optional(), offerId: z.union([idSchema, z.literal("none")]).optional(), tz: timezoneSchema.optional() });
const inboxQuerySchema = z.object({ ventureId: idSchema.optional(), handled: z.enum(["true", "false"]).optional(), owner: z.union([z.literal("me"), idSchema]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const ok = (data: unknown) => ({ ok: true, data });

/** Leads and everything on them: overview, list, detail, edit, delete, activities, inbox, verdicts and delivery work. */
export function salesLeadRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  router.get("/overview", async (req, res) => {
    const query = overviewQuerySchema.parse(req.query);
    res.json(ok(await buildOverview(salesCtx(database, req), { ventureId: query.ventureId, owner: query.owner, offerId: query.offerId, tz: query.tz })));
  });

  router.get("/leads", async (req, res) => {
    res.json(ok(await listLeads(salesCtx(database, req), leadListQuerySchema.parse(req.query))));
  });

  // Counts for the lead filters (state, city, industry, how to reach), with the other active filters applied. Before /leads/:id so "facets" is not read as an id.
  router.get("/leads/facets", async (req, res) => {
    res.json(ok(await leadFacets(salesCtx(database, req), leadFacetsQuerySchema.parse(req.query))));
  });

  // The pipeline in money for the Overview: open and weighted value, the forecast by expected close month, won this month.
  router.get("/pipeline-value", async (req, res) => {
    const query = pipelineValueQuerySchema.parse(req.query);
    res.json(ok(await pipelineValue(salesCtx(database, req), { ...(query.ventureId ? { ventureId: query.ventureId } : {}), ...(query.owner ? { owner: query.owner } : {}), tz: query.tz ?? SALES_TZ })));
  });

  router.post("/leads", async (req, res) => {
    const { lead, created } = await createLead(salesCtx(database, req), opportunityInputSchema.parse(req.body));
    res.status(created ? 201 : 200).json(ok(leadJson(lead)));
  });

  router.get("/leads/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    const filter = { workspaceId: ctx.workspaceId, leadId: String(lead._id) };
    const [activities, drafts, verdicts] = await Promise.all([
      db.collection("sales_activities").find(filter).sort({ at: -1, _id: -1 }).limit(200).toArray(),
      db.collection("sales_drafts").find(filter).sort({ createdAt: -1, _id: -1 }).limit(100).toArray(),
      db.collection("sales_verdicts").find(filter).sort({ createdAt: -1, _id: -1 }).limit(20).toArray(),
    ]);
    // Drafts carry the same approval flags as the Review lists, so the drawer can show Approve to the right people.
    const settings = await settingsFor(ctx, String(lead.ventureId));
    const playIds = [...new Set(drafts.map((draft) => draft.playId).filter((id): id is string => typeof id === "string"))];
    const plays = new Map(playIds.length ? (await db.collection("sales_plays").find({ _id: { $in: playIds }, workspaceId: ctx.workspaceId }).toArray()).map((play) => [String(play._id), play]) : []);
    res.json(ok({ lead: leadJson(lead), activities: activities.map(present), drafts: drafts.map((draft) => ({ ...present(draft), ...approvalNeed(draft, plays.get(String(draft.playId)), settings) })), verdicts: verdicts.map(present) }));
  });

  router.patch("/leads/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    res.json(ok(leadJson(await updateLead(ctx, lead, updateOpportunitySchema.parse(req.body)))));
  });

  // Soft delete: the venture head or an admin, or the owner before first contact. The lead's unsent drafts are discarded.
  router.delete("/leads/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    const beforeFirstContact = isPreContactStage(normalizeStage(lead.stage)) && !lead.lastTouchAt;
    if (!isHeadOf(ctx.actor, lead.ventureId) && !(canWriteIn(ctx.actor, lead.ventureId) && lead.ownerId === ctx.actor.id && beforeFirstContact)) {
      throw forbidden("Only a venture head or admin can delete a lead (its owner can until the first contact)");
    }
    const now = new Date();
    await atomic(database, async (session) => {
      const result = await db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, deletedAt: null }, { $set: { deletedAt: now, deletedBy: ctx.actor.id, updatedAt: now } }, { session });
      if (!result.matchedCount) throw notFound("Lead");
      await discardOpenDrafts(ctx, String(lead._id), "all", "The lead was deleted", now, session);
      await auditSales(ctx, "sales.lead.delete", "lead", String(lead._id), String(lead.ventureId), undefined, session);
    });
    res.json(ok({ id: String(lead._id), deletedAt: now.toISOString() }));
  });

  router.post("/leads/:id/activities", async (req, res) => {
    const ctx = salesCtx(database, req);
    const id = idSchema.parse(req.params.id);
    const input = activityInputSchema.parse(req.body);
    const lead = await loadLead(ctx, id);
    requireLeadEditor(ctx, lead, "log activity on this lead");
    // The same requestId with the same content repeats the first answer instead of logging twice; the same id with other content is refused.
    const hash = payloadHash({ ...input, requestId: undefined });
    const replay = async () => {
      if (!input.requestId) return null;
      const prior = await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, leadId: id, requestId: input.requestId });
      if (!prior) return null;
      if (prior.payloadHash && prior.payloadHash !== hash) throw new AppError(409, "CONFLICT", "That requestId was already used for a different activity: use a new requestId for new content");
      return { activity: present(prior), lead: leadJson((await db.collection("opportunities").findOne({ _id: id }))!) };
    };
    const replayed = await replay();
    if (replayed) { res.json(ok(replayed)); return; }
    if (input.draftId && !await db.collection("sales_drafts").findOne({ _id: input.draftId, workspaceId: ctx.workspaceId, leadId: id }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "That draft does not belong to this lead");
    const now = new Date();
    let activity;
    try {
      activity = await atomic(database, async (session) => {
        const fresh = await loadLead(ctx, id, session);
        const result = await applyActivity(ctx, fresh, input, now, session);
        await auditSales(ctx, "sales.activity.log", "activity", String(result.activity._id), String(fresh.ventureId), { kind: input.kind, direction: String(result.activity.direction ?? "none"), ...(input.replyType ? { replyType: input.replyType } : {}), ...(input.callOutcome ? { callOutcome: input.callOutcome } : {}), ...(result.stageTo ? { stageTo: result.stageTo } : {}) }, session);
        return result.activity;
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) { const raced = await replay(); if (raced) { res.json(ok(raced)); return; } }
      throw error;
    }
    res.status(201).json(ok({ activity: present(activity), lead: leadJson((await db.collection("opportunities").findOne({ _id: id }))!) }));
  });

  // Sorts an inbound reply into one of the reply types after the fact: the type's rules apply as if it had been logged with it.
  router.patch("/activities/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const activity = await db.collection("sales_activities").findOne({ _id: idSchema.parse(req.params.id), workspaceId: ctx.workspaceId });
    if (!activity) throw notFound("Activity");
    const lead = await loadLead(ctx, String(activity.leadId));
    requireLeadEditor(ctx, lead, "set the reply type on this lead's messages");
    const { replyType } = activityReplyTypeInputSchema.parse(req.body);
    if (activity.direction !== "in") throw new AppError(400, "BAD_REQUEST", "Only inbound messages have a reply type");
    const current = async () => ok({ activity: present((await db.collection("sales_activities").findOne({ _id: activity._id }))!), lead: leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!) });
    if (activity.replyType === replyType) { res.json(await current()); return; }
    // An opt-out (or hostile reply) put the company on the do-not-contact list: that is only ever undone from the list itself.
    if (activity.replyType === "opt_out" || activity.replyType === "hostile") throw new AppError(409, "CONFLICT", `This reply was marked ${activity.replyType}: the company is on the do-not-contact list, and a venture head removes it from there`);
    const now = new Date();
    await atomic(database, async (session) => {
      const fresh = await loadLead(ctx, String(lead._id), session);
      const result = await applyReplyType(ctx, fresh, activity, replyType, now, session);
      await auditSales(ctx, "sales.activity.reply_type", "activity", String(activity._id), String(lead.ventureId), { replyType, ...(result.stageTo ? { stageTo: result.stageTo } : {}) }, session);
    });
    res.json(await current());
  });

  // Clears an inbound item from the Inbox.
  router.post("/activities/:id/handled", async (req, res) => {
    const ctx = salesCtx(database, req);
    const activity = await db.collection("sales_activities").findOne({ _id: idSchema.parse(req.params.id), workspaceId: ctx.workspaceId });
    if (!activity) throw notFound("Activity");
    const lead = await loadLead(ctx, String(activity.leadId));
    requireLeadEditor(ctx, lead, "clear this from the Inbox");
    if (activity.direction !== "in") throw new AppError(400, "BAD_REQUEST", "Only inbound messages wait in the Inbox");
    const needsOptIn = ctx.via === "app" && activity.kind === "whatsapp" && !lead.whatsappOptIn;
    if (!activity.handledAt || needsOptIn) {
      const now = new Date();
      await atomic(database, async (session) => {
        const { optIn } = await markHandled(ctx, lead, activity, now, session);
        if (!activity.handledAt || optIn) await auditSales(ctx, "sales.activity.handled", "activity", String(activity._id), String(activity.ventureId), optIn ? { whatsappOptIn: true } : undefined, session);
      });
    }
    res.json(ok(present((await db.collection("sales_activities").findOne({ _id: activity._id }))!)));
  });

  router.get("/inbox", async (req, res) => {
    res.json(ok(await listInbox(salesCtx(database, req), inboxQuerySchema.parse(req.query))));
  });

  // Claude's verdict on a lead: saved with its evidence, then the lead's summary, needs-you flag and (before first contact) stage follow.
  // It is judged against an offer (sales/offers.ts verdictOffer): the lead's, the one it names (a lead with no offer takes it), or the
  // venture's only usable one; naming another offer than the lead's is refused.
  router.post("/leads/:id/verdicts", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "save a verdict on this lead");
    const input = verdictInputSchema.parse(req.body);
    // Claude does not overrule a person: a verdict a person saved or overrode, or a lead waiting for a person's decision, is not replaced by Claude.
    if (ctx.via === "claude") {
      const current = lead.verdict as { overridden?: boolean; via?: string } | undefined;
      if (current?.overridden) throw new AppError(409, "CONFLICT", "A person overrode the current verdict on this lead: Claude cannot replace it. Ask a person to review it in the app");
      if (current?.via === "app") throw new AppError(409, "CONFLICT", "A person set the current verdict on this lead: Claude cannot replace it. Ask a person to review it in the app");
      if (lead.needsYou) throw new AppError(409, "CONFLICT", "This lead is waiting for a person's decision (needs you): Claude cannot save a new verdict until a person has decided");
    }
    const offer = await verdictOffer(ctx, lead, input.offerId);
    const now = new Date();
    const verdictId = randomUUID();
    const plan = planVerdict(lead, input, verdictId, now, { via: ctx.via, actorId: ctx.actor.id });
    if (offer.setOnLead) plan.set.offerId = offer.offerId;
    const verdict = {
      _id: verdictId, workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, createdBy: ctx.actor.id, via: ctx.via, createdAt: now, ...input, ...(offer.offerId ? { offerId: offer.offerId } : {}),
      evidence: input.evidence.map((item) => ({ ...item, ...(item.seenAt ? { seenAt: new Date(item.seenAt) } : {}) })), ...(input.signalSeenAt ? { signalSeenAt: new Date(input.signalSeenAt) } : {}),
    };
    await atomic(database, async (session) => {
      await db.collection("sales_verdicts").insertOne(verdict, { session });
      await db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId }, { $set: { ...plan.set, updatedAt: now }, ...(plan.unset.length ? { $unset: Object.fromEntries(plan.unset.map((field) => [field, ""])) } : {}) }, { session });
      if (plan.stageTo) {
        await stageNote(ctx, lead, plan.stageFrom, plan.stageTo, "system", now, session, `Stage: ${plan.stageFrom} -> ${plan.stageTo} after Claude's verdict (${input.decision})`);
        await discardOpenDrafts(ctx, String(lead._id), plan.discardDrafts, `Lead moved to ${plan.stageTo}`, now, session);
      }
      // The lead just landed in "needs you": its owner is told (once while it stays there).
      if (plan.set.needsYou === true && lead.needsYou !== true) await notifyNeedsYou(ctx, lead, verdictId, `${input.decision}, ${input.confidence} confidence: ${input.summary}`, now, session);
      await auditSales(ctx, "sales.verdict.save", "verdict", verdictId, String(lead.ventureId), { decision: input.decision, confidence: input.confidence, needsYou: Boolean(plan.set.needsYou), ...(offer.offerId ? { offerId: offer.offerId } : {}), ...(plan.stageTo ? { stageTo: plan.stageTo } : {}) }, session);
    });
    res.status(201).json(ok({ verdict: present(verdict), lead: leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!) }));
  });

  // A person's override with a reason. Claude cannot override: it would clear its own needs-you flag.
  router.post("/verdicts/:id/override", async (req, res) => {
    const ctx = salesCtx(database, req);
    const verdict = await db.collection("sales_verdicts").findOne({ _id: idSchema.parse(req.params.id), workspaceId: ctx.workspaceId });
    if (!verdict) throw notFound("Verdict");
    const lead = await loadLead(ctx, String(verdict.leadId));
    forbidClaude(ctx.via, "Overriding a verdict");
    requireLeadEditor(ctx, lead, "override the verdict on this lead");
    const input = verdictOverrideInputSchema.parse(req.body);
    if ((lead.verdict as { verdictId?: string } | undefined)?.verdictId !== String(verdict._id)) throw new AppError(409, "CONFLICT", "Only the latest verdict of a lead can be overridden");
    const now = new Date();
    const plan = planOverride(lead, lead.verdict as Record<string, unknown>, input.decision, input.reason, now, ctx.actor.id);
    await atomic(database, async (session) => {
      await db.collection("sales_verdicts").updateOne({ _id: verdict._id }, { $set: { override: { decision: input.decision, reason: input.reason, by: ctx.actor.id, at: now } } }, { session });
      await db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId }, { $set: { ...plan.set, updatedAt: now }, ...(plan.unset.length ? { $unset: Object.fromEntries(plan.unset.map((field) => [field, ""])) } : {}) }, { session });
      if (plan.stageTo) {
        await stageNote(ctx, lead, plan.stageFrom, plan.stageTo, "app", now, session, `Stage: ${plan.stageFrom} -> ${plan.stageTo} after the verdict was overridden (${input.decision})`);
        await discardOpenDrafts(ctx, String(lead._id), plan.discardDrafts, `Lead moved to ${plan.stageTo}`, now, session);
      }
      await auditSales(ctx, "sales.verdict.override", "verdict", String(verdict._id), String(lead.ventureId), { decision: input.decision, ...(plan.stageTo ? { stageTo: plan.stageTo } : {}) }, session);
    });
    res.json(ok({ verdict: present((await db.collection("sales_verdicts").findOne({ _id: verdict._id }))!), lead: leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!) }));
  });

  // WhatsApp consent is a person's to record: they messaged us, said yes on a call, or said yes by email. Claude never records it.
  router.post("/leads/:id/whatsapp-opt-in", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    forbidClaude(ctx.via, "Recording a lead's WhatsApp consent");
    requireLeadEditor(ctx, lead, "record WhatsApp consent for this lead");
    const input = whatsappOptInInputSchema.parse(req.body);
    if (lead.doNotContact) throw new AppError(409, "CONFLICT", "This lead is on the do-not-contact list: it cannot be opted in to WhatsApp");
    if (input.activityId) {
      const activity = await db.collection("sales_activities").findOne({ _id: input.activityId, workspaceId: ctx.workspaceId, leadId: String(lead._id) });
      const yesOnCall = activity?.kind === "call" && activity.callOutcome === "yes_whatsapp" && input.how === "yes_on_call";
      const theyMessaged = activity?.kind === "whatsapp" && activity.direction === "in" && input.how === "they_messaged";
      if (!yesOnCall && !theyMessaged) throw new AppError(400, "BAD_REQUEST", "activityId must be this lead's call logged as yes_whatsapp (how yes_on_call) or an inbound WhatsApp message (how they_messaged)");
    }
    if (!lead.whatsappOptIn) {
      const now = new Date();
      await atomic(database, async (session) => {
        await db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, whatsappOptIn: null }, { $set: { whatsappOptIn: { at: now, by: ctx.actor.id, how: input.how }, updatedAt: now } }, { session });
        await auditSales(ctx, "sales.lead.whatsapp_opt_in", "lead", String(lead._id), String(lead.ventureId), { how: input.how, ...(input.activityId ? { activityId: input.activityId } : {}) }, session);
      });
    }
    res.json(ok(leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!)));
  });

  router.post("/leads/:id/delivery-work", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    const result = await createDeliveryWork(ctx, lead, deliveryWorkInputSchema.parse(req.body ?? {}));
    res.status(201).json(ok({ lead: leadJson(result.lead), task: jsonValue(result.task) }));
  });

  return router;
}
