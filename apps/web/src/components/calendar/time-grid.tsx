"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { CalendarLayerItem, CalendarOccurrence } from "@venture-studio/contracts";
import { Repeat, Video } from "@/components/ui/icons";
import { colorClass, dayKey, fromDayKey, HOUR_PX, isSameDay, LAYER_ICON, layoutPieces, minutesIntoDay, occurrenceDays, responseClass, SNAP_MINUTES, timedPieces, timeText } from "./calendar-utils";

const MINUTE_PX = HOUR_PX / 60;
const snap = (minutes: number) => Math.max(0, Math.min(24 * 60, Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES));
type Gesture =
  | { kind: "create"; dayIndex: number; anchor: number; current: number; pointerId: number; moved: boolean }
  | { kind: "move"; item: CalendarOccurrence; grab: number; dayIndex: number; startMinute: number; length: number; pointerId: number; moved: boolean; originX: number; originY: number }
  | { kind: "resize"; item: CalendarOccurrence; dayIndex: number; startMinute: number; endMinute: number; pointerId: number; moved: boolean };

/**
 * Week and day view. Drag on empty space to draw a new event; drag an event to move it (also to another day); drag its
 * bottom edge to change its length. Clicks open events. Times snap to 15 minutes.
 */
export function TimeGrid({ days, events, items, onOpen, onOpenItem, onCreateRange, onReschedule, canDrag }: {
  days: Date[]; events: CalendarOccurrence[]; items: CalendarLayerItem[];
  onOpen: (item: CalendarOccurrence) => void; onOpenItem: (item: CalendarLayerItem) => void;
  onCreateRange: (start: Date, end: Date) => void; onReschedule: (item: CalendarOccurrence, start: Date, end: Date) => void;
  canDrag: (item: CalendarOccurrence) => boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef<(HTMLDivElement | null)[]>([]);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Gesture | null>(null);
  const [now, setNow] = useState(() => new Date());
  const keys = days.map(dayKey);

  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(timer); }, []);
  // Open on the working day: an hour before now when today is shown, otherwise 7:30.
  useLayoutEffect(() => {
    const showingToday = days.some((day) => isSameDay(day, new Date()));
    const minute = showingToday ? Math.max(0, minutesIntoDay(new Date()) - 60) : 7.5 * 60;
    if (scroller.current) scroller.current.scrollTop = minute * MINUTE_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join("|")]);

  const minuteAt = (dayIndex: number, clientY: number) => { const rect = columns.current[dayIndex]?.getBoundingClientRect(); return rect ? (clientY - rect.top) / MINUTE_PX : 0; };
  const dayAt = (clientX: number, fallback: number) => { const index = columns.current.findIndex((column) => { const rect = column?.getBoundingClientRect(); return rect && clientX >= rect.left && clientX < rect.right; }); return index >= 0 ? index : fallback; };

  function startCreate(event: React.PointerEvent<HTMLDivElement>, dayIndex: number) {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    const minute = Math.min(snap(minuteAt(dayIndex, event.clientY) - SNAP_MINUTES / 2), 24 * 60 - SNAP_MINUTES);
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind: "create", dayIndex, anchor: minute, current: minute + 60, pointerId: event.pointerId, moved: false };
    setPreview(gesture.current);
  }
  function startMove(event: React.PointerEvent<HTMLElement>, item: CalendarOccurrence, dayIndex: number, startMinute: number, endMinute: number, resize: boolean) {
    if (event.button !== 0 || !canDrag(item)) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    gesture.current = resize
      ? { kind: "resize", item, dayIndex, startMinute, endMinute, pointerId: event.pointerId, moved: false }
      : { kind: "move", item, grab: minuteAt(dayIndex, event.clientY) - startMinute, dayIndex, startMinute, length: endMinute - startMinute, pointerId: event.pointerId, moved: false, originX: event.clientX, originY: event.clientY };
  }
  function onPointerMove(event: React.PointerEvent) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.kind === "create") {
      const current = snap(minuteAt(active.dayIndex, event.clientY));
      gesture.current = { ...active, current: current === active.anchor ? active.anchor + SNAP_MINUTES : current, moved: true };
    } else if (active.kind === "move") {
      // A few pixels of wobble is still a click.
      if (!active.moved && Math.hypot(event.clientX - active.originX, event.clientY - active.originY) < 5) return;
      const dayIndex = dayAt(event.clientX, active.dayIndex);
      const startMinute = Math.min(Math.max(0, snap(minuteAt(dayIndex, event.clientY) - active.grab)), 24 * 60 - SNAP_MINUTES);
      gesture.current = { ...active, dayIndex, startMinute, moved: true };
    } else {
      const endMinute = Math.max(active.startMinute + SNAP_MINUTES, snap(minuteAt(active.dayIndex, event.clientY)));
      gesture.current = { ...active, endMinute, moved: true };
    }
    setPreview(gesture.current);
  }
  function onPointerUp(event: React.PointerEvent) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null; setPreview(null);
    const at = (dayIndex: number, minute: number) => { const date = fromDayKey(keys[dayIndex]!); date.setMinutes(minute); return date; };
    if (active.kind === "create") {
      const from = Math.min(active.anchor, active.current); const to = Math.max(active.anchor, active.current);
      onCreateRange(at(active.dayIndex, from), at(active.dayIndex, active.moved ? to : from + 60));
    } else if (active.kind === "move") {
      if (!active.moved) return onOpen(active.item);
      const start = at(active.dayIndex, active.startMinute);
      onReschedule(active.item, start, new Date(start.getTime() + (new Date(active.item.endAt).getTime() - new Date(active.item.startAt).getTime())));
    } else if (active.moved) {
      onReschedule(active.item, new Date(active.item.startAt), at(active.dayIndex, active.endMinute));
    }
  }
  const cancel = () => { gesture.current = null; setPreview(null); };

  const allDay = keys.map((key) => events.filter((item) => item.allDay && occurrenceDays(item).includes(key)));
  const showAllDay = allDay.some((list) => list.length);
  const grid = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;
  const nowTop = minutesIntoDay(now) * MINUTE_PX;

  return <div className="flex h-full min-h-0 flex-col" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancel}>
    <div className="grid border-b border-neutral-100" style={{ gridTemplateColumns: grid }}>
      <div />
      {days.map((day) => {
        const today = isSameDay(day, now);
        return <div key={dayKey(day)} className="flex flex-col items-center gap-0.5 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400">{new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day)}</span>
          <span className={clsx("grid h-8 min-w-8 place-items-center rounded-full px-1.5 text-base font-bold tnum", today ? "vso-cal-today" : "text-neutral-800")}>{day.getDate()}</span>
        </div>;
      })}
    </div>
    {showAllDay && <div className="grid border-b border-neutral-100" style={{ gridTemplateColumns: grid }}>
      <div className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[.06em] text-neutral-400">All day</div>
      {allDay.map((list, index) => <div key={keys[index]} className="min-w-0 space-y-0.5 border-l border-neutral-100 p-1">
        {list.slice(0, 3).map((item) => <button key={`${item.eventId}-${item.occurrenceKey}`} type="button" onClick={() => onOpen(item)} className={clsx("vso-cal-block flex w-full min-w-0 items-center rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold leading-4 active:scale-[0.98]", colorClass(item.color), responseClass(item.myResponse))}><span className="vso-cal-title truncate">{item.title}</span></button>)}
        {list.length > 3 && <p className="px-1.5 text-[10px] font-semibold text-neutral-500">+{list.length - 3} more</p>}
      </div>)}
    </div>}
    <div ref={scroller} className="thin-scroll relative min-h-0 flex-1 overflow-y-auto" style={{ ["--cal-hour" as string]: `${HOUR_PX}px` }}>
      <div className="grid" style={{ gridTemplateColumns: grid, height: 24 * HOUR_PX }}>
        <div className="relative">{Array.from({ length: 23 }, (_, index) => <span key={index} className="absolute right-2 -translate-y-1/2 text-[10px] font-medium text-neutral-400 tnum" style={{ top: (index + 1) * HOUR_PX }}>{timeText(new Date(2000, 0, 1, index + 1))}</span>)}</div>
        {keys.map((key, dayIndex) => {
          const laid = layoutPieces(timedPieces(events, key));
          const dayItems = items.filter((item) => dayKey(new Date(item.at)) === key);
          const today = isSameDay(fromDayKey(key), now);
          return <div key={key} ref={(node) => { columns.current[dayIndex] = node; }} onPointerDown={(event) => startCreate(event, dayIndex)}
            aria-label={`${new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(fromDayKey(key))}: drag to add an event`}
            className={clsx("vso-cal-hours relative touch-pan-y border-l border-neutral-100", today && "bg-primary-50/30")}>
            {laid.map((piece) => {
              const dragged = preview && preview.kind !== "create" && preview.item.eventId === piece.item.eventId && preview.item.occurrenceKey === piece.item.occurrenceKey && preview.moved;
              const draggable = canDrag(piece.item) && !piece.before && !piece.after;
              const height = (piece.endMinute - piece.startMinute) * MINUTE_PX;
              return <div key={`${piece.item.eventId}-${piece.item.occurrenceKey}`} role="button" tabIndex={0} aria-label={`${piece.item.title}, ${timeText(new Date(piece.item.startAt))}`}
                onPointerDown={(event) => draggable ? startMove(event, piece.item, dayIndex, piece.startMinute, piece.endMinute, false) : undefined}
                onClick={() => { if (!draggable) onOpen(piece.item); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(piece.item); } }}
                className={clsx("vso-cal-block absolute overflow-hidden px-1.5 py-1 text-[11px] leading-4 transition-[opacity,filter] duration-150 hover:brightness-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", colorClass(piece.item.color), responseClass(piece.item.myResponse), piece.before ? "rounded-t-none" : "rounded-t-lg", piece.after ? "rounded-b-none" : "rounded-b-lg", draggable ? "cursor-grab" : "cursor-pointer", dragged && "opacity-40")}
                style={{ top: piece.startMinute * MINUTE_PX + 1, height: Math.max(height - 2, 18), left: `calc(${(piece.column / piece.columns) * 100}% + 2px)`, width: `calc(${100 / piece.columns}% - 4px)` }}>
                <p className="vso-cal-title flex items-center gap-1 truncate font-semibold">{piece.item.recurring && <Repeat size={10} className="shrink-0 opacity-70" />}{piece.item.hasMeeting && <Video size={10} className="shrink-0 opacity-70" />}<span className="truncate">{piece.item.title}</span></p>
                {height >= 34 && <p className="truncate opacity-75 tnum">{timeText(new Date(piece.item.startAt))} – {timeText(new Date(piece.item.endAt))}{piece.item.location ? ` · ${piece.item.location}` : ""}</p>}
                {draggable && <span aria-hidden="true" onPointerDown={(event) => startMove(event, piece.item, dayIndex, piece.startMinute, piece.endMinute, true)} className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize" />}
              </div>;
            })}
            {dayItems.map((item) => {
              const Icon = LAYER_ICON[item.kind];
              return <button key={item.id} type="button" onClick={() => onOpenItem(item)} onPointerDown={(event) => event.stopPropagation()} title={item.title}
                className="vso-cal-layer absolute left-1 right-1 z-[4] flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold"
                style={{ top: Math.min(minutesIntoDay(new Date(item.at)) * MINUTE_PX, 24 * HOUR_PX - 20) }}>
                <Icon size={10} className="shrink-0 opacity-70" /><span className="truncate">{item.title}</span>
              </button>;
            })}
            {today && <div className="vso-cal-now" style={{ top: nowTop }} aria-hidden="true" />}
            {preview && preview.dayIndex === dayIndex && preview.moved && <Ghost preview={preview} />}
            {preview && preview.kind === "create" && preview.dayIndex === dayIndex && !preview.moved && <Ghost preview={preview} />}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

function Ghost({ preview }: { preview: Gesture }) {
  if (preview.kind === "create") {
    const from = Math.min(preview.anchor, preview.current); const to = Math.max(preview.anchor, preview.current);
    const at = (minute: number) => timeText(new Date(2000, 0, 1, 0, minute));
    return <div className="vso-cal-selection absolute inset-x-1 px-2 py-1 text-[11px] font-semibold text-primary-800" style={{ top: from * MINUTE_PX, height: Math.max((to - from) * MINUTE_PX, 12) }}>{at(from)} – {at(to)}</div>;
  }
  const start = preview.kind === "move" ? preview.startMinute : preview.startMinute;
  const end = preview.kind === "move" ? preview.startMinute + preview.length : preview.endMinute;
  const at = (minute: number) => timeText(new Date(2000, 0, 1, 0, minute));
  return <div className={clsx("vso-cal-block vso-cal-dragging absolute inset-x-1 rounded-lg px-1.5 py-1 text-[11px] leading-4", colorClass(preview.item.color))} style={{ top: start * MINUTE_PX + 1, height: Math.max((end - start) * MINUTE_PX - 2, 18) }}>
    <p className="truncate font-semibold">{preview.item.title}</p><p className="opacity-80 tnum">{at(start)} – {at(Math.min(end, 24 * 60))}</p>
  </div>;
}
