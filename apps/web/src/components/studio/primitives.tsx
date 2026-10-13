"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { Check, Inbox, RefreshCw, X, type Icon } from "@/components/ui/icons";
import { EmptyState, type EmptyTone } from "@/components/ui/empty-state";
import { prefersReducedMotion, useExitTransition } from "@/lib/motion";

/** Label-less pill controls for filter rows; they size to their content and turn green while filtering. */
export const filterControlClass = "min-h-9 max-w-60 rounded-full border border-neutral-200 bg-white px-3.5 text-[13px] font-semibold text-neutral-700 outline-none transition-[border-color,background-color,color,box-shadow] duration-150 placeholder:font-medium placeholder:text-neutral-400 hover:border-neutral-300 focus:border-primary-400 focus:ring-2 focus:ring-primary-100";
export const filterControl = (active: boolean) => active ? `${filterControlClass} !border-primary-300 !bg-primary-50 !text-primary-800` : filterControlClass;
export const inputClass ="min-h-11 min-w-0 w-full max-w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-neutral-400 focus:border-primary-400 focus:ring-2 focus:ring-primary-100";
export const primaryClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-primary-700 px-4 text-sm font-semibold text-white transition-[background-color,transform,opacity] duration-150 hover:bg-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary-700 disabled:active:scale-100";
export const secondaryClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-4 text-sm font-semibold text-neutral-700 transition-[background-color,transform,opacity] duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white disabled:active:scale-100";

export function PageFrame({ children }: { children: React.ReactNode }) { return <div data-vso-stagger-group className="mx-auto min-w-0 w-full max-w-[1580px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6">{children}</div>; }
export function PageTitle({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) { return <header className="mb-5 flex min-w-0 flex-wrap items-end justify-between gap-4"><div className="min-w-0 w-full sm:w-auto sm:flex-1"><h1 className="text-[clamp(1.6rem,3vw,2rem)] font-extrabold tracking-[-.04em] text-neutral-900">{title}</h1><p className="mt-1 break-words text-sm font-normal leading-6 text-neutral-500">{description}</p></div>{action}</header>; }
export function Panel({ children, className }: { children: React.ReactNode; className?: string }) { return <section data-vso-stagger-group className={clsx("min-w-0 rounded-2xl border border-neutral-100 bg-white shadow-card", className)}>{children}</section>; }
export function PanelHead({ title, aside }: { title: string; aside?: React.ReactNode }) { return <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4"><h2 className="text-sm font-bold text-neutral-900">{title}</h2>{aside}</div>; }
export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "blue" | "green" | "amber" | "red" | "purple" }) { const tones = { neutral: "bg-neutral-100 text-neutral-600", blue: "bg-primary-50 text-primary-700", green: "bg-success-surface text-success-text", amber: "bg-warning-surface text-warning-text", red: "bg-danger-surface text-danger-text", purple: "bg-ai-surface text-ai-text" }; return <span className={clsx("inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold transition-colors duration-200", tones[tone])}>{children}</span>; }
/** A card-style empty state (see components/ui/empty-state.tsx for the page, filtered, select, error, and column variants). */
export function Empty({ title, body, action, icon = Inbox, tone = "green" }: { title: string; body: string; action?: React.ReactNode; icon?: Icon; tone?: EmptyTone }) { return <EmptyState variant="card" icon={icon} tone={tone} title={title} body={body}>{action}</EmptyState>; }

