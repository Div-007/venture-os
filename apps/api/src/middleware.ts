import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { AppDb } from "./db.js";
import { membershipSchema, type Membership } from "@venture-studio/contracts";
import { can, type Action } from "@venture-studio/core";
import type { AppConfig } from "./config.js";
import type { Auth } from "./auth.js";
import { AppError } from "./errors.js";
import { audit } from "./audit.js";
import { withArchiveScope } from "./archive-scope.js";
import { internalUserId } from "./internal-auth.js";

type Actor = { id: string; email: string; name: string; membership: Membership };

function membershipValue(document: Record<string, unknown>): Membership {
  return membershipSchema.parse({ ...document, id: document._id, createdAt: (document.createdAt as Date).toISOString(), updatedAt: (document.updatedAt as Date).toISOString() });
}

export function createActorResolver(auth: Auth, db: AppDb, config: AppConfig) {
  const resolveIdentity = createIdentityResolver(auth, db, config);
  return async (headers: IncomingHttpHeaders): Promise<Actor | undefined> => {
    const user = await resolveIdentity(headers);
    return user ? actorFor(db, user) : undefined;
  };
}

/** A person's actor (their one active membership, with archived ventures marked), or undefined without exactly one. */
export async function actorFor(db: AppDb, user: { id: string; email: string; name: string }): Promise<Actor | undefined> {
  const memberships = await db.collection("memberships").find({ userId: user.id, status: "active" }).limit(2).toArray();
  if (memberships.length !== 1) return undefined;
  return { ...user, membership: await withArchiveScope(db, membershipValue(memberships[0]!)) };
}

export function createIdentityResolver(auth: Auth, db: AppDb, config: AppConfig) {
  return async (headers: IncomingHttpHeaders): Promise<{ id: string; email: string; name: string } | undefined> => {
    // A hosted MCP tool calling the API as the token's owner (see internal-auth.ts); the MCP layer already checked the token.
    const internalId = internalUserId(headers);
    if (internalId) {
      const owner = await db.collection("users").findOne({ _id: internalId, status: "active" });
      return owner ? { id: internalId, email: String(owner.email), name: String(owner.name) } : undefined;
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    let user = session?.user;
    if (!user && config.ALLOW_DEV_AUTH && config.APP_MODE === "local") {
      const id = headers["x-dev-user-id"];
      if (typeof id === "string") {
        const seeded = await db.collection("users").findOne({ _id: id, status: "active" });
        if (seeded) user = { id, email: String(seeded.email), name: String(seeded.name), emailVerified: true, createdAt: new Date(), updatedAt: new Date(), image: null };
      }
    }
    if (!user) return undefined;
    return { id: user.id, email: user.email, name: user.name };
  };
}

export function requireIdentity(resolveIdentity: ReturnType<typeof createIdentityResolver>) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const identity = await resolveIdentity(req.headers);
      if (!identity) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
      req.identity = identity;
      next();
    } catch (error) { next(error); }
  };
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.id = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 100) : randomUUID();
  req.interfaceChannel = internalUserId(req.headers) ? "mcp" : "api";
  res.setHeader("x-request-id", req.id);
  const startedAt = Date.now();
  res.on("finish", () => console.info(JSON.stringify({ level: "info", requestId: req.id, method: req.method, path: req.path.replace(/\/local-objects\/[^/]+/i, "/local-objects/[redacted]").replace(/\/calendar\/feed\/[^/]+/i, "/calendar/feed/[redacted]"), status: res.statusCode, durationMs: Date.now() - startedAt })));
  next();
}

export function requireActor(resolveActor: ReturnType<typeof createActorResolver>, anonymousLimit?: ReturnType<typeof rateLimit>) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = await resolveActor(req.headers);
      if (!actor) {
        if (anonymousLimit) return anonymousLimit(req, _res, (error) => next(error ?? new AppError(401, "UNAUTHENTICATED", "Authentication required")));
        throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
      }
      req.actor = actor;
      next();
    } catch (error) { next(error); }
  };
}

export function authorize(db: AppDb, action: Action, scope: (req: Request) => { ventureId?: string; groupId?: string } = () => ({})) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const actor = req.actor;
    if (!actor) return next(new AppError(401, "UNAUTHENTICATED", "Authentication required"));
    const requestedScope = scope(req);
    if (!can(actor.membership, action, requestedScope)) {
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action, objectType: "scope", ventureId: requestedScope.ventureId, result: "denied" });
      return next(new AppError(403, "FORBIDDEN", "You do not have access to this resource"));
    }
    next();
  };
}

/** Uses a header the edge always overwrites (e.g. Cloudflare's cf-connecting-ip) as req.ip when it holds a valid address. */
export function clientAddressFromHeader(header: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const value = req.headers[header];
    const address = typeof value === "string" ? value.trim() : "";
    if (isIP(address)) Object.defineProperty(req, "ip", { value: address, configurable: true });
    next();
  };
}

/** Rate-limit key for an address: IPv4 as is (also IPv4-mapped IPv6), IPv6 by its /64 network so rotating addresses
 * inside one allocation shares a bucket (as better-auth does for sign-in). */
export function rateLimitAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  const [head = "", tail = ""] = address.toLowerCase().split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}::/64`;
}

/** Fixed-window counter in the shared rate-limit collection (adds `amount`); returns seconds to wait when over the limit. */
export async function overLimit(db: AppDb, key: string, max: number, windowMs = 60_000, amount = 1): Promise<number> {
  const now = Date.now(); const windowStart = Math.floor(now / windowMs) * windowMs;
  const entry = await db.collection("api_rate_limits").findOneAndUpdate({ _id: `${key}:${windowStart}` as never }, { $inc: { count: amount }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs), createdAt: new Date(now) } }, { upsert: true, returnDocument: "after" });
  return Number(entry?.count ?? amount) > max ? Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) : 0;
}

export function rateLimit(db: AppDb, max: number, windowMs: number, bucket = "default") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const now = Date.now();
    // Claude connections get their own per-person bucket so heavy MCP use never throttles the person's browser session.
    const mcp = req.interfaceChannel === "mcp";
    const key = `${bucket}${mcp ? "-mcp" : ""}:${req.actor?.id ?? req.identity?.id ?? (mcp ? internalUserId(req.headers) : undefined) ?? (req.ip ? rateLimitAddress(req.ip) : "unknown")}`;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    try {
      const entry = await db.collection("api_rate_limits").findOneAndUpdate(
        { _id: `${key}:${windowStart}` },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs), createdAt: new Date(now) } },
        { upsert: true, returnDocument: "after" },
      );
      const count = Number(entry?.count ?? 1);
      res.setHeader("x-ratelimit-limit", max);
      res.setHeader("x-ratelimit-remaining", Math.max(0, max - count));
      if (count > max) {
        res.setHeader("retry-after", Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)));
        return next(new AppError(429, "RATE_LIMITED", "Too many requests"));
      }
      next();
    } catch (error) { next(error); }
  };
}
