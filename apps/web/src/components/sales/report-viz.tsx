"use client";
import { useState } from "react";
import clsx from "clsx";
import type { SalesReport } from "@venture-studio/contracts";
import { CHANNELS, count, percent, plural, useWidth } from "./report-shared";

// The Reports tab's charts, drawn as plain SVG in real pixels (no chart library): the funnel, calls and messages per day, and the
// small histograms. One series per chart uses the brand green; the four channels use the validated categorical colours.

type Stage = SalesReport["funnel"]["stages"][number];
type Day = SalesReport["activity"]["days"][number];

/** A bar that starts square at its baseline and ends rounded (4 px). */
function barRight(x: number, y: number, width: number, height: number, radius = 4) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return `M${x},${y}h${width - r}a${r},${r} 0 0 1 ${r},${r}v${height - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(width - r)}z`;
}
function barUp(x: number, bottom: number, width: number, height: number, round: boolean) {
  const r = round ? Math.max(0, Math.min(4, width / 2, height)) : 0;
  return `M${x},${bottom}v${-(height - r)}a${r},${r} 0 0 1 ${r},${-r}h${width - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${height - r}z`;
}
function barDown(x: number, top: number, width: number, height: number) {
  const r = Math.max(0, Math.min(4, width / 2, height));
  return `M${x},${top}v${height - r}a${r},${r} 0 0 0 ${r},${r}h${width - 2 * r}a${r},${r} 0 0 0 ${r},${-r}v${-(height - r)}z`;
}

