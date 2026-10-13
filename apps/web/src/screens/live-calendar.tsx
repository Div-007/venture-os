"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import type { CalendarEvent, CalendarLayerItem, CalendarOccurrence } from "@venture-studio/contracts";
import { Calendar, CalendarPlus, ChevronLeft, ChevronRight, LinkIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { HeaderActions, HeaderLabel, PageFrame, PageTitle, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { AgendaView, MiniMonth } from "@/components/calendar/agenda-view";
import { EventDialog, type EventDialogTarget } from "@/components/calendar/event-dialog";
import { EventDrawer, type OpenOccurrence } from "@/components/calendar/event-drawer";
import { MonthView } from "@/components/calendar/month-view";
import { SubscribeDialog } from "@/components/calendar/subscribe-dialog";
import { TimeGrid } from "@/components/calendar/time-grid";
import { type CalendarView, dayKey, fromDayKey, LAYERS, type LayerKey, occurrenceDays, rangeTitle, startOfDay, stepAnchor, timeValue, viewerTimeZone, viewRange } from "@/components/calendar/calendar-utils";
import { getLiveEvent, loadLiveCalendar, loadLiveSession, updateLiveEvent } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
const VIEWS: { key: CalendarView; label: string }[] = [{ key: "month", label: "Month" }, { key: "week", label: "Week" }, { key: "day", label: "Day" }, { key: "agenda", label: "Agenda" }];
const LAYER_STORE = "vso-calendar-layers"; const VIEW_STORE = "vso-calendar-view";
const DEFAULT_LAYERS: LayerKey[] = ["tasks", "reviews", "classes"];

/** Personal and venture calendars: events, invitations, and existing work as layers, in month, week, day, or agenda view. */
export function LiveCalendarScreen() {
  const params = useSearchParams(); const router = useRouter(); const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [scope, setScope] = useState("mine");
  const [layers, setLayers] = useState<Set<LayerKey>>(() => new Set(DEFAULT_LAYERS));
  const [data, setData] = useState<{ events: CalendarOccurrence[]; items: CalendarLayerItem[]; truncated?: boolean | undefined }>({ events: [], items: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<OpenOccurrence | null>(null);
  const [dialog, setDialog] = useState<EventDialogTarget | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ item: CalendarOccurrence; start: Date; end: Date } | null>(null);

  // Remembered per device: the view (phones start on the agenda) and which layers show.
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const stored = localStorage.getItem(VIEW_STORE) as CalendarView | null;
        setView(stored && VIEWS.some((item) => item.key === stored) ? stored : window.matchMedia("(max-width: 767px)").matches ? "agenda" : "week");
        const savedLayers = localStorage.getItem(LAYER_STORE);
        if (savedLayers !== null) setLayers(new Set(savedLayers.split(",").filter((item) => LAYERS.some((layer) => layer.key === item)) as LayerKey[]));
      } catch { /* storage unavailable: defaults */ }
    });
  }, []);
  useEffect(() => { loadLiveSession().then(setSession).catch((cause: unknown) => setLoadError(describeError(cause, "Could not load your workspace."))); }, []);

  const range = useMemo(() => viewRange(view, anchor), [view, anchor]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setLoading(true); });
    loadLiveCalendar({ from: range.from.toISOString(), to: range.to.toISOString(), scope, layers: ["events", ...layers] })
      .then((value) => { if (active) { setData(value); setLoadError(""); setLoading(false); } })
      .catch((cause: unknown) => { if (active) { setLoadError(describeError(cause, "Could not load the calendar.")); setLoading(false); } });
    return () => { active = false; };
  }, [range, scope, layers, revision]);

  // A link like /calendar/live?event=… (from a notification) opens that event.
  const linked = params.get("event");
  // Once per link: closing the drawer clears it before the address drops ?event=, which must not reopen it.
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    if (!linked) { handledLink.current = null; return; }
    if (handledLink.current === linked) return;
    handledLink.current = linked;
    getLiveEvent(linked).then((event) => setOpen({ eventId: event.id, key: event.allDay ? event.startDate! : event.startAt, startAt: event.startAt, endAt: event.endAt, startDate: event.startDate, endDate: event.endDate })).catch(() => toast({ tone: "error", title: "That event is gone", body: "It was cancelled, or you can't open it." }));
  }, [linked]);
  const closeEvent = () => { setOpen(null); if (params.has("event")) { const next = new URLSearchParams(params); next.delete("event"); router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false }); } };

  const changeView = (next: CalendarView) => { setView(next); try { localStorage.setItem(VIEW_STORE, next); } catch { /* storage unavailable */ } };
  const toggleLayer = (key: LayerKey) => setLayers((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); try { localStorage.setItem(LAYER_STORE, [...next].join(",")); } catch { /* storage unavailable */ } return next; });
  const refresh = () => setRevision((value) => value + 1);
  const openItem = (item: CalendarLayerItem) => router.push(item.href);
  const openEvent = (item: CalendarOccurrence) => setOpen({ eventId: item.eventId, key: item.occurrenceKey, startAt: item.startAt, endAt: item.endAt, startDate: item.startDate, endDate: item.endDate });
  const create = useCallback((day = dayKey(anchor), start?: string, end?: string) => setDialog({ kind: "create", day, ...(start ? { start } : {}), ...(end ? { end } : {}) }), [anchor]);
  const scopeVenture = scope !== "mine" && scope !== "all" ? scope : undefined;
  // Outcome reviews belong to one venture, so that layer is offered only on a venture calendar.
  const shownLayers = LAYERS.filter((layer) => layer.key !== "outcomes" || scopeVenture);

  // Keyboard: T today, M/W/D/A views, ←/→ move, N new event (not while typing or with a dialog open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || dialog || open || subscribing) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable=true], [role=combobox]"))) return;
      const key = event.key.toLowerCase();
      if (key === "t") setAnchor(startOfDay(new Date()));
      else if (key === "arrowleft") setAnchor((current) => stepAnchor(view, current, -1));
      else if (key === "arrowright") setAnchor((current) => stepAnchor(view, current, 1));
      else if (key === "n") { event.preventDefault(); create(); }
      else { const next = VIEWS.find((item) => item.key[0] === key); if (next) changeView(next.key); else return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, dialog, open, subscribing, create]);

  async function reschedule(item: CalendarOccurrence, start: Date, end: Date, scopeChoice?: "series" | "occurrence") {
    if (item.recurring && !scopeChoice) { setPendingMove({ item, start, end }); return; }
    setPendingMove(null);
    try {
      const event = await getLiveEvent(item.eventId);
      const shift = start.getTime() - new Date(item.startAt).getTime();
      const seriesStart = scopeChoice === "series" ? new Date(new Date(event.startAt).getTime() + shift) : start;
      await updateLiveEvent(event.id, {
        title: event.title, description: event.description, location: event.location, ...(event.meetingUrl ? { meetingUrl: event.meetingUrl } : {}), visibility: event.visibility, ...(event.ventureId ? { ventureId: event.ventureId } : {}), ...(event.groupId ? { groupId: event.groupId } : {}),
        allDay: false, startAt: seriesStart.toISOString(), endAt: new Date(seriesStart.getTime() + (end.getTime() - start.getTime())).toISOString(), timezone: event.recurrence ? event.timezone : viewerTimeZone(),
        recurrence: scopeChoice === "occurrence" ? null : event.recurrence ?? null, attendeeIds: event.attendees.map((attendee) => attendee.userId), color: event.color,
        scope: scopeChoice ?? "series", baseVersion: event.version, ...(scopeChoice === "occurrence" ? { occurrenceKey: item.occurrenceKey } : {}),
      });
      toast({ title: "Moved", body: `${item.title} · ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(start)}${item.attendeeCount ? ". Everyone invited was told." : ""}` });
    } catch (cause) { toast({ tone: "error", title: "Could not move it", body: describeError(cause, "Try again.") }); }
    refresh();
  }

  const ventureName = (id?: string) => id ? session?.hierarchy.ventures.find((item) => item.id === id)?.name : undefined;
  const marked = useMemo(() => new Set(data.events.flatMap(occurrenceDays)), [data.events]);
  const empty = !loading && !loadError && !data.events.length && !data.items.length;
  const scopeName = scope === "mine" ? "My calendar" : scope === "all" ? "Everything" : ventureName(scope) ?? "Venture";

  return <PageFrame>
    <PageTitle title="Calendar" description={scope === "mine" ? "Your events, invitations, and work in one place." : scope === "all" ? "Your calendar and every venture calendar you can open." : `${scopeName}'s shared calendar: everyone in the venture sees it.`}
      action={<HeaderActions><button type="button" onClick={() => setSubscribing(true)} className={secondaryClass}><LinkIcon size={15} /><HeaderLabel>Add to phone calendar</HeaderLabel></button><button type="button" onClick={() => create()} className={primaryClass}><CalendarPlus size={15} /><HeaderLabel>New event</HeaderLabel></button></HeaderActions>} />
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => setAnchor(startOfDay(new Date()))} className={clsx(secondaryClass, "!min-h-9")}>Today</button>
      <div className="flex"><button type="button" aria-label="Previous" onClick={() => setAnchor((current) => stepAnchor(view, current, -1))} className="grid h-9 w-9 place-items-center rounded-l-xl border border-neutral-200 bg-white text-neutral-600 transition-colors duration-150 hover:bg-neutral-50"><ChevronLeft size={16} /></button><button type="button" aria-label="Next" onClick={() => setAnchor((current) => stepAnchor(view, current, 1))} className="-ml-px grid h-9 w-9 place-items-center rounded-r-xl border border-neutral-200 bg-white text-neutral-600 transition-colors duration-150 hover:bg-neutral-50"><ChevronRight size={16} /></button></div>
      <h2 className="min-w-0 flex-1 truncate text-lg font-bold tracking-[-.02em] text-neutral-900 max-sm:order-first max-sm:basis-full" aria-live="polite">{view === "agenda" ? `From ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" }).format(anchor)}` : rangeTitle(view, anchor)}</h2>
      <Select aria-label="Which calendar" value={scope} onChange={(event) => setScope(event.target.value)} className="!min-h-9 !w-auto !rounded-xl !text-sm">
        <option value="mine">My calendar</option>
        {session?.hierarchy.ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}
        <option value="all">Everything</option>
      </Select>
      <SlidingTabs tabs={VIEWS.map((item) => ({ key: item.key, label: item.label }))} active={view} onChange={(key) => changeView(key as CalendarView)} label="Calendar view" className="max-sm:w-full" fitContent />
    </div>
    {/* Below xl the options column is hidden, so the work layers become a row of chips. */}
    <div role="group" aria-label="Show my work" className="thin-scroll -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1 xl:hidden">
      {shownLayers.map((layer) => <button key={layer.key} type="button" aria-pressed={layers.has(layer.key)} onClick={() => toggleLayer(layer.key)}
        className={clsx("min-h-8 shrink-0 rounded-full border px-3 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]", layers.has(layer.key) ? "border-primary-200 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50")}>{layer.label}</button>)}
    </div>
    <div className="grid gap-4 xl:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="space-y-4 max-xl:hidden" aria-label="Calendar options">
        <Panel className="p-4"><MiniMonth anchor={anchor} selected={anchor} marked={marked} onPick={(day) => setAnchor(startOfDay(day))} onMonth={(direction) => setAnchor((current) => new Date(current.getFullYear(), current.getMonth() + direction, 1))} /></Panel>
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400">Show my work</p>
          <ul className="space-y-1">{shownLayers.map((layer) => <li key={layer.key}><label className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:bg-neutral-50"><input type="checkbox" checked={layers.has(layer.key)} onChange={() => toggleLayer(layer.key)} className="accent-[var(--color-primary-600)]" />{layer.label}</label></li>)}</ul>
          <p className="mt-3 text-[11px] leading-4 text-neutral-400">Dashed items come from tasks, classes, requests, and sales. Open one to change it there.</p>
        </Panel>
        <Panel className="p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400">Shortcuts</p>
          <p className="text-xs leading-6 text-neutral-500"><kbd className="font-semibold text-neutral-700">T</kbd> today · <kbd className="font-semibold text-neutral-700">N</kbd> new event · <kbd className="font-semibold text-neutral-700">M W D A</kbd> views · <kbd className="font-semibold text-neutral-700">← →</kbd> move</p>
        </Panel>
      </aside>
      <Panel className={clsx("relative overflow-hidden", view === "agenda" ? "min-h-[420px]" : "h-[min(78dvh,880px)] min-h-[520px]")}>
        {loading && <div role="status" aria-label="Loading the calendar" className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden"><div className="vso-cal-loading h-full w-1/3 bg-primary-500" /></div>}
        {loadError && !data.events.length ? <EmptyState variant="error" title="Could not load the calendar" body={loadError} action={{ label: "Try again", onClick: refresh }} />
          : view === "agenda" ? (empty ? <EmptyState variant="card" icon={Calendar} tone="green" title="Nothing in the next 30 days" body={scope === "mine" ? "Create an event, or turn on your work in the side panel." : "Nothing is on this calendar yet."} action={{ label: "New event", icon: CalendarPlus, onClick: () => create() }} />
            : <AgendaView from={range.from} events={data.events} items={data.items} ventureName={ventureName} onOpen={openEvent} onOpenItem={openItem} />)
          : view === "month" ? <MonthView anchor={anchor} events={data.events} items={data.items} onOpen={openEvent} onOpenItem={openItem} onCreate={(day) => create(day)} onShowDay={(day) => { setAnchor(fromDayKey(day)); changeView("day"); }} />
          : <TimeGrid days={range.days} events={data.events} items={data.items} onOpen={openEvent} onOpenItem={openItem} canDrag={(item) => item.myResponse === "organizer" && !item.allDay}
            onCreateRange={(start, end) => create(dayKey(start), timeValue(start), timeValue(end))} onReschedule={(item, start, end) => void reschedule(item, start, end)} />}
        {pendingMove && <div role="alertdialog" aria-label="Move which dates?" className="vso-fade-enter absolute inset-x-3 bottom-3 z-30 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-neutral-200 bg-white p-3 shadow-e3">
          <p className="text-sm font-semibold text-neutral-800">Move “{pendingMove.item.title}”: which dates?</p>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setPendingMove(null)} className={clsx(secondaryClass, "!min-h-9")}>Cancel</button><button type="button" onClick={() => void reschedule(pendingMove.item, pendingMove.start, pendingMove.end, "occurrence")} className={clsx(secondaryClass, "!min-h-9")}>This date only</button><button type="button" onClick={() => void reschedule(pendingMove.item, pendingMove.start, pendingMove.end, "series")} className={clsx(primaryClass, "!min-h-9")}>All dates</button></div>
        </div>}
      </Panel>
    </div>
    {data.truncated && <p className="mt-2 text-xs text-neutral-500">Showing the first 2,000 events in this range.</p>}
    {session && dialog && <EventDialog session={session} {...(scopeVenture ? { scopeVentureId: scopeVenture } : {})} target={dialog} onClose={() => setDialog(null)} onSaved={(event: CalendarEvent, message) => { setDialog(null); toast({ title: message, body: event.title }); if (!event.allDay) setAnchor(startOfDay(new Date(event.startAt))); else setAnchor(fromDayKey(event.startDate!)); refresh(); }} />}
    {session && open && <EventDrawer session={session} open={open} onClose={closeEvent} onEdit={(event, occurrence) => { closeEvent(); setDialog({ kind: "edit", event, occurrence }); }} onChanged={(message) => { toast({ title: message }); refresh(); if (/cancelled/i.test(message)) closeEvent(); }} />}
    {subscribing && <SubscribeDialog onClose={() => setSubscribing(false)} />}
  </PageFrame>;
}

