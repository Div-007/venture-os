"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { BULK_MAX, type Lead } from "@venture-studio/contracts";
import { Check, Download, Filter, Inbox, Plus, Search, Sparkles, Upload, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Badge, DetailDrawer, Field, filterControl, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { exportLeadsCsv, listLeads, listPlays } from "@/lib/sales-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { useSalesOverview } from "@/components/sales/overview-context";
import { LeadCreate } from "@/components/sales/lead-create";
import { LeadBulkBar, type BulkTarget } from "@/components/sales/lead-bulk-bar";
import { LeadImportDrawer } from "@/components/sales/lead-import-drawer";
import { LeadViews, VIEW_KEYS, type ViewFilters } from "@/components/sales/lead-views";
import { PopAvatar, PopCard } from "@/components/sales/pop-card";
import { FacetPicker } from "@/components/sales/lead-facet-picker";
import { categoryOptions, CONTACT_FILTERS, isContactFilter, offerFilterUseful, offerOptions, PlaceFilters, useLeadFacets, type FacetFilters } from "@/components/sales/lead-filters";
import { openOffers, useVentureOffers } from "@/components/sales/offer-model";
import {
  canCreateLeads, FilterChip, isOverdue, Lock, number, OfferChip, PersonChip, plural, Phone, callablePhone, stageGroup, StageChip, STAGE_GROUPS, stageList, telHref, timeAgo, useDebounced, useUrlParams, VerdictChip, when,
} from "@/components/sales/sales-ui";

const PAGE = 50;
const KEEP_MAX = 300;
type Verdict = "recommend" | "hold" | "reject" | "none";
type Sort = "updated" | "next" | "relevance" | "name";
const SORTS: { value: Sort; label: string }[] = [{ value: "updated", label: "Recently updated" }, { value: "next", label: "Next action" }, { value: "relevance", label: "Best fit first" }, { value: "name", label: "Name A to Z" }];
type Query = FacetFilters & { sort: Sort };
const VERDICT_LABELS: Record<Verdict, string> = { recommend: "Claude: go", hold: "Claude: hold", reject: "Claude: no", none: "Not judged" };

/** Reads the first pages again up to the number already on screen, so a reload never collapses the list. */
async function fetchUpTo(query: Query, count: number) {
  const first = await listLeads({ ...query, offset: 0, limit: Math.min(100, Math.max(PAGE, count)) });
  let items = first.items;
  while (items.length < Math.min(count, first.total, KEEP_MAX)) {
    const next = await listLeads({ ...query, offset: items.length, limit: Math.min(100, count - items.length) });
    if (!next.items.length) break;
    items = [...items, ...next.items];
  }
  return { items, total: first.total };
}

function NextCell({ lead }: { lead: Lead }) {
  if (!lead.nextAction && !lead.nextActionAt) return <span className="text-neutral-300">None</span>;
  const overdue = isOverdue(lead.nextActionAt);
  return <span className="block min-w-0"><span className="line-clamp-2 block text-[13px] font-medium leading-5 text-neutral-700">{lead.nextAction || "Follow up"}</span>{lead.nextActionAt && <span className={clsx("block text-xs font-semibold", overdue ? "text-danger-text" : "text-neutral-400")}>{overdue ? "Overdue · " : ""}{when(lead.nextActionAt)}</span>}</span>;
}

function Flags({ lead }: { lead: Lead }) {
  return <>{lead.needsYou && <Badge tone="amber">Needs you</Badge>}{lead.doNotContact && <span title="Do not contact" className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger-text"><Lock size={12} />Do not contact</span>}</>;
}

/** A row checkbox with a 40px hit area; clicking it never opens the lead. */
function RowCheck({ checked, label, onChange, indeterminate = false }: { checked: boolean; label: string; onChange: () => void; indeterminate?: boolean }) {
  return <label onClick={(event) => event.stopPropagation()} className="-my-2 -ml-2 grid h-10 w-10 cursor-pointer place-items-center rounded-lg transition-colors duration-150 hover:bg-neutral-100">
    <input type="checkbox" checked={checked} aria-label={label} ref={(element) => { if (element) element.indeterminate = indeterminate; }} onChange={onChange} className="h-4 w-4 cursor-pointer accent-[var(--color-primary-700)]" />
  </label>;
}

type Selection = { key: string; ids: Set<string>; all: boolean };

/** Import and Export, icon-only on phones. */
function FileButtons({ onImport, onExport, exporting, canExport, total, className }: { onImport: () => void; onExport: () => void; exporting: boolean; canExport: boolean; total: number; className?: string }) {
  return <div className={clsx("flex shrink-0 items-center gap-1.5", className)}>
    <button type="button" onClick={onImport} aria-label="Import leads from a CSV file" className={clsx(secondaryClass, "!min-w-10 !px-3")}><Upload size={15} aria-hidden="true" /><span className="max-sm:sr-only">Import</span></button>
    <button type="button" onClick={onExport} disabled={exporting || !canExport} aria-label={canExport ? `Export these ${plural(total, "lead")} as CSV` : "Export the list as CSV"} className={clsx(secondaryClass, "!min-w-10 !px-3")}><Download size={15} aria-hidden="true" /><span className="max-sm:sr-only">{exporting ? "Exporting…" : "Export"}</span></button>
  </div>;
}

/** Leads: server-side search and filters over every lead, a table on laptops and cards on phones; a row opens the lead drawer. */
export function LeadsScreen() {
  const { session, ventureId, openLead, refreshKey, refresh, personName } = useSalesShell();
  const { members } = useSalesOverview();
  const { params, update } = useUrlParams();
  const group = stageGroup(params.get("group"));
  const rawStage = params.get("stage") ?? "";
  const verdict = (["recommend", "hold", "reject", "none"] as const).find((value) => value === params.get("verdict")) ?? "";
  const needsYou = params.get("needsYou") === "true";
  const mine = params.get("mine") === "1";
  const playId = params.get("play") ?? "";
  const offerId = params.get("offer") ?? "";
  const sort = SORTS.find((item) => item.value === params.get("sort"))?.value ?? "updated";
  const selectedLead = params.get("lead");
  // Where, what and how to reach them: chosen from the counted lists, kept in the URL.
  const state = params.get("state") ?? "";
  const city = params.get("city") ?? "";
  const category = params.get("category") ?? "";
  const contactParam = params.get("contact");
  const contact = isContactFilter(contactParam) ? contactParam : "";
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [plays, setPlays] = useState<{ id: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const canCreate = !!session && canCreateLeads(session);
  // Bulk changes, import and export are for people who can change leads (not learners); assigning is a venture head's or admin's job.
  const canBulk = canCreate;
  const canAssign = !!session && (session.membership.role === "admin" || (session.membership.role === "venture_head" && (!ventureId || session.membership.ventureIds.includes(ventureId))));
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Selection>({ key: "", ids: new Set(), all: false });
  // The top bar sends people here with ?q= (search) or ?new=1 (Add lead); take the value, then clear the parameter.
  const urlQuery = params.get("q");
  const wantsNew = params.get("new") === "1";
  useEffect(() => {
    if (urlQuery === null && !wantsNew) return;
    queueMicrotask(() => {
      if (urlQuery !== null) setSearch(urlQuery);
      if (wantsNew && canCreate) setCreating(true);
      update({ q: null, new: null });
    });
  }, [urlQuery, wantsNew, canCreate, update]);

  useEffect(() => {
    let active = true;
    listPlays({ ...(ventureId ? { ventureId } : {}) }).then((items) => { if (active) setPlays(items.map(({ id, name }) => ({ id, name }))); }).catch(() => { if (active) setPlays([]); });
    return () => { active = false; };
  }, [ventureId]);

  // Counts for the dropdowns use the same filters as the list, so each one shows what choosing a value would leave.
  const facetFilters = useMemo<FacetFilters>(() => ({
    ...(ventureId ? { ventureId } : {}), ...(rawStage ? { stage: rawStage } : group ? { stage: stageList(group) } : {}), ...(q ? { q } : {}), ...(mine ? { owner: "me" as const } : {}),
    ...(needsYou ? { needsYou: "true" as const } : {}), ...(playId ? { playId } : {}), ...(offerId ? { offerId } : {}), ...(verdict ? { verdict } : {}),
    ...(state ? { region: state } : {}), ...(city ? { city } : {}), ...(category ? { category } : {}), ...(contact ? { contact } : {}),
  }), [ventureId, rawStage, group, q, mine, needsYou, playId, offerId, verdict, state, city, category, contact]);
  const query = useMemo<Query>(() => ({ ...facetFilters, sort }), [facetFilters, sort]);
  const queryKey = JSON.stringify(query);
  const { facets } = useLeadFacets(facetFilters, refreshKey);
  const industries = useMemo(() => categoryOptions(facets, category), [facets, category]);
  // Offers: names for the filter and the row chips. A row names its offer only where the venture sells more than one (in All ventures:
  // when the leads in view span more than one offer).
  const ventureOffers = useVentureOffers(ventureId || undefined, refreshKey);
  const offerNames = useMemo(() => ({ ...Object.fromEntries((facets?.offers ?? []).map((item) => [item.value, item.name])), ...Object.fromEntries((ventureOffers ?? []).map((item) => [item.id, item.name])) }) as Record<string, string>, [facets, ventureOffers]);
  const showOfferChip = ventureId ? (ventureOffers?.length ?? 0) > 1 : (facets?.offers.length ?? 0) > 1;
  const offerName = (lead: Lead) => showOfferChip && lead.offerId ? offerNames[lead.offerId] : undefined;
  const offerChoices = useMemo(() => offerOptions(facets, offerId, offerNames), [facets, offerId, offerNames]);
  const offerFilter = offerFilterUseful(facets, offerId);
  const offerNotSet = facets ? { count: facets.notSet.offers, label: "No offer" } : undefined;
  const contactOptions = CONTACT_FILTERS.map(([value, label]) => ({ value, label, count: facets ? (value === "whatsapp" ? facets.contact.whatsappOptIn : facets.contact[value]) : 0 }));
  const setPlace = ({ state: nextState, city: nextCity }: { state: string | null; city: string | null }) => update({ state: nextState, city: nextCity });

  const [result, setResult] = useState<{ key: string; items: Lead[]; total: number; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const shown = useRef({ key: "", count: 0 });

  useEffect(() => {
    let active = true;
    const keep = shown.current.key === queryKey ? shown.current.count : 0;
    queueMicrotask(() => {
      setBusy(true);
      fetchUpTo(JSON.parse(queryKey) as Query, keep).then(({ items, total }) => {
        if (!active) return;
        shown.current = { key: queryKey, count: items.length };
        setResult({ key: queryKey, items, total, error: "" }); setBusy(false);
      }).catch((cause: unknown) => {
        if (!active) return;
        const message = describeError(cause, "Could not load the leads. Try again.");
        setResult((previous) => ({ key: queryKey, items: previous?.key === queryKey ? previous.items : [], total: previous?.key === queryKey ? previous.total : 0, error: message }));
        setBusy(false);
      });
    });
    return () => { active = false; };
  // refreshKey reloads after a change anywhere in Sales; attempt is the Try again button.
  }, [queryKey, refreshKey, attempt]);

  const current = result?.key === queryKey ? result : null;
  const items = current?.items ?? [];
  const total = current?.total ?? 0;

  const more = useCallback(async () => {
    if (!current) return;
    setMoreBusy(true);
    try {
      const next = await listLeads({ ...query, offset: current.items.length, limit: PAGE });
      const known = new Set(current.items.map((lead) => lead.id));
      const merged = [...current.items, ...next.items.filter((lead) => !known.has(lead.id))];
      shown.current = { key: queryKey, count: merged.length };
      setResult({ key: queryKey, items: merged, total: next.total, error: "" });
    } catch (cause) { setResult({ ...current, error: describeError(cause, "Could not load more leads.") }); }
    finally { setMoreBusy(false); }
  }, [current, query, queryKey]);

  // The selection belongs to one set of filters, search and sort: changing any of them starts afresh, and going back to the earlier
  // filters does not bring the old ticks back. `all` means every lead the filters match.
  if (selection.key !== queryKey && (selection.all || selection.ids.size > 0)) setSelection({ key: queryKey, ids: new Set(), all: false });
  const picked: Selection = selection.key === queryKey ? selection : { key: queryKey, ids: new Set(), all: false };
  const isPicked = (leadId: string) => picked.all || picked.ids.has(leadId);
  const pickedCount = picked.all ? total : picked.ids.size;
  const showBar = canBulk && pickedCount > 0;
  const allShownPicked = items.length > 0 && items.every((lead) => isPicked(lead.id));
  const someShownPicked = items.some((lead) => isPicked(lead.id));
  const clearSelection = () => setSelection({ key: queryKey, ids: new Set(), all: false });
  const toggle = (leadId: string) => {
    const before = picked.all ? items.map((lead) => lead.id) : [...picked.ids];
    setSelection({ key: queryKey, ids: new Set(before.includes(leadId) ? before.filter((id) => id !== leadId) : [...before, leadId]), all: false });
  };
  const toggleShown = () => setSelection({ key: queryKey, ids: allShownPicked ? new Set() : new Set(items.map((lead) => lead.id)), all: false });
  const bulkTarget: BulkTarget = picked.all ? { filter: facetFilters } : { ids: [...picked.ids].slice(0, BULK_MAX) };
  // A change for all matching leads that stopped at BULK_MAX keeps the selection, so running it again takes the next ones.
  const bulkDone = (more: boolean) => { if (!more) { clearSelection(); setSelecting(false); } refresh(); };

  // Saved views: the filters in the URL (and the search box) as they are now.
  const viewFilters = useMemo<ViewFilters>(() => {
    const out: ViewFilters = {};
    for (const key of VIEW_KEYS) { const value = key === "q" ? q : params.get(key); if (value) out[key] = value; }
    return out;
  }, [params, q]);
  const applyView = (filters: ViewFilters) => {
    setSearch(filters.q ?? "");
    update(Object.fromEntries(VIEW_KEYS.filter((key) => key !== "q").map((key) => [key, filters[key] ?? null])));
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, fileName, rows, matching } = await exportLeadsCsv(query);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = fileName;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast({ title: `Exported ${plural(rows, "lead")}`, body: matching > rows ? `The first ${number(rows)} of ${number(matching)} matching. Narrow the filters for the rest.` : `${fileName}: business details only, no notes or research.` });
    } catch (cause) { toast({ tone: "error", title: "Could not export the list", body: describeError(cause, "Try again.") }); }
    finally { setExporting(false); }
  };

  const activeFilters = [group || rawStage, verdict, needsYou, mine, playId, offerId, q, state, city, category, contact].filter(Boolean).length;
  const clearAll = () => { setSearch(""); update({ group: null, stage: null, verdict: null, needsYou: null, mine: null, play: null, offer: null, state: null, city: null, category: null, contact: null }); };
  // On phones the filters live in a sheet; the ones in use also show as chips under the search box.
  const sheetCount = activeFilters - (q ? 1 : 0);
  const chips: { key: string; label: string; clear: () => void }[] = [
    ...(group ? [{ key: "stage", label: group.label, clear: () => update({ group: null, stage: null }) }] : rawStage ? [{ key: "stage", label: "Stages", clear: () => update({ stage: null }) }] : []),
    ...(verdict ? [{ key: "verdict", label: VERDICT_LABELS[verdict], clear: () => update({ verdict: null }) }] : []),
    ...(offerId ? [{ key: "offer", label: offerId === "none" ? "No offer" : offerNames[offerId] ?? "Offer", clear: () => update({ offer: null }) }] : []),
    ...(state ? [{ key: "state", label: state === "none" ? "No state" : state, clear: () => update({ state: null }) }] : []),
    ...(city ? [{ key: "city", label: city === "none" ? "No city" : city, clear: () => update({ city: null }) }] : []),
    ...(category ? [{ key: "category", label: category === "none" ? "No industry" : category, clear: () => update({ category: null }) }] : []),
    ...(contact ? [{ key: "contact", label: CONTACT_FILTERS.find(([key]) => key === contact)![1], clear: () => update({ contact: null }) }] : []),
    ...(needsYou ? [{ key: "needs", label: "Needs you", clear: () => update({ needsYou: null }) }] : []),
    ...(mine ? [{ key: "mine", label: "Mine", clear: () => update({ mine: null }) }] : []),
    ...(playId ? [{ key: "play", label: plays.find((play) => play.id === playId)?.name ?? "Play", clear: () => update({ play: null }) }] : []),
  ];
  const countText = current ? (total > items.length ? `${number(items.length)} of ${number(total)} leads` : `${number(total)} lead${total === 1 ? "" : "s"}`) : "";
  const loading = !current;

  return <div className={showBar ? "pb-48 sm:pb-24 lg:pb-0" : undefined}>
    <div className="mb-3 flex items-center gap-2">
      <label className="relative min-w-0 flex-1 basis-40 sm:basis-56"><span className="sr-only">Search leads</span><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={200} placeholder="Search company, contact or note…" className={`${inputClass} pl-10 pr-10 [&::-webkit-search-cancel-button]:appearance-none`} />{search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-neutral-400 transition-[background-color,color] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={15} /></button>}</label>
      <button type="button" onClick={() => setSheetOpen(true)} aria-haspopup="dialog" className={clsx(secondaryClass, "relative shrink-0 !px-3.5 sm:hidden", sheetCount > 0 && "!border-primary-300 !bg-primary-50 !text-primary-800")}><Filter size={16} />Filters{sheetCount > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary-700 px-1.5 text-[10px] font-bold text-white tnum" aria-label={`${sheetCount} in use`}>{sheetCount}</span>}</button>
    </div>
    {chips.length > 0 && <div role="group" aria-label="Filters in use" className="thin-scroll -mx-4 mb-2 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 sm:hidden [&>*]:shrink-0">{chips.map((chip) => <button key={chip.key} type="button" onClick={chip.clear} aria-label={`Remove filter ${chip.label}`} className="inline-flex min-h-8 items-center gap-1 rounded-full bg-primary-50 px-3 text-xs font-semibold text-primary-800 transition-[background-color,transform] duration-150 active:scale-[0.97]">{chip.label}<X size={12} aria-hidden="true" /></button>)}<button type="button" onClick={clearAll} className="inline-flex min-h-8 items-center rounded-full px-2 text-xs font-semibold text-neutral-500">Clear filters</button></div>}
    <div role="group" aria-label="Filters" className="mb-3 hidden flex-wrap items-center gap-2 sm:flex">
      <Select aria-label="Stage" className={filterControl(!!group || !!rawStage)} value={group?.key ?? ""} onChange={(event) => update({ group: event.target.value || null, stage: null })}><option value="">All stages</option>{STAGE_GROUPS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select>
      <Select aria-label="Claude's verdict" className={filterControl(!!verdict)} value={verdict} onChange={(event) => update({ verdict: event.target.value || null })}><option value="">Any verdict</option><option value="recommend">Claude: go</option><option value="hold">Claude: hold</option><option value="reject">Claude: no</option><option value="none">Not judged</option></Select>
      {offerFilter && <FacetPicker label="Offer" allLabel="All offers" value={offerId} options={offerChoices} notSet={offerNotSet} onChange={(next) => update({ offer: next || null })} />}
      <PlaceFilters facets={facets} region={state} city={city} onChange={setPlace} />
      <FacetPicker label="Industry" allLabel="All industries" value={category} options={industries} searchable notSet={facets ? { count: facets.notSet.categories, label: "Not set" } : undefined} onChange={(next) => update({ category: next || null })} />
      <FacetPicker label="Contact" allLabel="Any contact" value={contact} options={contactOptions} onChange={(next) => update({ contact: next || null })} />
      <FilterChip active={needsYou} onClick={() => update({ needsYou: needsYou ? null : "true" })}>Needs you</FilterChip>
      <FilterChip active={mine} onClick={() => update({ mine: mine ? null : "1" })}>Mine</FilterChip>
      {plays.length > 0 && <Select aria-label="Play" className={filterControl(!!playId)} value={playId} onChange={(event) => update({ play: event.target.value || null })}><option value="">Any play</option>{plays.map((play) => <option key={play.id} value={play.id}>{play.name}</option>)}</Select>}
      <Select aria-label="Sort by" className={filterControl(false)} value={sort} onChange={(event) => update({ sort: event.target.value === "updated" ? null : event.target.value })}>{SORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select>
      {activeFilters > 0 && <button type="button" onClick={clearAll} className="inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800"><X size={13} />Clear filters</button>}
      <span aria-live="polite" className="ml-auto text-xs font-semibold text-neutral-500 tnum">{countText}{busy && current ? " · updating…" : ""}</span>
    </div>
    <div className="mb-3 flex min-h-10 items-center justify-between gap-2 sm:hidden">
      <p aria-live="polite" className="min-w-0 text-xs font-semibold text-neutral-500 tnum">{countText || " "}{busy && current ? " · updating…" : ""}</p>
      {canBulk && <div className="flex shrink-0 items-center gap-1.5">
        {selecting && <button type="button" onClick={toggleShown} className="inline-flex min-h-10 items-center rounded-xl px-2.5 text-sm font-semibold text-primary-700">{allShownPicked ? "Select none" : "Select all"}</button>}
        {items.length > 0 && <button type="button" aria-pressed={selecting} onClick={() => { if (selecting) clearSelection(); setSelecting(!selecting); }} className={clsx(secondaryClass, "!min-h-10 !px-3.5")}>{selecting ? "Done" : "Select"}</button>}
        {!selecting && <FileButtons onImport={() => setImporting(true)} onExport={() => void exportCsv()} exporting={exporting} canExport={!!current && total > 0} total={total} />}
      </div>}
    </div>
    {/* Saved views (and, on laptops, Import and Export). On phones the row is left out while there is no view to show. */}
    <div className="mb-3 flex items-center gap-2 max-sm:[&:has(>div:first-child:empty)]:hidden">
      <div className="thin-scroll -mx-4 min-w-0 flex-1 overflow-x-auto px-4 py-0.5 sm:mx-0 sm:overflow-visible sm:px-0"><LeadViews filters={viewFilters} onApply={applyView} /></div>
      {canBulk && <FileButtons className="max-sm:hidden" onImport={() => setImporting(true)} onExport={() => void exportCsv()} exporting={exporting} canExport={!!current && total > 0} total={total} />}
    </div>
    {canBulk && allShownPicked && total > items.length && <div role="status" className="mb-3 flex flex-wrap items-center justify-center gap-x-2 rounded-xl bg-primary-50 px-4 py-1.5 text-center text-[13px] leading-5 text-primary-900">
      {picked.all
        ? <><span>All {number(total)} matching leads are selected{total > BULK_MAX ? `; a change applies to the ${number(BULK_MAX)} most recently updated (run it again for the next ones)` : ""}.</span><button type="button" onClick={clearSelection} className="min-h-9 font-semibold underline underline-offset-2">Clear selection</button></>
        : <><span>All {number(items.length)} leads shown are selected.</span><button type="button" onClick={() => setSelection({ key: queryKey, ids: new Set(items.map((lead) => lead.id)), all: true })} className="min-h-9 font-semibold underline underline-offset-2">Select all {number(total)} matching</button></>}
    </div>}
    <Notice tone="error" message={current?.error && items.length ? current.error : ""} onDismiss={() => setResult((previous) => previous ? { ...previous, error: "" } : previous)} className="pb-3" />

    {loading && <Panel><div role="status" aria-label="Loading leads" className="grid grid-cols-1 gap-px">{Array.from({ length: 7 }, (_, index) => <div key={index} className="flex items-center gap-4 px-5 py-4"><span className="grid flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${46 - (index % 3) * 8}%` }} /><span className="vso-skeleton h-2.5" style={{ width: `${28 - (index % 2) * 6}%` }} /></span><span className="vso-skeleton hidden h-5 w-20 sm:block" /><span className="vso-skeleton hidden h-5 w-24 md:block" /></div>)}</div></Panel>}
    {current && !current.error && items.length === 0 && <Panel>{activeFilters > 0
      ? <EmptyState variant="filtered" title="No leads match" body="Nothing fits these filters. Loosen one, or clear them all." action={{ label: "Clear filters", onClick: clearAll }} />
      : <EmptyState variant="card" icon={Inbox} tone="green" title="No leads yet" body="Ask Claude to find some, or add one by hand. Imported lists land here too." action={{ label: "Find leads", href: "/sales/live/find", icon: Sparkles }} secondary={canCreate ? { label: "Add a lead", onClick: () => setCreating(true), icon: Plus } : undefined} />}</Panel>}
    {current && current.error && items.length === 0 && <Panel><EmptyState variant="error" title="Could not load the leads" body={current.error} action={{ label: busy ? "Trying again…" : "Try again", onClick: () => setAttempt((value) => value + 1), disabled: busy }} /></Panel>}

    {items.length > 0 && <>
      <Panel className="hidden overflow-hidden md:block">
        <table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            {canBulk && <col className="w-12" />}
            <col className="w-[32%] lg:w-[28%] xl:w-[26%]" />
            <col className="w-[18%] lg:w-[15%] xl:w-[13%]" />
            <col className="w-[24%] lg:w-[25%] xl:w-[23%]" />
            <col className="w-[26%] lg:w-[21%] xl:w-[19%]" />
            <col className="hidden xl:table-column xl:w-[10%]" />
            <col className="hidden lg:table-column lg:w-[8%] xl:w-[9%]" />
          </colgroup>
          <thead><tr className="border-b border-neutral-100 text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-400">
            {canBulk && <th scope="col" className="py-3 pl-4"><RowCheck checked={allShownPicked} indeterminate={someShownPicked && !allShownPicked} label={allShownPicked ? "Clear the selection" : `Select the ${plural(items.length, "lead")} shown`} onChange={toggleShown} /></th>}
            <th scope="col" className={clsx("py-3 pr-5 font-semibold", canBulk ? "pl-2" : "pl-5")}>Company</th>
            <th scope="col" className="px-3 py-3 font-semibold">Stage</th>
            <th scope="col" className="px-3 py-3 font-semibold">Claude</th>
            <th scope="col" className="px-3 py-3 font-semibold">Next</th>
            <th scope="col" className="hidden px-3 py-3 font-semibold xl:table-cell">Owner</th>
            <th scope="col" className="hidden px-5 py-3 text-right font-semibold lg:table-cell">Updated</th>
          </tr></thead>
          <tbody className="divide-y divide-neutral-100">
            {items.map((lead) => <tr key={lead.id} data-flash-id={lead.id} onClick={() => openLead(lead.id)} className={clsx("cursor-pointer align-top transition-colors duration-150 hover:bg-neutral-50", selectedLead === lead.id ? "bg-primary-50/70 hover:bg-primary-50" : isPicked(lead.id) && "bg-primary-50/40")}>
              {canBulk && <td className="py-3.5 pl-4"><RowCheck checked={isPicked(lead.id)} label={`Select ${lead.companyName}`} onChange={() => toggle(lead.id)} /></td>}
              <td className={clsx("py-3.5 pr-5", canBulk ? "pl-2" : "pl-5")}><button type="button" onClick={(event) => { event.stopPropagation(); openLead(lead.id); }} className="block w-full min-w-0 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="block truncate text-sm font-semibold text-neutral-800">{lead.companyName}</span><span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500"><span className="truncate">{[lead.city, lead.category].filter(Boolean).join(" · ") || "No place yet"}</span>{offerName(lead) && <OfferChip name={offerName(lead)!} />}<Flags lead={lead} /></span></button></td>
              <td className="px-3 py-3.5"><StageChip stage={lead.stage} /></td>
              <td className="px-3 py-3.5"><VerdictChip verdict={lead.verdict} />{lead.verdict && <span className="mt-1 block truncate text-xs text-neutral-500" title={lead.verdict.summary}>{lead.verdict.summary}</span>}</td>
              <td className="px-3 py-3.5"><NextCell lead={lead} /></td>
              <td className="hidden px-3 py-3.5 xl:table-cell"><PersonChip name={personName(lead.ownerId)} /></td>
              <td className="hidden px-5 py-3.5 text-right text-xs font-medium text-neutral-400 lg:table-cell">{timeAgo(lead.updatedAt)}</td>
            </tr>)}
          </tbody>
        </table>
      </Panel>
      <ul aria-label="Leads" className="grid grid-cols-1 gap-2.5 md:hidden">
        {items.map((lead) => {
          const dial = callablePhone(lead);
          const tel = dial ? telHref(dial) : undefined;
          const ticked = selecting && isPicked(lead.id);
          return <li key={lead.id}><PopCard tilt={5} className="rounded-2xl"><div data-flash-id={lead.id} className={clsx("flex items-stretch rounded-2xl border bg-white shadow-card [transform-style:preserve-3d]", ticked ? "border-primary-400 bg-primary-50/40" : selectedLead === lead.id ? "border-primary-300" : "border-neutral-100")}>
            <button type="button" onClick={() => { if (selecting) toggle(lead.id); else openLead(lead.id); }} {...(selecting ? { "aria-pressed": ticked } : {})} className={clsx("min-w-0 flex-1 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:bg-neutral-50 [transform-style:preserve-3d]", tel ? "rounded-l-2xl" : "rounded-2xl")}>
              <span className="flex items-start gap-3 [transform-style:preserve-3d]">
                {selecting && <span aria-hidden="true" className={clsx("mt-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 transition-colors duration-150", ticked ? "border-primary-700 bg-primary-700 text-white" : "border-neutral-300 bg-white")}>{ticked && <Check size={13} strokeWidth={3} />}</span>}
                <PopAvatar name={lead.companyName} size="sm" />
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-bold leading-5 text-neutral-900 [overflow-wrap:anywhere]">{lead.companyName}</span><span className="mt-0.5 block truncate text-xs text-neutral-500">{[lead.city, lead.category].filter(Boolean).join(" · ") || "No place yet"}</span></span>
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-1.5"><StageChip stage={lead.stage} /><VerdictChip verdict={lead.verdict} />{offerName(lead) && <OfferChip name={offerName(lead)!} />}<Flags lead={lead} /></span>
              {(lead.nextAction || lead.nextActionAt) && <span className="mt-2 block text-xs text-neutral-600"><span className="font-medium">{lead.nextAction || "Follow up"}</span> <span className={clsx("font-semibold", isOverdue(lead.nextActionAt) ? "text-danger-text" : "text-neutral-400")}>· {when(lead.nextActionAt)}</span></span>}
            </button>
            {tel && <a href={tel} aria-label={`Call ${lead.companyName}`} className="grid w-14 shrink-0 place-items-center rounded-r-2xl border-l border-neutral-100 text-primary-700 transition-colors duration-150 hover:bg-primary-50 active:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600"><Phone size={19} /></a>}
          </div></PopCard></li>;
        })}
      </ul>
      {total > items.length && <div className="mt-4 flex flex-wrap items-center justify-center gap-3"><button type="button" onClick={() => void more()} disabled={moreBusy} className={clsx(secondaryClass, "min-w-40")}>{moreBusy ? "Loading…" : `Load ${Math.min(PAGE, total - items.length)} more`}</button><span className="text-xs font-medium text-neutral-400 tnum">{number(total - items.length)} not shown</span></div>}
    </>}
    {sheetOpen && <DetailDrawer title="Filters" subtitle={countText || undefined} onClose={() => setSheetOpen(false)}>
      <div className="grid grid-cols-1 gap-4">
        <Field label="Stage"><Select aria-label="Stage" className={inputClass} value={group?.key ?? ""} onChange={(event) => update({ group: event.target.value || null, stage: null })}><option value="">All stages</option>{STAGE_GROUPS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select></Field>
        <Field label="Claude's verdict"><Select aria-label="Claude's verdict" className={inputClass} value={verdict} onChange={(event) => update({ verdict: event.target.value || null })}><option value="">Any verdict</option><option value="recommend">Claude: go</option><option value="hold">Claude: hold</option><option value="reject">Claude: no</option><option value="none">Not judged</option></Select></Field>
        {offerFilter && <div className="grid gap-1.5"><span className="text-xs font-semibold text-neutral-600">Offer</span><FacetPicker variant="field" label="Offer" allLabel="All offers" value={offerId} options={offerChoices} notSet={offerNotSet} onChange={(next) => update({ offer: next || null })} /></div>}
        <PlaceFilters facets={facets} region={state} city={city} onChange={setPlace} variant="field" />
        <div className="grid gap-1.5"><span className="text-xs font-semibold text-neutral-600">Industry</span><FacetPicker variant="field" label="Industry" allLabel="All industries" value={category} options={industries} searchable notSet={facets ? { count: facets.notSet.categories, label: "Not set" } : undefined} onChange={(next) => update({ category: next || null })} /></div>
        <div className="grid gap-1.5"><span className="text-xs font-semibold text-neutral-600">How to reach them</span><FacetPicker variant="field" label="Contact" allLabel="Any contact" value={contact} options={contactOptions} onChange={(next) => update({ contact: next || null })} /></div>
        <div className="flex flex-wrap gap-2"><FilterChip active={needsYou} onClick={() => update({ needsYou: needsYou ? null : "true" })}>Needs you</FilterChip><FilterChip active={mine} onClick={() => update({ mine: mine ? null : "1" })}>Mine</FilterChip></div>
        {plays.length > 0 && <Field label="Play"><Select aria-label="Play" className={inputClass} value={playId} onChange={(event) => update({ play: event.target.value || null })}><option value="">Any play</option>{plays.map((play) => <option key={play.id} value={play.id}>{play.name}</option>)}</Select></Field>}
        <Field label="Sort by"><Select aria-label="Sort by" className={inputClass} value={sort} onChange={(event) => update({ sort: event.target.value === "updated" ? null : event.target.value })}>{SORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></Field>
        <div className="sticky bottom-0 -mx-5 -mb-5 flex gap-2 border-t border-neutral-100 bg-white p-4"><button type="button" onClick={() => setSheetOpen(false)} className={clsx(primaryClass, "!min-h-12 flex-1")}>{current ? `Show ${number(total)} lead${total === 1 ? "" : "s"}` : "Show leads"}</button>{activeFilters > 0 && <button type="button" onClick={clearAll} className={clsx(secondaryClass, "!min-h-12")}>Clear filters</button>}</div>
      </div>
    </DetailDrawer>}
    {creating && <LeadCreate onClose={() => setCreating(false)} onCreated={(leadId) => { setCreating(false); openLead(leadId); }} />}
    {importing && <LeadImportDrawer onClose={() => setImporting(false)} />}
    {showBar && <LeadBulkBar count={picked.all ? total : Math.min(pickedCount, BULK_MAX)} target={bulkTarget} canAssign={canAssign} members={members} plays={plays} offers={ventureId ? openOffers(ventureOffers ?? []) : null} ventureId={ventureId} onClear={() => { clearSelection(); setSelecting(false); }} onDone={bulkDone} />}
  </div>;
}