/** Page-header actions: one row that never wraps. Secondary labels hide on phones (wrap them in `HeaderLabel`) so no button sits alone on a line. */
export function HeaderActions({ children, className }: { children: React.ReactNode; className?: string }) { return <div className={clsx("flex shrink-0 flex-nowrap items-center gap-2", className)}>{children}</div>; }
export function HeaderLabel({ children }: { children: React.ReactNode }) { return <span className="max-sm:sr-only">{children}</span>; }
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
/** A number whose digits roll like an odometer when it changes (decision 8C); the first value is static. */
export function RollingNumber({ value, className }: { value: number | string; className?: string }) {
  const text = String(value);
  const chars = [...text];
  return <span className={clsx("tnum", className)}><span className="sr-only">{text}</span><span aria-hidden="true">
    {/* Keyed by place from the right, so 9 → 10 rolls the ones digit and adds a tens digit. */}
    {chars.map((char, index) => <span key={`place-${chars.length - index}`} className={/\d/.test(char) ? "vso-odo-cell" : undefined}>{/\d/.test(char) ? <><span className="vso-odo-ghost">{char}</span><span className="vso-odo-col" style={{ transform: `translateY(${-Number(char) * 10}%)` }}>{DIGITS.map((digit) => <span key={digit}>{digit}</span>)}</span></> : char}</span>)}
  </span></span>;
}
export function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1.5 block text-xs font-semibold text-neutral-600">{label}</span>{children}</label>; }

/** Button text for a save-style action: "Saving…" while busy, then a brief "✓ Saved" before returning to idle. */
export function ActionLabel({ busy, done, idle, busyText = "Saving…", doneText = "Saved" }: { busy?: boolean; done?: boolean; idle: React.ReactNode; busyText?: string; doneText?: string }) {
  if (busy) return <span key="busy" className="vso-label-swap">{busyText}</span>;
  if (done) return <span key="done" className="vso-label-swap inline-flex items-center gap-1.5"><Check size={14} aria-hidden="true" />{doneText}</span>;
  return <>{idle}</>;
}

/** A short-lived key (e.g. which form just saved). Raising it again restarts the timer. */
export function useFlag(ms = 1600): [string, (key: string) => void] {
  const [flag, setFlag] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const raise = useCallback((key: string) => { window.clearTimeout(timer.current); setFlag(key); timer.current = window.setTimeout(() => setFlag(""), ms); }, [ms]);
  return [flag, raise];
}

/** Refresh control whose icon spins while the refetch runs. */
/** Icon-only refresh; it comes first in a page header, before secondary and primary actions. */
export function RefreshButton({ busy, onClick, label = "Refresh", className }: { busy: boolean; onClick: () => void; label?: string; className?: string }) {
  return <button type="button" onClick={onClick} aria-busy={busy || undefined} aria-label={label} title={label} className={clsx(secondaryClass, "!px-0 w-10 shrink-0", className)}><RefreshCw size={16} className={clsx(busy && "vso-spin")} /></button>;
}

