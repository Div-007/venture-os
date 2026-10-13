"use client";
import clsx from "clsx";
import { LayoutGrid, TrendingUp, type Icon } from "@/components/ui/icons";
import type { AppMode } from "@/lib/app-mode";

const MODES: { key: AppMode; label: string; icon: Icon }[] = [
  { key: "studio", label: "Studio", icon: LayoutGrid },
  { key: "sales", label: "Sales", icon: TrendingUp },
];
const press = "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

/**
 * The Studio | Sales switch at the top of the sidebar: a white pill on a neutral track that glides between the two.
 * Phones and the open rail get the labelled control; the collapsed rail gets two icon buttons with tooltips (data-tip).
 */
export function ModeSwitch({ mode, collapsed, onSwitch }: { mode: AppMode; collapsed: boolean; onSwitch: (mode: AppMode) => void }) {
  const index = MODES.findIndex((item) => item.key === mode);
  return <>
    <div role="group" aria-label="Workspace mode" className={clsx("relative mb-3 grid grid-cols-2 rounded-xl bg-neutral-100 p-1", collapsed && "lg:hidden")}>
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-lg bg-white shadow-sm ring-1 ring-neutral-200/70 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none" style={{ transform: `translateX(${index * 100}%)` }} />
      {MODES.map(({ key, label, icon: ModeIcon }) => {
        const active = key === mode;
        return <button key={key} type="button" aria-pressed={active} onClick={() => onSwitch(key)} className={clsx("relative z-10 flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold", press, active ? "text-neutral-900" : "text-neutral-500 hover:text-neutral-800")}><ModeIcon size={15} strokeWidth={active ? 2.1 : 1.8} />{label}</button>;
      })}
    </div>
    <div role="group" aria-label="Workspace mode" className={clsx("mb-3 hidden gap-1 rounded-xl bg-neutral-100 p-1", collapsed && "lg:grid")}>
      {MODES.map(({ key, label, icon: ModeIcon }) => {
        const active = key === mode;
        return <button key={key} type="button" aria-pressed={active} aria-label={label} data-tip={label} onClick={() => onSwitch(key)} className={clsx("grid h-9 place-items-center rounded-lg", press, active ? "bg-white text-neutral-900 shadow-sm ring-1 ring-neutral-200/70" : "text-neutral-500 hover:bg-white/60 hover:text-neutral-800")}><ModeIcon size={16} strokeWidth={active ? 2.1 : 1.8} /></button>;
      })}
    </div>
  </>;
}
