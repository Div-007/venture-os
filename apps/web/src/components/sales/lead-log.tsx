"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { CALL_OUTCOMES, REPLY_TYPES, type Lead } from "@venture-studio/contracts";
import { Check, MessageCircle, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { logActivity } from "@/lib/sales-api";
import { CALL_OUTCOME_LABELS, newRequestId, NotebookPen, Phone, REPLY_TYPE_LABELS, STAGE_LABELS } from "@/components/sales/sales-ui";

export type LogMode = "call" | "reply" | "note";
const REPLY_CHANNELS = [["email", "Email"], ["whatsapp", "WhatsApp"], ["call", "Phone call"], ["linkedin", "LinkedIn"], ["meeting", "In person"]] as const;
type ReplyChannel = (typeof REPLY_CHANNELS)[number][0];
const MODES: readonly { key: LogMode; label: string; short: string; icon: typeof Phone }[] = [
  { key: "call", label: "Log a call", short: "Call", icon: Phone },
  { key: "reply", label: "They replied", short: "Replied", icon: MessageCircle },
  { key: "note", label: "Note", short: "Note", icon: NotebookPen },
];

/** The bar pinned under the drawer: the three things people log most. Choosing one opens the composer in its place. */
export function LeadLogBar({ onPick }: { onPick: (mode: LogMode) => void }) {
  return <div role="group" aria-label="Log what happened" className="grid grid-cols-3 gap-2">
    {MODES.map(({ key, label, short, icon: Icon }, index) => <button key={key} type="button" aria-label={label} onClick={() => onPick(key)} className={clsx(index === 0 ? primaryClass : secondaryClass, "!min-h-11 !gap-1.5 !px-2 !text-[13px] sm:!px-4 sm:!text-sm")}><Icon size={15} /><span className="sm:hidden">{short}</span><span className="max-sm:hidden">{label}</span></button>)}
  </div>;
}

/**
 * Records what just happened in one small panel: a call outcome, a reply from them, or a note. It opens from the bar under the
 * drawer, on the mode that was picked, and goes away when it is done or closed.
 */
export function LeadLog({ lead, mode, onMode, onClose, onLogged, onDirty }: { lead: Lead; mode: LogMode; onMode: (mode: LogMode) => void; onClose: () => void; onLogged: () => void; onDirty: (key: string, dirty: boolean) => void }) {
  const [outcome, setOutcome] = useState<(typeof CALL_OUTCOMES)[number] | "">("");
  const [callNote, setCallNote] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [channel, setChannel] = useState<ReplyChannel>("email");
  const [replyType, setReplyType] = useState<(typeof REPLY_TYPES)[number] | "">("");
  const [replyBody, setReplyBody] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One request id per attempt, so a double tap or a retry never logs the same thing twice.
  const requestId = useRef<string | null>(null);
  useEffect(() => { onDirty("log", !!outcome || !!callNote.trim() || !!replyType || !!replyBody.trim() || !!note.trim()); return () => onDirty("log", false); }, [outcome, callNote, replyType, replyBody, note, onDirty]);

  async function submit(input: Parameters<typeof logActivity>[1], done: string, detail: string) {
    setBusy(true); setError("");
    requestId.current ??= newRequestId();
    try {
      const { lead: updated } = await logActivity(lead.id, { ...input, requestId: requestId.current });
      requestId.current = null;
      const moved = updated.stage !== lead.stage ? ` Now ${STAGE_LABELS[updated.stage].toLowerCase()}.` : "";
      toast({ title: done, body: `${lead.companyName}: ${detail}.${moved}` });
      onLogged(); onClose();
    } catch (cause) { setError(describeError(cause, "Could not save this. Try again.")); }
    finally { setBusy(false); }
  }

  const logCall = (event: React.FormEvent) => {
    event.preventDefault();
    if (!outcome) return;
    void submit({ kind: "call", direction: "out", callOutcome: outcome, body: callNote.trim(), ...(outcome === "call_back" && callbackAt ? { nextActionAt: new Date(callbackAt).toISOString() } : {}) }, "Call logged", CALL_OUTCOME_LABELS[outcome]);
  };
  const logReply = (event: React.FormEvent) => {
    event.preventDefault();
    if (!replyType) { setError("Pick what they said."); return; }
    void submit({ kind: channel, direction: "in", replyType, body: replyBody.trim() }, "Reply logged", REPLY_TYPE_LABELS[replyType]);
  };
  const addNote = (event: React.FormEvent) => {
    event.preventDefault();
    if (!note.trim()) return;
    void submit({ kind: "note", body: note.trim() }, "Note added", "saved to the activity");
  };

  const current = MODES.find((item) => item.key === mode)!;
  const send = clsx(primaryClass, "w-full !min-h-11");
  return <section aria-label={current.label} className="vso-fade-enter grid max-h-[min(72vh,560px)] gap-3 overflow-y-auto overscroll-contain thin-scroll">
    <div className="flex items-center justify-between gap-2">
      <div role="tablist" aria-label="What to log" className="flex min-w-0 gap-1 rounded-xl bg-neutral-100 p-1">
        {MODES.map(({ key, short, icon: Icon }) => <button key={key} type="button" role="tab" aria-selected={mode === key} onClick={() => { onMode(key); setError(""); requestId.current = null; }} className={clsx("inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", mode === key ? "bg-white text-primary-800 shadow-card" : "text-neutral-500 hover:text-neutral-900")}><Icon size={14} />{short}</button>)}
      </div>
      <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.95]"><X size={16} /></button>
    </div>

    {mode === "call" && (lead.doNotContact
      ? <p className="rounded-xl bg-danger-surface p-3 text-xs font-semibold leading-5 text-danger-text">This company is on the do-not-contact list, so calls cannot be logged. Add a note instead.</p>
      : <form onSubmit={logCall} className="grid grid-cols-1 gap-3">
        <div role="group" aria-label="How did the call go" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {CALL_OUTCOMES.map((value) => <button key={value} type="button" aria-pressed={outcome === value} onClick={() => { setOutcome(value); requestId.current = null; }} className={clsx("min-h-10 rounded-xl border px-2.5 py-1.5 text-left text-[13px] font-semibold leading-4 transition-[background-color,border-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]", outcome === value ? "border-primary-300 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50")}>{CALL_OUTCOME_LABELS[value]}</button>)}
        </div>
        {outcome && <div className="vso-fade-enter grid gap-3">
          {outcome === "call_back" && <Field label="Call back at (optional)"><input type="datetime-local" className={inputClass} value={callbackAt} onChange={(event) => setCallbackAt(event.target.value)} /></Field>}
          <textarea aria-label="What was said (optional)" rows={2} maxLength={10_000} className={`${inputClass} py-2.5`} value={callNote} onChange={(event) => setCallNote(event.target.value)} placeholder="What was said (optional): who you spoke to, what they need." />
        </div>}
        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        <button disabled={busy || !outcome} className={send}><ActionLabel busy={busy} idle={<><Check size={15} />Log this call</>} /></button>
      </form>)}

    {mode === "reply" && <form onSubmit={logReply} className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="They replied by"><Select aria-label="They replied by" className={inputClass} value={channel} onChange={(event) => setChannel(event.target.value as ReplyChannel)}>{REPLY_CHANNELS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</Select></Field>
        <Field label="What they said"><Select aria-label="What they said" className={inputClass} value={replyType} onChange={(event) => setReplyType(event.target.value as (typeof REPLY_TYPES)[number])}><option value="">Pick one</option>{REPLY_TYPES.map((value) => <option key={value} value={value}>{REPLY_TYPE_LABELS[value]}</option>)}</Select></Field>
      </div>
      <textarea aria-label="Their words (optional)" rows={2} maxLength={10_000} className={`${inputClass} py-2.5`} value={replyBody} onChange={(event) => setReplyBody(event.target.value)} placeholder="Their words (optional): paste or summarise the reply." />
      {(replyType === "opt_out" || replyType === "hostile") && <p className="rounded-xl bg-warning-surface p-3 text-xs font-semibold leading-5 text-warning-text">This adds the company to the do-not-contact list for every venture and discards any unsent drafts.</p>}
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <button disabled={busy || !replyType} className={send}><ActionLabel busy={busy} idle={<><Check size={15} />Log this reply</>} /></button>
    </form>}

    {mode === "note" && <form onSubmit={addNote} className="grid grid-cols-1 gap-3">
      <textarea aria-label="Note" autoFocus rows={3} maxLength={10_000} required className={`${inputClass} py-2.5`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Anything the next person should know." />
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <button disabled={busy || !note.trim()} className={send}><ActionLabel busy={busy} idle="Add note" /></button>
    </form>}
  </section>;
}