/** The funnel: one bar per step, the share that went on between steps, and how many got to each step during the period. */
export function FunnelChart({ stages }: { stages: Stage[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const labelWidth = 84, valueWidth = 104, rowHeight = 24, gap = 26;
  const area = Math.max(40, width - labelWidth - valueWidth);
  const max = Math.max(1, ...stages.map((stage) => stage.leads));
  const height = stages.length * rowHeight + (stages.length - 1) * gap;
  const summary = stages.map((stage) => `${stage.label} ${stage.leads}`).join(", ");
  return <div ref={ref} className="w-full min-w-0" style={{ minHeight: height }}>
    {width > 0 && <svg width={width} height={height} role="img" aria-label={`Funnel: ${summary}`} className="block overflow-visible">
      {stages.map((stage, index) => {
        const y = index * (rowHeight + gap);
        const bar = stage.leads === 0 ? 0 : Math.max(3, (stage.leads / max) * area);
        return <g key={stage.key}>
          <title>{`${stage.label}: ${count(stage.leads)} of the leads that moved reached this step or further; ${count(stage.entered)} got here during the period`}</title>
          <text x={0} y={y + rowHeight / 2} dominantBaseline="central" className="fill-neutral-700 text-[12px] font-semibold">{stage.label}</text>
          <path d={barRight(labelWidth, y, area, rowHeight)} className="fill-neutral-100" />
          {bar > 0 && <path d={barRight(labelWidth, y, bar, rowHeight)} className="fill-primary-600" />}
          <text x={labelWidth + area + 10} y={y + rowHeight / 2} dominantBaseline="central" className="tnum fill-neutral-900 text-[13px] font-bold">
            {count(stage.leads)}<tspan dx={6} className="fill-neutral-400 text-[11px] font-semibold">{stage.entered > 0 ? `+${count(stage.entered)}` : ""}</tspan>
          </text>
          {index > 0 && <text x={labelWidth + 2} y={y - gap / 2} dominantBaseline="central" className="fill-neutral-500 text-[11px] font-medium">
            {`↳ ${stage.conversion && stage.conversion.n > 0 ? percent(stage.conversion) ? `${percent(stage.conversion)} went on` : `too few to tell (n ${stage.conversion.n})` : "nobody at the step before"}`}
          </text>}
        </g>;
      })}
    </svg>}
  </div>;
}

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const weekdayFormat = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
export const shortDay = (day: string) => dayFormat.format(asDate(day));

/** Calls and messages per day, stacked by channel above the line; replies received below it, on the same scale. */
export function DayBars({ days }: { days: Day[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const out = days.map((day) => day.call + day.email + day.whatsapp + day.linkedin);
  const maxOut = Math.max(0, ...out);
  const maxIn = Math.max(0, ...days.map((day) => day.replies));
  const top = 140;
  const scale = top / Math.max(1, maxOut, maxIn);
  const below = Math.ceil(maxIn * scale);
  const pad = 16;
  const axis = pad + top;
  const height = axis + 2 + below + 4;
  const band = days.length ? width / days.length : 0;
  const barWidth = Math.max(1, Math.min(24, band > 6 ? band - 4 : band - 1));
  const gap = barWidth >= 4 ? 2 : 0;
  const current = hover !== null ? days[hover] : undefined;
  return <div className="w-full min-w-0">
    <div ref={ref} className="relative w-full" style={{ minHeight: height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && <svg width={width} height={height} role="img" aria-label={`Calls and messages per day: ${count(out.reduce((sum, value) => sum + value, 0))} sent, ${count(days.reduce((sum, day) => sum + day.replies, 0))} replies`} className="block">
        <rect x={0} y={pad} width={width} height={1} className="fill-neutral-100" />
        <text x={width} y={pad - 4} textAnchor="end" className="tnum fill-neutral-400 text-[10px] font-medium">{plural(Math.max(maxOut, maxIn), "a day", "a day")}</text>
        {days.map((day, index) => {
          const x = index * band + (band - barWidth) / 2;
          let base = axis;
          const segments = CHANNELS.map((channel) => ({ ...channel, value: day[channel.key] })).filter((segment) => segment.value > 0);
          return <g key={day.day}>
            {hover === index && <rect x={index * band} y={0} width={band} height={height} className="fill-neutral-100" />}
            {segments.map((segment, position) => {
              const full = segment.value * scale;
              const drawn = Math.max(1, full - (position > 0 ? gap : 0));
              const bottom = base - (position > 0 ? gap : 0);
              base -= full;
              return <path key={segment.key} d={barUp(x, bottom, barWidth, drawn, position === segments.length - 1 && barWidth >= 4)} style={{ fill: segment.color }} />;
            })}
            {day.replies > 0 && <path d={barDown(x, axis + 2, barWidth, Math.max(1, day.replies * scale))} style={{ fill: "var(--rp-replies)" }} />}
            <rect x={index * band} y={0} width={Math.max(band, 1)} height={height} fill="transparent" onMouseEnter={() => setHover(index)}>
              <title>{`${weekdayFormat.format(asDate(day.day))}: ${day.call} calls, ${day.email} emails, ${day.whatsapp} WhatsApp, ${day.linkedin} LinkedIn; ${day.replies} replies`}</title>
            </rect>
          </g>;
        })}
        <rect x={0} y={axis} width={width} height={1} className="fill-neutral-300" />
      </svg>}
      {current && hover !== null && <div role="status" className="pointer-events-none absolute top-0 z-10 w-44 rounded-xl border border-neutral-200 bg-white p-2.5 text-[11px] shadow-e4" style={{ left: Math.min(Math.max(0, hover * band + band / 2 - 88), Math.max(0, width - 176)) }}>
        <p className="font-bold text-neutral-900">{weekdayFormat.format(asDate(current.day))}</p>
        <ul className="mt-1 space-y-0.5">
          {CHANNELS.map((channel) => <li key={channel.key} className="flex items-center justify-between gap-2 text-neutral-600"><span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: channel.color }} />{channel.label}</span><span className="tnum font-semibold text-neutral-900">{current[channel.key]}</span></li>)}
          <li className="flex items-center justify-between gap-2 border-t border-neutral-100 pt-0.5 text-neutral-600"><span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: "var(--rp-replies)" }} />Replies</span><span className="tnum font-semibold text-neutral-900">{current.replies}</span></li>
        </ul>
      </div>}
    </div>
    {days.length > 0 && <div className="mt-1.5 flex justify-between text-[11px] font-medium text-neutral-400">
      <span>{shortDay(days[0]!.day)}</span>{days.length > 2 && <span>{shortDay(days[Math.floor(days.length / 2)]!.day)}</span>}<span>{shortDay(days[days.length - 1]!.day)}</span>
    </div>}
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] font-medium text-neutral-600" aria-label="Legend">
      {CHANNELS.map((channel) => <li key={channel.key} className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: channel.color }} />{channel.label}</li>)}
      <li className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--rp-replies)" }} />Replies (below the line)</li>
    </ul>
  </div>;
}

/** A small histogram: one row per value, the bar in proportion to the largest. Zero rows stay listed but quiet. */
export function HBarList({ rows, unit }: { rows: { key: string; label: string; count: number }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return <ul className="space-y-2">
    {rows.map((row) => <li key={row.key} title={`${row.label}: ${row.count} of ${total} ${unit}`} className={clsx("grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_2.25rem] items-center gap-3 text-xs", row.count === 0 && "opacity-55")}>
      <span className="truncate font-medium text-neutral-700">{row.label}</span>
      <span className="block h-2.5 overflow-hidden rounded-r-[4px] bg-neutral-100"><span className="vso-progress block h-full rounded-r-[4px] bg-primary-600" style={{ width: `${(row.count / max) * 100}%` }} /></span>
      <span className="tnum text-right font-semibold text-neutral-800">{count(row.count)}</span>
    </li>)}
  </ul>;
}
