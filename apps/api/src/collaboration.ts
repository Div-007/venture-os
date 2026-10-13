import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Router } from "express";
import { Server } from "socket.io";
import type { ChangeStream, ClientSession } from "mongodb";
import { channelNotificationLevelSchema, createChannelMessageSchema, createDirectMessageSchema, cursorQuerySchema, idSchema, messageAttachmentSchema, messageSchema, pinUpdateSchema, reactionUpdateSchema, saveUpdateSchema } from "@venture-studio/contracts";
import { can, dmKey } from "@venture-studio/core";
import type { AppDb, Database } from "./db.js";
import { atomic } from "./db.js";
import { audit } from "./audit.js";
import { AppError } from "./errors.js";
import { inArchivedVenture, notArchived } from "./archive-scope.js";
import { jsonValue } from "./json.js";
import type { createActorResolver } from "./middleware.js";

type Actor = NonNullable<Express.Request["actor"]>;
const publishers = new WeakMap<Database, (value: Record<string, unknown>) => Promise<void>>();
async function publish(database: Database, value?: Record<string, unknown>) {
  if (!value) return;
  try { await publishers.get(database)?.(value); }
  catch (error) { console.error(JSON.stringify({ level: "error", event: "realtime.publish_failed", eventId: value.eventId, error: error instanceof Error ? error.message : "unknown" })); }
}

const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9._-]*)/gi;

/** A notice's copy of a message, with each @handle of someone in the workspace written as @Name. */
async function readableMentions(db: AppDb, workspaceId: string, body: string): Promise<string> {
  // A handle at the end of a sentence may carry its full stop ("@ann-lee."), so look up both spellings.
  const handles = [...new Set([...body.matchAll(MENTION)].flatMap((match) => { const handle = match[2]!.toLowerCase(); return [handle, handle.replace(/[._-]+$/, "")]; }))].slice(0, 40);
  if (!handles.length) return body;
  const people = await db.collection("users").find({ workspaceId, handle: { $in: handles } }, { projection: { handle: 1, name: 1 } }).toArray();
  const names = new Map(people.map((person) => [String(person.handle).toLowerCase(), String(person.name)]));
  return body.replace(MENTION, (all, before: string, handle: string) => {
    const exact = names.get(handle.toLowerCase());
    if (exact) return `${before}@${exact}`;
    const trimmed = handle.replace(/[._-]+$/, "");
    const name = names.get(trimmed.toLowerCase());
    return name ? `${before}@${name}${handle.slice(trimmed.length)}` : all;
  });
}

async function channelScope(db: AppDb, actor: Actor, channelId: string) {
  const channel = await db.collection("channels").findOne({ _id: channelId, workspaceId: actor.membership.workspaceId });
  if (!channel || inArchivedVenture(actor.membership, channel.ventureId) || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(channel.ventureId)) || !actor.membership.groupIds.includes(String(channel.groupId))))) throw new AppError(404, "NOT_FOUND", "Channel not found");
  return channel;
}

async function messageAttachments(db: AppDb, actor: Actor, ids: string[], scope: { ventureId: string; groupId: string } | { recipientId: string }) {
  if (!ids.length) return [];
  if (new Set(ids).size !== ids.length) throw new AppError(400, "BAD_REQUEST", "Duplicate attachment");
  const files = await db.collection("files").find({
    _id: { $in: ids }, workspaceId: actor.membership.workspaceId, ownerId: actor.id, status: "ready",
    ...("recipientId" in scope
      ? { recipientId: scope.recipientId, ventureId: { $exists: false }, groupId: { $exists: false } }
      : { ventureId: scope.ventureId, groupId: scope.groupId, recipientId: { $exists: false } }),
  }).toArray();
  if (files.length !== ids.length) throw new AppError(400, "BAD_REQUEST", "Every attachment must be a completed upload for this conversation");
  const byId = new Map(files.map((file) => [String(file._id), file]));
  return ids.map((id) => {
    const file = byId.get(id)!;
    return messageAttachmentSchema.parse({ id, name: file.name, contentType: file.contentType, size: file.size, ...(file.width && file.height ? { width: file.width, height: file.height } : {}), ...(file.hd === true ? { hd: true } : {}) });
  });
}

function sameMessageRequest(message: Record<string, any>, input: { body: string; mentionUserIds: string[]; threadRootId?: string; attachmentFileIds: string[] }) {
  return message.body === input.body
    && message.threadRootId === input.threadRootId
    && JSON.stringify(message.mentionUserIds ?? []) === JSON.stringify(input.mentionUserIds)
    && JSON.stringify((message.attachments ?? []).map((file: { id: string }) => file.id)) === JSON.stringify(input.attachmentFileIds);
}

