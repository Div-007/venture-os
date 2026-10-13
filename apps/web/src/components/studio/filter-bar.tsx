"use client";

import { useEffect, useId, useState } from "react";
import clsx from "clsx";
import { Filter } from "@/components/ui/icons";

/** Whether a page's filter row is shown; remembered per page in this browser (best effort). */
export function useFilterToggle(storageKey: string) {
  const id = useId();
  const key = `vso-filters:${storageKey}`;
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try { if (localStorage.getItem(key) === "closed") queueMicrotask(() => setOpen(false)); } catch { /* storage unavailable: stay open */ }
  }, [key]);
  const toggle = () => setOpen((current) => {
    try { localStorage.setItem(key, current ? "closed" : "open"); } catch { /* storage unavailable */ }
    return !current;
  });
  return { open, toggle, rowId: `${id}-filters` };
}

/** The filter icon button that shows and hides a page's filter row; `count` is the result total, `active` the filters in use. */
export function FilterToggle({ open, onToggle, rowId, count, noun, active }: { open: boolean; onToggle: () => void; rowId: string; count: number; noun: string; active: number }) {
  return <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={rowId} aria-label={`${open ? "Hide" : "Show"} filters`}
    className={clsx("inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-sm font-semibold transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]",
      open ? "bg-primary-50 text-primary-800 hover:bg-primary-100" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800")}>
    <Filter size={16} />
    <span className="tnum">{count} {noun}{count === 1 ? "" : "s"}</span>
    {active > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary-700 px-1.5 text-[10px] font-bold text-white tnum" aria-label={`${active} filter${active === 1 ? "" : "s"} on`}>{active}</span>}
  </button>;
}

/** The filter controls themselves: no panel, just a wrapping row of content-width pills that collapses when hidden. */
export function FilterRow({ open, rowId, onClear, active, children }: { open: boolean; rowId: string; onClear?: () => void; active: number; children: React.ReactNode }) {
  return <div id={rowId} data-open={open} className="vso-collapse" aria-hidden={!open || undefined} inert={!open || undefined}>
    <div><div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2 p-0.5 pb-4">
      {children}
      {onClear && active > 0 && <button type="button" onClick={onClear} className="min-h-9 rounded-full px-3 text-[13px] font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800">Clear</button>}
    </div></div>
  </div>;
}
