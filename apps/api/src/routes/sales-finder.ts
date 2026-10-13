import { Router } from "express";
import { finderStatusSchema } from "@venture-studio/contracts";
import type { AppConfig } from "../config.js";
import type { AppDocument, Database } from "../db.js";
import { ventureScope } from "../sales/access.js";
import { salesCtx } from "../sales/ctx.js";
import { FINDER_WORKER, finderEnabled } from "../sales/finder/runner.js";
import { resolveSearchKeys } from "../sales/search-keys.js";

const ok = (data: unknown) => ({ ok: true, data });
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" ? value : new Date(0).toISOString();
const count = (value: unknown) => Number.isInteger(value) ? Number(value) : 0;
const kindOf = (run: AppDocument) => run.kind === "enrich" ? "enrich" as const : "find" as const;

/**
 * The built-in lead finder as the Find leads screen shows it: GET /sales/finder/status, for anyone who can read Sales. Whether it is on in
 * this API, whether company search can run (a TinyFish or Exa key is set: only which engines, never a key), the run it is working on and
 * how its last run ended (in the ventures the reader can open).
 */
export function salesFinderRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();
  router.get("/finder/status", async (req, res) => {
    const ctx = salesCtx(database, req);
    const keys = await resolveSearchKeys(db, ctx.workspaceId, config);
    const engines = [...(keys.tinyfishKey ? ["tinyfish" as const] : []), ...(keys.exaKey ? ["exa" as const] : [])];
    const scope = ventureScope(ctx.actor, undefined);
    const runs = db.collection("sales_find_runs");
    const [running, last] = scope ? await Promise.all([
      runs.findOne({ workspaceId: ctx.workspaceId, ...scope, status: "running", claimedBy: FINDER_WORKER }, { sort: { claimedAt: -1, _id: 1 } }),
      runs.findOne({ workspaceId: ctx.workspaceId, ...scope, status: { $in: ["done", "failed"] }, claimedBy: FINDER_WORKER }, { sort: { finishedAt: -1, _id: 1 } }),
    ]) : [null, null];
    res.json(ok(finderStatusSchema.parse({
      builtIn: {
        on: finderEnabled(config), searchReady: engines.length > 0, engines,
        ...(running ? { running: { runId: String(running._id), ventureId: String(running.ventureId), kind: kindOf(running), request: String(running.request ?? ""), startedAt: iso(running.claimedAt), ...(typeof running.note === "string" && running.note ? { note: running.note } : {}), ...(running.progress ? { progress: { found: count(running.progress.found), crawled: count(running.progress.crawled), added: count(running.progress.added) } } : {}) } } : {}),
        ...(last ? { lastRun: { runId: String(last._id), ventureId: String(last.ventureId), kind: kindOf(last), request: String(last.request ?? ""), status: last.status, finishedAt: iso(last.finishedAt ?? last.updatedAt), found: count(last.results?.found), added: count(last.results?.added), skipped: count(last.results?.skipped), ...(typeof last.results?.note === "string" && last.results.note ? { note: last.results.note } : {}) } } : {}),
      },
    })));
  });
  return router;
}
