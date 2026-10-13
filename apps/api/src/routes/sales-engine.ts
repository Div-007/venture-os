import { Router } from "express";
import { z } from "zod";
import { engineClaimInputSchema, engineFinishInputSchema, engineHeartbeatInputSchema, engineLeadsInputSchema, idSchema } from "@venture-studio/contracts";
import { atomic, type AppDocument, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { ventureScope } from "../sales/access.js";
import { auditSales, salesCtx } from "../sales/ctx.js";
import { STALE_CLAIM_MS, enrichEngineLead, enrichTargets, firstActivePipeline, ingestEngineLead, loadRun, runConflict, type EngineSkip } from "../sales/engine.js";
import { requireEngineToken } from "../sales/engine-auth.js";
import { present } from "../sales/present.js";
import { loadLead, requireLeadEditor } from "../sales/leads.js";
import { randomUUID } from "node:crypto";

const listQuerySchema = z.object({ status: z.enum(["queued", "running"]).default("queued"), limit: z.coerce.number().int().min(1).max(100).default(50) });
const ok = (data: unknown) => ({ ok: true, data });

/**
 * The office PC engine bridge (docs/sales-dealflow.md section 10), mounted at /v1/sales/engine before the session gate. Every route
 * needs a Bearer token with the sales:engine scope; the worker holding a run is identified by its token (and its workerId, when sent).
 */
export function salesEngineRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  const runs = db.collection("sales_find_runs");
  router.use(requireEngineToken(db));
  const patId = (res: { locals: Record<string, unknown> }) => String(res.locals.enginePatId);
  /** The run as the worker sees it: an enrich run also carries the leads to look up (`targets`). */
  const shown = async (ctx: ReturnType<typeof salesCtx>, run: AppDocument) => ({ ...present(run), ...(run.kind === "enrich" ? { targets: await enrichTargets(ctx, run) } : {}) });

  // Queued runs (or running ones, to resume) in ventures the token's owner can work, oldest first.
  router.get("/runs", async (req, res) => {
    const ctx = salesCtx(database, req);
    const query = listQuerySchema.parse(req.query);
    const scope = ventureScope(ctx.actor, undefined);
    const role = ctx.actor.membership.role;
    // Heads and admins work every run of their ventures; contributors and reviewers the runs they planned; learners none.
    const who = role === "admin" || role === "venture_head" ? {} : role === "learner" ? { _id: { $in: [] } } : { createdBy: ctx.actor.id };
    const rows = scope ? await runs.find({ workspaceId: ctx.workspaceId, status: query.status, ...scope, ...who }).sort({ createdAt: 1, _id: 1 }).limit(query.limit).toArray() : [];
    res.json(ok(await Promise.all(rows.map((row) => shown(ctx, row)))));
  });

  // Takes a queued run (atomic). The same worker may claim again; another worker's claim is 409 until 15 minutes pass without a heartbeat.
  router.post("/runs/:id/claim", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { workerId } = engineClaimInputSchema.parse(req.body);
    const run = await loadRun(ctx, idSchema.parse(req.params.id));
    const now = new Date();
    const stale = new Date(now.getTime() - STALE_CLAIM_MS);
    const before = await runs.findOneAndUpdate(
      { _id: run._id, workspaceId: ctx.workspaceId, $or: [{ status: "queued" }, { status: "running", claimedBy: patId(res), workerId }, { status: "running", heartbeatAt: { $lt: stale } }, { status: "running", heartbeatAt: null }] },
      { $set: { status: "running", workerId, claimedBy: patId(res), claimedAt: now, heartbeatAt: now, updatedAt: now } }, { returnDocument: "before" });
    if (!before) {
      const current = await runs.findOne({ _id: run._id });
      throw current?.status === "running" ? new AppError(409, "CONFLICT", `Another worker (${String(current.workerId)}) holds this run; it can be taken over after 15 minutes without a heartbeat`) : current?.status === "queued" ? new AppError(409, "CONFLICT", "This run changed: try again") : new AppError(409, "CONFLICT", `This run is ${String(current?.status)}, not queued`);
    }
    const takeover = before.status === "running" && (before.claimedBy !== patId(res) || before.workerId !== workerId);
    await auditSales(ctx, "sales.engine.claim", "find_run", String(run._id), String(run.ventureId), { workerId, takeover, ...(takeover ? { previousWorker: String(before.workerId ?? "") } : {}) });
    res.json(ok(await shown(ctx, (await runs.findOne({ _id: run._id }))!)));
  });

  /** The run, if this token's worker holds it (409 with the reason otherwise). */
  async function held(ctx: ReturnType<typeof salesCtx>, id: string, token: string, workerId?: string): Promise<AppDocument> {
    const run = await loadRun(ctx, id);
    if (run.status !== "running" || run.claimedBy !== token || (workerId && run.workerId !== workerId)) throw runConflict(run, token, workerId);
    return run;
  }

  // Progress and a note; also what keeps the claim alive. A 409 means the run is no longer this worker's (cancelled, finished or taken over): stop.
  router.post("/runs/:id/heartbeat", async (req, res) => {
    const ctx = salesCtx(database, req);
    const input = engineHeartbeatInputSchema.parse(req.body);
    const id = idSchema.parse(req.params.id);
    const run = await held(ctx, id, patId(res), input.workerId);
    const now = new Date();
    const changed = await runs.updateOne({ _id: run._id, status: "running", claimedBy: patId(res) }, { $set: { progress: input.progress, ...(input.note !== undefined ? { note: input.note } : {}), heartbeatAt: now, updatedAt: now } });
    if (!changed.matchedCount) throw runConflict(await runs.findOne({ _id: run._id }), patId(res), input.workerId);
    await auditSales(ctx, "sales.engine.heartbeat", "find_run", String(run._id), String(run.ventureId), { found: input.progress.found, crawled: input.progress.crawled, added: input.progress.added });
    res.json(ok({ id: String(run._id), status: "running", heartbeatAt: now.toISOString() }));
  });

  // Up to 50 leads: each is checked on its own and answered as added or skipped (duplicate, do_not_contact or invalid).
  router.post("/runs/:id/leads", async (req, res) => {
    const ctx = salesCtx(database, req);
    const input = engineLeadsInputSchema.parse(req.body);
    const run = await held(ctx, idSchema.parse(req.params.id), patId(res), input.workerId);
    if (run.kind === "enrich") {
      // An enrich run updates the leads it names; nothing is created.
      const updated: Extract<Awaited<ReturnType<typeof enrichEngineLead>>, { updated: unknown }>["updated"][] = [];
      const skippedLeads: EngineSkip[] = [];
      for (const raw of input.leads) {
        const outcome = await enrichEngineLead(ctx, run, raw);
        if ("updated" in outcome) updated.push(outcome.updated); else skippedLeads.push(outcome.skipped);
      }
      const at = new Date();
      await runs.updateOne({ _id: run._id, status: "running", claimedBy: patId(res) }, { $set: { heartbeatAt: at, updatedAt: at } });
      await auditSales(ctx, "sales.engine.enrich", "find_run", String(run._id), String(run.ventureId), { received: input.leads.length, updated: updated.length, routesAdded: updated.reduce((sum, item) => sum + item.routesAdded, 0), skipped: skippedLeads.length });
      res.json(ok({ added: [], updated, skipped: skippedLeads }));
      return;
    }
    const pipeline = await firstActivePipeline(ctx, String(run.ventureId));
    if (!pipeline) throw new AppError(409, "CONFLICT", "This venture has no active pipeline for the leads: a venture head creates one first");
    const added: { id: string; companyName: string }[] = [];
    const skipped: EngineSkip[] = [];
    for (const raw of input.leads) {
      const outcome = await ingestEngineLead(ctx, run, String(pipeline._id), raw);
      if ("added" in outcome) added.push(outcome.added); else skipped.push(outcome.skipped);
    }
    const now = new Date();
    await atomic(database, async (session) => {
      await runs.updateOne({ _id: run._id, status: "running", claimedBy: patId(res) }, { $set: { heartbeatAt: now, updatedAt: now } }, { session });
      await auditSales(ctx, "sales.engine.leads", "find_run", String(run._id), String(run.ventureId), {
        received: input.leads.length, added: added.length, duplicates: skipped.filter((item) => item.reason === "duplicate").length, doNotContact: skipped.filter((item) => item.reason === "do_not_contact").length, invalid: skipped.filter((item) => item.reason === "invalid").length,
      }, session);
    });
    res.json(ok({ added, skipped }));
  });

  // Ends the run (done or failed) with its totals. Only the worker that holds it; finishing again with the same status repeats the answer.
  router.post("/runs/:id/finish", async (req, res) => {
    const ctx = salesCtx(database, req);
    const input = engineFinishInputSchema.parse(req.body);
    const id = idSchema.parse(req.params.id);
    const run = await loadRun(ctx, id);
    if ((run.status === "done" || run.status === "failed") && run.status === input.status && run.claimedBy === patId(res) && (!input.workerId || run.workerId === input.workerId)) { res.json(ok(present(run))); return; }
    if (run.status !== "running" || run.claimedBy !== patId(res) || (input.workerId && run.workerId !== input.workerId)) throw runConflict(run, patId(res), input.workerId);
    const now = new Date();
    const changed = await runs.updateOne({ _id: run._id, status: "running", claimedBy: patId(res) }, { $set: { status: input.status, results: input.results, finishedAt: now, heartbeatAt: now, updatedAt: now } });
    if (!changed.matchedCount) throw runConflict(await runs.findOne({ _id: run._id }), patId(res), input.workerId);
    await auditSales(ctx, "sales.engine.finish", "find_run", String(run._id), String(run.ventureId), { status: input.status, found: input.results.found, added: input.results.added, skipped: input.results.skipped });
    res.json(ok(present((await runs.findOne({ _id: run._id }))!)));
  });

  return router;
}

