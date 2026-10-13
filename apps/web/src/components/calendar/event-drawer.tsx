"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import type { CalendarEvent } from "@venture-studio/contracts";
import { Calendar, Check, Copy, Edit, LockKeyhole, MapPin, Repeat, Users, Video } from "@/components/ui/icons";
import { DetailDrawer, Notice, SkeletonRows, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { cancelLiveEvent, getLiveEvent, listLiveMembers, loadLiveSession, respondToLiveEvent, setLiveEventReminders } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";
import { ALL_DAY_REMINDERS, colorClass, repeatText, TIMED_REMINDERS, whenText } from "./calendar-utils";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
export type OpenOccurrence = { eventId: string; key: string; startAt: string; endAt: string; startDate?: string | undefined; endDate?: string | undefined };
const RESPONSES = [["going", "Going"], ["maybe", "Maybe"], ["declined", "No"]] as const;
const ANSWER: Record<string, { label: string; tone: string }> = { going: { label: "Going", tone: "bg-success-surface text-success-text" }, maybe: { label: "Maybe", tone: "bg-warning-surface text-warning-text" }, declined: { label: "Not going", tone: "bg-neutral-100 text-neutral-500" }, pending: { label: "Invited", tone: "bg-neutral-100 text-neutral-600" } };

/** One event: when and where, who's coming, my answer and reminders, and edit or cancel for its organiser. */
export function EventDrawer({ session, open, onClose, onEdit, onChanged }: { session: Session; open: OpenOccurrence; onClose: () => void; onEdit: (event: CalendarEvent, occurrence: OpenOccurrence) => void; onChanged: (message: string) => void }) {
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) { setEvent(null); setError(""); setCancelling(false); } });
    getLiveEvent(open.eventId).then((value) => { if (active) setEvent(value); }).catch((cause: unknown) => { if (active) setError(describeError(cause, "Could not load this event.")); });
    listLiveMembers({ limit: 100 }).then((page) => { if (active) setNames(Object.fromEntries(page.items.map((item) => [item.id, item.name]))); }).catch(() => undefined);
    return () => { active = false; };
  }, [open.eventId]);

  const nameOf = (id: string) => id === session.user.id ? "You" : names[id] ?? "Member";
  const venture = event?.ventureId ? session.hierarchy.ventures.find((item) => item.id === event.ventureId) : undefined;
  const group = event?.groupId ? venture?.groups.find((item) => item.id === event.groupId) : undefined;

  async function act(key: string, work: () => Promise<CalendarEvent | void>, message?: string) {
    setBusy(key); setError("");
    try { const value = await work(); if (value) setEvent(value); if (message) onChanged(message); }
    catch (cause) { setError(describeError(cause, "That didn't work. Please try again.")); }
    finally { setBusy(""); }
  }
  async function cancel(occurrenceOnly: boolean) {
    if (!event) return;
    await act("cancel", () => cancelLiveEvent(event.id, occurrenceOnly ? open.key : undefined), occurrenceOnly ? "This date was cancelled" : "Event cancelled");
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(`${window.location.origin}/calendar/live?event=${encodeURIComponent(open.eventId)}`); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setError("Copy was unavailable."); }
  }

  const going = event ? [{ userId: event.organizerId, response: "organizer" }, ...event.attendees] : [];
  const reminderOptions = event?.allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
  const coming = event && (event.myResponse === "organizer" || event.myResponse === "going" || event.myResponse === "maybe" || event.myResponse === "pending");

  return createPortal(<DetailDrawer title={event?.title ?? "Event"} subtitle={event ? whenText({ ...open, allDay: event.allDay }) : "Loading"} onClose={onClose}>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mb-4" />
    {!event ? (!error && <SkeletonRows rows={5} label="Loading event" />) : <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx("vso-cal-block inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", colorClass(event.color))}><span className="vso-cal-dot h-2 w-2 rounded-full" />{event.visibility === "private" ? "Private" : group ? `${venture?.name ?? "Venture"} · ${group.name}` : venture?.name ?? "Venture"}</span>
        {event.visibility === "private" && <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><LockKeyhole size={12} />Only you{event.attendees.length ? " and invitees" : ""}</span>}
        {event.recurrence && <span className="inline-flex items-center gap-1 text-xs text-neutral-500"><Repeat size={12} />{repeatText(event.recurrence)}</span>}
      </div>
      {(event.location || event.meetingUrl) && <div className="space-y-2">
        {event.location && <p className="flex items-start gap-2 text-sm text-neutral-700"><MapPin size={15} className="mt-0.5 shrink-0 text-neutral-400" />{event.location}</p>}
        {event.meetingUrl && <a href={event.meetingUrl} target="_blank" rel="noopener noreferrer" className={clsx(primaryClass, "w-full sm:w-auto")}><Video size={15} />Join call</a>}
      </div>}
      {event.description && <p className="whitespace-pre-wrap rounded-xl bg-neutral-50 p-3 text-sm leading-6 text-neutral-700">{event.description}</p>}

      {event.myResponse !== "organizer" && <div>
        <p className="mb-1.5 text-xs font-semibold text-neutral-600">Are you going?</p>
        <div role="radiogroup" aria-label="Your answer" className="grid grid-cols-3 gap-1 rounded-xl bg-neutral-100 p-1">
          {RESPONSES.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={event.myResponse === value} disabled={Boolean(busy)} onClick={() => void act(value, () => respondToLiveEvent(event.id, value), value === "declined" ? "You won't get reminders for it" : undefined)}
            className={clsx("min-h-9 rounded-lg text-sm font-semibold transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.97]", event.myResponse === value ? "bg-white text-neutral-900" : "text-neutral-500 hover:text-neutral-800")}>{busy === value ? "…" : label}</button>)}
        </div>
        {event.myResponse === "none" && <p className="mt-1.5 text-xs text-neutral-500">You weren&apos;t invited, but anyone on this calendar can join.</p>}
      </div>}

      {coming && <div>
        <p className="mb-1.5 text-xs font-semibold text-neutral-600">My reminders</p>
        <div role="group" aria-label="My reminders" className="flex flex-wrap gap-1.5">{reminderOptions.map((option) => { const on = event.myReminders.includes(option.minutes); return <button key={option.minutes} type="button" aria-pressed={on} disabled={Boolean(busy) || (!on && event.myReminders.length >= 5)} onClick={() => void act(`reminder-${option.minutes}`, () => setLiveEventReminders(event.id, on ? event.myReminders.filter((item) => item !== option.minutes) : [...event.myReminders, option.minutes]))}
          className={clsx("min-h-8 rounded-lg border px-2.5 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]", on ? "border-primary-300 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50")}>{option.label}</button>; })}</div>
      </div>}

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-neutral-600"><Users size={13} />{going.length} {going.length === 1 ? "person" : "people"}</p>
        <ul className="space-y-1.5">{going.map((item) => <li key={item.userId} className="flex items-center justify-between gap-3 rounded-xl px-1 py-1">
          <span className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-50 text-[10px] font-bold text-primary-700">{nameOf(item.userId).split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("")}</span><span className="truncate text-sm font-medium text-neutral-800">{nameOf(item.userId)}</span></span>
          <span className={clsx("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", item.response === "organizer" ? "bg-primary-50 text-primary-800" : ANSWER[item.response]?.tone)}>{item.response === "organizer" ? "Organiser" : ANSWER[item.response]?.label}</span>
        </li>)}</ul>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-neutral-100 pt-4">
        {event.canEdit && <button type="button" onClick={() => onEdit(event, open)} className={secondaryClass}><Edit size={15} />Edit</button>}
        <button type="button" onClick={() => void copyLink()} className={secondaryClass}>{copied ? <><Check size={15} />Copied</> : <><Copy size={15} />Copy link</>}</button>
        {event.canEdit && !cancelling && <button type="button" onClick={() => setCancelling(true)} className="min-h-10 rounded-xl px-3 text-sm font-semibold text-danger-text transition-[background-color,transform] duration-150 hover:bg-danger-surface active:scale-[0.97]">Cancel event</button>}
      </div>
      {cancelling && <div role="alertdialog" aria-label="Cancel this event?" className="vso-fade-enter rounded-xl border border-danger/30 bg-danger-surface p-3">
        <p className="text-sm font-semibold text-danger-text">{event.recurrence ? "Cancel which dates?" : "Cancel this event?"} Everyone invited is told.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => setCancelling(false)} className={secondaryClass}>Keep it</button>
          {event.recurrence && <button type="button" disabled={busy === "cancel"} onClick={() => void cancel(true)} className={secondaryClass}>This date only</button>}
          <button type="button" disabled={busy === "cancel"} onClick={() => void cancel(false)} className="min-h-10 rounded-xl bg-[#b42318] px-4 text-sm font-semibold text-white transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.97]">{busy === "cancel" ? "Cancelling…" : event.recurrence ? "All dates" : "Cancel event"}</button>
        </div>
      </div>}
      <p className="flex items-center gap-1.5 text-xs text-neutral-400"><Calendar size={12} />Times show in your time zone{event.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? `; organised in ${event.timezone}` : ""}.</p>
    </div>}
  </DetailDrawer>, document.body);
}