/** Shimmering placeholder rows shaped like a list, shown on first load instead of "Loading…" text. */
export function SkeletonRows({ rows = 4, label = "Loading", className }: { rows?: number; label?: string; className?: string }) {
  return <div role="status" aria-label={label} className={clsx("grid gap-4 p-5", className)}>{Array.from({ length: rows }, (_, index) => <div key={index} className="flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-xl" /><span className="grid min-w-0 flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${72 - (index % 3) * 14}%` }} /><span className="vso-skeleton h-2.5" style={{ width: `${44 - (index % 2) * 12}%` }} /></span></div>)}</div>;
}

/**
 * Inline message that opens and closes smoothly instead of popping. It keeps showing the last text while it
 * closes, scrolls itself into view inside drawers, and success messages close themselves after `autoDismissMs`.
 */
export function Notice({ tone, message, onDismiss, autoDismissMs, className }: { tone: "error" | "success" | "info"; message: string; onDismiss?: () => void; autoDismissMs?: number; className?: string }) {
  const [shown, setShown] = useState(message);
  if (message && message !== shown) setShown(message);
  const box = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    if (!message) return;
    box.current?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    if (!autoDismissMs) return;
    const timer = window.setTimeout(() => dismissRef.current?.(), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [message, autoDismissMs]);
  const tones = { error: "bg-danger-surface text-danger-text", success: "bg-success-surface text-success-text", info: "bg-primary-50 text-primary-800" };
  return <div ref={box} data-open={Boolean(message)} aria-hidden={!message} className="vso-collapse">
    <div><div className={className}>
      <div role={tone === "error" ? "alert" : "status"} className={clsx("flex items-start gap-2 rounded-xl p-3 text-sm font-semibold", tones[tone])}>
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{shown}</p>
        {onDismiss && <button type="button" tabIndex={message ? 0 : -1} onClick={onDismiss} aria-label="Dismiss message" className="-my-1 -mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg opacity-60 transition-[opacity,background-color] duration-150 hover:bg-black/5 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"><X size={14} /></button>}
      </div>
    </div></div>
  </div>;
}

/**
 * Side drawer. Closing (button, Esc, backdrop) plays a short exit before `onClose` unmounts it.
 * With `dirty`, closing first asks inside the drawer whether to discard the changes.
 */
/** `actions` sit beside Close in the header (they stay put while the body scrolls); `footer` is a bar pinned under the body. */
export function DetailDrawer({ title, subtitle, onClose, dirty = false, enter = true, actions, footer, children }: { title: string; subtitle?: React.ReactNode; onClose: () => void; dirty?: boolean; enter?: boolean; actions?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
  const titleId = useId();
  const drawer = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const { state, close: exit } = useExitTransition(onClose, 170);
  const [confirming, setConfirming] = useState(false);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const requestClose = useCallback(() => {
    if (dirtyRef.current) { setConfirming(true); requestAnimationFrame(() => keepEditing.current?.focus()); return; }
    exit();
  }, [exit]);
  const requestCloseRef = useRef(requestClose);
  const confirmingRef = useRef(confirming);
  useEffect(() => { requestCloseRef.current = requestClose; confirmingRef.current = confirming; }, [requestClose, confirming]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('[role="combobox"][aria-expanded="true"]'))) return;
        event.preventDefault();
        if (confirmingRef.current) { setConfirming(false); return; }
        requestCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !drawer.current) return;
      const focusable = [...drawer.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); drawer.current.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !drawer.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !drawer.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div data-state={state} data-enter={enter} className="vso-backdrop fixed inset-0 z-50 flex justify-end bg-neutral-900/25 backdrop-blur-[1px]" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <aside ref={drawer} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="vso-enter-right flex h-full w-full max-w-[640px] flex-col bg-white shadow-e4">
      <header className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4"><div className="min-w-0"><h2 id={titleId} className="text-lg font-bold text-neutral-900 [overflow-wrap:anywhere]">{title}</h2>{subtitle && <p className="mt-1 text-xs text-neutral-500">{subtitle}</p>}</div><div className="flex shrink-0 items-center gap-1.5">{actions}<button ref={close} type="button" onClick={requestClose} aria-label="Close detail" className="min-h-10 rounded-xl px-3 text-sm font-semibold text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]">Close</button></div></header>
      <div data-open={confirming} className="vso-collapse"><div><div role="alertdialog" aria-label="Discard changes?" className="flex flex-wrap items-center justify-between gap-3 border-b border-warning-surface bg-warning-surface px-5 py-3"><p className="text-sm font-semibold text-warning-text">Discard your unsaved changes?</p><div className="flex gap-2"><button ref={keepEditing} type="button" tabIndex={confirming ? 0 : -1} onClick={() => setConfirming(false)} className={clsx(secondaryClass, "!min-h-9")}>Keep editing</button><button type="button" tabIndex={confirming ? 0 : -1} onClick={() => { setConfirming(false); exit(); }} className="inline-flex min-h-9 items-center rounded-xl bg-danger px-3 text-sm font-semibold text-white transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.97]">Discard</button></div></div></div></div>
      <div className="thin-scroll flex-1 overflow-y-auto p-5">{children}</div>
      {footer && <div className="shrink-0 border-t border-neutral-100 bg-white px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
    </aside>
  </div>;
}
