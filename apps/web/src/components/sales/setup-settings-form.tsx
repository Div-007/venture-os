"use client";
import { useState } from "react";
import clsx from "clsx";
import { SALES_CHANNELS } from "@venture-studio/contracts";
import { Plus, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { putSalesSettings, rememberSalesSettings, type SalesSettingsView } from "@/lib/sales-api";
import { CHANNEL_LABEL } from "./draft-shared";
import { DAY_NAMES } from "./setup-checks";

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];
const APPROVAL: { mode: SalesSettingsView["approvalMode"]; title: string; line: string }[] = [
  { mode: "claude_review_enough", title: "Claude's review is enough", line: "A person reads the first batch of each play. After that, a message Claude has checked can be sent." },
  { mode: "person_approves_every_message", title: "A person approves every message", line: "Every message waits for a person's approval before it can be marked sent, even after Claude's check." },
];
const dateLabel = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const dayLabel = (date: string) => dateLabel.format(new Date(`${date}T00:00:00Z`));
const isRealDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** Compact form for a venture's working days, holidays, reply and follow-up timing, daily limits, channels and approval mode. */
export function SetupSettingsForm({ ventureId, initial, onSaved }: { ventureId: string; initial: SalesSettingsView; onSaved: (saved: SalesSettingsView) => void }) {
  const [days, setDays] = useState<number[]>(initial.workingDays);
  const [followUp, setFollowUp] = useState(String(initial.followUpAfterWorkingDays));
  const [sla, setSla] = useState(String(initial.replySlaHours));
  const [emails, setEmails] = useState(String(initial.dailyCaps.email));
  const [whatsapp, setWhatsapp] = useState(String(initial.dailyCaps.whatsapp));
  const [approval, setApproval] = useState<SalesSettingsView["approvalMode"]>(initial.approvalMode);
  const [channels, setChannels] = useState<SalesSettingsView["allowedChannels"]>(initial.allowedChannels);
  const [holidays, setHolidays] = useState<string[]>(initial.blackoutDates);
  const [newHoliday, setNewHoliday] = useState("");
  const [zone, setZone] = useState(initial.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = <T,>(list: T[], value: T) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const number = (text: string) => Number(text.trim());

  function addHoliday() {
    if (!isRealDate(newHoliday)) { setError("Pick a date to add."); return; }
    setError(""); setHolidays([...new Set([...holidays, newHoliday])].sort()); setNewHoliday("");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!days.length) { setError("Pick at least one working day."); return; }
    if (!channels.length) { setError("Pick at least one channel."); return; }
    const values = { followUp: number(followUp), sla: number(sla), emails: number(emails), whatsapp: number(whatsapp) };
    if (Object.values(values).some((value) => !Number.isInteger(value) || value < 0)) { setError("Days, hours and limits are whole numbers."); return; }
    setBusy(true); setError("");
    try {
      const saved = await putSalesSettings(ventureId, { workingDays: days, blackoutDates: holidays, followUpAfterWorkingDays: values.followUp, replySlaHours: values.sla, dailyCaps: { email: values.emails, whatsapp: values.whatsapp }, approvalMode: approval, allowedChannels: channels, timezone: zone });
      rememberSalesSettings(saved);
      toast({ title: "Settings saved", body: "They apply to every lead in this venture from now on." });
      onSaved(saved);
    } catch (cause) { setError(describeError(cause, "Could not save the settings. Try again.")); }
    finally { setBusy(false); }
  }

  const chip = (active: boolean) => clsx("inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-semibold transition-[background-color,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", active ? "border-primary-600 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50");
  return <form onSubmit={submit} className="space-y-4 rounded-2xl bg-neutral-50 p-4">
    <div><span className="mb-1.5 block text-xs font-semibold text-neutral-600">Working days</span><div role="group" aria-label="Working days" className="flex flex-wrap gap-1.5">{[1, 2, 3, 4, 5, 6, 7].map((day) => <button key={day} type="button" aria-pressed={days.includes(day)} onClick={() => setDays(toggle(days, day))} className={chip(days.includes(day))}>{DAY_NAMES[day]}</button>)}</div></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Follow up after (working days)"><input type="number" inputMode="numeric" min={1} max={30} value={followUp} onChange={(event) => setFollowUp(event.target.value)} className={inputClass} /></Field>
      <Field label="Answer warm replies within (working hours)"><input type="number" inputMode="numeric" min={1} max={72} value={sla} onChange={(event) => setSla(event.target.value)} className={inputClass} /></Field>
      <Field label="Emails per person per day"><input type="number" inputMode="numeric" min={0} max={1000} value={emails} onChange={(event) => setEmails(event.target.value)} className={inputClass} /></Field>
      <Field label="WhatsApp messages per person per day"><input type="number" inputMode="numeric" min={0} max={1000} value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} className={inputClass} /></Field>
    </div>
    <div><span className="mb-1.5 block text-xs font-semibold text-neutral-600">Channels this venture uses</span><div role="group" aria-label="Channels" className="flex flex-wrap gap-1.5">{SALES_CHANNELS.map((channel) => <button key={channel} type="button" aria-pressed={channels.includes(channel)} onClick={() => setChannels(toggle(channels, channel))} className={chip(channels.includes(channel))}>{CHANNEL_LABEL[channel]}</button>)}</div></div>
    <div>
      <span id="setup-approval" className="mb-1.5 block text-xs font-semibold text-neutral-600">Who approves messages?</span>
      <div role="radiogroup" aria-labelledby="setup-approval" className="grid gap-2 sm:grid-cols-2">{APPROVAL.map((option) => <button key={option.mode} type="button" role="radio" aria-checked={approval === option.mode} onClick={() => setApproval(option.mode)} className={clsx("rounded-xl border p-3 text-left transition-[background-color,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", approval === option.mode ? "border-primary-600 bg-primary-50" : "border-neutral-200 bg-white hover:bg-neutral-50")}><span className={clsx("block text-[13px] font-bold", approval === option.mode ? "text-primary-900" : "text-neutral-800")}>{option.title}</span><span className={clsx("mt-0.5 block text-xs leading-5", approval === option.mode ? "text-primary-800" : "text-neutral-500")}>{option.line}</span></button>)}</div>
    </div>
    <div>
      <span className="mb-1.5 block text-xs font-semibold text-neutral-600">Holidays <span className="font-normal text-neutral-400">· no follow-ups or reply clocks on these days</span></span>
      {holidays.length > 0 ? <ul className="mb-2 flex flex-wrap gap-1.5">{holidays.map((date) => <li key={date} className="inline-flex items-center gap-1 rounded-lg bg-white py-1 pl-2.5 pr-1 text-xs font-semibold text-neutral-700 ring-1 ring-neutral-200"><span className="tnum">{dayLabel(date)}</span><button type="button" aria-label={`Remove ${dayLabel(date)}`} onClick={() => setHolidays(holidays.filter((item) => item !== date))} className="-my-1.5 grid h-10 w-10 place-items-center rounded-md text-neutral-400 sm:my-0 sm:h-6 sm:w-6 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={12} /></button></li>)}</ul> : <p className="mb-2 text-xs text-neutral-500">No holidays set.</p>}
      <div className="flex flex-wrap items-center gap-2"><input type="date" aria-label="Holiday date" value={newHoliday} onChange={(event) => setNewHoliday(event.target.value)} className={clsx(inputClass, "!w-auto min-w-44")} /><button type="button" onClick={addHoliday} className={clsx(secondaryClass, "!min-h-11")}><Plus size={14} />Add</button></div>
    </div>
    <Field label="Time zone"><Select className={inputClass} value={zone} onChange={(event) => setZone(event.target.value)}>{(ZONES.includes(zone) ? ZONES : [zone, ...ZONES]).map((item) => <option key={item} value={item}>{item}</option>)}</Select></Field>
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
    <button disabled={busy} className={primaryClass}><ActionLabel busy={busy} idle={initial.updatedAt ? "Save settings" : "Save these settings"} /></button>
  </form>;
}
