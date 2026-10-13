import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { AppDb } from "../db.js";
import { commandExecuteSchema, commandPreviewRequestSchema, commandPreviewSchema } from "@venture-studio/contracts";
import { can, CommandSyntaxError, previewCommand } from "@venture-studio/core";
import type { Database } from "../db.js";
import { atomic } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { inArchivedVenture } from "../archive-scope.js";
import { assignableMembership, listedInOrAdmin } from "../assignable.js";
import { jsonValue } from "../json.js";

export function commandRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  router.post("/commands/preview", async (req, res) => {
    const input = commandPreviewRequestSchema.parse(req.body);
    const actor = req.actor!;
    const channel = await accessibleChannel(db, actor, input.channelId);
    let preview;
    try { preview = previewCommand(input.input); }
    catch (error) { if (error instanceof CommandSyntaxError) throw new AppError(400, "BAD_REQUEST", error.message); throw error; }
    assertCommandManager(actor.membership, String(channel.ventureId), String(channel.groupId));
    await db.collection("command_previews").insertOne({ _id: preview.previewId, workspaceId: actor.membership.workspaceId, actorId: actor.id, channelId: input.channelId, ventureId: channel.ventureId, groupId: channel.groupId, ...preview, expiresAt: new Date(preview.expiresAt), createdAt: new Date() });
    res.status(201).json({ ok: true, data: preview });
  });

  router.post("/commands/execute", async (req, res) => {
    const input = commandExecuteSchema.parse(req.body);
    const actor = req.actor!;
    const previous = await db.collection("command_executions").findOne({ workspaceId: actor.membership.workspaceId, actorId: actor.id, idempotencyKey: input.idempotencyKey });
    if (previous) {
      if (previous.preview?.previewId !== input.previewId) throw new AppError(409, "CONFLICT", "Idempotency key was used for another preview");
      return void res.json({ ok: true, data: jsonValue(previous.result) });
    }
    const stored = await db.collection("command_previews").findOne({ _id: input.previewId, workspaceId: actor.membership.workspaceId, actorId: actor.id });
    if (!stored || (stored.expiresAt as Date).getTime() <= Date.now()) throw new AppError(409, "STALE_PREVIEW", "Command preview expired; preview it again");
    const preview = commandPreviewSchema.parse({ ...stored, previewId: stored._id, expiresAt: (stored.expiresAt as Date).toISOString() });
    const channel = await accessibleChannel(db, actor, String(stored.channelId));
    if (String(channel.ventureId) !== String(stored.ventureId) || String(channel.groupId) !== String(stored.groupId)) throw new AppError(409, "STALE_PREVIEW", "Command scope changed; preview it again");
    assertCommandManager(actor.membership, String(stored.ventureId), String(stored.groupId));
    const target = await resolveUser(db, actor.membership.workspaceId, String(stored.ventureId), String(stored.groupId), preview.command.kind === "assign" ? preview.command.assignee : preview.command.recipient);
    const fenceCommandMembers = async (session?: import("mongodb").ClientSession) => {
      const currentActor = await db.collection("memberships").findOneAndUpdate({ workspaceId: actor.membership.workspaceId, userId: actor.id, status: "active" }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
      if (!currentActor) throw new AppError(403, "FORBIDDEN", "Command access denied");
      assertCommandManager(currentActor as unknown as NonNullable<Express.Request["actor"]>["membership"], String(stored.ventureId), String(stored.groupId));
      const currentTarget = await db.collection("memberships").findOneAndUpdate(assignableMembership(actor.membership.workspaceId, String(target._id), String(stored.ventureId), String(stored.groupId)), { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
      if (!currentTarget) throw new AppError(404, "NOT_FOUND", "Command recipient is no longer in this group");
    };
    const now = new Date();
    const scheduledAt = preview.command.kind === "assign" ? preview.command.dueAt : preview.command.scheduledAt;
    if (new Date(scheduledAt).getTime() <= now.getTime()) throw new AppError(409, "STALE_PREVIEW", "Command time has passed; preview it again");
    let result: Record<string, unknown>;
    try {
    if (preview.command.kind === "assign") {
      const taskId = randomUUID();
      const dueAt = new Date(preview.command.dueAt);
      const latestStartAt = new Date(dueAt.getTime() - preview.command.estimatedMinutes * 60_000);
      const task = { _id: taskId, workspaceId: actor.membership.workspaceId, ventureId: stored.ventureId, groupId: stored.groupId, channelId: stored.channelId, title: preview.command.title, outcome: preview.command.title, assigneeId: target._id, creatorId: actor.id, priority: "medium", status: "proposed", dueAt, timezone: preview.command.timezone, estimatedMinutes: preview.command.estimatedMinutes, definitionOfDone: preview.command.title, evidenceRequirement: "Evidence link or reviewed exception", dependencies: [], evidenceLinks: [], tags: [], deadlineRisk: latestStartAt <= now, createdAt: now, updatedAt: now };
      const reminder = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: target._id, taskId, kind: "task_start", message: `Start: ${task.title}`, scheduledAt: latestStartAt > now ? latestStartAt : now, timezone: preview.command.timezone, repeatMinutes: 10, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now };
      result = { task, reminder };
      await atomic(database, async (session) => {
        await fenceCommandMembers(session);
        await db.collection("tasks").insertOne(task, { session });
        await db.collection("reminders").insertOne(reminder, { session });
        await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: target._id, type: "assignment", title: task.title, body: task.outcome, resourceType: "task", resourceId: taskId, idempotencyKey: `task:${taskId}:assigned`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
        await recordExecution(db, actor, input.idempotencyKey, preview, result, session);
      });
    } else {
      // The channel's venture travels with the reminder so archiving or deleting the venture also holds or removes it.
      const reminder = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: target._id, ventureId: stored.ventureId, channelId: stored.channelId, message: preview.command.message, scheduledAt: new Date(preview.command.scheduledAt), timezone: preview.command.timezone, repeatMinutes: null, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now };
      result = { reminder };
      await atomic(database, async (session) => {
        await fenceCommandMembers(session);
        await db.collection("reminders").insertOne(reminder, { session });
        await recordExecution(db, actor, input.idempotencyKey, preview, result, session);
      });
    }
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const replay = await db.collection("command_executions").findOne({ workspaceId: actor.membership.workspaceId, actorId: actor.id, idempotencyKey: input.idempotencyKey });
        if (replay) {
          if (replay.preview?.previewId !== input.previewId) throw new AppError(409, "CONFLICT", "Idempotency key was used for another preview");
          return void res.json({ ok: true, data: jsonValue(replay.result) });
        }
      }
      throw error;
    }
    res.status(201).json({ ok: true, data: jsonValue(result) });
  });
  return router;
}

