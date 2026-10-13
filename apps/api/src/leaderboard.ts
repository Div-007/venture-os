import type { LeaderboardBoard, LeaderboardEntry, LeaderboardPeriod } from "@venture-studio/contracts";
import { localDate, wallTime, zonedTimeToUtc } from "@venture-studio/core";
import type { AppDb } from "./db.js";

/** People need this many tasks counted in a period to be ranked (the evening out guards against luck). */
export const MINIMUM_TASKS = 2;
/** Each person's rates are pulled toward the team's as if they had this many more tasks at the team average. */
const PRIOR_TASKS = 5;
/** The score: 70% on time, 30% evidence accepted the first time. */
const ON_TIME_SHARE = 0.7;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Blocked time moves a due date back by at most this much, so a task left blocked can't stay "not due yet" for ever. */
const MAX_BLOCKED_EXTENSION = 7 * DAY;
/** Not counted at all: dropped, paused on purpose, or never really handed over. */
const UNCOUNTED = ["cancelled", "parked", "draft"];
/** Still open: the statuses "overdue now" looks in. */
const OPEN = ["proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review"];
/** Work handed in: accepted, accepted as an exception, or waiting for review (a slow reviewer must not make it late; a later rejection undoes it). */
const HANDED_IN = ["accepted", "exception", "pending"];

/** Local midnight `days` days after the local date of `instant`. */
function localMidnight(instant: Date, timeZone: string, days = 0): Date {
  const wall = wallTime(instant, timeZone);
  const day = new Date(Date.UTC(wall.y, wall.m - 1, wall.d + days));
  return zonedTimeToUtc({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), hh: 0, mm: 0 }, timeZone);
}
/** Saturday midnight on or before `instant`: weeks run Saturday to Friday, so the weekly edition appears on Saturday. */
export function weekStartOf(instant: Date, timeZone: string): Date {
  const wall = wallTime(instant, timeZone);
  const sinceSaturday = (new Date(Date.UTC(wall.y, wall.m - 1, wall.d)).getUTCDay() + 1) % 7;
  return localMidnight(instant, timeZone, -sinceSaturday);
}
export { localDate };
export function periodRange(period: LeaderboardPeriod, now: Date, timeZone: string): { from: Date; to: Date } {
  if (period === "all") return { from: new Date(0), to: now };
  const thisWeek = weekStartOf(now, timeZone);
  if (period === "week") return { from: thisWeek, to: now };
  if (period === "last_week") return { from: localMidnight(thisWeek, timeZone, -7), to: thisWeek };
  if (period === "month") { const wall = wallTime(now, timeZone); return { from: localMidnight(now, timeZone, 1 - wall.d), to: now }; }
  return { from: new Date(now.getTime() - 30 * DAY), to: now };
}
/**
 * What the trend arrows compare with: for the lifetime board, the board as it stood at the start of this week (Saturday
 * midnight), so the arrows show who moved this week; the whole previous week or month for those; otherwise the same length
 * just before.
 */
export function previousRange(period: LeaderboardPeriod, { from, to }: { from: Date; to: Date }, timeZone: string) {
  if (period === "all") return { from, to: weekStartOf(to, timeZone) };
  if (period === "week") return { from: localMidnight(from, timeZone, -7), to: from };
  if (period === "month") { const before = localMidnight(from, timeZone, -1); const wall = wallTime(before, timeZone); return { from: localMidnight(before, timeZone, 1 - wall.d), to: from }; }
  return { from: new Date(from.getTime() - (to.getTime() - from.getTime())), to: from };
}

export type TaskResult = {
  id: string; title: string; ventureId: string; groupId: string; assigneeId: string; dueAt: Date; deliveredAt?: Date;
  outcome: "on_time" | "late" | "missed"; credit: number; weight: number; lateMs: number; blockedMs: number; allowanceMs: number; firstTimeRight?: boolean;
};
/**
 * `now` is the moment the board is "as of": evidence sent after it doesn't count yet (the weekly edition is as of Saturday
 * midnight, whenever it's first opened). `light` skips what only the current board shows (overdue now, reviewers).
 */
