"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { X } from "@/components/ui/icons";
import { prefersReducedMotion, springTiming } from "@/lib/motion";

export type IslandMessage = { id: string; title: string; body: string; href: string; at: string };
type Phase = "hidden" | "pill" | "open" | "closing";

const PILL = { width: 132, height: 36, radius: 18 };
const VISIBLE_ROWS = 3;

/** "Divyansh Dwivedi" and "#general" (or "Direct message", "mentioned you in #general") from a notice title. */
function parts(title: string): { name: string; where: string } {
  let match = /^Message from (.+?)( \(via Claude\))?$/.exec(title);
  if (match) return { name: match[1]!, where: match[2] ? "Direct message · via Claude" : "Direct message" };
  match = /^(.+?) mentioned you in (#.+)$/.exec(title);
  if (match) return { name: match[1]!, where: `mentioned you in ${match[2]}` };
  match = /^(.+?) in (#.+)$/.exec(title);
  if (match) return { name: match[1]!, where: match[2]! };
  return { name: title, where: "" };
}

/** "#general" for a channel message or mention; nothing for a direct message (the compact rows have little room). */
const channelOf = (where: string) => /#\S+/.exec(where)?.[0] ?? "";
const initials = (name: string) => name.replace(/\(via Claude\)/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";
const AVATAR_TONES = ["#1f8a55", "#2563eb", "#9333ea", "#c2410c", "#0e7490", "#be185d"];
const tone = (name: string) => AVATAR_TONES[[...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % AVATAR_TONES.length];
function ago(at: string) {
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * New messages while you're on another page of the app, shown like a MacBook notch / Dynamic Island: a black pill drops
 * in at the top, grows into a card with who wrote what, and stays until you open a message or close it. More messages
 * stack inside it. Reminders and other notices keep the regular pop-up.
 */
export function MessageIsland({ items, onOpen, onClose }: { items: IslandMessage[]; onOpen: (item: IslandMessage) => void; onClose: () => void }) {
  const [phase, setPhaseState] = useState<Phase>("hidden");
  const phaseRef = useRef<Phase>("hidden");
  const setPhase = (next: Phase) => { phaseRef.current = next; setPhaseState(next); };
  const [shown, setShown] = useState<IslandMessage[]>([]);
  const [contentHeight, setContentHeight] = useState(72);
  const [width, setWidth] = useState(400);
  const content = useRef<HTMLDivElement>(null);
  // Arrive as a pill, then grow; when the last message goes, shrink back to the pill and leave.
  useEffect(() => {
    queueMicrotask(() => {
      const current = phaseRef.current;
      if (items.length) {
        setShown(items);
        if (current === "hidden" || current === "closing") setPhase(prefersReducedMotion() ? "open" : "pill");
      } else if (current !== "hidden") {
        if (prefersReducedMotion()) { setPhase("hidden"); setShown([]); } else setPhase("closing");
      }
    });
  }, [items]);
  // Each step leads to the next on its own, so new messages arriving mid-way can't stall it.
  useEffect(() => {
    if (phase === "pill") { const timer = window.setTimeout(() => setPhase("open"), 170); return () => window.clearTimeout(timer); }
    if (phase === "closing") { const timer = window.setTimeout(() => { setPhase("hidden"); setShown([]); }, 400); return () => window.clearTimeout(timer); }
  }, [phase]);

  useEffect(() => {
    const fit = () => setWidth(Math.min(400, window.innerWidth - 16));
    queueMicrotask(fit);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const mounted = phase !== "hidden";
  // The card grows to fit its rows (the observer reports the first size straight away).
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setContentHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown.length, mounted]);

  if (phase === "hidden" || !shown.length) return null;
  const open = phase === "open";
  const spring = springTiming(open ? 0.22 : 0, open ? 0.5 : 0.34);
  const closing = phase === "closing";
  // Closing: shrink back to the pill, then fade out.
  const morph = prefersReducedMotion() ? "opacity 150ms ease" : [...["width", "height", "border-radius"].map((property) => `${property} ${spring.duration}ms ${spring.easing}`), `opacity 160ms ease ${closing ? 230 : 0}ms`].join(", ");
  const visible = shown.slice(0, VISIBLE_ROWS);
  const extra = shown.length - visible.length;

  return createPortal(<div className="pointer-events-none fixed inset-x-0 top-2 z-[80] flex justify-center px-2">
    <section role="status" aria-live="polite" aria-label={`${shown.length} new message${shown.length === 1 ? "" : "s"}`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      className={clsx("vso-island pointer-events-auto relative overflow-hidden bg-black text-white", phase === "pill" && "vso-island-arrive")}
      style={{ width: open ? width : PILL.width, height: open ? contentHeight : PILL.height, borderRadius: open ? 26 : PILL.radius, opacity: closing ? 0 : 1, transition: morph }}>
      <div ref={content} className={clsx("absolute left-0 top-0 transition-[opacity,filter] duration-200", open ? "opacity-100 blur-0 delay-100" : "opacity-0 blur-[3px]")} style={{ width }}>
        <div className="space-y-1 p-2.5">
          {visible.map((item, index) => {
            const { name, where } = parts(item.title);
            const first = index === 0;
            return <div key={item.id} className="group relative flex items-start rounded-[18px] transition-colors duration-150 hover:bg-white/[.07]">
              <button type="button" onClick={() => onOpen(item)} className={clsx("flex min-w-0 flex-1 items-start gap-3 rounded-[18px] p-1.5 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40", first ? "" : "items-center")}>
                <span aria-hidden="true" className={clsx("grid shrink-0 place-items-center rounded-full font-bold text-white", first ? "h-9 w-9 text-xs" : "h-6 w-6 text-[10px]")} style={{ background: tone(name) }}>{initials(name)}</span>
                {first ? <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5"><span className="max-w-[65%] shrink-0 truncate text-[13.5px] font-semibold">{name}</span>{where && <span className="min-w-0 truncate text-xs text-white/50">{where}</span>}<span className="ml-auto shrink-0 pl-2 text-[11px] text-white/40 tnum">{ago(item.at)}</span></span>
                  <span className="mt-0.5 line-clamp-2 text-[13px] leading-[18px] text-white/80">{item.body}</span>
                </span> : <span className="min-w-0 flex-1 truncate text-[12.5px] text-white/70"><span className="font-semibold text-white/90">{name}</span>{channelOf(where) && <span className="text-white/40"> {channelOf(where)}</span>} {item.body}</span>}
              </button>
              {first && <button type="button" aria-label="Close" onClick={onClose} className="mr-1 mt-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/50 transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"><X size={14} /></button>}
            </div>;
          })}
          {extra > 0 && <p className="px-2 pb-0.5 text-[11.5px] font-medium text-white/45">and {extra} more in your inbox</p>}
        </div>
      </div>
    </section>
  </div>, document.body);
}