/**
 * Asks the office PC engine to fill in the contact details of one lead: POST /v1/sales/leads/:id/enrich (a person, or Claude as the token owner).
 * The lead joins the person's queued enrich run in its venture (made on the first request, up to 100 leads); the run is returned.
 */
export function salesEnrichRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  router.post("/leads/:id/enrich", async (req, res) => {
    const ctx = salesCtx(database, req);
    const lead = await loadLead(ctx, idSchema.parse(req.params.id));
    requireLeadEditor(ctx, lead, "ask for this lead to be enriched");
    if (lead.doNotContact) throw new AppError(409, "CONFLICT", "This lead is on the do-not-contact list: nobody looks for its contact details");
    const runs = db.collection("sales_find_runs");
    const now = new Date();
    const leadId = String(lead._id);
    let created = false;
    let run: AppDocument | null = null;
    await atomic(database, async (session) => {
      created = false;
      const open = await runs.findOne({ workspaceId: ctx.workspaceId, ventureId: lead.ventureId, kind: "enrich", status: "queued", createdBy: ctx.actor.id, "leadIds.99": { $exists: false } }, { sort: { createdAt: 1, _id: 1 }, session });
      // Join it with one conditional update: the lead is added to the set only while the run is still queued and holds fewer than 100 leads,
      // so parallel requests never overwrite each other's leads. A run that filled up or was claimed meanwhile means a new run.
      const joined = open ? await runs.updateOne({ _id: open._id, status: "queued", "leadIds.99": { $exists: false } }, { $addToSet: { leadIds: leadId }, $set: { updatedAt: now } }, { session }) : undefined;
      if (open && joined?.matchedCount) {
        // The request line follows the number of leads the run now holds.
        await runs.updateOne({ _id: open._id }, [{ $set: { request: { $concat: ["Find contact details for ", { $toString: { $size: "$leadIds" } }, { $cond: [{ $gt: [{ $size: "$leadIds" }, 1] }, " leads", " lead"] }] } } }], { session });
        run = (await runs.findOne({ _id: open._id }, { session }))!;
      } else {
        created = true;
        const doc = { _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: lead.ventureId, kind: "enrich", leadIds: [leadId], request: "Find contact details for 1 lead", plan: { places: [], categories: [], searches: [], limit: 50 }, status: "queued", createdBy: ctx.actor.id, createdVia: ctx.via, createdAt: now, updatedAt: now };
        await runs.insertOne(doc, { session });
        run = doc;
      }
      await auditSales(ctx, "sales.lead.enrich", "find_run", String(run!._id), String(lead.ventureId), { leadId, created }, session);
    });
    res.status(created ? 201 : 200).json(ok(present(run!)));
  });
  return router;
}
