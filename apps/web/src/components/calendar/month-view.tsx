"use client";

import clsx from "clsx";
import type { CalendarLayerItem, CalendarOccurrence } from "@venture-studio/contracts";
import { colorClass, dayKey, isSameDay, LAYER_ICON, occurrenceDays, responseClass, timeText, viewRange, WEEKDAY_SHORT } from "./calendar-utils";

const SHOWN = 3;

/** Six weeks at a glance. Each day lists all-day items first, then by time; "+N more" opens that day. */
export function MonthView({ anchor, events, items, onOpen, onOpenItem, onCreate, onShowDay }: {
  anchor: Date; events: CalendarOccurrence[]; items: CalendarLayerItem[];
  onOpen: (item: CalendarOccurrence) => void; onOpenItem: (item: CalendarLayerItem) => void; onCreate: (day: string) => void; onShowDay: (day: string) => void;
}) {
  const { days } = viewRange("month", anchor);
  const today = new Date();
  const byDay = new Map<string, CalendarOccurrence[]>();
  for (const item of events) for (const key of occurrenceDays(item)) byDay.set(key, [...(byDay.get(key) ?? []), item]);
  const itemsByDay = new Map<string, CalendarLayerItem[]>();
  for (const item of items) { const key = dayKey(new Date(item.at)); itemsByDay.set(key, [...(itemsByDay.get(key) ?? []), item]); }

  return <div role="grid" aria-label={new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(anchor)} className="flex h-full min-h-[560px] flex-col">
    <div role="row" className="grid grid-cols-7 border-b border-neutral-100">
      {[1, 2, 3, 4, 5, 6, 0].map((day) => <div key={day} role="columnheader" className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400">{WEEKDAY_SHORT[day]}</div>)}
    </div>
    <div className="grid flex-1 grid-cols-7 grid-rows-6">
      {days.map((day) => {
        const key = dayKey(day);
        const dayEvents = (byDay.get(key) ?? []).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt.localeCompare(b.startAt));
        const dayItems = itemsByDay.get(key) ?? [];
        const entries: { event?: CalendarOccurrence; item?: CalendarLayerItem }[] = [...dayEvents.map((event) => ({ event })), ...dayItems.map((item) => ({ item }))];
        const outside = day.getMonth() !== anchor.getMonth();
        const isToday = isSameDay(day, today);
        return <div key={key} role="gridcell" aria-label={new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(day)}
          className={clsx("group relative min-w-0 border-b border-r border-neutral-100 p-1 transition-colors duration-150 [&:nth-child(7n)]:border-r-0", outside ? "bg-neutral-50/60" : "hover:bg-neutral-50/70")}
          onClick={(event) => { if (event.target === event.currentTarget) onCreate(key); }}>
          <div className="flex items-center justify-between px-1">
            <button type="button" onClick={() => onShowDay(key)} aria-label={`Open ${key}`} className={clsx("grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-semibold tnum transition-colors duration-150", isToday ? "vso-cal-today" : outside ? "text-neutral-400 hover:bg-neutral-100" : "text-neutral-700 hover:bg-neutral-100")}>{day.getDate()}</button>
            <button type="button" aria-label={`New event on ${key}`} onClick={() => onCreate(key)} className="grid h-6 w-6 place-items-center rounded-md text-sm font-bold text-neutral-400 opacity-0 transition-opacity duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100 max-md:hidden">+</button>
          </div>
          {/* Phones: coloured dots; wider screens: titled chips. */}
          <div className="mt-1 flex flex-wrap gap-0.5 px-1 md:hidden">{entries.slice(0, 5).map((entry, index) => <span key={index} className={clsx("h-1.5 w-1.5 rounded-full", entry.event ? clsx(colorClass(entry.event.color), "vso-cal-dot") : "bg-neutral-400")} />)}</div>
          <div className="mt-0.5 space-y-0.5 max-md:hidden">
            {entries.slice(0, SHOWN).map((entry, index) => entry.event
              ? <button key={`${entry.event.eventId}-${entry.event.occurrenceKey}`} type="button" onClick={() => onOpen(entry.event!)} title={entry.event.title}
                className={clsx("vso-cal-block flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold leading-4 transition-[filter,transform] duration-150 hover:brightness-[.97] active:scale-[0.98]", colorClass(entry.event.color), responseClass(entry.event.myResponse))}>
                {!entry.event.allDay && <span className="shrink-0 font-medium opacity-75 tnum">{timeText(new Date(entry.event.startAt))}</span>}<span className="vso-cal-title truncate">{entry.event.title}</span>
              </button>
              : <LayerChip key={`item-${index}`} item={entry.item!} onOpen={onOpenItem} />)}
            {entries.length > SHOWN && <button type="button" onClick={() => onShowDay(key)} className="w-full rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold text-neutral-500 hover:bg-neutral-100">+{entries.length - SHOWN} more</button>}
          </div>
        </div>;
      })}
    </div>
  </div>;
}

export function LayerChip({ item, onOpen, showTime = true }: { item: CalendarLayerItem; onOpen: (item: CalendarLayerItem) => void; showTime?: boolean }) {
  const Icon = LAYER_ICON[item.kind];
  return <button type="button" onClick={() => onOpen(item)} title={item.title}
    className="vso-cal-layer flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold leading-4 transition-colors duration-150 hover:bg-neutral-100">
    <Icon size={11} className="shrink-0 opacity-70" />{showTime && <span className="shrink-0 font-medium opacity-75 tnum">{timeText(new Date(item.at))}</span>}<span className="truncate">{item.title}</span>
  </button>;
}
