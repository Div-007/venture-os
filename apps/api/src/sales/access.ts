// Who can do what in Sales, per venture (docs/sales-dealflow.md section 3), and how a request is attributed (app or Claude).
import type { Request } from "express";
import type { AppDb, AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { listedInOrAdmin } from "../assignable.js";
import { notArchived } from "../archive-scope.js";

export type Actor = NonNullable<Express.Request["actor"]>;
/** Who made a change: a person in the app, or Claude through the hosted connector (acting with the token owner's rights). */
export type Via = "app" | "claude";
export const viaOf = (req: Request): Via => (req.interfaceChannel === "mcp" ? "claude" : "app");

/** Opens the venture: workspace admins open every venture that is not archived, everyone else the ventures they belong to. */
export function canSeeVenture(actor: Actor, ventureId: unknown): boolean {
  if (typeof ventureId !== "string") return false;
  const membership = actor.membership;
  if (membership.archivedVentureIds?.includes(ventureId)) return false;
  return membership.role === "admin" || membership.ventureIds.includes(ventureId);
}

/** Admin, or the head of this venture: reassign, delete, approve plays and brain, first-batch approval, suppression removal. */
export function isHeadOf(actor: Actor, ventureId: unknown): boolean {
  return canSeeVenture(actor, ventureId) && (actor.membership.role === "admin" || actor.membership.role === "venture_head");
}

/** Everyone but learners writes in the ventures they can open: create leads, propose plays and brain items, review and veto drafts. */
export function canWriteIn(actor: Actor, ventureId: unknown): boolean {
  return canSeeVenture(actor, ventureId) && actor.membership.role !== "learner";
}

/** Edits a lead (log calls and replies, write and send drafts, override the verdict): the venture head, or a writer who owns the lead. */
export function canEditLead(actor: Actor, lead: AppDocument): boolean {
  return isHeadOf(actor, lead.ventureId) || (canWriteIn(actor, lead.ventureId) && lead.ownerId === actor.id);
}

export const forbidden = (message: string) => new AppError(403, "FORBIDDEN", message);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);

export function requireWriter(actor: Actor, ventureId: unknown, what = "change this") {
  if (!canSeeVenture(actor, ventureId)) throw notFound("Venture");
  if (!canWriteIn(actor, ventureId)) throw forbidden(`Your role in this venture is read-only: you cannot ${what}`);
}

export function requireHead(actor: Actor, ventureId: unknown, what: string) {
  if (!canSeeVenture(actor, ventureId)) throw notFound("Venture");
  if (!isHeadOf(actor, ventureId)) throw forbidden(`Only a venture head or admin can ${what}`);
}

/** Approvals are a person's decision: Claude (via the connector) is refused. */
export function forbidClaude(via: Via, what: string) {
  if (via === "claude") throw forbidden(`${what} is a person's decision in the app: Claude cannot do it`);
}

/** A Mongo filter on `ventureId` for what the actor can open, optionally narrowed to one venture; null when that venture is not theirs. */
export function ventureScope(actor: Actor, ventureId?: string, field = "ventureId"): Record<string, unknown> | null {
  if (ventureId) return canSeeVenture(actor, ventureId) ? { [field]: ventureId } : null;
  if (actor.membership.role === "admin") return notArchived(actor.membership, field);
  return { [field]: { $in: actor.membership.ventureIds } };
}

/** The venture exists in the workspace, is not archived, and the actor can open it. */
export async function loadVenture(db: AppDb, actor: Actor, ventureId: string): Promise<AppDocument> {
  const venture = await db.collection("ventures").findOne({ _id: ventureId, workspaceId: actor.membership.workspaceId, status: { $ne: "archived" } });
  if (!venture || !canSeeVenture(actor, ventureId)) throw notFound("Venture");
  return venture;
}

/** The lead owner must be an active member of the venture (or an admin, who opens every venture). */
export async function assertOwnerInVenture(db: AppDb, workspaceId: string, ownerId: string, ventureId: string, session?: import("mongodb").ClientSession): Promise<void> {
  if (!(await db.collection("memberships").findOne({ workspaceId, userId: ownerId, status: "active", ...listedInOrAdmin(ventureId) }, { session }))) throw new AppError(400, "BAD_REQUEST", "The deal owner must be an active member of this venture");
}
