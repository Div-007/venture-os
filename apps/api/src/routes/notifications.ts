import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db.js";
import { idSchema, markNotificationsReadSchema, notificationPreferencesSchema } from "@venture-studio/contracts";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { isTrustedPushEndpoint } from "@venture-studio/core";
import { listVisibleNotifications } from "../notification-visibility.js";

const defaultPreferences = { email: false, webPush: true, mentions: true, messages: true, assignments: true, reminders: true };
const subscriptionSchema = z.object({ endpoint: z.url().refine(isTrustedPushEndpoint, "Unsupported push service endpoint").transform((value) => new URL(value).href), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) });
const subscriptionEndpointSchema = subscriptionSchema.pick({ endpoint: true });

export function notificationRoutes(db: AppDb, vapidPublicKey?: string): Router {
  const router = Router();
  router.get("/push-config", (_req, res) => {
    res.json({ ok: true, data: vapidPublicKey ? { available: true, publicKey: vapidPublicKey } : { available: false } });
  });
  router.get("/notifications", async (req, res) => {
    const actor = req.actor!;
    res.json({ ok: true, data: jsonValue(await listVisibleNotifications(db, actor)) });
  });
  // One notice, under the inbox's visibility rules: the browser's notification worker reads it to show who wrote what,
  // so a push never carries message text and a browser signed in as someone else only gets a generic alert.
  router.get("/notifications/:id", async (req, res) => {
    const actor = req.actor!;
    const [item] = await listVisibleNotifications(db, actor, { _id: idSchema.parse(req.params.id) }, 1);
    if (!item) throw new AppError(404, "NOT_FOUND", "Notification not found");
    res.json({ ok: true, data: jsonValue(item) });
  });
  router.post("/notifications/read", async (req, res) => {
    const actor = req.actor!;
    const { chatKind, chatId } = markNotificationsReadSchema.parse(req.body ?? {});
    const result = await db.collection("notifications").updateMany({ workspaceId: actor.membership.workspaceId, userId: actor.id, readAt: { $exists: false }, ...(chatKind ? { chatKind, chatId } : {}) }, { $set: { readAt: new Date() } });
    res.json({ ok: true, data: { read: result.modifiedCount } });
  });
  router.post("/notifications/:id/read", async (req, res) => {
    const actor = req.actor!;
    const result = await db.collection("notifications").updateOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { readAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "NOT_FOUND", "Notification not found");
    res.json({ ok: true, data: { read: true } });
  });
  router.get("/notification-preferences", async (req, res) => {
    const actor = req.actor!;
    const stored = await db.collection("notification_preferences").findOne({ workspaceId: actor.membership.workspaceId, userId: actor.id });
    res.json({ ok: true, data: notificationPreferencesSchema.parse({ ...defaultPreferences, ...stored }) });
  });
  router.put("/notification-preferences", async (req, res) => {
    const actor = req.actor!; const preferences = notificationPreferencesSchema.parse(req.body);
    await db.collection("notification_preferences").updateOne({ workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { ...preferences, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ ok: true, data: preferences });
  });
  router.post("/push-subscriptions", async (req, res) => {
    const actor = req.actor!; const subscription = subscriptionSchema.parse(req.body);
    // A browser endpoint is one device, not one account; re-registration transfers ownership.
    const collection = db.collection("push_subscriptions");
    const update = { $set: { ...subscription, workspaceId: actor.membership.workspaceId, userId: actor.id, active: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } };
    try { await collection.updateOne({ endpoint: subscription.endpoint }, update, { upsert: true }); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const retry = await collection.updateOne({ endpoint: subscription.endpoint }, { $set: update.$set });
      if (!retry.matchedCount) throw error;
    }
    res.status(201).json({ ok: true, data: { subscribed: true } });
  });
  router.delete("/push-subscriptions", async (req, res) => {
    const actor = req.actor!; const { endpoint } = subscriptionEndpointSchema.parse(req.body);
    await db.collection("push_subscriptions").updateOne({ workspaceId: actor.membership.workspaceId, userId: actor.id, endpoint }, { $set: { active: false, updatedAt: new Date() } });
    res.json({ ok: true, data: { unsubscribed: true } });
  });
  return router;
}
