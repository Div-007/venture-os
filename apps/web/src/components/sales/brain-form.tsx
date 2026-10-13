"use client";
import { useState } from "react";
import clsx from "clsx";
import { BRAIN_KINDS, type BrainItem } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { proposeBrainItem, updateBrainItem } from "@/lib/sales-api";
import { useSalesShell } from "./sales-context";

export type BrainKind = (typeof BRAIN_KINDS)[number];
export const KIND_LABEL: Record<BrainKind, string> = { offer: "Offer", target_profile: "Target profile", message_rules: "Message rules", venture_settings: "Venture settings", notes: "Notes" };
/** One line per kind: what it is for. Shown in empty groups and in the proposal form. */
export const KIND_HINT: Record<BrainKind, string> = {
  offer: "What we sell, who it is for, what is included and the price rules. Claude uses it to judge fit and to write messages.",
  target_profile: "Who we sell to, the signals that matter and the hard no's. Claude judges every lead against it.",
  message_rules: "How we write: language, length, what to say, what never to say and the one ask. Claude checks every draft against it.",
  venture_settings: "Working limits for this venture: daily numbers, hours and owners. Claude respects them.",
  notes: "What we learned: what worked, what did not and what the founders decided. Claude reads them as context.",
};
const BODY_HINT: Record<BrainKind, string> = {
  offer: "## What we sell\nOne plain sentence.\n\n## Who it is for\n\n## What is included\n\n## Price rules\nRange only. Never a bare number before the written scope.",
  target_profile: "## Good fit\n- Owner-led distributors with a visible dealer signal\n\n## Not a fit\n- National brands\n\n## Signals to look for\n",
  message_rules: "- Language: Hinglish for owners, English for companies that write in English\n- Under 100 words\n- One ask: a 20-minute call\n- Never promise results",
  venture_settings: "- Calls a day per person: 15\n- Emails a day per mailbox: 20\n- Owner of replies: Divyansh",
  notes: "",
};

/** What the drawer opens with: a new proposal (optionally prefilled from an approved item), or an existing draft to edit. */
/** `template`: the text is a starting point for a new item (title editable, kind fixed), not a change to an approved one. */
export type BrainFormTarget = { mode: "propose"; kind?: BrainKind; title?: string; body?: string; template?: boolean } | { mode: "edit"; item: BrainItem };

/**
 * Drawer to propose a change to the brain, or edit a pending proposal. Nothing changes what Claude does until a venture head approves it.
 * `kinds` limits what a new item can be (the Offers page offers only the shared kinds: notes and venture settings).
 */
export function BrainForm({ ventureId, target, kinds = BRAIN_KINDS, onClose, onSaved }: { ventureId: string; target: BrainFormTarget; kinds?: readonly BrainKind[]; onClose: () => void; onSaved: (item: BrainItem) => void }) {
  const { ventureName } = useSalesShell();
  const editing = target.mode === "edit";
  const [initial] = useState(() => editing ? { kind: target.item.kind as BrainKind, title: target.item.title, body: target.item.body } : { kind: target.kind ?? kinds[0] ?? "notes", title: target.title ?? "", body: target.body ?? "" });
  const [kind, setKind] = useState<BrainKind>(initial.kind);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = kind !== initial.kind || title !== initial.title || body !== initial.body;
  const replacing = !editing && Boolean(target.title) && !(target.mode === "propose" && target.template);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) { setError("Give it a short title."); return; }
    if (!body.trim()) { setError("Write what Claude should know."); return; }
    setBusy(true); setError("");
    try {
      const saved = target.mode === "edit" ? await updateBrainItem(target.item.id, { title: title.trim(), body: body.trim() }) : await proposeBrainItem({ ventureId, kind, title: title.trim(), body: body.trim() });
      toast({ title: target.mode === "edit" ? "Proposal saved" : "Change proposed", body: `${saved.title}. A venture head approves it before Claude uses it.` });
      onSaved(saved); onClose();
    } catch (cause) { setError(describeError(cause, "Could not save. Try again.")); }
    finally { setBusy(false); }
  }

  return <DetailDrawer title={editing ? "Edit proposal" : replacing ? "Propose a change" : target.mode === "propose" && target.template ? `Propose the ${KIND_LABEL[kind].toLowerCase()}` : "Propose something new"} subtitle={`${ventureName(ventureId)} · ${KIND_LABEL[kind]}`} dirty={dirty} onClose={onClose}>
    <form onSubmit={submit} className="space-y-4">
      <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">Claude uses only approved text. Your proposal waits for a venture head, who approves it on this page.{replacing ? " Keep the same title: approving it replaces the current version, which is kept in the history." : ""}</p>
      <Field label="What is it about?"><Select className={inputClass} disabled={editing || replacing || (target.mode === "propose" && Boolean(target.template))} value={kind} onChange={(event) => setKind(event.target.value as BrainKind)}>{(kinds.includes(kind) ? kinds : [kind, ...kinds]).map((item) => <option key={item} value={item}>{KIND_LABEL[item]}</option>)}</Select></Field>
      <p className="-mt-2 text-xs leading-5 text-neutral-500">{KIND_HINT[kind]}</p>
      <Field label="Title"><input required maxLength={160} value={title} readOnly={replacing} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "offer" ? "Dealer catalogue and orders" : KIND_LABEL[kind]} className={clsx(inputClass, replacing && "bg-neutral-50")} /></Field>
      <Field label="Text (Markdown works)"><textarea required maxLength={20000} rows={16} value={body} onChange={(event) => setBody(event.target.value)} placeholder={BODY_HINT[kind]} className={clsx(inputClass, "py-3 font-mono text-[13px] leading-6")} /></Field>
      <p className="-mt-2 text-right text-[11px] tabular-nums text-neutral-400">{body.length.toLocaleString("en-IN")} / 20,000</p>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} busyText="Saving…" idle={editing ? "Save proposal" : "Propose for approval"} /></button><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button></div>
    </form>
  </DetailDrawer>;
}
