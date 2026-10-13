"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { prefersReducedMotion } from "@/lib/motion";

export type ChatMenuAction = { label: string; onSelect: () => void; disabled?: boolean };

/** True when the event came from a control inside the message (attachment buttons, links), not the message itself. */
const fromInnerControl = (event: { target: EventTarget | null; currentTarget: EventTarget }) => event.target instanceof Element && event.target !== event.currentTarget && !!event.target.closest("button, a[href], input, textarea, select");

export function ChatMessageMenu({ children, actions, label = "Message actions" }: { children: ReactNode; actions: ChatMenuAction[]; label?: string }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const [pressing, setPressing] = useState(false);
  const trigger = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressCue = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  function clearHold() {
    if (hold.current) clearTimeout(hold.current);
    if (pressCue.current) clearTimeout(pressCue.current);
    hold.current = null; pressCue.current = null;
    setPressing(false);
  }
  function open(x: number, y: number) {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setClosing(false);
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - 190)), y: Math.max(8, Math.min(y, window.innerHeight - 196)) });
  }
  /** Pointer dismissals fade out; keyboard ones close at once. */
  function close(animate: boolean, refocus: boolean) {
    if (refocus) trigger.current?.focus();
    if (!animate || prefersReducedMotion()) { setPosition(null); return; }
    setClosing(true);
    closeTimer.current = setTimeout(() => { setPosition(null); setClosing(false); }, 100);
  }

  useEffect(() => {
    if (!position || closing) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(true, false); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(false, true); return; }
      if (event.key === "Tab") { close(false, false); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    // The menu is fixed to the screen; scrolling the conversation would leave it floating over the wrong message.
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && menu.current?.contains(event.target))) close(false, false); };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("keydown", onKeyDown); window.removeEventListener("scroll", onScroll, true); };
  }, [position, closing]);
  useEffect(() => () => { clearHold(); if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  return <>
    <div ref={trigger} role="button" tabIndex={0} aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(position) && !closing}
      className={clsx("inline-block max-w-full cursor-context-menu select-text rounded-2xl align-bottom transition-transform duration-300 ease-out [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-500)]", pressing && "scale-[0.97]")}
      onClick={(event) => {
        if (position || fromInnerControl(event) || window.getSelection()?.toString()) return;
        const box = event.currentTarget.getBoundingClientRect();
        open(box.left + Math.min(box.width / 2, 120), box.bottom + 4);
      }}
      onContextMenu={(event) => { if (fromInnerControl(event)) return; event.preventDefault(); open(event.clientX, event.clientY); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key === "Enter" || event.key === " ") { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); open(box.left + Math.min(box.width / 2, 120), box.bottom + 4); }
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch" || fromInnerControl(event)) return;
        pointer.current = { x: event.clientX, y: event.clientY }; clearHold();
        // A gentle press-in confirms the hold before the menu opens.
        pressCue.current = setTimeout(() => setPressing(true), 150);
        hold.current = setTimeout(() => { setPressing(false); navigator.vibrate?.(10); open(event.clientX, event.clientY); }, 500);
      }}
      onPointerMove={(event) => { if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 8) clearHold(); }}
      onPointerUp={clearHold} onPointerCancel={clearHold}>{children}</div>
    {position && createPortal(<div ref={menu} role="menu" aria-label={label} data-align="left" data-state={closing ? "closing" : undefined} className="vso-enter-popover fixed z-[90] min-w-44 rounded-xl border border-[var(--color-neutral-200)] bg-white p-1.5 text-left shadow-[0_14px_35px_rgba(0,0,0,.2)]" style={{ left: position.x, top: position.y }}>
      {actions.map((action) => <button key={action.label} type="button" role="menuitem" disabled={action.disabled} onClick={() => { close(true, true); action.onSelect(); }} className="block min-h-9 w-full rounded-lg px-3 text-left text-xs font-medium text-[var(--color-neutral-700)] transition-colors duration-100 hover:bg-[var(--color-primary-50)] focus-visible:bg-[var(--color-primary-50)] focus-visible:outline-none active:bg-[var(--color-primary-100)] disabled:opacity-40">{action.label}</button>)}
    </div>, document.body)}
  </>;
}
