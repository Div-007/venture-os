"use client";
import clsx from "clsx";
import type { Lead } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { Badge, filterControl } from "@/components/studio/primitives";
import { PopAvatar, PopCard } from "@/components/sales/pop-card";
import { groupOfStage, isOverdue, isWonStage, Lock, PersonChip, StageChip, STAGE_GROUPS, VerdictChip, when, type StageGroupKey } from "@/components/sales/sales-ui";

/** One lead on the board. Opens the drawer on click or Enter; on phones a Move select replaces dragging. */
export function PipelineCard({ lead, ownerName, movable, pending, dragging, dragActive, flipProps, onOpen, onMove, canHandOver, handingOver, onHandOver }: {
  lead: Lead; ownerName: string; movable: boolean; pending: boolean; dragging: boolean; /** Some card on the board is being dragged: no card pops while it is. */ dragActive: boolean; flipProps: Record<string, unknown>;
  onOpen: () => void; onMove: (group: StageGroupKey) => void; canHandOver: boolean; handingOver: boolean; onHandOver: () => void;
}) {
  const group = groupOfStage(lead.stage);
  const overdue = isOverdue(lead.nextActionAt);
  const won = isWonStage(lead.stage);
  // The flip and drag props sit on the outer box (it carries the glide, the z-index while gliding and the drag copy); the pop effect wraps the card itself.
  return <div {...flipProps} className="relative mb-2 rounded-xl"><PopCard tilt={6} className="rounded-xl" disabled={dragActive}><article data-flash-id={lead.id} role="button" tabIndex={0} aria-label={`Open ${lead.companyName}`} aria-busy={pending || undefined} onClick={onOpen}
    onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }}
    className={clsx("relative w-full rounded-xl [transform-style:preserve-3d] border border-transparent bg-neutral-50 p-3 text-left transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]", movable && "md:cursor-grab", dragging && "border-dashed !border-primary-300 opacity-40", pending && "opacity-70")}>
    <div className="flex items-start gap-2.5">
      <PopAvatar name={lead.companyName} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-5 text-neutral-800 [overflow-wrap:anywhere]">{lead.companyName}</p>
        {(lead.city || lead.category) && <p className="mt-0.5 truncate text-xs text-neutral-500">{[lead.city, lead.category].filter(Boolean).join(" · ")}</p>}
      </div>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {group.stages.length > 1 && <StageChip stage={lead.stage} />}
      {group.key === "new" && <VerdictChip verdict={lead.verdict} />}
      {lead.needsYou && <Badge tone="amber">Needs you</Badge>}
      {lead.doNotContact && <span title="Do not contact" className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger-text"><Lock size={12} />No contact</span>}
    </div>
    {(lead.nextAction || lead.nextActionAt) && <p className="mt-2 text-xs leading-5 text-neutral-500"><span className="font-medium text-neutral-600">{lead.nextAction || "Follow up"}</span>{lead.nextActionAt && <span className={clsx("font-semibold", overdue ? "text-danger-text" : "text-neutral-400")}> · {when(lead.nextActionAt)}</span>}</p>}
    <div className="mt-2.5 flex items-center justify-between gap-2"><PersonChip name={ownerName} />{won && lead.deliveryTaskId && <Badge tone="green">Handed over</Badge>}</div>
    {won && !lead.deliveryTaskId && canHandOver && <button type="button" disabled={handingOver} onClick={(event) => { event.stopPropagation(); onHandOver(); }} className="mt-2.5 inline-flex min-h-9 w-full items-center justify-center rounded-lg bg-primary-700 px-2.5 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 active:scale-[0.97] disabled:opacity-50">{handingOver ? "Creating…" : "Create delivery work"}</button>}
    {movable && <div className="mt-2.5 md:hidden" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><Select aria-label={`Move ${lead.companyName} to another column`} className={clsx(filterControl(false), "!min-h-10 w-full")} value={group.key} onChange={(event) => onMove(event.target.value as StageGroupKey)}>{STAGE_GROUPS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select></div>}
  </article></PopCard></div>;
}
