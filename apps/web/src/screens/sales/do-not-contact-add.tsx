"use client";
import { useState } from "react";
import clsx from "clsx";
import { Info } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { addSuppression, type Suppression } from "@/lib/sales-api";

export type DncKind = Suppression["kind"];
export const DNC_KINDS: readonly DncKind[] = ["email", "phone", "domain", "company"];
export const DNC_KIND_LABEL: Record<DncKind, string> = { email: "Email", phone: "Phone", domain: "Domain", company: "Company" };
const PLACEHOLDER: Record<DncKind, string> = { email: "name@company.com", phone: "+91 98765 43210", domain: "company.com", company: "Company name, as it appears on their site" };
const HELP: Record<DncKind, string> = {
  email: "One email address.",
  phone: "One phone number. Spaces and dashes do not matter.",
  domain: "A company's own website domain, without www or @. Shared ones such as gmail.com are refused: add the individual addresses instead.",
  company: "The company name. Every lead with that name is flagged.",
};

/** Drawer to add an entry by hand. Opt-out and hostile replies add theirs automatically. */
export function DoNotContactAdd({ onClose, onAdded }: { onClose: () => void; onAdded: (entry: Suppression) => void }) {
  const [kind, setKind] = useState<DncKind>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!value.trim()) { setError("Enter who or what to add."); return; }
    setBusy(true); setError("");
    try {
      const entry = await addSuppression({ kind, value: value.trim(), reason: reason.trim() });
      toast({ title: "Added to the do-not-contact list", body: entry.value });
      onAdded(entry); onClose();
    } catch (cause) { setError(describeError(cause, "Could not add it. Try again.")); }
    finally { setBusy(false); }
  }

  return <DetailDrawer title="Add to the do-not-contact list" subtitle="For every venture, on every channel." dirty={Boolean(value.trim() || reason.trim())} onClose={onClose}>
    <form onSubmit={submit} className="space-y-5">
      <div role="note" className="flex items-start gap-3 rounded-2xl bg-warning-surface p-4 text-warning-text">
        <Info size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1 text-xs leading-5"><p className="text-[13px] font-bold">This blocks everyone, everywhere</p><p>Once it is on the list, nobody in any venture can call, email, WhatsApp or message anything that matches it, and every matching lead is flagged do-not-contact. Only an admin can take an entry off again.</p></div>
      </div>
      <Field label="What is it?"><Select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as DncKind)}>{DNC_KINDS.map((item) => <option key={item} value={item}>{DNC_KIND_LABEL[item]}</option>)}</Select></Field>
      <div><Field label={DNC_KIND_LABEL[kind]}><input required maxLength={320} value={value} onChange={(event) => setValue(event.target.value)} placeholder={PLACEHOLDER[kind]} inputMode={kind === "phone" ? "tel" : kind === "email" ? "email" : "text"} autoComplete="off" className={inputClass} /></Field><p className="mt-1.5 text-xs leading-5 text-neutral-500">{HELP[kind]}</p></div>
      <Field label="Why? (optional, but it helps the next person)"><textarea maxLength={300} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: asked on a call not to be contacted again." className={clsx(inputClass, "py-3")} /></Field>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} busyText="Adding…" idle="Add to the list" /></button><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button></div>
    </form>
  </DetailDrawer>;
}
