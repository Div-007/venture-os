// Reminders and notices for Sales: one reminder per lead for its next action, and the notices the team needs (a reply on your lead,
// a message waiting for approval, a lead that needs you). Reminders use the `reminders` collection the worker already delivers;
// notices go through `notification_outbox` like the won notice, one row per person and event (the idempotency key dedupes).
import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { AppDocument } from "../db.js";
import type { SalesCtx } from "./ctx.js";
import { settingsFor } from "./ctx.js";
import { isExitStage, normalizeStage } from "./rules.js";

const MIN_LEAD_TIME_MS = 60_000;
const SNIPPET = 140;

/** Reminders for a lead's next action are `kind: "sales_next_action"` with the lead's id; the worker delivers them like any reminder. */
export const NEXT_ACTION_REMINDER = "sales_next_action";

/** Stops the lead's waiting reminder (the lead was closed, deleted or flagged do-not-contact). */
export async function cancelNextActionReminders(ctx: SalesCtx, leadId: string, reason: string, now: Date, session?: ClientSession): Promise<void> {
  await ctx.db.collection("reminders").updateMany({ workspaceId: ctx.workspaceId, leadId, kind: NEXT_ACTION_REMINDER, state: "scheduled" }, { $set: { state: "cancelled", cancelReason: reason, updatedAt: now } }, { session });
}

/**
 * Makes the lead's reminder match its next action: one reminder for the owner at `nextActionAt` ("Call again: Acme"), replacing the previous
 * one. No reminder for a date that is not at least a minute ahead, a closed or deleted lead, or one on the do-not-contact list.
 */
export async function syncNextActionReminder(ctx: SalesCtx, leadId: string, now: Date, session?: ClientSession): Promise<void> {
  const lead = await ctx.db.collection("opportunities").findOne({ _id: leadId, workspaceId: ctx.workspaceId }, { session });
  const at = lead?.nextActionAt ? new Date(lead.nextActionAt) : undefined;
  const wanted = Boolean(lead && !lead.deletedAt && !lead.doNotContact && lead.ownerId && at && at.getTime() >= now.getTime() + MIN_LEAD_TIME_MS && !isExitStage(normalizeStage(lead.stage)));
  const current = await ctx.db.collection("reminders").find({ workspaceId: ctx.workspaceId, leadId, kind: NEXT_ACTION_REMINDER, state: "scheduled" }, { session }).toArray();
  const message = wanted ? `${String(lead!.nextAction || "Follow up").trim()}: ${String(lead!.companyName)}`.slice(0, 500) : "";
  if (wanted && current.length === 1 && current[0]!.userId === lead!.ownerId && new Date(current[0]!.scheduledAt).getTime() === at!.getTime() && current[0]!.message === message) return;
  if (current.length) await ctx.db.collection("reminders").updateMany({ _id: { $in: current.map((row) => row._id) } }, { $set: { state: "cancelled", cancelReason: wanted ? "replaced" : "cleared", updatedAt: now } }, { session });
  if (!wanted) return;
  const settings = await settingsFor(ctx, String(lead!.ventureId));
  await ctx.db.collection("reminders").insertOne({ _id: randomUUID(), workspaceId: ctx.workspaceId, userId: String(lead!.ownerId), kind: NEXT_ACTION_REMINDER, leadId, ventureId: String(lead!.ventureId), message, scheduledAt: at!, timezone: settings.timezone, repeatMinutes: null, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now }, { session });
}

type Notice = { userId: string; type: string; title: string; body: string; resourceType: string; resourceId: string; key: string };

/** Queues one notice for one person; the same key is never queued twice. */
async function queueNotice(ctx: SalesCtx, notice: Notice, now: Date, session?: ClientSession): Promise<void> {
  await ctx.db.collection("notification_outbox").updateOne({ idempotencyKey: notice.key }, { $setOnInsert: { _id: randomUUID(), workspaceId: ctx.workspaceId, userId: notice.userId, type: notice.type, title: notice.title.slice(0, 200), body: notice.body.slice(0, 500), resourceType: notice.resourceType, resourceId: notice.resourceId, idempotencyKey: notice.key, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now } }, { upsert: true, session });
}

const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", call: "Call", meeting: "Meeting" };

/** "sales_reply": someone else (a teammate, or Claude) logged an inbound reply on your lead. */
export async function notifyReply(ctx: SalesCtx, lead: AppDocument, activity: AppDocument, now: Date, session?: ClientSession): Promise<void> {
  const owner = String(lead.ownerId);
  if (owner === ctx.actor.id) return;
  const text = String(activity.body ?? "").replace(/\s+/g, " ").trim();
  await queueNotice(ctx, { userId: owner, type: "sales_reply", title: `Reply from ${String(lead.companyName)}`, body: `${CHANNEL_LABEL[String(activity.kind)] ?? "Message"}${text ? `: ${text.slice(0, SNIPPET)}${text.length > SNIPPET ? "..." : ""}` : ""}`, resourceType: "opportunity", resourceId: String(lead._id), key: `activity:${String(activity._id)}:reply` }, now, session);
}

/** "sales_approval": a draft is ready and needs a person's approval before it can be sent: the venture's heads and the admins, once per draft. */
export async function notifyApprovalNeeded(ctx: SalesCtx, lead: AppDocument, draft: AppDocument, now: Date, session?: ClientSession): Promise<void> {
  const people = await ctx.db.collection("memberships").find({ workspaceId: ctx.workspaceId, status: "active", $or: [{ role: "venture_head", ventureIds: lead.ventureId }, { role: "admin" }] }, { session, projection: { userId: 1 } }).toArray();
  const recipients = new Set(people.map((person) => String(person.userId)));
  recipients.delete(ctx.actor.id);
  for (const userId of recipients) {
    await queueNotice(ctx, { userId, type: "sales_approval", title: `Approve a message to ${String(lead.companyName)}`, body: `A ${String(draft.channel).replace("_", " ")} draft passed review and waits for a person's approval before it can be sent.`, resourceType: "sales_draft", resourceId: String(draft._id), key: `draft:${String(draft._id)}:approval:${userId}` }, now, session);
  }
}

/** "sales_needs_you": a verdict left the lead waiting for a person's decision: its owner is told (once per time it lands there). */
export async function notifyNeedsYou(ctx: SalesCtx, lead: AppDocument, verdictId: string, summary: string, now: Date, session?: ClientSession): Promise<void> {
  const owner = String(lead.ownerId);
  // The owner who saved the verdict in the app already sees it; through Claude they do not.
  if (owner === ctx.actor.id && ctx.via === "app") return;
  await queueNotice(ctx, { userId: owner, type: "sales_needs_you", title: `Needs you: ${String(lead.companyName)}`, body: summary || "Claude's verdict needs a person's decision.", resourceType: "opportunity", resourceId: String(lead._id), key: `lead:${String(lead._id)}:needs_you:${verdictId}` }, now, session);
}