async function messageScope(db: AppDb, actor: Actor, messageId: string) {
  const message = await db.collection("messages").findOne({ _id: messageId, workspaceId: actor.membership.workspaceId });
  if (!message) throw new AppError(404, "NOT_FOUND", "Message not found");
  if (message.channelId) await channelScope(db, actor, String(message.channelId));
  else if (!message.dmKey || message.dmKey !== dmKey(actor.id, String(message.authorId === actor.id ? message.recipientId : message.authorId))) throw new AppError(404, "NOT_FOUND", "Message not found");
  return message;
}

async function decorateMessages(db: AppDb, actor: Actor, messages: Record<string, any>[]) {
  if (!messages.length) return [];
  const ids = messages.map((message) => message._id);
  const [reactions, saves] = await Promise.all([
    db.collection("message_reactions").find({ messageId: { $in: ids } }).toArray(),
    db.collection("message_saves").find({ userId: actor.id, messageId: { $in: ids } }).project({ messageId: 1 }).toArray(),
  ]);
  const saved = new Set(saves.map((item) => item.messageId));
  return messages.map((message) => {
    const own = reactions.filter((item) => item.messageId === message._id && item.userId === actor.id).map((item) => String(item.emoji));
    const counts = new Map<string, number>();
    for (const item of reactions.filter((item) => item.messageId === message._id)) counts.set(String(item.emoji), (counts.get(String(item.emoji)) ?? 0) + 1);
    return { ...message, reactions: Object.fromEntries(counts), myReactions: own, savedByMe: saved.has(message._id), pinned: Boolean(message.pinnedAt) };
  });
}

async function event(db: AppDb, actor: Actor, type: string, payload: Record<string, unknown>, scope: Record<string, unknown>, session?: ClientSession, stableEventId?: string) {
  const eventId = stableEventId ?? randomUUID();
  const value = { _id: eventId, eventId, version: 1, occurredAt: new Date(), actorId: actor.id, workspaceId: actor.membership.workspaceId, ...scope, type, payload };
  await db.collection("events").insertOne(value, { session });
  return value;
}

