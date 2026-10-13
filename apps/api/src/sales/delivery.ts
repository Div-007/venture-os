// "Create delivery work": a won lead becomes a Venture OS task in the venture's first group and channel, built the way
// POST /tasks builds one (task, start reminder, first update, assignment notice), and linked back as `deliveryTaskId`.
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createTaskSchema, type deliveryWorkInputSchema } from "@venture-studio/contracts";
import { can, hasDeadlineRisk } from "@venture-studio/core";
import { atomic, type AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { assignableMembership } from "../assignable.js";
import { withDates } from "../json.js";
import { forbidden } from "./access.js";
import { auditSales, settingsFor, type SalesCtx } from "./ctx.js";
import { requireLeadEditor } from "./leads.js";
import { isWonStage } from "./rules.js";

const WEEK_MS = 7 * 86_400_000;

export async function createDeliveryWork(ctx: SalesCtx, lead: AppDocument, input: z.infer<typeof deliveryWorkInputSchema>): Promise<{ lead: AppDocument; task: AppDocument }> {
  const { db, actor, workspaceId } = ctx;
  requireLeadEditor(ctx, lead, "create delivery work");
  if (!isWonStage(String(lead.stage))) throw new AppError(409, "CONFLICT", "Delivery work can be created once the deal is won");
  if (lead.deliveryTaskId) throw new AppError(409, "CONFLICT", "Delivery work was already created for this lead");
  const ventureId = String(lead.ventureId);
  if (!can(actor.membership, "task:create", { ventureId })) throw forbidden("Your role cannot create tasks in this venture");
  const assigneeId = input.assigneeId ?? String(lead.ownerId);
  // The first group (oldest first) where the assignee can be given work and this person can create tasks.
  const groups = await db.collection("groups").find({ workspaceId, ventureId }).sort({ createdAt: 1, _id: 1 }).toArray();
  let group: AppDocument | undefined;
  for (const candidate of groups) {
    if (!can(actor.membership, "task:create", { ventureId, groupId: String(candidate._id) })) continue;
    if (await db.collection("memberships").findOne(assignableMembership(workspaceId, assigneeId, ventureId, String(candidate._id)), { projection: { _id: 1 } })) { group = candidate; break; }
  }
  if (!group) throw new AppError(400, "BAD_REQUEST", "No group in this venture has both you and the assignee in it: add the assignee to a group first");
  const groupId = String(group._id);
  const channel = await db.collection("channels").findOne({ workspaceId, ventureId, groupId }, { sort: { createdAt: 1, _id: 1 } });
  const now = new Date();
  const company = String(lead.companyName);
  const dueAt = input.dueAt ?? new Date(now.getTime() + WEEK_MS).toISOString();
  const parsed = createTaskSchema.parse({
    ventureId, groupId, ...(channel ? { channelId: String(channel._id) } : {}), title: input.title ?? `Deliver: ${company}`.slice(0, 200), outcome: `Deliver what was sold to ${company} and hand it over to the client.`,
    assigneeId, priority: "high", dueAt, timezone: (await settingsFor(ctx, ventureId)).timezone, estimatedMinutes: 120,
    definitionOfDone: "The work is delivered and the client has confirmed the handover.", evidenceRequirement: "A note or link showing what was delivered and the client's confirmation.", tags: ["sales", "delivery"],
  });
  const id = randomUUID();
  const deadlineRisk = hasDeadlineRisk(parsed.dueAt, parsed.estimatedMinutes, now);
  const task = { _id: id, workspaceId, ...withDates(parsed, ["dueAt", "reviewAt"]), creatorId: actor.id, status: "proposed", deadlineRisk, createdAt: now, updatedAt: now };
  // Claim the lead first so two requests cannot both create work; give the claim back if the task cannot be written (no transaction locally).
  const claimed = await db.collection("opportunities").updateOne({ _id: lead._id, workspaceId, deliveryTaskId: null, deletedAt: null }, { $set: { deliveryTaskId: id, updatedAt: now } });
  if (!claimed.matchedCount) throw new AppError(409, "CONFLICT", "Delivery work was already created for this lead");
  try {
    await atomic(ctx.database, async (session) => {
      const membership = await db.collection("memberships").findOneAndUpdate({ workspaceId, userId: actor.id, status: "active" }, { $inc: { authorizationFence: 1 } }, { returnDocument: "after", session });
      if (!membership || !can(membership as unknown as Parameters<typeof can>[0], "task:create", { ventureId, groupId })) throw forbidden("You cannot create tasks in this scope");
      if (!await db.collection("memberships").findOneAndUpdate(assignableMembership(workspaceId, assigneeId, ventureId, groupId), { $inc: { authorizationFence: 1 } }, { session })) throw new AppError(400, "BAD_REQUEST", "Assignee is not an active member of this venture and group");
      await db.collection("tasks").insertOne(task, { session });
      const latestStartAt = new Date(new Date(parsed.dueAt).getTime() - parsed.estimatedMinutes * 60_000);
      await db.collection("reminders").insertOne({ _id: randomUUID(), workspaceId, userId: assigneeId, taskId: id, kind: "task_start", message: `Start: ${parsed.title}`, scheduledAt: latestStartAt > now ? latestStartAt : now, timezone: parsed.timezone, repeatMinutes: 10, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now }, { session });
      await db.collection("task_updates").insertOne({ _id: randomUUID(), workspaceId, taskId: id, authorId: actor.id, type: "status", body: "Task proposed", toStatus: "proposed", createdAt: now }, { session });
      await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId, userId: assigneeId, type: "assignment", title: parsed.title, body: parsed.outcome, resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:assigned`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      if (deadlineRisk) await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId, userId: assigneeId, type: "deadline_warning", title: `Deadline risk: ${parsed.title}`, body: "Estimated work exceeds the time remaining before the deadline.", resourceType: "task", resourceId: id, idempotencyKey: `task:${id}:deadline-risk`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      await auditSales(ctx, "sales.lead.delivery_work", "lead", String(lead._id), ventureId, { taskId: id }, session);
      await auditSales(ctx, "task.create", "task", id, ventureId, { source: "sales" }, session);
    });
  } catch (error) {
    await db.collection("opportunities").updateOne({ _id: lead._id, workspaceId, deliveryTaskId: id }, { $unset: { deliveryTaskId: "" } });
    throw error;
  }
  return { lead: (await db.collection("opportunities").findOne({ _id: lead._id, workspaceId }))!, task };
}
