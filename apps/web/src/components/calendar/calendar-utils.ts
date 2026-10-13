import type { CalendarLayerItem, CalendarOccurrence } from "@venture-studio/contracts";
import { CircleCheck, Clock3, FileQuestion, FolderOpen, Target, Users, type Icon } from "@/components/ui/icons";

export type CalendarView = "month" | "week" | "day" | "agenda";
export type LayerKey = "tasks" | "reviews" | "classes" | "requests" | "deals" | "outcomes";
export const HOUR_PX = 48;
export const SNAP_MINUTES = 15;
const pad = (value: number) => String(value).padStart(2, "0");

/** Dates here are local to the viewer: a "day" is the viewer's day. */
export const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const fromDayKey = (key: string) => { const [y, m, d] = key.split("-").map(Number); return new Date(y!, m! - 1, d!); };
export const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
export const addMonths = (date: Date, months: number) => new Date(date.getFullYear(), date.getMonth() + months, 1);
/** Weeks start on Monday. */
export const startOfWeek = (date: Date) => addDays(startOfDay(date), -((date.getDay() + 6) % 7));
export const isSameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);
export const minutesIntoDay = (date: Date) => date.getHours() * 60 + date.getMinutes();
export const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const timeText = (date: Date) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
export const timeValue = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
export const dateFromValues = (day: string, time: string) => { const date = fromDayKey(day); const [h, m] = time.split(":").map(Number); date.setHours(h ?? 0, m ?? 0, 0, 0); return date; };
export const daysBetweenKeys = (from: string, to: string) => Math.round((fromDayKey(to).getTime() - fromDayKey(from).getTime()) / 86_400_000);
export const shiftKey = (key: string, days: number) => dayKey(addDays(fromDayKey(key), days));

/** The days a view shows and the range it asks the API for. */
export function viewRange(view: CalendarView, anchor: Date): { from: Date; to: Date; days: Date[] } {
  const length = view === "month" ? 42 : view === "week" ? 7 : view === "day" ? 1 : 30;
  const from = view === "month" ? startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1)) : view === "week" ? startOfWeek(anchor) : startOfDay(anchor);
  const days = Array.from({ length }, (_, index) => addDays(from, index));
  return { from, to: addDays(from, length), days };
}

export function stepAnchor(view: CalendarView, anchor: Date, direction: 1 | -1): Date {
  if (view === "month") return addMonths(anchor, direction);
  return addDays(anchor, direction * (view === "week" ? 7 : view === "day" ? 1 : 30));
}

export function rangeTitle(view: CalendarView, anchor: Date): string {
  const days = viewRange(view, anchor).days;
  if (view === "month") return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(anchor);
  if (view === "day") return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(anchor);
  const first = days[0]!; const last = days[days.length - 1]!;
  const sameMonth = first.getMonth() === last.getMonth();
  const short = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  return `${sameMonth ? first.getDate() : short.format(first)} – ${short.format(last)} ${last.getFullYear()}`;
}

/** An occurrence's local days: all-day dates as written; a timed event on each day it touches. */
export function occurrenceDays(item: CalendarOccurrence): string[] {
  if (item.allDay) { const span = Math.max(1, daysBetweenKeys(item.startDate!, item.endDate!)); return Array.from({ length: span }, (_, index) => shiftKey(item.startDate!, index)); }
  const start = new Date(item.startAt); const end = new Date(new Date(item.endAt).getTime() - 1);
  const keys: string[] = [];
  for (let day = startOfDay(start); day <= end && keys.length < 15; day = addDays(day, 1)) keys.push(dayKey(day));
  return keys.length ? keys : [dayKey(start)];
}

export type Piece = { item: CalendarOccurrence; day: string; startMinute: number; endMinute: number; before: boolean; after: boolean };
/** Timed occurrences cut into per-day pieces (an event past midnight continues the next day). */
export function timedPieces(items: CalendarOccurrence[], day: string): Piece[] {
  const dayStart = fromDayKey(day).getTime(); const dayEnd = addDays(fromDayKey(day), 1).getTime();
  return items.filter((item) => !item.allDay).flatMap((item) => {
    const start = new Date(item.startAt).getTime(); const end = new Date(item.endAt).getTime();
    if (end <= dayStart || start >= dayEnd) return [];
    const from = Math.max(start, dayStart); const to = Math.min(end, dayEnd);
    return [{ item, day, startMinute: Math.round((from - dayStart) / 60_000), endMinute: Math.max(Math.round((to - dayStart) / 60_000), Math.round((from - dayStart) / 60_000) + 15), before: start < dayStart, after: end > dayEnd }];
  });
}

