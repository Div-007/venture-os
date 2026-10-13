import { randomUUID } from "node:crypto";
import type { CelebrationFeed, CelebrationItem } from "@venture-studio/contracts";
import type { AppDb, AppDocument } from "./db.js";
import { inArchivedVenture } from "./archive-scope.js";
import { weekStartOf } from "./leaderboard.js";

type Actor = NonNullable<Express.Request["actor"]>;
const DAY = 86_400_000;
/** Celebrations older than this are skipped rather than played days late. */
export const CELEBRATION_WINDOW_DAYS = 3;
const MAX_ITEMS = 5;
export const celebrationSettingsId = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;
const time = (value: unknown) => (value instanceof Date ? value.getTime() : Number.NaN);

/** When the person's pause on celebrations ends, if they've paused them. */
export async function celebrationPause(db: AppDb, workspaceId: string, userId: string, now = new Date()): Promise<Date | undefined> {
  const settings = await db.collection("celebration_settings").findOne({ _id: celebrationSettingsId(workspaceId, userId) });
  const until = settings?.pausedUntil;
  return until instanceof Date && until > now ? until : undefined;
}

/**
 * Notes that `userId` finished `taskId`, for their celebration: once per task, whichever comes first of its evidence
 * being accepted and it being marked done. While they've paused celebrations it's kept as skipped, so it never plays.
 * It never fails the request it rides on.
 */
export async function recordCelebration(db: AppDb, input: { workspaceId: string; userId: string; taskId: string; trigger: "approved" | "done"; actorId: string }): Promise<void> {
  try {
    const now = new Date();
    const paused = await celebrationPause(db, input.workspaceId, input.userId, now);
    await db.collection("celebrations").updateOne(
      { workspaceId: input.workspaceId, userId: input.userId, taskId: input.taskId },
      { $setOnInsert: { _id: randomUUID(), trigger: input.trigger, actorId: input.actorId, createdAt: now, state: paused ? "skipped" : "pending" } },
      { upsert: true },
    );
  } catch (error) {
    // Two finishes at the same moment are the same celebration.
    if ((error as { code?: number }).code === 11000) return;
    console.error(JSON.stringify({ level: "error", event: "celebration.record_failed", taskId: input.taskId, error: error instanceof Error ? error.message : "unknown" }));
  }
}

/** The first accepted (or excepted) evidence per task: when it was handed in and when it was accepted. */
function firstAccepted(evidence: AppDocument[]) {
  const first = new Map<string, AppDocument>();
  for (const item of evidence) {
    if (item.reviewStatus !== "accepted" && item.reviewStatus !== "exception") continue;
    const current = first.get(String(item.taskId));
    if (!current || time(item.reviewedAt ?? item.submittedAt) < time(current.reviewedAt ?? current.submittedAt)) first.set(String(item.taskId), item);
  }
  return first;
}

/** Tasks finished to date, this week (weeks start on Saturday, as on the leaderboard), and on time in a row, latest first. */
async function personStats(db: AppDb, workspaceId: string, userId: string, timeZone: string, now: Date): Promise<CelebrationFeed["stats"]> {
  const tasks = await db.collection("tasks").find({ workspaceId, assigneeId: userId, status: { $ne: "cancelled" } }, { projection: { status: 1, dueAt: 1, completedAt: 1 } }).toArray();
  if (!tasks.length) return { finished: 0, thisWeek: 0, onTimeStreak: 0 };
  const accepted = firstAccepted(await db.collection("evidence_items").find({ workspaceId, taskId: { $in: tasks.map((task) => String(task._id)) }, reviewStatus: { $in: ["accepted", "exception"] } }, { projection: { taskId: 1, reviewStatus: 1, submittedAt: 1, reviewedAt: 1 } }).toArray());
  const finished: { at: number; onTime: boolean }[] = [];
  for (const task of tasks) {
    const evidence = accepted.get(String(task._id));
    const doneAt = task.status === "done" ? time(task.completedAt) : Number.NaN;
    const acceptedAt = evidence ? time(evidence.reviewedAt ?? evidence.submittedAt) : Number.NaN;
    const at = Math.min(...[doneAt, acceptedAt].filter(Number.isFinite));
    if (!Number.isFinite(at)) continue;
    const deliveredAt = evidence ? time(evidence.submittedAt) : doneAt;
    finished.push({ at, onTime: !Number.isFinite(time(task.dueAt)) || !Number.isFinite(deliveredAt) || deliveredAt <= time(task.dueAt) });
  }
  finished.sort((a, b) => b.at - a.at);
  const weekStart = weekStartOf(now, timeZone).getTime();
  let onTimeStreak = 0;
  for (const item of finished) { if (!item.onTime) break; onTimeStreak += 1; }
  return { finished: finished.length, thisWeek: finished.filter((item) => item.at >= weekStart).length, onTimeStreak };
}

