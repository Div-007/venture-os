"use client";
import { useState } from "react";
import clsx from "clsx";
import { LOST_REASONS, type Lead, type LostReason } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { ActionLabel, DetailDrawer, Field, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { LOST_REASON_LABELS } from "@/components/sales/sales-ui";

type Exit = "lost" | "disqualified";
const CHOICES: { value: Exit; title: string; body: string }[] = [
  { value: "lost", title: "Lost", body: "They said no, went quiet, or chose someone else." },
  { value: "disqualified", title: "Not a fit", body: "We should not pursue them: wrong size, wrong place, or they asked us to stop." },
];

/** Closing a lead needs a reason, so dropping a card on Closed asks first. */
export function PipelineClose({ lead, onCancel, onConfirm }: { lead: Lead; onCancel: () => void; onConfirm: (stage: Exit, reason: string, lostReason?: LostReason) => Promise<void> }) {
  const [stage, setStage] = useState<Exit>("lost");
  const [reason, setReason] = useState("");
  const [lostReason, setLostReason] = useState<LostReason | "">("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    await onConfirm(stage, reason.trim(), stage === "lost" && lostReason ? lostReason : undefined);
    setBusy(false);
  }
  return <DetailDrawer title={`Close ${lead.companyName}`} subtitle="Closed leads leave the board and keep their history." onClose={onCancel} dirty={reason.trim().length > 0}>
    <form onSubmit={submit} className="grid grid-cols-1 gap-4">
      <div role="radiogroup" aria-label="Why is it closed" className="grid grid-cols-1 gap-2.5">
        {CHOICES.map((choice) => <button key={choice.value} type="button" role="radio" aria-checked={stage === choice.value} onClick={() => setStage(choice.value)} className={clsx("rounded-xl border p-3.5 text-left transition-[background-color,border-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]", stage === choice.value ? "border-primary-400 bg-primary-50" : "border-neutral-200 bg-white hover:bg-neutral-50")}><span className="block text-sm font-bold text-neutral-900">{choice.title}</span><span className="mt-0.5 block text-xs leading-5 text-neutral-500">{choice.body}</span></button>)}
      </div>
      {stage === "lost" && <Field label="Main reason"><Select aria-label="Main reason it was lost" className={inputClass} value={lostReason} onChange={(event) => setLostReason(event.target.value as LostReason)}><option value="" disabled>Pick one</option>{LOST_REASONS.map((value) => <option key={value} value={value}>{LOST_REASON_LABELS[value]}</option>)}</Select></Field>}
      <Field label={stage === "lost" ? "In a line" : "Reason"}><input autoFocus required minLength={2} maxLength={500} className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="One line, for the record" /></Field>
      <div className="flex flex-wrap gap-2"><button disabled={busy || reason.trim().length < 2 || (stage === "lost" && !lostReason)} className={primaryClass}><ActionLabel busy={busy} busyText="Closing…" idle="Close this lead" /></button><button type="button" onClick={onCancel} className={secondaryClass}>Cancel</button></div>
    </form>
  </DetailDrawer>;
}
