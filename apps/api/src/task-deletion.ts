import { randomUUID } from "node:crypto";
import type { ClientSession, Document } from "mongodb";
import type { AppDb } from "./db.js";
import { AppError } from "./errors.js";

/** Deleted tasks can be recovered for this long; the app offers Undo straight after, and admins can restore until then. */
export const TASK_RECOVERY_DAYS = 30;

type Scope = { workspaceId: string; taskId: string; deletionId: string; actorId: string };

/**
 * Removes a task with its comments, status history, evidence, reminders, attachment records, and the notices about it.
 * Each removed record is copied to `deleted_records` first (expiring after TASK_RECOVERY_DAYS) so the delete can be undone;
 * records that only point at the task (other tasks' dependencies, focus sessions, class applications) lose the reference.
 * Uploaded file objects stay in storage; only their records are removed.
 */
export async function deleteTaskCascade(db: AppDb, scope: Scope, session?: ClientSession): Promise<Record<string, number>> {
  const { workspaceId, taskId, deletionId, actorId } = scope;
  const deletedAt = new Date(); const expiresAt = new Date(deletedAt.getTime() + TASK_RECOVERY_DAYS * 86_400_000);
  const counts: Record<string, number> = {};
  const task = await db.collection("tasks").findOne({ _id: taskId, workspaceId }, { session });
  if (!task) throw new AppError(404, "NOT_FOUND", "Task not found");
  const snapshot = async (collection: string, action: "removed" | "rewritten", documents: Document[]) => {
    if (!documents.length) return;
    await db.collection("deleted_records").insertMany(documents.map((document) => ({ _id: randomUUID(), deletionId, kind: "task", taskId, workspaceId, ventureId: task.ventureId, collection, action, document, deletedAt, deletedBy: actorId, expiresAt })), { session });
  };
  const remove = async (collection: string, filter: Record<string, unknown>) => {
    const documents = await db.collection(collection).find(filter, { session }).toArray();
    await snapshot(collection, "removed", documents);
    if (documents.length) await db.collection(collection).deleteMany({ _id: { $in: documents.map((document) => document._id) } }, { session });
    counts[collection] = documents.length;
    return documents;
  };
  const rewrite = async (collection: string, filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const documents = await db.collection(collection).find(filter, { session }).toArray();
    await snapshot(collection, "rewritten", documents);
    if (documents.length) await db.collection(collection).updateMany({ _id: { $in: documents.map((document) => document._id) } }, update, { session });
    counts[`${collection} updated`] = documents.length;
  };

  await remove("tasks", { _id: taskId, workspaceId });
  const reminders = await remove("reminders", { taskId });
  await remove("task_updates", { taskId });
  await remove("evidence_items", { taskId });
  const files = await remove("files", { workspaceId, taskId });
  // Text read out of those files is derived from them, so it goes without a recovery copy (it is read again if restored).
  if (files.length) await db.collection("file_texts").deleteMany({ _id: { $in: files.map((file) => file._id) } }, { session });
  const aboutTask = { workspaceId, $or: [{ resourceType: "task", resourceId: taskId }, { reminderId: { $in: reminders.map((reminder) => reminder._id) } }] };
  await remove("notification_outbox", aboutTask);
  await remove("notifications", aboutTask);
  await rewrite("tasks", { workspaceId, dependencies: taskId }, { $pull: { dependencies: taskId } });
  await rewrite("tasks", { workspaceId, parentTaskId: taskId }, { $unset: { parentTaskId: "" } });
  await rewrite("focus_sessions", { taskId }, { $unset: { taskId: "" } });
  await rewrite("class_applications", { taskId }, { $unset: { taskId: "", evidenceItemId: "" } });
  await rewrite("command_executions", { workspaceId, "result.task._id": taskId }, { $unset: { "result.task": "", "result.reminder": "" } });
  return counts;
}

/**
 * Puts a deleted task back: its own records are reinserted, and records that pointed at it get the reference back
 * (only where it is still missing, so nothing changed since is overwritten). Returns the restored task.
 */
export async function restoreTaskDeletion(db: AppDb, workspaceId: string, deletionId: string, session?: ClientSession): Promise<Document> {
  const records = await db.collection("deleted_records").find({ workspaceId, deletionId, kind: "task" }, { session }).toArray();
  const task = records.find((record) => record.collection === "tasks" && record.action === "removed")?.document;
  if (!task) throw new AppError(404, "NOT_FOUND", "That deleted task can no longer be restored");
  const taskId = String(task._id);
  if (await db.collection("tasks").findOne({ _id: taskId }, { session })) throw new AppError(409, "CONFLICT", "That task is already back");
  for (const record of records) {
    const document = record.document as Document;
    if (record.action === "removed") {
      const { _id, ...fields } = document;
      await db.collection(String(record.collection)).updateOne({ _id }, { $setOnInsert: fields }, { upsert: true, session });
      continue;
    }
    const filter = { _id: document._id };
    if (record.collection === "tasks") {
      if (Array.isArray(document.dependencies) && document.dependencies.includes(taskId)) await db.collection("tasks").updateOne(filter, { $addToSet: { dependencies: taskId } }, { session });
      if (document.parentTaskId === taskId) await db.collection("tasks").updateOne({ ...filter, parentTaskId: { $exists: false } }, { $set: { parentTaskId: taskId } }, { session });
    } else if (record.collection === "focus_sessions") {
      await db.collection("focus_sessions").updateOne({ ...filter, taskId: { $exists: false } }, { $set: { taskId } }, { session });
    } else if (record.collection === "class_applications") {
      await db.collection("class_applications").updateOne({ ...filter, taskId: { $exists: false } }, { $set: { taskId, ...(document.evidenceItemId ? { evidenceItemId: document.evidenceItemId } : {}) } }, { session });
    } else if (record.collection === "command_executions" && document.result?.task) {
      await db.collection("command_executions").updateOne({ ...filter, "result.task": { $exists: false } }, { $set: { "result.task": document.result.task, ...(document.result.reminder ? { "result.reminder": document.result.reminder } : {}) } }, { session });
    }
  }
  // Tasks deleted since then are not depended on again.
  const references = [...(Array.isArray(task.dependencies) ? task.dependencies : []), ...(task.parentTaskId ? [task.parentTaskId] : [])].map(String);
  if (references.length) {
    const alive = new Set((await db.collection("tasks").find({ _id: { $in: references } }, { projection: { _id: 1 }, session }).toArray()).map((item) => String(item._id)));
    const gone = references.filter((reference) => !alive.has(reference));
    if (gone.length) await db.collection("tasks").updateOne({ _id: taskId }, { $pull: { dependencies: { $in: gone } } as never, ...(task.parentTaskId && gone.includes(String(task.parentTaskId)) ? { $unset: { parentTaskId: "" } } : {}) }, { session });
  }
  await db.collection("deleted_records").deleteMany({ workspaceId, deletionId, kind: "task" }, { session });
  // The task as it now stands (without references dropped above).
  return (await db.collection("tasks").findOne({ _id: taskId }, { session })) ?? task;
}
