import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema, timezoneSchema } from "./common.js";

export const taskStatusSchema = z.enum(["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"]);
export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const taskSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  ventureId: idSchema,
  groupId: idSchema,
  channelId: idSchema.optional(),
  title: z.string().min(1).max(200),
  outcomeId: idSchema.optional(),
  parentTaskId: idSchema.optional(),
  outcome: z.string().min(1).max(2_000),
  assigneeId: idSchema,
  creatorId: idSchema,
  reviewerId: idSchema.optional(),
  priority: taskPrioritySchema,
  status: taskStatusSchema,
  dueAt: isoDateSchema,
  reviewAt: isoDateSchema.optional(),
  timezone: timezoneSchema,
  estimatedMinutes: z.number().int().min(1).max(100_800),
  definitionOfDone: z.string().min(1).max(5_000),
  evidenceRequirement: z.string().min(1).max(2_000),
  /** Background, current state, specs, links, and plans, in Markdown: what doesn't belong in a short definition of done. */
  details: z.string().max(20_000).optional(),
  dependencies: z.array(idSchema).max(100),
  evidenceLinks: z.array(z.url()).max(100),
  blocker: z.string().max(2_000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(30),
  deadlineRisk: z.boolean(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  completedAt: isoDateSchema.optional(),
  acceptedAt: isoDateSchema.optional(),
  startedAt: isoDateSchema.optional(),
});

export const createTaskSchema = z.object({
  ventureId: idSchema,
  groupId: idSchema,
  outcomeId: idSchema.optional(),
  parentTaskId: idSchema.optional(),
  channelId: idSchema.optional(),
  title: z.string().trim().min(1).max(200),
  outcome: z.string().trim().min(1).max(2_000),
  assigneeId: idSchema,
  reviewerId: idSchema.optional(),
  priority: taskPrioritySchema.default("medium"),
  dueAt: isoDateSchema,
  reviewAt: isoDateSchema.optional(),
  timezone: timezoneSchema,
  estimatedMinutes: z.number().int().min(1).max(100_800),
  definitionOfDone: z.string().trim().min(1).max(5_000),
  evidenceRequirement: z.string().trim().min(1).max(2_000),
  details: z.string().trim().max(20_000).optional(),
  dependencies: z.array(idSchema).max(100).default([]),
  evidenceLinks: z.array(z.url()).max(100).default([]),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
});

