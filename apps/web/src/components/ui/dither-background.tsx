"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";

// An 8×8 Bayer matrix as thresholds between 0 and 1: ordered dithering turns a smooth field into a pattern of dots.
const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map((value) => (value + 0.5) / 64);
const FRAME_MS = 1000 / 24;

/**
 * A slowly drifting ordered-dither pattern of soft waves, drawn in chunky pixels behind a stage. Purely decorative:
 * hidden from assistive tech, still for people who prefer reduced motion, and paused while the tab is hidden.
 * `color` is RGBA (0-255); `density` (0-1) sets how much of the area the dots cover at the waves' peaks.
 */
export function DitherBackground({ color, density = 0.55, cell = 5, speed = 1, fade = true, className }: { color: readonly [number, number, number, number]; density?: number; cell?: number; speed?: number; fade?: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [red, green, blue, alpha] = color;
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dot = ((alpha << 24) | (blue << 16) | (green << 8) | red) >>> 0; // ImageData is RGBA bytes, read little-endian
    let width = 0; let height = 0;
    let image: ImageData | null = null; let pixels: Uint32Array | null = null;
    let raf = 0; let last = -Infinity;

    const draw = (time: number) => {
      if (!image || !pixels) return;
      const t = (time / 1000) * speed;
      // The field is a sum of three travelling waves; each depends on one axis, so it's a few lookups per dot.
      const columns = new Float32Array(width); const rows = new Float32Array(height); const diagonals = new Float32Array(width + height);
      for (let x = 0; x < width; x++) columns[x] = Math.sin(x * 0.045 + t * 0.6);
      for (let y = 0; y < height; y++) rows[y] = Math.sin(y * 0.06 - t * 0.45);
      for (let d = 0; d < width + height; d++) diagonals[d] = Math.sin(d * 0.028 + t * 0.3);
      for (let y = 0; y < height; y++) {
        const row = rows[y]!; const band = (y & 7) << 3;
        // Stronger near the top, easing off further down, so text below stays calm.
        const strength = density * (fade ? 1 - 0.55 * (y / height) : 1);
        const offset = y * width;
        for (let x = 0; x < width; x++) {
          const value = (columns[x]! + row + diagonals[x + y]!) / 6 + 0.5;
          pixels[offset + x] = value * strength > BAYER[band + (x & 7)]! ? dot : 0;
        }
      }
      context.putImageData(image, 0, 0);
    };
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      width = Math.max(1, Math.ceil(box.width / cell)); height = Math.max(1, Math.ceil(box.height / cell));
      canvas.width = width; canvas.height = height;
      image = context.createImageData(width, height); pixels = new Uint32Array(image.data.buffer);
      draw(last === -Infinity ? 0 : last);
    };
    const loop = (time: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || time - last < FRAME_MS) return;
      last = time;
      // Follow the stage's size every frame too (content arriving can make it taller), not only on resize notices.
      const box = canvas.getBoundingClientRect();
      if (Math.ceil(box.width / cell) !== width || Math.ceil(box.height / cell) !== height) resize();
      draw(time);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    if (!still) raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [red, green, blue, alpha, density, cell, speed, fade]);
  return <canvas ref={canvasRef} aria-hidden="true" className={clsx("pointer-events-none [image-rendering:pixelated]", className)} />;
}
