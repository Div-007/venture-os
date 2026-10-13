import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Filter } from "mongodb";
import { createEvidenceSchema, createOutcomeSchema, createReminderSchema, createTaskSchema, cursorQuerySchema, idSchema, snoozeSchema, startFocusSchema, taskDetailFields, taskListQuerySchema, type taskSortSchema, updateOutcomeSchema, updateTaskSchema } from "@venture-studio/contracts";
import { can, hasDeadlineRisk, snoozeReminder } from "@venture-studio/core";
import type { AppDb, AppDocument, Database } from "../db.js";
import { atomic } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { assignableMembership } from "../assignable.js";
import { inArchivedVenture, notArchived } from "../archive-scope.js";
import { jsonValue, omitNullFields, withDates } from "../json.js";
import { assertNotBlank, assertOrderedDates } from "../validation.js";
import { deleteTaskCascade, restoreTaskDeletion } from "../task-deletion.js";
import { recordCelebration } from "../celebrations.js";
import { z } from "zod";

type TaskSortKey = { value: unknown; order: 1 | -1; date: boolean };
type TaskSort = z.infer<typeof taskSortSchema>;
/** What each task sort orders by (the id breaks ties). Missing dates sort as the epoch rather than breaking the paging. */
const taskSortKeys: Record<TaskSort, TaskSortKey[]> = {
  due: [{ value: { $ifNull: ["$dueAt", new Date(0)] }, order: 1, date: true }],
  priority: [{ value: { $indexOfArray: [["low", "medium", "high", "urgent"], "$priority"] }, order: -1, date: false }, { value: { $ifNull: ["$dueAt", new Date(0)] }, order: 1, date: true }],
  updated: [{ value: { $ifNull: ["$updatedAt", "$createdAt", new Date(0)] }, order: -1, date: true }],
  newest: [{ value: { $ifNull: ["$createdAt", new Date(0)] }, order: -1, date: true }],
};
/** A page cursor: the sort, the last task's sort values, and its id, as base64url JSON (it fits the opaque-id format). */
function encodeTaskCursor(sort: TaskSort, row: Record<string, unknown>, keys: TaskSortKey[]) {
  const values = keys.map((key, index) => { const value = row[`_s${index}`]; return key.date ? (value instanceof Date ? value.getTime() : 0) : Number(value); });
  return Buffer.from(JSON.stringify([sort, ...values, String(row._id)])).toString("base64url");
}
function decodeTaskCursor(sort: TaskSort, cursor: string, keys: TaskSortKey[]) {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { parsed = undefined; }
  const values = Array.isArray(parsed) ? parsed.slice(1, -1) : [];
  if (!Array.isArray(parsed) || parsed[0] !== sort || values.length !== keys.length || typeof parsed[parsed.length - 1] !== "string" || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new AppError(400, "BAD_REQUEST", "That page cursor doesn't fit this sort; start again from the first page");
  return { values: keys.map((key, index) => key.date ? new Date(values[index] as number) : values[index] as number), id: parsed[parsed.length - 1] as string };
}
/** Rows after the cursor in sort order: a later first key, or the same first key and a later second, …, or all the same and a later id. */
function afterTaskCursor(keys: TaskSortKey[], after: { values: unknown[]; id: string }) {
  const same = (count: number) => Object.fromEntries(keys.slice(0, count).map((_, index) => [`_s${index}`, after.values[index]]));
  return { $or: [...keys.map((key, index) => ({ ...same(index), [`_s${index}`]: { [key.order === 1 ? "$gt" : "$lt"]: after.values[index] } })), { ...same(keys.length), _id: { $gt: after.id } }] };
}

export function workRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  /** Re-reads the actor's membership inside a transaction (and fences it), so a member removed or demoted meanwhile can't act; returns it. */
  async function fenceActor(actor: NonNullable<Express.Request["actor"]>, ventureId: string, groupId: string, session?: import("mongodb").ClientSession) {
    const membership = await db.collection("memberships").findOneAndUpdate({ workspaceId: actor.membership.workspaceId, userId: actor.id, status: "active" }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
    if (!membership || (membership.role !== "admin" && (!membership.ventureIds.includes(ventureId) || !membership.groupIds.includes(groupId)))) throw new AppError(404, "NOT_FOUND", "Task not found");
    if (!can(membership as unknown as Parameters<typeof can>[0], "task:update", { ventureId, groupId })) throw new AppError(403, "FORBIDDEN", "Current role cannot change tasks");
    return membership;
  }
  /** Writes to the task inside the caller's transaction, so it conflicts with a delete running at the same time. */
  async function touchTask(id: string, session?: import("mongodb").ClientSession) {
    return (await db.collection("tasks").updateOne({ _id: id }, { $set: { lastActivityAt: new Date() } }, { session })).matchedCount > 0;
  }

  /** Open tasks with evidence waiting that this person may review (the same rules as reviewing it; through Claude, never their own). */
  async function needsReviewBy(actor: NonNullable<Express.Request["actor"]>, viaClaude: boolean): Promise<Filter<AppDocument>> {
    const role = actor.membership.role;
    const anyone = role === "admin" && !viaClaude;
    const pending = await db.collection("evidence_items").find({ workspaceId: actor.membership.workspaceId, reviewStatus: "pending", ...(anyone ? {} : { submittedBy: { $ne: actor.id } }) }, { projection: { taskId: 1 } }).toArray();
    const reviewer = anyone ? {} : role === "admin" || role === "venture_head" ? { assigneeId: { $ne: actor.id } } : { reviewerId: actor.id, assigneeId: { $ne: actor.id } };
    return { _id: { $in: [...new Set(pending.map((item) => String(item.taskId)))] }, status: { $nin: ["done", "cancelled"] }, ...reviewer };
  }

  router.get("/tasks", async (req, res) => {
    const query = taskListQuerySchema.parse(req.query);
    const actor = req.actor!;
    // Who can see what, and the venture, people, priority, tag, and search asked for: the lists (and their counts) share these.
    const filter: Filter<AppDocument> = { workspaceId: actor.membership.workspaceId };
    if (query.ventureId) filter.ventureId = query.ventureId;
    if (query.groupId) filter.groupId = query.groupId;
    if (query.assigneeId) filter.assigneeId = query.assigneeId;
    if (query.reviewerId) filter.reviewerId = query.reviewerId;
    if (query.priority) filter.priority = query.priority;
    if (query.tag) filter.tags = query.tag;
    if (query.q) {
      const words = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: words }, { outcome: words }, { tags: words }];
    }
    if (actor.membership.role === "admin") {
      if (query.ventureId && inArchivedVenture(actor.membership, query.ventureId)) filter.ventureId = { $in: [] };
      else if (!query.ventureId) Object.assign(filter, notArchived(actor.membership));
    } else {
      filter.ventureId = query.ventureId && actor.membership.ventureIds.includes(query.ventureId) ? query.ventureId : query.ventureId ? { $in: [] } : { $in: actor.membership.ventureIds };
      filter.groupId = query.groupId && actor.membership.groupIds.includes(query.groupId) ? query.groupId : query.groupId ? { $in: [] } : { $in: actor.membership.groupIds };
    }
    const now = new Date();
    const offList = ["done", "cancelled", "parked"];
    const views = {
      open: async () => ({ status: { $nin: offList } }),
      review: () => needsReviewBy(actor, req.interfaceChannel === "mcp"),
      overdue: async () => ({ status: { $nin: offList }, dueAt: { $lt: now } }),
      done: async () => ({ status: "done" }),
      all: async () => ({}),
    } satisfies Record<string, () => Promise<Filter<AppDocument>>>;
    const narrowed: Filter<AppDocument>[] = [await views[query.view ?? "all"]()];
    if (query.status) narrowed.push({ status: query.status });
    if (query.dueFrom || query.dueTo) narrowed.push({ dueAt: { ...(query.dueFrom ? { $gte: new Date(query.dueFrom) } : {}), ...(query.dueTo ? { $lt: new Date(query.dueTo) } : {}) } });
    const counts = query.counts === "true" ? Object.fromEntries(await Promise.all((Object.keys(views) as (keyof typeof views)[]).map(async (view) => [view, await db.collection("tasks").countDocuments({ ...filter, $and: [await views[view]()] })]))) : undefined;
    const listed = { ...filter, $and: narrowed };
    // Lists leave the long details out; they come with the task itself.
    if (!query.sort) {
      const items = await db.collection("tasks").find({ ...listed, ...(query.cursor ? { _id: { $gt: query.cursor } } : {}) } as Filter<AppDocument>, { projection: { details: 0 } }).sort({ _id: 1 }).limit(query.limit + 1).toArray();
      res.json({ ok: true, data: { items: jsonValue(items.slice(0, query.limit)), nextCursor: items.length > query.limit ? items[query.limit - 1]?._id : undefined, ...(counts ? { counts } : {}) } });
      return;
    }
    // Sorted lists page by their sort values and id, so a page never repeats or skips a task.
    const keys = taskSortKeys[query.sort];
    const after = query.cursor ? decodeTaskCursor(query.sort, query.cursor, keys) : undefined;
    const rows = await db.collection("tasks").aggregate([
      { $match: listed },
      { $project: { details: 0 } },
      { $addFields: Object.fromEntries(keys.map((key, index) => [`_s${index}`, key.value])) },
      ...(after ? [{ $match: afterTaskCursor(keys, after) }] : []),
      { $sort: { ...Object.fromEntries(keys.map((key, index) => [`_s${index}`, key.order])), _id: 1 } },
      { $limit: query.limit + 1 },
    ]).toArray();
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    const items = page.map(({ _s0, _s1, ...task }) => task);
    res.json({ ok: true, data: { items: jsonValue(items), nextCursor: last ? encodeTaskCursor(query.sort, last, keys) : undefined, ...(counts ? { counts } : {}) } });
  });

  router.get("/tasks/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const task = await accessibleTask(db, req.actor!, id);
    const [updates, evidence, attachments] = await Promise.all([
      db.collection("task_updates").find({ taskId: id }).sort({ createdAt: 1 }).toArray(),
      db.collection("evidence_items").find({ taskId: id }).sort({ submittedAt: 1 }).toArray(),
      db.collection("files").find({ taskId: id, workspaceId: task.workspaceId, ventureId: task.ventureId, groupId: task.groupId, status: "ready" }).sort({ createdAt: 1 }).toArray(),
    ]);
    res.json({ ok: true, data: jsonValue({ ...task, updates: updates.map((item) => omitNullFields(item, ["fromStatus", "toStatus"])), evidence: evidence.map((item) => omitNullFields(item, ["uri"])), attachments }) });
  });

  router.post("/tasks", async (req, res) => {
    const input = createTaskSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "task:create", { ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(403, "FORBIDDEN", "You cannot create tasks in this scope");
    await assertTaskScope(db, actor.membership.workspaceId, input);
    await assertAssignableMember(db, actor.membership.workspaceId, input.assigneeId, input.ventureId, input.groupId, "Assignee");
    if (input.reviewerId) await assertAssignableMember(db, actor.membership.workspaceId, input.reviewerId, input.ventureId, input.groupId, "Reviewer");
    const now = new Date();
    const id = randomUUID();
    const deadlineRisk = hasDeadlineRisk(input.dueAt, input.estimatedMinutes, now);
    // Empty details are left out rather than stored empty.
    const { details, ...fields } = input;
    const task = { _id: id, workspaceId: actor.membership.workspaceId, ...withDates(fields, ["dueAt", "reviewAt"]), ...(details ? { details } : {}), creatorId: actor.id, status: "proposed", deadlineRisk, createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      const currentActor = await db.collection("memberships").findOneAndUpdate({ workspaceId: actor.membership.workspaceId, userId: actor.id, status: "active" }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
      if (!currentActor || !can(currentActor as unknown as Parameters<typeof can>[0], "task:create", { ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(403, "FORBIDDEN", "You cannot create tasks in this scope");
      await fenceAssignableMember(db, actor.membership.workspaceId, input.assigneeId, input.ventureId, input.groupId, "Assignee", session);
      if (input.reviewerId && input.reviewerId !== input.assigneeId) await fenceAssignableMember(db, actor.membership.workspaceId, input.reviewerId, input.ventureId, input.groupId, "Reviewer", session);
      await db.collection("tasks").insertOne(task, { session });
      const latestStartAt = new Date(new Date(input.dueAt).getTime() - input.estimatedMinutes * 60_000);
      await db.collection("reminders").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.assigneeId, taskId: id, kind: "task_start", message: `Start: ${input.title}`, scheduledAt: latestStartAt > now ? latestStartAt : now, timezone: input.timezone, repeatMinutes: 10, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now }, { session });
      await db.collection("task_updates").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, authorId: actor.id, type: "status", body: "Task proposed", toStatus: "proposed", createdAt: now }, { session });
      await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.assigneeId, type: "assignment", title: input.title, body: input.outcome, resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:assigned`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      if (deadlineRisk) await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.assigneeId, type: "deadline_warning", title: `Deadline risk: ${input.title}`, body: "Estimated work exceeds the time remaining before the deadline.", resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:deadline-risk`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "task.create", objectType: "task", objectId: id, ventureId: input.ventureId, result: "success" }, session);
    });
    res.status(201).json({ ok: true, data: jsonValue(task), warnings: deadlineRisk ? ["Estimated effort exceeds the time remaining before the deadline."] : [] });
  });

  router.patch("/tasks/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = updateTaskSchema.parse(req.body);
    const actor = req.actor!;
    const existing = await accessibleTask(db, actor, id);
    const now = new Date();
    let finishedFor: string | undefined;
    await atomic(database, async (session) => {
      const current = await db.collection("tasks").findOne({ _id: id, workspaceId: actor.membership.workspaceId }, { session });
      if (!current) throw new AppError(404, "NOT_FOUND", "Task not found");
      const membership = await db.collection("memberships").findOneAndUpdate({ workspaceId: actor.membership.workspaceId, userId: actor.id, status: "active" }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
      if (!membership || (membership.role !== "admin" && (!membership.ventureIds.includes(String(current.ventureId)) || !membership.groupIds.includes(String(current.groupId))))) throw new AppError(404, "NOT_FOUND", "Task not found");
      if (!can(membership as unknown as Parameters<typeof can>[0], "task:update", { ventureId: String(current.ventureId), groupId: String(current.groupId) })) throw new AppError(403, "FORBIDDEN", "Current role cannot update tasks");
      const elevated = membership.role === "admin" || membership.role === "venture_head";
      // The task's details (title, outcome, definition of done, evidence requirement, tags) belong to whoever created it, and admins.
      const editsDetails = taskDetailFields.some((field) => input[field] !== undefined);
      if (editsDetails && membership.role !== "admin" && current.creatorId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the task's creator or a workspace admin may edit its details");
      if (editsDetails && ["done", "cancelled"].includes(String(current.status))) throw new AppError(409, "CONFLICT", "This task is finished, so its details can't change; reopen it first");
      const editsWork = Object.keys(input).some((field) => !(taskDetailFields as readonly string[]).includes(field));
      if (editsWork && !elevated && current.assigneeId !== actor.id && current.reviewerId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the assignee, assigned reviewer, or venture lead may update this task");
      if (!elevated && (["assigneeId", "reviewerId", "priority", "dueAt", "estimatedMinutes"] as const).some((field) => input[field] !== undefined)) throw new AppError(403, "FORBIDDEN", "Only a venture lead or workspace admin may change task planning or assignment");
      if (input.status && !elevated && current.assigneeId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the assignee or venture lead may change task progress");
      if (input.assigneeId) await fenceAssignableMember(db, actor.membership.workspaceId, input.assigneeId, String(current.ventureId), String(current.groupId), "Assignee", session);
      if (input.reviewerId && input.reviewerId !== input.assigneeId) await fenceAssignableMember(db, actor.membership.workspaceId, input.reviewerId, String(current.ventureId), String(current.groupId), "Reviewer", session);
      if (input.status === "done") {
        const evidence = await db.collection("evidence_items").countDocuments({ taskId: id, reviewStatus: { $in: ["accepted", "exception"] } }, { session });
        if (!evidence) throw new AppError(409, "CONFLICT", "Completion requires accepted evidence or a reviewed exception");
      }
      const nextDueAt = input.dueAt ? new Date(input.dueAt) : new Date(current.dueAt);
      const nextEstimate = input.estimatedMinutes ?? Number(current.estimatedMinutes);
      const nextAssignee = input.assigneeId ?? String(current.assigneeId);
      const nextTitle = String(input.title ?? current.title);
      const nextOutcome = String(input.outcome ?? current.outcome);
      const assigneeChanged = nextAssignee !== current.assigneeId;
      const planningChanged = assigneeChanged || nextDueAt.getTime() !== new Date(current.dueAt).getTime() || nextEstimate !== current.estimatedMinutes;
      const deadlineRisk = hasDeadlineRisk(nextDueAt, nextEstimate, now);
      const $set: Record<string, unknown> = { ...input, ...(input.dueAt ? { dueAt: nextDueAt } : {}), deadlineRisk, updatedAt: now };
      // A cleared blocker or emptied details are removed, not stored empty.
      const $unset: Record<string, ""> = { ...(input.blocker === null ? { blocker: "" } : {}), ...(input.details === null || input.details === "" ? { details: "" } : {}) };
      for (const field of Object.keys($unset)) delete $set[field];
      if (input.status === "accepted") $set.acceptedAt = now;
      if (input.status === "in_progress" && !current.startedAt) $set.startedAt = now;
      if (input.status === "done") $set.completedAt = now;
      // Finishing it is the assignee's moment: their celebration, unless it already came when the evidence was accepted.
      const owner = input.assigneeId ?? (typeof current.assigneeId === "string" ? current.assigneeId : undefined);
      finishedFor = input.status === "done" && current.status !== "done" ? owner : undefined;
      await db.collection("tasks").updateOne({ _id: id }, Object.keys($unset).length ? { $set, $unset } : { $set }, { session });
      // Empty details and missing details are the same thing.
      const comparable = (field: (typeof taskDetailFields)[number], value: unknown) => value === null || value === "" ? (field === "tags" ? [] : undefined) : value ?? (field === "tags" ? [] : undefined);
      const changedDetails = taskDetailFields.filter((field) => input[field] !== undefined && JSON.stringify(comparable(field, input[field])) !== JSON.stringify(comparable(field, current[field])));
      const detailNames = { title: "title", outcome: "outcome", definitionOfDone: "definition of done", evidenceRequirement: "evidence requirement", details: "details", tags: "tags" } as const;
      const detailSummary = changedDetails.length ? `Edited the ${changedDetails.map((field) => detailNames[field]).join(", ").replace(/, ([^,]*)$/, " and $1")}` : "";
      await db.collection("task_updates").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, authorId: actor.id, type: input.status ? "status" : input.blocker !== undefined ? "blocker" : "comment", body: input.blocker ?? (detailSummary || "Task updated"), ...(changedDetails.length ? { previous: Object.fromEntries(changedDetails.map((field) => [field, typeof current[field] === "string" && current[field].length > 2000 ? `${current[field].slice(0, 2000)}…` : current[field] ?? null])) } : {}), fromStatus: current.status, ...(input.status ? { toStatus: input.status } : {}), createdAt: now }, { session });
      if (assigneeChanged) {
        await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, userId: current.assigneeId, type: { $in: ["assignment", "deadline_warning", "reminder"] }, state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
        await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: nextAssignee, type: "assignment", title: nextTitle, body: nextOutcome, resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:reassigned:${randomUUID()}`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      }
      // The assignee hears when someone else changes what the task asks of them; reminders take the new title.
      if (changedDetails.length && nextAssignee !== actor.id && !assigneeChanged) {
        await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: nextAssignee, type: "assignment", title: `Task updated: ${nextTitle}`.slice(0, 200), body: `${actor.name} ${detailSummary.charAt(0).toLowerCase()}${detailSummary.slice(1)}.`, resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:details:${randomUUID()}`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      }
      if (input.title !== undefined && input.title !== current.title) await db.collection("reminders").updateMany({ taskId: id, $or: [{ kind: "task_start" }, { kind: { $exists: false }, repeatMinutes: 10 }], state: { $in: ["scheduled", "claimed"] } }, { $set: { message: `Start: ${input.title}`, updatedAt: now } }, { session });
      const terminalOrStarted = ["done", "cancelled"].includes(input.status ?? String(current.status)) || Boolean(current.startedAt || $set.startedAt);
      if (terminalOrStarted) {
        await db.collection("reminders").updateMany({ taskId: id, state: { $in: ["scheduled", "claimed"] } }, { $set: { state: "cancelled", cancelReason: "task_started_or_terminal", updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
        await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, type: { $in: ["reminder", "deadline_warning"] }, state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
      } else if (planningChanged) {
        await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, type: "reminder", state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
        if (!deadlineRisk) await db.collection("notification_outbox").updateMany({ resourceType: "task", resourceId: id, type: "deadline_warning", state: "pending" }, { $set: { state: "cancelled", updatedAt: now } }, { session });
        const reminder = await db.collection("reminders").findOne({ taskId: id, $or: [{ kind: "task_start" }, { kind: { $exists: false }, repeatMinutes: 10 }] }, { sort: { createdAt: -1 }, session });
        const latestStartAt = new Date(nextDueAt.getTime() - nextEstimate * 60_000);
        const scheduledAt = latestStartAt > now ? latestStartAt : now;
        if (assigneeChanged || !reminder) {
          if (reminder) await db.collection("reminders").updateMany({ taskId: id, state: { $in: ["scheduled", "claimed"] } }, { $set: { state: "cancelled", cancelReason: "reassigned", updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
          await db.collection("reminders").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: nextAssignee, taskId: id, kind: "task_start", message: `Start: ${nextTitle}`, scheduledAt, timezone: current.timezone, repeatMinutes: 10, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now }, { session });
        } else if (["scheduled", "claimed"].includes(String(reminder.state))) {
          await db.collection("reminders").updateOne({ _id: reminder._id }, { $set: { scheduledAt, state: "scheduled", updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" }, $inc: { sequence: 1 } }, { session });
        }
        if (deadlineRisk && (!current.deadlineRisk || assigneeChanged)) await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: nextAssignee, type: "deadline_warning", title: `Deadline risk: ${nextTitle}`, body: "Estimated work exceeds the time remaining before the deadline.", resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:deadline-risk:${randomUUID()}`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      }
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "task.update", objectType: "task", objectId: id, ventureId: String(existing.ventureId), result: "success" }, session);
    });
    if (finishedFor) await recordCelebration(db, { workspaceId: actor.membership.workspaceId, userId: finishedFor, taskId: id, trigger: "done", actorId: actor.id });
    res.json({ ok: true, data: jsonValue(await db.collection("tasks").findOne({ _id: id })) });
  });

  // Deleting is for mistakes and duplicates (cancelling keeps the history): the task's creator or an admin may do it.
  router.delete("/tasks/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const actor = req.actor!;
    const task = await accessibleTask(db, actor, id);
    if (actor.membership.role !== "admin" && task.creatorId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the task's creator or a workspace admin can delete it");
    if (!can(actor.membership, "task:update", { ventureId: String(task.ventureId), groupId: String(task.groupId) })) throw new AppError(403, "FORBIDDEN", "Current role cannot delete tasks");
    if (!database.transactions) throw new AppError(503, "INTEGRATION_UNAVAILABLE", "Deleting a task needs a MongoDB replica set");
    const deletionId = randomUUID();
    let removed: Record<string, number> = {};
    await atomic(database, async (session) => {
      const fenced = await fenceActor(actor, String(task.ventureId), String(task.groupId), session);
      if (fenced.role !== "admin" && task.creatorId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the task's creator or a workspace admin can delete it");
      removed = await deleteTaskCascade(db, { workspaceId: actor.membership.workspaceId, taskId: id, deletionId, actorId: actor.id }, session);
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "task.delete", objectType: "task", objectId: id, ventureId: String(task.ventureId), result: "success", metadata: { deletionId, title: String(task.title).slice(0, 200), removed: JSON.stringify(removed) } }, session);
    });
    res.json({ ok: true, data: { deletionId, removed } });
  });

  // Undo a delete: whoever deleted it, or an admin, while the recovery copy lasts.
  router.post("/tasks/deletions/:deletionId/restore", async (req, res) => {
    const deletionId = idSchema.parse(req.params.deletionId);
    const actor = req.actor!;
    const workspaceId = actor.membership.workspaceId;
    const record = await db.collection("deleted_records").findOne({ workspaceId, deletionId, kind: "task", collection: "tasks", action: "removed" });
    if (!record) throw new AppError(404, "NOT_FOUND", "That deleted task can no longer be restored");
    if (actor.membership.role !== "admin" && record.deletedBy !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the person who deleted it or a workspace admin can restore it");
    const ventureId = String(record.document.ventureId); const groupId = String(record.document.groupId);
    const archived = actor.membership.archivedVentureIds?.includes(ventureId) || actor.membership.archivedGroupIds?.includes(groupId);
    if (archived || !(await db.collection("groups").findOne({ _id: groupId, workspaceId, ventureId }))) throw new AppError(409, "CONFLICT", "Its venture or group is gone or archived, so the task can't come back there");
    if (!can(actor.membership, "task:update", { ventureId, groupId })) throw new AppError(403, "FORBIDDEN", "You can no longer change tasks in its group");
    if (!database.transactions) throw new AppError(503, "INTEGRATION_UNAVAILABLE", "Restoring a task needs a MongoDB replica set");
    let task: Record<string, unknown> = {};
    await atomic(database, async (session) => {
      const fenced = await fenceActor(actor, ventureId, groupId, session);
      if (fenced.role !== "admin" && record.deletedBy !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the person who deleted it or a workspace admin can restore it");
      // Its people must still be able to hold it.
      await fenceAssignableMember(db, workspaceId, String(record.document.assigneeId), ventureId, groupId, "Assignee", session);
      if (record.document.reviewerId) await fenceAssignableMember(db, workspaceId, String(record.document.reviewerId), ventureId, groupId, "Reviewer", session);
      task = await restoreTaskDeletion(db, workspaceId, deletionId, session);
      await audit(db, { workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "task.restore", objectType: "task", objectId: String(task._id), ventureId, result: "success", metadata: { deletionId } }, session);
    });
    res.json({ ok: true, data: jsonValue(task) });
  });

  router.post("/tasks/:id/evidence", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const actor = req.actor!;
    const task = await accessibleTask(db, actor, id);
    const lead = actor.membership.role === "admin" || (actor.membership.role === "venture_head" && actor.membership.ventureIds.includes(String(task.ventureId)));
    if (task.assigneeId !== actor.id && !lead) throw new AppError(403, "FORBIDDEN", "Only the assignee or a venture lead may submit evidence for this task");
    const input = createEvidenceSchema.parse(req.body);
    // Omit an absent URI: the driver would persist `undefined` as null, which the published contract rejects.
    const evidence = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, type: input.type, title: input.title, ...(input.uri ? { uri: input.uri } : {}), description: input.description, submittedBy: actor.id, submittedAt: new Date(), reviewStatus: "pending", ...(req.interfaceChannel === "mcp" ? { via: "claude" } : {}) };
    await atomic(database, async (session) => {
      if (!(await touchTask(id, session))) throw new AppError(404, "NOT_FOUND", "Task not found");
      await db.collection("evidence_items").insertOne(evidence, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "task.evidence.add", objectType: "task", objectId: id, ventureId: String(task.ventureId), result: "success" }, session);
    });
    res.status(201).json({ ok: true, data: jsonValue(evidence) });
  });

  router.post("/tasks/:id/comments", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const actor = req.actor!;
    await accessibleTask(db, actor, id);
    const { body } = z.object({ body: z.string().trim().min(1).max(5_000) }).parse(req.body);
    const comment = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, taskId: id, authorId: actor.id, type: "comment", body, ...(req.interfaceChannel === "mcp" ? { via: "claude" } : {}), createdAt: new Date() };
    await atomic(database, async (session) => {
      if (!(await touchTask(id, session))) throw new AppError(404, "NOT_FOUND", "Task not found");
      await db.collection("task_updates").insertOne(comment, { session });
    });
    res.status(201).json({ ok: true, data: jsonValue(comment) });
  });

  router.post("/evidence/:id/review", async (req, res) => {
    const actor = req.actor!;
    const id = idSchema.parse(req.params.id);
    const { status } = z.object({ status: z.enum(["accepted", "rejected", "exception"]) }).parse(req.body);
    const evidence = await db.collection("evidence_items").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!evidence) throw new AppError(404, "NOT_FOUND", "Evidence not found");
    const task = await accessibleTask(db, actor, String(evidence.taskId));
    const elevated = actor.membership.role === "admin" || actor.membership.role === "venture_head" || task.reviewerId === actor.id;
    if (!elevated) throw new AppError(403, "FORBIDDEN", "Only the assigned reviewer or venture lead may review evidence");
    if (evidence.submittedBy === actor.id && actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "You cannot review evidence you submitted; ask the assigned reviewer or a venture lead");
    if (task.assigneeId === actor.id && actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "You cannot review evidence for your own task; ask the assigned reviewer or another venture lead");
    // A Claude connection never reviews its owner's own work, admins included: a person makes that call in the app.
    if (req.interfaceChannel === "mcp" && (evidence.submittedBy === actor.id || task.assigneeId === actor.id)) throw new AppError(403, "FORBIDDEN", "Claude can't review evidence you submitted or that is on your own task; review it yourself in the app");
    await db.collection("evidence_items").updateOne({ _id: id }, { $set: { reviewStatus: status, reviewedBy: actor.id, reviewedAt: new Date() } });
    // Approval is the assignee's moment: their celebration plays (once per task, so marking it done later won't repeat it).
    if (status !== "rejected" && typeof task.assigneeId === "string" && task.assigneeId && !["cancelled", "done"].includes(String(task.status))) await recordCelebration(db, { workspaceId: actor.membership.workspaceId, userId: task.assigneeId, taskId: String(task._id), trigger: "approved", actorId: actor.id });
    const reviewed = await db.collection("evidence_items").findOne({ _id: id });
    res.json({ ok: true, data: reviewed ? jsonValue(omitNullFields(reviewed, ["uri"])) : null });
  });

  router.post("/outcomes", async (req, res) => {
    const input = createOutcomeSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "outcome:write", { ventureId: input.ventureId })) throw new AppError(403, "FORBIDDEN", "You cannot create outcomes in this venture");
    assertNotBlank(input, ["title", "description", "successEvidence"]);
    assertOrderedDates(input.startAt, input.reviewAt, "The review date must be after the start date");
    const now = new Date();
    const outcome = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...withDates(input, ["startAt", "reviewAt"]), createdAt: now, updatedAt: now };
    await db.collection("outcomes").insertOne(outcome);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "outcome.create", objectType: "outcome", objectId: String(outcome._id), ventureId: input.ventureId, result: "success" });
    res.status(201).json({ ok: true, data: jsonValue(outcome) });
  });

  router.get("/outcomes", async (req, res) => {
    const actor = req.actor!;
    const ventureId = typeof req.query.ventureId === "string" ? idSchema.parse(req.query.ventureId) : undefined;
    // A requested venture must also be in scope: archived ventures for everyone, and other ventures for members.
    const inScope = !ventureId || (!inArchivedVenture(actor.membership, ventureId) && (actor.membership.role === "admin" || actor.membership.ventureIds.includes(ventureId)));
    const allowed = actor.membership.role === "admin" ? notArchived(actor.membership) : { ventureId: { $in: actor.membership.ventureIds } };
    const items = inScope ? await db.collection("outcomes").find({ workspaceId: actor.membership.workspaceId, $and: [allowed, ventureId ? { ventureId } : {}] }).sort({ reviewAt: 1 }).toArray() : [];
    res.json({ ok: true, data: jsonValue(items) });
  });
  router.patch("/outcomes/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const existing = await db.collection("outcomes").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!existing || inArchivedVenture(actor.membership, existing.ventureId) || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(String(existing.ventureId)))) throw new AppError(404, "NOT_FOUND", "Outcome not found");
    if (!can(actor.membership, "outcome:write", { ventureId: String(existing.ventureId) })) throw new AppError(403, "FORBIDDEN", "You cannot edit this outcome");
    const input = updateOutcomeSchema.parse(req.body);
    assertNotBlank(input, ["title", "description", "successEvidence"]);
    // Only date changes are checked, so status-only updates keep working on older records with inverted dates.
    if (input.startAt || input.reviewAt) assertOrderedDates(input.startAt ?? existing.startAt, input.reviewAt ?? existing.reviewAt, "The review date must be after the start date");
    await db.collection("outcomes").updateOne({ _id: id, workspaceId: actor.membership.workspaceId }, { $set: { ...input, ...(input.startAt ? { startAt: new Date(input.startAt) } : {}), ...(input.reviewAt ? { reviewAt: new Date(input.reviewAt) } : {}), updatedAt: new Date() } });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "outcome.update", objectType: "outcome", objectId: id, ventureId: String(existing.ventureId), result: "success" });
    res.json({ ok: true, data: jsonValue(await db.collection("outcomes").findOne({ _id: id })) });
  });

  router.post("/focus", async (req, res) => {
    const input = startFocusSchema.parse(req.body);
    const actor = req.actor!;
    if (input.taskId) await accessibleTask(db, actor, input.taskId);
    const startedAt = new Date();
    const session = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: actor.id, ...input, startedAt, endsAt: new Date(startedAt.getTime() + input.plannedMinutes * 60_000) };
    await db.collection("focus_sessions").insertOne(session);
    res.status(201).json({ ok: true, data: jsonValue(session) });
  });

  router.get("/focus/current", async (req, res) => {
    const actor = req.actor!;
    const session = await db.collection("focus_sessions").findOne({ workspaceId: actor.membership.workspaceId, userId: actor.id, completedAt: { $exists: false }, cancelledAt: { $exists: false } }, { sort: { startedAt: -1 } });
    res.json({ ok: true, data: jsonValue(session) });
  });
  router.get("/focus/history", async (req, res) => {
    const actor = req.actor!; const query = cursorQuerySchema.parse(req.query);
    const scope = { workspaceId: actor.membership.workspaceId, userId: actor.id };
    const cursor = query.cursor ? await db.collection("focus_sessions").findOne({ _id: idSchema.parse(query.cursor), ...scope, completedAt: { $exists: true } }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Focus cursor not found");
    const after = cursor ? { $or: [{ startedAt: { $lt: cursor.startedAt } }, { startedAt: cursor.startedAt, _id: { $lt: cursor._id } }] } : {};
    const rows = await db.collection("focus_sessions").find({ ...scope, completedAt: { $exists: true }, ...after }).sort({ startedAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(rows.slice(0, query.limit)), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?._id) : undefined } });
  });

  // Pause and resume are single atomic updates on the caller's own active session, so a double click can't apply twice.
  const activeFocus = (actor: { id: string; membership: { workspaceId: string } }, id: string) => ({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id, completedAt: { $exists: false }, cancelledAt: { $exists: false } });
  router.post("/focus/:id/pause", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id); const now = new Date();
    const updated = await db.collection("focus_sessions").findOneAndUpdate({ ...activeFocus(actor, id), pausedAt: { $exists: false }, endsAt: { $gt: now } }, { $set: { pausedAt: now } }, { returnDocument: "after" });
    if (!updated) throw new AppError(409, "CONFLICT", "Only a running focus session with time left can be paused");
    res.json({ ok: true, data: jsonValue(updated) });
  });
  router.post("/focus/:id/resume", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id); const now = new Date();
    const paused = { $subtract: [now, "$pausedAt"] };
    const updated = await db.collection("focus_sessions").findOneAndUpdate({ ...activeFocus(actor, id), pausedAt: { $exists: true } },
      [{ $set: { endsAt: { $add: ["$endsAt", paused] }, pausedMs: { $add: [{ $ifNull: ["$pausedMs", 0] }, paused] } } }, { $unset: "pausedAt" }], { returnDocument: "after" });
    if (!updated) throw new AppError(409, "CONFLICT", "Only a paused focus session can be resumed");
    res.json({ ok: true, data: jsonValue(updated) });
  });

  router.post("/focus/:id/complete", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id); const now = new Date();
    // Finishing while paused counts the pause up to now, so `pausedMs` always holds every paused moment.
    const result = await db.collection("focus_sessions").updateOne(activeFocus(actor, id), [
      { $set: { completedAt: now, pausedMs: { $add: [{ $ifNull: ["$pausedMs", 0] }, { $cond: [{ $ifNull: ["$pausedAt", false] }, { $subtract: [now, "$pausedAt"] }, 0] }] } } },
      { $unset: "pausedAt" },
    ]);
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "Active focus session not found");
    res.json({ ok: true, data: jsonValue(await db.collection("focus_sessions").findOne({ _id: id })) });
  });

  router.get("/task-filters", async (req, res) => {
    const actor = req.actor!; res.json({ ok: true, data: jsonValue(await db.collection("task_filters").find({ workspaceId: actor.membership.workspaceId, userId: actor.id }).sort({ name: 1 }).toArray()) });
  });
  router.put("/task-filters/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const input = z.object({ name: z.string().trim().min(1).max(100), filters: taskListQuerySchema.omit({ cursor: true, limit: true, counts: true }) }).parse(req.body);
    await db.collection("task_filters").updateOne({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { ...input, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ ok: true, data: jsonValue(await db.collection("task_filters").findOne({ _id: id })) });
  });

  // A member's own reminder at a time, optionally about a task they can open (used by the app and by Claude via MCP).
  router.post("/reminders", async (req, res) => {
    const actor = req.actor!; const input = createReminderSchema.parse(req.body); const now = new Date();
    const at = new Date(input.at);
    if (at.getTime() < now.getTime() + 60_000 || at.getTime() > now.getTime() + 366 * 86_400_000) throw new AppError(400, "BAD_REQUEST", "Pick a time between one minute and one year from now");
    const task = input.taskId ? await accessibleTask(db, actor, input.taskId) : null;
    const pending = await db.collection("reminders").countDocuments({ workspaceId: actor.membership.workspaceId, userId: actor.id, kind: "personal", state: "scheduled" });
    if (pending >= 200) throw new AppError(409, "CONFLICT", "You have 200 upcoming personal reminders; let some fire or snooze them first");
    const reminder = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: actor.id, kind: "personal", message: input.message, scheduledAt: at, repeatMinutes: null, state: "scheduled", sequence: 0, ...(task ? { taskId: task._id, ventureId: task.ventureId } : {}), createdAt: now, updatedAt: now };
    await atomic(database, async (session) => {
      await db.collection("reminders").insertOne(reminder, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "reminder.create", objectType: "reminder", objectId: reminder._id, ...(task ? { ventureId: String(task.ventureId) } : {}), result: "success" }, session);
    });
    res.status(201).json({ ok: true, data: jsonValue(reminder) });
  });
  router.get("/reminders", async (req, res) => {
    const actor = req.actor!; const query = cursorQuerySchema.parse(req.query);
    const scope = { workspaceId: actor.membership.workspaceId, userId: actor.id };
    // ?upcoming=true: the soonest scheduled reminders first (one page, no cursor).
    if (req.query.upcoming === "true") {
      const rows = await db.collection("reminders").find({ ...scope, state: "scheduled", ...await notArchivedReminders(db, actor) }).sort({ scheduledAt: 1, _id: 1 }).limit(query.limit).toArray();
      res.json({ ok: true, data: { items: jsonValue(rows) } });
      return;
    }
    const cursor = query.cursor ? await db.collection("reminders").findOne({ _id: idSchema.parse(query.cursor), ...scope }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Reminder cursor not found");
    const after = cursor ? { $or: [{ scheduledAt: { $lt: cursor.scheduledAt } }, { scheduledAt: cursor.scheduledAt, _id: { $lt: cursor._id } }] } : {};
    const rows = await db.collection("reminders").find({ ...scope, ...after, ...await notArchivedReminders(db, actor) }).sort({ scheduledAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(rows.slice(0, query.limit)), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?._id) : undefined } });
  });
  router.get("/reminders/:id", async (req, res) => {
    const actor = req.actor!;
    const item = await db.collection("reminders").findOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId, userId: actor.id, ...await notArchivedReminders(db, actor) });
    if (!item) throw new AppError(404, "NOT_FOUND", "Reminder not found");
    res.json({ ok: true, data: jsonValue(item) });
  });
  router.post("/reminders/:id/snooze", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const { minutes } = snoozeSchema.parse(req.body);
    const actor = req.actor!;
    const reminder = await db.collection("reminders").findOne({ _id: id, workspaceId: actor.membership.workspaceId, userId: actor.id, ...await notArchivedReminders(db, actor) });
    if (!reminder) throw new AppError(404, "NOT_FOUND", "Reminder not found");
    if (reminder.state === "claimed") throw new AppError(409, "CONFLICT", "Reminder is currently being delivered; retry snooze shortly");
    if (reminder.state === "cancelled" || (reminder.state === "completed" && reminder.completionReason !== "delivered")) throw new AppError(409, "CONFLICT", "A terminal reminder cannot be snoozed");
    // Start-of-task nudges stop once work starts; a personal reminder is the person's own note and can always be snoozed.
    if (reminder.taskId && reminder.kind !== "personal") {
      const task = await db.collection("tasks").findOne({ _id: reminder.taskId, workspaceId: actor.membership.workspaceId });
      if (task?.startedAt || task?.completedAt || ["done", "cancelled"].includes(String(task?.status))) throw new AppError(409, "CONFLICT", "A reminder for started or terminal work cannot be snoozed");
    }
    // A repeating reminder is rescheduled one repeat ahead right after delivery; snoozing then counts from now, not from that slot.
    const snoozedAt = new Date();
    const nextSlot = reminder.scheduledAt ? new Date(reminder.scheduledAt as Date | string).getTime() : Number.NaN;
    // The two-minute margin absorbs clock skew between the worker that set the slot and this API.
    const farAhead = Number.isFinite(nextSlot) && nextSlot - snoozedAt.getTime() > Number(reminder.repeatMinutes ?? 0) * 60_000 + 120_000;
    const scheduledAt = snoozeReminder(snoozedAt, minutes, farAhead ? reminder.scheduledAt as Date | string : undefined);
    const allowedStates = reminder.state === "completed" ? ["completed"] : ["scheduled"];
    const update = scheduledAt
      ? { $set: { scheduledAt, state: "scheduled", updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "", completionReason: "" }, $inc: { sequence: 1 } }
      : { $set: { state: "cancelled", cancelReason: "never", updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "" } };
    await atomic(database, async (session) => {
      const changed = await db.collection("reminders").updateOne({ _id: id, state: { $in: allowedStates }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] }, update, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Reminder changed while snoozing; reload and try again");
      await db.collection("notification_outbox").updateMany({ reminderId: id, state: "pending" }, { $set: { state: "cancelled", updatedAt: new Date() } }, { session });
    });
    res.json({ ok: true, data: jsonValue(await db.collection("reminders").findOne({ _id: id })) });
  });
  return router;
}

/** Reminders of archived ventures (by their task, or the channel venture of a /remind) stay hidden and frozen until restore. */
async function notArchivedReminders(db: AppDb, actor: NonNullable<Express.Request["actor"]>): Promise<Record<string, unknown>> {
  const archived = actor.membership.archivedVentureIds ?? [];
  if (!archived.length) return {};
  const tasks = await db.collection("tasks").find({ workspaceId: actor.membership.workspaceId, ventureId: { $in: archived } }, { projection: { _id: 1 } }).toArray();
  return { taskId: { $nin: tasks.map((task) => task._id) }, ventureId: { $nin: archived } };
}

async function accessibleTask(db: AppDb, actor: NonNullable<Express.Request["actor"]>, id: string) {
  const task = await db.collection("tasks").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
  if (!task || inArchivedVenture(actor.membership, task.ventureId) || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(task.ventureId)) || !actor.membership.groupIds.includes(String(task.groupId))))) throw new AppError(404, "NOT_FOUND", "Task not found");
  return task;
}

async function assertAssignableMember(db: AppDb, workspaceId: string, userId: string, ventureId: string, groupId: string, who: "Assignee" | "Reviewer", session?: import("mongodb").ClientSession): Promise<void> {
  const membership = await db.collection("memberships").findOne(assignableMembership(workspaceId, userId, ventureId, groupId), { session });
  if (!membership) throw new AppError(400, "BAD_REQUEST", `${who} is not an active member of this venture and group`);
}

async function fenceAssignableMember(db: AppDb, workspaceId: string, userId: string, ventureId: string, groupId: string, who: "Assignee" | "Reviewer", session?: import("mongodb").ClientSession): Promise<void> {
  const membership = await db.collection("memberships").findOneAndUpdate(assignableMembership(workspaceId, userId, ventureId, groupId), { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
  if (!membership) throw new AppError(400, "BAD_REQUEST", `${who} is not an active member of this venture and group`);
}

async function assertTaskScope(db: AppDb, workspaceId: string, input: { ventureId: string; groupId: string; channelId?: string; outcomeId?: string; parentTaskId?: string; dependencies: string[] }): Promise<void> {
  const group = await db.collection("groups").findOne({ _id: input.groupId, workspaceId, ventureId: input.ventureId });
  if (!group) throw new AppError(400, "BAD_REQUEST", "Task group does not belong to the selected venture");
  if (input.channelId && !await db.collection("channels").findOne({ _id: input.channelId, workspaceId, ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(400, "BAD_REQUEST", "Task channel does not belong to the selected group");
  if (input.outcomeId && !await db.collection("outcomes").findOne({ _id: input.outcomeId, workspaceId, ventureId: input.ventureId })) throw new AppError(400, "BAD_REQUEST", "Task outcome does not belong to the selected venture");
  const relatedIds = [...new Set([...(input.parentTaskId ? [input.parentTaskId] : []), ...input.dependencies])];
  if (relatedIds.length) {
    const related = await db.collection("tasks").countDocuments({ _id: { $in: relatedIds }, workspaceId, ventureId: input.ventureId, groupId: input.groupId });
    if (related !== relatedIds.length) throw new AppError(400, "BAD_REQUEST", "Parent and dependency tasks must belong to the selected venture and group");
  }
}
