"use client";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_BLACKOUT_DATES, type Activity } from "@venture-studio/contracts";
import { Badge } from "@/components/studio/primitives";
import type { SalesSettingsView } from "@/lib/sales-api";
import { useVentureSettings } from "./draft-shared";

// The reply rule (docs/sales-dealflow.md section 5): answer WARM replies within the venture's reply time (replySlaHours, 2 by default),
// counted in WORKING hours: the venture's working days, 10:00 to 19:00 in its time zone, minus its blackout days. The same clock the API
// uses for the reports. Other replies (not now, wrong person, unsorted…) run no clock.

/** Replies that want an answer from us now. They come first in the Inbox, and only they are clocked. */
export const WARM_TYPES: readonly string[] = ["interested", "send_details", "price_first"];
export const isWarm = (replyType?: string) => replyType !== undefined && WARM_TYPES.includes(replyType);

const DAY_MS = 86_400_000;
const WORK_START = 10;
const WORK_END = 19;

/** A venture's reply clock: its reply time in working hours, working days (ISO, 1 = Monday), blackout days and time zone. */
export type SlaCalendar = { hours: number; workingDays: ReadonlySet<number>; blackout: ReadonlySet<string>; timeZone: string };
/** The defaults, used until (or when) a venture's settings cannot be read: 2 hours, Monday to Saturday, Asia/Kolkata. */
export const DEFAULT_SLA: SlaCalendar = { hours: 2, workingDays: new Set([1, 2, 3, 4, 5, 6]), blackout: new Set(DEFAULT_BLACKOUT_DATES), timeZone: "Asia/Kolkata" };

export function slaCalendar(settings?: SalesSettingsView): SlaCalendar {
  if (!settings) return DEFAULT_SLA;
  const timeZone = validZone(settings.timezone) ? settings.timezone : DEFAULT_SLA.timeZone;
  return { hours: settings.replySlaHours, workingDays: new Set(settings.workingDays), blackout: new Set(settings.blackoutDates), timeZone };
}
function validZone(timeZone: string) { try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; } }

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
/** How far the zone's wall clock is ahead of UTC at that instant, in ms. */
function offsetMs(ms: number, timeZone: string): number {
  if (timeZone === "Asia/Kolkata") return 330 * 60_000;
  let format = offsetFormats.get(timeZone);
  if (!format) { format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); offsetFormats.set(timeZone, format); }
  const parts = format.formatToParts(new Date(ms));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second")) - Math.floor(ms / 1000) * 1000;
}
/** The calendar day ("YYYY-MM-DD") of an instant in the calendar's zone. */
const localDay = (ms: number, cal: SlaCalendar) => new Date(ms + offsetMs(ms, cal.timeZone)).toISOString().slice(0, 10);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const isWorkingDay = (day: string, cal: SlaCalendar) => cal.workingDays.has(new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay() || 7) && !cal.blackout.has(day);
/** The instant `hour`:00 starts on a calendar day in the calendar's zone. */
function localMoment(day: string, hour: number, cal: SlaCalendar): number {
  const wall = Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000;
  const first = wall - offsetMs(wall, cal.timeZone);
  return wall - offsetMs(first, cal.timeZone);
}

/** Working hours between two instants (a fraction of an hour is kept). */
export function workingHoursBetween(fromMs: number, toMs: number, cal: SlaCalendar = DEFAULT_SLA): number {
  if (toMs <= fromMs) return 0;
  // A reply left for more than two months is long past any deadline; do not walk every day.
  if (toMs - fromMs > 62 * DAY_MS) return 62 * (WORK_END - WORK_START);
  let total = 0;
  const last = localDay(toMs, cal);
  for (let day = localDay(fromMs, cal); day <= last; day = nextDay(day)) {
    if (!isWorkingDay(day, cal)) continue;
    total += Math.max(0, Math.min(localMoment(day, WORK_END, cal), toMs) - Math.max(localMoment(day, WORK_START, cal), fromMs));
  }
  return total / 3_600_000;
}

/** The start of the next stretch of working time at or after `ms` (looks two weeks ahead, past a long blackout). */
function nextWorkStart(ms: number, cal: SlaCalendar): number {
  let day = localDay(ms, cal);
  for (let step = 0; step < 21; step += 1, day = nextDay(day)) {
    if (!isWorkingDay(day, cal)) continue;
    if (ms < localMoment(day, WORK_START, cal)) return localMoment(day, WORK_START, cal);
    if (ms < localMoment(day, WORK_END, cal)) return ms;
  }
  return ms;
}

const clockFormats = new Map<string, { time: Intl.DateTimeFormat; day: Intl.DateTimeFormat }>();
function clockIn(timeZone: string) {
  let format = clockFormats.get(timeZone);
  if (!format) { format = { time: new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit" }), day: new Intl.DateTimeFormat("en-IN", { timeZone, weekday: "short" }) }; clockFormats.set(timeZone, format); }
  return format;
}
const span = (hours: number) => { const minutes = Math.max(0, Math.round(hours * 60)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`; };

export type Sla = { hours: number; tone: "neutral" | "amber" | "red"; label: string; over: boolean };

/** How long a waiting warm reply has waited, in the venture's working time. `null` for handled items and for replies that are not warm. */
export function slaOf(activity: Pick<Activity, "at" | "handledAt" | "replyType">, now: number, cal: SlaCalendar = DEFAULT_SLA): Sla | null {
  if (activity.handledAt || !isWarm(activity.replyType)) return null;
  const hours = workingHoursBetween(new Date(activity.at).getTime(), now, cal);
  if (hours > cal.hours) return { hours, tone: "red", label: `Over ${cal.hours}h`, over: true };
  if (hours >= cal.hours / 2) return { hours, tone: "amber", label: `Waiting ${span(hours)}`, over: false };
  // Not started yet: it arrived outside working time and the clock opens later.
  const opens = nextWorkStart(now, cal);
  if (hours === 0 && opens > now) {
    const clock = clockIn(cal.timeZone);
    return { hours, tone: "neutral", label: `Clock starts ${localDay(opens, cal) === localDay(now, cal) ? "" : `${clock.day.format(opens)} `}${clock.time.format(opens).replace(":00", "")}`, over: false };
  }
  return { hours, tone: "neutral", label: `Waiting ${span(hours)}`, over: false };
}

/** The reply clock of each venture, from its sales settings (cached five minutes); the defaults until they are read or when they cannot be. */
export function useSlaCalendars(ventureIds: readonly string[]): (ventureId: string) => SlaCalendar {
  const settings = useVentureSettings(ventureIds);
  return useCallback((ventureId: string) => slaCalendar(settings[ventureId]), [settings]);
}

/** Re-renders the caller every minute so waiting times keep moving. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

/** "Waiting 25m" (grey), "Waiting 1h 20m" (amber) or "Over 2h" (red), for warm replies only. Nothing for the rest. */
export function SlaChip({ activity, now, calendar = DEFAULT_SLA }: { activity: Pick<Activity, "at" | "handledAt" | "replyType">; now: number; calendar?: SlaCalendar }) {
  const sla = slaOf(activity, now, calendar);
  if (!sla) return null;
  return <Badge tone={sla.tone === "red" ? "red" : sla.tone === "amber" ? "amber" : "neutral"}>{sla.label}</Badge>;
}
