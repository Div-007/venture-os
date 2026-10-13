"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { z } from "zod";
import { BULK_MAX, EXIT_STAGES, SALES_STAGES, WON_STAGES, type BulkLeadsInput, type leadFacetsQuerySchema, type LostReason, type Offer, type SalesStage } from "@venture-studio/contracts";
import { ArrowLeft, Hash, Kanban, Play, UserPlus, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { ActionLabel, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { bulkLeads, type BulkResult } from "@/lib/sales-api";
import type { SalesMember } from "@/components/sales/overview-context";
import { Package } from "@/components/sales/lead-icons";
import { offerChip, offerHref } from "@/components/sales/offer-model";
import { LOST_REASON_LABELS, LOST_REASONS, number, plural, STAGE_LABELS, Trash2 } from "@/components/sales/sales-ui";

type Step = "assign" | "tag" | "stage" | "play" | "offer" | "delete";
/** One bulk change without its target (each action keeps its own fields). */
type BulkChange = BulkLeadsInput extends infer Input ? Input extends unknown ? Omit<Input, "ids" | "filter"> : never : never;
/** Which leads a bulk change is for: the ticked ones, or everything the list filters match (the API stops at BULK_MAX). */
export type BulkTarget = { ids: string[] } | { filter: z.input<typeof leadFacetsQuerySchema> };

const DONE: Record<BulkResult["action"], [string, string]> = {
  assign: ["Assigned", "already theirs"], tag: ["Tagged", "already had it"], untag: ["Removed the tag from", "did not have it"], stage: ["Moved", "already there"], play: ["Added to the play:", "already in it"], offer: ["Moved to the offer:", "already on it"], delete: ["Deleted", ""],
};
/** Moves that are made one lead at a time, from the lead: winning a deal (the API refuses them in bulk). */
const BULK_STAGES = SALES_STAGES.filter((stage) => !WON_STAGES.includes(stage));

/** A change for all matching leads stopped at BULK_MAX and more are left that it could reach: the same change again takes the next ones. */
export const moreToGo = (result: BulkResult) => result.truncated && (result.remaining ?? 0) > 0 && result.changed > 0;

/** One toast that says what happened: changed, already so, still to go, and skipped with the first reason. */
export function bulkToast(result: BulkResult) {
  const [verb, already] = DONE[result.action];
  const reasons = [...new Set(result.skipped.map((item) => item.reason))];
  const skipped = result.skippedCount ? `${number(result.skippedCount)} skipped: ${reasons[0] ?? "not allowed"}${reasons.length > 1 ? " (and other reasons)" : ""}` : "";
  const more = moreToGo(result);
  const parts = more
    ? [`Changed ${number(result.changed)}; ${number(result.unchanged)} ${result.unchanged === 1 ? "was" : "were"} already like that; ${number(result.remaining ?? 0)} still to go — run again`, skipped]
    : [result.unchanged ? `${number(result.unchanged)} ${already}` : "", skipped];
  const body = parts.filter(Boolean).join(" · ");
  toast({ tone: result.changed ? "success" : result.skippedCount ? "error" : "info", title: `${verb} ${plural(result.changed, "lead")}`, ...(body ? { body } : {}), duration: result.skippedCount || more ? 9000 : 5000 });
}

function ActionButton({ icon: Icon, label, onClick, danger }: { icon: typeof Hash; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" onClick={onClick} className={clsx("inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] sm:min-h-9 sm:justify-start sm:text-[13px]", danger ? "text-danger-text hover:bg-danger-surface" : "text-neutral-700 hover:bg-neutral-100", "max-sm:border max-sm:border-neutral-200")}><Icon size={15} aria-hidden="true" />{label}</button>;
}

/**
 * The bar that appears when leads are ticked: Assign, Add tag, Move to stage, Add to play, Move to offer, Delete. Each opens a small step that names
 * what will happen ("Move 12 leads to Contacted") before anything changes; the answer comes back as one toast. On laptops it sticks to the
 * bottom of the list column (clear of the sidebar); on tablets it floats at the bottom of the screen; on phones it is a bottom sheet. Each lead is still checked like a single edit, so some may be skipped.
 */
export function LeadBulkBar({ count, target, canAssign, members, plays, offers = null, ventureId = "", onClear, onDone }: {
  /** `more`: the change stopped at BULK_MAX with leads still to go; the bar keeps the selection and the step so it can run again. */
  count: number; target: BulkTarget; canAssign: boolean; members: SalesMember[]; plays: { id: string; name: string }[];
  /** The picked venture's offers that leads may move to (not archived); null in All ventures, where moving to an offer is left out. */
  offers?: Offer[] | null; ventureId?: string; onClear: () => void; onDone: (more: boolean) => void;
}) {
  const [step, setStep] = useState<Step | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [tag, setTag] = useState("");
  const [stage, setStage] = useState<SalesStage | "">("");
  const [lostReason, setLostReason] = useState<LostReason | "">("");
  const [exitReason, setExitReason] = useState("");
  const [playId, setPlayId] = useState("");
  const [offerId, setOfferId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bar = useRef<HTMLDivElement>(null);
  const leads = plural(Math.min(count, BULK_MAX), "lead");
  const exit = !!stage && EXIT_STAGES.includes(stage);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (step) setStep(null); else onClear();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [step, onClear]);

  function open(next: Step) { setStep(next); setError(""); }

  async function run(input: BulkChange) {
    setBusy(true); setError("");
    try {
      const result = await bulkLeads({ ...input, ...target } as BulkLeadsInput);
      bulkToast(result);
      const more = moreToGo(result);
      // With more to go the step stays open with its choices, so "run again" is one more press.
      if (!more) { setStep(null); setTag(""); setStage(""); setLostReason(""); setExitReason(""); }
      onDone(more);
    } catch (cause) { setError(describeError(cause, "Could not change the leads. Try again.")); }
    finally { setBusy(false); }
  }

  let form: React.ReactNode = null;
  if (step === "assign") form = <form className="grid gap-2.5 sm:flex sm:items-center" onSubmit={(event) => { event.preventDefault(); if (ownerId) void run({ action: "assign", ownerId }); }}>
    <div className="min-w-0 sm:w-56 sm:shrink-0"><Select aria-label="New owner" className={clsx(inputClass, "sm:!min-h-10")} value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">Choose a person</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></div>
    <button type="submit" disabled={busy || !ownerId} className={primaryClass}><ActionLabel busy={busy} busyText="Assigning…" idle={`Assign ${leads}`} /></button>
  </form>;
  if (step === "tag") form = <form className="grid gap-2.5 sm:flex sm:items-center" onSubmit={(event) => { event.preventDefault(); if (tag.trim()) void run({ action: "tag", tag: tag.trim() }); }}>
    <label className="sr-only" htmlFor="bulk-tag">Tag</label>
    <input id="bulk-tag" autoFocus value={tag} maxLength={40} onChange={(event) => setTag(event.target.value)} placeholder="Tag, e.g. raipur-batch" className={clsx(inputClass, "sm:!min-h-10 sm:w-56")} />
    <div className="grid grid-cols-2 gap-2 sm:flex">
      <button type="submit" disabled={busy || !tag.trim()} className={primaryClass}><ActionLabel busy={busy} busyText="Tagging…" idle={`Tag ${leads}`} /></button>
      <button type="button" disabled={busy || !tag.trim()} onClick={() => void run({ action: "untag", tag: tag.trim() })} className={secondaryClass}>Remove tag</button>
    </div>
  </form>;
  if (step === "stage") form = <form className="grid gap-2.5 sm:flex sm:items-center" onSubmit={(event) => { event.preventDefault(); if (stage) void run({ action: "stage", stage, ...(exit ? { exitReason: exitReason.trim() } : {}), ...(stage === "lost" && lostReason ? { lostReason } : {}) }); }}>
    <div className="min-w-0 sm:w-52 sm:shrink-0"><Select aria-label="Move to stage" className={clsx(inputClass, "sm:!min-h-10")} value={stage} onChange={(event) => setStage(event.target.value as SalesStage | "")}><option value="">Choose a stage</option>{BULK_STAGES.map((item) => <option key={item} value={item}>{STAGE_LABELS[item]}</option>)}</Select></div>
    {stage === "lost" && <div className="min-w-0 sm:w-48 sm:shrink-0"><Select aria-label="Why it was lost" className={clsx(inputClass, "sm:!min-h-10")} value={lostReason} onChange={(event) => setLostReason(event.target.value as LostReason | "")}><option value="">Why lost?</option>{LOST_REASONS.map((item) => <option key={item} value={item}>{LOST_REASON_LABELS[item]}</option>)}</Select></div>}
    {exit && <><label className="sr-only" htmlFor="bulk-exit">Reason</label><input id="bulk-exit" value={exitReason} maxLength={500} onChange={(event) => setExitReason(event.target.value)} placeholder={stage === "lost" ? "In a few words, what happened" : "Why they are not a fit"} className={clsx(inputClass, "sm:!min-h-10 sm:w-60")} /></>}
    <button type="submit" disabled={busy || !stage || (exit && !exitReason.trim()) || (stage === "lost" && !lostReason)} className={primaryClass}><ActionLabel busy={busy} busyText="Moving…" idle={stage ? `Move ${leads} to ${STAGE_LABELS[stage]}` : `Move ${leads}`} /></button>
  </form>;
  if (step === "play") form = <form className="grid gap-2.5 sm:flex sm:items-center" onSubmit={(event) => { event.preventDefault(); if (playId) void run({ action: "play", playId }); }}>
    {plays.length
      ? <div className="min-w-0 sm:w-56 sm:shrink-0"><Select aria-label="Play" className={clsx(inputClass, "sm:!min-h-10")} value={playId} onChange={(event) => setPlayId(event.target.value)}><option value="">Choose a play</option>{plays.map((play) => <option key={play.id} value={play.id}>{play.name}</option>)}</Select></div>
      : <p className="text-sm text-neutral-500">No plays yet. Plan one with Claude first.</p>}
    {plays.length > 0 && <button type="submit" disabled={busy || !playId} className={primaryClass}><ActionLabel busy={busy} busyText="Adding…" idle={`Add ${leads}`} /></button>}
  </form>;
  if (step === "offer") form = <form className="grid gap-2.5 sm:flex sm:items-center" onSubmit={(event) => { event.preventDefault(); if (offerId) void run({ action: "offer", offerId }); }}>
    {offers?.length
      ? <div className="min-w-0 sm:w-56 sm:shrink-0"><Select aria-label="Offer" className={clsx(inputClass, "sm:!min-h-10")} value={offerId} onChange={(event) => setOfferId(event.target.value)}><option value="">Choose an offer</option>{offers.map((offer) => { const chip = offerChip(offer); return <option key={offer.id} value={offer.id}>{offer.name}{chip.label === "Active" ? "" : ` (${chip.label.toLowerCase()})`}</option>; })}</Select></div>
      : <p className="text-sm text-neutral-500">No offers yet. {ventureId ? <WorkspaceLink href={offerHref(ventureId)} className="font-semibold text-primary-700 hover:underline">Create one in Offers</WorkspaceLink> : "Create one in Offers"} first.</p>}
    {!!offers?.length && <button type="submit" disabled={busy || !offerId} className={primaryClass}><ActionLabel busy={busy} busyText="Moving…" idle={`Move ${leads}`} /></button>}
  </form>;
  if (step === "delete") form = <div className="grid gap-2.5 sm:flex sm:items-center">
    <p className="text-sm leading-5 text-neutral-700 sm:max-w-md"><strong className="font-semibold text-danger-text">Delete {leads}?</strong> Leads you may not delete (already contacted, or someone else&apos;s) are skipped.</p>
    <button type="button" disabled={busy} onClick={() => void run({ action: "delete" })} className={clsx(primaryClass, "!bg-danger hover:!opacity-90")}><ActionLabel busy={busy} busyText="Deleting…" idle={`Delete ${leads}`} /></button>
  </div>;

  const titles: Record<Step, string> = { assign: "Assign to", tag: "Tag", stage: "Move to stage", play: "Add to a play", offer: "Move to offer", delete: "Delete" };
  return <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 sm:bottom-5 sm:flex sm:justify-center sm:px-4 lg:sticky lg:mt-4 lg:px-0">
    <div ref={bar} role="region" aria-label="Change the selected leads" className="vso-fade-enter pointer-events-auto w-full rounded-t-2xl border border-neutral-200 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-e4 sm:w-auto sm:max-w-full sm:rounded-2xl sm:p-2 sm:pb-2">
      <div className="flex items-center justify-between gap-2 sm:hidden"><p className="text-sm font-bold text-neutral-900 tnum">{number(count)} selected</p><button type="button" onClick={onClear} className="inline-flex min-h-10 items-center gap-1 rounded-xl px-2.5 text-sm font-semibold text-neutral-500">Clear</button></div>
      {step
        ? <div className="mt-2 grid gap-2.5 sm:mt-0 sm:flex sm:items-center sm:gap-3">
          <div className="flex items-center gap-1.5"><button type="button" onClick={() => { setStep(null); setError(""); }} aria-label="Back to the actions" className="grid h-10 w-10 place-items-center rounded-xl text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 sm:h-9 sm:w-9"><ArrowLeft size={16} /></button><span className="text-sm font-semibold text-neutral-800">{titles[step]}</span></div>
          {form}
          {error && <Notice tone="error" message={error} onDismiss={() => setError("")} className="sm:max-w-sm" />}
        </div>
        : <div className="mt-2 grid grid-cols-2 gap-2 sm:mt-0 sm:flex sm:items-center sm:gap-0.5">
          <p className="hidden px-2.5 text-[13px] font-bold text-neutral-900 tnum sm:block">{number(count)} selected</p>
          <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-neutral-200 sm:block" />
          {canAssign && <ActionButton icon={UserPlus} label="Assign" onClick={() => open("assign")} />}
          <ActionButton icon={Hash} label="Add tag" onClick={() => open("tag")} />
          <ActionButton icon={Kanban} label="Move to stage" onClick={() => open("stage")} />
          <ActionButton icon={Play} label="Add to play" onClick={() => open("play")} />
          {offers && <ActionButton icon={Package} label="Move to offer" onClick={() => open("offer")} />}
          <ActionButton icon={Trash2} label="Delete" danger onClick={() => open("delete")} />
          <button type="button" onClick={onClear} aria-label="Clear the selection" className="ml-1 hidden h-9 w-9 place-items-center rounded-xl text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 sm:grid"><X size={16} /></button>
        </div>}
    </div>
  </div>;
}
