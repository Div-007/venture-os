"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import type { SalesReport } from "@venture-studio/contracts";
import { CalendarDays, Copy } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, filterControl, secondaryClass } from "@/components/studio/primitives";
import { getSalesReport } from "@/lib/sales-api";
import { copyText, Segmented, useSalesLoad } from "@/components/sales/draft-shared";
import { useSalesShell } from "@/components/sales/sales-context";
import { useUrlParams } from "@/components/sales/sales-ui";
import { REPORT_CHART_CSS, RateValue, ReportSection, SmallSample, StatValue, WillAppear, count, days, hours, money, percent, plural } from "@/components/sales/report-shared";
import { DayBars, FunnelChart, HBarList, shortDay } from "@/components/sales/report-viz";
import { AgingTable, BreakdownTable, CalibrationGrid, OldestList, OverrideList, SignalsTable } from "@/components/sales/report-tables";
import { periodLabel, reportText } from "@/components/sales/report-text";
import { daysLabel } from "@/components/sales/setup-checks";

type RangeKey = "week" | "30d" | "quarter" | "custom";
type ByKey = "source" | "play" | "owner" | "city";
const RANGES: { value: RangeKey; label: string }[] = [{ value: "week", label: "This week" }, { value: "30d", label: "30 days" }, { value: "quarter", label: "Quarter" }, { value: "custom", label: "Custom" }];
const BY: { value: ByKey; label: string; noun: string }[] = [{ value: "source", label: "Source", noun: "Source" }, { value: "play", label: "Play", noun: "Play" }, { value: "owner", label: "Owner", noun: "Owner" }, { value: "city", label: "City", noun: "City" }];

const pad = (value: number) => String(value).padStart(2, "0");
const isoDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localToday = () => isoDay(new Date());
const shiftDay = (day: string, by: number) => { const [y, m, d] = day.split("-").map(Number) as [number, number, number]; return isoDay(new Date(y, m - 1, d + by)); };
const validDay = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "");
/** A report covers at most one year (the API refuses more): 366 days counting both ends, so from a date to the same date a year later. */
const MAX_DAYS_BACK = 365;
const earliestFrom = (to: string) => shiftDay(to, -MAX_DAYS_BACK);
const longDay = (day: string) => { const [y, m, d] = day.split("-").map(Number) as [number, number, number]; return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); };

/** The period a range choice stands for, as days (the server reads them as whole days in the venture's time zone). */
function periodOf(range: RangeKey, today: string, from: string, to: string): { from?: string; to?: string } {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  if (range === "week") { const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7; return { from: shiftDay(today, -weekday), to: today }; }
  if (range === "quarter") return { from: isoDay(new Date(y, Math.floor((m - 1) / 3) * 3, 1)), to: today };
  if (range === "custom") { const end = to || today; const start = from && from <= end ? from : shiftDay(end, -29); return { from: start, to: end }; }
  return {};
}

function Tile({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return <div className="min-w-0 rounded-2xl border border-neutral-200/75 bg-white px-4 py-4 shadow-card">
    <p className="text-[11px] font-semibold uppercase leading-4 tracking-[0.07em] text-neutral-600">{label}</p>
    <div className="mt-2">{children}</div>
    {note && <p className="mt-1 text-[11px] font-medium text-neutral-500">{note}</p>}
  </div>;
}
const Big = ({ value }: { value: string }) => <p className="text-[24px] font-extrabold leading-none tracking-tight text-neutral-900">{value}</p>;

function ReportSkeleton() {
  return <div role="status" aria-label="Loading the report" className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((index) => <span key={index} className="vso-skeleton block h-24 rounded-2xl" />)}</div>
    <div className="grid gap-4 lg:grid-cols-12"><Panel className="space-y-3 p-5 lg:col-span-7">{[0, 1, 2, 3, 4, 5].map((index) => <span key={index} className="vso-skeleton block h-6" style={{ width: `${92 - index * 13}%` }} />)}</Panel><Panel className="space-y-3 p-5 lg:col-span-5"><span className="vso-skeleton block h-8 w-1/3" /><span className="vso-skeleton block h-24" /></Panel></div>
    <Panel className="p-5"><span className="vso-skeleton block h-40" /></Panel>
  </div>;
}

