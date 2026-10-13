"use client";

import { useId, useRef, useState } from "react";
import clsx from "clsx";
import { Dither } from "@/components/ui/dither";
import { ditherTone } from "@/components/ui/empty-state";

const SIZE = 340; const C = SIZE / 2;
const OUTER = 118; const INNER = 80;
const MAX_HOURS = 4; const MINUTE_STEP = 5; const MAX_MINUTES = MAX_HOURS * 60;
const HOUR_SWEEP = 72; // degrees per hour step: 0–4 h sit at 0°, 72°, … 288°.

const polar = (radius: number, degrees: number) => { const radians = ((degrees - 90) * Math.PI) / 180; return [C + radius * Math.cos(radians), C + radius * Math.sin(radians)] as const; };
/** Follows a 0–360° target by the shortest turn, so crossing 12 o'clock doesn't spin the knob the long way round. */
function useUnwrapped(target: number) {
  const [state, setState] = useState({ target, angle: target });
  if (state.target !== target) {
    const delta = ((((target - state.angle) % 360) + 540) % 360) - 180;
    const next = { target, angle: state.angle + delta };
    setState(next);
    return next.angle;
  }
  return state.angle;
}

const split = (total: number) => ({ hours: Math.floor(total / 60), minutes: total % 60 });
export const formatDuration = (total: number) => total >= 60 ? `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m` : `${total} min`;

/**
 * Two concentric dials: the outer ring sets minutes in 5-minute detents, the inner ring sets hours (0–4).
 * Turning the minutes past 12 o'clock carries into the hours, like a watch crown. Each detent snaps with a small
 * spring and a short vibration where the device supports it. Both rings are keyboard sliders.
 */
