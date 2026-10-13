import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema } from "./common.js";

/** An image's pixel size (so chat can reserve its space before it loads) and whether it was sent in HD, untouched. */
const imageFields = { width: z.number().int().min(1).max(20_000).optional(), height: z.number().int().min(1).max(20_000).optional(), hd: z.literal(true).optional() };

export const fileSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), groupId: idSchema.optional(), taskId: idSchema.optional(), recipientId: idSchema.optional(),
  ownerId: idSchema, name: z.string().min(1).max(255), contentType: z.string().min(1).max(120),
  size: z.number().int().min(1).max(25 * 1024 * 1024), objectKey: z.string(),
  status: z.enum(["pending", "ready", "abandoned", "deleted"]),
  createdAt: isoDateSchema, completedAt: isoDateSchema.optional(), ...imageFields,
});
export const groupFileSchema = fileSchema.omit({ objectKey: true });

export const uploadIntentSchema = z.object({
  ventureId: idSchema.optional(), groupId: idSchema.optional(), taskId: idSchema.optional(), recipientId: idSchema.optional(), name: z.string().trim().min(1).max(255),
  contentType: z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/markdown", "text/plain", "image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav"]),
  size: z.number().int().min(1).max(25 * 1024 * 1024), ...imageFields,
}).refine((value) => Boolean(value.ventureId) !== Boolean(value.recipientId), { message: "Choose a venture or a direct-message recipient" })
  .refine((value) => (value.width === undefined) === (value.height === undefined), { message: "Give an image's width and height together", path: ["width"] })
  .refine((value) => value.contentType.startsWith("image/") || (value.width === undefined && value.hd === undefined), { message: "Only images have a pixel size or HD", path: ["contentType"] })
  .refine((value) => !value.recipientId || (!value.groupId && !value.taskId), { message: "Direct-message uploads cannot have a group or task" })
  .refine((value) => !value.taskId || Boolean(value.groupId), { message: "Task attachments require a group", path: ["groupId"] });
export const uploadCompleteSchema = z.object({ etag: z.string().min(1).max(200) });

export const searchQuerySchema = cursorQuerySchema.extend({
  q: z.string().trim().min(2).max(200), ventureId: idSchema.optional(), groupId: idSchema.optional(),
  types: z.array(z.enum(["message", "task", "file"])).default(["message", "task", "file"]),
});

// Read scopes, then the narrow write scopes used by hosted MCP tools. Older read scopes stay valid for existing tokens.
export const patScopeSchema = z.enum([
  "today:read", "ventures:read", "tasks:read", "messages:read", "files:read", "knowledge:read", "classes:read", "decisions:read",
  "reminders:read", "notifications:read", "requests:read", "sales:read", "calendar:read", "direct_messages:read",
  "tasks:write", "reminders:write", "notifications:write", "knowledge:write", "files:write", "messages:write", "decisions:write",
  "requests:write", "sales:write", "classes:write", "calendar:write", "direct_messages:write",
  // The office PC lead-finding worker (docs/sales-dealflow.md section 10): claims queued find-lead runs and posts leads back. Not part of the Claude presets.
  "sales:engine",
]);
export const PAT_READ_SCOPES = ["ventures:read", "tasks:read", "messages:read", "files:read", "knowledge:read", "classes:read", "decisions:read", "requests:read", "sales:read", "calendar:read", "reminders:read", "notifications:read"] as const;
export const PAT_WRITE_SCOPES = ["tasks:write", "reminders:write", "notifications:write", "knowledge:write", "files:write", "messages:write", "decisions:write", "requests:write", "sales:write", "classes:write", "calendar:write"] as const;
/** The "Office PC engine" preset: the worker reads Sales and talks to /v1/sales/engine. It carries no write scope, so Claude's connectors cannot use it. */
export const PAT_ENGINE_SCOPES = ["sales:read", "sales:engine"] as const;
/** Private conversations stay out of both presets: a key reaches them only when its owner ticks this separately. */
export const PAT_DIRECT_MESSAGE_SCOPES = ["direct_messages:read", "direct_messages:write"] as const;
// Tokens must expire: a lost laptop or pasted token stops working on its own. 1 to 366 days.
export const patCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // A write scope only makes sense with its read scope (a tool must see what it changes).
  scopes: z.array(patScopeSchema).min(1).max(30).refine((scopes) => scopes.every((scope) => (!scope.endsWith(":write") || scopes.includes(scope.replace(/:write$/, ":read") as never)) && (scope !== "sales:engine" || scopes.includes("sales:read"))), "Each write scope needs its matching read scope (sales:engine needs sales:read)"),
  expiresInDays: z.number().int().min(1).max(366),
});

// What the app lists and returns at creation (the secret `token` only once).
export const patListItemSchema = z.object({ id: idSchema, name: z.string(), prefix: z.string(), scopes: z.array(patScopeSchema), createdAt: isoDateSchema, expiresAt: isoDateSchema.optional(), lastUsedAt: isoDateSchema.optional(), revokedAt: isoDateSchema.optional() });
export const patCreatedSchema = z.object({ pat: patListItemSchema, token: z.string() });

export const patSchema = z.object({
  id: idSchema, workspaceId: idSchema, userId: idSchema, name: z.string(),
  prefix: z.string(), scopes: z.array(patScopeSchema), createdAt: isoDateSchema,
  expiresAt: isoDateSchema.optional(), revokedAt: isoDateSchema.optional(), lastUsedAt: isoDateSchema.optional(),
});
