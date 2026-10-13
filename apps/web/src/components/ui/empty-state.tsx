"use client";

import { WorkspaceLink as Link } from "@/components/shell/workspace-link";
import clsx from "clsx";
import { Dither } from "@/components/ui/dither";
import { AlertTriangle, FilterX, PointerClick, Plus, RefreshCw, SearchX, type Icon } from "@/components/ui/icons";

export type EmptyTone = "green" | "blue" | "amber" | "violet" | "teal" | "red" | "neutral";
export type EmptyAction = { label: string; onClick?: () => void; href?: string; icon?: Icon; disabled?: boolean };

/**
 * page      a whole page with nothing yet: dithered band, illustration, title, line, actions (renders its own card)
 * card      inside an existing card or panel: centred icon tile over a soft dither, title, line, optional action
 * filtered  search or filters hide everything: quiet, no dither, offers Clear filters
 * select    a detail pane with nothing chosen (callers hide it on phones)
 * error     a load failed: the message and Try again, never a "No … yet" next to it
 * column    a short dashed box for a board or pipeline column
 * compact   one line for small sections such as drawer lists
 */
export type EmptyVariant = "page" | "card" | "filtered" | "select" | "error" | "column" | "compact";

// Faint to strong; the theme tokens switch with light and dark.
const DITHER: Record<EmptyTone, string[]> = {
  green: ["var(--vso-dither-green-1)", "var(--vso-dither-green-2)", "var(--vso-dither-green-3)"],
  blue: ["var(--vso-dither-blue-1)", "var(--vso-dither-blue-2)", "var(--vso-dither-blue-3)"],
  amber: ["var(--vso-dither-amber-1)", "var(--vso-dither-amber-2)", "var(--vso-dither-amber-3)"],
  violet: ["var(--vso-dither-violet-1)", "var(--vso-dither-violet-2)", "var(--vso-dither-violet-3)"],
  teal: ["var(--vso-dither-teal-1)", "var(--vso-dither-teal-2)", "var(--vso-dither-teal-3)"],
  red: ["var(--vso-dither-red-1)", "var(--vso-dither-red-2)", "var(--vso-dither-red-3)"],
  neutral: ["var(--color-neutral-100)", "var(--color-neutral-200)", "var(--color-neutral-300)"],
};
export const ditherTone = (tone: EmptyTone) => DITHER[tone];

