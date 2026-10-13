"use client";

import { useState } from "react";
import clsx from "clsx";
import { WorkspaceLink as Link } from "@/components/shell/workspace-link";
import { Dither } from "@/components/ui/dither";
import { ditherTone, type EmptyTone } from "@/components/ui/empty-state";
import { ArrowUpRight, type Icon } from "@/components/ui/icons";
import { RollingNumber } from "@/components/studio/primitives";

const iconTone: Record<EmptyTone, string> = {
  green: "bg-primary-50 text-primary-700",
  blue: "vso-stat-icon-blue",
  amber: "bg-warning-surface text-warning-text",
  violet: "bg-ai-surface text-ai-text",
  teal: "vso-stat-icon-teal",
  red: "bg-danger-surface text-danger-text",
  neutral: "bg-neutral-100 text-neutral-600",
};

/**
 * A headline number that links to its list. A dither in the stat's own colour (red for blocked, amber for signals,
 * green for open work) always sits in the corner; on hover or keyboard focus it spreads further and brightens.
 */
export function StatCard({ icon: StatIcon, label, value, note, tone, href }: { icon: Icon; label: string; value: number | string; note?: string; tone: EmptyTone; href: string }) {
  const [active, setActive] = useState(false);
  return <Link href={href} onPointerEnter={() => setActive(true)} onPointerLeave={() => setActive(false)} onFocus={() => setActive(true)} onBlur={() => setActive(false)} className="vso-stat group relative block min-w-0 overflow-hidden rounded-2xl border border-neutral-200/75 bg-white px-4 py-4 shadow-card transition-[box-shadow,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:-translate-y-px hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]">
    <span aria-hidden="true" className="vso-stat-wash pointer-events-none absolute inset-0">
      <Dither colors={ditherTone(tone)} origin={[1.02, -0.15]} reach={active ? 1.2 : 0.78} transitionMs={460} pixel={3} />
    </span>
    <div className="relative flex items-start justify-between gap-2">
      <span className={clsx("grid h-9 w-9 place-items-center rounded-xl", iconTone[tone])}><StatIcon size={17} strokeWidth={1.9} /></span>
      <ArrowUpRight size={14} className="text-neutral-300 transition-[color,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-neutral-600" />
    </div>
    <p className="relative mt-3 text-[24px] font-extrabold leading-none tracking-tight text-neutral-900"><RollingNumber value={value} /></p>
    <p className="relative mt-2 text-[11px] font-semibold uppercase leading-4 tracking-[0.07em] text-neutral-600">{label}</p>
    {note && <p className="relative mt-1 truncate text-[11px] font-medium text-neutral-500">{note}</p>}
  </Link>;
}
