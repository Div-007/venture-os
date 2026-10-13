import { Router } from "express";
import { z } from "zod";
import { idSchema, salesSettingsSchema } from "@venture-studio/contracts";
import { atomic, type Database } from "../db.js";
import { forbidClaude, loadVenture, requireHead } from "../sales/access.js";
import { auditSales, salesCtx } from "../sales/ctx.js";
import { loadSettings } from "../sales/settings.js";
import { jsonValue } from "../json.js";

const querySchema = z.object({ ventureId: idSchema });
const ok = (data: unknown) => ({ ok: true, data });

/**
 * A venture's sales settings: working days, blackout dates, follow-up and reply timing, daily caps, allowed channels, approval mode and
 * time zone. Everyone who can open the venture reads them (defaults when none are saved); a venture head or admin saves them, in the app.
 */
export function salesSettingsRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  const view = async (workspaceId: string, ventureId: string) => {
    const settings = await loadSettings(db, workspaceId, ventureId);
    const stored = await db.collection("sales_settings").findOne({ _id: ventureId, workspaceId }, { projection: { updatedAt: 1, updatedBy: 1 } });
    return jsonValue({ ventureId, ...settings, ...(stored?.updatedAt ? { updatedAt: stored.updatedAt, updatedBy: stored.updatedBy } : {}) });
  };

  router.get("/settings", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { ventureId } = querySchema.parse(req.query);
    await loadVenture(db, ctx.actor, ventureId);
    res.json(ok(await view(ctx.workspaceId, ventureId)));
  });

  // Replaces the venture's settings: whatever the body leaves out takes its default.
  router.put("/settings", async (req, res) => {
    const ctx = salesCtx(database, req);
    const { ventureId } = querySchema.parse({ ventureId: req.query.ventureId ?? (req.body as { ventureId?: unknown } | undefined)?.ventureId });
    await loadVenture(db, ctx.actor, ventureId);
    forbidClaude(ctx.via, "Changing a venture's sales settings");
    requireHead(ctx.actor, ventureId, "change the sales settings");
    const input = salesSettingsSchema.parse(req.body ?? {});
    const before = await loadSettings(db, ctx.workspaceId, ventureId);
    const changed = (Object.keys(input) as (keyof typeof input)[]).filter((key) => JSON.stringify(input[key]) !== JSON.stringify(before[key]));
    const now = new Date();
    await atomic(database, async (session) => {
      await db.collection("sales_settings").updateOne({ _id: ventureId, workspaceId: ctx.workspaceId }, { $set: { ...input, updatedAt: now, updatedBy: ctx.actor.id }, $setOnInsert: { createdAt: now } }, { upsert: true, session });
      await auditSales(ctx, "sales.settings.update", "sales_settings", ventureId, ventureId, { changed: changed.join(",") || "none", approvalMode: input.approvalMode }, session);
    });
    res.json(ok(await view(ctx.workspaceId, ventureId)));
  });

  return router;
}