/**
 * The person's unseen celebrations from the last few days (the newest five, oldest first), with what each film shows:
 * the task, how early, whether it was right first time, and who approved it. Tasks since cancelled, deleted, handed to
 * someone else, or out of the person's reach (as for opening the task) are left out. Nothing is listed while
 * celebrations are paused. Reading it changes nothing.
 */
export async function celebrationFeed(db: AppDb, actor: Actor, timeZone: string, now = new Date()): Promise<CelebrationFeed> {
  const workspaceId = actor.membership.workspaceId;
  const userId = actor.id;
  const pausedUntil = await celebrationPause(db, workspaceId, userId, now);
  const user = await db.collection("users").findOne({ _id: userId }, { projection: { name: 1 } });
  const empty: CelebrationFeed = { name: String(user?.name ?? actor.name ?? ""), stats: { finished: 0, thisWeek: 0, onTimeStreak: 0 }, items: [], ...(pausedUntil ? { pausedUntil: pausedUntil.toISOString() } : {}) };
  if (pausedUntil) return empty;
  const rows = await db.collection("celebrations").find({ workspaceId, userId, state: "pending", createdAt: { $gte: new Date(now.getTime() - CELEBRATION_WINDOW_DAYS * DAY) } }).sort({ createdAt: -1 }).limit(MAX_ITEMS * 4).toArray();
  if (!rows.length) return empty;

  const taskIds = rows.map((row) => String(row.taskId));
  const tasks = new Map((await db.collection("tasks").find({ _id: { $in: taskIds }, workspaceId }).toArray()).map((task) => [String(task._id), task]));
  const evidence = await db.collection("evidence_items").find({ workspaceId, taskId: { $in: taskIds } }, { projection: { taskId: 1, reviewStatus: 1, submittedAt: 1, reviewedAt: 1, reviewedBy: 1 } }).toArray();
  const accepted = firstAccepted(evidence);
  const ventureIds = [...new Set([...tasks.values()].map((task) => String(task.ventureId)))];
  const reviewerIds = [...new Set([...accepted.values()].map((item) => item.reviewedBy).filter((id): id is string => typeof id === "string" && id !== userId))];
  const [ventures, reviewers] = await Promise.all([
    db.collection("ventures").find({ _id: { $in: ventureIds }, workspaceId }, { projection: { name: 1 } }).toArray(),
    reviewerIds.length ? db.collection("users").find({ _id: { $in: reviewerIds } }, { projection: { name: 1 } }).toArray() : Promise.resolve([]),
  ]);
  const ventureNames = new Map(ventures.map((venture) => [String(venture._id), String(venture.name)]));
  const reviewerNames = new Map(reviewers.map((reviewer) => [String(reviewer._id), String(reviewer.name)]));

  const membership = actor.membership;
  const reachable = (task: AppDocument) => !inArchivedVenture(membership, String(task.ventureId)) && (membership.role === "admin" || (membership.ventureIds.includes(String(task.ventureId)) && membership.groupIds.includes(String(task.groupId))));
  const items: CelebrationItem[] = [];
  for (const row of rows) {
    if (items.length >= MAX_ITEMS) break;
    const task = tasks.get(String(row.taskId));
    if (!task || task.status === "cancelled" || task.assigneeId !== userId || !reachable(task)) continue;
    const first = accepted.get(String(task._id));
    const createdAt = row.createdAt instanceof Date ? row.createdAt : now;
    const delivered = first?.submittedAt instanceof Date ? first.submittedAt : task.completedAt instanceof Date ? task.completedAt : createdAt;
    const due = task.dueAt instanceof Date ? task.dueAt : undefined;
    const sentBack = evidence.some((item) => String(item.taskId) === String(task._id) && item.reviewStatus === "rejected" && (!first || time(item.submittedAt) <= time(first.submittedAt)));
    const reviewer = typeof first?.reviewedBy === "string" ? reviewerNames.get(first.reviewedBy) : undefined;
    items.push({
      id: String(row._id), taskId: String(task._id), title: String(task.title), trigger: row.trigger === "done" ? "done" : "approved", at: createdAt.toISOString(),
      ...(ventureNames.has(String(task.ventureId)) ? { ventureName: ventureNames.get(String(task.ventureId))! } : {}),
      ...(due ? { dueAt: due.toISOString(), minutesEarly: Math.round((due.getTime() - delivered.getTime()) / 60_000) } : {}),
      deliveredAt: delivered.toISOString(),
      ...(typeof task.estimatedMinutes === "number" ? { estimatedMinutes: Math.round(task.estimatedMinutes) } : {}),
      ...(["low", "medium", "high", "urgent"].includes(String(task.priority)) ? { priority: task.priority as CelebrationItem["priority"] } : {}),
      firstTimeRight: first?.reviewStatus === "accepted" && !sentBack,
      ...(reviewer && typeof first?.reviewedBy === "string" ? { approvedBy: { userId: first.reviewedBy, name: reviewer } } : {}),
    });
  }
  items.reverse();
  return { ...empty, stats: items.length ? await personStats(db, workspaceId, userId, timeZone, now) : empty.stats, items };
}
