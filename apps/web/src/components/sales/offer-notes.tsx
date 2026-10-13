"use client";
import { useState } from "react";
import type { BrainItem } from "@venture-studio/contracts";
import { ChevronDown, ChevronRight, Plus } from "@/components/ui/icons";
import { Badge, Panel, secondaryClass } from "@/components/studio/primitives";
import { KIND_LABEL, type BrainKind } from "./brain-form";
import { isApproved, isProposal, liveItems } from "./brain-model";
import { useSalesShell } from "./sales-context";

/** Background every offer of the venture uses. The other brain kinds are legacy: the offers migration moves them into an offer. */
export const SHARED_KINDS: readonly BrainKind[] = ["notes", "venture_settings"];
export const LEGACY_KINDS: readonly BrainKind[] = ["offer", "target_profile", "message_rules"];

const shortDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
/** Rows shown before "Show all": the page stays short when a venture has many notes. */
const FOLDED = 6;

/** Approved notes first (by title), then proposals (newest change first). */
export function sharedNotes(items: readonly BrainItem[]) {
  const live = liveItems(items).filter((item) => SHARED_KINDS.includes(item.kind));
  return [...live.filter(isApproved).sort((a, b) => a.title.localeCompare(b.title)), ...live.filter(isProposal).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))];
}
export const legacyItems = (items: readonly BrainItem[]) => liveItems(items).filter((item) => LEGACY_KINDS.includes(item.kind));

/** "Shared for {venture}": the notes as quiet rows that open in the reader (the first few, then "Show all"), and a way to add one. */
export function SharedNotes({ ventureName, items, legacy, loading, error, canWrite, onOpen, onAdd }: {
  ventureName: string; items: BrainItem[]; legacy: BrainItem[]; loading: boolean; error: string; canWrite: boolean; onOpen: (item: BrainItem) => void; onAdd: () => void;
}) {
  const { personName } = useSalesShell();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, FOLDED);
  const waiting = items.filter(isProposal).length;
  return <Panel className="overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold text-neutral-900">Shared for {ventureName}{waiting > 0 && <Badge tone="amber">{waiting === 1 ? "1 proposal" : `${waiting} proposals`}</Badge>}</h2>
        <p className="mt-0.5 max-w-xl text-xs leading-5 text-neutral-500">Background every offer uses: what we learned, what the founders decided, and working limits.</p>
      </div>
      {canWrite && <button type="button" onClick={onAdd} className={`${secondaryClass} !min-h-9 !px-3 !text-xs`}><Plus size={14} aria-hidden="true" />Add a note</button>}
    </div>
    {error && !items.length ? <p role="alert" className="px-4 py-4 text-sm font-semibold text-danger-text sm:px-5">Could not load the shared notes. {error}</p>
      : loading ? <div role="status" aria-label="Loading the shared notes" className="space-y-3 px-4 py-4 sm:px-5">{[0, 1].map((index) => <span key={index} className="vso-skeleton block h-10 rounded-lg" />)}</div>
        : items.length === 0 ? <p className="px-4 py-4 text-sm leading-6 text-neutral-500 sm:px-5">No shared notes yet. Claude proposes them when you talk the business through with it, or add one yourself.</p>
          : <><ul className="divide-y divide-neutral-100">{shown.map((item) => {
            const approved = isApproved(item);
            const by = item.via === "claude" ? "Claude" : personName(item.proposedBy);
            return <li key={item.id}><button type="button" onClick={() => onOpen(item)} className="group flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-bold leading-5 text-neutral-900 line-clamp-2 [overflow-wrap:anywhere]">{item.title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{item.kind === "venture_settings" ? `${KIND_LABEL.venture_settings} · ` : ""}v{item.version} · {shortDate.format(new Date(item.updatedAt))} · {by}</span>
              </span>
              <Badge tone={approved ? "green" : "amber"}>{approved ? "Approved" : "Proposed"}</Badge>
              <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-neutral-300 transition-transform duration-150 group-hover:translate-x-0.5" />
            </button></li>;
          })}</ul>
          {items.length > FOLDED && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex min-h-11 w-full items-center justify-center gap-1.5 border-t border-neutral-100 text-xs font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-50 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600">{expanded ? "Show fewer" : `Show all ${items.length} notes`}<ChevronDown size={14} aria-hidden="true" className={expanded ? "rotate-180 transition-transform duration-150" : "transition-transform duration-150"} /></button>}</>}
    {legacy.length > 0 && <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500 sm:px-5">
      <p>Older knowledge waiting to move into an offer: {legacy.length === 1 ? "one item" : `${legacy.length} items`} written before offers existed. Read them here until they move.</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">{legacy.map((item) => <li key={item.id} className="min-w-0 max-w-full"><button type="button" onClick={() => onOpen(item)} className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 text-left font-semibold text-neutral-700 transition-colors duration-150 hover:border-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="min-w-0 truncate">{item.title}</span><span className="shrink-0 font-normal text-neutral-400">· {KIND_LABEL[item.kind]}</span></button></li>)}</ul>
    </div>}
  </Panel>;
}
