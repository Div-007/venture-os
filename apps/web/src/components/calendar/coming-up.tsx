"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { CalendarOccurrence } from "@venture-studio/contracts";
import { ArrowRight, Calendar, Video } from "@/components/ui/icons";
import { WorkspaceLink as Link } from "@/components/shell/workspace-link";
import { Panel, PanelHead } from "@/components/studio/primitives";
import { loadLiveCalendar } from "@/lib/studio-api";
import { addDays, colorClass, isSameDay, responseClass, startOfDay, timeText } from "./calendar-utils";

/** The next few events on my calendar (today through two days ahead), for Today and the dashboard. */
export function ComingUp() {
  const [events, setEvents] = useState<CalendarOccurrence[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const now = new Date();
    loadLiveCalendar({ from: now.toISOString(), to: addDays(startOfDay(now), 3).toISOString(), scope: "mine", layers: ["events"] })
      .then((value) => setEvents(value.events.filter((item) => item.myResponse !== "declined").slice(0, 4)))
      .catch(() => setFailed(true));
  }, []);
  const today = startOfDay(new Date());
  const dayLabel = (date: Date) => isSameDay(date, today) ? "Today" : isSameDay(date, addDays(today, 1)) ? "Tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);

  return <Panel>
    <PanelHead title="Coming up" aside={<Link href="/calendar" className="text-xs font-semibold text-primary-600">Calendar <ArrowRight size={12} className="inline" /></Link>} />
    {failed ? <p className="px-5 pb-5 text-sm text-neutral-500">Your calendar couldn&apos;t be loaded right now.</p>
      : !events ? <div className="space-y-2 px-5 pb-5" role="status" aria-label="Loading your calendar"><span className="vso-skeleton block h-11" /><span className="vso-skeleton block h-11" /></div>
      : !events.length ? <div className="flex items-center gap-3 px-5 pb-5"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-700"><Calendar size={17} /></span><p className="text-sm leading-5 text-neutral-500">Nothing on your calendar for the next few days.</p></div>
      : <ul className="space-y-1.5 px-3 pb-3">{events.map((item) => {
        const start = new Date(item.allDay ? `${item.startDate}T00:00:00` : item.startAt);
        return <li key={`${item.eventId}-${item.occurrenceKey}`}><Link href={`/calendar/live?event=${encodeURIComponent(item.eventId)}`} className={clsx("vso-cal-block flex items-center gap-3 rounded-xl px-3 py-2.5 transition-[filter,transform] duration-150 hover:brightness-[.97] active:scale-[0.99]", colorClass(item.color), responseClass(item.myResponse))}>
          <span className="w-16 shrink-0 text-xs font-semibold leading-4 opacity-80"><span className="block">{dayLabel(start)}</span><span className="tnum">{item.allDay ? "All day" : timeText(start)}</span></span>
          <span className="vso-cal-title min-w-0 flex-1 truncate text-sm font-semibold">{item.title}</span>
          {item.hasMeeting && <Video size={14} className="shrink-0 opacity-70" aria-label="Has a call link" />}
        </Link></li>;
      })}</ul>}
  </Panel>;
}
