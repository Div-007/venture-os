"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { PipelineValue } from "@venture-studio/contracts";
import { ArrowRight } from "@/components/ui/icons";
import { Panel, PanelHead } from "@/components/studio/primitives";
import { getPipelineValue } from "@/lib/sales-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { moneyFull, moneyShort, number, plural } from "@/components/sales/sales-ui";

const monthName = (key: string) => new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" }).format(new Date(`${key}-01T00:00:00Z`));

function Tile({ label, value, hint, full, tone }: { label: string; value: string; hint?: string; full?: string; tone?: "green" }) {
  return <div className="min-w-0 rounded-xl bg-neutral-50 p-3" title={full}>
    <p className="truncate text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-500">{label}</p>
    <p className={clsx("mt-1 truncate text-lg font-extrabold leading-6 tracking-tight tnum", tone === "green" ? "text-success-text" : "text-neutral-900")}>{value}</p>
    {hint && <p className="mt-0.5 truncate text-xs font-medium text-neutral-500">{hint}</p>}
  </div>;
}

/** The pipeline in money: open value, the weighted forecast for this month and next (by expected close date), and what was won this month. */
export function OverviewPipeline({ scope }: { scope: "me" | "all" }) {
  const { ventureId, refreshKey } = useSalesShell();
  const [state, setState] = useState<{ key: string; data: PipelineValue | null; error: boolean } | null>(null);
  const key = `${ventureId}|${scope}|${refreshKey}`;
  useEffect(() => {
    let active = true;
    getPipelineValue({ ...(ventureId ? { ventureId } : {}), ...(scope === "me" ? { owner: "me" as const } : {}) })
      .then((data) => { if (active) setState({ key, data, error: false }); })
      .catch(() => { if (active) setState((previous) => ({ key, data: previous?.data ?? null, error: true })); });
    return () => { active = false; };
  }, [key, ventureId, scope]);
  const data = state?.data ?? null;
  const rows = data?.rows ?? [];
  const month = data ? { current: monthName(data.months.current), next: monthName(data.months.next) } : { current: "", next: "" };

  return <Panel>
    <PanelHead title="Pipeline" aside={<Link href="/sales/live/pipeline" className="-my-2 inline-flex min-h-10 items-center gap-1 rounded-lg px-1 text-xs font-semibold text-primary-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 sm:min-h-8">Open board <ArrowRight size={12} /></Link>} />
    {!state ? <div role="status" aria-label="Loading the pipeline value" className="grid grid-cols-2 gap-2 p-5">{[0, 1, 2, 3].map((index) => <span key={index} className="vso-skeleton h-[76px] rounded-xl" />)}</div>
      : !rows.length ? <div className="p-5"><p className="text-sm leading-6 text-neutral-500">{state.error ? "Could not load the pipeline value." : "No deal values yet. Add a value to a lead and the open pipeline and forecast show up here."}</p>{(data?.openWithoutValue ?? 0) > 0 && <Link href="/sales/live/leads?stage=contacted,replied,discovery_booked,qualified,proposal" className="mt-1 inline-flex min-h-10 items-center text-xs font-semibold text-primary-700 hover:underline sm:min-h-8">{plural(data!.openWithoutValue, "open lead")} without a value</Link>}</div>
      : <div className="grid gap-4 p-5">
        {rows.map((row) => <div key={row.currency} className="grid gap-2">
          {rows.length > 1 && <p className="text-xs font-semibold text-neutral-500">{row.currency}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Open" value={moneyShort(row.openValueMinor, row.currency)} hint={plural(row.openDeals, "deal")} full={moneyFull(row.openValueMinor, row.currency)} />
            <Tile label="Weighted" value={moneyShort(row.openWeightedMinor, row.currency)} hint="value x chance" full={moneyFull(row.openWeightedMinor, row.currency)} />
            <Tile label={`${month.current} forecast`} value={moneyShort(row.forecastThisMonthMinor, row.currency)} hint="expected to close, weighted" full={moneyFull(row.forecastThisMonthMinor, row.currency)} />
            <Tile label={`${month.next} forecast`} value={moneyShort(row.forecastNextMonthMinor, row.currency)} hint="expected to close, weighted" full={moneyFull(row.forecastNextMonthMinor, row.currency)} />
          </div>
          <Tile label={`Won in ${month.current}`} value={moneyShort(row.wonThisMonthMinor, row.currency)} hint={plural(row.wonThisMonthDeals, "deal")} full={moneyFull(row.wonThisMonthMinor, row.currency)} tone={row.wonThisMonthMinor > 0 ? "green" : undefined} />
          {row.unscheduledWeightedMinor > 0 && <p className="text-xs leading-5 text-neutral-500" title={moneyFull(row.unscheduledWeightedMinor, row.currency)}>{moneyShort(row.unscheduledWeightedMinor, row.currency)} weighted has no close date yet, so it is not in a month.</p>}
        </div>)}
        {(data?.openWithoutValue ?? 0) > 0 && <p className="text-xs leading-5 text-neutral-500">{number(data!.openWithoutValue)} open {data!.openWithoutValue === 1 ? "lead has" : "leads have"} no value yet and {data!.openWithoutValue === 1 ? "is" : "are"} left out.</p>}
      </div>}
  </Panel>;
}
