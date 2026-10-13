"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import type { CalendarEvent } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { ditherTone, EmptyTile } from "@/components/ui/empty-state";
import { Dither } from "@/components/ui/dither";
import { Calendar, LockKeyhole, X } from "@/components/ui/icons";
import { Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { createLiveEvent, listLiveMembers, loadLiveSession, updateLiveEvent } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";
import { useExitTransition } from "@/lib/motion";
import { ALL_DAY_REMINDERS, colorClass, dateFromValues, dayKey, daysBetweenKeys, EVENT_COLORS, fromDayKey, shiftKey, TIMED_REMINDERS, timeValue, viewerTimeZone, WEEKDAY_SHORT } from "./calendar-utils";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Repeat = "none" | "daily" | "weekly" | "weekdays" | "monthly";
type Ends = "never" | "on" | "after";
export type EventDialogTarget = { kind: "create"; day: string; start?: string; end?: string; allDay?: boolean } | { kind: "edit"; event: CalendarEvent; occurrence?: { key: string; startAt: string; endAt: string; startDate?: string | undefined; endDate?: string | undefined } };

const chip = (active: boolean) => clsx("min-h-8 rounded-lg border px-2.5 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]", active ? "border-primary-300 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50");
const ordinal = (day: number) => `${day}${day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th"}`;

/**
 * Create or edit an event. Opened from a venture's calendar, the event goes on that venture's calendar (shown, not asked);
 * elsewhere it starts private. Editing one date of a repeating event asks whether the change is for that date or all dates.
 */
export function EventDialog({ session, scopeVentureId, target, onClose, onSaved }: { session: Session; scopeVentureId?: string; target: EventDialogTarget; onClose: () => void; onSaved: (event: CalendarEvent, message: string) => void }) {
  const editing = target.kind === "edit" ? target.event : undefined;
  const occurrence = target.kind === "edit" ? target.occurrence : undefined;
  const me = session.user.id;
  // The organiser isn't an invitee; a lead editing someone else's event stays on its list.
  const organizerId = editing?.organizerId ?? me;
  const learner = session.membership.role === "learner";
  // The organiser's reminders are also the starting point for everyone invited; a lead editing someone else's event leaves them.
  const ownReminders = target.kind === "create" || target.event.myResponse === "organizer";
  const initial = useMemo(() => {
    if (target.kind === "create") {
      const start = target.start ?? "09:00";
      return { title: "", allDay: Boolean(target.allDay), day: target.day, lastDay: target.day, start, end: target.end ?? timeValue(new Date(dateFromValues(target.day, start).getTime() + 60 * 60_000)), where: scopeVentureId ? `venture:${scopeVentureId}` : "private", attendees: [] as string[], location: "", meetingUrl: "", description: "", reminders: target.allDay ? [900] : [10], color: "green" as string, repeat: "none" as Repeat, interval: 1, weekdays: [fromDayKey(target.day).getDay()], ends: "never" as Ends, until: shiftKey(target.day, 28), count: 10 };
    }
    const event = target.event;
    const at = occurrence ?? event;
    const startDate = at.startDate ?? dayKey(new Date(at.startAt)); const endDate = at.endDate ?? startDate;
    const recurrence = event.recurrence;
    const repeat: Repeat = !recurrence ? "none" : recurrence.freq === "weekly" && (recurrence.weekdays?.length ?? 0) > 1 ? "weekdays" : recurrence.freq;
    return {
      title: event.title, allDay: event.allDay, day: event.allDay ? startDate : dayKey(new Date(at.startAt)), lastDay: event.allDay ? shiftKey(endDate, -1) : dayKey(new Date(at.startAt)),
      start: timeValue(new Date(at.startAt)), end: timeValue(new Date(at.endAt)), where: event.visibility === "private" ? "private" : event.visibility === "group" ? `group:${event.ventureId}:${event.groupId}` : `venture:${event.ventureId}`,
      attendees: event.attendees.map((item) => item.userId), location: event.location, meetingUrl: event.meetingUrl ?? "", description: event.description, reminders: event.myReminders, color: event.color as string,
      repeat, interval: recurrence?.interval ?? 1, weekdays: recurrence?.weekdays ?? [fromDayKey(startDate).getDay()], ends: (recurrence?.until ? "on" : recurrence?.count ? "after" : "never") as Ends, until: recurrence?.until ?? shiftKey(startDate, 28), count: recurrence?.count ?? 10,
    };
  }, [target, scopeVentureId, occurrence]);
  const [draft, setDraft] = useState(initial);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [askScope, setAskScope] = useState(false);
  const exit = useExitTransition(onClose, 130);
  const titleInput = useRef<HTMLInputElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => { setDraft((current) => ({ ...current, [key]: value })); setError(""); };
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => { titleInput.current?.focus(); }, []);
  // Names for people already invited (the picker supplies them for new ones).
  useEffect(() => { if (initial.attendees.length) void listLiveMembers({ limit: 100 }).then((page) => setNames(Object.fromEntries(page.items.map((item) => [item.id, item.name])))).catch(() => undefined); }, [initial.attendees.length]);

  const [kind, ventureId, groupId] = draft.where.split(":") as [string, string | undefined, string | undefined];
  const scopedVenture = scopeVentureId ? session.hierarchy.ventures.find((item) => item.id === scopeVentureId) : undefined;
  const ventures = session.hierarchy.ventures;
  const requestClose = useCallback(() => { if (busy) return; if (dirty) { setConfirming(true); requestAnimationFrame(() => keepEditing.current?.focus()); return; } exit.close(); }, [busy, dirty, exit]);

  function body(scope: "series" | "occurrence") {
    const timezone = viewerTimeZone();
    const visibility = kind === "private" ? "private" : kind === "group" ? "group" : "venture";
    const recurrence = scope === "occurrence" || draft.repeat === "none" ? null : {
      freq: draft.repeat === "weekdays" ? "weekly" as const : draft.repeat, interval: Math.max(1, Math.min(30, draft.interval || 1)),
      ...(draft.repeat === "weekdays" ? { weekdays: draft.weekdays } : draft.repeat === "weekly" ? { weekdays: [fromDayKey(draft.day).getDay()] } : {}),
      ...(draft.ends === "on" ? { until: draft.until } : draft.ends === "after" ? { count: Math.max(1, Math.min(500, draft.count || 1)) } : {}),
    };
    // Editing all dates from one date moves the whole series by the same number of days.
    const seriesShift = editing && occurrence && scope === "series" ? daysBetweenKeys(occurrence.startDate ?? dayKey(new Date(occurrence.startAt)), editing.allDay ? editing.startDate! : dayKey(new Date(editing.startAt))) : 0;
    const day = shiftKey(draft.day, seriesShift); const lastDay = shiftKey(draft.lastDay, seriesShift);
    const startAt = dateFromValues(day, draft.start);
    let endAt = dateFromValues(day, draft.end);
    // An end at or before the start means the event runs past midnight.
    if (endAt <= startAt) endAt = new Date(endAt.getTime() + 86_400_000);
    return {
      title: draft.title.trim(), description: draft.description.trim(), location: draft.location.trim(), ...(draft.meetingUrl.trim() ? { meetingUrl: draft.meetingUrl.trim() } : {}),
      visibility, ...(ventureId ? { ventureId } : {}), ...(groupId ? { groupId } : {}), allDay: draft.allDay,
      ...(draft.allDay ? { startDate: day, endDate: shiftKey(lastDay, 1) } : { startAt: startAt.toISOString(), endAt: endAt.toISOString() }),
      timezone, recurrence, attendeeIds: draft.attendees.filter((id) => id !== organizerId), ...(ownReminders ? { reminders: draft.reminders } : {}), color: draft.color,
      ...(editing ? { scope, baseVersion: editing.version, ...(scope === "occurrence" ? { occurrenceKey: occurrence!.key } : {}) } : {}),
    };
  }

  async function save(scope?: "series" | "occurrence") {
    if (busy) return;
    if (!draft.title.trim()) { setError("Give the event a title."); titleInput.current?.focus(); return; }
    if (draft.allDay && draft.lastDay < draft.day) { setError("The last day is before the first day."); return; }
    if (draft.repeat !== "none" && draft.ends === "on" && draft.until < draft.day) { setError("The repeat ends before the event starts."); return; }
    if (draft.repeat === "weekdays" && !draft.weekdays.length) { setError("Pick at least one weekday."); return; }
    // A repeating event edited from one of its dates: ask which dates the change is for.
    if (editing?.recurrence && occurrence && !scope) { setAskScope(true); return; }
    setBusy(true); setError("");
    try {
      const saved = editing ? await updateLiveEvent(editing.id, body(scope ?? "series")) : await createLiveEvent(body("series"));
      onSaved(saved, editing ? scope === "occurrence" ? "This date was updated" : "Event updated" : saved.attendees.length ? `Event created and ${saved.attendees.length} invited` : "Event created");
    } catch (cause) { setError(describeError(cause, "The event could not be saved. Please try again.")); setAskScope(false); }
    finally { setBusy(false); }
  }

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      if (event.target instanceof HTMLElement && event.target.closest('[role="combobox"][aria-expanded="true"]')) return;
      event.stopPropagation();
      if (confirming) setConfirming(false); else if (askScope) setAskScope(false); else requestClose();
    }
  }

  const reminderOptions = draft.allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
  const weekday = WEEKDAY_SHORT[fromDayKey(draft.day).getDay()];
  const repeatChoices: [Repeat, string][] = [["none", "Does not repeat"], ["daily", "Every day"], ["weekly", `Every week on ${weekday}`], ["weekdays", "Every week on chosen days"], ["monthly", `Every month on the ${ordinal(fromDayKey(draft.day).getDate())}`]];
  const pickerScope = kind === "private" ? {} : { ventureId: ventureId!, ...(groupId ? { groupId } : {}) };

  return createPortal(<div data-state={exit.state} className="vso-backdrop fixed inset-0 z-[60] grid place-items-center bg-neutral-900/30 p-3 backdrop-blur-[2px] sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="event-dialog-title" onKeyDownCapture={onKey} className="vso-enter-modal flex max-h-[min(92dvh,900px)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
      <header className="relative flex items-start gap-3 overflow-hidden border-b border-neutral-100 px-5 py-5 sm:px-6">
        <div aria-hidden="true" className="vso-dialog-glow absolute inset-0" />
        <Dither colors={ditherTone("green")} origin={[1.05, -0.4]} reach={1.25} pixel={3} animated className="vso-dialog-dither opacity-90" />
        <span className="relative"><EmptyTile icon={Calendar} tone="green" size={40} /></span>
        <div className="relative min-w-0 flex-1"><h2 id="event-dialog-title" className="text-base font-bold text-neutral-900">{editing ? occurrence && editing.recurrence ? "Edit event" : "Edit event" : "New event"}</h2><p className="text-xs text-neutral-500">{scopedVenture && !editing ? `On ${scopedVenture.name}'s calendar.` : "Invite people and they can answer Going, Maybe, or No."}</p></div>
        <button type="button" aria-label="Close" onClick={requestClose} className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-800 active:scale-[0.96]"><X size={16} /></button>
      </header>
      <div data-open={confirming} className="vso-collapse"><div><div role="alertdialog" aria-label="Discard changes?" className="flex flex-wrap items-center justify-between gap-3 bg-warning-surface px-5 py-3 sm:px-6"><p className="text-sm font-semibold text-warning-text">Discard this {editing ? "change" : "event"}?</p><div className="flex gap-2"><button ref={keepEditing} type="button" tabIndex={confirming ? 0 : -1} onClick={() => setConfirming(false)} className={clsx(secondaryClass, "!min-h-9")}>Keep editing</button><button type="button" tabIndex={confirming ? 0 : -1} onClick={exit.close} className="min-h-9 rounded-xl bg-[#b42318] px-3 text-sm font-semibold text-white transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.97]">Discard</button></div></div></div></div>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex min-h-0 flex-1 flex-col">
        <div className="thin-scroll grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-5 sm:grid-cols-2 sm:px-6">
          <div className="sm:col-span-2"><Field label="Title"><input ref={titleInput} required maxLength={200} value={draft.title} onChange={(event) => set("title", event.target.value)} className={inputClass} placeholder="What's happening?" /></Field></div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-neutral-700"><input type="checkbox" checked={draft.allDay} onChange={(event) => { const allDay = event.target.checked; setDraft((current) => ({ ...current, allDay, reminders: allDay ? [900] : [10] })); }} className="accent-[var(--color-primary-600)]" />All day</label>
          </div>
          {draft.allDay ? <>
            <Field label="From"><input type="date" required value={draft.day} onChange={(event) => { const day = event.target.value; setDraft((current) => ({ ...current, day, lastDay: current.lastDay < day ? day : current.lastDay })); }} className={inputClass} /></Field>
            <Field label="Until (last day)"><input type="date" required min={draft.day} value={draft.lastDay} onChange={(event) => set("lastDay", event.target.value)} className={inputClass} /></Field>
          </> : <>
            <div className="sm:col-span-2"><Field label="Date"><input type="date" required value={draft.day} onChange={(event) => setDraft((current) => ({ ...current, day: event.target.value, lastDay: event.target.value }))} className={inputClass} /></Field></div>
            <Field label="Starts"><input type="time" required step={300} value={draft.start} onChange={(event) => { const start = event.target.value; setDraft((current) => { const length = dateFromValues(current.day, current.end).getTime() - dateFromValues(current.day, current.start).getTime(); return { ...current, start, end: length > 0 ? timeValue(new Date(dateFromValues(current.day, start).getTime() + length)) : current.end }; }); }} className={inputClass} /></Field>
            <Field label="Ends"><input type="time" required step={300} value={draft.end} onChange={(event) => set("end", event.target.value)} className={inputClass} /></Field>
            {draft.end <= draft.start && <p className="-mt-2 text-xs text-neutral-500 sm:col-span-2">Ends the next day.</p>}
          </>}
          {!occurrence || !editing?.recurrence ? <div className="sm:col-span-2 space-y-2">
            <Field label="Repeat"><Select className={inputClass} value={draft.repeat} onChange={(event) => set("repeat", event.target.value as Repeat)}>{repeatChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
            {draft.repeat === "weekdays" && <div role="group" aria-label="Repeat on" className="flex flex-wrap gap-1.5">{[1, 2, 3, 4, 5, 6, 0].map((day) => <button key={day} type="button" aria-pressed={draft.weekdays.includes(day)} onClick={() => set("weekdays", draft.weekdays.includes(day) ? draft.weekdays.filter((item) => item !== day) : [...draft.weekdays, day])} className={chip(draft.weekdays.includes(day))}>{WEEKDAY_SHORT[day]}</button>)}</div>}
            {draft.repeat !== "none" && <div className="grid gap-3 sm:grid-cols-3">
              <Field label={`Every (${draft.repeat === "daily" ? "days" : draft.repeat === "monthly" ? "months" : "weeks"})`}><input type="number" min={1} max={30} value={draft.interval} onChange={(event) => set("interval", Number(event.target.value))} className={inputClass} /></Field>
              <Field label="Ends"><Select className={inputClass} value={draft.ends} onChange={(event) => set("ends", event.target.value as Ends)}><option value="never">Never</option><option value="on">On a date</option><option value="after">After a number of times</option></Select></Field>
              {draft.ends === "on" && <Field label="Last date"><input type="date" min={draft.day} value={draft.until} onChange={(event) => set("until", event.target.value)} className={inputClass} /></Field>}
              {draft.ends === "after" && <Field label="Times"><input type="number" min={1} max={500} value={draft.count} onChange={(event) => set("count", Number(event.target.value))} className={inputClass} /></Field>}
            </div>}
          </div> : <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600 sm:col-span-2">This event repeats. When you save, choose whether the change is for this date only or for all dates.</p>}
          <div className="sm:col-span-2">
            {scopedVenture && (!editing || editing.visibility !== "private")
              ? <Field label="Calendar"><Select className={inputClass} value={draft.where} onChange={(event) => set("where", event.target.value)} aria-label={`Calendar: ${scopedVenture.name}`}><option value={`venture:${scopedVenture.id}`}>{scopedVenture.name}: whole venture</option>{scopedVenture.groups.map((group) => <option key={group.id} value={`group:${scopedVenture.id}:${group.id}`}>{scopedVenture.name}: {group.name} only</option>)}</Select></Field>
              : <Field label="Calendar"><Select className={inputClass} value={draft.where} onChange={(event) => { set("where", event.target.value); }}>
                <option value="private">Only me and the people I invite</option>
                {!learner && ventures.map((venture) => <Fragment key={venture.id}><option value={`venture:${venture.id}`}>{venture.name}: whole venture</option>{venture.groups.map((group) => <option key={group.id} value={`group:${venture.id}:${group.id}`}>{venture.name}: {group.name} only</option>)}</Fragment>)}
              </Select></Field>}
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-500">{kind === "private" ? <><LockKeyhole size={12} />Only you and the people you invite see it.</> : `Everyone who can open ${kind === "group" ? "this group" : "this venture"} sees it and can join.`}</p>
          </div>
          <div className="sm:col-span-2 space-y-2">
            <LiveMemberPicker label="Invite people" value="" optional emptyLabel="Add a person…" onChange={(id, member) => { if (!id) return; if (member) setNames((current) => ({ ...current, [id]: member.name })); set("attendees", draft.attendees.includes(id) ? draft.attendees : [...draft.attendees, id]); }} excludeIds={[me, ...draft.attendees]} {...pickerScope} />
            {draft.attendees.filter((id) => id !== organizerId).length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label="Invited">{draft.attendees.filter((id) => id !== organizerId).map((id) => <li key={id} className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-1 pl-3 pr-1 text-xs font-semibold text-neutral-700">{names[id] ?? "Member"}<button type="button" aria-label={`Remove ${names[id] ?? "this person"}`} onClick={() => set("attendees", draft.attendees.filter((item) => item !== id))} className="grid h-5 w-5 place-items-center rounded-full text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800"><X size={11} /></button></li>)}</ul>}
          </div>
          <Field label="Location"><input maxLength={300} value={draft.location} onChange={(event) => set("location", event.target.value)} className={inputClass} placeholder="Office, café, or address" /></Field>
          <Field label="Call link"><input type="url" maxLength={2000} value={draft.meetingUrl} onChange={(event) => set("meetingUrl", event.target.value)} className={inputClass} placeholder="https://meet.google.com/…" /></Field>
          <div className="sm:col-span-2"><Field label="Notes"><textarea maxLength={5000} value={draft.description} onChange={(event) => set("description", event.target.value)} className={`${inputClass} min-h-20 py-3`} placeholder="Agenda, links, anything people should know" /></Field></div>
          {ownReminders && <div className="sm:col-span-2"><p className="mb-1.5 text-xs font-semibold text-neutral-600">Remind me</p><div role="group" aria-label="Reminders" className="flex flex-wrap gap-1.5">{reminderOptions.map((option) => { const on = draft.reminders.includes(option.minutes); return <button key={option.minutes} type="button" aria-pressed={on} disabled={!on && draft.reminders.length >= 5} onClick={() => set("reminders", on ? draft.reminders.filter((item) => item !== option.minutes) : [...draft.reminders, option.minutes])} className={chip(on)}>{option.label}</button>; })}</div><p className="mt-1.5 text-xs text-neutral-500">{editing ? "Your reminders, and the starting point for people who haven't chosen their own." : "People you invite start with the same reminders and can change theirs."}</p></div>}
          <div className="sm:col-span-2"><p className="mb-1.5 text-xs font-semibold text-neutral-600">Colour</p><div role="radiogroup" aria-label="Colour" className="flex gap-2">{EVENT_COLORS.map((color) => <label key={color} className={clsx("vso-cal-block relative grid h-8 w-8 cursor-pointer place-items-center rounded-full transition-transform duration-150 active:scale-95 has-[:checked]:ring-2 has-[:checked]:ring-neutral-800 has-[:checked]:ring-offset-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-600", colorClass(color))}><input type="radio" name="event-colour" className="sr-only" checked={draft.color === color} onChange={() => set("color", color)} aria-label={color} /><span className="vso-cal-dot h-3.5 w-3.5 rounded-full" /></label>)}</div></div>
          <div className="sm:col-span-2"><Notice tone="error" message={error} onDismiss={() => setError("")} /></div>
        </div>
        <footer className="border-t border-neutral-100 px-5 py-4 sm:px-6">
          {askScope ? <div className="vso-fade-enter flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-neutral-800">Change which dates?</p><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setAskScope(false)} className={secondaryClass}>Back</button><button type="button" disabled={busy} onClick={() => void save("occurrence")} className={secondaryClass}>This date only</button><button type="button" disabled={busy} onClick={() => void save("series")} className={primaryClass}>{busy ? "Saving…" : "All dates"}</button></div></div>
            : <div className="flex justify-end gap-2"><button type="button" onClick={requestClose} className={secondaryClass}>Cancel</button><button disabled={busy} className={primaryClass}>{busy ? "Saving…" : editing ? "Save" : "Create event"}</button></div>}
        </footer>
      </form>
    </section>
  </div>, document.body);
}
