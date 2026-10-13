import { Router } from "express";
import { daybreakQuerySchema, salesReportQuerySchema } from "@venture-studio/contracts";
import type { Database } from "../db.js";
import { salesCtx } from "../sales/ctx.js";
import { buildDaybreak, buildReport } from "../sales/reports.js";

const ok = (data: unknown) => ({ ok: true, data });

/**
 * Accountability and the self-filling queue (docs/sales-reports-and-daybreak.md), mounted at /v1/sales. Both are read only and open to
 * every member of the venture (learners too); without `ventureId` they cover every venture the person can open.
 *
 * - GET /reports?ventureId&from&to&owner=me|all&tz: funnel, activity, speed, stage aging, Claude's calibration, wins and losses.
 * - GET /daybreak?ventureId&owner=me|all&tz: the morning work list (follow-ups due, stale verdicts, leads without contacts, calls,
 *   replies waiting, approvals waiting, today's sends against the caps) and a one-line summary.
 */
export function salesReportsRoutes(database: Database): Router {
  const router = Router();

  router.get("/reports", async (req, res) => {
    const query = salesReportQuerySchema.parse(req.query);
    res.json(ok(await buildReport(salesCtx(database, req), query)));
  });

  router.get("/daybreak", async (req, res) => {
    const query = daybreakQuerySchema.parse(req.query);
    res.json(ok(await buildDaybreak(salesCtx(database, req), query)));
  });

  return router;
}
