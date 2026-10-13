"use client";
import { useState } from "react";
import clsx from "clsx";
import type { BrainItem } from "@venture-studio/contracts";
import { ArrowLeft, ArrowRight, Check, Edit, Plus, Sparkles } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { approveBrainItem, archiveBrainItem } from "@/lib/sales-api";
import { BrainMarkdown } from "./brain-markdown";
import { KIND_LABEL, type BrainFormTarget } from "./brain-form";
import { isApproved } from "./brain-model";
import { Trash } from "./draft-icons";
import { kickerClass, stamp } from "./draft-shared";
import { useSalesShell } from "./sales-context";
import { plural } from "./sales-ui";

const chipClass = "inline-flex min-h-8 items-center gap-1 rounded-lg bg-[var(--color-neutral-0)] px-2.5 font-semibold text-neutral-800 transition-[filter] duration-150 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";

/** The right pane: one knowledge item, who proposed or approved it, and what a person can do with it. */
export function BrainReader({ item, twin, proposals, retires, canApprove, canWrite, showBack = true, onBack, onSelect, onEdit, onPropose, onApproved, onArchived }: {
  item: BrainItem; twin?: BrainItem | undefined; proposals: BrainItem[]; retires: BrainItem[]; canApprove: boolean; canWrite: boolean;
  /** The phone-only Back button in the header; off where the page has its own way back. */
  showBack?: boolean;
  onBack: () => void; onSelect: (item: BrainItem) => void; onEdit: (item: BrainItem) => void; onPropose: (target: BrainFormTarget) => void;
  onApproved: (item: BrainItem) => void; onArchived: (item: BrainItem) => void;
}) {
  const { session, personName, refresh } = useSalesShell();
  const [compare, setCompare] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const approved = isApproved(item);
  // The API lets a venture head or admin, and the person who proposed it, change or discard a pending proposal.
  const canManage = !approved && (canApprove || (canWrite && !!session && item.proposedBy === session.user.id));
  const by = item.via === "claude" ? `Claude, for ${personName(item.proposedBy)}` : personName(item.proposedBy);

  async function approve() {
    setBusy("approve"); setError("");
    try { const saved = await approveBrainItem(item.id); toast({ title: "Approved", body: `${saved.title}. Claude uses it from now on.${saved.retired ? ` ${plural(saved.retired, "approved item")} it replaces ${saved.retired === 1 ? "was" : "were"} retired.` : ""}` }); onApproved(saved); refresh(); }
    catch (cause) { setError(describeError(cause, "Could not approve. Try again.")); }
    finally { setBusy(""); }
  }
  async function discard() {
    setBusy("discard"); setError("");
    try { const saved = await archiveBrainItem(item.id); toast({ title: "Proposal discarded", body: saved.title }); onArchived(saved); refresh(); }
    catch (cause) { setError(describeError(cause, "Could not discard. Try again.")); setBusy(""); }
  }

  return <article className="vso-fade-enter min-w-0">
    <header className="space-y-2.5 border-b border-neutral-100 px-4 py-4 sm:px-6">
      <div className="flex items-start gap-3">
        {showBack && <button type="button" onClick={onBack} aria-label="Back to the list" className="-ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.95] lg:hidden"><ArrowLeft size={18} /></button>}
        <div className="min-w-0 flex-1">
          <p className={kickerClass}>{KIND_LABEL[item.kind]}</p>
          <h2 className="mt-0.5 text-xl font-extrabold leading-tight tracking-[-.02em] text-neutral-900 [overflow-wrap:anywhere]">{item.title}</h2>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-neutral-500">
        <Badge tone={approved ? "green" : "amber"}>{approved ? "Approved" : "Proposed"}</Badge>
        <span className="font-semibold text-neutral-700">Version {item.version}</span>
        {approved
          ? <span>Approved{item.approvedBy ? ` by ${personName(item.approvedBy)}` : ""}{item.approvedAt ? `, ${stamp(item.approvedAt)}` : ""}</span>
          : <span className="inline-flex items-center gap-1">{item.via === "claude" && <Sparkles size={12} aria-hidden="true" />}Proposed by {by}, {stamp(item.createdAt)}</span>}
        {approved && <span className="text-neutral-400">Proposed by {item.via === "claude" ? "Claude" : personName(item.proposedBy)}</span>}
      </div>
    </header>

    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-5">
      {!approved && twin && <p className="rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs leading-5 text-warning-text">This proposal would replace version {twin.version}. Until it is approved, Claude keeps using version {twin.version}.</p>}
      {!approved && !twin && <p className="rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs leading-5 text-warning-text">New and not approved yet, so Claude does not use it.</p>}
      {!approved && retires.length > 0 && <div className="space-y-1.5 rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs leading-5 text-warning-text">
        <p className="font-semibold">Approving this retires {plural(retires.length, "approved item")}:</p>
        <ul className="flex flex-wrap gap-2">{retires.map((other) => <li key={other.id} className="min-w-0 max-w-full"><button type="button" onClick={() => onSelect(other)} className={clsx(chipClass, "max-w-full text-left")}><span className="min-w-0 [overflow-wrap:anywhere]">{other.title}</span><span className="shrink-0 font-normal text-neutral-500">· {KIND_LABEL[other.kind]}</span></button></li>)}</ul>
      </div>}
      {approved && proposals.length > 0 && <div className="space-y-1.5 rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs leading-5 text-warning-text">
        <p>{proposals.length === 1 ? "A change to this item is waiting for approval." : `${proposals.length} changes to this item are waiting for approval.`}</p>
        <div className="flex flex-wrap gap-2">{proposals.map((proposal) => <button key={proposal.id} type="button" onClick={() => onSelect(proposal)} className={chipClass}>View version {proposal.version}<ArrowRight size={12} aria-hidden="true" /></button>)}</div>
      </div>}

      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap items-center gap-2">
        {!approved && canApprove && <button type="button" onClick={() => void approve()} disabled={busy !== ""} className={primaryClass}><ActionLabel busy={busy === "approve"} busyText="Approving…" idle={<><Check size={16} />Approve</>} /></button>}
        {canManage && <button type="button" onClick={() => onEdit(item)} className={secondaryClass}><Edit size={16} />Edit</button>}
        {!approved && twin && <button type="button" aria-pressed={compare} onClick={() => setCompare(!compare)} className={secondaryClass}>{compare ? "Hide the comparison" : "Compare with approved"}</button>}
        {approved && canWrite && proposals.length === 0 && <button type="button" onClick={() => onPropose({ mode: "propose", kind: item.kind, title: item.title, body: item.body })} className={secondaryClass}><Plus size={16} />Propose a change</button>}
        {canManage && <button type="button" aria-expanded={discarding} onClick={() => setDiscarding(!discarding)} className={clsx(secondaryClass, "!text-danger-text")}><Trash size={16} />Discard draft</button>}
        {!approved && !canApprove && <span className="text-xs text-neutral-500">A venture head approves this.</span>}
      </div>
      {discarding && <div role="alertdialog" aria-label="Confirm discard" className="vso-fade-enter space-y-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3.5">
        <p className="text-sm font-bold text-neutral-900">Discard this proposal?</p>
        <p className="text-xs leading-5 text-neutral-500">{twin ? `Version ${twin.version} stays as it is.` : "Nothing has been approved under this title yet."} Claude or a teammate can propose it again.</p>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void discard()} disabled={busy !== ""} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50"><ActionLabel busy={busy === "discard"} busyText="Discarding…" idle="Yes, discard it" /></button><button type="button" onClick={() => setDiscarding(false)} className={secondaryClass}>Keep it</button></div>
      </div>}

      <div className="border-t border-neutral-100 pt-5">
        {!approved && twin && compare
          ? <div className="grid gap-6 lg:grid-cols-2">
            <section className="min-w-0 space-y-3"><p className={kickerClass}>Approved now · version {twin.version}</p><BrainMarkdown markdown={twin.body} wide /></section>
            <section className="min-w-0 space-y-3 rounded-2xl bg-warning-surface/40 p-4"><p className="text-[11px] font-bold uppercase tracking-[.06em] text-warning-text">Proposed · version {item.version}</p><BrainMarkdown markdown={item.body} wide /></section>
          </div>
          : <BrainMarkdown markdown={item.body} />}
      </div>
    </div>
  </article>;
}