async function createChannelMessage(database: Database, actor: Actor, channelId: string, input: unknown, interfaceChannel: "api" | "socket" | "mcp" | "engine") {
  const parsed = createChannelMessageSchema.parse(input);
  const channel = await channelScope(database.db, actor, channelId);
  if (!can(actor.membership, "message:write", { ventureId: String(channel.ventureId), groupId: String(channel.groupId) })) throw new AppError(403, "FORBIDDEN", "You cannot post in this channel");
  const prior = await database.db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: parsed.clientId });
  if (prior) {
    if (prior.channelId !== channelId) throw new AppError(409, "CONFLICT", "Message client ID was already used in another channel");
    if (!sameMessageRequest(prior, parsed)) throw new AppError(409, "CONFLICT", "Message client ID was already used with different content");
    const priorEvent = await database.db.collection("events").findOne({ _id: prior._id, workspaceId: actor.membership.workspaceId, type: "message.created" });
    if (!priorEvent) throw new AppError(409, "CONFLICT", "Message retry is waiting for its event; retry shortly");
    return { message: prior, event: priorEvent, replayed: true };
  }
  const mentioned = [...new Set(parsed.mentionUserIds)];
  if (parsed.threadRootId) {
    const root = await database.db.collection("messages").findOne({ _id: parsed.threadRootId, workspaceId: actor.membership.workspaceId, channelId });
    if (!root || root.threadRootId) throw new AppError(400, "BAD_REQUEST", "Thread root must be a top-level message in this channel");
  }
  if (mentioned.length) {
    const valid = await database.db.collection("memberships").countDocuments({ workspaceId: actor.membership.workspaceId, userId: { $in: mentioned }, status: "active", $or: [{ role: "admin" }, { ventureIds: channel.ventureId, groupIds: channel.groupId }] });
    if (valid !== mentioned.length) throw new AppError(400, "BAD_REQUEST", "Every mention must be an active member of this venture and group");
  }
  const attachments = await messageAttachments(database.db, actor, parsed.attachmentFileIds, { ventureId: String(channel.ventureId), groupId: String(channel.groupId) });
  // Who hears about it: people @mentioned, unless they turned this channel off, and people following every message in it
  // who can still open it (each person's choice per channel; @mentions only by default). Never the sender.
  const levels = new Map((await database.db.collection("channel_notification_settings").find({ workspaceId: actor.membership.workspaceId, channelId }, { projection: { userId: 1, level: 1 } }).toArray()).map((row) => [String(row.userId), String(row.level)]));
  const mentionRecipients = mentioned.filter((userId) => userId !== actor.id && levels.get(userId) !== "off");
  const followers = [...levels].filter(([userId, level]) => level === "all" && userId !== actor.id && !mentioned.includes(userId)).map(([userId]) => userId);
  const followerRecipients = followers.length ? (await database.db.collection("memberships").find({ workspaceId: actor.membership.workspaceId, userId: { $in: followers }, status: "active", $or: [{ role: "admin" }, { ventureIds: channel.ventureId, groupIds: channel.groupId }] }, { projection: { userId: 1 } }).toArray()).map((row) => String(row.userId)) : [];
  const author = `${actor.name}${interfaceChannel === "mcp" ? " (via Claude)" : ""}`;
  const preview = mentionRecipients.length || followerRecipients.length ? (await readableMentions(database.db, actor.membership.workspaceId, parsed.body)).slice(0, 500) || (parsed.attachmentFileIds.length ? "Shared a file" : "New message") : "";
  const { attachmentFileIds: _attachmentFileIds, ...content } = parsed;
  const message = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ventureId: channel.ventureId, groupId: channel.groupId, channelId, authorId: actor.id, ...content, attachments, ...(interfaceChannel === "mcp" ? { via: "claude" } : {}), createdAt: new Date() };
  let createdEvent: Record<string, unknown> | undefined;
  try {
    await atomic(database, async (session) => {
      await database.db.collection("messages").insertOne(message, { session });
      createdEvent = await event(database.db, actor, "message.created", message, { ventureId: channel.ventureId, groupId: channel.groupId, channelId }, session, message._id);
      const notices = [
        // Someone following every message is told about @mentions too, under the channel's choice rather than the account's.
        ...mentionRecipients.map((userId) => ({ userId, type: levels.get(userId) === "all" ? "channel_message" : "mention", title: `${author} mentioned you in #${channel.name}`, idempotencyKey: `mention:${message._id}:${userId}` })),
        ...followerRecipients.map((userId) => ({ userId, type: "channel_message", title: `${author} in #${channel.name}`, idempotencyKey: `channel:${message._id}:${userId}` })),
      ];
      if (notices.length) {
        const notifiedAt = new Date();
        await database.db.collection("notification_outbox").bulkWrite(notices.map((notice) => ({ updateOne: { filter: { idempotencyKey: notice.idempotencyKey }, update: { $setOnInsert: { _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: notice.userId, type: notice.type, title: notice.title.slice(0, 200), body: preview, resourceType: "message", resourceId: message._id, chatKind: "channel", chatId: channelId, idempotencyKey: notice.idempotencyKey, state: "pending", attempts: 0, nextAttemptAt: notifiedAt, createdAt: notifiedAt, updatedAt: notifiedAt } }, upsert: true } })), { session });
      }
      await audit(database.db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: interfaceChannel, action: "message.create", objectType: "message", objectId: message._id, ventureId: String(channel.ventureId), result: "success" }, session);
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const duplicate = await database.db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: parsed.clientId, channelId });
    const duplicateEvent = duplicate ? await database.db.collection("events").findOne({ _id: duplicate._id, workspaceId: actor.membership.workspaceId, type: "message.created" }) : null;
    if (!duplicate || !duplicateEvent) throw new AppError(409, "CONFLICT", "Concurrent message retry is not yet readable; retry shortly");
    if (!sameMessageRequest(duplicate, parsed)) throw new AppError(409, "CONFLICT", "Message client ID was already used with different content");
    return { message: duplicate, event: duplicateEvent, replayed: true };
  }
  return { message, event: createdEvent!, replayed: false };
}

