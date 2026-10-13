"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { prefersReducedMotion, springTiming } from "@/lib/motion";

// Motion review decisions 3C and 4C: cards glide between columns on a soft spring (bounce 0.25); a dragged card lifts
// and tilts (scale 1.04, -2.5°) and springs into place when dropped, unwinding the tilt as it lands.
const LIFT = "scale(1.04) rotate(-2.5deg)";
const LIFT_SHADOW = "0 18px 40px -12px rgb(16 24 40 / .35), 0 4px 10px rgb(16 24 40 / .08)";
const glide = () => springTiming(0.25, 0.42);
const settle = () => springTiming(0.35, 0.4);
const DRAG_THRESHOLD = 5;

type Snapshot = { rects: Map<string, DOMRect>; dropped?: string };
type Gesture = { id: string; pointerId: number; startX: number; startY: number; card: HTMLElement; ghost: HTMLElement | null; offsetX: number; offsetY: number; x: number; y: number; over: string | null; scroll: number };

const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest('button, input, select, textarea, [role="combobox"], [data-no-drag]');

/**
 * Board motion: cards (`data-flip-id`) glide to their new place whenever `capture()` runs before a state change,
 * and mouse or pen users can drag a card onto a column (`data-drop-column`). Touch users keep each card's move control.
 * `onDrop` returns true when it accepted the move (and updated state); otherwise the card returns to where it was.
 */
