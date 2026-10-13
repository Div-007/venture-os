"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Bookmark, Plus, X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { deleteView, listViews, saveView, type SavedView } from "@/lib/sales-api";

/** The Leads URL parameters a saved view is made of (`q` is the search box). */
export const VIEW_KEYS = ["group", "stage", "verdict", "needsYou", "mine", "play", "offer", "state", "city", "category", "contact", "sort", "q"] as const;
export type ViewFilters = Record<string, string>;

const sameFilters = (a: ViewFilters, b: ViewFilters) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => (a[key] ?? "") === (b[key] ?? ""));
const chipHeight = "min-h-10 sm:min-h-9";

/**
 * Saved views: each person's named sets of Leads filters, as chips above the list. A chip applies its filters (tapping the active
 * one clears them); "Save this view" appears once filters are in use and names them. At most 20 per person (the API refuses more).
 */
export function LeadViews({ filters, onApply }: { filters: ViewFilters; onApply: (filters: ViewFilters) => void }) {
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    listViews().then((items) => { if (active) setViews(items); }).catch(() => { if (active) setViews([]); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (naming) input.current?.focus(); }, [naming]);

  const list = views ?? [];
  const current = list.find((view) => sameFilters(view.filters, filters));
  const inUse = Object.keys(filters).length > 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const label = name.trim();
    if (!label) return;
    setBusy(true);
    try {
      const view = await saveView({ name: label, page: "leads", filters });
      setViews((previous) => { const rest = (previous ?? []).filter((item) => item.id !== view.id); return [...rest, view].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); });
      toast({ title: "View saved", body: `“${view.name}” is a chip above the list now.` });
      setNaming(false); setName("");
    } catch (cause) { toast({ tone: "error", title: "Could not save the view", body: describeError(cause, "Try again.") }); }
    finally { setBusy(false); }
  }

  async function remove(view: SavedView) {
    setViews((previous) => (previous ?? []).filter((item) => item.id !== view.id));
    try {
      await deleteView(view.id);
      toast({ title: "View deleted", body: `“${view.name}”`, action: { label: "Undo", onClick: () => { void saveView({ name: view.name, page: "leads", filters: view.filters }).then((restored) => setViews((previous) => [...(previous ?? []), restored])).catch(() => undefined); } } });
    } catch (cause) {
      setViews((previous) => previous && !previous.some((item) => item.id === view.id) ? [...previous, view].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : previous);
      toast({ tone: "error", title: "Could not delete the view", body: describeError(cause, "Try again.") });
    }
  }

  if (!list.length && !inUse && !naming) return null;
  return <div role="group" aria-label="Saved views" className="flex min-w-0 items-center gap-1.5 sm:flex-wrap [&>*]:shrink-0">
    {list.map((view) => {
      const active = current?.id === view.id;
      return <span key={view.id} className={clsx("inline-flex max-w-56 items-center rounded-full border text-[13px] font-semibold transition-colors duration-150", chipHeight, active ? "border-primary-300 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300")}>
        <button type="button" aria-pressed={active} title={active ? "Showing this view: tap to clear its filters" : `Show ${view.name}`} onClick={() => onApply(active ? {} : view.filters)} className={clsx("inline-flex min-w-0 items-center gap-1.5 rounded-full pl-3.5 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", chipHeight)}><Bookmark size={13} aria-hidden="true" className="shrink-0" /><span className="truncate">{view.name}</span></button>
        <button type="button" aria-label={`Delete view ${view.name}`} onClick={() => void remove(view)} className={clsx("grid w-8 shrink-0 place-items-center rounded-full text-neutral-400 transition-colors duration-150 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", chipHeight)}><X size={13} /></button>
      </span>;
    })}
    {naming
      ? <form onSubmit={(event) => void save(event)} className="inline-flex items-center gap-1.5">
        <label className="sr-only" htmlFor="lead-view-name">Name for this view</label>
        <input id="lead-view-name" ref={input} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setNaming(false); setName(""); } }} placeholder="Name this view" className={clsx("w-40 rounded-full border border-primary-300 bg-white px-3.5 text-[13px] font-semibold text-neutral-800 outline-none focus:ring-2 focus:ring-primary-600", chipHeight)} />
        <button type="submit" disabled={busy || !name.trim()} className={clsx("inline-flex items-center rounded-full bg-primary-700 px-3.5 text-[13px] font-semibold text-white transition-[background-color,opacity] duration-150 hover:bg-primary-800 disabled:opacity-50", chipHeight)}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" onClick={() => { setNaming(false); setName(""); }} className={clsx("inline-flex items-center rounded-full px-2.5 text-[13px] font-semibold text-neutral-500 hover:text-neutral-800", chipHeight)}>Cancel</button>
      </form>
      : inUse && !current && <button type="button" onClick={() => setNaming(true)} className={clsx("inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 px-3.5 text-[13px] font-semibold text-neutral-600 transition-colors duration-150 hover:border-primary-300 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600", chipHeight)}><Plus size={13} aria-hidden="true" />Save this view</button>}
  </div>;
}