/** Reports (route /sales/live/reports): how the pipeline is doing and how good Claude's judgement has been, with honest sample sizes. */
export function ReportsScreen() {
  const { session, ventureId, ventureName, personName, openLead } = useSalesShell();
  const { params, update } = useUrlParams();
  const [today] = useState(localToday);
  const range = (RANGES.some((item) => item.value === params.get("range")) ? params.get("range") : "30d") as RangeKey;
  const by = (BY.some((item) => item.value === params.get("by")) ? params.get("by") : "source") as ByKey;
  const mine = params.get("owner") === "me";
  const customFrom = validDay(params.get("from")), customTo = validDay(params.get("to"));
  const period = useMemo(() => periodOf(range, today, customFrom, customTo), [range, today, customFrom, customTo]);
  // A custom period longer than a year is not asked for: the screen says how to shorten it instead.
  const tooLong = range === "custom" && !!period.from && !!period.to && period.from < earliestFrom(period.to);
  const report = useSalesLoad(`report|${ventureId}|${mine}|${period.from ?? ""}|${period.to ?? ""}|${tooLong}`, () => tooLong ? Promise.resolve(null) : getSalesReport({ ...(ventureId ? { ventureId } : {}), owner: mine ? "me" : "all", ...period }));
  const data = report.data;
  const scopeName = ventureId ? ventureName(ventureId) : "All ventures";

  function pickRange(next: RangeKey) {
    // Custom starts from the period on screen, so switching does not jump.
    if (next === "custom") { const current = range === "30d" ? periodOf("custom", today, "", "") : periodOf(range, today, customFrom, customTo); update({ range: next, from: current.from ?? null, to: current.to ?? null }); }
    else update({ range: next === "30d" ? null : next, from: null, to: null });
  }

  const toolbar = <div className="mb-4 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="Period" value={range} onChange={pickRange} options={RANGES} />
      {session && <Segmented label="Whose leads" value={mine ? "mine" : "all"} onChange={(value) => update({ owner: value === "mine" ? "me" : null })} options={[{ value: "all", label: "Everyone" }, { value: "mine", label: "Mine" }]} />}
      <button type="button" disabled={!data} onClick={() => data && copyText(reportText(data, { ventureName: scopeName, whose: mine ? "my leads" : "everyone" }), "Copied the report as text")} className={clsx(secondaryClass, "ml-auto !min-h-9")}><Copy size={15} />Copy as text</button>
    </div>
    {range === "custom" && <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-neutral-500">
      <label className="flex items-center gap-2">From<input type="date" value={period.from ?? ""} min={period.to ? earliestFrom(period.to) : undefined} max={period.to ?? today} aria-invalid={tooLong || undefined} aria-describedby="report-range-note" onChange={(event) => validDay(event.target.value) && update({ from: event.target.value })} className={filterControl(true)} /></label>
      <label className="flex items-center gap-2">to<input type="date" value={period.to ?? ""} min={period.from} max={period.from && shiftDay(period.from, MAX_DAYS_BACK) < today ? shiftDay(period.from, MAX_DAYS_BACK) : today} aria-invalid={tooLong || undefined} aria-describedby="report-range-note" onChange={(event) => validDay(event.target.value) && update({ to: event.target.value })} className={filterControl(true)} /></label>
      <span id="report-range-note" className={clsx("font-medium", tooLong ? "text-danger-text" : "text-neutral-400")}>{tooLong ? "At most one year: this period is longer." : "At most one year."}</span>
    </div>}
    {data && <p className="text-xs font-medium text-neutral-500">{periodLabel(data)} · {scopeName} · {mine ? "my leads" : "everyone's leads"}</p>}
  </div>;

  if (tooLong && period.to) return <>{toolbar}<Panel><EmptyState variant="card" tone="amber" icon={CalendarDays} title="That period is longer than a year" body={`A report covers at most one year. Start it on ${longDay(earliestFrom(period.to))} or later, or pick an earlier end date.`} action={{ label: "Use the year up to the end date", onClick: () => update({ from: earliestFrom(period.to!) }) }} /></Panel></>;
  if (report.error && !data) return <>{toolbar}<Panel><EmptyState variant="error" title="Could not load the report" body={report.error} action={{ label: report.busy ? "Trying again…" : "Try again", onClick: report.reload, disabled: report.busy }} /></Panel></>;
  if (!data) return <>{toolbar}<ReportSkeleton /></>;
  return <div className="vso-report">
    <style>{REPORT_CHART_CSS}</style>
    {toolbar}
    {report.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{report.error}</p>}
    <div className={clsx("space-y-4 transition-opacity duration-150", report.busy && "opacity-70")} aria-busy={report.busy || undefined}>
      <Headline report={data} />
      <div className="grid items-start gap-4 lg:grid-cols-12">
        <FunnelSection report={data} className="lg:col-span-7" />
        <WinsSection report={data} className="lg:col-span-5" />
      </div>
      <ReportSection id="report-sources" title="Where leads come from" subtitle="The leads that moved in this period, split by where they came from, their play, owner or city."
        aside={<Segmented label="Split by" value={by} onChange={(value) => update({ by: value === "source" ? null : value })} options={BY.map(({ value, label }) => ({ value, label }))} />}>
        <BreakdownTable rows={data.funnel.by[by]} noun={BY.find((item) => item.value === by)!.noun} />
      </ReportSection>
      <ActivitySection report={data} />
      <SpeedSection report={data} onOpen={openLead} personName={personName} />
      <CalibrationSection report={data} onOpen={openLead} personName={personName} />
    </div>
  </div>;
}

