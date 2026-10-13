import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { ClientSession } from "mongodb";
import { deleteVentureSchema, idSchema } from "@venture-studio/contracts";
import type { AppDb, Database } from "../db.js";
import { atomic } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";

type Actor = NonNullable<Express.Request["actor"]>;
// Deleted records are kept this long so a mistaken permanent delete can still be recovered by an operator.
const RECOVERY_DAYS = 30;

/** The venture ids this actor really belongs to: the request membership has archived ones removed, so read the stored one. */
async function storedVentureIds(db: AppDb, actor: Actor): Promise<string[]> {
  const membership = await db.collection("memberships").findOne({ workspaceId: actor.membership.workspaceId, userId: actor.id, status: "active" }, { projection: { ventureIds: 1 } });
  return Array.isArray(membership?.ventureIds) ? membership.ventureIds.map(String) : [];
}

/** Admins manage every venture's lifecycle; a venture head may archive and restore the ventures they lead. */
async function assertLifecycleAccess(db: AppDb, actor: Actor, ventureId: string): Promise<void> {
  if (actor.membership.role === "admin") return;
  if (actor.membership.role === "venture_head" && (await storedVentureIds(db, actor)).includes(ventureId)) return;
  throw new AppError(403, "FORBIDDEN", "Only an admin or this venture's head may archive or restore it");
}

export function ventureLifecycleRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  router.get("/ventures/archived", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin" && actor.membership.role !== "venture_head") { res.json({ ok: true, data: [] }); return; }
    const scope = actor.membership.role === "admin" ? {} : { _id: { $in: await storedVentureIds(db, actor) } };
    const items = await db.collection("ventures").find({ workspaceId: actor.membership.workspaceId, status: "archived", ...scope }).sort({ archivedAt: -1 }).toArray();
    res.json({ ok: true, data: jsonValue(items.map((item) => ({ id: item._id, name: item.name, goal30Day: item.goal30Day ?? "", archivedAt: item.archivedAt, archivedBy: item.archivedBy }))) });
  });

  router.post("/ventures/:ventureId/archive", async (req, res) => {
    const actor = req.actor!; const ventureId = idSchema.parse(req.params.ventureId); const workspaceId = actor.membership.workspaceId;
    await assertLifecycleAccess(db, actor, ventureId);
    const now = new Date();
    const venture = await atomic(database, async (session) => {
      const updated = await db.collection("ventures").findOneAndUpdate({ _id: ventureId, workspaceId, status: { $ne: "archived" } }, { $set: { status: "archived", archivedAt: now, archivedBy: actor.id, updatedAt: now } }, { returnDocument: "after", session });
      if (!updated) throw new AppError(404, "NOT_FOUND", "Venture not found or already archived");
      await audit(db, { workspaceId, ventureId, actorId: actor.id, channel: "api", action: "venture.archive", objectType: "venture", objectId: ventureId, result: "success" }, session);
      return updated;
    });
    res.json({ ok: true, data: jsonValue(venture) });
  });

  router.post("/ventures/:ventureId/restore", async (req, res) => {
    const actor = req.actor!; const ventureId = idSchema.parse(req.params.ventureId); const workspaceId = actor.membership.workspaceId;
    await assertLifecycleAccess(db, actor, ventureId);
    const now = new Date();
    const venture = await atomic(database, async (session) => {
      const updated = await db.collection("ventures").findOneAndUpdate({ _id: ventureId, workspaceId, status: "archived" }, { $set: { status: "active", updatedAt: now }, $unset: { archivedAt: "", archivedBy: "" } }, { returnDocument: "after", session });
      if (!updated) throw new AppError(404, "NOT_FOUND", "Archived venture not found");
      // Reminders and notices the worker held back while the venture was archived become due again now.
      await db.collection("reminders").updateMany({ workspaceId, heldForArchive: true, state: "scheduled" }, { $set: { scheduledAt: now, updatedAt: now }, $unset: { heldForArchive: "" } }, { session });
      await db.collection("notification_outbox").updateMany({ workspaceId, heldForArchive: true, state: "pending" }, { $set: { nextAttemptAt: now, updatedAt: now }, $unset: { heldForArchive: "" } }, { session });
      await audit(db, { workspaceId, ventureId, actorId: actor.id, channel: "api", action: "venture.restore", objectType: "venture", objectId: ventureId, result: "success" }, session);
      return updated;
    });
    res.json({ ok: true, data: jsonValue(venture) });
  });

  router.delete("/ventures/:ventureId", async (req, res) => {
    const actor = req.actor!; const ventureId = idSchema.parse(req.params.ventureId); const workspaceId = actor.membership.workspaceId;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may permanently delete a venture");
    // Without transactions a failure midway would leave a half-deleted venture, so refuse instead.
    if (!database.transactions) throw new AppError(409, "CONFLICT", "Permanent delete needs a MongoDB replica set with transactions");
    const { confirmName } = deleteVentureSchema.parse(req.body ?? {});
    const deletionId = randomUUID();
    const counts = await atomic(database, async (session) => {
      const venture = await db.collection("ventures").findOne({ _id: ventureId, workspaceId }, { session });
      if (!venture) throw new AppError(404, "NOT_FOUND", "Venture not found");
      if (venture.status !== "archived") throw new AppError(409, "CONFLICT", "Archive the venture before deleting it permanently");
      if (confirmName !== venture.name) throw new AppError(400, "BAD_REQUEST", "Type the venture's exact name to confirm the permanent delete");
      const removed = await deleteVentureCascade(db, { workspaceId, ventureId, deletionId, actorId: actor.id }, session);
      await audit(db, { workspaceId, ventureId, actorId: actor.id, channel: "api", action: "venture.delete", objectType: "venture", objectId: ventureId, result: "success", metadata: { deletionId, records: Object.values(removed).reduce((sum, value) => sum + value, 0) } }, session);
      return removed;
    });
    res.json({ ok: true, data: { deleted: true, deletionId, counts, recoverableUntil: new Date(Date.now() + RECOVERY_DAYS * 86_400_000).toISOString() } });
  });

  return router;
}

