/**
 * Calendar date and time-zone arithmetic shared by the API, the reminder worker, and the calendar feed.
 * Timed events are real instants that repeat at the same wall-clock time in the event's time zone; all-day events are
 * plain dates (end exclusive) that mean the same days wherever they are viewed.
 */

export type Recurrence = { freq: "daily" | "weekly" | "monthly"; interval: number; weekdays?: number[]; until?: string; count?: number };
export type CalendarTiming = { allDay: boolean; startAt: Date; endAt: Date; startDate?: string; endDate?: string; timezone: string; recurrence?: Recurrence | null; exdates?: string[] };
/** One occurrence. `key` identifies it within its series (the start instant, or the start date for all-day events). */
export type Occurrence = { key: string; startAt: Date; endAt: Date; startDate?: string; endDate?: string };

/** Minutes before the start a reminder may fire: timed events, and all-day events (9:00 the day before, or 9:00 on the day). */
export const TIMED_REMINDER_MINUTES = [0, 5, 10, 15, 30, 60, 120, 1440] as const;
export const ALL_DAY_REMINDER_MINUTES = [900, -540] as const;
export const MAX_RECURRENCE_COUNT = 500;
const MAX_STEPS = 5_000;
const DAY_MS = 86_400_000;

type Wall = { y: number; m: number; d: number; hh: number; mm: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) { found = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatters.set(timeZone, found); }
  return found;
}

/** The wall-clock date and time of an instant in a time zone. */
export function wallTime(instant: Date, timeZone: string): Wall {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: Number(parts.hour) % 24, mm: Number(parts.minute) };
}

/** The instant at which a wall-clock time happens in a time zone (DST gaps resolve forward, overlaps to the first). */
export function zonedTimeToUtc(wall: Wall, timeZone: string): Date {
  const target = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = wallTime(new Date(guess), timeZone);
    const delta = target - Date.UTC(seen.y, seen.m - 1, seen.d, seen.hh, seen.mm);
    if (!delta) break;
    guess += delta;
  }
  return new Date(guess);
}

const pad = (value: number) => String(value).padStart(2, "0");
const dateOf = (wall: Pick<Wall, "y" | "m" | "d">) => `${wall.y}-${pad(wall.m)}-${pad(wall.d)}`;
const parseDate = (date: string) => { const [y, m, d] = date.split("-").map(Number); return { y: y!, m: m!, d: d! }; };
const dayNumber = (date: string) => { const { y, m, d } = parseDate(date); return Date.UTC(y, m - 1, d) / DAY_MS; };
export const addDays = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);
export const weekdayOf = (date: string) => new Date(dayNumber(date) * DAY_MS).getUTCDay();
export const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && addDays(value, 0) === value;
export const isTimeZone = (value: unknown): value is string => { if (typeof value !== "string" || !value) return false; try { formatter(value); return true; } catch { return false; } };
/** Today's date in a time zone. */
export const localDate = (instant: Date, timeZone: string) => dateOf(wallTime(instant, timeZone));

/** The dates a series falls on, in order, from its first date. Stops at `until` or `count`; `fromDate` lets endless series skip ahead. */
function* seriesDates(firstDate: string, recurrence: Recurrence | null | undefined, fromDate: string): Generator<string> {
  if (!recurrence) { yield firstDate; return; }
  const interval = Math.max(1, Math.floor(recurrence.interval || 1));
  const counted = recurrence.count !== undefined;
  // Only an endless or until-bounded series may skip ahead; a counted one must count from its first date.
  const behind = counted ? 0 : Math.max(0, daysBetween(firstDate, fromDate));
  let steps = 0;
  const done = (date: string) => (recurrence.until !== undefined && date > recurrence.until) || ++steps > MAX_STEPS;
  if (recurrence.freq === "daily") {
    for (let index = Math.max(0, Math.floor(behind / interval) - 1); ; index++) { const date = addDays(firstDate, index * interval); if (done(date)) return; yield date; }
  }
  if (recurrence.freq === "weekly") {
    const days = [...new Set(recurrence.weekdays?.length ? recurrence.weekdays : [weekdayOf(firstDate)])].map((day) => (day + 6) % 7).sort((a, b) => a - b);
    const monday = addDays(firstDate, -((weekdayOf(firstDate) + 6) % 7));
    for (let week = Math.max(0, Math.floor(behind / 7 / interval) - 1); ; week++) {
      for (const offset of days) {
        const date = addDays(monday, week * interval * 7 + offset);
        if (date < firstDate) continue;
        if (done(date)) return;
        yield date;
      }
    }
  }
  const { y, m, d } = parseDate(firstDate);
  for (let index = Math.max(0, Math.floor(behind / 31 / interval) - 1); ; index++) {
    const month = m - 1 + index * interval;
    const when = new Date(Date.UTC(y, month, d));
    // Months without this day (the 31st, or 29 February) are skipped, as calendar apps do.
    if (when.getUTCDate() !== d) { if (++steps > MAX_STEPS) return; continue; }
    const date = when.toISOString().slice(0, 10);
    if (done(date)) return;
    yield date;
  }
}