/** Overlapping pieces side by side: each gets a column and the number of columns in its cluster. */
export function layoutPieces(pieces: Piece[]): (Piece & { column: number; columns: number })[] {
  const sorted = [...pieces].sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);
  const placed: (Piece & { column: number; columns: number })[] = [];
  let cluster: (Piece & { column: number; columns: number })[] = []; let clusterEnd = -1;
  const close = () => { const columns = Math.max(1, ...cluster.map((item) => item.column + 1)); for (const item of cluster) item.columns = columns; cluster = []; };
  for (const piece of sorted) {
    if (piece.startMinute >= clusterEnd) { close(); clusterEnd = -1; }
    const busy = new Set(cluster.filter((item) => item.endMinute > piece.startMinute).map((item) => item.column));
    let column = 0; while (busy.has(column)) column++;
    const entry = { ...piece, column, columns: 1 };
    cluster.push(entry); placed.push(entry); clusterEnd = Math.max(clusterEnd, piece.endMinute);
  }
  close();
  return placed;
}

export const colorClass = (color: string) => `vso-cal-${color}`;
/** Maybe and unanswered invitations are hatched; declined ones fade. */
export const responseClass = (response: string) => response === "declined" ? "vso-cal-declined" : response === "maybe" || response === "pending" ? "vso-cal-tentative" : "";

export const LAYERS: { key: LayerKey; label: string; kinds: CalendarLayerItem["kind"][] }[] = [
  { key: "tasks", label: "Task deadlines", kinds: ["task_due"] }, { key: "reviews", label: "Reviews", kinds: ["review"] },
  { key: "classes", label: "Classes", kinds: ["class"] }, { key: "requests", label: "Information requests", kinds: ["request_due"] },
  { key: "deals", label: "Deal follow-ups", kinds: ["deal_followup"] }, { key: "outcomes", label: "Outcome reviews", kinds: ["outcome_review"] },
];
export const LAYER_ICON: Record<CalendarLayerItem["kind"], Icon> = { task_due: CircleCheck, review: Clock3, class: Users, request_due: FileQuestion, deal_followup: FolderOpen, outcome_review: Target };
export const LAYER_LABEL: Record<CalendarLayerItem["kind"], string> = { task_due: "Due", review: "Review", class: "Class", request_due: "Request due", deal_followup: "Follow up", outcome_review: "Outcome review" };

export const TIMED_REMINDERS: { minutes: number; label: string }[] = [{ minutes: 0, label: "At start" }, { minutes: 5, label: "5 min" }, { minutes: 10, label: "10 min" }, { minutes: 15, label: "15 min" }, { minutes: 30, label: "30 min" }, { minutes: 60, label: "1 hour" }, { minutes: 120, label: "2 hours" }, { minutes: 1440, label: "1 day" }];
export const ALL_DAY_REMINDERS: { minutes: number; label: string }[] = [{ minutes: 900, label: "Day before, 9:00" }, { minutes: -540, label: "On the day, 9:00" }];
export const EVENT_COLORS = ["green", "blue", "teal", "violet", "amber", "red", "neutral"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Every week on Mon, Wed" and the like, for an event's repeat rule. */
export function repeatText(recurrence: { freq: string; interval: number; weekdays?: number[]; until?: string; count?: number } | null | undefined): string {
  if (!recurrence) return "";
  const unit = { daily: "day", weekly: "week", monthly: "month" }[recurrence.freq] ?? "time";
  const every = recurrence.interval > 1 ? `Every ${recurrence.interval} ${unit}s` : `Every ${unit}`;
  const days = recurrence.freq === "weekly" && recurrence.weekdays?.length ? ` on ${[...recurrence.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => WEEKDAY_SHORT[day]).join(", ")}` : "";
  const end = recurrence.until ? `, until ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(fromDayKey(recurrence.until))}` : recurrence.count ? `, ${recurrence.count} times` : "";
  return `${every}${days}${end}`;
}

/** "Fri 16 Oct · 16:00 – 17:00" (or "· all day"), in the viewer's own time. */
export function whenText(item: { allDay: boolean; startAt: string; endAt: string; startDate?: string | undefined; endDate?: string | undefined }): string {
  const longDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  if (item.allDay) {
    const first = fromDayKey(item.startDate!); const last = addDays(fromDayKey(item.endDate!), -1);
    return isSameDay(first, last) ? `${longDay.format(first)} · all day` : `${longDay.format(first)} – ${longDay.format(last)} · all day`;
  }
  const start = new Date(item.startAt); const end = new Date(item.endAt);
  return isSameDay(start, end) ? `${longDay.format(start)} · ${timeText(start)} – ${timeText(end)}` : `${longDay.format(start)} ${timeText(start)} – ${longDay.format(end)} ${timeText(end)}`;
}
