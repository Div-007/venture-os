import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { AppDb } from "../db.js";
import { idSchema, patCreateSchema } from "@venture-studio/contracts";
import { createPat } from "@venture-studio/core";
import type { AppConfig } from "../config.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";

// Personal access tokens for hosted MCP (Claude Code and similar clients). Each belongs to one person and one membership.
const MAX_ACTIVE_TOKENS = 20;

const publicPat = (pat: Record<string, unknown>) => ({ id: pat._id, name: pat.name, prefix: pat.prefix, scopes: pat.scopes, createdAt: pat.createdAt, expiresAt: pat.expiresAt, lastUsedAt: pat.lastUsedAt, revokedAt: pat.revokedAt });

export function patRoutes(db: AppDb, config: AppConfig): Router {
  const router = Router();
  router.get("/pats", async (req, res) => {
    const actor = req.actor!;
    const items = await db.collection("pats").find({ workspaceId: actor.membership.workspaceId, userId: actor.id }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ ok: true, data: jsonValue(items.map(publicPat)) });
  });
  router.post("/pats", async (req, res) => {
    if (!config.MCP_ENABLED) throw new AppError(403, "FORBIDDEN", "Claude connections are turned off for this workspace");
    const input = patCreateSchema.parse(req.body);
    const actor = req.actor!;
    const now = new Date();
    const active = await db.collection("pats").countDocuments({ workspaceId: actor.membership.workspaceId, userId: actor.id, revokedAt: { $exists: false }, expiresAt: { $gt: now } });
    if (active >= MAX_ACTIVE_TOKENS) throw new AppError(409, "CONFLICT", `You already have ${MAX_ACTIVE_TOKENS} active tokens; revoke one first`);
    const generated = createPat();
    const pat = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: actor.id, membershipId: actor.membership.id, name: input.name, prefix: generated.prefix, tokenHash: generated.hash, scopes: [...new Set(input.scopes)], createdAt: now, expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000) };
    await db.collection("pats").insertOne(pat);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "pat.create", objectType: "pat", objectId: String(pat._id), result: "success", metadata: { scopeCount: pat.scopes.length, expiresInDays: input.expiresInDays } });
    res.status(201).json({ ok: true, data: { pat: jsonValue(publicPat(pat)), token: generated.token } });
  });
  router.post("/pats/:id/revoke", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const result = await db.collection("pats").updateOne({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "Token not found or already revoked");
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "pat.revoke", objectType: "pat", objectId: id, result: "success" });
    res.json({ ok: true, data: { revoked: true } });
  });
  return router;
}
