import { createHash, randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { daysBetween, eventReminderDocs, eventReminderIdFor, eventReminderStillDue, eventReminderText, reminderPeople, retryAt, type ReminderEvent } from "@venture-studio/core";
import { eventAudience } from "./event-audience.js";
import type { WorkerConfig } from "./config.js";
import { Delivery } from "./delivery.js";
import { reminderTransition } from "./rules.js";

// How long a reminder or notice for an archived venture waits before it is checked again.
const HOLD_MS = 6 * 60 * 60_000;
// Calendar reminders are planned a few days ahead (the API does it on every change); this keeps repeating events going.
const PLAN_EVERY_MS = 5 * 60_000;
const PLAN_HORIZON_MS = 3 * 86_400_000;
const PLAN_PAGE = 500;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export class Worker {
  private readonly delivery: Delivery;
  private plannedAt = 0;
  constructor(private readonly client: MongoClient, private readonly db: Db, private readonly config: WorkerConfig, private readonly transactions: boolean) { this.delivery = new Delivery(db, config); }
  async tick(now = new Date()): Promise<boolean> {
    if (now.getTime() - this.plannedAt >= PLAN_EVERY_MS) {
      this.plannedAt = now.getTime();
      await this.planEventReminders(now).catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "worker.calendar_plan.failed", error: error instanceof Error ? error.message : "unknown" })));
    }
    const reminder = await this.claim("reminders", { $or: [{ state: "scheduled", scheduledAt: { $lte: now }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] }, { state: "claimed", leaseUntil: { $lte: now } }] }, now);
    if (reminder) { await this.processReminder(reminder, now); return true; }
    const outbox = await this.claim("notification_outbox", { $or: [{ state: "pending", nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] }, { state: "claimed", leaseUntil: { $lte: now } }] }, now);
    if (outbox) { await this.processOutbox(outbox, now); return true; }
    return false;
  }
  private async claim(collection: string, filter: Record<string, unknown>, now: Date) {
    return this.db.collection(collection).findOneAndUpdate(filter, { $set: { state: "claimed", claimedBy: this.config.WORKER_ID, leaseUntil: new Date(now.getTime() + 60_000), updatedAt: now } }, { sort: collection === "reminders" ? { scheduledAt: 1 } : { nextAttemptAt: 1 }, returnDocument: "after" });
  }
  private async transaction(work: (session?: import("mongodb").ClientSession) => Promise<void>): Promise<void> {
    if (!this.transactions) return work();
    await this.client.withSession((session) => session.withTransaction(() => work(session)));
  }
  /**
   * Writes the reminders that events due in the next few days need, for the people who can still open them. Ids are stable
   * per occurrence, person, and offset, so this is safe to repeat (and to run on several workers): existing reminders,
   * delivered or not, are kept. Events are read a page at a time, and one that fails doesn't stop the others.
   */
  async planEventReminders(now: Date): Promise<number> {
    const filter = { deletedAt: { $exists: false }, startAt: { $lte: new Date(now.getTime() + PLAN_HORIZON_MS + 2 * 86_400_000) }, $or: [{ seriesEndAt: null }, { seriesEndAt: { $gte: now } }] };
    let written = 0; let after: unknown;
    for (;;) {
      const page = await this.db.collection("calendar_events").find(after === undefined ? filter : { ...filter, _id: { $gt: after as never } }).sort({ _id: 1 }).limit(PLAN_PAGE).toArray();
      for (const event of page) {
        try { written += await this.planEvent(event, now); }
        catch (error) { console.error(JSON.stringify({ level: "error", event: "worker.calendar_plan.event_failed", eventId: String(event._id), error: error instanceof Error ? error.message : "unknown" })); }
      }
      if (page.length < PLAN_PAGE) return written;
      after = page[page.length - 1]!._id;
    }
  }

  private async planEvent(event: Record<string, any>, now: Date): Promise<number> {
    if (await this.ventureArchived(event.workspaceId, event.ventureId)) return 0;
    const allowed = [...await eventAudience(this.db, event, reminderPeople(event as unknown as ReminderEvent).map((person) => person.userId))];
    const docs = allowed.length ? eventReminderDocs(event as unknown as ReminderEvent, now, PLAN_HORIZON_MS, sha, allowed) : [];
    if (!docs.length) return 0;
    const result = await this.db.collection("reminders").bulkWrite(docs.map((doc) => ({ updateOne: { filter: { _id: doc._id as never }, update: { $setOnInsert: doc }, upsert: true } })), { ordered: false });
    return result.upsertedCount;
  }

  /**
   * A calendar reminder, delivered only while it still fits the event (that date at that time, the person still coming with
   * that offset chosen) and the person can still open it. A title or description change doesn't stop it.
   */
  private async processEventReminder(reminder: Record<string, any>, now: Date): Promise<void> {
    await this.transaction(async (session) => {
      const event = await this.db.collection("calendar_events").findOne({ _id: reminder.eventId, workspaceId: reminder.workspaceId }, { session });
      const cancel = (reason: string) => this.db.collection("reminders").updateOne({ _id: reminder._id, state: "claimed", claimedBy: this.config.WORKER_ID }, { $set: { state: "cancelled", cancelReason: reason, updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
      // A reminder planned under another id for the same moment (an earlier build's, say) is superseded, never sent twice.
      if (event && reminder._id !== eventReminderIdFor(event as unknown as ReminderEvent, reminder as never, sha)) { await cancel("superseded"); return; }
      if (!event || event.deletedAt || !eventReminderStillDue(event as unknown as ReminderEvent, reminder as never)) { await cancel("event_changed"); return; }
      if (await this.ventureArchived(reminder.workspaceId, event.ventureId)) {
        await this.db.collection("reminders").updateOne({ _id: reminder._id, state: "claimed", claimedBy: this.config.WORKER_ID }, { $set: { state: "scheduled", scheduledAt: new Date(now.getTime() + HOLD_MS), heldForArchive: true, updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
        return;
      }
      if (!(await eventAudience(this.db, event, [String(reminder.userId)], session)).has(String(reminder.userId))) { await cancel("no_access"); return; }
      const occurrenceStart = new Date(reminder.occurrenceStart);
      // Too late to be useful once the occurrence is over (a reminder held while its venture was archived, for example).
      const length = event.allDay ? daysBetween(String(event.startDate), String(event.endDate)) * 86_400_000 : new Date(event.endAt).getTime() - new Date(event.startAt).getTime();
      const late = now.getTime() > occurrenceStart.getTime() + Math.max(0, length);
      const updated = await this.db.collection("reminders").updateOne({ _id: reminder._id, state: "claimed", claimedBy: this.config.WORKER_ID }, { $set: { state: late ? "cancelled" : "completed", ...(late ? { cancelReason: "too_late" } : { completionReason: "delivered" }), updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
      if (!updated.matchedCount || late) return;
      const key = `reminder:${reminder._id}:${reminder.sequence}`;
      await this.db.collection("notification_outbox").updateOne({ idempotencyKey: key }, { $setOnInsert: { _id: randomUUID(), workspaceId: reminder.workspaceId, userId: reminder.userId, type: "reminder", title: "Calendar", body: eventReminderText(String(event.title), occurrenceStart, Boolean(event.allDay), Number(reminder.minutes), now), resourceType: "event", resourceId: event._id, reminderId: reminder._id, ...(event.ventureId ? { ventureId: event.ventureId } : {}), idempotencyKey: key, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now } }, { upsert: true, session });
    });
  }

  private async processReminder(reminder: Record<string, any>, now: Date): Promise<void> {
    if (reminder.kind === "event") return this.processEventReminder(reminder, now);
    await this.transaction(async (session) => {
      const task = reminder.taskId ? await this.db.collection("tasks").findOne({ _id: reminder.taskId, workspaceId: reminder.workspaceId }, { session }) : null;
      // Hold reminders of archived ventures: re-check later, and restoring the venture re-arms them (heldForArchive).
      if (await this.ventureArchived(reminder.workspaceId, task ? task.ventureId : reminder.ventureId)) {
        await this.db.collection("reminders").updateOne({ _id: reminder._id, state: "claimed", claimedBy: this.config.WORKER_ID }, { $set: { state: "scheduled", scheduledAt: new Date(now.getTime() + HOLD_MS), heldForArchive: true, updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
        return;
      }
      // A personal reminder is the person's own note: deliver it whatever state the task is in.
      const taskState = task && reminder.kind !== "personal" ? { startedAt: task.startedAt as Date | undefined, completedAt: task.completedAt as Date | undefined, status: task.status as string | undefined } : null;
      const transition = reminderTransition({ repeatMinutes: reminder.repeatMinutes as number | null, sequence: Number(reminder.sequence) }, taskState, now);
      const updated = await this.db.collection("reminders").updateOne({ _id: reminder._id, state: "claimed", claimedBy: this.config.WORKER_ID }, { $set: { state: transition.state, completionReason: transition.state === "completed" ? transition.reason : undefined, sequence: transition.nextSequence, ...(transition.nextAt ? { scheduledAt: transition.nextAt } : {}), updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } }, { session });
      if (!updated.matchedCount || !transition.shouldDeliver) return;
      const key = `reminder:${reminder._id}:${reminder.sequence}`;
      await this.db.collection("notification_outbox").updateOne({ idempotencyKey: key }, { $setOnInsert: { _id: randomUUID(), workspaceId: reminder.workspaceId, userId: reminder.userId, type: "reminder", title: "Reminder", body: reminder.message, ...(reminder.kind === "personal" ? { kind: "personal" } : {}), resourceType: reminder.leadId ? "opportunity" : reminder.taskId ? "task" : "reminder", resourceId: reminder.leadId ?? reminder.taskId ?? reminder._id, reminderId: reminder._id, idempotencyKey: key, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now } }, { upsert: true, session });
    });
  }
  private async processOutbox(item: Record<string, any>, now: Date): Promise<void> {
    try {
      if (await this.forArchivedVenture(item)) {
        await this.db.collection("notification_outbox").updateOne({ _id: item._id, claimedBy: this.config.WORKER_ID }, { $set: { state: "pending", nextAttemptAt: new Date(now.getTime() + HOLD_MS), heldForArchive: true, updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } });
        return;
      }
      if (await this.isStaleTaskNotice(item)) {
        await this.db.collection("notification_outbox").updateOne({ _id: item._id, claimedBy: this.config.WORKER_ID }, { $set: { state: "cancelled", cancelReason: "task_changed", updatedAt: now }, $unset: { leaseUntil: "", claimedBy: "" } });
        return;
      }
      await this.delivery.send(item);
      await this.db.collection("notification_outbox").updateOne({ _id: item._id, claimedBy: this.config.WORKER_ID }, { $set: { state: "delivered", deliveredAt: new Date(), adapter: this.delivery.mode, updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "", lastError: "" } });
    } catch (error) {
      const attempts = Number(item.attempts ?? 0) + 1;
      await this.db.collection("notification_outbox").updateOne({ _id: item._id, claimedBy: this.config.WORKER_ID }, { $set: { state: attempts >= 8 ? "dead" : "pending", attempts, nextAttemptAt: retryAt(attempts, now), lastError: error instanceof Error ? error.message.slice(0, 500) : "Unknown delivery error", updatedAt: new Date() }, $unset: { leaseUntil: "", claimedBy: "" } });
    }
  }

  private async ventureArchived(workspaceId: unknown, ventureId: unknown): Promise<boolean> {
    return typeof ventureId === "string" && Boolean(await this.db.collection("ventures").findOne({ _id: ventureId as never, workspaceId, status: "archived" }, { projection: { _id: 1 } }));
  }

  /** Whether an outbox item points at a task, channel, or channel message inside an archived venture. */
  private async forArchivedVenture(item: Record<string, any>): Promise<boolean> {
    if (item.resourceType === "event") {
      const event = await this.db.collection("calendar_events").findOne({ _id: item.resourceId, workspaceId: item.workspaceId }, { projection: { ventureId: 1 } });
      return Boolean(event?.ventureId && await this.ventureArchived(item.workspaceId, event.ventureId));
    }
    if (item.resourceType === "task") {
      const task = await this.db.collection("tasks").findOne({ _id: item.resourceId, workspaceId: item.workspaceId }, { projection: { ventureId: 1 } });
      return Boolean(task && await this.ventureArchived(item.workspaceId, task.ventureId));
    }
    let channelId = item.chatKind === "channel" ? item.chatId : undefined;
    if (!channelId && item.resourceType === "message") channelId = (await this.db.collection("messages").findOne({ _id: item.resourceId, workspaceId: item.workspaceId }, { projection: { channelId: 1 } }))?.channelId;
    if (typeof channelId !== "string") return false;
    const channel = await this.db.collection("channels").findOne({ _id: channelId as never, workspaceId: item.workspaceId }, { projection: { ventureId: 1 } });
    return Boolean(channel && await this.ventureArchived(item.workspaceId, channel.ventureId));
  }

  private async isStaleTaskNotice(item: Record<string, any>): Promise<boolean> {
    if (item.resourceType !== "task" || !["assignment", "deadline_warning", "reminder"].includes(item.type) || item.kind === "personal") return false;
    const task = await this.db.collection("tasks").findOne({ _id: item.resourceId, workspaceId: item.workspaceId });
    if (!task || task.assigneeId !== item.userId) return true;
    if (item.type === "assignment") return false;
    if (task.startedAt || task.completedAt || ["done", "cancelled"].includes(String(task.status))) return true;
    if (item.type === "deadline_warning") return !task.deadlineRisk;
    if (!item.reminderId) return false;
    const reminder = await this.db.collection("reminders").findOne({ _id: item.reminderId, taskId: task._id, workspaceId: item.workspaceId, userId: item.userId });
    return !reminder || reminder.state === "cancelled" || item.idempotencyKey !== `reminder:${reminder._id}:${Number(reminder.sequence) - 1}`;
  }
}