/** Occurrences overlapping [from, to), at most `limit`. Skipped (exdate) occurrences are left out but still counted. */
export function occurrences(timing: CalendarTiming, from: Date, to: Date, limit = 1_000): Occurrence[] {
  const results: Occurrence[] = [];
  const skipped = new Set(timing.exdates ?? []);
  const counted = timing.recurrence?.count;
  let produced = 0;
  if (timing.allDay) {
    const firstDate = timing.startDate!; const span = Math.max(1, daysBetween(firstDate, timing.endDate!));
    // An all-day date covers that day in every time zone (UTC-12 to UTC+14), so compare with room either side.
    const fromDate = new Date(from.getTime() - 14 * 3_600_000).toISOString().slice(0, 10);
    const lookFrom = addDays(fromDate, -span);
    for (const date of seriesDates(firstDate, timing.recurrence, lookFrom)) {
      if (counted !== undefined && ++produced > counted) break;
      if (date < lookFrom) continue;
      const endDate = addDays(date, span);
      const startAt = new Date(dayNumber(date) * DAY_MS - 14 * 3_600_000); const endAt = new Date(dayNumber(endDate) * DAY_MS + 12 * 3_600_000);
      if (startAt >= to) break;
      if (endAt <= from || skipped.has(date)) continue;
      results.push({ key: date, startAt: new Date(dayNumber(date) * DAY_MS), endAt: new Date(dayNumber(endDate) * DAY_MS), startDate: date, endDate });
      if (results.length >= limit) break;
    }
    return results;
  }
  const start = wallTime(timing.startAt, timing.timezone);
  const duration = Math.max(0, timing.endAt.getTime() - timing.startAt.getTime());
  const lookFrom = localDate(new Date(from.getTime() - duration - DAY_MS), timing.timezone);
  for (const date of seriesDates(dateOf(start), timing.recurrence, lookFrom)) {
    if (counted !== undefined && ++produced > counted) break;
    // A counted series is walked from its first date; dates this early end before `from`, so skip the zone arithmetic.
    if (date < lookFrom) continue;
    const { y, m, d } = parseDate(date);
    const startAt = timing.recurrence ? zonedTimeToUtc({ y, m, d, hh: start.hh, mm: start.mm }, timing.timezone) : timing.startAt;
    if (startAt >= to) break;
    const endAt = new Date(startAt.getTime() + duration);
    const key = startAt.toISOString();
    if (endAt <= from || skipped.has(key)) continue;
    results.push({ key, startAt, endAt });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * No earlier than the last occurrence ends, or null for an endless series (used to find events still worth looking at).
 * All-day events get 14 hours more, so a viewer west of UTC still sees their last evening; `until` series end on that day.
 */
export function seriesEndsAt(timing: CalendarTiming): Date | null {
  const recurrence = timing.recurrence;
  const allDayPad = timing.allDay ? 14 * 3_600_000 : 0;
  if (!recurrence) return new Date(timing.endAt.getTime() + allDayPad);
  if (recurrence.until === undefined && recurrence.count === undefined) return null;
  if (recurrence.until !== undefined) {
    // The last date is on or before `until`: its end is at most that day's end plus the event's length.
    const lastDay = timing.allDay ? new Date((dayNumber(recurrence.until) + 1) * DAY_MS) : zonedTimeToUtc({ ...parseDate(addDays(recurrence.until, 1)), hh: 0, mm: 0 }, timing.timezone);
    return new Date(lastDay.getTime() + Math.max(0, timing.endAt.getTime() - timing.startAt.getTime()) + allDayPad);
  }
  const all = occurrences({ ...timing, exdates: [] }, timing.startAt, new Date(8.64e15), MAX_RECURRENCE_COUNT + 1);
  return new Date((all.length ? all[all.length - 1]!.endAt : timing.endAt).getTime() + allDayPad);
}

/** The instant an occurrence starts for reminders: an all-day occurrence starts at midnight in the event's time zone. */
export function occurrenceStartsAt(timing: Pick<CalendarTiming, "allDay" | "timezone">, occurrence: Occurrence): Date {
  if (!timing.allDay) return occurrence.startAt;
  const { y, m, d } = parseDate(occurrence.startDate!);
  return zonedTimeToUtc({ y, m, d, hh: 0, mm: 0 }, timing.timezone);
}

export type PlannedReminder = { userId: string; occurrenceKey: string; occurrenceStart: Date; minutes: number; remindAt: Date };

/** How late a reminder may still go out: an event made at 9:55 for 10:00 still gets its 10-minute reminder, not its 1-day one. */
export const REMINDER_LATE_MS = 15 * 60_000;

/**
 * Reminders due within `horizonMs` from now, for each person's chosen offsets. Timed occurrences already started are
 * skipped; a reminder whose time passed less than `REMINDER_LATE_MS` ago fires now, an older one not at all.
 */
export function planReminders(timing: CalendarTiming, people: { userId: string; minutes: readonly number[] }[], now: Date, horizonMs: number): PlannedReminder[] {
  const longest = Math.max(0, ...people.flatMap((person) => person.minutes));
  const until = new Date(now.getTime() + horizonMs + longest * 60_000);
  const planned: PlannedReminder[] = [];
  for (const occurrence of occurrences(timing, now, until, 200)) {
    const occurrenceStart = occurrenceStartsAt(timing, occurrence);
    // An all-day date has begun at midnight, but its "9:00 on the day" reminder is still ahead.
    if (!timing.allDay && occurrenceStart <= now) continue;
    for (const person of people) {
      for (const minutes of new Set(person.minutes)) {
        const at = occurrenceStart.getTime() - minutes * 60_000;
        if (at > now.getTime() + horizonMs || at < now.getTime() - REMINDER_LATE_MS) continue;
        planned.push({ userId: person.userId, occurrenceKey: occurrence.key, occurrenceStart, minutes, remindAt: new Date(Math.max(at, now.getTime())) });
      }
    }
  }
  return planned;
}

/** Why a recurrence rule is invalid for an event starting on `firstDate`, or undefined when it is fine. */
export function recurrenceProblem(recurrence: Recurrence, firstDate: string): string | undefined {
  if (!Number.isInteger(recurrence.interval) || recurrence.interval < 1 || recurrence.interval > 30) return "Repeat every 1 to 30 days, weeks, or months";
  if (recurrence.until !== undefined && recurrence.count !== undefined) return "End a repeat on a date or after a number of times, not both";
  if (recurrence.until !== undefined && (!isDate(recurrence.until) || recurrence.until < firstDate)) return "A repeat must end on or after the first day";
  if (recurrence.count !== undefined && (!Number.isInteger(recurrence.count) || recurrence.count < 1 || recurrence.count > MAX_RECURRENCE_COUNT)) return `A repeat can happen at most ${MAX_RECURRENCE_COUNT} times`;
  if (recurrence.weekdays && (recurrence.freq !== "weekly" || recurrence.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) return "Weekdays only apply to weekly repeats (0 = Sunday to 6 = Saturday)";
  return undefined;
}

/** The people an event reminds: its organiser and everyone invited who hasn't declined, each with their chosen offsets. */
export function reminderPeople(event: { organizerId: string; attendees: { userId: string; response: string }[]; reminderPrefs?: { userId: string; minutes: number[] }[]; defaultReminders: number[] }): { userId: string; minutes: number[] }[] {
  const chosen = new Map((event.reminderPrefs ?? []).map((item) => [item.userId, item.minutes]));
  const people = [event.organizerId, ...event.attendees.filter((item) => item.response !== "declined" && item.userId !== event.organizerId).map((item) => item.userId)];
  return [...new Set(people)].map((userId) => ({ userId, minutes: chosen.get(userId) ?? event.defaultReminders }));
}

/**
 * A stable id per occurrence, person, and offset, kept across edits: planning again (after a title fix, say) never sends a
 * reminder that already went out. Moving an occurrence changes its key, so the new time gets reminders of its own.
 */
export function eventReminderId(eventId: string, occurrenceKey: string, userId: string, minutes: number, hash: (text: string) => string): string {
  return `evrem_${hash(`${eventId}|${occurrenceKey}|${userId}|${minutes}`).slice(0, 40)}`;
}

/**
 * The id a reminder of this event should have. A date split off a series keeps the series' ids, so editing the split-off
 * date's title or notes (but not its time) doesn't resend a reminder the series already sent for it.
 */
export function eventReminderIdFor(event: Pick<ReminderEvent, "_id" | "seriesId">, reminder: { occurrenceKey: string; userId: string; minutes: number }, hash: (text: string) => string): string {
  return eventReminderId(event.seriesId ?? event._id, reminder.occurrenceKey, reminder.userId, Number(reminder.minutes), hash);
}

/** "Pitch practice starts in 10 minutes", worded at delivery time so a late reminder still reads right. */
export function eventReminderText(title: string, occurrenceStart: Date, allDay: boolean, _minutes: number, now: Date): string {
  if (allDay) return `${title} is ${occurrenceStart > now ? "tomorrow" : "today"}`;
  const left = Math.round((occurrenceStart.getTime() - now.getTime()) / 60_000);
  // A snoozed reminder can arrive after the start (it is dropped once the occurrence ends).
  if (left < -1) return `${title} started ${-left} minutes ago`;
  if (left <= 1) return `${title} is starting now`;
  if (left < 60) return `${title} starts in ${left} minutes`;
  const hours = Math.round(left / 60);
  return hours < 24 ? `${title} starts in ${hours} hour${hours === 1 ? "" : "s"}` : `${title} starts tomorrow`;
}

/** The fields of a stored calendar event that reminders need. */
export type ReminderEvent = {
  _id: string; workspaceId: string; organizerId: string; title: string; allDay: boolean; timezone: string; version: number; ventureId?: string; seriesId?: string;
  startAt: Date; endAt: Date; startDate?: string; endDate?: string; recurrence?: Recurrence | null; exdates?: string[];
  attendees: { userId: string; response: string }[]; reminderPrefs?: { userId: string; minutes: number[] }[]; defaultReminders: number[];
};

/**
 * The reminder records an event needs within `horizonMs` (one per person, occurrence, and offset), shaped for the
 * `reminders` collection. The API writes them when an event changes; the worker writes them as repeating events move on.
 */
export function eventReminderDocs(event: ReminderEvent, now: Date, horizonMs: number, hash: (text: string) => string, users?: string[]): Record<string, unknown>[] {
  const timing = timingOfEvent(event);
  const people = reminderPeople(event).filter((person) => !users || users.includes(person.userId));
  return planReminders(timing, people, now, horizonMs).slice(0, 500).map((item) => ({
    _id: eventReminderIdFor(event, item, hash), workspaceId: event.workspaceId, userId: item.userId,
    kind: "event", eventId: event._id, eventTitle: event.title, allDay: event.allDay, occurrenceKey: item.occurrenceKey,
    occurrenceStart: item.occurrenceStart, minutes: item.minutes, ...(event.ventureId ? { ventureId: event.ventureId } : {}), message: event.title,
    scheduledAt: item.remindAt, timezone: event.timezone, repeatMinutes: null, state: "scheduled", sequence: 0, createdAt: now, updatedAt: now,
  }));
}

const timingOfEvent = (event: ReminderEvent): CalendarTiming => ({ allDay: event.allDay, startAt: new Date(event.startAt), endAt: new Date(event.endAt), ...(event.startDate ? { startDate: event.startDate, endDate: event.endDate! } : {}), timezone: event.timezone, recurrence: event.recurrence ?? null, exdates: event.exdates ?? [] });

/** The occurrence a key names (its start instant, or its date for all-day events), while the event still has it. */
export function findOccurrence(timing: CalendarTiming, key: string): Occurrence | undefined {
  const at = new Date(isDate(key) ? `${key}T00:00:00Z` : key);
  if (Number.isNaN(at.getTime())) return undefined;
  return occurrences(timing, new Date(at.getTime() - 1), new Date(at.getTime() + 1), 1_000).find((item) => item.key === key);
}

/**
 * Whether a planned reminder still fits its event at delivery: that date is still part of it (not moved or cancelled) and
 * starts when it did, and the person is still coming with that offset chosen. Other edits, like a new title, don't matter.
 */
export function eventReminderStillDue(event: ReminderEvent, reminder: { userId: string; occurrenceKey: string; occurrenceStart: Date | string; minutes: number }): boolean {
  const person = reminderPeople(event).find((item) => item.userId === reminder.userId);
  if (!person?.minutes.includes(Number(reminder.minutes))) return false;
  const timing = timingOfEvent(event);
  const occurrence = findOccurrence(timing, reminder.occurrenceKey);
  return Boolean(occurrence) && occurrenceStartsAt(timing, occurrence!).getTime() === new Date(reminder.occurrenceStart).getTime();
}
