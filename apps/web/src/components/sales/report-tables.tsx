"use client";
import clsx from "clsx";
import type { SalesReport } from "@venture-studio/contracts";
import { ArrowRight } from "@/components/ui/icons";
import { StageChip } from "@/components/sales/sales-ui";
import { RateValue, StatValue, WillAppear, count, days, percent } from "./report-shared";

// The Reports tab's tables. Each has a phone layout (stacked rows) and a laptop layout (a dense table); numbers stay honest.

type FunnelRow = SalesReport["funnel"]["by"]["source"][number];
type Calibration = SalesReport["calibration"];
type Cell = Calibration["grid"][number];

const th = "px-3 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.07em] text-neutral-400";
const td = "px-3 py-2.5 text-[12.5px] font-medium text-neutral-700";

/** Where leads come from: one row per source, play, owner or city. */
export function BreakdownTable({ rows, noun }: { rows: FunnelRow[]; noun: string }) {
  if (!rows.length) return <WillAppear title={`No ${noun} to compare yet`} body="Once leads are added or worked in this period, each row shows how many were contacted, replied, met, got a proposal and were won, with the reply rate (shown from 5 contacted leads up)." />;
  const columns: [keyof FunnelRow, string][] = [["leads", "Leads"], ["contacted", "Contacted"], ["replied", "Replied"], ["meetings", "Meetings"], ["proposals", "Proposals"], ["won", "Won"], ["lostOrDisqualified", "Closed"]];
  return <>
    <div className="thin-scroll -mx-5 hidden overflow-x-auto md:block">
      <table className="w-full min-w-[640px] border-collapse">
        <thead className="bg-neutral-50/80"><tr><th scope="col" className={clsx(th, "pl-5 text-left")}>{noun}</th>{columns.map(([key, label]) => <th key={key} scope="col" className={clsx(th, "text-right")}>{label}</th>)}<th scope="col" className={clsx(th, "pr-5 text-right")}>Reply rate</th></tr></thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((row) => <tr key={row.key} className="transition-colors duration-100 hover:bg-neutral-50">
            <th scope="row" className={clsx(td, "max-w-[16rem] truncate pl-5 text-left font-semibold text-neutral-900")} title={row.label}>{row.label}</th>
            {columns.map(([key]) => <td key={key} className={clsx(td, "tnum text-right", row[key] === 0 && "text-neutral-300")}>{count(row[key] as number)}</td>)}
            <td className={clsx(td, "pr-5 text-right")}><RateValue rate={row.replyRate} className="items-end" /></td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <ul className="divide-y divide-neutral-100 md:hidden">
      {rows.map((row) => <li key={row.key} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-neutral-900">{row.label}</p>
          <p className="tnum mt-0.5 text-xs leading-5 text-neutral-500">{count(row.leads)} leads · {count(row.contacted)} contacted · {count(row.replied)} replied · {count(row.meetings)} met · {count(row.won)} won{row.lostOrDisqualified ? ` · ${count(row.lostOrDisqualified)} closed` : ""}</p>
        </div>
        <RateValue rate={row.replyRate} className="shrink-0 items-end" />
      </li>)}
    </ul>
  </>;
}

/** How long open leads have waited in their current step. */
export function AgingTable({ groups }: { groups: SalesReport["stageAging"]["groups"] }) {
  return <table className="w-full border-collapse">
    <thead><tr className="border-b border-neutral-100"><th scope="col" className={clsx(th, "pl-0 text-left")}>Step</th><th scope="col" className={clsx(th, "text-right")}>Open</th><th scope="col" className={clsx(th, "text-right")}>Median wait</th><th scope="col" className={clsx(th, "pr-0 text-right")}>9 in 10 within</th></tr></thead>
    <tbody className="divide-y divide-neutral-100">
      {groups.map((group) => <tr key={group.key}>
        <th scope="row" className={clsx(td, "pl-0 text-left font-semibold text-neutral-900")}>{group.label}</th>
        <td className={clsx(td, "tnum text-right", group.open === 0 && "text-neutral-300")}>{count(group.open)}</td>
        <td className={clsx(td, "text-right")}>{group.open ? <StatValue stat={group.medianDays} format={days} /> : <span className="text-neutral-300">—</span>}</td>
        <td className={clsx(td, "pr-0 text-right")}>{group.open ? <StatValue stat={group.p90Days} format={days} /> : <span className="text-neutral-300">—</span>}</td>
      </tr>)}
    </tbody>
  </table>;
}

/** The open leads (contacted or further) that have waited longest; a row opens the lead. */
export function OldestList({ rows, onOpen, personName }: { rows: SalesReport["stageAging"]["oldest"]; onOpen: (leadId: string) => void; personName: (id: string) => string }) {
  if (!rows.length) return <WillAppear title="No contacted leads waiting" body="Leads that were contacted and have not moved on show up here, longest wait first, so nothing goes cold unnoticed." />;
  return <ul className="space-y-1.5">
    {rows.map((row) => <li key={row.leadId}><button type="button" onClick={() => onOpen(row.leadId)} className="group flex min-h-12 w-full items-center gap-3 rounded-xl bg-neutral-50 px-3 py-2 text-left transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]">
      <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-semibold text-neutral-800">{row.companyName}</span><span className="mt-0.5 block truncate text-[11px] font-medium text-neutral-500">{personName(row.ownerId)} · waiting {days(row.days)}</span></span>
      <StageChip stage={row.stage} />
      <ArrowRight size={14} className="shrink-0 text-neutral-300 transition-colors group-hover:text-neutral-600" />
    </button></li>)}
  </ul>;
}

const DECISIONS = [["recommend", "Go"], ["hold", "Hold"], ["reject", "No"]] as const;
const CONFIDENCES = [["high", "High"], ["medium", "Medium"], ["low", "Low"]] as const;
function CellBody({ cell }: { cell: Cell }) {
  if (cell.n === 0) return <span className="text-xs font-medium text-neutral-300">none</span>;
  const parts = [[cell.won, "won"], [cell.meeting, "met"], [cell.replied, "replied"], [cell.open, "open"], [cell.lost, "lost"], [cell.disqualified, "no fit"]] as const;
  return <div className="space-y-1.5">
    <p className="text-xs font-bold text-neutral-900">{count(cell.n)} judged · {count(cell.contacted)} contacted</p>
    <p className="tnum text-[11px] leading-4 text-neutral-500">{parts.filter(([value]) => value > 0).map(([value, label]) => `${count(value)} ${label}`).join(" · ")}</p>
    <div className="flex items-baseline gap-1.5"><span className="text-[11px] font-medium text-neutral-500">Replied</span><RateValue rate={cell.replyRate} /></div>
  </div>;
}

/** Claude's decisions against its confidence, with what happened to the leads. */
export function CalibrationGrid({ grid }: { grid: Cell[] }) {
  const cell = (decision: string, confidence: string) => grid.find((row) => row.decision === decision && row.confidence === confidence);
  return <>
    <div className="thin-scroll -mx-5 hidden overflow-x-auto md:block">
      <table className="w-full min-w-[640px] table-fixed border-collapse">
        <thead><tr className="border-b border-neutral-100"><th scope="col" className={clsx(th, "w-28 pl-5 text-left")}>Claude said</th>{CONFIDENCES.map(([key, label]) => <th key={key} scope="col" className={clsx(th, "text-left")}>{label} confidence</th>)}</tr></thead>
        <tbody className="divide-y divide-neutral-100">
          {DECISIONS.map(([decision, label]) => <tr key={decision}>
            <th scope="row" className={clsx(td, "pl-5 text-left align-top text-sm font-bold text-neutral-900")}>{label}</th>
            {CONFIDENCES.map(([confidence]) => { const value = cell(decision, confidence); return <td key={confidence} className={clsx(td, "align-top")}>{value ? <CellBody cell={value} /> : null}</td>; })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <ul className="space-y-2 md:hidden">
      {DECISIONS.flatMap(([decision, label]) => CONFIDENCES.map(([confidence, level]) => ({ value: cell(decision, confidence), label: `${label} · ${level.toLowerCase()} confidence` })))
        .filter((item) => item.value && item.value.n > 0).map((item) => <li key={item.label} className="rounded-xl bg-neutral-50 px-3 py-2.5"><p className="mb-1 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-400">{item.label}</p><CellBody cell={item.value!} /></li>)}
    </ul>
  </>;
}

/** People overriding Claude, newest first, with their reasons. */
export function OverrideList({ overrides, onOpen, personName }: { overrides: Calibration["overrides"]; onOpen: (leadId: string) => void; personName: (id: string) => string }) {
  const word = { recommend: "go", hold: "hold", reject: "no" } as const;
  if (!overrides.recent.length) return <WillAppear title="No overrides in this period" body="When someone disagrees with Claude's verdict and changes it, the reason lands here. Many overrides in one direction is a sign to adjust the offer's gates." />;
  return <ul className="divide-y divide-neutral-100">
    {overrides.recent.map((row) => <li key={row.verdictId} className="py-2.5 first:pt-0 last:pb-0">
      <button type="button" onClick={() => onOpen(row.leadId)} className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"><span className="truncate text-[12.5px] font-semibold text-neutral-900">{row.companyName}</span><span className="text-[11px] font-semibold text-neutral-500">{word[row.decision]} ({row.confidence}) → {word[row.to]}</span></span>
        <span className="mt-0.5 block text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">“{row.reason}” <span className="text-neutral-400">· {personName(row.by)}</span></span>
      </button>
    </li>)}
  </ul>;
}

/** The words in Claude's signals and how often those leads replied. */
export function SignalsTable({ signals }: { signals: Calibration["signals"] }) {
  if (!signals.length) return <WillAppear title="No signals to compare yet" body="Each verdict quotes a signal (hiring, a new branch, a tender). Once those leads are contacted, the words that go with replies rise to the top." />;
  return <table className="w-full border-collapse">
    <thead><tr className="border-b border-neutral-100"><th scope="col" className={clsx(th, "pl-0 text-left")}>Signal word</th><th scope="col" className={clsx(th, "text-right")}>Leads</th><th scope="col" className={clsx(th, "text-right max-sm:hidden")}>Contacted</th><th scope="col" className={clsx(th, "pr-0 text-right")}>Replied</th></tr></thead>
    <tbody className="divide-y divide-neutral-100">
      {signals.map((row) => <tr key={row.keyword}>
        <th scope="row" className={clsx(td, "pl-0 text-left font-semibold text-neutral-900")}>{row.keyword}</th>
        <td className={clsx(td, "tnum text-right")}>{count(row.leads)}</td>
        <td className={clsx(td, "tnum text-right max-sm:hidden")}>{count(row.contacted)}</td>
        <td className={clsx(td, "pr-0 text-right")}><span className="tnum">{count(row.replied)}</span>{percent(row.replyRate) ? <span className="ml-1 text-neutral-500">({percent(row.replyRate)})</span> : null}</td>
      </tr>)}
    </tbody>
  </table>;
}