export function collaborationRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  router.get("/channels/:channelId/messages", async (req, res) => {
    const channelId = idSchema.parse(req.params.channelId);
    const actor = req.actor!;
    await channelScope(db, actor, channelId);
    const query = cursorQuerySchema.parse(req.query);
    const pinned = req.query.pinned === "true";
    const threadRootId = typeof req.query.threadRootId === "string" ? idSchema.parse(req.query.threadRootId) : undefined;
    const cursor = query.cursor ? await db.collection("messages").findOne({ _id: query.cursor, channelId }) : undefined;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Message cursor not found");
    // Default pages forward from the oldest message; `order=latest` starts at the newest page and its cursor walks to older messages.
    const latest = req.query.order === "latest";
    const comparison = latest ? "$lt" : "$gt";
    const after = cursor ? { $or: [{ createdAt: { [comparison]: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { [comparison]: cursor._id } }] } : {};
    const direction = latest ? -1 : 1;
    const items = await db.collection("messages").find({ workspaceId: actor.membership.workspaceId, channelId, ...(pinned ? { pinnedAt: { $exists: true } } : {}), ...(threadRootId ? { threadRootId } : {}), ...after }).sort({ createdAt: direction, _id: direction }).limit(query.limit + 1).toArray();
    const page = items.slice(0, query.limit);
    res.json({ ok: true, data: { items: jsonValue(await decorateMessages(db, actor, latest ? page.reverse() : page)), nextCursor: items.length > query.limit ? items[query.limit - 1]?._id : undefined } });
  });
  // How this channel notifies me: every message, @mentions only (the default, stored as no row), or nothing.
  router.get("/channels/:channelId/notification-level", async (req, res) => {
    const channelId = idSchema.parse(req.params.channelId);
    const actor = req.actor!;
    await channelScope(db, actor, channelId);
    const row = await db.collection("channel_notification_settings").findOne({ workspaceId: actor.membership.workspaceId, userId: actor.id, channelId });
    res.json({ ok: true, data: { level: row?.level ?? "mentions" } });
  });
  router.put("/channels/:channelId/notification-level", async (req, res) => {
    const channelId = idSchema.parse(req.params.channelId);
    const actor = req.actor!;
    const { level } = channelNotificationLevelSchema.parse(req.body);
    await channelScope(db, actor, channelId);
    const key = { workspaceId: actor.membership.workspaceId, userId: actor.id, channelId };
    if (level === "mentions") await db.collection("channel_notification_settings").deleteOne(key);
    else await db.collection("channel_notification_settings").updateOne(key, { $set: { level, updatedAt: new Date() }, $setOnInsert: { _id: randomUUID(), createdAt: new Date() } }, { upsert: true });
    res.json({ ok: true, data: { level } });
  });
  router.post("/channels/:channelId/messages", async (req, res) => {
    const result = await createChannelMessage(database, req.actor!, idSchema.parse(req.params.channelId), req.body, req.interfaceChannel);
    if (!result.replayed) await publish(database, result.event);
    res.status(result.replayed ? 200 : 201).json({ ok: true, data: jsonValue({ ...result, message: (await decorateMessages(db, req.actor!, [result.message]))[0] }) });
  });
  router.get("/direct-messages/:userId", async (req, res) => {
    const otherId = idSchema.parse(req.params.userId);
    const actor = req.actor!;
    const items = await db.collection("messages").find({ workspaceId: actor.membership.workspaceId, dmKey: dmKey(actor.id, otherId) }).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    res.json({ ok: true, data: jsonValue(await decorateMessages(db, actor, items.reverse())) });
  });
  router.post("/direct-messages", async (req, res) => {
    const input = createDirectMessageSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "message:write")) throw new AppError(403, "FORBIDDEN", "You cannot send direct messages");
    const recipient = await db.collection("memberships").findOne({ workspaceId: actor.membership.workspaceId, userId: input.recipientId, status: "active" });
    if (!recipient) throw new AppError(404, "NOT_FOUND", "Recipient not found");
    const key = dmKey(actor.id, input.recipientId);
    const prior = await db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: input.clientId });
    if (prior) {
      if (prior.dmKey !== key) throw new AppError(409, "CONFLICT", "Message client ID was already used elsewhere");
      if (!sameMessageRequest(prior, input)) throw new AppError(409, "CONFLICT", "Message client ID was already used with different content");
      res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [prior]))[0]) });
      return;
    }
    if (input.threadRootId) {
      const root = await db.collection("messages").findOne({ _id: input.threadRootId, workspaceId: actor.membership.workspaceId, dmKey: key });
      if (!root || root.threadRootId) throw new AppError(400, "BAD_REQUEST", "Thread root must be a top-level message in this conversation");
    }
    const attachments = await messageAttachments(db, actor, input.attachmentFileIds, { recipientId: input.recipientId });
    const { attachmentFileIds: _attachmentFileIds, ...content } = input;
    const viaClaude = req.interfaceChannel === "mcp";
    const preview = (await readableMentions(db, actor.membership.workspaceId, input.body)).slice(0, 500) || "Shared a file";
    const message = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, dmKey: key, authorId: actor.id, ...content, attachments, ...(viaClaude ? { via: "claude" } : {}), createdAt: new Date() };
    let createdEvent: Record<string, unknown> | undefined;
    try { await atomic(database, async (session) => {
      await db.collection("messages").insertOne(message, { session });
      createdEvent = await event(db, actor, "direct_message.created", message, { audienceUserIds: [actor.id, input.recipientId] }, session);
      await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, userId: input.recipientId, type: "message", title: `Message from ${actor.name}${viaClaude ? " (via Claude)" : ""}`, body: preview, resourceType: "message", resourceId: message._id, chatKind: "direct", chatId: actor.id, idempotencyKey: `dm:${message._id}:${input.recipientId}`, state: "pending", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date(), updatedAt: new Date() }, { session });
    }); } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const duplicate = await db.collection("messages").findOne({ workspaceId: actor.membership.workspaceId, authorId: actor.id, clientId: input.clientId, dmKey: key });
      if (!duplicate) throw new AppError(409, "CONFLICT", "Concurrent message retry is not yet readable; retry shortly");
      if (!sameMessageRequest(duplicate, input)) throw new AppError(409, "CONFLICT", "Message client ID was already used with different content");
      res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [duplicate]))[0]) });
      return;
    }
    await publish(database, createdEvent);
    res.status(201).json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [message]))[0]) });
  });
  router.get("/messages/saved", async (req, res) => {
    const actor = req.actor!;
    const visible = [];
    for await (const save of db.collection("message_saves").find({ workspaceId: actor.membership.workspaceId, userId: actor.id }).sort({ createdAt: -1, _id: -1 })) {
      try { visible.push(await messageScope(db, actor, String(save.messageId))); }
      catch (error) { if (!(error instanceof AppError && error.status === 404)) throw error; }
      if (visible.length === 100) break;
    }
    res.json({ ok: true, data: jsonValue(await decorateMessages(db, actor, visible)) });
  });
  router.get("/groups/:groupId/messages/saved", async (req, res) => {
    const actor = req.actor!;
    const groupId = idSchema.parse(req.params.groupId);
    const group = await db.collection("groups").findOne({ _id: groupId, workspaceId: actor.membership.workspaceId });
    if (!group || !can(actor.membership, "group:read", { ventureId: String(group.ventureId), groupId })) throw new AppError(404, "NOT_FOUND", "Group not found");
    const query = cursorQuerySchema.parse(req.query);
    const scope = { workspaceId: actor.membership.workspaceId, userId: actor.id };
    const cursor = query.cursor ? await db.collection("message_saves").findOne({ ...scope, _id: idSchema.parse(query.cursor) }) : undefined;
    if (query.cursor && (!cursor || (await messageScope(db, actor, String(cursor.messageId))).groupId !== groupId)) throw new AppError(404, "NOT_FOUND", "Saved-message cursor not found");
    const before = cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {};
    const rows = await db.collection("message_saves").aggregate([
      { $match: { ...scope, ...before } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $lookup: { from: "messages", localField: "messageId", foreignField: "_id", as: "message" } },
      { $unwind: "$message" },
      { $match: { "message.workspaceId": scope.workspaceId, "message.groupId": groupId, "message.channelId": { $exists: true } } },
      { $lookup: { from: "channels", localField: "message.channelId", foreignField: "_id", as: "channel" } },
      { $match: { "channel.workspaceId": scope.workspaceId, "channel.groupId": groupId } },
      { $limit: query.limit + 1 },
      { $project: { _id: 1, message: 1 } },
    ]).toArray();
    const items = await decorateMessages(db, actor, rows.slice(0, query.limit).map((row) => row.message as Record<string, any>));
    res.json({ ok: true, data: { items: messageSchema.array().parse(jsonValue(items)), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?._id) : undefined } });
  });
  router.put("/messages/:id/reaction", async (req, res) => {
    const actor = req.actor!; const message = await messageScope(db, actor, idSchema.parse(req.params.id));
    if (!can(actor.membership, "message:write", message.channelId ? { ventureId: String(message.ventureId), groupId: String(message.groupId) } : {})) throw new AppError(403, "FORBIDDEN", "You cannot react to this message");
    const input = reactionUpdateSchema.parse(req.body);
    const changedEvent = await atomic(database, async (session) => {
      const existing = await db.collection("message_reactions").findOne({ messageId: message._id, userId: actor.id, emoji: input.emoji }, { session });
      if (Boolean(existing) === input.active) return undefined;
      if (input.active) await db.collection("message_reactions").updateOne({ messageId: message._id, userId: actor.id, emoji: input.emoji }, { $setOnInsert: { _id: randomUUID(), workspaceId: actor.membership.workspaceId, messageId: message._id, userId: actor.id, emoji: input.emoji, createdAt: new Date() } }, { upsert: true, session });
      else await db.collection("message_reactions").deleteOne({ messageId: message._id, userId: actor.id, emoji: input.emoji }, { session });
      return event(db, actor, "message.reaction", { messageId: message._id, emoji: input.emoji, active: input.active }, message.channelId ? { ventureId: message.ventureId, groupId: message.groupId, channelId: message.channelId } : { audienceUserIds: [message.authorId, message.recipientId] }, session);
    });
    await publish(database, changedEvent);
    res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [message]))[0]) });
  });
  router.put("/messages/:id/save", async (req, res) => {
    const actor = req.actor!; const message = await messageScope(db, actor, idSchema.parse(req.params.id));
    const { saved } = saveUpdateSchema.parse(req.body);
    if (saved) await db.collection("message_saves").updateOne({ messageId: message._id, userId: actor.id }, { $setOnInsert: { _id: randomUUID(), workspaceId: actor.membership.workspaceId, messageId: message._id, userId: actor.id, createdAt: new Date() } }, { upsert: true });
    else await db.collection("message_saves").deleteOne({ messageId: message._id, userId: actor.id });
    res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [message]))[0]) });
  });
  router.put("/messages/:id/pin", async (req, res) => {
    const actor = req.actor!; const message = await messageScope(db, actor, idSchema.parse(req.params.id));
    if (!message.channelId || (actor.membership.role !== "admin" && actor.membership.role !== "venture_head")) throw new AppError(403, "FORBIDDEN", "Only admins or venture heads may pin channel messages");
    const { pinned } = pinUpdateSchema.parse(req.body);
    const changedEvent = await atomic(database, async (session) => {
      const current = await db.collection("messages").findOne({ _id: message._id, workspaceId: actor.membership.workspaceId }, { session });
      if (Boolean(current?.pinnedAt) === pinned) return undefined;
      const now = new Date();
      await db.collection("messages").updateOne({ _id: message._id, workspaceId: actor.membership.workspaceId }, pinned ? { $set: { pinnedAt: now, pinnedBy: actor.id } } : { $unset: { pinnedAt: "", pinnedBy: "" } }, { session });
      const result = await event(db, actor, "message.pin", { messageId: message._id, pinned }, { ventureId: message.ventureId, groupId: message.groupId, channelId: message.channelId }, session);
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "message.pin", objectType: "message", objectId: String(message._id), ventureId: String(message.ventureId), result: "success" }, session);
      return result;
    });
    await publish(database, changedEvent);
    const current = await db.collection("messages").findOne({ _id: message._id, workspaceId: actor.membership.workspaceId });
    res.json({ ok: true, data: jsonValue((await decorateMessages(db, actor, [current!]))[0]) });
  });
  router.get("/events", async (req, res) => {
    const actor = req.actor!;
    const after = typeof req.query.after === "string" ? idSchema.parse(req.query.after) : undefined;
    const cursor = after ? await db.collection("events").findOne({ _id: after, workspaceId: actor.membership.workspaceId }) : undefined;
    if (after && (!cursor || !eventAccessible(cursor, actor))) throw new AppError(404, "NOT_FOUND", "Event cursor not found");
    const audience = actor.membership.role === "admin"
      ? { $or: [{ audienceUserIds: actor.id }, { groupId: { $exists: true }, audienceUserIds: { $exists: false }, ...notArchived(actor.membership) }] }
      : { $or: [{ audienceUserIds: actor.id }, { groupId: { $in: actor.membership.groupIds }, ventureId: { $in: actor.membership.ventureIds }, audienceUserIds: { $exists: false } }] };
    const afterFilter = cursor ? { $or: [{ occurredAt: { $gt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, _id: { $gt: cursor._id } }] } : {};
    // Without a cursor a client is establishing one, so return the newest window (still ascending) rather than the oldest history.
    const events = cursor
      ? await db.collection("events").find({ workspaceId: actor.membership.workspaceId, $and: [audience, afterFilter] }).sort({ occurredAt: 1, _id: 1 }).limit(500).toArray()
      : (await db.collection("events").find({ workspaceId: actor.membership.workspaceId, $and: [audience] }).sort({ occurredAt: -1, _id: -1 }).limit(500).toArray()).reverse();
    res.json({ ok: true, data: jsonValue(events) });
  });
  return router;
}

