import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { draftInputSchema, draftReviewInputSchema, draftSendInputSchema, draftUpdateSchema, draftVetoInputSchema, idSchema } from "@venture-studio/contracts";
import { atomic, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { forbidClaude, forbidden, isHeadOf, notFound, requireHead, requireWriter } from "../sales/access.js";
import { auditSales, salesCtx, settingsFor, type SalesCtx } from "../sales/ctx.js";
import { approvalNeed, channelOf, isOpenDraft, needsPersonApproval, reviewOutcome, sendBlocker } from "../sales/drafts.js";
import { notifyApprovalNeeded } from "../sales/notify.js";
import { startOfLocalDay } from "../sales/workdays.js";
import { applyActivity, claimSendSlot, defined, isCappedChannel, loadLead, markHandled, payloadHash, requireLeadEditor } from "../sales/leads.js";
import { leadJson, present } from "../sales/present.js";
import { getDraftWithLead, listDrafts } from "../sales/queries.js";

const draftsQuerySchema = z.object({ ventureId: idSchema.optional(), status: z.string().max(200).optional(), owner: z.union([z.literal("me"), idSchema]).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
const ok = (data: unknown) => ({ ok: true, data });

/** Drafts: written (usually by Claude), reviewed in a separate pass, approved for a play's first batch by a head, sent by a person. */
export function salesDraftRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  async function loadDraft(ctx: SalesCtx, id: string, session?: import("mongodb").ClientSession) {
    const draft = await db.collection("sales_drafts").findOne({ _id: id, workspaceId: ctx.workspaceId }, { session });
    if (!draft) throw notFound("Draft");
    return { draft, lead: await loadLead(ctx, String(draft.leadId), session) };
  }
  /** The draft as the API returns it: with whether it waits for a person's approval, and why (the same rule the send route applies). */
  const shown = async (ctx: SalesCtx, draft: AppDocument) => {
    const play = typeof draft.playId === "string" ? await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }) : null;
    return { ...present(draft), ...approvalNeed(draft, play, await settingsFor(ctx, String(draft.ventureId))) };
  };
  const reload = async (ctx: SalesCtx, id: unknown) => shown(ctx, (await db.collection("sales_drafts").findOne({ _id: String(id) }))!);

  /**
   * How many of a play's drafts a venture head or admin approved: only those count toward its first batch. Approvals stored before
   * `byHead` existed count when the approver heads the play's venture or is an admin.
   */
  async function headApprovals(ctx: SalesCtx, play: AppDocument, session?: import("mongodb").ClientSession): Promise<number> {
    const rows = await db.collection("sales_drafts").find({ workspaceId: ctx.workspaceId, playId: String(play._id), personApproval: { $type: "object" } }, { session, projection: { personApproval: 1 } }).toArray();
    const legacy = [...new Set(rows.filter((row) => row.personApproval.byHead === undefined).map((row) => String(row.personApproval.by)))];
    const heads = new Set(legacy.length ? (await db.collection("memberships").find({ workspaceId: ctx.workspaceId, userId: { $in: legacy }, status: "active", $or: [{ role: "admin" }, { role: "venture_head", ventureIds: play.ventureId }] }, { session, projection: { userId: 1 } }).toArray()).map((row) => String(row.userId)) : []);
    return rows.filter((row) => row.personApproval.byHead === true || (row.personApproval.byHead === undefined && heads.has(String(row.personApproval.by)))).length;
  }

  router.get("/drafts", async (req, res) => {
    res.json(ok(await listDrafts(salesCtx(database, req), draftsQuerySchema.parse(req.query))));
  });

  // One draft, shaped like a list row (lead summary, whether it waits for a person's approval): anyone who can open the lead's venture.
  router.get("/drafts/:id", async (req, res) => {
    res.json(ok(await getDraftWithLead(salesCtx(database, req), idSchema.parse(req.params.id))));
  });

  router.post("/leads/:id/drafts", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "write drafts for this lead");
    const input = draftInputSchema.parse(req.body);
    if (lead.doNotContact) throw new AppError(409, "CONFLICT", "This lead is on the do-not-contact list: no drafts can be written for it");
    const settings = await settingsFor(ctx, String(lead.ventureId));
    if (!settings.allowedChannels.includes(channelOf(input) as never)) throw new AppError(409, "CONFLICT", `This venture does not use ${channelOf(input)} for outreach (see its sales settings)`);
    // A lead that belongs to a play brings its drafts into that play (and its first-batch approval).
    const playId = input.playId ?? (typeof lead.playId === "string" ? lead.playId : undefined);
    if (playId && !await db.collection("sales_plays").findOne({ _id: playId, workspaceId: ctx.workspaceId, ventureId: lead.ventureId }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "That play does not belong to this lead's venture");
    if (input.inReplyTo && !await db.collection("sales_activities").findOne({ _id: input.inReplyTo, workspaceId: ctx.workspaceId, leadId: String(lead._id) }, { projection: { _id: 1 } })) throw new AppError(400, "BAD_REQUEST", "inReplyTo must be an activity on this lead");
    const now = new Date();
    const draft = defined({
      _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, playId, inReplyTo: input.inReplyTo, channel: input.channel, purpose: input.purpose, subject: input.subject, body: input.body,
      status: input.submit ? "in_review" : "draft", authorId: ctx.actor.id, authorVia: ctx.via, authorSessionId: input.sessionId, createdAt: now, updatedAt: now,
    });
    await atomic(database, async (session) => {
      await db.collection("sales_drafts").insertOne(draft, { session });
      await auditSales(ctx, "sales.draft.create", "draft", draft._id, String(lead.ventureId), { channel: input.channel, purpose: input.purpose, status: draft.status }, session);
    });
    res.status(201).json(ok(await shown(ctx, draft)));
  });

  // Editing the text sends the draft back to review and clears the review and any approval.
  router.patch("/drafts/:id", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "edit this draft");
    if (!isOpenDraft(draft)) throw new AppError(409, "CONFLICT", `A ${draft.status} draft can no longer be edited`);
    const input = draftUpdateSchema.parse(req.body);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: { $in: ["draft", "in_review", "ready", "needs_changes"] } }, {
        $set: { ...(input.subject !== undefined ? { subject: input.subject } : {}), ...(input.body !== undefined ? { body: input.body } : {}), status: "in_review", authorId: ctx.actor.id, authorVia: ctx.via, updatedAt: now, ...(input.sessionId ? { authorSessionId: input.sessionId } : {}) },
        $unset: { review: "", personApproval: "", ...(input.sessionId ? {} : { authorSessionId: "" }) },
      }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      await auditSales(ctx, "sales.draft.update", "draft", String(draft._id), String(lead.ventureId), undefined, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  // Review pass: pass -> ready, fail -> needs_changes. Claude's review of a Claude draft must come from a different session.
  router.post("/drafts/:id/review", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(ctx, idSchema.parse(req.params.id));
    requireWriter(ctx.actor, lead.ventureId, "review drafts");
    const input = draftReviewInputSchema.parse(req.body);
    const status = reviewOutcome(draft, input, ctx.via);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: "in_review" }, { $set: { status, review: defined({ result: input.result, issues: input.issues, notes: input.notes, sessionId: input.sessionId, by: ctx.actor.id, via: ctx.via, at: now }), updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed while it was being reviewed: reload it and try again");
      // Ready, but a person has to approve it before it can be sent: the venture's heads and admins are told once per draft.
      if (status === "ready") {
        const play = draft.playId ? await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }, { session }) : null;
        if (needsPersonApproval({ ...draft, status: "ready" }, play, await settingsFor(ctx, String(lead.ventureId)))) await notifyApprovalNeeded(ctx, lead, draft, now, session);
      }
      await auditSales(ctx, "sales.draft.review", "draft", String(draft._id), String(lead.ventureId), { result: input.result, status }, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  // A person reads a play's first batch in full: head or admin, in the app only. Enough head approvals mark the batch as reviewed.
  router.post("/drafts/:id/approve", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(ctx, idSchema.parse(req.params.id));
    forbidClaude(ctx.via, "Approving a draft");
    // First-batch approval is for a head or admin; where every message needs a person, the lead's owner may approve their own messages too
    // (to send them), but only a head's or admin's approval counts toward a play's first batch.
    if ((await settingsFor(ctx, String(lead.ventureId))).approvalMode === "person_approves_every_message") requireLeadEditor(ctx, lead, "approve a message");
    else requireHead(ctx.actor, lead.ventureId, "approve a draft");
    if (draft.status !== "ready") throw new AppError(409, "CONFLICT", "Only a draft that passed review (ready) can be approved");
    const byHead = isHeadOf(ctx.actor, lead.ventureId);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: "ready" }, { $set: { personApproval: { by: ctx.actor.id, at: now, byHead }, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      if (draft.playId && byHead) {
        const play = await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }, { session });
        if (play && !play.firstBatchReviewed && await headApprovals(ctx, play, session) >= Number(play.batchSize ?? 10)) await db.collection("sales_plays").updateOne({ _id: play._id }, { $set: { firstBatchReviewed: true, updatedAt: now } }, { session });
      }
      await auditSales(ctx, "sales.draft.approve", "draft", String(draft._id), String(lead.ventureId), { byHead }, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  // Mark sent records what a person sent from their own mail app or phone; nothing is sent from here in v1.
  router.post("/drafts/:id/sent", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "mark this draft sent");
    const input = draftSendInputSchema.parse(req.body ?? {}); // sentVia defaults to manual, so a bare POST is a manual send
    if (input.sentVia !== "manual") throw new AppError(503, "INTEGRATION_UNAVAILABLE", "Sending from the app is not switched on yet: send it from your own mail app or phone, then mark it sent");
    const sentHash = payloadHash({ draftId: String(draft._id), sentVia: input.sentVia });
    const result = async () => {
      const activity = await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, draftId: String(draft._id), direction: "out" });
      return { draft: await reload(ctx, draft._id), activity: present(activity!), lead: leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!) };
    };
    // The same requestId repeats the first answer (a different draft or content under the same id is refused).
    const replay = async () => {
      if (!input.requestId) return false;
      const prior = await db.collection("sales_activities").findOne({ workspaceId: ctx.workspaceId, leadId: String(lead._id), requestId: input.requestId });
      if (!prior) return false;
      if (prior.draftId !== String(draft._id) || (prior.payloadHash && prior.payloadHash !== sentHash)) throw new AppError(409, "CONFLICT", "That requestId was already used for something else: use a new requestId");
      res.json(ok(await result()));
      return true;
    };
    if (draft.status === "sent" && await replay()) return;
    const play = draft.playId ? await db.collection("sales_plays").findOne({ _id: draft.playId, workspaceId: ctx.workspaceId }) : null;
    const settings = await settingsFor(ctx, String(lead.ventureId));
    const blocker = sendBlocker(draft, lead, play, settings);
    if (blocker) throw new AppError(409, "CONFLICT", blocker);
    const now = new Date();
    const channel = channelOf(draft);
    const at = input.at ? new Date(input.at) : now;
    let activity: AppDocument;
    let release: (() => Promise<void>) | undefined;
    try {
      activity = await atomic(database, async (session) => {
        // A retried transaction gives back the send it took on the first try.
        await release?.();
        release = undefined;
        // Claim the draft first: only one request moves it from ready to sent, so a repeated or parallel call never writes a second activity.
        const claimed = await db.collection("sales_drafts").findOneAndUpdate({ _id: draft._id, status: "ready" }, { $set: { status: "sent", sentAt: at, sentBy: ctx.actor.id, sentVia: "manual", updatedAt: now } }, { session, returnDocument: "before" });
        if (!claimed) throw new AppError(409, "CONFLICT", "This draft was already marked sent, or changed: reload it");
        try {
          // Then one of the day's sends (the venture's daily cap per person and channel, counted per local day in one atomic update):
          // refused when the cap is used up, and given back below if marking it sent fails. A message marked sent for an earlier day
          // (`at`) is not one of today's sends.
          if (isCappedChannel(channel) && at.getTime() >= startOfLocalDay(now, settings.timezone).getTime()) release = await claimSendSlot(ctx, String(lead.ventureId), channel, now);
          const fresh = await loadLead(ctx, String(lead._id), session);
          const nowBlocked = sendBlocker(claimed, fresh, play, settings);
          if (nowBlocked) throw new AppError(409, "CONFLICT", nowBlocked);
          const subject = draft.subject ? `Subject: ${draft.subject}\n\n` : "";
          const logged = await applyActivity(ctx, fresh, { kind: draft.channel as "email" | "whatsapp" | "linkedin", direction: "out", body: `${subject}${draft.body}`.slice(0, 10_000), at: at.toISOString(), draftId: String(draft._id), ...(input.requestId ? { requestId: input.requestId } : {}) }, now, session, ctx.via, { payloadHash: sentHash, sendClaimed: true });
          // Answering a reply clears it from the Inbox.
          if (draft.inReplyTo) {
            const replied = await db.collection("sales_activities").findOne({ _id: String(draft.inReplyTo), workspaceId: ctx.workspaceId }, { session });
            if (replied && !replied.handledAt) await markHandled(ctx, await loadLead(ctx, String(lead._id), session), replied, now, session);
          }
          await auditSales(ctx, "sales.draft.sent", "draft", String(draft._id), String(lead.ventureId), { channel: String(draft.channel), sentVia: "manual", ...(logged.stageTo ? { stageTo: logged.stageTo } : {}) }, session);
          return logged.activity;
        } catch (error) {
          // Without transactions (local development) the claim is already stored: give the draft back so it can be sent again.
          if (!session) await db.collection("sales_drafts").updateOne({ _id: draft._id, status: "sent", sentBy: ctx.actor.id, sentAt: at }, { $set: { status: "ready", updatedAt: now }, $unset: { sentAt: "", sentBy: "", sentVia: "" } }).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      // Nothing was marked sent: the day's send goes back to the counter.
      await release?.();
      // A parallel call with the same requestId that lost the claim gets the first call's answer.
      if (input.requestId && ((error as { code?: number }).code === 11000 || (error instanceof AppError && error.status === 409)) && await replay()) return;
      throw error;
    }
    res.status(201).json(ok({ draft: await reload(ctx, draft._id), activity: present(activity), lead: leadJson((await db.collection("opportunities").findOne({ _id: lead._id }))!) }));
  });

  router.post("/drafts/:id/veto", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(ctx, idSchema.parse(req.params.id));
    requireWriter(ctx.actor, lead.ventureId, "veto drafts");
    const input = draftVetoInputSchema.parse(req.body);
    if (!isOpenDraft(draft)) throw new AppError(409, "CONFLICT", `A ${draft.status} draft can no longer be vetoed`);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: { $in: ["draft", "in_review", "ready", "needs_changes"] } }, { $set: { status: "vetoed", veto: { reason: input.reason, by: ctx.actor.id, at: now }, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      await auditSales(ctx, "sales.draft.veto", "draft", String(draft._id), String(lead.ventureId), undefined, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  router.post("/drafts/:id/discard", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { draft, lead } = await loadDraft(ctx, idSchema.parse(req.params.id));
    requireWriter(ctx.actor, lead.ventureId, "discard drafts");
    if (!isHeadOf(ctx.actor, lead.ventureId) && lead.ownerId !== ctx.actor.id && draft.authorId !== ctx.actor.id) throw forbidden("Only the lead's owner, the draft's author or a venture head can discard this draft");
    if (!isOpenDraft(draft)) throw new AppError(409, "CONFLICT", `A ${draft.status} draft can no longer be discarded`);
    const now = new Date();
    await atomic(database, async (session) => {
      const changed = await db.collection("sales_drafts").updateOne({ _id: draft._id, status: { $in: ["draft", "in_review", "ready", "needs_changes"] } }, { $set: { status: "discarded", discardedAt: now, discardedBy: ctx.actor.id, updatedAt: now } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This draft changed: reload it and try again");
      await auditSales(ctx, "sales.draft.discard", "draft", String(draft._id), String(lead.ventureId), undefined, session);
    });
    res.json(ok(await reload(ctx, draft._id)));
  });

  return router;
}
