"use client";
import { useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, CircleAlert } from "@/components/ui/icons";
import { Badge } from "@/components/studio/primitives";
import type { SetupItem } from "./setup-checks";

/** One line of the checklist. Done items fold to a single row; to-do items open with why it matters and the action that completes it. */
export function SetupItemCard({ number, item, children }: { number: number; item: SetupItem; children?: React.ReactNode }) {
  const [open, setOpen] = useState(!item.done);
  const panelId = `setup-${item.key}`;
  return <li className={clsx("rounded-2xl border bg-white shadow-card transition-colors duration-150", item.done ? "border-neutral-100" : "border-neutral-200")}>
    <h3>
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)} className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 sm:px-5">
        <span aria-hidden="true" className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold", item.done ? "bg-success-surface text-success-text" : item.unknown ? "bg-neutral-100 text-neutral-500" : "border-2 border-neutral-200 text-neutral-500")}>{item.done ? <Check size={15} /> : item.unknown ? <CircleAlert size={15} /> : number}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-sm font-bold text-neutral-900">{item.title}</span>{item.done ? <Badge tone="green">Done</Badge> : item.unknown ? <Badge>Could not check</Badge> : <Badge tone="amber">To do</Badge>}</span>
          {!open && <span className="mt-0.5 block truncate text-xs text-neutral-500">{item.summary}</span>}
        </span>
        <ChevronDown size={16} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", open && "rotate-180")} />
      </button>
    </h3>
    {open && <div id={panelId} className="vso-fade-enter space-y-3 px-4 pb-4 sm:px-5 sm:pl-[4.75rem]">
      <p className="text-[13px] leading-6 text-neutral-600">{item.why}</p>
      <p className="text-[13px] font-semibold leading-6 text-neutral-800 [overflow-wrap:anywhere]">{item.summary}</p>
      {children}
    </div>}
  </li>;
}