/** Local dev auth only: other loopback origins (e.g. alice.localhost:3012) let several test users connect side by side. */
export function isLocalDevOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost"));
  } catch { return false; }
}

export function attachRealtime(server: HttpServer, database: Database, resolveActor: ReturnType<typeof createActorResolver>, appOrigin: string, allowDevAuth = false): Server {
  const trustedOrigin = new URL(appOrigin).origin;
  const io = new Server(server, { cors: { origin: trustedOrigin, credentials: true }, allowRequest: (request, callback) => callback(null, !request.headers.origin || request.headers.origin === trustedOrigin || (allowDevAuth && isLocalDevOrigin(request.headers.origin))) });
  publishers.set(database, async (value) => {
    if (typeof value.channelId === "string") await emitAuthorizedToChannel(io, database.db, resolveActor, value.channelId, jsonValue(value));
    else if (Array.isArray(value.audienceUserIds)) await emitAuthorizedToUsers(io, resolveActor, value, jsonValue(value));
  });
  io.use(async (socket, next) => {
    try {
      const headers = { ...socket.request.headers };
      if (allowDevAuth && typeof socket.handshake.auth?.devUserId === "string") headers["x-dev-user-id"] = idSchema.parse(socket.handshake.auth.devUserId);
      const actor = await resolveActor(headers);
      if (!actor) return next(new Error("UNAUTHENTICATED"));
      socket.data.actor = actor;
      socket.data.authHeaders = headers;
      next();
    } catch { next(new Error("UNAUTHENTICATED")); }
  });
  io.on("connection", (socket) => {
    const actor = socket.data.actor as Actor;
    socket.join(`user:${actor.membership.workspaceId}:${actor.id}`);
    socket.on("channel:join", async (channelId: string, reply: (value: unknown) => void) => {
      try { const fresh = await resolveActor(socket.data.authHeaders); if (!fresh) throw new Error("UNAUTHENTICATED"); await channelScope(database.db, fresh, idSchema.parse(channelId)); const room = `channel:${channelId}`; await socket.join(room); await emitAuthorizedPresence(io, database.db, resolveActor, channelId, fresh.id, "online"); if (typeof reply === "function") reply({ ok: true }); }
      catch { if (typeof reply === "function") reply({ ok: false, error: { code: "FORBIDDEN", message: "Channel access denied" } }); }
    });
    socket.on("message:create", async (input: { channelId: string; body: unknown }, reply: (value: unknown) => void) => {
      try {
        const fresh = await resolveActor(socket.data.authHeaders);
        if (!fresh) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
        const result = await createChannelMessage(database, fresh, idSchema.parse(input.channelId), input.body, "socket");
        if (!result.replayed) {
          await publish(database, result.event);
        }
        if (typeof reply === "function") reply({ ok: true, data: jsonValue(result.message) });
      } catch (error) { if (typeof reply === "function") reply({ ok: false, error: { code: error instanceof AppError ? error.code : "BAD_REQUEST", message: error instanceof Error ? error.message : "Invalid message" } }); }
    });
    socket.on("disconnecting", async () => {
      for (const room of socket.rooms) {
        if (!room.startsWith("channel:")) continue;
        const channelId = room.slice("channel:".length);
        const peers = await io.in(room).fetchSockets();
        let hasAuthorizedSameUserPeer = false;
        for (const peer of peers) {
          if (peer.id === socket.id) continue;
          try {
            const fresh = await resolveActor(peer.data.authHeaders);
            if (!fresh) throw new Error("UNAUTHENTICATED");
            await channelScope(database.db, fresh, channelId);
            if (fresh.id === actor.id) hasAuthorizedSameUserPeer = true;
          } catch { await peer.leave(room); }
        }
        if (!hasAuthorizedSameUserPeer) await emitAuthorizedPresence(io, database.db, resolveActor, channelId, actor.id, "offline");
      }
    });
  });
  const stops = [
    watchInserts(io, database, resolveActor, { collection: "notifications", event: "notification" }),
    // A finished task's celebration plays on whatever page its person has open.
    watchInserts(io, database, resolveActor, { collection: "celebrations", event: "celebration", match: { "fullDocument.state": "pending" } }),
  ];
  const stopWatching = () => { for (const stop of stops) stop(); };
  watchers.set(database, stopWatching);
  server.on("close", stopWatching);
  return io;
}

