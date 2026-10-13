import type { Membership } from "@venture-studio/contracts";
import type { AppDb } from "./db.js";

/** The archived ventures of a workspace and the groups inside them. */
export async function archivedScope(db: AppDb, workspaceId: string): Promise<{ ventureIds: string[]; groupIds: string[] }> {
  const ventures = await db.collection("ventures").find({ workspaceId, status: "archived" }, { projection: { _id: 1 } }).toArray();
  if (!ventures.length) return { ventureIds: [], groupIds: [] };
  const ventureIds = ventures.map((venture) => String(venture._id));
  const groups = await db.collection("groups").find({ workspaceId, ventureId: { $in: ventureIds } }, { projection: { _id: 1 } }).toArray();
  return { ventureIds, groupIds: groups.map((group) => String(group._id)) };
}

/**
 * Removes archived ventures (and their groups) from a membership for this request and records them, so every
 * membership-scoped read hides them and `can` refuses writes into them. Nothing here is written back to the database.
 */
export async function withArchiveScope(db: AppDb, membership: Membership): Promise<Membership> {
  const archived = await archivedScope(db, membership.workspaceId);
  if (!archived.ventureIds.length) return membership;
  return {
    ...membership,
    ventureIds: membership.ventureIds.filter((id) => !archived.ventureIds.includes(id)),
    groupIds: membership.groupIds.filter((id) => !archived.groupIds.includes(id)),
    archivedVentureIds: archived.ventureIds,
    archivedGroupIds: archived.groupIds,
  };
}

/** Mongo filter that drops records of archived ventures; for admin queries that are otherwise workspace-wide. Records without a ventureId still match. */
export function notArchived(membership: Pick<Membership, "archivedVentureIds">, field = "ventureId"): Record<string, unknown> {
  return membership.archivedVentureIds?.length ? { [field]: { $nin: membership.archivedVentureIds } } : {};
}

/** Same for records scoped by group (channels, messages). */
export function notArchivedGroup(membership: Pick<Membership, "archivedGroupIds">, field = "groupId"): Record<string, unknown> {
  return membership.archivedGroupIds?.length ? { [field]: { $nin: membership.archivedGroupIds } } : {};
}

/** Whether a record's venture is archived for this request; such records read as not found until the venture is restored. */
export function inArchivedVenture(membership: Pick<Membership, "archivedVentureIds">, ventureId: unknown): boolean {
  return typeof ventureId === "string" && Boolean(membership.archivedVentureIds?.includes(ventureId));
}
