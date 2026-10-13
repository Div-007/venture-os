"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";
import { prefersReducedMotion } from "@/lib/motion";

// 8x8 Bayer matrix: thresholds for ordered dithering, so a fade turns into a crisp pixel pattern instead of a blur.
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((value) => (value + 0.5) / 64);

/** Resolves any CSS color (including `var(--token)`) to RGB through the element's computed style. */
function resolveColor(host: HTMLElement, value: string): [number, number, number] | null {
  host.style.color = value;
  const match = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(getComputedStyle(host).color);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * A decorative ordered-dither fade. `colors` run from faint to strong; the strongest sits at `origin` (radial) or at
 * the start of `angle` (linear) and fades out to transparent. It redraws on size or theme changes; when `reach`
 * changes and `transitionMs` is set, the fade spreads or shrinks smoothly (instantly under reduced motion).
 * `animated` adds slow drifting waves through the pattern (about 24 fps, paused while hidden or off-screen).
 */
export function Dither({ colors, shape = "radial", origin = [0.5, 0.5], angle = 90, reach = 1, pixel = 3, transitionMs = 0, animated = false, className }: {
  colors: string[]; shape?: "radial" | "linear"; origin?: [number, number]; angle?: number; reach?: number; pixel?: number; transitionMs?: number; animated?: boolean; className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const shown = useRef(reach);
  const time = useRef(0);
  const draw = useRef<(value: number) => void>(() => {});
  const key = colors.join("|");
  const [ox, oy] = origin;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    draw.current = (currentReach: number) => {
      const { width, height } = element.getBoundingClientRect();
      const columns = Math.max(1, Math.ceil(width / pixel)); const rows = Math.max(1, Math.ceil(height / pixel));
      if (element.width !== columns) element.width = columns;
      if (element.height !== rows) element.height = rows;
      const context = element.getContext("2d");
      if (!context) return;
      const palette = key.split("|").map((value) => resolveColor(element, value));
      const image = context.createImageData(columns, rows);
      const radians = (angle * Math.PI) / 180; const dx = Math.cos(radians); const dy = Math.sin(radians);
      const aspect = columns / rows;
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const u = x / columns; const v = y / rows;
        const distance = shape === "radial" ? Math.hypot((u - ox) * aspect, v - oy) / (aspect * 0.75) : (u * dx + v * dy) * 0.5 + 0.5;
        const base = Math.max(0, 1 - distance / currentReach);
        // Drifting waves ride on the fade; with no animation `time` stays 0 and the pattern is still.
        const wave = time.current ? (0.16 * Math.sin(u * 7 + v * 3 + time.current * 1.1) + 0.1 * Math.cos(v * 6 - u * 2 - time.current * 0.8)) * Math.min(1, base * 2.2) : 0;
        const strength = Math.min(1, Math.max(0, base ** 1.35 + wave));
        const level = strength * palette.length;
        const index = Math.floor(level) + (level % 1 > BAYER[(y % 8) * 8 + (x % 8)]! ? 1 : 0);
        const color = index > 0 ? palette[Math.min(index, palette.length) - 1] : null;
        if (!color) continue;
        const offset = (y * columns + x) * 4;
        image.data[offset] = color[0]; image.data[offset + 1] = color[1]; image.data[offset + 2] = color[2]; image.data[offset + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    };
    const redraw = () => draw.current(shown.current);
    redraw();
    const resize = new ResizeObserver(redraw); resize.observe(element);
    // The palette uses theme tokens, so repaint when the theme switches.
    const theme = new MutationObserver(redraw); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => { resize.disconnect(); theme.disconnect(); };
  }, [key, shape, ox, oy, angle, pixel]);

  // Spread or shrink to a new reach: an ease-out tween, one canvas repaint per frame.
  useEffect(() => {
    const from = shown.current; const to = reach;
    if (from === to) return;
    if (!transitionMs || prefersReducedMotion()) { shown.current = to; draw.current(to); return; }
    const start = performance.now(); let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / transitionMs);
      shown.current = from + (to - from) * (1 - (1 - progress) ** 3);
      draw.current(shown.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [reach, transitionMs]);

  // Drift: advance the waves at ~24 fps while the canvas is on screen and the tab is visible.
  useEffect(() => {
    const element = canvas.current;
    if (!animated || !element || prefersReducedMotion()) return;
    let frame = 0; let last = 0; let visible = true;
    const start = performance.now();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible || document.hidden || now - last < 42) return;
      last = now; time.current = (now - start) / 1000 + 0.001;
      draw.current(shown.current);
    };
    const seen = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; }); seen.observe(element);
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); seen.disconnect(); time.current = 0; };
  }, [animated]);

  return <canvas ref={canvas} aria-hidden="true" className={clsx("pointer-events-none absolute inset-0 h-full w-full [image-rendering:pixelated]", className)} />;
}