const watchers = new WeakMap<Database, () => void>();
/** Stops realtime work that reads the database; call it before closing the database client. */
export function stopRealtime(database: Database): void { watchers.get(database)?.(); }

/**
 * Nudges a person's open tabs the moment something is added for them: a notice in their inbox (so alerts arrive within a
 * second instead of at the next poll), or a celebration. Only the id is sent; the tab reads it back, with its access rules.
 * Inserts are handled one at a time so a message to many followers doesn't re-check every socket at once. Returns a stop
 * function. Tabs keep polling, so a gap while the watch restarts only delays them.
 */
function watchInserts(io: Server, database: Database, resolveActor: ReturnType<typeof createActorResolver>, source: { collection: string; event: string; match?: Record<string, unknown> }): () => void {
  let stream: ChangeStream | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;
  let queue: Promise<void> = Promise.resolve();
  const later = () => {
    if (stopped) return;
    retry = setTimeout(start, Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
    retry.unref();
    failures += 1;
  };
  const start = () => {
    if (stopped) return;
    const current = database.db.collection(source.collection).watch([{ $match: { operationType: "insert", ...source.match } }]);
    stream = current;
    current.on("change", (change) => {
      failures = 0;
      const notice = (change as { fullDocument?: Record<string, unknown> }).fullDocument;
      if (!notice || typeof notice.userId !== "string" || typeof notice.workspaceId !== "string") return;
      const target = { workspaceId: notice.workspaceId, audienceUserIds: [notice.userId] };
      queue = queue.then(() => emitAuthorizedToUsers(io, resolveActor, target, { id: String(notice._id) }, source.event))
        .catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: `realtime.${source.event}_failed`, error: error instanceof Error ? error.message : "unknown" })));
    });
    current.on("error", (error: Error & { code?: number }) => {
      // A late error from a stream already replaced must not touch the new one.
      if (stream !== current) return;
      stream = undefined;
      void current.close().catch(() => undefined);
      if (stopped) return;
      if (error.code === 40573) { console.info(JSON.stringify({ level: "info", event: `realtime.${source.event}_watch_unavailable`, reason: `MongoDB is not a replica set; tabs poll for new ${source.collection}` })); return; }
      console.error(JSON.stringify({ level: "error", event: `realtime.${source.event}_watch_failed`, error: error.message }));
      later();
    });
    // Dropping or renaming the collection ends the stream without an error.
    current.on("close", () => { if (stream !== current) return; stream = undefined; later(); });
  };
  start();
  return () => {
    stopped = true;
    clearTimeout(retry);
    const current = stream;
    stream = undefined;
    void current?.close().catch(() => undefined);
  };
}

