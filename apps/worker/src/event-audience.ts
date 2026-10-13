import type { ClientSession, Db } from "mongodb";

/**
 * Of these people, the ones who can still open a calendar event: active members of its workspace who are its organiser or
 * invited (private events), or listed in its venture (and group) or admins (shared events). The API applies the same rule
 * (apps/api/src/routes/calendar.ts).
 */
export async function eventAudience(db: Db, event: Record<string, any>, userIds: string[], session?: ClientSession): Promise<Set<string>> {
  const invited = new Set([String(event.organizerId), ...((event.attendees ?? []) as { userId: string }[]).map((item) => item.userId)]);
  const candidates = [...new Set(userIds)].filter((userId) => event.visibility !== "private" || invited.has(userId));
  if (!candidates.length) return new Set();
  const listed = { ventureIds: event.ventureId, ...(event.visibility === "group" ? { groupIds: event.groupId } : {}) };
  const scope = event.visibility === "private" ? {} : { $or: [listed, { role: "admin" }] };
  const rows = await db.collection("memberships").find({ workspaceId: event.workspaceId, userId: { $in: candidates }, status: "active", ...scope }, { projection: { userId: 1 }, ...(session ? { session } : {}) }).toArray();
  return new Set(rows.map((row) => String(row.userId)));
}
