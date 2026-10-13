// What every Sales write needs: the database, who is acting, how (app or Claude), and an audit helper.
import type { ClientSession } from "mongodb";
import type { Request } from "express";
import { audit, type AuditInput } from "../audit.js";
import type { AppDb, Database } from "../db.js";
import { viaOf, type Actor, type Via } from "./access.js";
import { loadSettings, type SalesSettings } from "./settings.js";

export type SalesCtx = { database: Database; db: AppDb; actor: Actor; via: Via; channel: AuditInput["channel"]; workspaceId: string; settings: Map<string, Promise<SalesSettings>> };

export function salesCtx(database: Database, req: Request): SalesCtx {
  const actor = req.actor!;
  return { database, db: database.db, actor, via: viaOf(req), channel: req.interfaceChannel, workspaceId: actor.membership.workspaceId, settings: new Map() };
}

/** The venture's sales settings (defaults where none are saved), read once per request. */
export function settingsFor(ctx: SalesCtx, ventureId: string): Promise<SalesSettings> {
  let found = ctx.settings.get(ventureId);
  if (!found) { found = loadSettings(ctx.db, ctx.workspaceId, ventureId); ctx.settings.set(ventureId, found); }
  return found;
}

/** Records a successful Sales write in the audit log, with channel "mcp" when Claude made it. */
export function auditSales(ctx: SalesCtx, action: string, objectType: string, objectId: string, ventureId: string | undefined, metadata?: Record<string, string | number | boolean | null>, session?: ClientSession) {
  return audit(ctx.db, { workspaceId: ctx.workspaceId, actorId: ctx.actor.id, channel: ctx.channel, action, objectType, objectId, ...(ventureId ? { ventureId } : {}), result: "success", ...(metadata ? { metadata } : {}) }, session);
}