async function emitAuthorizedToUsers(io: Server, resolveActor: ReturnType<typeof createActorResolver>, value: Record<string, unknown>, payload: unknown, eventName = "event"): Promise<void> {
  for (const userId of value.audienceUserIds as string[]) {
    for (const socket of await io.in(`user:${value.workspaceId}:${userId}`).fetchSockets()) {
      try {
        const actor = await resolveActor(socket.data.authHeaders);
        if (actor && actor.id === userId && actor.membership.workspaceId === value.workspaceId) socket.emit(eventName, payload);
        else await socket.leave(`user:${value.workspaceId}:${userId}`);
      } catch { await socket.leave(`user:${value.workspaceId}:${userId}`); }
    }
  }
}

function eventAccessible(value: Record<string, any>, actor: Actor): boolean {
  if (Array.isArray(value.audienceUserIds)) return value.audienceUserIds.includes(actor.id);
  if (typeof value.groupId === "string") return !inArchivedVenture(actor.membership, value.ventureId) && (actor.membership.role === "admin" || (actor.membership.groupIds.includes(value.groupId) && actor.membership.ventureIds.includes(value.ventureId)));
  return false;
}

async function emitAuthorizedToChannel(io: Server, db: AppDb, resolveActor: ReturnType<typeof createActorResolver>, channelId: string, value: unknown): Promise<void> {
  const sockets = await io.in(`channel:${channelId}`).fetchSockets();
  for (const socket of sockets) {
    try {
      const actor = await resolveActor(socket.data.authHeaders);
      if (!actor) throw new Error("UNAUTHENTICATED");
      await channelScope(db, actor, channelId);
      socket.emit("event", value);
    } catch { await socket.leave(`channel:${channelId}`); }
  }
}

async function emitAuthorizedPresence(io: Server, db: AppDb, resolveActor: ReturnType<typeof createActorResolver>, channelId: string, userId: string, state: "online" | "offline"): Promise<void> {
  const room = `channel:${channelId}`;
  const sockets = await io.in(room).fetchSockets();
  for (const socket of sockets) {
    try {
      const actor = await resolveActor(socket.data.authHeaders);
      if (!actor) throw new Error("UNAUTHENTICATED");
      await channelScope(db, actor, channelId);
      socket.emit("presence:update", { userId, state });
    } catch { await socket.leave(room); }
  }
}
