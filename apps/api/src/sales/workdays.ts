// Working-day arithmetic for Sales (see docs/sales-dealflow.md section 5). What counts as a working day, which days are blacked
// out (no follow-ups are scheduled on them), and the time zone all belong to the venture's settings (a "work calendar");
// without one the defaults apply: Monday to Saturday in Asia/Kolkata minus the festival blackout.
import { DEFAULT_BLACKOUT_DATES } from "@venture-studio/contracts";

export const SALES_TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** Follow-ups and "next working day" actions land at this hour (local) so they are due at the start of the working day. */
export const FOLLOW_UP_HOUR = 10;
/** The hours a "working hour" is counted in (local). */
export const WORK_START_HOUR = 10;
export const WORK_END_HOUR = 19;

/** A venture's working week, blackout days and time zone. */
export type WorkCalendar = { workingDays: ReadonlySet<number>; blackout: ReadonlySet<string>; timeZone: string };

/** ISO weekdays (1 = Monday ... 7 = Sunday). */
export function workCalendar(settings: { workingDays: readonly number[]; blackoutDates: readonly string[]; timezone: string }): WorkCalendar {
  return { workingDays: new Set(settings.workingDays), blackout: new Set(settings.blackoutDates), timeZone: settings.timezone };
}

/** Festival blackout (calendar days): 2026-10-20 and 2026-11-06 to 2026-11-11 (the default for ventures without their own list). */
export const BLACKOUT_DAYS: ReadonlySet<string> = new Set(DEFAULT_BLACKOUT_DATES);

export const DEFAULT_CALENDAR: WorkCalendar = { workingDays: new Set([1, 2, 3, 4, 5, 6]), blackout: BLACKOUT_DAYS, timeZone: SALES_TZ };

function offsetMs(instant: Date, timeZone: string): number {
  if (timeZone === SALES_TZ) return IST_OFFSET_MS;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second")) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The calendar day ("YYYY-MM-DD") of an instant in the calendar's time zone. */
export function localDay(instant: Date, cal: WorkCalendar = DEFAULT_CALENDAR): string {
  return new Date(instant.getTime() + offsetMs(instant, cal.timeZone)).toISOString().slice(0, 10);
}
/** The IST calendar day of an instant. */
export function istDay(instant: Date): string {
  return localDay(instant, DEFAULT_CALENDAR);
}

/** Calendar arithmetic on "YYYY-MM-DD" strings. */
export function shiftDate(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

export function isWorkingDay(day: string, cal: WorkCalendar = DEFAULT_CALENDAR): boolean {
  const iso = weekday(day) || 7;
  return cal.workingDays.has(iso) && !cal.blackout.has(day);
}

/** The instant `hour:minute` starts on a calendar day in the calendar's time zone. */
export function localMoment(day: string, hour = FOLLOW_UP_HOUR, minute = 0, cal: WorkCalendar = DEFAULT_CALENDAR): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  const first = wall - offsetMs(new Date(wall), cal.timeZone);
  return new Date(wall - offsetMs(new Date(first), cal.timeZone));
}
/** The instant `hour:minute` IST starts on an IST calendar day. */
export function istMoment(day: string, hour = FOLLOW_UP_HOUR, minute = 0): Date {
  return localMoment(day, hour, minute, DEFAULT_CALENDAR);
}

/** The first working day strictly after `day` (a calendar that rules out every day falls back to the next calendar day). */
export function nextWorkingDate(day: string, cal: WorkCalendar = DEFAULT_CALENDAR): string {
  let next = shiftDate(day, 1);
  for (let guard = 0; guard < 800 && !isWorkingDay(next, cal); guard++) next = shiftDate(next, 1);
  return next;
}

/** `day` itself when it is a working day, otherwise the next one. */
export function workingDateOnOrAfter(day: string, cal: WorkCalendar = DEFAULT_CALENDAR): string {
  return isWorkingDay(day, cal) ? day : nextWorkingDate(day, cal);
}

/** The moment `days` working days after the day of `from`, at `hour` local. */
export function addWorkingDays(from: Date, days: number, hour = FOLLOW_UP_HOUR, cal: WorkCalendar = DEFAULT_CALENDAR): Date {
  let day = localDay(from, cal);
  for (let step = 0; step < days; step++) day = nextWorkingDate(day, cal);
  return localMoment(day, hour, 0, cal);
}

/** The start (`hour` local) of the next working day after `from`. */
export function nextWorkingDay(from: Date, hour = FOLLOW_UP_HOUR, cal: WorkCalendar = DEFAULT_CALENDAR): Date {
  return localMoment(nextWorkingDate(localDay(from, cal), cal), hour, 0, cal);
}

/** `from` plus calendar days, moved forward to a working day, at `hour` local. */
export function workingMomentAfterDays(from: Date, days: number, hour = FOLLOW_UP_HOUR, cal: WorkCalendar = DEFAULT_CALENDAR): Date {
  return localMoment(workingDateOnOrAfter(localDay(new Date(from.getTime() + days * DAY_MS), cal), cal), hour, 0, cal);
}

/** Working days passed between two instants: the working days in (a's day, b's day]. */
export function workingDaysBetween(a: Date, b: Date, cal: WorkCalendar = DEFAULT_CALENDAR): number {
  let day = localDay(a, cal);
  const end = localDay(b, cal);
  let count = 0;
  while (day < end) {
    day = shiftDate(day, 1);
    if (isWorkingDay(day, cal)) count++;
  }
  return count;
}

/** `hours` working hours (working days, 10:00-19:00 local, outside blackout days) after `from`. */
export function addWorkingHours(from: Date, hours: number, cal: WorkCalendar = DEFAULT_CALENDAR): Date {
  let remaining = hours * 60;
  let cursor = from;
  for (let guard = 0; guard < 400; guard++) {
    const day = localDay(cursor, cal);
    if (!isWorkingDay(day, cal)) { cursor = localMoment(nextWorkingDate(day, cal), WORK_START_HOUR, 0, cal); continue; }
    const start = localMoment(day, WORK_START_HOUR, 0, cal);
    const end = localMoment(day, WORK_END_HOUR, 0, cal);
    if (cursor < start) cursor = start;
    if (cursor >= end) { cursor = localMoment(nextWorkingDate(day, cal), WORK_START_HOUR, 0, cal); continue; }
    const available = (end.getTime() - cursor.getTime()) / 60_000;
    if (remaining <= available) return new Date(cursor.getTime() + remaining * 60_000);
    remaining -= available;
    cursor = localMoment(nextWorkingDate(day, cal), WORK_START_HOUR, 0, cal);
  }
  return cursor;
}

/** The instant the local calendar day containing `instant` ends (the next local midnight) in an IANA zone. */
export function endOfLocalDay(instant: Date, timeZone: string): Date {
  const local = new Date(instant.getTime() + offsetMs(instant, timeZone));
  const nextMidnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  const guess = new Date(nextMidnightAsUtc - offsetMs(new Date(nextMidnightAsUtc), timeZone));
  return new Date(nextMidnightAsUtc - offsetMs(guess, timeZone));
}

/** The instant the local calendar day containing `instant` began. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const day = new Date(instant.getTime() + offsetMs(instant, timeZone)).toISOString().slice(0, 10);
  return localMoment(day, 0, 0, { workingDays: DEFAULT_CALENDAR.workingDays, blackout: DEFAULT_CALENDAR.blackout, timeZone });
}
