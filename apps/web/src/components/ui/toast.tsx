"use client";

import { useEffect, useSyncExternalStore } from "react";
import clsx from "clsx";
import { Check, CircleAlert, Info, X } from "@/components/ui/icons";
import { prefersReducedMotion } from "@/lib/motion";

type Tone = "success" | "info" | "error";
type ToastInput = {
  id?: string;
  title?: string;
  body?: string;
  tone?: Tone;
  action?: { label: string; onClick: () => void };
  /** Milliseconds before closing on its own; ignored when `sticky`. */
  duration?: number;
  /** Stays until dismissed (reminders, deadline warnings). */
  sticky?: boolean;
  /** Fully custom content (the notification toast renders its own actions). */
  node?: React.ReactNode;
  /** Runs once when the toast leaves: "action" after its action button, otherwise "dismissed" (timeout, close, or pushed out). */
  onClose?: (reason: "action" | "dismissed") => void;
};
type ToastItem = ToastInput & { id: string; leaving: boolean; remaining: number; startedAt: number; timer: number };

const EXIT_MS = 240;
const MAX_VISIBLE = 3;
let items: ToastItem[] = [];
let paused = false;
// Paused while hovered, while a toast holds focus, or while the tab is hidden.
let hovered = false;
let focused = false;
let hiddenTab = false;
const updatePaused = () => setPaused(hovered || focused || hiddenTab);
const listeners = new Set<() => void>();
const emit = () => { items = [...items]; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => items;
const empty: ToastItem[] = [];

function schedule(item: ToastItem) {
  window.clearTimeout(item.timer);
  if (item.sticky || item.leaving || paused || document.visibilityState === "hidden") return;
  item.startedAt = Date.now();
  item.timer = window.setTimeout(() => dismissToast(item.id), item.remaining);
}

/** Show (or update, when `id` matches an open toast) a toast. Returns its id. */
export function toast(input: ToastInput) {
  const id = input.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const existing = items.find((item) => item.id === id && !item.leaving);
  if (existing) {
    Object.assign(existing, input, { id });
    emit();
    return id;
  }
  const item: ToastItem = { tone: "success", ...input, id, leaving: false, remaining: input.duration ?? 4000, startedAt: 0, timer: 0 };
  items = [item, ...items];
  items.filter((entry) => !entry.leaving).slice(MAX_VISIBLE).forEach((entry) => { if (!entry.sticky) beginLeave(entry); });
  schedule(item);
  emit();
  return id;
}

function beginLeave(item: ToastItem, reason: "action" | "dismissed" = "dismissed") {
  window.clearTimeout(item.timer);
  item.leaving = true;
  item.onClose?.(reason);
  window.setTimeout(() => {
    items = items.filter((entry) => entry !== item);
    // Browsers do not always report blur when the focused toast is removed.
    focused = Boolean(document.activeElement?.closest("[data-toast-region]"));
    updatePaused();
    emit();
  }, prefersReducedMotion() ? 0 : EXIT_MS);
}

export function dismissToast(id: string, reason: "action" | "dismissed" = "dismissed") {
  const item = items.find((entry) => entry.id === id && !entry.leaving);
  if (!item) return;
  beginLeave(item, reason);
  emit();
}

function setPaused(next: boolean) {
  if (paused === next) return;
  paused = next;
  for (const item of items) {
    if (item.sticky || item.leaving) continue;
    if (next) { window.clearTimeout(item.timer); item.remaining = Math.max(800, item.remaining - (Date.now() - item.startedAt)); }
    else schedule(item);
  }
}

const icons = { success: Check, info: Info, error: CircleAlert };
const iconTones = { success: "bg-success-surface text-success-text", info: "bg-primary-100 text-primary-700", error: "bg-danger-surface text-danger-text" };

/** One stack at the top right. Toasts slide in from the right edge, newest on top, and pause while hovered or the tab is hidden. */
export function ToastRegion() {
  const list = useSyncExternalStore(subscribe, snapshot, () => empty);
  useEffect(() => {
    const onVisibility = () => { hiddenTab = document.visibilityState === "hidden"; updatePaused(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return <section data-toast-region aria-label="Notifications" className="pointer-events-none fixed right-3 top-16 z-[70] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col sm:right-5" onMouseEnter={() => { hovered = true; updatePaused(); }} onMouseLeave={() => { hovered = false; updatePaused(); }} onFocusCapture={() => { focused = true; updatePaused(); }} onBlurCapture={(event) => { focused = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget); updatePaused(); }}>
    {list.map((item) => {
      const Icon = icons[item.tone ?? "success"];
      return <div key={item.id} data-leaving={item.leaving} className="vso-toast-row">
        <div className="pb-2"><div className="vso-toast pointer-events-auto">
          {item.node ?? <div role={item.tone === "error" ? "alert" : "status"} className="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3.5 text-left shadow-[0_12px_34px_rgba(38,38,55,.16)]">
            <span className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-lg", iconTones[item.tone ?? "success"])}><Icon size={16} /></span>
            <div className="min-w-0 flex-1 pt-0.5">{item.title && <p className="break-words text-sm font-semibold text-neutral-800">{item.title}</p>}{item.body && <p className="mt-0.5 break-words text-xs leading-5 text-neutral-500">{item.body}</p>}{item.action && <button type="button" onClick={() => { item.action!.onClick(); dismissToast(item.id, "action"); }} className="mt-2 inline-flex min-h-8 items-center rounded-lg bg-primary-50 px-2.5 text-xs font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-100 active:scale-[0.97]">{item.action.label}</button>}</div>
            <button type="button" onClick={() => dismissToast(item.id)} aria-label="Dismiss" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700"><X size={14} /></button>
          </div>}
        </div></div>
      </div>;
    })}
  </section>;
}
