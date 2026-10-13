import { Router } from "express";
import { bulkLeadsInputSchema, idSchema, importCommitInputSchema, importInputSchema, leadListQuerySchema, savedViewInputSchema } from "@venture-studio/contracts";
import type { Database } from "../db.js";
import { salesCtx } from "../sales/ctx.js";
import { bulkLeads, commitImport, deleteView, exportLeads, listViews, previewImport, saveView } from "../sales/io.js";
import { SALES_TZ } from "../sales/workdays.js";

const ok = (data: unknown) => ({ ok: true, data });
const exportQuerySchema = leadListQuerySchema.omit({ offset: true, limit: true, totals: true });

/**
 * Lists at scale, mounted at /v1/sales BEFORE the lead routes (so "export.csv" and "bulk" are not read as lead ids). People only: none of
 * these are open to Claude's connector.
 *
 * - POST /leads/bulk: assign, tag, untag, stage, play or delete up to 500 leads named by id or by the list filters; each lead is checked like a single edit.
 * - GET /leads/export.csv: the list filters as a CSV file (business fields, at most 10,000 rows).
 * - POST /leads/import/preview and /leads/import/commit: a CSV file in, what would happen / the leads created (one commit per venture at a
 *   time: 409 while another runs; the same file again creates nothing and answers 200 with `alreadyImported`).
 * - GET/POST /views, DELETE /views/:id: the person's saved Leads filters (at most 20).
 */
export function salesIoRoutes(database: Database): Router {
  const router = Router();

  router.post("/leads/bulk", async (req, res) => {
    res.json(ok(await bulkLeads(salesCtx(database, req), bulkLeadsInputSchema.parse(req.body))));
  });

  router.get("/leads/export.csv", async (req, res) => {
    const result = await exportLeads(salesCtx(database, req), exportQuerySchema.parse(req.query));
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: SALES_TZ }).format(new Date());
    res.status(200).set({
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="leads-${day}.csv"`, "Cache-Control": "no-store",
      "X-Exported-Rows": String(result.rows), "X-Matching-Rows": String(result.matching), "Access-Control-Expose-Headers": "X-Exported-Rows, X-Matching-Rows, Content-Disposition",
    }).send(result.csv);
  });

  router.post("/leads/import/preview", async (req, res) => {
    res.json(ok(await previewImport(salesCtx(database, req), importInputSchema.parse(req.body))));
  });

  router.post("/leads/import/commit", async (req, res) => {
    const result = await commitImport(salesCtx(database, req), importCommitInputSchema.parse(req.body));
    // 200 when the same file was imported before and nothing was created again.
    res.status(result.alreadyImported ? 200 : 201).json(ok(result));
  });

  router.get("/views", async (req, res) => {
    res.json(ok(await listViews(salesCtx(database, req))));
  });

  router.post("/views", async (req, res) => {
    const { view, created } = await saveView(salesCtx(database, req), savedViewInputSchema.parse(req.body));
    res.status(created ? 201 : 200).json(ok(view));
  });

  router.delete("/views/:id", async (req, res) => {
    await deleteView(salesCtx(database, req), idSchema.parse(req.params.id));
    res.json(ok({ id: req.params.id }));
  });

  return router;
}