export function useBoardMotion<Column extends string>(onDrop: (id: string, column: Column) => boolean, { scrollAxis = "page" }: { scrollAxis?: "page" | "x" } = {}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const snapshot = useRef<Snapshot | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const onDropRef = useRef(onDrop);
  const [draggingId, setDraggingId] = useState("");
  const [overColumn, setOverColumn] = useState<Column | null>(null);
  const scrollAxisRef = useRef(scrollAxis);
  useEffect(() => { onDropRef.current = onDrop; scrollAxisRef.current = scrollAxis; }, [onDrop, scrollAxis]);

  const capture = useCallback((dropped?: { id: string; rect: DOMRect }) => {
    const rects = new Map<string, DOMRect>();
    rootRef.current?.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((element) => rects.set(element.dataset.flipId!, element.getBoundingClientRect()));
    if (dropped) rects.set(dropped.id, dropped.rect);
    snapshot.current = { rects, dropped: dropped?.id };
  }, []);

  // After the render that follows capture(), play each card from its old place to its new one.
  useLayoutEffect(() => {
    const before = snapshot.current;
    if (!before) return;
    snapshot.current = null;
    if (prefersReducedMotion() || !rootRef.current) return;
    rootRef.current.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((element) => {
      const id = element.dataset.flipId!;
      const from = before.rects.get(id);
      if (!from) return;
      const to = element.getBoundingClientRect();
      const dx = from.left - to.left, dy = from.top - to.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      element.style.zIndex = "5";
      const dropped = id === before.dropped;
      const animation = element.animate([{ transform: `translate(${dx}px, ${dy}px)${dropped ? ` ${LIFT}` : ""}` }, { transform: "none" }], dropped ? settle() : glide());
      const reset = () => { element.style.zIndex = ""; };
      animation.onfinish = reset;
      animation.oncancel = reset;
    });
  });

  const finish = useCallback((accept: boolean) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    window.cancelAnimationFrame(current.scroll);
    const ghost = current.ghost;
    setOverColumn(null);
    if (!ghost) return;
    // Swallow the click that follows a drag so the card's link does not open.
    const stop = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
    // The ghost's own box (before its tilt), so the landing card starts exactly where the ghost is.
    const ghostRect = new DOMRect(current.x, current.y, ghost.offsetWidth, ghost.offsetHeight);
    const column = current.over as Column | null;
    if (accept && column) {
      capture({ id: current.id, rect: ghostRect });
      if (onDropRef.current(current.id, column)) { ghost.remove(); setDraggingId(""); return; }
      snapshot.current = null;
    }
    // Return to the original slot.
    const home = current.card.getBoundingClientRect();
    if (prefersReducedMotion()) { ghost.remove(); setDraggingId(""); return; }
    const done = () => { if (!ghost.isConnected) return; ghost.remove(); setDraggingId(""); };
    const back = settle();
    ghost.animate([{ transform: ghost.style.transform }, { transform: `translate(${home.left}px, ${home.top}px)` }], back).onfinish = done;
    // Animations pause in hidden tabs; never leave the copy behind.
    window.setTimeout(done, Number(back.duration) + 120);
  }, [capture]);

  useEffect(() => () => {
    const current = gesture.current;
    if (!current) return;
    window.cancelAnimationFrame(current.scroll);
    current.ghost?.remove();
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.ghost) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return;
        const rect = current.card.getBoundingClientRect();
        const ghost = current.card.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("data-flip-id");
        ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, { position: "fixed", left: "0", top: "0", margin: "0", width: `${rect.width}px`, zIndex: "90", pointerEvents: "none", boxShadow: LIFT_SHADOW, cursor: "grabbing", transition: "none" });
        current.offsetX = current.startX - rect.left;
        current.offsetY = current.startY - rect.top;
        current.x = rect.left; current.y = rect.top;
        ghost.style.transform = `translate(${rect.left}px, ${rect.top}px) ${LIFT}`;
        document.body.append(ghost);
        if (!prefersReducedMotion()) ghost.animate([{ transform: `translate(${rect.left}px, ${rect.top}px)`, boxShadow: "none" }, { transform: ghost.style.transform, boxShadow: LIFT_SHADOW }], { duration: 150, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
        current.ghost = ghost;
        document.body.style.cursor = "grabbing";
        setDraggingId(current.id);
      }
      event.preventDefault();
      current.x = event.clientX - current.offsetX; current.y = event.clientY - current.offsetY;
      current.ghost.style.transform = `translate(${current.x}px, ${current.y}px) ${LIFT}`;
      const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-drop-column]")?.dataset.dropColumn ?? null;
      if (over !== current.over) { current.over = over; setOverColumn(over as Column | null); }
      // Scroll the page (or a sideways board) while dragging near its edge.
      window.cancelAnimationFrame(current.scroll);
      const sideways = scrollAxisRef.current === "x";
      const scroller = sideways ? rootRef.current : document.getElementById("main-content");
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        const step = sideways
          ? event.clientX > bounds.right - 64 ? 14 : event.clientX < bounds.left + 64 ? -14 : 0
          : event.clientY > bounds.bottom - 64 ? 14 : event.clientY < bounds.top + 64 ? -14 : 0;
        if (step) { const tick = () => { if (sideways) scroller.scrollLeft += step; else scroller.scrollTop += step; current.scroll = window.requestAnimationFrame(tick); }; current.scroll = window.requestAnimationFrame(tick); }
      }
    }
    function onUp(event: PointerEvent) {
      if (!gesture.current || event.pointerId !== gesture.current.pointerId) return;
      document.body.style.cursor = "";
      finish(true);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || !gesture.current?.ghost) return;
      event.preventDefault();
      document.body.style.cursor = "";
      finish(false);
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [finish]);

  function cardProps(id: string, draggable: boolean) {
    return {
      "data-flip-id": id,
      ...(draggable ? {
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
          if (event.button !== 0 || event.pointerType === "touch" || gesture.current || interactive(event.target)) return;
          // Stops text selection and the browser's own link drag; the click still happens if the pointer does not move.
          event.preventDefault();
          gesture.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, card: event.currentTarget, ghost: null, offsetX: 0, offsetY: 0, x: 0, y: 0, over: null, scroll: 0 };
        },
      } : {}),
    };
  }
  const columnProps = (column: Column) => ({ "data-drop-column": column });
  /** A card moved with its keyboard control re-mounts in its new column; put focus back on that control. */
  const refocus = useCallback((id: string) => {
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(id)}"] [role="combobox"]`)?.focus({ preventScroll: true }));
  }, []);

  return { rootRef, capture, cardProps, columnProps, draggingId, overColumn, refocus };
}