export const updateTaskSchema = z.object({
  status: taskStatusSchema.optional(),
  assigneeId: idSchema.optional(),
  reviewerId: idSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueAt: isoDateSchema.optional(),
  estimatedMinutes: z.number().int().min(1).max(100_800).optional(),
  evidenceLinks: z.array(z.url()).max(100).optional(),
  blocker: z.string().trim().max(2_000).nullable().optional(),
  // The task's details: only its creator or a workspace admin may change these.
  title: createTaskSchema.shape.title.optional(),
  outcome: createTaskSchema.shape.outcome.optional(),
  definitionOfDone: createTaskSchema.shape.definitionOfDone.optional(),
  evidenceRequirement: createTaskSchema.shape.evidenceRequirement.optional(),
  /** Empty or null clears it. */
  details: z.string().trim().max(20_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one update is required");

/** The fields of a task only its creator or a workspace admin may edit. */
export const taskDetailFields = ["title", "outcome", "definitionOfDone", "evidenceRequirement", "details", "tags"] as const;

export const outcomeSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema,
  title: z.string().min(1).max(200), description: z.string().min(1).max(5_000),
  ownerId: idSchema, priority: taskPrioritySchema, startAt: isoDateSchema, reviewAt: isoDateSchema,
  successEvidence: z.string().min(1).max(2_000), status: z.enum(["draft", "approved", "active", "at_risk", "achieved", "cancelled"]),
  risk: z.string().max(2_000).optional(), decisionId: idSchema.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});

export const createOutcomeSchema = outcomeSchema.omit({ id: true, workspaceId: true, createdAt: true, updatedAt: true });
export const updateOutcomeSchema = createOutcomeSchema.omit({ ventureId: true }).partial().refine((value) => Object.keys(value).length > 0);

export const evidenceItemSchema = z.object({
  id: idSchema, workspaceId: idSchema, taskId: idSchema, type: z.enum(["link", "file", "note"]),
  title: z.string().min(1).max(200), uri: z.url().optional(), description: z.string().max(2_000),
  submittedBy: idSchema, submittedAt: isoDateSchema, reviewStatus: z.enum(["pending", "accepted", "rejected", "exception"]),
  reviewedBy: idSchema.optional(),
});
export const createEvidenceSchema = z.object({
  type: evidenceItemSchema.shape.type.default("link"),
  title: evidenceItemSchema.shape.title,
  description: evidenceItemSchema.shape.description,
  uri: z.url({ protocol: /^https?$/ }).optional(),
});

export const taskUpdateSchema = z.object({
  id: idSchema, workspaceId: idSchema, taskId: idSchema, authorId: idSchema,
  type: z.enum(["comment", "status", "blocker", "evidence", "acceptance"]), body: z.string().max(5_000),
  fromStatus: taskStatusSchema.optional(), toStatus: taskStatusSchema.optional(), createdAt: isoDateSchema,
  /** Set when written through a Claude connection. */
  via: z.literal("claude").optional(),
});

/** Ready-made lists: still open (not done, cancelled, or parked), evidence waiting for me to review, overdue, finished, or everything. */
export const taskViewSchema = z.enum(["open", "review", "overdue", "done", "all"]);
/** Soonest due first, most urgent first, most recently changed first, or newest first. Without one, tasks come in id order. */
export const taskSortSchema = z.enum(["due", "priority", "updated", "newest"]);
export const taskListQuerySchema = cursorQuerySchema.extend({
  ventureId: idSchema.optional(), groupId: idSchema.optional(), assigneeId: idSchema.optional(), reviewerId: idSchema.optional(),
  status: taskStatusSchema.optional(), priority: taskPrioritySchema.optional(), tag: z.string().optional(),
  view: taskViewSchema.optional(), sort: taskSortSchema.optional(),
  /** Words in the title, outcome, or tags. */
  q: z.string().trim().min(1).max(100).regex(/^[^\u0000]*$/, "Search can't contain a null character").optional(),
  /** Due on or after `dueFrom` and before `dueTo`. */
  dueFrom: isoDateSchema.optional(), dueTo: isoDateSchema.optional(),
  /** "true" adds how many tasks each list holds, under the same venture, people, priority, tag, and search. */
  counts: z.enum(["true", "false"]).optional(),
});
export const taskListCountsSchema = z.object({ open: z.number().int(), review: z.number().int(), overdue: z.number().int(), done: z.number().int(), all: z.number().int() });

export const commandPreviewRequestSchema = z.object({
  channelId: idSchema,
  input: z.string().trim().min(1).max(2_000),
});

export const assignCommandSchema = z.object({
  kind: z.literal("assign"), assignee: z.string(), title: z.string(), dueAt: isoDateSchema,
  estimatedMinutes: z.number().int().min(1).max(100_800), timezone: timezoneSchema,
});
export const notifyCommandSchema = z.object({
  kind: z.literal("notify"), recipient: z.string(), message: z.string(), scheduledAt: isoDateSchema, timezone: timezoneSchema,
});
export const parsedCommandSchema = z.discriminatedUnion("kind", [assignCommandSchema, notifyCommandSchema]);

export const commandPreviewSchema = z.object({
  previewId: idSchema,
  normalizedInput: z.string(),
  expiresAt: isoDateSchema,
  command: parsedCommandSchema,
  warnings: z.array(z.string()),
});

export const commandExecuteSchema = z.object({
  previewId: idSchema,
  idempotencyKey: z.string().min(8).max(200),
});

export const reminderSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  taskId: idSchema.optional(),
  message: z.string().min(1).max(2_000),
  scheduledAt: isoDateSchema,
  timezone: timezoneSchema,
  repeatMinutes: z.literal(10).nullable(),
  state: z.enum(["scheduled", "claimed", "completed", "cancelled"]),
  sequence: z.number().int().nonnegative(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

// A member's own reminder at a time, optionally about a task they can open.
export const createReminderSchema = z.object({ at: isoDateSchema, message: z.string().trim().min(1).max(500), taskId: idSchema.optional() }).strict();
export const snoozeSchema = z.object({ minutes: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal("never")]) });

export const focusSessionSchema = z.object({
  id: idSchema, workspaceId: idSchema, userId: idSchema, taskId: idSchema.optional(),
  plannedMinutes: z.number().int().min(1).max(240), startedAt: isoDateSchema,
  endsAt: isoDateSchema, completedAt: isoDateSchema.optional(), cancelledAt: isoDateSchema.optional(),
  // While paused, `pausedAt` is set and the clock stands still; resuming pushes `endsAt` back by the pause. `pausedMs` totals every pause.
  pausedAt: isoDateSchema.optional(), pausedMs: z.number().int().min(0).optional(),
});

export const startFocusSchema = z.object({ taskId: idSchema.optional(), plannedMinutes: z.number().int().min(1).max(240).default(25) });

export type Task = z.infer<typeof taskSchema>;
export type ParsedCommand = z.infer<typeof parsedCommandSchema>;
export type CommandPreview = z.infer<typeof commandPreviewSchema>;