/**
 * Removes a venture and everything that belongs to it. Every removed or rewritten document is first copied to
 * `deleted_records` (expiring after RECOVERY_DAYS), so an operator can recover a mistaken delete. Workspace-wide
 * records (documents, decisions, classes without a venture), direct messages, and the audit trail are untouched.
 * Uploaded file objects stay in storage; only their records are removed.
 */
async function deleteVentureCascade(db: AppDb, scope: { workspaceId: string; ventureId: string; deletionId: string; actorId: string }, session?: ClientSession): Promise<Record<string, number>> {
  const { workspaceId, ventureId, deletionId } = scope;
  const deletedAt = new Date(); const expiresAt = new Date(deletedAt.getTime() + RECOVERY_DAYS * 86_400_000);
  const counts: Record<string, number> = {};
  const snapshot = async (collection: string, documents: Record<string, unknown>[]) => {
    if (!documents.length) return;
    await db.collection("deleted_records").insertMany(documents.map((document) => ({ _id: randomUUID(), deletionId, workspaceId, ventureId, collection, document, deletedAt, deletedBy: scope.actorId, expiresAt })), { session });
  };
  // Child records are found by their parent ids (some of them carry no workspaceId); top-level ones also by workspace.
  const remove = async (collection: string, filter: Record<string, unknown>, byParentIds = false) => {
    const documents = await db.collection(collection).find(byParentIds ? filter : { workspaceId, ...filter }, { session }).toArray();
    await snapshot(collection, documents);
    if (documents.length) await db.collection(collection).deleteMany({ _id: { $in: documents.map((document) => document._id) } }, { session });
    counts[collection] = documents.length;
    return documents;
  };
  const ids = (documents: Record<string, unknown>[]) => documents.map((document) => String(document._id));

  // Records that carry the venture directly.
  const groups = await remove("groups", { ventureId });
  const channels = await remove("channels", { ventureId });
  const tasks = await remove("tasks", { ventureId });
  const messages = await remove("messages", { ventureId });
  const documents = await remove("documents", { ventureId });
  const classes = await remove("classes", { ventureId });
  const previews = await remove("command_previews", { ventureId });
  for (const collection of ["outcomes", "decisions", "information_requests", "files", "pipelines", "opportunities", "sales_activities", "sales_verdicts", "sales_drafts", "sales_plays", "sales_find_runs", "sales_brain_items", "sales_offers", "sales_offer_versions", "sales_imports", "sales_import_locks", "events", "document_chunks", "venture_context", "skills"]) await remove(collection, { ventureId });
  // The venture's sales settings are kept under the venture's own id.
  await remove("sales_settings", { _id: ventureId });
  // Claude's note that it read this venture's context goes too; it is only a reminder, so it gets no recovery copy.
  await db.collection("mcp_context_reads").deleteMany({ workspaceId, ventureId }, { session });
  const calendarEvents = await remove("calendar_events", { ventureId });
  // Text read out of the venture's files is derived from them, so it goes without a recovery copy.
  await db.collection("file_texts").deleteMany({ workspaceId, ventureId }, { session });

  // Records that hang off those.
  const taskIds = ids(tasks); const messageIds = ids(messages); const channelIds = ids(channels); const groupIds = ids(groups);
  const reminders = await remove("reminders", { $or: [{ taskId: { $in: taskIds } }, { ventureId }] }, true);
  await remove("task_updates", { taskId: { $in: taskIds } }, true);
  await remove("evidence_items", { taskId: { $in: taskIds } }, true);
  await remove("message_reactions", { messageId: { $in: messageIds } }, true);
  await remove("message_saves", { messageId: { $in: messageIds } }, true);
  await remove("channel_notification_settings", { channelId: { $in: channelIds } });
  await remove("document_versions", { documentId: { $in: ids(documents) } }, true);
  await remove("class_applications", { classId: { $in: ids(classes) } }, true);
  await remove("command_executions", { $or: [{ "preview.previewId": { $in: ids(previews) } }, { "result.task.ventureId": ventureId }] }, true);
  const pointsAtVenture = { $or: [{ resourceId: { $in: [...taskIds, ...messageIds, ...ids(calendarEvents)] } }, { chatKind: "channel", chatId: { $in: channelIds } }, { reminderId: { $in: ids(reminders) } }] };
  await remove("notification_outbox", pointsAtVenture);
  await remove("notifications", pointsAtVenture);

  // Records that only mention the venture: keep them, drop the reference (the old version is in deleted_records).
  const rewrite = async (collection: string, filter: Record<string, unknown>, update: Record<string, unknown>, byParentIds = false) => {
    const documents = await db.collection(collection).find(byParentIds ? filter : { workspaceId, ...filter }, { session }).toArray();
    await snapshot(collection, documents);
    if (documents.length) await db.collection(collection).updateMany({ _id: { $in: documents.map((document) => document._id) } }, update, { session });
    counts[`${collection} updated`] = documents.length;
    return documents;
  };
  await rewrite("memberships", { $or: [{ ventureIds: ventureId }, { inheritedVentureIds: ventureId }, { allGroupVentureIds: ventureId }, { groupIds: { $in: groupIds } }] }, { $pull: { ventureIds: ventureId, inheritedVentureIds: ventureId, allGroupVentureIds: ventureId, groupIds: { $in: groupIds } }, $set: { updatedAt: deletedAt } });
  const invitations = await rewrite("invitations", { status: "pending", $or: [{ ventureIds: ventureId }, { allGroupVentureIds: ventureId }, { groupIds: { $in: groupIds } }] }, { $pull: { ventureIds: ventureId, allGroupVentureIds: ventureId, groupIds: { $in: groupIds } }, $set: { updatedAt: deletedAt } });
  // One of those invitations left with no venture would add a member who can open nothing (admins see everything regardless).
  await db.collection("invitations").updateMany({ _id: { $in: invitations.map((invite) => invite._id) }, role: { $ne: "admin" }, ventureIds: { $size: 0 } }, { $set: { status: "superseded", supersededReason: "venture_deleted", updatedAt: deletedAt } }, { session });
  await rewrite("focus_sessions", { taskId: { $in: taskIds } }, { $unset: { taskId: "" } }, true);
  await rewrite("class_applications", { taskId: { $in: taskIds } }, { $unset: { taskId: "", evidenceItemId: "" } }, true);
  await rewrite("task_filters", { $or: [{ "filters.ventureId": ventureId }, { "filters.groupId": { $in: groupIds } }] }, { $unset: { "filters.ventureId": "", "filters.groupId": "" } }, true);

  const venture = await remove("ventures", { _id: ventureId });
  if (!venture.length) throw new AppError(409, "CONFLICT", "The venture changed while it was being deleted; nothing was removed");
  return counts;
}
