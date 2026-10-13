"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import type { Activity, Lead } from "@venture-studio/contracts";
import { Check, MessageCircle } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { recordWhatsappOptIn } from "@/lib/sales-api";
import { absoluteDate, Lock, OPT_IN_LABELS, snippet, timeAgo } from "@/components/sales/sales-ui";

type How = "yes_on_call" | "yes_by_email";

/**
 * WhatsApp consent is a person's decision, never Claude's. This shows the current consent, asks the owner to confirm
 * what Claude logged ("they said yes", or a WhatsApp message from them), or lets a person record consent themselves.
 * Learners and do-not-contact leads get no actions.
 */
export function LeadConsent({ lead, activities, canEdit, personName, onChanged }: { lead: Lead; activities: Activity[]; canEdit: boolean; personName: (id: string) => string; onChanged: () => void }) {
  const [recording, setRecording] = useState(false);
  const [how, setHow] = useState<How>("yes_on_call");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The newest thing Claude logged that would open WhatsApp if a person agrees with it.
  const pending = useMemo(() => {
    if (lead.whatsappOptIn) return undefined;
    const claudeLogged = activities.filter((activity) => activity.via === "claude" && ((activity.kind === "call" && activity.callOutcome === "yes_whatsapp") || (activity.kind === "whatsapp" && activity.direction === "in")));
    const latest = [...claudeLogged].sort((a, b) => b.at.localeCompare(a.at))[0];
    return latest ? { activity: latest, how: latest.kind === "call" ? "yes_on_call" as const : "they_messaged" as const } : undefined;
  }, [activities, lead.whatsappOptIn]);

  async function record(input: Parameters<typeof recordWhatsappOptIn>[1]) {
    setBusy(true); setError("");
    try {
      await recordWhatsappOptIn(lead.id, input);
      toast({ title: "WhatsApp consent recorded", body: `${lead.companyName}: ${OPT_IN_LABELS[input.how]?.toLowerCase() ?? "opted in"}. WhatsApp is open.` });
      setRecording(false);
      onChanged();
    } catch (cause) { setError(describeError(cause, "Could not record consent. Try again.")); }
    finally { setBusy(false); }
  }

  if (lead.whatsappOptIn) {
    return <p className="flex items-start gap-2 text-xs leading-5 text-neutral-500"><MessageCircle size={13} className="mt-0.5 shrink-0 text-primary-700" />WhatsApp is open: {OPT_IN_LABELS[lead.whatsappOptIn.how]?.toLowerCase() ?? "they opted in"} (recorded by {personName(lead.whatsappOptIn.by)} on {absoluteDate(lead.whatsappOptIn.at).split(",")[0]}).</p>;
  }

  const hint = <p className="flex items-start gap-2 text-xs leading-5 text-neutral-500"><Lock size={13} className="mt-0.5 shrink-0" />WhatsApp opens after they message us or say yes on a call, and a person confirms it here.</p>;
  if (!canEdit || lead.doNotContact) return hint;

  if (pending) {
    const call = pending.activity.kind === "call";
    return <div className="grid gap-2.5">
      {hint}
      <div className="rounded-xl bg-warning-surface p-3.5">
        <p className="text-sm font-semibold leading-5 text-warning-text">{call ? "Claude logged that they said yes to WhatsApp. Confirm?" : "Claude logged a WhatsApp message from them. Confirm that they opted in?"}</p>
        <p className="mt-1 text-xs leading-5 text-warning-text/90" title={absoluteDate(pending.activity.at)}>{pending.activity.body ? `“${snippet(pending.activity.body, 140)}” · ` : ""}{timeAgo(pending.activity.at)}. WhatsApp stays closed until you confirm.</p>
        <Notice tone="error" message={error} onDismiss={() => setError("")} className="mt-2" />
        <button type="button" disabled={busy} onClick={() => void record({ how: pending.how, activityId: pending.activity.id })} className={clsx(primaryClass, "mt-3 !min-h-11 w-full sm:w-auto")}><ActionLabel busy={busy} busyText="Confirming…" idle={<><Check size={15} />Confirm: they agreed</>} /></button>
      </div>
    </div>;
  }

  return <div className="grid gap-2.5">
    {hint}
    {!recording
      ? <button type="button" onClick={() => setRecording(true)} className={clsx(secondaryClass, "!min-h-10 justify-self-start !px-3 !text-xs sm:!min-h-9")}>Record WhatsApp consent</button>
      : <div className="vso-fade-enter grid gap-3 rounded-xl border border-neutral-200 p-3.5">
        <label className="block"><span className="mb-1.5 block text-xs font-semibold text-neutral-600">How did they agree?</span><Select aria-label="How did they agree" className={inputClass} value={how} onChange={(event) => setHow(event.target.value as How)}><option value="yes_on_call">They said yes on a call</option><option value="yes_by_email">They said yes by email</option></Select></label>
        <p className="text-xs leading-5 text-neutral-500">Only record this if they clearly agreed to be messaged on WhatsApp. It is saved with your name and today&apos;s date, and it opens WhatsApp for this company.</p>
        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void record({ how })} className={primaryClass}><ActionLabel busy={busy} busyText="Saving…" idle="Yes, they agreed" /></button><button type="button" onClick={() => { setRecording(false); setError(""); }} className={secondaryClass}>Cancel</button></div>
      </div>}
  </div>;
}
