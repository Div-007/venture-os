"use client";
import { useState } from "react";
import clsx from "clsx";
import type { CALL_OUTCOMES } from "@venture-studio/contracts";
import { ArrowRight, ArrowUpRight, CalendarPlus, ChevronLeft, Clock3, FileText, Info, Sparkles, Timer, X } from "@/components/ui/icons";
import { describeError } from "@/lib/errors";
import { ActionLabel, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import type { LeadDetail, SalesOverview } from "@/lib/sales-api";
import { Phone, PhoneMissed, PhoneOff, UserX, Whatsapp } from "./draft-icons";
import { CALL_OUTCOME_LABEL, CHANNEL_LABEL, kickerClass, OPT_IN_LABEL, plainEmail, routeOf, safeHttp, stamp, telHref } from "./draft-shared";
import { StageChip, VerdictChip, when } from "./sales-ui";
import { PopAvatar } from "./pop-card";
import type { Icon } from "@/components/ui/icons";

export type CallLead = SalesOverview["callsDue"][number];
type Outcome = (typeof CALL_OUTCOMES)[number];
export type CallLogger = (outcome: Outcome, input: { note: string; at?: string }) => Promise<void>;

const OUTCOMES: { outcome: Outcome; label: string; icon: Icon; tone: "primary" | "plain" | "danger"; asks?: "time" | "confirm" }[] = [
  { outcome: "interested_book", label: "Interested, book a call", icon: CalendarPlus, tone: "primary", asks: "time" },
  { outcome: "yes_whatsapp", label: "Yes, WhatsApp me", icon: Whatsapp, tone: "primary" },
  { outcome: "send_details", label: "Send details", icon: FileText, tone: "plain" },
  { outcome: "call_back", label: "Call back later", icon: Clock3, tone: "plain", asks: "time" },
  { outcome: "no_answer", label: "No answer", icon: PhoneMissed, tone: "plain" },
  { outcome: "busy", label: "Busy", icon: Timer, tone: "plain" },
  { outcome: "wrong_person", label: "Wrong person", icon: UserX, tone: "plain" },
  { outcome: "wrong_number", label: "Wrong number", icon: PhoneOff, tone: "plain" },
  { outcome: "not_interested", label: "Not interested", icon: X, tone: "danger", asks: "confirm" },
];
/** What each button does, in one line, so a tap is never a surprise (docs/sales-dealflow.md section 5). */
const EFFECT: Record<Outcome, string> = {
  interested_book: "Moves the lead to Call booked.", send_details: "Marks it replied, next step: send details.", call_back: "Sets a call-back reminder.", no_answer: "Calls again the next working day.", busy: "Calls again the next working day.",
  not_interested: "Closes the lead as lost: not interested on call.", wrong_person: "Next step: find the right person.", wrong_number: "Saved as a note only.", yes_whatsapp: "Records that they said yes to WhatsApp. WhatsApp unlocks for this lead.",
};

const localInput = (date: Date) => { const pad = (n: number) => String(n).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
function quickTimes(now = new Date()) {
  const inHour = new Date(now.getTime() + 3_600_000);
  const tomorrow = (hour: number) => { const date = new Date(now); date.setDate(date.getDate() + 1); date.setHours(hour, 0, 0, 0); return date; };
  return [{ label: "In an hour", value: localInput(inHour) }, { label: "Tomorrow 11 am", value: localInput(tomorrow(11)) }, { label: "Tomorrow 4 pm", value: localInput(tomorrow(16)) }];
}

/** One lead in call mode: who, the number, Claude's opener, and one-tap outcome buttons. */
export function CallCard({ lead, detail, detailError, position, total, canLog, readOnlyNote, onLog, onSkip, onBack, onOpenLead }: {
  /** `readOnlyNote`: why this person cannot log the call (shown instead of the outcome buttons); the learner wording when empty. */
  lead: CallLead; detail: LeadDetail | null; detailError: string; position: number; total: number; canLog: boolean; readOnlyNote?: string;
  onLog: CallLogger; onSkip: () => void; onBack?: (() => void) | undefined; onOpenLead: () => void;
}) {
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState<Outcome | null>(null);
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState<Outcome | "">("");
  const [error, setError] = useState("");

  const full = detail?.lead;
  const phones = lead.contactRoutes.filter((route) => route.kind === "phone" || route.kind === "whatsapp");
  // Only a single plain number gets a Call link; anything else (two numbers, an extension) is shown as text.
  const dialable = phones.map((route) => ({ route, href: telHref(route.value) }));
  const main = dialable.find((entry) => entry.href);
  const others = dialable.filter((entry) => entry !== main);
  const email = routeOf(lead.contactRoutes, "email");
  const emailAddress = email ? plainEmail(email.value) : "";
  const blocked = Boolean(lead.doNotContact || full?.doNotContact);
  const opener = [...(detail?.drafts ?? [])].filter((draft) => draft.channel === "call_opener" && !["vetoed", "discarded"].includes(draft.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const recent = [...(detail?.activities ?? [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
  const optedIn = lead.whatsappOptIn;
  const meta = [lead.city, full?.category, lead.contactName && `Ask for ${lead.contactName}`].filter(Boolean).join(" · ");
  const buttons = OUTCOMES.filter((item) => !(item.outcome === "yes_whatsapp" && optedIn));

  async function log(outcome: Outcome, atValue?: string) {
    setBusy(outcome); setError("");
    try { await onLog(outcome, { note, ...(atValue ? { at: new Date(atValue).toISOString() } : {}) }); }
    catch (cause) { setError(describeError(cause, "Could not log the call. Try again.")); }
    finally { setBusy(""); }
  }
  function choose(item: (typeof OUTCOMES)[number]) {
    setError("");
    if (item.asks) { setAsking(asking === item.outcome ? null : item.outcome); setAt(""); return; }
    void log(item.outcome);
  }
  const askedItem = OUTCOMES.find((item) => item.outcome === asking);

  return <div className="vso-fade-enter space-y-5">
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className={kickerClass}>Call {position} of {total}</span>
        <span className="flex items-center gap-1">
          {onBack && <button type="button" onClick={onBack} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><ChevronLeft size={14} />Back</button>}
          <button type="button" onClick={onSkip} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Skip<ArrowRight size={14} /></button>
        </span>
      </div>
      <div role="progressbar" aria-label="Calls done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={position - 1} className="h-1.5 overflow-hidden rounded-full bg-neutral-100"><div className="h-full rounded-full bg-primary-600 transition-[width] duration-300" style={{ width: `${Math.round(((position - 1) / Math.max(1, total)) * 100)}%` }} /></div>
    </div>

    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <PopAvatar name={lead.companyName} size="lg" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[1.65rem] font-extrabold leading-tight tracking-[-.03em] text-neutral-900 [overflow-wrap:anywhere]">{lead.companyName}</h2>
          {meta && <p className="mt-1 text-sm font-medium text-neutral-500">{meta}</p>}
        </div>
        <button type="button" onClick={onOpenLead} aria-label={`Open ${lead.companyName}`} title="Open the lead" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-400 transition-[background-color,color] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><ArrowUpRight size={18} /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5"><StageChip stage={lead.stage} /><VerdictChip verdict={lead.verdict} />{optedIn && <span className="inline-flex items-center gap-1 rounded-md bg-success-surface px-2 py-1 text-[11px] font-semibold text-success-text"><Whatsapp size={12} />WhatsApp OK</span>}</div>
    </div>

    {blocked
      ? <div role="note" className="space-y-1.5 rounded-2xl bg-danger-surface p-4 text-danger-text">
        <p className="text-sm font-bold">On the do-not-contact list</p>
        <p className="text-xs leading-5">{lead.companyName} asked not to be contacted, or matched the list. Do not call, write or message them. Skip to the next call.</p>
      </div>
      : main
        ? <div className="space-y-2">
          <a href={main.href} className={clsx(primaryClass, "!min-h-14 w-full !rounded-2xl !text-base")}><Phone size={20} />Call {main.route.value}</a>
          <p className="text-xs text-neutral-500">{main.route.label || (main.route.publishedByCompany ? "Business number from their own site" : "Number on file")}{main.route.sourceUrl && safeHttp(main.route.sourceUrl) ? <> · <a href={main.route.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary-700 underline underline-offset-2">where we saw it</a></> : null}{others.length > 0 && <> · also {others.map((entry, index) => <span key={entry.route.value}>{index > 0 && ", "}{entry.href ? <a href={entry.href} className="font-semibold text-primary-700 underline underline-offset-2">{entry.route.value}</a> : entry.route.value}</span>)}</>}</p>
        </div>
        : <div className="space-y-2 rounded-2xl bg-warning-surface p-4 text-warning-text">
          <p className="text-sm font-bold">{phones.length ? "No number that can be dialled" : "No phone number on file"}</p>
          <p className="text-xs leading-5">{phones.length ? <>The number on file ({phones.map((route) => route.value).join(", ")}) is not a single plain number.</> : null} Try another way in, or skip to the next call.{emailAddress ? <> Their email is <a href={`mailto:${emailAddress}`} className="font-semibold underline underline-offset-2">{emailAddress}</a>.</> : email ? <> Their email on file is {email.value}.</> : null}</p>
        </div>}

    {(lead.why || full?.observedSignal || lead.verdict?.summary || lead.nextAction) && <div className="space-y-1.5 rounded-2xl bg-neutral-50 p-4">
      <span className={kickerClass}>Why this call</span>
      {lead.why && <p className="text-[13px] leading-6 text-neutral-800 [overflow-wrap:anywhere]">{lead.why}</p>}
      {full?.observedSignal && !lead.why.includes(full.observedSignal) && <p className="border-l-2 border-primary-300 pl-2.5 text-[13px] leading-6 text-neutral-700 [overflow-wrap:anywhere]">&ldquo;{full.observedSignal}&rdquo;</p>}
      {lead.verdict?.summary && <p className="text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">Claude: {lead.verdict.summary}</p>}
      {lead.nextAction && <p className="text-xs leading-5 text-neutral-500">Next step on file: {lead.nextAction}{lead.nextActionAt ? ` · ${when(lead.nextActionAt)}` : ""}</p>}
      {optedIn && <p className="text-xs font-semibold text-success-text">WhatsApp OK: {OPT_IN_LABEL[optedIn.how].toLowerCase()}.</p>}
    </div>}

    <div className="space-y-2 rounded-2xl border border-primary-200 bg-primary-50 p-4">
      <span className="flex items-center gap-2 text-xs font-bold text-primary-800"><Sparkles size={14} />Claude&apos;s opener</span>
      {opener ? <p className="whitespace-pre-wrap text-sm leading-7 text-neutral-900 [overflow-wrap:anywhere]">{opener.body}</p>
        : !detail && !detailError ? <span role="status" aria-label="Loading the opener" className="vso-skeleton block h-16 rounded-xl" />
          : <p className="text-[13px] leading-6 text-primary-900">{detailError ? `Could not load the opener. ${detailError}` : "No opener written yet. Ask Claude: “write call openers for my calls today”. Meanwhile: say who you are in one line, name the signal above, and ask one question."}</p>}
    </div>

    {recent.length > 0 && <div className="space-y-1.5"><span className={kickerClass}>Earlier</span><ul className="space-y-1">{recent.map((entry) => <li key={entry.id} className="text-xs leading-5 text-neutral-600"><b className="font-semibold text-neutral-700">{CHANNEL_LABEL[entry.kind] ?? entry.kind} {entry.direction === "in" ? "from them" : "from us"}</b>{entry.callOutcome ? `: ${CALL_OUTCOME_LABEL[entry.callOutcome]}` : ""} · {stamp(entry.at)}{entry.body ? ` · ${entry.body.length > 90 ? `${entry.body.slice(0, 89)}…` : entry.body}` : ""}</li>)}</ul></div>}

    {canLog && !blocked ? <div className="space-y-3 border-t border-neutral-100 pt-5">
      <span className={kickerClass}>How did it go?</span>
      <Field label="Notes, in their words (optional)"><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={10000} rows={2} placeholder="Orders come on WhatsApp from 40 shops; rates change monthly…" className={clsx(inputClass, "py-3")} /></Field>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">{buttons.map((item) => {
        const ItemIcon = item.icon;
        const active = asking === item.outcome;
        return <button key={item.outcome} type="button" disabled={busy !== ""} onClick={() => choose(item)} aria-pressed={item.asks ? active : undefined} className={clsx("flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-2 text-center text-[13px] font-bold leading-tight transition-[background-color,border-color,transform,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] disabled:opacity-50 sm:min-h-[72px]",
          item.tone === "primary" ? (active ? "border-primary-700 bg-primary-700 text-white" : "border-primary-200 bg-primary-50 text-primary-900 hover:bg-primary-100")
            : item.tone === "danger" ? (active ? "border-danger bg-danger text-white" : "border-danger-surface bg-danger-surface text-danger-text hover:brightness-95")
              : (active ? "border-neutral-700 bg-neutral-700 text-white" : "border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50"))}>
          {busy === item.outcome ? <span aria-hidden="true" className="vso-spinner h-4 w-4" /> : <ItemIcon size={18} aria-hidden="true" />}{item.label}</button>;
      })}</div>

      {askedItem && <div className="vso-fade-enter space-y-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
        {askedItem.asks === "time" ? <>
          <p className="text-sm font-bold text-neutral-900">{askedItem.outcome === "interested_book" ? "When is the call?" : "When should you call back?"} <span className="font-normal text-neutral-500">(optional)</span></p>
          <div className="flex flex-wrap gap-2">{quickTimes().map((choice) => <button key={choice.label} type="button" onClick={() => setAt(choice.value)} aria-pressed={at === choice.value} className={clsx("min-h-10 rounded-xl border px-3 text-xs font-semibold transition-[background-color,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", at === choice.value ? "border-primary-600 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50")}>{choice.label}</button>)}</div>
          <input type="datetime-local" aria-label="Date and time" value={at} onChange={(event) => setAt(event.target.value)} className={inputClass} />
          <p className="text-xs leading-5 text-neutral-500">{EFFECT[askedItem.outcome]}{askedItem.outcome === "call_back" ? " Leave the time empty to call back the next working day." : ""}</p>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy !== ""} onClick={() => void log(askedItem.outcome, at)} className={primaryClass}><ActionLabel busy={busy === askedItem.outcome} idle={`Save and go to the next call`} /></button><button type="button" onClick={() => setAsking(null)} className={secondaryClass}>Cancel</button></div>
        </> : <>
          <p className="text-sm font-bold text-neutral-900">Close {lead.companyName} as lost?</p>
          <p className="text-xs leading-5 text-neutral-500">{EFFECT[askedItem.outcome]} You can still reopen it from the lead.</p>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy !== ""} onClick={() => void log("not_interested")} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50"><ActionLabel busy={busy === "not_interested"} busyText="Saving…" idle="Yes, not interested" /></button><button type="button" onClick={() => setAsking(null)} className={secondaryClass}>Cancel</button></div>
        </>}
      </div>}
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <p className="flex items-start gap-2 text-xs leading-5 text-neutral-500"><Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />Each button logs the call and sets the next step. The next lead opens by itself.</p>
    </div> : <p className="flex items-start gap-2 border-t border-neutral-100 pt-4 text-xs leading-5 text-neutral-500"><Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{blocked ? "There is nothing to log: this company is not to be contacted." : readOnlyNote || "You can look at the calls. A contributor or venture head makes and logs them."}</p>}
  </div>;
}