function assertCommandManager(membership: NonNullable<Express.Request["actor"]>["membership"], ventureId: string, groupId: string): void {
  if ((membership.role !== "admin" && membership.role !== "venture_head") || !can(membership, "task:create", { ventureId, groupId })) throw new AppError(403, "FORBIDDEN", "Only a venture lead or workspace admin may run /assign or /notify");
}

async function accessibleChannel(db: AppDb, actor: NonNullable<Express.Request["actor"]>, id: string) {
  const channel = await db.collection("channels").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
  if (!channel || inArchivedVenture(actor.membership, channel.ventureId) || (actor.membership.role !== "admin" && !actor.membership.groupIds.includes(String(channel.groupId)))) throw new AppError(404, "NOT_FOUND", "Channel not found");
  return channel;
}

async function resolveUser(db: AppDb, workspaceId: string, ventureId: string, groupId: string, handle: string) {
  // Group members and workspace admins, the same people a task here can be assigned to.
  const members = await db.collection("memberships").find({ workspaceId, status: "active", ...listedInOrAdmin(ventureId, groupId) }).project({ userId: 1 }).toArray();
  const ids = members.map((member) => member.userId);
  const exact = { $regex: `^${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" };
  for (const field of ["handle", "email", "name"] as const) {
    const users = await db.collection("users").find({ workspaceId, status: "active", _id: { $in: ids }, [field]: exact }).limit(2).toArray();
    if (users.length > 1) throw new AppError(409, "CONFLICT", "Command recipient is ambiguous in this group");
    if (users[0]) return users[0];
  }
  throw new AppError(404, "NOT_FOUND", "Command recipient not found in this venture and group");
}

async function recordExecution(db: AppDb, actor: NonNullable<Express.Request["actor"]>, idempotencyKey: string, preview: unknown, result: unknown, session: import("mongodb").ClientSession | undefined) {
  await db.collection("command_executions").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, actorId: actor.id, idempotencyKey, preview, result, createdAt: new Date() }, { session });
  await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "command.execute", objectType: "command", objectId: idempotencyKey, result: "success" }, session);
}