const buttonBase = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-[background-color,transform,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";
const primaryButton = `${buttonBase} bg-primary-700 text-white hover:bg-primary-800`;
const secondaryButton = `${buttonBase} border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50`;
// Card-sized states sit inside compact panels, so their buttons are a step smaller.
const small = "!min-h-9 !px-3 !text-xs !rounded-lg";

function ActionButton({ action, primary, compact }: { action: EmptyAction; primary: boolean; compact: boolean }) {
  const ActionIcon = action.icon;
  const content = <>{ActionIcon && <ActionIcon size={compact ? 14 : 16} />}{action.label}</>;
  const className = clsx(primary ? primaryButton : secondaryButton, compact && small);
  // Workspace links map "/tasks" to the live or demo route for the current mode.
  if (action.href && !action.disabled) return <Link href={action.href} className={className}>{content}</Link>;
  return <button type="button" onClick={action.onClick} disabled={action.disabled} className={className}>{content}</button>;
}

/** The gradient icon tile used across empty states; `quiet` is the neutral version for filtered and selection states. */
export function EmptyTile({ icon: TileIcon, tone = "green", size = 44, quiet = false }: { icon: Icon; tone?: EmptyTone; size?: number; quiet?: boolean }) {
  return <span aria-hidden="true" style={{ width: size, height: size }} className={clsx("relative grid shrink-0 place-items-center overflow-hidden rounded-xl", quiet || tone === "neutral" ? "border border-neutral-200 bg-neutral-50 text-neutral-400" : clsx("vso-tile text-white", `vso-tile-${tone}`))}>
    <TileIcon size={Math.round(size * 0.45)} className="relative" />
  </span>;
}

function Actions({ action, secondary, children, compact = false }: { action?: EmptyAction; secondary?: EmptyAction; children?: React.ReactNode; compact?: boolean }) {
  if (!action && !secondary && !children) return null;
  return <div className={clsx("flex flex-wrap justify-center gap-2", compact ? "mt-4" : "mt-5")}>{action && <ActionButton action={action} primary compact={compact} />}{secondary && <ActionButton action={secondary} primary={false} compact={compact} />}{children}</div>;
}

export function EmptyState({ variant = "card", icon, tone = "green", title, body, action, secondary, children, art, className }: {
  variant?: EmptyVariant; icon?: Icon; tone?: EmptyTone; title: string; body?: React.ReactNode;
  action?: EmptyAction; secondary?: EmptyAction; children?: React.ReactNode;
  /** Page variant only: replaces the default stacked-cards illustration. */
  art?: React.ReactNode; className?: string;
}) {
  if (variant === "column") {
    const ColumnIcon = icon ?? Plus;
    return <div className={clsx("grid place-items-center gap-1 rounded-xl border border-dashed border-neutral-200 px-3 py-4 text-center text-xs font-medium text-neutral-400", className)}><ColumnIcon size={15} aria-hidden="true" /><span>{title}</span>{children}</div>;
  }

  if (variant === "compact") {
    const CompactIcon = icon ?? SearchX;
    return <div className={clsx("flex items-center gap-3 rounded-xl bg-neutral-50 px-3 py-2.5 text-left", className)}>
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-neutral-400 shadow-sm"><CompactIcon size={15} /></span>
      <p className="min-w-0 flex-1 text-xs leading-5 text-neutral-500"><span className="font-semibold text-neutral-700">{title}</span>{body && <> {body}</>}</p>
      {action && <button type="button" onClick={action.onClick} disabled={action.disabled} className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50">{action.label}</button>}
      {children}
    </div>;
  }

  if (variant === "page") {
    const PageIcon = icon ?? Plus;
    return <section className={clsx("vso-fade-enter relative overflow-hidden rounded-3xl border border-neutral-100 bg-white shadow-card", className)}>
      <div className="relative h-44 overflow-hidden sm:h-52">
        <div aria-hidden="true" data-tone={tone} className="vso-empty-glow absolute inset-0" />
        <Dither colors={DITHER[tone]} origin={[0.5, -0.2]} reach={0.95} pixel={4} className="opacity-70" />
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--color-neutral-0)] to-transparent" />
        {art ?? <div aria-hidden="true" className="absolute left-1/2 top-[56%] h-24 w-48 -translate-x-1/2 -translate-y-1/2">
          <span className="absolute inset-0 -rotate-[8deg] translate-x-[-22px] translate-y-[8px] rounded-2xl border border-neutral-200 bg-white opacity-60 shadow-sm" />
          <span className="absolute inset-0 rotate-[6deg] translate-x-[22px] translate-y-[2px] rounded-2xl border border-neutral-200 bg-white opacity-80 shadow-sm" />
          <span className="absolute inset-0 grid place-items-center rounded-2xl border border-neutral-100 bg-white shadow-xl"><EmptyTile icon={PageIcon} tone={tone} size={52} /></span>
        </div>}
      </div>
      <div className="relative px-6 pb-8 text-center sm:px-10">
        <h2 className="text-lg font-extrabold tracking-[-.03em] text-neutral-900 [text-wrap:balance] sm:text-xl">{title}</h2>
        {body && <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-neutral-500">{body}</p>}
        <Actions action={action} secondary={secondary}>{children}</Actions>
      </div>
    </section>;
  }

  const quiet = variant === "filtered" || variant === "select";
  const tileIcon = icon ?? (variant === "filtered" ? SearchX : variant === "select" ? PointerClick : variant === "error" ? AlertTriangle : Plus);
  const tileTone: EmptyTone = variant === "error" ? "red" : tone;
  const filteredAction = variant === "filtered" && action ? { icon: FilterX, ...action } : action;
  const errorAction = variant === "error" && action ? { icon: RefreshCw, ...action } : filteredAction;
  return <div role={variant === "error" ? "alert" : undefined} className={clsx("vso-fade-enter relative grid place-items-center overflow-hidden px-6 text-center", variant === "select" ? "h-full min-h-[260px] py-10" : "min-h-[208px] py-10", className)}>
    <div className="relative grid justify-items-center">
      {/* The dither is anchored to the icon, so it stays with the content however tall the container is. */}
      {!quiet && <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[-64px] h-[230px] w-[440px] max-w-[92vw] -translate-x-1/2"><Dither colors={DITHER[tileTone]} origin={[0.5, 0.36]} reach={0.62} pixel={3} className="vso-empty-card-dither opacity-60" /></div>}
      <EmptyTile icon={tileIcon} tone={tileTone} quiet={quiet} />
      <h3 className="mt-3 text-sm font-bold text-neutral-900 [text-wrap:balance]">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-[13px] leading-5 text-neutral-500">{body}</p>}
      <Actions action={errorAction} secondary={secondary} compact>{children}</Actions>
    </div>
  </div>;
}
