"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { EXIT_STAGES, SALES_STAGES, type Lead, type LostReason, type SalesStage } from "@venture-studio/contracts";
import { Check, Edit } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { updateLead } from "@/lib/sales-api";
import type { SalesMember } from "@/components/sales/overview-context";
import { CalendarClock, isOverdue, isWonStage, LOST_REASON_LABELS, LOST_REASONS, PersonChip, STAGE_LABELS, StageChip, toLocalInput, when } from "@/components/sales/sales-ui";

/**
 * The one quiet line under the lead's name: "Next: Call again · Tomorrow 10:00". For a person who may edit, it is a button that
 * turns into a small inline form (what, when, Save, Cancel); nobody sees an empty field until they choose to change it.
 */
export function LeadNextAction({ lead, canEdit, onSaved, onDirty }: { lead: Lead; canEdit: boolean; onSaved: () => void; onDirty: (key: string, dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState(lead.nextAction);
  const [at, setAt] = useState(toLocalInput(lead.nextActionAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const dirty = editing && (action.trim() !== lead.nextAction.trim() || at !== toLocalInput(lead.nextActionAt));
  useEffect(() => { onDirty("next", dirty); return () => onDirty("next", false); }, [dirty, onDirty]);

  const overdue = isOverdue(lead.nextActionAt);
  const text = lead.nextAction || lead.nextActionAt ? `Next: ${lead.nextAction || "Follow up"}${lead.nextActionAt ? ` · ${when(lead.nextActionAt)}` : ""}` : "";

  function open() { setAction(lead.nextAction); setAt(toLocalInput(lead.nextActionAt)); setError(""); setEditing(true); }
  function close() { setEditing(false); setError(""); requestAnimationFrame(() => opener.current?.focus()); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await updateLead(lead.id, { nextAction: action.trim(), nextActionAt: at ? new Date(at).toISOString() : null });
      toast({ title: "Next step saved", body: `${lead.companyName}: ${action.trim() || "cleared"}` });
      setEditing(false); onSaved();
    } catch (cause) { setError(describeError(cause, "Could not save the next step.")); }
    finally { setBusy(false); }
  }

  if (editing) {
    return <form onSubmit={save} className="vso-fade-enter grid gap-3 rounded-xl border border-neutral-200 bg-white p-3">
      <Field label="What happens next"><input autoFocus maxLength={1000} className={inputClass} value={action} onChange={(event) => setAction(event.target.value)} placeholder="Call back, send details, check the website…" /></Field>
      <Field label="When"><input type="datetime-local" className={inputClass} value={at} onChange={(event) => setAt(event.target.value)} /></Field>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2">
        <button disabled={!dirty || busy} className={clsx(primaryClass, "flex-1 sm:flex-none")}><ActionLabel busy={busy} idle={<><Check size={15} />Save</>} /></button>
        <button type="button" onClick={close} className={clsx(secondaryClass, "flex-1 sm:flex-none")}>Cancel</button>
      </div>
    </form>;
  }
  const look = clsx("inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg text-[13px] font-semibold [overflow-wrap:anywhere]", overdue ? "text-danger-text" : text ? "text-neutral-600" : "text-neutral-400");
  const icon = <CalendarClock size={14} className="shrink-0" />;
  if (!canEdit) return text ? <p className={look}>{icon}<span>{text}</span></p> : null;
  return <button ref={opener} type="button" onClick={open} title="Change the next step" className={clsx(look, "-mx-1.5 px-1.5 text-left transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600")}>
    {icon}<span>{text ? `${overdue ? "Overdue · " : ""}${text}` : "Add a next step"}</span><Edit size={12} className="shrink-0 text-neutral-400" />
  </button>;
}

/** Stage and owner of a lead, read-only until Edit is chosen. One Save writes both. */
export function LeadOwnership({ lead, canEdit, canReassign, members, personName, onSaved, onDirty }: {
  lead: Lead; canEdit: boolean; canReassign: boolean; members: SalesMember[]; personName: (id: string) => string; onSaved: () => void; onDirty: (key: string, dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [stage, setStage] = useState<SalesStage>(lead.stage);
  const [reason, setReason] = useState(lead.exitReason ?? "");
  const [lostReason, setLostReason] = useState<LostReason | "">(lead.lostReason ?? "");
  const [owner, setOwner] = useState(lead.ownerId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsReason = EXIT_STAGES.includes(stage);
  const stageDirty = stage !== lead.stage || (needsReason && reason.trim() !== (lead.exitReason ?? "").trim()) || (stage === "lost" && lostReason !== (lead.lostReason ?? ""));
  const ownerDirty = owner !== lead.ownerId;
  const dirty = editing && (stageDirty || ownerDirty);
  // A lost lead needs a reason category as well as the written reason.
  const ready = !needsReason || !stageDirty || (reason.trim().length >= 2 && (stage !== "lost" || !!lostReason));
  useEffect(() => { onDirty("ownership", dirty); return () => onDirty("ownership", false); }, [dirty, onDirty]);

  function open() { setStage(lead.stage); setReason(lead.exitReason ?? ""); setLostReason(lead.lostReason ?? ""); setOwner(lead.ownerId); setError(""); setEditing(true); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await updateLead(lead.id, {
        ...(stageDirty ? { stage, ...(needsReason ? { exitReason: reason.trim() } : {}), ...(stage === "lost" && lostReason ? { lostReason } : {}) } : {}),
        ...(ownerDirty ? { ownerId: owner } : {}),
      });
      toast({ title: stageDirty ? "Stage changed" : "Owner changed", body: `${lead.companyName}: ${stageDirty ? STAGE_LABELS[stage] : personName(owner)}` });
      setEditing(false); onSaved();
    } catch (cause) { setError(describeError(cause, "Could not save the change.")); }
    finally { setBusy(false); }
  }

  const ownerOptions = members.some((member) => member.id === lead.ownerId) ? members : [{ id: lead.ownerId, name: personName(lead.ownerId), role: "" }, ...members];
  const view = <dl className="grid gap-2 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><dt className="text-xs font-semibold text-neutral-500">Stage</dt><dd><StageChip stage={lead.stage} /></dd></div>
    {lead.exitReason && <div className="flex flex-wrap justify-between gap-2"><dt className="text-xs font-semibold text-neutral-500">{lead.stage === "lost" ? "Why it was lost" : "Why not a fit"}</dt><dd className="max-w-[70%] text-right font-medium text-neutral-700 [overflow-wrap:anywhere]">{lead.lostReason ? `${LOST_REASON_LABELS[lead.lostReason]}. ` : ""}{lead.exitReason}</dd></div>}
    <div className="flex flex-wrap items-center justify-between gap-2"><dt className="text-xs font-semibold text-neutral-500">Owner</dt><dd><PersonChip name={personName(lead.ownerId)} /></dd></div>
  </dl>;
  if (!editing) {
    return <div className="grid gap-3">{view}{canEdit && <button type="button" onClick={open} className={clsx(secondaryClass, "!min-h-9 justify-self-start !px-3 !text-xs")}><Edit size={13} />Change stage{canReassign ? " or owner" : ""}</button>}</div>;
  }
  return <form onSubmit={save} className="vso-fade-enter grid grid-cols-1 gap-3">
    <Field label="Stage"><Select aria-label="Stage" className={inputClass} value={stage} onChange={(event) => setStage(event.target.value as SalesStage)}>{SALES_STAGES.map((value) => <option key={value} value={value}>{STAGE_LABELS[value]}</option>)}</Select></Field>
    {stage === "lost" && <Field label="Main reason"><Select aria-label="Main reason it was lost" className={inputClass} value={lostReason} onChange={(event) => setLostReason(event.target.value as LostReason)}><option value="">Pick one</option>{LOST_REASONS.map((value) => <option key={value} value={value}>{LOST_REASON_LABELS[value]}</option>)}</Select></Field>}
    {needsReason && <Field label={stage === "lost" ? "In a line" : "Why it is not a fit"}><input required minLength={2} maxLength={500} className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="One line, for the team" /></Field>}
    {isWonStage(stage) && !isWonStage(lead.stage) && <p className="rounded-xl bg-success-surface p-3 text-xs font-semibold leading-5 text-success-text">Moving a lead to a won stage tells the owner and the venture heads to create delivery work.</p>}
    {canReassign && <Field label="Owner"><Select aria-label="Owner" className={inputClass} value={owner} onChange={(event) => setOwner(event.target.value)}>{ownerOptions.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></Field>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
    <div className="flex flex-wrap gap-2">
      <button disabled={!dirty || busy || !ready} className={clsx(primaryClass, "flex-1 sm:flex-none")}><ActionLabel busy={busy} idle={<><Check size={15} />Save</>} /></button>
      <button type="button" onClick={() => { setEditing(false); setError(""); }} className={clsx(secondaryClass, "flex-1 sm:flex-none")}>Cancel</button>
    </div>
  </form>;
}