function Headline({ report }: { report: SalesReport }) {
  const [, contacted, talking] = report.funnel.stages;
  const won = report.winsLosses.won;
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
    <Tile label="Leads that moved" note="Added, judged, contacted or answered"><Big value={count(report.funnel.active)} /></Tile>
    <Tile label="Contacted" note={`${plural(report.activity.totals.calls, "call", "calls")} · ${plural(report.activity.totals.messages, "message", "messages")}`}><Big value={count(contacted?.leads ?? 0)} /></Tile>
    <Tile label="Replied" note={percent(talking?.conversion) ? `${percent(talking?.conversion)} of contacted (n ${talking?.conversion?.n})` : talking?.conversion?.n ? `Too few to show a rate (n ${talking.conversion.n})` : "Replies show here once leads answer"}><Big value={count(talking?.leads ?? 0)} /></Tile>
    <Tile label="Won" note={won.value.length ? won.value.map((row) => money(row.minor, row.currency)).join(" + ") : won.count ? "No value recorded yet" : "Wins in this period show here"}><Big value={count(won.count)} /></Tile>
  </div>;
}

function FunnelSection({ report, className }: { report: SalesReport; className?: string }) {
  const { funnel } = report;
  return <ReportSection id="report-funnel" className={className} title="Funnel" subtitle="Leads that moved in this period, and how far each has got. The line between steps is the share that went on."
    aside={funnel.closed.lost + funnel.closed.disqualified > 0 ? <span className="text-[11px] font-semibold text-neutral-500">Closed: {count(funnel.closed.lost)} lost · {count(funnel.closed.disqualified)} not a fit</span> : undefined}>
    {funnel.active === 0
      ? <WillAppear title="Nothing moved in this period" body="Leads show up here once they are added, judged, contacted or answer. Each bar then counts how many reached that step, and the line between bars shows how many went on. Try a longer period, or Everyone instead of Mine." />
      : <>
        <FunnelChart stages={funnel.stages} />
        <p className="mt-4 text-[11px] leading-5 text-neutral-500">Bars count leads that reached the step or further by the end of the period; <span className="font-semibold text-neutral-600">+n</span> got there during it. Shares under 5 leads say “too few”.</p>
      </>}
  </ReportSection>;
}

function WinsSection({ report, className }: { report: SalesReport; className?: string }) {
  const { won, lost, disqualified } = report.winsLosses;
  return <ReportSection id="report-wins" className={className} title="Wins and losses" subtitle="Deals won, lost or found not a fit in this period, and why.">
    <div className="grid grid-cols-2 gap-3">
      <div><p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-neutral-500">Won</p><p className="mt-1 text-[22px] font-extrabold tracking-tight text-neutral-900">{count(won.count)}</p><p className="text-xs font-medium text-neutral-500">{won.value.length ? won.value.map((row) => money(row.minor, row.currency)).join(" + ") : won.count ? "no value recorded" : "none yet"}{won.withoutValue && won.value.length ? ` · ${won.withoutValue} without a value` : ""}</p></div>
      <div><p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-neutral-500">First seen to won</p><div className="mt-1"><StatValue stat={won.daysToWin} format={days} size="lg" /></div></div>
    </div>
    <div className="mt-5 space-y-4">
      <div><p className="mb-2 text-xs font-bold text-neutral-700">Lost · {count(lost.count)}</p>{lost.count ? <HBarList rows={lost.reasons} unit="lost deals" /> : <WillAppear title="No lost deals in this period" body="When a deal is lost, the reason someone picks (price, timing, no need…) is counted here." />}</div>
      {disqualified.count > 0 && <div><p className="mb-2 text-xs font-bold text-neutral-700">Not a fit · {count(disqualified.count)}</p><HBarList rows={disqualified.reasons} unit="leads closed as not a fit" /></div>}
    </div>
  </ReportSection>;
}

