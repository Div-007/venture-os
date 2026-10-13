"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { Lead, Verdict } from "@venture-studio/contracts";
import { Check, CircleAlert, LinkIcon, Sparkles } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Badge, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { overrideVerdict } from "@/lib/sales-api";
import { absoluteDate, hostOf, safeUrl, timeAgo, type Tone } from "@/components/sales/sales-ui";

const DECISION_WORD = { recommend: "go", hold: "hold", reject: "no" } as const;
const DECISION_TONE: Record<Verdict["decision"], Tone> = { recommend: "green", hold: "amber", reject: "red" };
const SCORE_LABELS = [["fit", "Fit"], ["need", "Need"], ["access", "Access"], ["ability", "Ability"], ["timing", "Timing"]] as const;
const GATE_TONE: Record<string, Tone> = { pass: "green", fail: "red", unknown: "neutral" };

const label = "text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400";

function Dots({ value }: { value: number }) {
  return <span className="inline-flex items-center gap-0.5" aria-hidden="true">{[1, 2, 3].map((step) => <span key={step} className={clsx("h-1.5 w-3 rounded-full", step <= value ? "bg-primary-600" : "bg-neutral-200")} />)}</span>;
}

/** Claude's verdict on a lead: decision, evidence with sources, the case against, and a person's override. */
export function LeadVerdict({ lead, verdicts, canEdit, personName, onChanged, onDirty }: {
  lead: Lead; verdicts: Verdict[]; canEdit: boolean; personName: (id: string) => string; onChanged: () => void; onDirty: (key: string, dirty: boolean) => void;
}) {
  const sorted = [...verdicts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const verdict = sorted[0];
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] = useState<Verdict["decision"]>("recommend");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { onDirty("override", editing && reason.trim().length > 0); return () => onDirty("override", false); }, [editing, reason, onDirty]);

  if (!verdict) {
    return <section aria-label="Claude's verdict" className="rounded-2xl border border-dashed border-neutral-200 p-4">
      <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-xl bg-ai-surface text-ai-text"><Sparkles size={15} /></span><div><p className="text-sm font-bold text-neutral-900">Claude has not judged this lead yet</p><p className="mt-0.5 text-xs leading-5 text-neutral-500">Ask Claude in your chat to research {lead.companyName}. The verdict, quotes and sources will show here.</p></div></div>
      {lead.needsYou && <p className="mt-3 rounded-xl bg-warning-surface p-3 text-xs font-semibold text-warning-text">This lead is waiting for your decision.</p>}
    </section>;
  }

  const effective = verdict.override?.decision ?? verdict.decision;
  const changed = !!verdict.override;
  const scores = SCORE_LABELS.filter(([key]) => verdict.scores[key] != null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) { setError("Say why in a few words."); return; }
    setBusy(true); setError("");
    try {
      await overrideVerdict(verdict!.id, { decision, reason: reason.trim() });
      toast({ title: "Verdict changed", body: `${lead.companyName}: ${DECISION_WORD[decision]}` });
      setEditing(false); setReason("");
      onChanged();
    } catch (cause) { setError(describeError(cause, "Could not change the verdict.")); }
    finally { setBusy(false); }
  }

  return <section aria-label="Claude's verdict" className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-card">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-ai-surface text-ai-text"><Sparkles size={15} /></span><span className="text-sm font-bold text-neutral-900">{changed ? `Now: ${DECISION_WORD[effective]}` : `Claude says ${DECISION_WORD[effective]}`}</span></span>
      <span className="flex flex-wrap items-center gap-1.5"><Badge tone={DECISION_TONE[effective]}>{effective === "recommend" ? "Go" : effective === "hold" ? "Hold" : "No"}</Badge><Badge>{verdict.confidence} confidence</Badge></span>
    </div>
    {lead.needsYou && <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-surface p-3 text-xs font-semibold leading-5 text-warning-text"><CircleAlert size={15} className="mt-0.5 shrink-0" />Claude is not sure. Read the evidence and the case against, then decide.</p>}
    <p className="mt-3 text-sm font-semibold leading-6 text-neutral-800">{verdict.summary}</p>
    {changed && <p className="mt-2 rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">Claude said <strong className="text-neutral-800">{DECISION_WORD[verdict.decision]}</strong>. {personName(verdict.override!.by)} changed it to <strong className="text-neutral-800">{DECISION_WORD[verdict.override!.decision]}</strong> on {absoluteDate(verdict.override!.at)}: {verdict.override!.reason}</p>}

    <dl className="mt-4 grid gap-3 text-sm">
      <div><dt className={label}>Offer fit</dt><dd className="mt-1 leading-6 text-neutral-700"><strong className="text-neutral-800">{verdict.offer}.</strong> {verdict.offerFit}</dd></div>
      {scores.length > 0 && <div><dt className={label}>Scores</dt><dd className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">{scores.map(([key, name]) => <span key={key} className="flex items-center justify-between gap-2 text-xs font-semibold text-neutral-600"><span>{name}</span><span className="flex items-center gap-1.5"><Dots value={verdict.scores[key]!} /><span className="sr-only">{verdict.scores[key]} of 3</span></span></span>)}</dd></div>}
      {verdict.gates.length > 0 && <div><dt className={label}>Checks</dt><dd className="mt-1.5 flex flex-wrap gap-1.5">{verdict.gates.map((gate) => <span key={gate.gate} title={gate.note || undefined}><Badge tone={GATE_TONE[gate.result] ?? "neutral"}>{gate.gate} · {gate.result}</Badge></span>)}</dd>{verdict.gates.some((gate) => gate.result !== "pass" && gate.note) && <ul className="mt-2 grid gap-1 text-xs leading-5 text-neutral-500">{verdict.gates.filter((gate) => gate.result !== "pass" && gate.note).map((gate) => <li key={gate.gate}><strong className="font-semibold text-neutral-700">{gate.gate}:</strong> {gate.note}</li>)}</ul>}</div>}
    </dl>

    <div className="mt-4">
      <p className={label}>Evidence</p>
      <ul className="mt-2 grid gap-3">{verdict.evidence.map((item, index) => {
        const url = safeUrl(item.url);
        return <li key={`${item.url}-${index}`} className="rounded-xl bg-neutral-50 p-3">
          <p className="text-xs font-semibold leading-5 text-neutral-700">{item.claim}</p>
          <blockquote className="mt-1.5 border-l-2 border-primary-300 pl-3 text-sm italic leading-6 text-neutral-600">“{item.quote}”</blockquote>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] font-semibold text-neutral-400">{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><LinkIcon size={12} />{hostOf(url)}</a> : <span>{item.url}</span>}{item.seenAt && <span>seen {absoluteDate(item.seenAt).split(",")[0]}</span>}</p>
        </li>;
      })}</ul>
    </div>

    <div className="mt-4 grid gap-3">
      <div className="rounded-xl bg-danger-surface p-3"><p className="text-[11px] font-semibold uppercase tracking-[.08em] text-danger-text">Case against</p><p className="mt-1 text-sm leading-6 text-danger-text">{verdict.against}</p></div>
      {verdict.openQuestion && <div><p className={label}>Open question</p><p className="mt-1 text-sm leading-6 text-neutral-700">{verdict.openQuestion}</p></div>}
      {verdict.signal && <div><p className={label}>Signal to open with</p><p className="mt-1 text-sm leading-6 text-neutral-700">{verdict.signal}</p></div>}
      {verdict.contactRoute && <div><p className={label}>Best way in</p><p className="mt-1 text-sm leading-6 text-neutral-700">{verdict.contactRoute}</p></div>}
    </div>

    <p className="mt-4 text-[11px] font-medium text-neutral-400" title={absoluteDate(verdict.createdAt)}>Judged {timeAgo(verdict.createdAt)} by {verdict.via === "claude" ? "Claude" : personName(verdict.createdBy)}{sorted.length > 1 ? ` · ${sorted.length - 1} earlier verdict${sorted.length === 2 ? "" : "s"}` : ""}</p>

    {canEdit && !editing && <button type="button" onClick={() => { setDecision(effective); setEditing(true); }} className={clsx(secondaryClass, "mt-3 w-full sm:w-auto")}>Change the verdict</button>}
    {editing && <form onSubmit={save} className="mt-4 grid gap-3 rounded-xl border border-neutral-200 p-3">
      <Field label="Your decision"><Select aria-label="Your decision" className={inputClass} value={decision} onChange={(event) => setDecision(event.target.value as Verdict["decision"])}><option value="recommend">Go: contact them</option><option value="hold">Hold: not yet</option><option value="reject">No: not a fit</option></Select></Field>
      <Field label="Why"><textarea required minLength={3} maxLength={1000} rows={3} className={`${inputClass} py-2.5`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="One or two sentences. This is saved with the verdict." /></Field>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy || reason.trim().length < 3} className={primaryClass}><ActionLabel busy={busy} idle={<><Check size={15} />Save decision</>} /></button><button type="button" onClick={() => { setEditing(false); setReason(""); setError(""); }} className={secondaryClass}>Cancel</button></div>
    </form>}
  </section>;
}
