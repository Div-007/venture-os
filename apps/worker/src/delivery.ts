import webpush from "web-push";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { WorkerConfig } from "./config.js";
import { eventAudience } from "./event-audience.js";
import { isTrustedPushEndpoint, readableSensitivities, sharesKnowledge } from "@venture-studio/core";

export class Delivery {
  readonly mode: "local" | "live";
  constructor(private readonly db: Db, private readonly config: WorkerConfig) {
    this.mode = config.RESEND_API_KEY || (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) ? "live" : "local";
    if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  }
  async send(item: Record<string, any>): Promise<void> {
    const user = await this.db.collection("users").findOne({ _id: item.userId, workspaceId: item.workspaceId, status: "active" });
    if (!user) throw new Error("Notification user is inactive");
    const legacyMessage = !item.chatKind && item.resourceType === "message" ? await this.db.collection("messages").findOne({ _id: item.resourceId, workspaceId: item.workspaceId }) : null;
    if (!item.chatKind && item.resourceType === "message" && !legacyMessage) {
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.scopeSkippedAt": new Date() } });
      return;
    }
    // "Someone accepted your invitation" only goes to an inviter who is still a workspace admin.
    if (item.type === "member_joined" && !(await this.db.collection("memberships").findOne({ workspaceId: item.workspaceId, userId: item.userId, status: "active", role: "admin" }))) {
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.scopeSkippedAt": new Date() } });
      return;
    }
    const channelId = item.chatKind === "channel" ? item.chatId : legacyMessage?.channelId;
    if (channelId) {
      const channel = await this.db.collection("channels").findOne({ _id: channelId, workspaceId: item.workspaceId });
      const membership = await this.db.collection("memberships").findOne({ workspaceId: item.workspaceId, userId: item.userId, status: "active" });
      if (!channel || !membership || (membership.role !== "admin" && (!membership.ventureIds?.includes(String(channel.ventureId)) || !membership.groupIds?.includes(String(channel.groupId))))) {
        await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.scopeSkippedAt": new Date() } });
        return;
      }
      // The channel's bell as it is now: a choice changed while this notice waited (or retried) still counts.
      if (item.type === "channel_message" || item.type === "mention") {
        const level = (await this.db.collection("channel_notification_settings").findOne({ workspaceId: item.workspaceId, userId: item.userId, channelId }))?.level ?? "mentions";
        if (level === "off" || (item.type === "channel_message" && level !== "all" && !String(item.idempotencyKey ?? "").startsWith("mention:"))) {
          await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.levelSkippedAt": new Date() } });
          return;
        }
      }
    }
    // Calendar notices (cancellations too) reach only people who can still open the event.
    if (item.resourceType === "event") {
      const event = await this.db.collection("calendar_events").findOne({ _id: item.resourceId, workspaceId: item.workspaceId });
      if (!event || !(await eventAudience(this.db, event, [String(item.userId)])).has(String(item.userId))) {
        await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.scopeSkippedAt": new Date() } });
        return;
      }
    }
    // Knowledge notices reach only people who can still read the document, and review requests only people who can still approve them.
    if (item.resourceType === "document") {
      const [document, membership] = await Promise.all([
        this.db.collection("documents").findOne({ _id: item.resourceId, workspaceId: item.workspaceId, status: { $ne: "archived" } }),
        this.db.collection("memberships").findOne({ workspaceId: item.workspaceId, userId: item.userId, status: "active" }),
      ]);
      const approver = membership ? sharesKnowledge({ role: String(membership.role), canShareKnowledge: membership.canShareKnowledge === true }) : false;
      const readable = Boolean(document && membership) && readableSensitivities(String(membership!.role)).includes(String(document!.sensitivity))
        && (!document!.ventureId || membership!.role === "admin" || (membership!.ventureIds ?? []).includes(String(document!.ventureId)))
        && (!document!.review || approver || document!.ownerId === item.userId)
        && (item.type !== "knowledge_request" || approver);
      if (!readable) {
        await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.scopeSkippedAt": new Date() } });
        return;
      }
    }
    const storedPreferences = await this.db.collection("notification_preferences").findOne({ workspaceId: item.workspaceId, userId: item.userId });
    const preferences = { email: false, webPush: true, mentions: true, messages: true, assignments: true, reminders: true, calendar: true, ...storedPreferences };
    // "Someone accepted your invitation" has no preference switch of its own, so it always arrives in the inbox; nor do
    // knowledge requests and their results, since muting them would leave a request waiting unseen.
    // Calendar invitations, changes, and replies have their own switch; calendar reminders follow the reminders switch.
    // A channel followed for every message has no account-wide switch: the per-channel choice is the switch.
    const category = item.type === "member_joined" || item.type === "channel_message" || String(item.type).startsWith("knowledge_") ? null : String(item.type).startsWith("event_") ? "calendar" : item.type === "mention" ? "mentions" : item.type === "message" ? "messages" : item.type === "assignment" || item.type === "deadline_warning" || String(item.type).startsWith("sales_") ? "assignments" : "reminders";
    if (category && preferences[category] === false) {
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.categorySkippedAt": new Date() } });
      return;
    }
    if (!item.delivery?.inAppAt) {
      await this.db.collection("notifications").updateOne({ outboxId: item._id }, { $setOnInsert: { _id: item._id, outboxId: item._id, workspaceId: item.workspaceId, userId: item.userId, type: item.type, title: item.title, body: item.body, resourceType: item.resourceType, resourceId: item.resourceId, ...(item.chatKind && item.chatId ? { chatKind: item.chatKind, chatId: item.chatId } : {}), ...(item.reminderId ? { reminderId: item.reminderId } : {}), createdAt: new Date() } }, { upsert: true });
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.inAppAt": new Date() } });
    }
    if (this.mode === "local") { console.info(JSON.stringify({ level: "info", adapter: "local", event: "notification", outboxId: item._id, userId: item.userId, type: item.type })); return; }
    // Following a channel's every message would mean an email per message: those stay in the inbox and push.
    if (this.config.RESEND_API_KEY && preferences.email && user.email && !item.delivery?.emailAt && item.type !== "channel_message") {
      const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${this.config.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `vso-${item._id}` }, body: JSON.stringify({ from: this.config.EMAIL_FROM, to: user.email, subject: item.title, text: item.body }) });
      if (!response.ok) throw new Error(`Resend delivery failed: ${response.status}`);
      await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { "delivery.emailAt": new Date() } });
    }
    if (this.config.VAPID_PUBLIC_KEY && this.config.VAPID_PRIVATE_KEY && preferences.webPush) {
      const subscriptions = await this.db.collection("push_subscriptions").find({ workspaceId: item.workspaceId, userId: item.userId, active: true }).toArray();
      // Each device in parallel, each capped at 10 s: one slow push service mustn't hold up everyone else's notices.
      const results = await Promise.allSettled(subscriptions.map(async (subscription) => {
        if (!isTrustedPushEndpoint(String(subscription.endpoint))) {
          await this.db.collection("push_subscriptions").updateOne({ _id: subscription._id, workspaceId: item.workspaceId, userId: item.userId }, { $set: { active: false, invalidEndpointAt: new Date() } });
          return;
        }
        // Best-effort ownership fence before the external send; an in-flight send cannot be recalled.
        const current = await this.db.collection("push_subscriptions").findOne({ _id: subscription._id, workspaceId: item.workspaceId, userId: item.userId, endpoint: subscription.endpoint, active: true });
        if (!current) return;
        const endpointKey = createHash("sha256").update(String(subscription.endpoint)).digest("hex");
        if (item.delivery?.push?.[endpointKey]) return;
        try {
          // Push can race a shared-browser account switch. Keep private details in the authenticated inbox.
          await webpush.sendNotification({ endpoint: current.endpoint, expirationTime: current.expirationTime, keys: current.keys }, JSON.stringify({ notificationId: item._id, ...(item.chatKind && item.chatId ? { chat: { kind: item.chatKind, id: item.chatId } } : {}) }), { topic: createHash("sha256").update(String(item._id)).digest("base64url").slice(0, 32), timeout: 10_000 });
        } catch (error) {
          if (![404, 410].includes(Number((error as { statusCode?: number }).statusCode))) throw error;
          await this.db.collection("push_subscriptions").updateOne({ _id: subscription._id, workspaceId: item.workspaceId, userId: item.userId, endpoint: current.endpoint, keys: current.keys, active: true }, { $set: { active: false, expiredAt: new Date() } });
          return;
        }
        await this.db.collection("notification_outbox").updateOne({ _id: item._id }, { $set: { [`delivery.push.${endpointKey}`]: new Date() } });
      }));
      // A failed device is retried later; the devices that got it are remembered and skipped then.
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    }
  }
}
