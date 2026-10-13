"use client";

import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";

export type SlidingTab = { key: string; label: React.ReactNode; badge?: number };

/** Decision 2C: give the content under a set of tabs `vso-tab-enter` plus the direction of the switch (key the content by tab). */
export function useTabMotion(active: string, keys: readonly string[]) {
  const [last, setLast] = useState({ active, dir: 0 });
  if (last.active !== active) setLast({ active, dir: Math.sign(keys.indexOf(active) - keys.indexOf(last.active)) });
  return { className: "vso-tab-enter", style: { "--tab-dir": last.dir } as React.CSSProperties };
}

export function SlidingTabs({
  tabs,
  active,
  onChange,
  label,
  className,
  fitContent = true,
  tone = "light",
}: {
  tabs: SlidingTab[];
  active: string;
  onChange: (key: string) => void;
  label: string;
  className?: string;
  fitContent?: boolean;
  /** "dark" sits on a dark header (document reader): white pill, light text. */
  tone?: "light" | "dark";
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const keyboardChange = useRef(false);
  // Re-measure only when the set of tabs changes, not on every render of a fresh array.
  const tabKeys = tabs.map((tab) => tab.key).join("|");

  useLayoutEffect(() => {
    const list = listRef.current;
    const indicator = indicatorRef.current;
    if (!list || !indicator) return;

    const measure = () => {
      const selected = [...list.querySelectorAll<HTMLButtonElement>("[data-tab-key]")]
        .find((button) => button.dataset.tabKey === active);
      if (!selected) return;
      const parent = list.getBoundingClientRect();
      const target = selected.getBoundingClientRect();
      indicator.style.width = `${target.width}px`;
      indicator.style.height = `${target.height}px`;
      indicator.style.transform = `translate3d(${target.left - parent.left + list.scrollLeft}px, ${target.top - parent.top + list.scrollTop}px, 0)`;
      list.dataset.ready = "true";
      // Fade the edge that has more tabs past it, so a clipped label reads as "scroll for more".
      const before = list.scrollLeft > 4; const after = list.scrollLeft + list.clientWidth < list.scrollWidth - 4;
      list.dataset.fade = before && after ? "both" : before ? "left" : after ? "right" : "none";
      // Keep the active tab visible in a scrolling tab bar (phones).
      if (list.scrollWidth > list.clientWidth) {
        const left = target.left - parent.left + list.scrollLeft;
        if (left < list.scrollLeft || left + target.width > list.scrollLeft + list.clientWidth) list.scrollTo({ left: Math.max(0, left - 16), behavior: keyboardChange.current ? "auto" : "smooth" });
      }
    };

    if (keyboardChange.current) {
      indicator.style.transitionDuration = "0ms";
      keyboardChange.current = false;
      requestAnimationFrame(() => { indicator.style.transitionDuration = ""; });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    list.querySelectorAll("[data-tab-key]").forEach((button) => observer.observe(button));
    list.addEventListener("scroll", measure, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener("scroll", measure); };
  }, [active, tabKeys]);

  const moveByKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, tabs.findIndex((tab) => tab.key === active));
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    keyboardChange.current = true;
    onChange(tabs[next].key);
    requestAnimationFrame(() => {
      const button = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-tab-key]") ?? [])]
        .find((item) => item.dataset.tabKey === tabs[next].key);
      button?.focus();
    });
  };

  return (
    <div ref={listRef} role="tablist" aria-label={label} onKeyDown={moveByKey}
      className={clsx("vso-tabs relative min-w-0 gap-1 overflow-x-auto rounded-xl p-1", tone === "dark" ? "border border-white/15 bg-white/10" : "bg-white", fitContent ? "inline-flex w-fit max-w-full" : "flex", className)}>
      <span ref={indicatorRef} aria-hidden="true" className={clsx("vso-tab-indicator pointer-events-none absolute left-0 top-0 z-0 rounded-lg", tone === "dark" ? "bg-[#fff]" : "bg-primary-100")} />
      {tabs.map((tab) => (
        <button key={tab.key} type="button" role="tab" aria-selected={active === tab.key}
          tabIndex={active === tab.key ? 0 : -1} data-tab-key={tab.key}
          onClick={() => onChange(tab.key)}
          className={clsx("relative z-10 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg font-semibold",
            tone === "dark" ? "min-h-8 px-2.5 text-xs focus-visible:ring-white/80" : "min-h-10 px-3 text-sm focus-visible:ring-primary-600",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2",
            tone === "dark" ? (active === tab.key ? "text-[#171717]" : "text-white/75 hover:text-white") : active === tab.key ? "text-primary-800" : "text-neutral-500 hover:text-neutral-900")}
        >
          {tab.label}
          {tab.badge != null && <span className={clsx("rounded-full px-1.5 py-0.5 text-[10px] leading-none tnum", active === tab.key ? "bg-primary-200 text-primary-900" : "bg-neutral-100 text-neutral-600")}>{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}
