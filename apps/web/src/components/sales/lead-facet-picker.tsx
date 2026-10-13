"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, ChevronDown, Search } from "@/components/ui/icons";
import { filterControl, inputClass } from "@/components/studio/primitives";
import { number } from "@/components/sales/sales-ui";

export type FacetOption = { value: string; label: string; count: number; hint?: string };
const SHOWN = 120;

/**
 * A filter dropdown whose choices carry counts, like a shop sidebar. `searchable` adds a box that narrows the list as you type.
 * `notSet` is the "Not set" choice (value "none"), always last. `variant="field"` is the full-width form version for the phone sheet.
 */
export function FacetPicker({ label, allLabel, value, valueLabel, options, notSet, searchable = false, variant = "pill", onChange }: {
  /** Short noun for the trigger and screen readers, e.g. "State". */
  label: string; allLabel: string; value: string; valueLabel?: string; options: FacetOption[]; notSet?: { count: number; label: string };
  searchable?: boolean; variant?: "pill" | "field"; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [place, setPlace] = useState({ top: 0, left: 0, width: 260, maxHeight: 360 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId().replaceAll(":", "");

  const needle = text.trim().toLowerCase();
  // Matches that start with what was typed come first; each group stays in count order.
  const matches = useMemo(() => {
    const found = options.filter((option) => !needle || option.label.toLowerCase().includes(needle) || (option.hint ?? "").toLowerCase().includes(needle));
    return needle ? [...found.filter((option) => option.label.toLowerCase().startsWith(needle)), ...found.filter((option) => !option.label.toLowerCase().startsWith(needle))] : found;
  }, [options, needle]);
  const shown = matches.slice(0, SHOWN);
  // Row 0 is "all"; the last row is "Not set" (hidden while searching).
  const rows: { value: string; label: string; count?: number; hint?: string }[] = [
    ...(needle ? [] : [{ value: "", label: allLabel }]), ...shown,
    ...(notSet && notSet.count > 0 && !needle ? [{ value: "none", label: notSet.label, count: notSet.count }] : []),
  ];
  const selectedLabel = value ? valueLabel ?? options.find((option) => option.value.toLowerCase() === value.toLowerCase())?.label ?? (value === "none" ? notSet?.label ?? "Not set" : value) : "";

  function show() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width, 260));
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const placeAbove = below < 220 && above > below;
    const maxHeight = Math.max(160, Math.min(380, placeAbove ? above : below));
    setPlace({ top: placeAbove ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, maxHeight });
    setText(""); setHighlight(0); setOpen(true);
  }
  const hide = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const choose = (next: string) => { onChange(next); hide(); };

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => (searchable ? input.current : popover.current)?.focus({ preventScroll: true }));
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !popover.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && popover.current?.contains(event.target))) setOpen(false); };
    const onResize = () => setOpen(false);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("pointerdown", onPointer, true); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onResize); };
  }, [open, searchable]);
  useEffect(() => { popover.current?.querySelector<HTMLElement>(`[data-row="${highlight}"]`)?.scrollIntoView({ block: "nearest" }); }, [highlight, open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setHighlight((current) => Math.min(rows.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)))); return; }
    if (event.key === "Home" || event.key === "End") { if (!searchable) { event.preventDefault(); setHighlight(event.key === "Home" ? 0 : rows.length - 1); } return; }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); const row = rows[Math.min(highlight, rows.length - 1)]; if (row) choose(row.value); }
  }

  const active = !!value;
  const triggerClass = variant === "field"
    ? clsx(inputClass, "flex items-center gap-2 text-left", active && "!border-primary-300 !bg-primary-50 !text-primary-800")
    : clsx(filterControl(active), "inline-flex items-center gap-1.5 whitespace-nowrap");
  return <>
    <button ref={trigger} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={active ? `${label}: ${selectedLabel}. Change` : label} onClick={() => open ? hide(false) : show()} className={clsx(triggerClass, variant === "field" && "w-full")}>
      <span className={clsx("min-w-0 truncate", variant === "field" ? "flex-1" : "max-w-44")}>{active ? (variant === "field" ? selectedLabel : `${label}: ${selectedLabel}`) : variant === "field" ? allLabel : label}</span>
      <ChevronDown size={14} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", open && "rotate-180")} />
    </button>
    {open && createPortal(<div ref={popover} id={listId} tabIndex={-1} onKeyDown={onKeyDown} aria-label={`${label} choices`} className="vso-enter-popover fixed z-[120] flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-800 shadow-e4 focus-visible:outline-none" style={{ top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }}>
      {searchable && <label className="relative block shrink-0 border-b border-neutral-100 p-2"><span className="sr-only">Search {label.toLowerCase()}</span><Search size={14} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400" /><input ref={input} value={text} onChange={(event) => { setText(event.target.value); setHighlight(0); }} placeholder={`Search ${label.toLowerCase()}…`} autoComplete="off" className="h-9 w-full rounded-lg bg-neutral-100 pl-8 pr-3 text-sm font-medium text-neutral-800 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-primary-300" /></label>}
      <div role="listbox" aria-label={label} className="thin-scroll min-h-0 flex-1 overflow-y-auto p-1">
        {rows.map((row, index) => {
          const selected = (row.value === "" && !value) || (!!value && row.value.toLowerCase() === value.toLowerCase());
          return <button key={`${row.value}-${index}`} type="button" role="option" aria-selected={selected} data-row={index} onClick={() => choose(row.value)} onMouseMove={() => setHighlight(index)} className={clsx("flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium", index === highlight ? "bg-primary-50 text-primary-800" : "hover:bg-neutral-100", selected && "font-semibold", row.value === "none" && "text-neutral-500")}>
            <span className="min-w-0 flex-1 truncate">{row.label}{row.hint && <span className="ml-1.5 text-xs font-medium text-neutral-400">{row.hint}</span>}</span>
            {row.count !== undefined && <span className="shrink-0 text-xs font-semibold text-neutral-400 tnum">{number(row.count)}</span>}
            {selected && <Check size={14} aria-hidden="true" className="shrink-0 text-primary-700" />}
          </button>;
        })}
        {needle && shown.length === 0 && <p className="px-3 py-6 text-center text-sm text-neutral-400">No {label.toLowerCase()} matches “{text.trim()}”.</p>}
        {matches.length > SHOWN && <p className="px-3 py-2 text-center text-[11px] font-medium text-neutral-400">Showing the top {SHOWN} of {number(matches.length)}. Type to narrow the list.</p>}
      </div>
    </div>, document.body)}
  </>;
}