export function FocusDial({ value, onChange, now, disabled = false }: { value: number; onChange: (minutes: number) => void; now: number; disabled?: boolean }) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<"hours" | "minutes" | null>(null);
  const [active, setActive] = useState<"hours" | "minutes" | null>(null);
  const [pulse, setPulse] = useState(0);
  // Minutes set before reaching the 4h cap (which forces :00), restored when the hours come back down.
  const parked = useRef<number | null>(null);
  const { hours, minutes } = split(value);

  const commit = (nextHours: number, nextMinutes: number) => {
    // Turning the minutes back past 12 o'clock at 0h stops at zero instead of wrapping to :55.
    if (nextHours < 0) { nextHours = 0; nextMinutes = 0; }
    const h = Math.min(MAX_HOURS, nextHours);
    if (h === MAX_HOURS && hours < MAX_HOURS) parked.current = minutes;
    let m = h === MAX_HOURS ? 0 : ((nextMinutes % 60) + 60) % 60;
    if (hours === MAX_HOURS && h < MAX_HOURS && m === 0 && parked.current !== null) { m = parked.current; parked.current = null; }
    const total = h * 60 + m;
    if (total === value) return;
    onChange(total);
    setPulse((count) => count + 1);
    // A short tick on phones that can vibrate; desktops ignore it.
    try { navigator.vibrate?.(6); } catch { /* not supported */ }
  };

  const angleAt = (clientX: number, clientY: number) => {
    const box = svg.current!.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * SIZE; const y = ((clientY - box.top) / box.height) * SIZE;
    return { angle: ((Math.atan2(y - C, x - C) * 180) / Math.PI + 90 + 360) % 360, distance: Math.hypot(x - C, y - C) };
  };

  const applyAngle = (ring: "hours" | "minutes", angle: number) => {
    if (ring === "hours") { commit(Math.round(angle / HOUR_SWEEP) % (MAX_HOURS + 1), minutes); return; }
    const next = (Math.round(angle / (360 / (60 / MINUTE_STEP))) * MINUTE_STEP) % 60;
    // Crossing 12 o'clock carries into the next (or previous) hour.
    const carry = minutes >= 45 && next <= 10 ? 1 : minutes <= 10 && next >= 45 ? -1 : 0;
    commit(hours + carry, next);
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const { angle, distance } = angleAt(event.clientX, event.clientY);
    if (distance < 40 || distance > OUTER + 26) return;
    const ring = distance > (OUTER + INNER) / 2 ? "minutes" : "hours";
    dragging.current = ring; setActive(ring);
    event.currentTarget.setPointerCapture(event.pointerId);
    applyAngle(ring, angle);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => { if (dragging.current) applyAngle(dragging.current, angleAt(event.clientX, event.clientY).angle); };
  const endDrag = () => { dragging.current = null; setActive(null); };

  const keyFor = (ring: "hours" | "minutes") => (event: React.KeyboardEvent) => {
    if (disabled) return;
    const step = ring === "hours" ? 60 : event.shiftKey ? 1 : MINUTE_STEP;
    const map: Record<string, number> = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 60, PageDown: -60 };
    let next = value;
    if (event.key in map) next = value + map[event.key]!;
    else if (event.key === "Home") next = ring === "hours" ? minutes : hours * 60;
    else if (event.key === "End") next = ring === "hours" ? MAX_MINUTES : Math.min(MAX_MINUTES, hours * 60 + 55);
    else return;
    event.preventDefault();
    const total = Math.max(0, Math.min(MAX_MINUTES, next));
    commit(Math.floor(total / 60), total % 60);
  };

  const minuteAngle = (minutes / 60) * 360; const hourAngle = hours * HOUR_SWEEP;
  const minuteTurn = useUnwrapped(minuteAngle); const hourTurn = useUnwrapped(hourAngle);
  const ends = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(now + value * 60_000));
  const knob = (radius: number, turn: number, ring: "hours" | "minutes", label: string, valueNow: number, max: number, text: string) => <g role="slider" tabIndex={disabled ? -1 : 0} aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={valueNow} aria-valuetext={text} aria-disabled={disabled || undefined}
    onKeyDown={keyFor(ring)} onFocus={() => setActive(ring)} onBlur={() => setActive(null)} className={clsx("vso-dial-knob cursor-grab outline-none", ring === "hours" && "is-hours")} style={{ transform: `rotate(${turn}deg)`, transformOrigin: `${C}px ${C}px` }}>
    <circle cx={C} cy={C - radius} r={active === ring ? 15 : 12} className={clsx("vso-dial-knob-ring", active === ring && "is-active")} />
    <circle key={pulse} cx={C} cy={C - radius} r={5} className="vso-dial-knob-dot" />
  </g>;
  const arc = (radius: number, fraction: number, width: number, gradient: string) => { const length = 2 * Math.PI * radius; return <circle cx={C} cy={C} r={radius} fill="none" strokeWidth={width} strokeLinecap="round" stroke={`url(#${gradient})`} strokeDasharray={`${length * fraction} ${length}`} transform={`rotate(-90 ${C} ${C})`} className="vso-dial-arc" style={{ opacity: fraction > 0 ? 1 : 0 }} />; };

  return <div className={clsx("relative mx-auto aspect-square w-full max-w-[320px] select-none touch-none", disabled && "opacity-60")}>
    {/* Pixel-dithered core behind the readout. */}
    <div aria-hidden="true" className="absolute inset-[29.5%] overflow-hidden rounded-full bg-[var(--color-neutral-50)]">
      <Dither colors={ditherTone("green")} origin={[0.5, 0.5]} reach={0.9} pixel={3} className="opacity-80" />
    </div>
    <svg ref={svg} viewBox={`0 0 ${SIZE} ${SIZE}`} className="relative h-full w-full" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <defs>
        <linearGradient id={`${id}-outer`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#34d399" /><stop offset="1" stopColor="#0f766e" /></linearGradient>
        <linearGradient id={`${id}-inner`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#60a5fa" /><stop offset="1" stopColor="#4338ca" /></linearGradient>
      </defs>
      {/* Minute ticks: every minute, longer every 5; lit up to the current value like an LED scale. */}
      {Array.from({ length: 60 }, (_, tick) => { const major = tick % 5 === 0; const [x0, y0] = polar(OUTER + 14, tick * 6); const [x1, y1] = polar(OUTER + (major ? 24 : 19), tick * 6); return <line key={tick} x1={x0} y1={y0} x2={x1} y2={y1} strokeWidth={major ? 2 : 1} strokeLinecap="round" className={clsx("transition-[stroke] duration-150", tick < minutes || (tick === 0 && minutes > 0) ? "stroke-primary-500" : "stroke-neutral-200")} />; })}
      <circle cx={C} cy={C} r={OUTER} fill="none" strokeWidth={14} className="stroke-neutral-100" />
      {arc(OUTER, minutes / 60, 14, `${id}-outer`)}
      <circle cx={C} cy={C} r={INNER} fill="none" strokeWidth={10} className="stroke-neutral-100" />
      {arc(INNER, hourAngle / 360, 10, `${id}-inner`)}
      {/* Hour detents with their numbers inside the inner ring. */}
      {Array.from({ length: MAX_HOURS + 1 }, (_, hour) => { const [dx, dy] = polar(INNER, hour * HOUR_SWEEP); const [lx, ly] = polar((INNER + OUTER) / 2 - 1, hour * HOUR_SWEEP); return <g key={hour}><circle cx={dx} cy={dy} r={2.5} className={hour <= hours ? "fill-white" : "fill-neutral-300"} /><text x={lx} y={ly} textAnchor="middle" dominantBaseline="central" className={clsx("font-mono text-[10px] font-semibold", hour === hours ? "fill-neutral-900" : "fill-neutral-400")}>{hour}h</text></g>; })}
      {/* Quarter labels for minutes, just outside the ticks. */}
      {[0, 15, 30, 45].map((mark) => { const [x, y] = polar(OUTER + 36, mark * 6); return <text key={mark} x={x} y={y} textAnchor="middle" dominantBaseline="central" className="fill-neutral-400 font-mono text-[10px] font-semibold">{mark}</text>; })}
      {knob(INNER, hourTurn, "hours", "Hours", hours, MAX_HOURS, `${hours} ${hours === 1 ? "hour" : "hours"}`)}
      {knob(OUTER, minuteTurn, "minutes", "Minutes", minutes, 59, `${minutes} ${minutes === 1 ? "minute" : "minutes"}`)}
    </svg>
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center text-center">
      <div>
        <p className="font-mono text-[26px] font-extrabold leading-none tracking-tight text-neutral-900 tnum">{value ? formatDuration(value) : "0 min"}</p>
        <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-500">{value ? `Ends ${ends}` : "Turn a ring"}</p>
      </div>
    </div>
  </div>;
}
