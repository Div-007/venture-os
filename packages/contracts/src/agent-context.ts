import { z } from "zod";
import { idSchema, isoDateSchema, pagedDataSchema } from "./common.js";

/** Each piece of text for Claude is capped so reading a venture's whole context stays affordable. */
export const AGENT_TEXT_MAX = 200_000;
const title = z.string().trim().min(1).max(200);
const markdown = z.string().max(AGENT_TEXT_MAX).refine((value) => value.trim().length > 0, "Write something first");

/**
 * A venture's context: files an agent reads in full before working on that venture. Without a venture, a file is the
 * workspace's context, read first for every venture.
 */
export const ventureContextSchema = z.object({
  id: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200),
  /** Only when asked for (a single item, or a full read). */
  markdown: z.string().max(AGENT_TEXT_MAX).optional(),
  characters: z.number().int().min(0),
  createdBy: idSchema, updatedBy: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export const createVentureContextSchema = z.object({ title, markdown });
export const updateVentureContextSchema = z.object({ title: title.optional(), markdown: markdown.optional() })
  .refine((value) => value.title !== undefined || value.markdown !== undefined, "Change the title or the text");

/** A skill: instructions an agent follows for one kind of work. No venture means every venture can use it. */
export const skillSchema = z.object({
  id: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200), description: z.string().max(500),
  markdown: z.string().max(AGENT_TEXT_MAX).optional(),
  characters: z.number().int().min(0),
  /** Whether the reader may edit, move, or remove it. */
  canEdit: z.boolean().optional(),
  createdBy: idSchema, updatedBy: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
const description = z.string().trim().min(1, "Say when to use this skill").max(500);
export const createSkillSchema = z.object({ ventureId: idSchema.optional(), title, description, markdown });
/** `ventureId: null` moves the skill to the whole workspace. */
export const updateSkillSchema = z.object({ title: title.optional(), description: description.optional(), markdown: markdown.optional(), ventureId: idSchema.nullable().optional() })
  .refine((value) => Object.values(value).some((item) => item !== undefined), "Change something first");
export const skillListQuerySchema = z.object({ ventureId: idSchema.optional() });

/** Files shared in chats or attached to tasks, newest first, for the Knowledge screen's browsers. */
export const attachmentKindSchema = z.enum(["image", "video", "audio", "document"]);
export const sharedAttachmentSchema = z.object({
  id: idSchema, name: z.string().min(1).max(255), contentType: z.string().min(1).max(120), size: z.number().int().min(1),
  width: z.number().int().min(1).optional(), height: z.number().int().min(1).optional(), hd: z.literal(true).optional(),
  sharedAt: isoDateSchema, sharedBy: idSchema, ventureId: idSchema,
  groupId: idSchema.optional(), channelId: idSchema.optional(), messageId: idSchema.optional(),
  taskId: idSchema.optional(), taskTitle: z.string().optional(),
});
export const groupAttachmentQuerySchema = z.object({ channelId: idSchema.optional(), kind: attachmentKindSchema.optional(), cursor: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(40) });
export const taskAttachmentQuerySchema = z.object({ ventureId: idSchema.optional(), kind: attachmentKindSchema.optional(), cursor: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(40) });

/** For a venture: the workspace's files first, then its own. `canEdit` is for the list's own files; `canEditWorkspace` for the workspace's. */
export const ventureContextListSchema = z.object({ items: z.array(ventureContextSchema), canEdit: z.boolean(), canEditWorkspace: z.boolean().optional() });
export const skillListSchema = z.object({ items: z.array(skillSchema) });
export const sharedAttachmentPageSchema = pagedDataSchema(sharedAttachmentSchema);

export type VentureContext = z.infer<typeof ventureContextSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type SharedAttachment = z.infer<typeof sharedAttachmentSchema>;
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;
