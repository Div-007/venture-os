// Authentication of the office PC engine: a personal access token with the `sales:engine` scope, and nothing else. Sessions,
// the local dev header and the MCP loopback are never consulted, so those can't reach the engine routes (and the MCP allowlist
// has no engine route). The token resolves to its owner's membership the way the hosted MCP grant does.
import type { NextFunction, Request, Response } from "express";
import { hashPat } from "@venture-studio/core";
import type { AppDb } from "../db.js";
import { AppError } from "../errors.js";
import { actorFor, overLimit, rateLimitAddress } from "../middleware.js";

/** Requests per minute per token (a worker posts a batch of 50 leads and a heartbeat every few seconds at most). */
export const ENGINE_REQUESTS_PER_MINUTE = 240;
const ANONYMOUS_PER_MINUTE = 30;
const LAST_USED_EVERY_MS = 5 * 60_000;

type Grant = { patId: string; membershipId: string; user: { id: string; email: string; name: string }; scopes: Set<string> };

/** The token's grant, or undefined when it is unknown, revoked, expired, or its membership or person is no longer active. */
async function resolveToken(db: AppDb, token: string): Promise<Grant | undefined> {
  const now = new Date();
  const pat = await db.collection("pats").findOne({ tokenHash: hashPat(token), revokedAt: { $exists: false }, expiresAt: { $gt: now }, membershipId: { $exists: true } });
  if (!pat) return undefined;
  const membership = await db.collection("memberships").findOne({ _id: pat.membershipId, workspaceId: pat.workspaceId, userId: pat.userId, status: "active" }, { projection: { _id: 1 } });
  const user = membership ? await db.collection("users").findOne({ _id: pat.userId, status: "active" }, { projection: { email: 1, name: 1 } }) : null;
  if (!membership || !user) return undefined;
  if (!pat.lastUsedAt || now.getTime() - new Date(pat.lastUsedAt).getTime() > LAST_USED_EVERY_MS) await db.collection("pats").updateOne({ _id: pat._id }, { $set: { lastUsedAt: now } });
  return { patId: String(pat._id), membershipId: String(pat.membershipId), user: { id: String(pat.userId), email: String(user.email), name: String(user.name) }, scopes: new Set(pat.scopes as string[]) };
}

/**
 * Express middleware for /v1/sales/engine: Bearer token only (401 when missing, wrong, revoked or expired; 403 without the
 * sales:engine and sales:read scopes; 429 over the per-token limit). Sets `req.actor` to the token owner (with archived ventures
 * removed), `req.interfaceChannel = "engine"` for the audit log, and `res.locals.enginePatId` for run ownership.
 */
export function requireEngineToken(db: AppDb) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.interfaceChannel = "engine";
      const match = /^bearer\s+(vso_[A-Za-z0-9_-]{20,200})$/i.exec(req.headers.authorization ?? "");
      const grant = match ? await resolveToken(db, match[1]!) : undefined;
      if (!grant) {
        const wait = await overLimit(db, `engine-anon:${req.ip ? rateLimitAddress(req.ip) : "unknown"}`, ANONYMOUS_PER_MINUTE);
        if (wait) { res.setHeader("retry-after", String(wait)); throw new AppError(429, "RATE_LIMITED", "Too many requests"); }
        res.setHeader("www-authenticate", 'Bearer realm="venture-studio-engine", error="invalid_token"');
        throw new AppError(401, "UNAUTHENTICATED", "Send the engine's personal access token as a Bearer token (it may be missing, revoked or expired)");
      }
      const actor = await actorFor(db, grant.user);
      if (!actor || actor.membership.id !== grant.membershipId) throw new AppError(401, "UNAUTHENTICATED", "This token's owner is no longer an active member");
      req.actor = actor;
      if (!grant.scopes.has("sales:engine") || !grant.scopes.has("sales:read")) throw new AppError(403, "FORBIDDEN", "This token needs the sales:engine and sales:read scopes");
      const wait = await overLimit(db, `engine:${grant.patId}`, ENGINE_REQUESTS_PER_MINUTE);
      if (wait) { res.setHeader("retry-after", String(wait)); throw new AppError(429, "RATE_LIMITED", "Too many requests from this token; slow down"); }
      res.locals.enginePatId = grant.patId;
      next();
    } catch (error) { next(error); }
  };
}
