"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { ReportRate, ReportStat } from "@venture-studio/contracts";
import { Panel } from "@/components/studio/primitives";

// Small pieces shared by the Reports tab (screens/sales/reports.tsx): honest numbers, formats and the section card.

const nf = new Intl.NumberFormat("en-IN");
export const count = (value: number) => nf.format(value);
/** "1 call", "3 calls". */
export const plural = (value: number, one: string, many: string) => `${nf.format(value)} ${value === 1 ? one : many}`;
/** "38%", or null when the sample is too small to show a share (fewer than 5). */
export const percent = (rate: ReportRate | null | undefined) => (rate && rate.value !== null ? (rate.value > 0 && rate.value < 0.005 ? "<1%" : `${Math.round(rate.value * 100)}%`) : null);
/** "38% (n 45)", "too few (n 3)" or "no cases yet": for plain text and labels. */
export function rateWords(rate: ReportRate | null | undefined) {
  if (!rate || rate.n === 0) return "no cases yet";
  const shown = percent(rate);
  return shown ? `${shown} (n ${rate.n})` : `too few to tell (n ${rate.n})`;
}

/** Hours as people say them: "25 min", "3.5 h", "2.1 days". */
export function hours(value: number) {
  if (value < 1) return `${Math.max(1, Math.round(value * 60))} min`;
  if (value < 48) return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} h`;
  return `${(value / 24).toFixed(1).replace(/\.0$/, "")} days`;
}
export const days = (value: number) => (value < 1 ? "under a day" : `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${value === 1 ? "day" : "days"}`);
/** Minor units (paise, cents) as money: "₹50,000". */
export function money(minor: number, currency: string) {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100); }
  catch { return `${currency} ${nf.format(Math.round(minor / 100))}`; }
}

/** A share with its sample, never a percentage below 5 cases: "38%" over "n 45", or "too few" over "n 3". */
export function RateValue({ rate, className, size = "md" }: { rate: ReportRate | null | undefined; className?: string; size?: "md" | "lg" }) {
  const shown = percent(rate);
  return <span className={clsx("inline-flex flex-col leading-tight", className)}>
    <span className={clsx("font-bold", size === "lg" ? "text-[22px] tracking-tight text-neutral-900" : "text-sm", shown ? "text-neutral-900" : "text-neutral-400")}>{shown ?? (rate && rate.n > 0 ? "too few" : "—")}</span>
    <span className="tnum text-[11px] font-medium text-neutral-500">{rate ? `n ${count(rate.n)}${shown && rate.small ? " · small sample" : ""}` : ""}</span>
  </span>;
}

/** A median or average with its sample. */
export function StatValue({ stat, format, size = "md" }: { stat: ReportStat; format: (value: number) => string; size?: "md" | "lg" }) {
  return <span className="inline-flex flex-col leading-tight">
    <span className={clsx("font-bold", size === "lg" ? "text-[22px] tracking-tight" : "text-sm", stat.value !== null ? "text-neutral-900" : "text-neutral-400")}>{stat.value !== null ? format(stat.value) : stat.n > 0 ? "too few" : "—"}</span>
    <span className="tnum text-[11px] font-medium text-neutral-500">n {count(stat.n)}{stat.value !== null && stat.small ? " · small sample" : ""}</span>
  </span>;
}

/** One report section: a card with a title, a line on what it measures, and an optional control. */
export function ReportSection({ id, title, subtitle, aside, children, className }: { id: string; title: string; subtitle: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <Panel className={clsx("min-w-0", className)}>
    <section aria-labelledby={`${id}-title`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4">
        <div className="min-w-0 flex-1 basis-64"><h2 id={`${id}-title`} className="text-sm font-bold text-neutral-900">{title}</h2><p className="mt-0.5 text-xs leading-5 text-neutral-500">{subtitle}</p></div>
        {aside}
      </header>
      <div className="p-5">{children}</div>
    </section>
  </Panel>;
}

/** A quiet note that says what will appear here once there is data (an empty section is a promise, not a failure). */
export function WillAppear({ title, body, className }: { title: string; body: string; className?: string }) {
  return <div className={clsx("rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-3", className)}>
    <p className="text-xs font-bold text-neutral-700">{title}</p>
    <p className="mt-0.5 text-xs leading-5 text-neutral-500">{body}</p>
  </div>;
}

/** The "small sample" marker: shown wherever fewer than 30 cases stand behind a number. */
export function SmallSample({ n }: { n: number }) {
  return <span title="Fewer than 30 cases: read this as a hint, not proof. Below 5 cases no percentage is shown." className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-warning-surface px-2.5 py-0.5 text-[11px] font-semibold text-warning-text">
    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />Small sample · n {count(n)}
  </span>;
}

/** The width of an element, kept up to date (charts draw in real pixels so nothing stretches). */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0]?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Channel colours for the activity chart (validated for colour-blind separation on the light and dark surfaces). */
export const REPORT_CHART_CSS = `
.vso-report{--rp-call:#2a78d6;--rp-email:#eb6834;--rp-whatsapp:#1baf7a;--rp-linkedin:#4a3aa7;--rp-replies:#737373}
:root[data-theme="dark"] .vso-report{--rp-call:#3987e5;--rp-email:#d95926;--rp-whatsapp:#199e70;--rp-linkedin:#9085e9;--rp-replies:#aec5b5}
`;
export const CHANNELS = [
  { key: "call", label: "Calls", color: "var(--rp-call)" },
  { key: "email", label: "Emails", color: "var(--rp-email)" },
  { key: "whatsapp", label: "WhatsApp", color: "var(--rp-whatsapp)" },
  { key: "linkedin", label: "LinkedIn", color: "var(--rp-linkedin)" },
] as const;
