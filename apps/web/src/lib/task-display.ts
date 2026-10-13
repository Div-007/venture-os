import type { Task } from "@venture-studio/contracts";
import { describeError } from "@/lib/errors";

export type TaskStatus = Task["status"];

export const TASK_STATUSES: TaskStatus[] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
export const statusLabel = (value: string) => value.replaceAll("_", " ");
export const displayDate = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
export const taskError = (cause: unknown) => describeError(cause, "The request failed. Please try again.");
export const atRisk = (task: Task) => task.deadlineRisk && !["done", "cancelled", "parked"].includes(task.status);
export const safeHttpUrl = (value: string) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } };
export const priorityTone = (task: Task) => task.priority === "urgent" || task.priority === "high" ? "red" as const : "neutral" as const;
export const statusTone = (task: Task) => task.status === "blocked" ? "red" as const : task.status === "done" ? "green" as const : "blue" as const;

/** Off the open list: finished, dropped, or paused on purpose. */
export const offList = (task: Task) => ["done", "cancelled", "parked"].includes(task.status);
/** Midnight today, tomorrow, and a week from today, in this browser's time zone. */
export function dayStarts(now = new Date()) {
  const at = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return { today: at(0), tomorrow: at(1), dayAfter: at(2), week: at(7) };
}
export type DueBucket = "past" | "today" | "week" | "later";
/** Which date heading a task sits under in a list sorted by due date; with `overdueFirst`, open work already late (even by hours) is "past". */
export function dueBucket(task: Task, now = new Date(), overdueFirst = false): DueBucket {
  const due = new Date(task.dueAt); const { today, tomorrow, week } = dayStarts(now);
  if (due < today || (overdueFirst && !offList(task) && due < now)) return "past";
  return due < tomorrow ? "today" : due < week ? "week" : "later";
}
/** How a due date reads in a list: overdue in red, today and tomorrow by name, this week by weekday. */
export function dueLabel(task: Task, now = new Date()): { text: string; tone: "red" | "amber" | "neutral" } {
  const due = new Date(task.dueAt);
  const { today, tomorrow, dayAfter, week } = dayStarts(now);
  const open = !offList(task);
  const short = (date: Date) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) }).format(date);
  // Finished work says when it was finished.
  if (task.status === "done") return { text: `Done ${short(new Date(task.completedAt ?? task.updatedAt))}`, tone: "neutral" };
  if (open && due < now) {
    // Calendar days, as people count them: due on the 7th is three days overdue on the 10th, whatever the hour.
    const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(due.getFullYear(), due.getMonth(), due.getDate())) / 86_400_000);
    const hours = Math.max(1, Math.floor((now.getTime() - due.getTime()) / 3_600_000));
    return { text: days >= 1 ? `Overdue by ${days} day${days === 1 ? "" : "s"}` : `Overdue by ${hours} hour${hours === 1 ? "" : "s"}`, tone: "red" };
  }
  const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(due);
  if (due >= today && due < tomorrow) return { text: `Due today, ${time}`, tone: open ? "amber" : "neutral" };
  if (due >= tomorrow && due < dayAfter) return { text: `Due tomorrow, ${time}`, tone: "neutral" };
  if (due >= today && due < week) return { text: `Due ${new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(due)}`, tone: "neutral" };
  return { text: `Due ${short(due)}`, tone: "neutral" };
}
