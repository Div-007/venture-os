"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Lead, LostReason, SalesStage } from "@venture-studio/contracts";
import { ChevronDown, Inbox, Search, Sparkles, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { toast } from "@/components/ui/toast";
import { useBoardMotion } from "@/components/ui/use-board-motion";
import { Badge, inputClass, Panel, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { listLeads, updateLead } from "@/lib/sales-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { useDeliveryWork } from "@/components/sales/lead-actions";
import { PipelineCard } from "@/components/sales/pipeline-card";
import { PipelineClose } from "@/components/sales/pipeline-close";
import { canEditLead, FilterChip, moneyFull, moneyLine, moneyShort, groupOfStage, isManager, isWonStage, number, STAGE_GROUPS, stageList, useDebounced, useUrlParams, type StageGroup, type StageGroupKey } from "@/components/sales/sales-ui";
import { FacetPicker } from "@/components/sales/lead-facet-picker";
import { offerFilterUseful, offerOptions, PlaceFilters, useLeadFacets } from "@/components/sales/lead-filters";

const PAGE = 20;
type Totals = NonNullable<Awaited<ReturnType<typeof listLeads>>["totals"]>;
type Col = { items: Lead[]; total: number; ready: boolean; error: string; totals?: Totals };
type Columns = Record<StageGroupKey, Col>;
const blank: Col = { items: [], total: 0, ready: false, error: "" };
const blankColumns = () => Object.fromEntries(STAGE_GROUPS.map((group) => [group.key, blank])) as Columns;
type Filters = { ventureId?: string; q?: string; owner?: "me"; offerId?: string; region?: string; city?: string };

const fetchColumn = async (group: StageGroup, filters: Filters, limit: number, offset = 0): Promise<Col> => {
  const page = await listLeads({ ...filters, stage: stageList(group), sort: "updated", offset, limit, totals: "true" });
  return { items: page.items, total: page.total, ready: true, error: "", ...(page.totals ? { totals: page.totals } : {}) };
};

/** Takes the lead out of whichever column holds it and puts the (moved) copy at the top of its new column. */
function place(columns: Columns, next: Lead): Columns {
  const target = groupOfStage(next.stage).key;
  const result = { ...columns };
  for (const group of STAGE_GROUPS) {
    const column = columns[group.key];
    if (column.items.some((item) => item.id === next.id)) result[group.key] = { ...column, items: column.items.filter((item) => item.id !== next.id), total: Math.max(0, column.total - 1) };
  }
  const column = result[target];
  result[target] = { ...column, items: [next, ...column.items], total: column.total + 1 };
  return result;
}
const swapIn = (columns: Columns, saved: Lead): Columns => Object.fromEntries(STAGE_GROUPS.map((group) => [group.key, { ...columns[group.key], items: columns[group.key].items.map((item) => item.id === saved.id ? saved : item) }])) as Columns;

/** "₹12.4L · 6 deals": the value of the column's leads and how many deals it holds (full amounts on hover). */
function ColumnMoney({ column }: { column: Col }) {
  const rows = (column.totals?.byCurrency ?? []).filter((row) => row.valueMinor > 0);
  const deals = `${number(column.total)} deal${column.total === 1 ? "" : "s"}`;
  const full = rows.map((row) => `${moneyFull(row.valueMinor, row.currency)} (weighted ${moneyFull(row.weightedMinor, row.currency)})`).join(" + ");
  return <span className="mt-0.5 block truncate text-xs font-medium text-neutral-500 tnum" title={full || undefined}>{rows.length ? `${rows.map((row) => moneyShort(row.valueMinor, row.currency)).join(" + ")} · ${deals}` : deals}</span>;
}

/** The 7-column board. Drag a card to another column to change its stage; phones switch columns with tabs and move cards with a select. */
export function PipelineScreen() {
  const { session, ventureId, openLead, refresh, refreshKey, personName } = useSalesShell();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [mine, setMine] = useState(false);
  // State and city come from the counted lists and live in the URL, like on Leads.
  const { params, update } = useUrlParams();
  const state = params.get("state") ?? "";
  const city = params.get("city") ?? "";
  const offerId = params.get("offer") ?? "";
  const [closedOpen, setClosedOpen] = useState(false);
  const [mobileGroup, setMobileGroup] = useState<StageGroupKey>("new");
  const [board, setBoard] = useState<{ key: string; columns: Columns }>({ key: "", columns: blankColumns() });
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [closing, setClosing] = useState<Lead | null>(null);
  const [moreBusy, setMoreBusy] = useState<StageGroupKey | "">("");
  const filters = useMemo<Filters>(() => ({ ...(ventureId ? { ventureId } : {}), ...(q ? { q } : {}), ...(mine ? { owner: "me" as const } : {}), ...(offerId ? { offerId } : {}), ...(state ? { region: state } : {}), ...(city ? { city } : {}) }), [ventureId, q, mine, offerId, state, city]);
  const filterKey = JSON.stringify(filters);
  const { facets } = useLeadFacets(filters, refreshKey);
  const offerNames = useMemo(() => Object.fromEntries((facets?.offers ?? []).map((item) => [item.value, item.name])) as Record<string, string>, [facets]);
  const offerChoices = useMemo(() => offerOptions(facets, offerId, offerNames), [facets, offerId, offerNames]);
  const latest = useRef({ board, closedOpen });
  useEffect(() => { latest.current = { board, closedOpen }; });
  const { create: handOver, busyId } = useDeliveryWork(refresh);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      const { board: previous, closedOpen: showClosed } = latest.current;
      const keep = (group: StageGroup) => previous.key === filterKey ? previous.columns[group.key].items.length : 0;
      Promise.all(STAGE_GROUPS.map((group) => {
        const limit = group.key === "closed" && !showClosed ? 1 : Math.min(100, Math.max(PAGE, keep(group)));
        return fetchColumn(group, JSON.parse(filterKey) as Filters, limit).then((column): [StageGroupKey, Col] => [group.key, column])
          .catch((cause: unknown): [StageGroupKey, Col] => [group.key, { ...blank, ready: true, error: describeError(cause, "Could not load this column.") }]);
      })).then((entries) => {
        if (!active) return;
        setBoard({ key: filterKey, columns: Object.fromEntries(entries) as Columns }); setBusy(false);
      });
    });
    return () => { active = false; };
  }, [filterKey, refreshKey, attempt]);

  const ready = board.key === filterKey;
  const columns = board.columns;
  const canMove = useCallback((lead: Lead) => !!session && canEditLead(session, lead), [session]);
  const findLead = (id: string) => STAGE_GROUPS.flatMap((group) => columns[group.key].items).find((item) => item.id === id);

  /** Moves the card at once and saves in the background; a failed save glides it back. */
  async function moveLead(lead: Lead, stage: SalesStage, exitReason?: string, lostReason?: LostReason): Promise<boolean> {
    const moved: Lead = { ...lead, stage, ...(exitReason ? { exitReason } : {}), ...(lostReason ? { lostReason } : {}) };
    setBoard((current) => ({ ...current, columns: place(current.columns, moved) }));
    setPending((current) => new Set(current).add(lead.id));
    try {
      const saved = await updateLead(lead.id, { stage, ...(exitReason ? { exitReason } : {}), ...(lostReason ? { lostReason } : {}) });
      setBoard((current) => ({ ...current, columns: swapIn(current.columns, saved) }));
      if (isWonStage(stage) && !isWonStage(lead.stage)) toast({ title: `Won: ${lead.companyName}`, body: "Hand it over so delivery can start.", duration: 9000, action: { label: "Create delivery work", onClick: () => void handOver(lead.id, lead.companyName) } });
      else toast({ title: "Stage changed", body: `${lead.companyName} · ${STAGE_GROUPS.find((group) => group.stages.includes(stage))?.label}` });
      refresh();
      return true;
    } catch (cause) {
      capture();
      setBoard((current) => ({ ...current, columns: place(current.columns, lead) }));
      toast({ tone: "error", title: "Could not change the stage", body: describeError(cause, "The change was not saved.") });
      return false;
    } finally { setPending((current) => { const next = new Set(current); next.delete(lead.id); return next; }); }
  }

  const { rootRef, capture, cardProps, columnProps, draggingId, overColumn } = useBoardMotion<StageGroupKey>((id, column) => {
    const lead = findLead(id);
    const target = STAGE_GROUPS.find((group) => group.key === column);
    if (!lead || !target || pending.has(id) || !canMove(lead) || groupOfStage(lead.stage).key === column) return false;
    // Closing needs a reason, so ask first; the card stays where it is until then.
    if (!target.dropStage) { setClosing(lead); return false; }
    void moveLead(lead, target.dropStage);
    return true;
  }, { scrollAxis: "x" });

  function moveToGroup(lead: Lead, key: StageGroupKey) {
    const target = STAGE_GROUPS.find((group) => group.key === key);
    if (!target || groupOfStage(lead.stage).key === key) return;
    if (!target.dropStage) { setClosing(lead); return; }
    capture();
    void moveLead(lead, target.dropStage);
  }

  async function toggleClosed() {
    const next = !closedOpen;
    setClosedOpen(next);
    const closedGroup = STAGE_GROUPS.find((group) => group.key === "closed")!;
    if (next && columns.closed.items.length < Math.min(PAGE, columns.closed.total)) {
      try { const column = await fetchColumn(closedGroup, filters, PAGE); setBoard((current) => ({ ...current, columns: { ...current.columns, closed: column } })); }
      catch (cause) { setBoard((current) => ({ ...current, columns: { ...current.columns, closed: { ...current.columns.closed, error: describeError(cause, "Could not load closed leads.") } } })); }
    }
  }

  async function loadMore(group: StageGroup) {
    const column = columns[group.key];
    setMoreBusy(group.key);
    try {
      const page = await fetchColumn(group, filters, PAGE, column.items.length);
      const known = new Set(column.items.map((item) => item.id));
      setBoard((current) => ({ ...current, columns: { ...current.columns, [group.key]: { ...page, items: [...current.columns[group.key].items, ...page.items.filter((item) => !known.has(item.id))] } } }));
    } catch (cause) { toast({ tone: "error", title: "Could not load more", body: describeError(cause, "Try again.") }); }
    finally { setMoreBusy(""); }
  }

  const totals = STAGE_GROUPS.reduce((sum, group) => sum + columns[group.key].total, 0);
  // Open money: everything before Won and Closed. Weighted = value x the lead's chance (its own, else its stage's).
  const openMoney = (key: "valueMinor" | "weightedMinor") => {
    const byCurrency = new Map<string, number>();
    for (const group of STAGE_GROUPS) if (group.key !== "won" && group.key !== "closed") for (const row of columns[group.key].totals?.byCurrency ?? []) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row[key]);
    return [...byCurrency].map(([currency, minor]) => ({ currency, minor }));
  };
  const openValue = openMoney("valueMinor"), openWeighted = openMoney("weightedMinor");
  const failed = ready && STAGE_GROUPS.every((group) => columns[group.key].error);
  const filtered = !!(q || mine || offerId || state || city);

  if (failed) return <Panel><EmptyState variant="error" title="Could not load the pipeline" body={columns.new.error} action={{ label: busy ? "Trying again…" : "Try again", onClick: () => setAttempt((value) => value + 1), disabled: busy }} /></Panel>;

  return <div>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Search the board</span><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={200} placeholder="Search the board…" className={`${inputClass} pl-10 pr-10 [&::-webkit-search-cancel-button]:appearance-none`} />{search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-neutral-400 transition-[background-color,color] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={15} /></button>}</label>
      <FilterChip active={mine} onClick={() => setMine(!mine)}>Mine</FilterChip>
      {offerFilterUseful(facets, offerId) && <FacetPicker label="Offer" allLabel="All offers" value={offerId} options={offerChoices} notSet={facets ? { count: facets.notSet.offers, label: "No offer" } : undefined} onChange={(next) => update({ offer: next || null })} />}
      <PlaceFilters facets={facets} region={state} city={city} onChange={({ state: nextState, city: nextCity }) => update({ state: nextState, city: nextCity })} />
      {filtered && <button type="button" onClick={() => { setSearch(""); setMine(false); update({ offer: null, state: null, city: null }); }} className="inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800"><X size={13} />Clear filters</button>}
      <span aria-live="polite" className="ml-auto text-xs font-semibold text-neutral-500 tnum">{ready ? `${number(totals)} lead${totals === 1 ? "" : "s"}` : ""}{ready && openValue.some((row) => row.minor > 0) && <> · <span title={`${moneyLine(openValue, false)} open, ${moneyLine(openWeighted, false)} weighted`}>open {moneyLine(openValue)} · weighted {moneyLine(openWeighted)}</span></>}{busy && ready ? " · updating…" : ""}</span>
    </div>

    {ready && totals === 0 && !filtered && !busy
      ? <Panel><EmptyState variant="card" icon={Inbox} tone="green" title="Nothing on the board yet" body="Leads show up here as they are found or added, and move right as deals progress." action={{ label: "Find leads", href: "/sales/live/find", icon: Sparkles }} secondary={{ label: "See all leads", href: "/sales/live/leads" }} /></Panel>
      : <>
        <SlidingTabs fitContent label="Pipeline columns" className="mb-3 md:hidden" active={mobileGroup} onChange={(key) => setMobileGroup(key as StageGroupKey)} tabs={STAGE_GROUPS.map((group) => ({ key: group.key, label: group.label, ...(ready ? { badge: columns[group.key].total } : {}) }))} />
        <div ref={rootRef} className="vso-fade-enter thin-scroll md:flex md:max-h-[max(28rem,calc(100dvh-16rem))] md:items-stretch md:gap-3 md:overflow-auto md:pb-1">
          {STAGE_GROUPS.map((group) => {
            const column = columns[group.key];
            const cards = column.items;
            const collapsed = group.key === "closed" && !closedOpen;
            const over = overColumn === group.key && !!draggingId && !cards.some((item) => item.id === draggingId);
            return <div key={group.key} className={clsx("min-w-0 md:min-w-[236px] md:basis-[236px]", collapsed ? "md:flex-none md:self-start" : "md:flex-1", group.key !== mobileGroup && "max-md:hidden")} {...columnProps(group.key)}>
              <Panel className={clsx("min-h-24 min-w-0 p-3 transition-[border-color,box-shadow] duration-150 md:h-full md:min-h-48", over && "border-primary-500 ring-2 ring-primary-300", collapsed && "md:!h-auto md:!min-h-0")}>
                <h2 className={clsx("md:sticky md:top-0 md:z-10 md:-mx-3 md:-mt-3 md:rounded-t-2xl md:bg-white md:px-3 md:pb-2 md:pt-3", !collapsed && "mb-1")}>{group.key === "closed"
                  ? <button type="button" aria-expanded={!collapsed} onClick={() => void toggleClosed()} className="flex w-full items-center justify-between gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="text-sm font-semibold text-neutral-800">{group.label}</span><span className="flex items-center gap-2"><Badge>{ready ? number(column.total) : "–"}</Badge><ChevronDown size={15} aria-hidden="true" className={clsx("text-neutral-400 transition-transform duration-200", !collapsed && "rotate-180")} /></span></button>
                  : <span className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-neutral-800">{group.label}</span><Badge>{ready ? <span key={column.total} className="vso-label-swap tnum">{number(column.total)}</span> : "–"}</Badge></span>}
                  {ready && !collapsed && <ColumnMoney column={column} />}</h2>
                {!ready && !collapsed && <div role="status" aria-label={`Loading ${group.label}`} className="grid grid-cols-1 gap-2"><span className="vso-skeleton h-20 rounded-xl" /><span className="vso-skeleton h-16 rounded-xl" /></div>}
                {ready && !collapsed && <>
                  {column.error && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-xs font-semibold leading-5 text-danger-text">{column.error} <button type="button" onClick={() => setAttempt((value) => value + 1)} className="underline underline-offset-2">Try again</button></p>}
                  {cards.map((lead) => {
                    const movable = canMove(lead) && !pending.has(lead.id);
                    return <PipelineCard key={lead.id} lead={lead} ownerName={personName(lead.ownerId)} movable={movable} pending={pending.has(lead.id)} dragging={draggingId === lead.id} dragActive={!!draggingId} flipProps={cardProps(lead.id, movable)} onOpen={() => openLead(lead.id)} onMove={(key) => moveToGroup(lead, key)}
                      canHandOver={(!!session && isManager(session, lead.ventureId)) || canMove(lead)} handingOver={busyId === lead.id} onHandOver={() => void handOver(lead.id, lead.companyName)} />;
                  })}
                  {over && <div aria-hidden="true" className="vso-fade-enter grid min-h-14 place-items-center rounded-xl border-2 border-dashed border-primary-300 bg-primary-50 text-xs font-semibold text-primary-700">Drop here</div>}
                  {!cards.length && !over && !column.error && <EmptyState variant="column" title={filtered ? "No matches" : group.key === "closed" ? "Nothing closed" : "Drop a lead here"} />}
                  {column.total > cards.length && <button type="button" disabled={moreBusy === group.key} onClick={() => void loadMore(group)} className={clsx(secondaryClass, "mt-1 w-full !min-h-9 !text-xs")}>{moreBusy === group.key ? "Loading…" : `Load ${Math.min(PAGE, column.total - cards.length)} more`}</button>}
                </>}
              </Panel>
            </div>;
          })}
        </div>
      </>}
    {closing && <PipelineClose lead={closing} onCancel={() => setClosing(null)} onConfirm={async (stage, reason, lostReason) => { const lead = closing; setClosing(null); capture(); await moveLead(lead, stage, reason, lostReason); }} />}
  </div>;
}
