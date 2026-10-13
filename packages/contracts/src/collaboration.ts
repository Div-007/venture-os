import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema } from "./common.js";

export const messageAttachmentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  size: z.number().int().min(1).max(25 * 1024 * 1024),
  width: z.number().int().min(1).max(20_000).optional(),
  height: z.number().int().min(1).max(20_000).optional(),
  hd: z.literal(true).optional(),
});

export const messageSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  ventureId: idSchema.optional(),
  groupId: idSchema.optional(),
  channelId: idSchema.optional(),
  dmKey: z.string().optional(),
  authorId: idSchema,
  body: z.string().max(10_000),
  attachments: z.array(messageAttachmentSchema).default([]),
  mentionUserIds: z.array(idSchema).default([]),
  threadRootId: idSchema.optional(),
  /** Set when the author posted it through a Claude connection (hosted MCP), so readers can tell. */
  via: z.literal("claude").optional(),
  createdAt: isoDateSchema,
  editedAt: isoDateSchema.optional(),
  pinnedAt: isoDateSchema.optional(),
  pinnedBy: idSchema.optional(),
  pinned: z.boolean().optional(),
  savedByMe: z.boolean().optional(),
  reactions: z.record(z.string(), z.number().int().nonnegative()).optional(),
  myReactions: z.array(z.string()).optional(),
});
export const reactionUpdateSchema = z.object({ emoji: z.string().trim().min(1).max(32), active: z.boolean() });
export const saveUpdateSchema = z.object({ saved: z.boolean() });
export const pinUpdateSchema = z.object({ pinned: z.boolean() });

export const createChannelMessageSchema = z.object({
  body: z.string().trim().max(10_000),
  attachmentFileIds: z.array(idSchema).max(10).default([]),
  mentionUserIds: z.array(idSchema).max(50).default([]),
  threadRootId: idSchema.optional(),
  clientId: z.string().min(8).max(120),
}).refine((value) => value.body.length > 0 || value.attachmentFileIds.length > 0, { message: "A message needs text or an attachment" });

export const createDirectMessageSchema = createChannelMessageSchema.extend({
  recipientId: idSchema,
});

export const messageListQuerySchema = cursorQuerySchema.extend({ afterEventId: idSchema.optional() });

/** Mark the caller's unread notifications read: all of them, or one conversation's (chatKind + chatId). */
export const markNotificationsReadSchema = z.object({ chatKind: z.enum(["direct", "channel"]).optional(), chatId: idSchema.optional() })
  .refine((value) => Boolean(value.chatKind) === Boolean(value.chatId), "chatKind and chatId must be provided together");
export const notificationSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  type: z.enum(["mention", "assignment", "reminder", "deadline_warning", "message", "channel_message", "member_joined", "event_invite", "event_update", "event_response", "knowledge_request", "knowledge_result", "sales_won", "sales_reply", "sales_approval", "sales_needs_you"]),
  title: z.string(),
  body: z.string(),
  resourceType: z.string(),
  resourceId: idSchema,
  chatKind: z.enum(["direct", "channel"]).optional(),
  chatId: idSchema.optional(),
  reminderId: idSchema.optional(),
  readAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
});
/**
 * How one channel notifies one person: every message, only messages that @mention them (the default), or nothing.
 * Direct messages always notify, subject to the account-wide "Direct messages" preference.
 */
export const CHANNEL_NOTIFICATION_LEVELS = ["all", "mentions", "off"] as const;
export const channelNotificationLevelSchema = z.object({ level: z.enum(CHANNEL_NOTIFICATION_LEVELS) });
export type ChannelNotificationLevel = (typeof CHANNEL_NOTIFICATION_LEVELS)[number];
// `calendar` (invitations, changes, and replies) arrived later: older saved preferences read as on.
export const notificationPreferencesSchema = z.object({ email: z.boolean(), webPush: z.boolean(), mentions: z.boolean(), messages: z.boolean(), assignments: z.boolean(), reminders: z.boolean(), calendar: z.boolean().default(true) });

export type Message = z.infer<typeof messageSchema>;
