import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";
import { taskPrioritySchema } from "./work.js";

/**
 * A celebration plays for the person a task is assigned to when it's finished: when a reviewer accepts its evidence
 * (or records an exception), or when it's marked done, whichever comes first, once per task. Someone can pause them
 * for a while; anything finished during a pause is skipped, not saved up for later.
 */
export const celebrationItemSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  title: z.string(),
  ventureName: z.string().optional(),
  /** "approved": a reviewer accepted the evidence. "done": the task was marked done. */
  trigger: z.enum(["approved", "done"]),
  at: isoDateSchema,
  dueAt: isoDateSchema.optional(),
  /** When the accepted evidence was handed in (or the task was marked done, without evidence). */
  deliveredAt: isoDateSchema.optional(),
  /** Minutes handed in ahead of the due date; negative when late. */
  minutesEarly: z.number().int().optional(),
  estimatedMinutes: z.number().int().optional(),
  priority: taskPrioritySchema.optional(),
  /** Accepted without any evidence being sent back first. */
  firstTimeRight: z.boolean(),
  /** Who accepted the evidence, when it was someone else. */
  approvedBy: z.object({ userId: idSchema, name: z.string() }).optional(),
});

export const celebrationFeedSchema = z.object({
  /** Set while celebrations are paused; nothing is listed then. */
  pausedUntil: isoDateSchema.optional(),
  /** The person's own name, for the film. */
  name: z.string(),
  /** Tasks finished to date, this week (from Saturday), and on time in a row (most recent first). */
  stats: z.object({ finished: z.number().int(), thisWeek: z.number().int(), onTimeStreak: z.number().int() }),
  /** Unseen celebrations from the last three days, oldest first, at most five. */
  items: z.array(celebrationItemSchema),
});

/** Pause for 1, 3, or 24 hours; 0 resumes now. */
export const celebrationPauseSchema = z.object({ hours: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(24)]) });
export const celebrationPauseResultSchema = z.object({ pausedUntil: isoDateSchema.nullable() });
export const celebrationSeenSchema = z.object({ ids: z.array(idSchema).min(1).max(20) });

export type CelebrationItem = z.infer<typeof celebrationItemSchema>;
export type CelebrationFeed = z.infer<typeof celebrationFeedSchema>;
