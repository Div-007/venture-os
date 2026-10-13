import type { Filter } from "mongodb";
import { readableSensitivities, sharesKnowledge } from "@venture-studio/core";
import type { AppDocument } from "./db.js";
import { inArchivedVenture, notArchived } from "./archive-scope.js";

type Actor = NonNullable<Express.Request["actor"]>;

/** The knowledge documents this member may read, optionally within one venture (workspace-wide documents included). */
export function authorizedDocumentFilter(actor: Actor, ventureId?: string): Filter<AppDocument> {
  const sensitivities = readableSensitivities(actor.membership.role);
  const ventures = actor.membership.role === "admin" ? (ventureId ? (inArchivedVenture(actor.membership, ventureId) ? [] : [ventureId]) : undefined) : ventureId ? (actor.membership.ventureIds.includes(ventureId) ? [ventureId] : []) : actor.membership.ventureIds;
  // A request to share with all ventures stays hidden from everyone but its author and the approvers until approved.
  const requests = sharesKnowledge(actor.membership) ? {} : { $and: [{ $or: [{ review: { $exists: false } }, { ownerId: actor.id }] }] };
  return { workspaceId: actor.membership.workspaceId, sensitivity: { $in: sensitivities }, status: { $ne: "archived" }, ...(ventures ? { $or: [{ ventureId: null }, { ventureId: { $in: ventures } }] } : notArchived(actor.membership)), ...requests };
}