function ActivitySection({ report }: { report: SalesReport }) {
  const { activity } = report;
  const active = activity.days.filter((day) => day.call + day.email + day.whatsapp + day.linkedin + day.replies > 0);
  const calls = activity.callOutcomes.reduce((sum, row) => sum + row.count, 0);
  const replies = activity.replyTypes.reduce((sum, row) => sum + row.count, 0);
  return <ReportSection id="report-activity" title="Activity" subtitle="Calls and messages sent per day by channel (above the line) and replies received (below it)."
    aside={<span className="tnum text-xs font-semibold text-neutral-600">{plural(activity.totals.calls, "call", "calls")} · {plural(activity.totals.messages, "message", "messages")} · {plural(activity.totals.replies, "reply", "replies")}</span>}>
    {active.length === 0
      ? <WillAppear title="No calls or messages logged in this period" body="Every call you log and every message marked sent adds to its day here, coloured by channel, with the replies that came back underneath." />
      : <>
        <DayBars days={activity.days} />
        <details className="mt-3 text-xs">
          <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-lg px-1 font-semibold text-primary-700 hover:bg-primary-50">Show the numbers</summary>
          <div className="thin-scroll mt-2 max-h-64 overflow-auto">
            <table className="w-full border-collapse text-left">
              <thead><tr className="border-b border-neutral-100 text-[10.5px] font-bold uppercase tracking-[0.07em] text-neutral-400"><th scope="col" className="py-2 pr-3">Day</th><th scope="col" className="py-2 pr-3 text-right">Calls</th><th scope="col" className="py-2 pr-3 text-right">Emails</th><th scope="col" className="py-2 pr-3 text-right">WhatsApp</th><th scope="col" className="py-2 pr-3 text-right">LinkedIn</th><th scope="col" className="py-2 text-right">Replies</th></tr></thead>
              <tbody className="tnum divide-y divide-neutral-100 text-neutral-700">{active.map((day) => <tr key={day.day}><th scope="row" className="py-1.5 pr-3 font-semibold">{shortDay(day.day)}</th><td className="py-1.5 pr-3 text-right">{day.call}</td><td className="py-1.5 pr-3 text-right">{day.email}</td><td className="py-1.5 pr-3 text-right">{day.whatsapp}</td><td className="py-1.5 pr-3 text-right">{day.linkedin}</td><td className="py-1.5 text-right">{day.replies}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      </>}
    <div className="mt-5 grid gap-6 md:grid-cols-2">
      <div><p className="mb-2 text-xs font-bold text-neutral-700">How calls ended · {count(calls)}</p>{calls ? <HBarList rows={activity.callOutcomes} unit="calls" /> : <WillAppear title="No calls yet" body="The outcome button pressed after each call (no answer, call back, interested…) is counted here." />}</div>
      <div><p className="mb-2 text-xs font-bold text-neutral-700">What replies said · {count(replies)}</p>{replies ? <HBarList rows={activity.replyTypes} unit="replies" /> : <WillAppear title="No replies yet" body="Each reply is sorted into a type (interested, wants details, not now…) and counted here." />}</div>
    </div>
  </ReportSection>;
}

/** The working hours the reply promise counts in, from the ventures' own settings: "Mon–Sat, 10:00 to 19:00", or each venture's own when they differ. */
function workingHoursText(rules: SalesReport["workRules"]): string {
  const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;
  const texts = [...new Set(rules.map((rule) => `${daysLabel(rule.workingDays)}, ${hour(rule.workStartHour)} to ${hour(rule.workEndHour)}`))];
  return texts.length === 1 ? texts[0]! : "each venture's own working days and hours";
}

function SpeedSection({ report, onOpen, personName }: { report: SalesReport; onOpen: (leadId: string) => void; personName: (id: string) => string }) {
  const { firstResponse, sla } = report.activity;
  const workingHours = workingHoursText(report.workRules);
  return <ReportSection id="report-speed" title="Speed" subtitle="How fast replies get an answer, and how long open deals have waited in their step.">
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 space-y-4">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
          <div className="rounded-xl bg-neutral-50 px-3 py-3"><p className="text-[11px] font-semibold leading-4 text-neutral-600">Median time to answer a reply</p><div className="mt-1.5"><StatValue stat={firstResponse.medianHours} format={hours} size="lg" /></div>{firstResponse.medianWorkingHours.value !== null && <p className="mt-1 text-[11px] text-neutral-500">{hours(firstResponse.medianWorkingHours.value)} of working time</p>}</div>
          <div className="rounded-xl bg-neutral-50 px-3 py-3"><p className="text-[11px] font-semibold leading-4 text-neutral-600">Warm replies answered within {sla.hours} working hours</p><div className="mt-1.5"><RateValue rate={sla.rate} size="lg" /></div></div>
        </div>
        <p className="text-xs leading-5 text-neutral-500">
          {sla.rate.n + sla.pending === 0 ? `No warm replies (interested, wants details, asks the price) in this period yet. The promise is measured on those, in working hours (${workingHours}, no festival days).` : <>{count(sla.late)} answered late, {count(sla.missed)} still unanswered past the {sla.hours} hours{sla.pending ? `, ${count(sla.pending)} still inside the time` : ""}. Working hours: {workingHours}.</>}
          {firstResponse.unanswered > 0 && <> {count(firstResponse.unanswered)} {firstResponse.unanswered === 1 ? "reply has" : "replies have"} had no answer yet.</>}
        </p>
        {/* On a phone the four columns may be wider than the card: they scroll inside it, never the page. */}
        <div className="overflow-x-auto"><AgingTable groups={report.stageAging.groups} /></div>
      </div>
      <div className="min-w-0"><p className="mb-2 text-xs font-bold text-neutral-700">Waiting longest</p><OldestList rows={report.stageAging.oldest} onOpen={onOpen} personName={personName} /></div>
    </div>
  </ReportSection>;
}

function CalibrationSection({ report, onOpen, personName }: { report: SalesReport; onOpen: (leadId: string) => void; personName: (id: string) => string }) {
  const { calibration: cal } = report;
  const overridden = cal.overridden;
  return <ReportSection id="report-calibration" title="Claude's calibration" subtitle="For the verdicts Claude saved in this period: what happened to those leads, by decision and confidence."
    aside={cal.verdicts > 0 && cal.verdicts < report.thresholds.smallN ? <SmallSample n={cal.verdicts} /> : undefined}>
    {cal.verdicts === 0
      ? <WillAppear title="Claude has not judged leads in this period" body="Once it has, this shows whether its go, hold and no calls held up: how many of the leads it recommended replied or booked a call (counted 10 working days after first contact), what happened when someone overrode it, and which signal words go with replies." />
      : <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl bg-neutral-50 px-3 py-3"><p className="text-[11px] font-semibold leading-4 text-neutral-600">When Claude said go: replied or booked</p><div className="mt-1.5"><RateValue rate={cal.precision.rate} size="lg" /></div><p className="mt-1 text-[11px] leading-4 text-neutral-500">Leads contacted {cal.precision.waitDays}+ working days ago{cal.precision.tooRecent ? ` · ${count(cal.precision.tooRecent)} too recent` : ""}{cal.precision.notContacted ? ` · ${count(cal.precision.notContacted)} not contacted` : ""}</p></div>
          <div className="rounded-xl bg-neutral-50 px-3 py-3"><p className="text-[11px] font-semibold leading-4 text-neutral-600">Overridden by a person</p><p className="mt-1.5 text-[22px] font-bold tracking-tight text-neutral-900">{count(cal.overrides.count)}</p><p className="mt-1 text-[11px] leading-4 text-neutral-500">{count(cal.overrides.toRecommend)} up to go · {count(cal.overrides.fromRecommend)} down from go</p></div>
          <div className="rounded-xl bg-neutral-50 px-3 py-3"><p className="text-[11px] font-semibold leading-4 text-neutral-600">Hold or no, then overridden</p><p className="mt-1.5 text-[22px] font-bold tracking-tight text-neutral-900">{count(overridden.n)}</p><p className="mt-1 text-[11px] leading-4 text-neutral-500">{overridden.n ? `${count(overridden.won)} won · ${count(overridden.meeting)} met · ${count(overridden.replied)} replied · ${count(overridden.lost + overridden.disqualified)} closed` : "None: nobody overrode a hold or no"}</p></div>
        </div>
        <CalibrationGrid grid={cal.grid} />
        <div className="grid gap-6 lg:grid-cols-2">
          <div><p className="mb-2 text-xs font-bold text-neutral-700">Overrides and why · {count(cal.overrides.count)}</p><OverrideList overrides={cal.overrides} onOpen={onOpen} personName={personName} /></div>
          <div><p className="mb-2 text-xs font-bold text-neutral-700">Signal words</p><SignalsTable signals={cal.signals} /></div>
        </div>
        <p className="text-[11px] leading-5 text-neutral-500">Fewer than 30 verdicts in a cell is a small sample: read it as a hint. Under 5, no percentage is shown.</p>
      </div>}
  </ReportSection>;
}
