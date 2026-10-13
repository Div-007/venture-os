import { Router } from "express";
import { celebrationPauseSchema, celebrationSeenSchema } from "@venture-studio/contracts";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";
import { jsonValue } from "../json.js";
import { celebrationFeed, celebrationSettingsId } from "../celebrations.js";

const HOUR = 3_600_000;

/** Each person's own celebrations: what's waiting, marking them seen, and pausing them for a while. */
export function celebrationRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();

  router.get("/celebrations", async (req, res) => {
    res.json({ ok: true, data: jsonValue(await celebrationFeed(db, req.actor!, config.LEADERBOARD_TIME_ZONE)) });
  });

  router.post("/celebrations/seen", async (req, res) => {
    const actor = req.actor!;
    const { ids } = celebrationSeenSchema.parse(req.body);
    const result = await db.collection("celebrations").updateMany({ _id: { $in: ids }, workspaceId: actor.membership.workspaceId, userId: actor.id, state: "pending" }, { $set: { state: "seen", seenAt: new Date() } });
    res.json({ ok: true, data: { updated: result.modifiedCount } });
  });

  // A pause means nothing shows up for that time: what's waiting now is skipped too, and so is anything finished meanwhile.
  router.put("/celebrations/pause", async (req, res) => {
    const actor = req.actor!;
    const { hours } = celebrationPauseSchema.parse(req.body);
    const workspaceId = actor.membership.workspaceId;
    const now = new Date();
    const pausedUntil = hours ? new Date(now.getTime() + hours * HOUR) : undefined;
    await db.collection("celebration_settings").updateOne(
      { _id: celebrationSettingsId(workspaceId, actor.id) },
      pausedUntil ? { $set: { workspaceId, userId: actor.id, pausedUntil, updatedAt: now } } : { $set: { workspaceId, userId: actor.id, updatedAt: now }, $unset: { pausedUntil: "" } },
      { upsert: true },
    );
    if (pausedUntil) await db.collection("celebrations").updateMany({ workspaceId, userId: actor.id, state: "pending" }, { $set: { state: "skipped", updatedAt: now } });
    res.json({ ok: true, data: { pausedUntil: pausedUntil?.toISOString() ?? null } });
  });

  return router;
}