export type BoardInput = { workspaceId: string; from: Date; to: Date; now: Date; ventureId?: string; includeLearners: boolean; archivedVentureIds?: string[]; light?: boolean };
export type ComputedBoard = LeaderboardBoard & { tasks: Map<string, TaskResult[]> };

/** On-time credit by how late the work came in, after the allowances. */
const creditFor = (lateMs: number) => lateMs <= 0 ? 1 : lateMs <= DAY ? 0.75 : lateMs <= 3 * DAY ? 0.5 : 0.25;
const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; };

/**
 * Scores the tasks due in [from, to). A task counts as delivered when its evidence was sent (accepted, or still waiting
 * for review), so a slow reviewer never makes the assignee late. The shortfall when a task was handed over with less time
 * than its estimate, and time spent blocked (from before it was late, up to a week), move its due date back. Unfinished
 * work past that due date earns nothing.
 */
export async function computeBoard(db: AppDb, input: BoardInput): Promise<ComputedBoard> {
  const { workspaceId, from, to, now } = input;
  const memberships = await db.collection("memberships").find({ workspaceId, status: "active" }, { projection: { userId: 1, role: 1 } }).toArray();
  const roles = new Map(memberships.filter((item) => input.includeLearners || item.role !== "learner").map((item) => [String(item.userId), String(item.role)]));
  const people = [...roles.keys()];
  const users = new Map((await db.collection("users").find({ _id: { $in: people } }, { projection: { name: 1, handle: 1 } }).toArray()).map((user) => [String(user._id), user]));
  const venture = input.ventureId ? { ventureId: input.ventureId } : input.archivedVentureIds?.length ? { ventureId: { $nin: input.archivedVentureIds } } : {};

  // A task counts in the period it settled: when it was handed in, if that was before its due date, otherwise when it was
  // due. So work finished early counts straight away, and work not handed in still counts (as late or missed) when due.
  const fields = { projection: { title: 1, assigneeId: 1, dueAt: 1, createdAt: 1, estimatedMinutes: 1, ventureId: 1, groupId: 1 } };
  const dueInPeriod = await db.collection("tasks").find({ workspaceId, assigneeId: { $in: people }, dueAt: { $gte: from, $lt: to }, status: { $nin: UNCOUNTED }, ...venture }, fields).toArray();
  const handedInEarly = await db.collection("evidence_items").distinct("taskId", { workspaceId, submittedAt: { $gte: from, $lt: to, $lte: now }, reviewStatus: { $in: HANDED_IN } });
  const alreadyDue = new Set(dueInPeriod.map((task) => String(task._id)));
  const laterIds = handedInEarly.map(String).filter((id) => !alreadyDue.has(id));
  const dueLater = laterIds.length ? await db.collection("tasks").find({ workspaceId, _id: { $in: laterIds }, assigneeId: { $in: people }, dueAt: { $gte: to }, status: { $nin: UNCOUNTED }, ...venture }, fields).toArray() : [];
  const tasks = [...dueInPeriod, ...dueLater];
  const taskIds = tasks.map((task) => String(task._id));
  const evidence = taskIds.length ? await db.collection("evidence_items").find({ workspaceId, taskId: { $in: taskIds }, submittedAt: { $lte: now } }, { projection: { taskId: 1, submittedAt: 1, reviewStatus: 1 } }).toArray() : [];
  const changes = taskIds.length ? await db.collection("task_updates").find({ taskId: { $in: taskIds }, type: "status" }, { projection: { taskId: 1, toStatus: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray() : [];
  const byTask = <T extends Record<string, unknown>>(items: T[]) => { const map = new Map<string, T[]>(); for (const item of items) { const key = String(item.taskId); map.set(key, [...(map.get(key) ?? []), item]); } return map; };
  const evidenceOf = byTask(evidence); const changesOf = byTask(changes);

  const results = new Map<string, TaskResult[]>();
  for (const task of tasks) {
    const id = String(task._id);
    const items = (evidenceOf.get(id) ?? []).filter((item) => item.submittedAt instanceof Date).sort((a, b) => (a.submittedAt as Date).getTime() - (b.submittedAt as Date).getTime());
    const handedIn = items.find((item) => HANDED_IN.includes(String(item.reviewStatus)));
    const deliveredAt = handedIn?.submittedAt as Date | undefined;
    const end = (deliveredAt ?? now).getTime();
    const dueAt = task.dueAt as Date;
    const settledAt = deliveredAt && deliveredAt <= dueAt ? deliveredAt : dueAt;
    if (settledAt < from || settledAt >= to) continue; // handed in early, in another period
    const estimateMs = Number(task.estimatedMinutes ?? 60) * 60_000;
    const allowanceMs = task.createdAt instanceof Date ? Math.max(0, estimateMs - (dueAt.getTime() - task.createdAt.getTime())) : 0;
    // Blocked time pauses the clock, but only for a block that began before the work was late, and for a week at most.
    let due = dueAt.getTime() + allowanceMs; let blockedMs = 0; let blockedSince: number | undefined;
    const unblock = (at: number) => { const added = Math.min(Math.max(0, at - blockedSince!), MAX_BLOCKED_EXTENSION - blockedMs); blockedMs += added; due += added; blockedSince = undefined; };
    for (const change of changesOf.get(id) ?? []) {
      const at = Math.min((change.createdAt as Date).getTime(), end);
      if (change.toStatus === "blocked") { if (blockedSince === undefined && at < due) blockedSince = at; }
      else if (blockedSince !== undefined) unblock(at);
    }
    if (blockedSince !== undefined) unblock(end);
    if (!deliveredAt && now.getTime() <= due) continue; // not due yet, after the allowances
    const lateMs = deliveredAt ? deliveredAt.getTime() - due : now.getTime() - due;
    const result: TaskResult = {
      id, title: String(task.title), ventureId: String(task.ventureId), groupId: String(task.groupId), assigneeId: String(task.assigneeId), dueAt, deliveredAt,
      outcome: !deliveredAt ? "missed" : lateMs <= 0 ? "on_time" : "late", credit: deliveredAt ? creditFor(lateMs) : 0,
      weight: Math.min(4, Math.max(0.5, estimateMs / HOUR)), lateMs: Math.max(0, lateMs), blockedMs, allowanceMs,
      firstTimeRight: deliveredAt ? !items.some((item) => item.reviewStatus === "rejected" && (item.submittedAt as Date) <= deliveredAt) : undefined,
    };
    results.set(result.assigneeId, [...(results.get(result.assigneeId) ?? []), result]);
  }

  // The team's pooled rates, which each person's are pulled toward.
  const all = [...results.values()].flat();
  const weightOf = (items: TaskResult[]) => items.reduce((sum, item) => sum + item.weight, 0);
  const creditOf = (items: TaskResult[]) => items.reduce((sum, item) => sum + item.weight * item.credit, 0);
  const teamReliability = all.length ? creditOf(all) / weightOf(all) : 1;
  const deliveredAll = all.filter((item) => item.deliveredAt);
  const teamQuality = deliveredAll.length ? deliveredAll.filter((item) => item.firstTimeRight).length / deliveredAll.length : 1;

  // Open work past due right now with nothing handed in, for context (not part of the score).
  const overdue = input.light ? [] : await db.collection("tasks").find({ workspaceId, assigneeId: { $in: people }, status: { $in: OPEN }, dueAt: { $lt: now }, ...venture }, { projection: { assigneeId: 1 } }).toArray();
  const settled = new Set(overdue.length ? (await db.collection("evidence_items").find({ workspaceId, taskId: { $in: overdue.map((task) => String(task._id)) }, reviewStatus: { $in: HANDED_IN } }, { projection: { taskId: 1 } }).toArray()).map((item) => String(item.taskId)) : []);
  const overdueNow = new Map<string, number>();
  for (const task of overdue) if (!settled.has(String(task._id))) overdueNow.set(String(task.assigneeId), (overdueNow.get(String(task.assigneeId)) ?? 0) + 1);

  const name = (userId: string) => String(users.get(userId)?.name ?? "Former member");
  const entries: LeaderboardEntry[] = [...results.entries()].map(([userId, items]) => {
    const delivered = items.filter((item) => item.deliveredAt);
    const late = items.filter((item) => item.outcome === "late");
    const firstTimeRight = delivered.filter((item) => item.firstTimeRight).length;
    const reliability = (items.length * (creditOf(items) / weightOf(items)) + PRIOR_TASKS * teamReliability) / (items.length + PRIOR_TASKS);
    const quality = ((delivered.length ? firstTimeRight : 0) + PRIOR_TASKS * teamQuality) / (delivered.length + PRIOR_TASKS);
    const handle = users.get(userId)?.handle;
    return {
      userId, name: name(userId), ...(typeof handle === "string" ? { handle } : {}), role: roles.get(userId) as LeaderboardEntry["role"],
      score: round(100 * (ON_TIME_SHARE * reliability + (1 - ON_TIME_SHARE) * quality)), reliability: round(reliability, 4), quality: round(quality, 4),
      tasksDue: items.length, delivered: delivered.length, onTime: items.filter((item) => item.outcome === "on_time").length, late: late.length,
      missed: items.filter((item) => item.outcome === "missed").length, firstTimeRight,
      ...(late.length ? { averageMinutesLate: Math.round(late.reduce((sum, item) => sum + item.lateMs, 0) / late.length / 60_000) } : {}),
      overdueNow: overdueNow.get(userId) ?? 0,
    };
  });
  entries.sort((a, b) => b.score - a.score || b.delivered - a.delivered || a.name.localeCompare(b.name));
  // Equal scores share a rank (1, 2, 2, 4).
  let place = 0; let previous: LeaderboardEntry | undefined;
  for (const entry of entries) {
    if (entry.tasksDue < MINIMUM_TASKS) continue;
    place += 1;
    entry.rank = previous && previous.score === entry.score ? previous.rank : place;
    previous = entry;
  }

  const busiest = entries.filter((entry) => entry.delivered > 0).sort((a, b) => b.delivered - a.delivered || b.score - a.score)[0];

  // Reviewers: how many reviews each did in the period, and how quickly. Reviewing your own work doesn't count.
  const reviewed = input.light ? [] : await db.collection("evidence_items").find({ workspaceId, reviewedAt: { $gte: from, $lt: to }, reviewedBy: { $in: people }, reviewStatus: { $in: ["accepted", "rejected", "exception"] } }, { projection: { taskId: 1, reviewedBy: 1, reviewedAt: 1, submittedAt: 1, submittedBy: 1 } }).toArray();
  const reviewedTasks = new Map(reviewed.length ? (await db.collection("tasks").find({ workspaceId, _id: { $in: [...new Set(reviewed.map((item) => String(item.taskId)))] }, ...venture }, { projection: { assigneeId: 1 } }).toArray()).map((task) => [String(task._id), String(task.assigneeId)]) : []);
  const counted = reviewed.filter((item) => reviewedTasks.has(String(item.taskId)) && item.reviewedBy !== item.submittedBy && item.reviewedBy !== reviewedTasks.get(String(item.taskId)));
  const turnaround = new Map<string, number[]>();
  for (const item of counted) if (item.reviewedAt instanceof Date && item.submittedAt instanceof Date) turnaround.set(String(item.reviewedBy), [...(turnaround.get(String(item.reviewedBy)) ?? []), Math.max(0, item.reviewedAt.getTime() - item.submittedAt.getTime()) / HOUR]);
  const reviewers = [...turnaround.entries()].map(([userId, hours]) => ({ userId, name: name(userId), reviews: hours.length, medianHours: round(median(hours)) }))
    .sort((a, b) => b.reviews - a.reviews || a.medianHours - b.medianHours).slice(0, 3);

  return {
    people: entries, team: { reliability: round(teamReliability, 4), quality: round(teamQuality, 4) },
    ...(busiest ? { mostDelivered: { userId: busiest.userId, name: busiest.name, delivered: busiest.delivered } } : {}),
    reviewers, tasks: results,
  };
}
