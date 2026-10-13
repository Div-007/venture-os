"use client";

import clsx from "clsx";
import type { CalendarLayerItem, CalendarOccurrence } from "@venture-studio/contracts";
import { MapPin, Repeat, Video } from "@/components/ui/icons";
import { addDays, colorClass, dayKey, fromDayKey, isSameDay, LAYER_ICON, LAYER_LABEL, occurrenceDays, responseClass, startOfDay, timeText } from "./calendar-utils";

type Entry = { at: string; event?: CalendarOccurrence; item?: CalendarLayerItem };
const RESPONSE_LABEL: Record<string, string> = { going: "Going", maybe: "Maybe", declined: "Not going", pending: "Invited" };

/** The next 30 days as a list grouped by day: the default on phones. Days with nothing are left out. */
export function AgendaView({ from, events, items, ventureName, onOpen, onOpenItem }: {
  from: Date; events: CalendarOccurrence[]; items: CalendarLayerItem[]; ventureName: (id?: string) => string | undefined;
  onOpen: (item: CalendarOccurrence) => void; onOpenItem: (item: CalendarLayerItem) => void;
}) {
  const today = startOfDay(new Date());
  const days = Array.from({ length: 30 }, (_, index) => dayKey(addDays(from, index)));
  const rows = days.map((key) => {
    const dayEvents = events.filter((item) => occurrenceDays(item).includes(key)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt.localeCompare(b.startAt));
    const dayItems = items.filter((item) => dayKey(new Date(item.at)) === key);
    const entries: Entry[] = [...dayEvents.map((event) => ({ at: event.allDay ? "" : event.startAt, event })), ...dayItems.map((item) => ({ at: item.at, item }))].sort((a, b) => a.at.localeCompare(b.at));
    return { key, entries };
  }).filter((row) => row.entries.length);
  if (!rows.length) return null;
  const label = (key: string) => { const day = fromDayKey(key); return isSameDay(day, today) ? "Today" : isSameDay(day, addDays(today, 1)) ? "Tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(day); };

  return <div className="divide-y divide-neutral-100">
    {rows.map((row) => <section key={row.key} aria-label={label(row.key)} className="grid gap-2 px-4 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:px-5">
      <h3 className={clsx("text-sm font-bold", label(row.key) === "Today" ? "text-primary-700" : "text-neutral-800")}>{label(row.key)}</h3>
      <ul className="space-y-1.5">
        {row.entries.map((entry, index) => entry.event
          ? <li key={`${entry.event.eventId}-${entry.event.occurrenceKey}`}><button type="button" onClick={() => onOpen(entry.event!)} className={clsx("vso-cal-block flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-[filter,transform] duration-150 hover:brightness-[.97] active:scale-[0.99]", colorClass(entry.event.color), responseClass(entry.event.myResponse))}>
            <span className="w-20 shrink-0 text-xs font-semibold opacity-80 tnum">{entry.event.allDay ? "All day" : timeText(new Date(entry.event.startAt))}</span>
            <span className="min-w-0 flex-1">
              <span className="vso-cal-title flex items-center gap-1.5 truncate text-sm font-semibold">{entry.event.recurring && <Repeat size={12} className="shrink-0 opacity-70" />}{entry.event.title}</span>
              <span className="flex flex-wrap items-center gap-x-2 text-xs opacity-75">{!entry.event.allDay && <span className="tnum">until {timeText(new Date(entry.event.endAt))}</span>}{ventureName(entry.event.ventureId) && <span>{ventureName(entry.event.ventureId)}</span>}{entry.event.location && <span className="inline-flex items-center gap-0.5"><MapPin size={11} />{entry.event.location}</span>}{entry.event.hasMeeting && <span className="inline-flex items-center gap-0.5"><Video size={11} />Call</span>}</span>
            </span>
            {RESPONSE_LABEL[entry.event.myResponse] && <span className="shrink-0 rounded-full bg-white/60 px-2 py-0.5 text-[11px] font-semibold">{RESPONSE_LABEL[entry.event.myResponse]}</span>}
          </button></li>
          : <li key={`item-${index}`}><AgendaItem item={entry.item!} ventureName={ventureName} onOpen={onOpenItem} /></li>)}
      </ul>
    </section>)}
  </div>;
}

function AgendaItem({ item, ventureName, onOpen }: { item: CalendarLayerItem; ventureName: (id?: string) => string | undefined; onOpen: (item: CalendarLayerItem) => void }) {
  const Icon = LAYER_ICON[item.kind];
  return <button type="button" onClick={() => onOpen(item)} className="vso-cal-layer flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150 hover:bg-neutral-100">
    <span className="w-20 shrink-0 text-xs font-semibold tnum">{timeText(new Date(item.at))}</span>
    <Icon size={14} className="shrink-0" />
    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-neutral-700">{LAYER_LABEL[item.kind]}: {item.title}</span>{(item.detail || ventureName(item.ventureId)) && <span className="block truncate text-xs text-neutral-500">{[ventureName(item.ventureId), item.detail].filter(Boolean).join(" · ")}</span>}</span>
  </button>;
}

/** A small month for jumping to a date; dots mark days with events. */
export function MiniMonth({ anchor, selected, marked, onPick, onMonth }: { anchor: Date; selected: Date; marked: Set<string>; onPick: (day: Date) => void; onMonth: (direction: 1 | -1) => void }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  const today = new Date();
  return <div className="select-none">
    <div className="mb-2 flex items-center justify-between">
      <p className="text-sm font-bold text-neutral-800">{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(anchor)}</p>
      <div className="flex gap-0.5"><button type="button" aria-label="Previous month" onClick={() => onMonth(-1)} className="grid h-7 w-7 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100">‹</button><button type="button" aria-label="Next month" onClick={() => onMonth(1)} className="grid h-7 w-7 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100">›</button></div>
    </div>
    <div className="grid grid-cols-7 gap-y-0.5 text-center">
      {["M", "T", "W", "T", "F", "S", "S"].map((letter, index) => <span key={index} className="py-1 text-[10px] font-semibold text-neutral-400">{letter}</span>)}
      {days.map((day) => {
        const key = dayKey(day); const inMonth = day.getMonth() === anchor.getMonth();
        return <button key={key} type="button" onClick={() => onPick(day)} aria-label={new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(day)} aria-current={isSameDay(day, selected) ? "date" : undefined}
          className={clsx("relative mx-auto grid h-7 w-7 place-items-center rounded-full text-xs font-semibold tnum transition-colors duration-150", isSameDay(day, today) ? "vso-cal-today" : isSameDay(day, selected) ? "bg-primary-100 text-primary-800" : inMonth ? "text-neutral-700 hover:bg-neutral-100" : "text-neutral-300 hover:bg-neutral-100")}>
          {day.getDate()}{marked.has(key) && !isSameDay(day, today) && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-primary-500" />}
        </button>;
      })}
    </div>
  </div>;
}
