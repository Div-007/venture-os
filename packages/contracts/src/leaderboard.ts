import { z } from "zod";
import { appRoleSchema, idSchema, isoDateSchema } from "./common.js";

/**
 * The leaderboard scores how reliably people deliver what they were given, not how much they were given:
 * 70% on time (credit per task due, weighted by its estimate) and 30% first-time-right evidence, each pulled
 * toward the team average by five tasks' worth so a few tasks can't win or lose unfairly. Weeks start on Saturday.
 */
/** "all" is the lifetime board (every task to date), the one the app shows; the others are narrower windows. */
export const leaderboardPeriodSchema = z.enum(["all", "week", "last_week", "month", "30d"]);
export const leaderboardQuerySchema = z.object({
  period: leaderboardPeriodSchema.default("all"),
  ventureId: idSchema.optional(),
  learners: z.enum(["true", "false"]).optional(),
  /** A weekly edition's first day (YYYY-MM-DD): the breakdown as that edition saw it, as of the Saturday it closed. */
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const leaderboardEntrySchema = z.object({
  userId: idSchema,
  name: z.string(),
  handle: z.string().optional(),
  role: appRoleSchema,
  /** 1 for the top (equal scores share a rank); absent until someone has enough tasks counted to be ranked. */
  rank: z.number().int().optional(),
  /** The rank before, for the trend arrow: for the lifetime board, as it stood at the start of this week (Saturday). */
  previousRank: z.number().int().optional(),
  score: z.number(),
  /** On-time credit and first-time-right share, after evening out small numbers (0 to 1). */
  reliability: z.number(),
  quality: z.number(),
  /** Tasks that counted: settled in the period, meaning handed in (if early) or due then, and not cancelled or parked. */
  tasksDue: z.number().int(),
  delivered: z.number().int(),
  onTime: z.number().int(),
  late: z.number().int(),
  missed: z.number().int(),
  firstTimeRight: z.number().int(),
  /** Mean minutes late across the tasks delivered late. */
  averageMinutesLate: z.number().int().optional(),
  /** Open tasks past due right now. */
  overdueNow: z.number().int(),
});
export const leaderboardReviewerSchema = z.object({ userId: idSchema, name: z.string(), reviews: z.number().int(), medianHours: z.number() });
export const leaderboardBoardSchema = z.object({
  people: z.array(leaderboardEntrySchema),
  team: z.object({ reliability: z.number(), quality: z.number() }),
  mostDelivered: z.object({ userId: idSchema, name: z.string(), delivered: z.number().int() }).optional(),
  reviewers: z.array(leaderboardReviewerSchema),
});
export const leaderboardSchema = leaderboardBoardSchema.extend({
  period: z.object({ key: leaderboardPeriodSchema, from: isoDateSchema, to: isoDateSchema }),
  timeZone: z.string(),
  /** People need this many tasks counted in the period to be ranked. */
  minimumTasks: z.number().int(),
});

export const leaderboardTaskOutcomeSchema = z.enum(["on_time", "late", "missed"]);
export const leaderboardPersonSchema = z.object({
  entry: leaderboardEntrySchema,
  period: z.object({ key: leaderboardPeriodSchema, from: isoDateSchema, to: isoDateSchema }),
  /** The tasks that counted and what each earned (only tasks the viewer can open). */
  tasks: z.array(z.object({
    id: idSchema, title: z.string(), dueAt: isoDateSchema, deliveredAt: isoDateSchema.optional(),
    outcome: leaderboardTaskOutcomeSchema, credit: z.number(), minutesLate: z.number().int().optional(),
    /** Hours added to the due date: time spent blocked, and the shortfall when it was given with less time than its estimate. */
    blockedHours: z.number().optional(), allowanceHours: z.number().optional(),
    firstTimeRight: z.boolean().optional(),
  })),
  /** Counted tasks in ventures or groups the viewer can't open. */
  hidden: z.number().int(),
});

/** The Saturday edition: the lifetime board as it stood at Saturday midnight (with each person's move that week), frozen when first opened. */
export const leaderboardWeeklySchema = z.object({
  id: z.string(),
  weekStart: isoDateSchema,
  weekEnd: isoDateSchema,
  timeZone: z.string(),
  generatedAt: isoDateSchema,
  board: leaderboardBoardSchema,
  seen: z.boolean(),
  minimumTasks: z.number().int(),
});
export const leaderboardWeeklyStatusSchema = z.object({ id: z.string(), weekStart: isoDateSchema, weekEnd: isoDateSchema, ranked: z.number().int(), seen: z.boolean() });

export type LeaderboardPeriod = z.infer<typeof leaderboardPeriodSchema>;
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
export type LeaderboardBoard = z.infer<typeof leaderboardBoardSchema>;
export type Leaderboard = z.infer<typeof leaderboardSchema>;
export type LeaderboardPerson = z.infer<typeof leaderboardPersonSchema>;
export type LeaderboardWeekly = z.infer<typeof leaderboardWeeklySchema>;
