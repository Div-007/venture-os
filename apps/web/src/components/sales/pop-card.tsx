"use client";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import clsx from "clsx";
import { prefersReducedMotion } from "@/lib/motion";

/**
 * A card that pops toward the cursor: it lifts and tilts a few degrees, a soft green glow spreads behind it,
 * a sheen sweeps across once, and anything marked `PopAvatar` rises out in front with its own shadow.
 * Mouse only (touch and pen get the plain card); reduced motion keeps the shadow and glow, drops the movement.
 * Styles live in app/globals.css under "3D pop cards".
 */
/** `disabled` switches the effect off (a board turns it off while a card is being dragged, so cards under the pointer stay still). */
export function PopCard({ children, className, tilt = 7, disabled = false }: { children: ReactNode; className?: string; tilt?: number; disabled?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);

  function move(event: PointerEvent<HTMLDivElement>) {
    const element = wrap.current;
    if (!element || disabled || event.pointerType !== "mouse") return;
    if (!hover) setHover(true);
    if (prefersReducedMotion()) return;
    const box = element.getBoundingClientRect();
    const x = (event.clientX - box.left) / Math.max(1, box.width);
    const y = (event.clientY - box.top) / Math.max(1, box.height);
    element.style.setProperty("--pop-rx", `${((0.5 - y) * tilt).toFixed(2)}deg`);
    element.style.setProperty("--pop-ry", `${((x - 0.5) * tilt * 1.3).toFixed(2)}deg`);
    element.style.setProperty("--pop-x", `${Math.round(x * 100)}%`);
    element.style.setProperty("--pop-y", `${Math.round(y * 100)}%`);
  }
  function leave() {
    const element = wrap.current;
    if (element) { element.style.setProperty("--pop-rx", "0deg"); element.style.setProperty("--pop-ry", "0deg"); }
    setHover(false);
  }

  return <div ref={wrap} data-hover={(hover && !disabled) || undefined} className="vso-pop-wrap" onPointerEnter={(event) => { if (!disabled && event.pointerType === "mouse") setHover(true); }} onPointerMove={move} onPointerLeave={leave}>
    <span aria-hidden="true" className="vso-pop-glow" />
    <div className={clsx("vso-pop", className)}>{children}</div>
  </div>;
}

/** Initials badge that pops out of a PopCard on hover. */
export function PopAvatar({ name, className, size = "md" }: { name: string; className?: string; size?: "sm" | "md" | "lg" }) {
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
  const dims = size === "lg" ? "h-14 w-14 text-lg rounded-2xl" : size === "sm" ? "h-8 w-8 text-[11px] rounded-lg" : "h-11 w-11 text-sm rounded-xl";
  return <span aria-hidden="true" className={clsx("vso-pop-avatar grid shrink-0 place-items-center font-extrabold tracking-[-.02em] text-white", dims, className)}>{initials}</span>;
}
