/** Timing for the app's films: clamped progress, mixing, easing curves, a damped spring, and seeded randomness. */
export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
export const span = (t: number, start: number, length: number) => clamp((t - start) / length, 0, 1);
export const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
export const outExpo = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
export const outCubic = (p: number) => 1 - (1 - p) ** 3;
export const inCubic = (p: number) => p ** 3;
export const inOutCubic = (p: number) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
export const inOutQuint = (p: number) => (p < 0.5 ? 16 * p ** 5 : 1 - (-2 * p + 2) ** 5 / 2);
export const outBack = (p: number, overshoot = 1.7) => 1 + (overshoot + 1) * (p - 1) ** 3 + overshoot * (p - 1) ** 2;
/** A damped spring from 0 to 1, `t` seconds after it was let go: `period` sets its pace, `bounce` its overshoot. */
export const spring = (t: number, period = 0.55, bounce = 0.3) => {
  if (t <= 0) return 0;
  const zeta = 1 - bounce; const omega = (2 * Math.PI) / period; const damped = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
};
export const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
};
export const shuffled = <T,>(items: T[], random: () => number) => { const copy = [...items]; for (let index = copy.length - 1; index > 0; index--) { const swap = Math.floor(random() * (index + 1)); [copy[index], copy[swap]] = [copy[swap]!, copy[index]!]; } return copy; };
