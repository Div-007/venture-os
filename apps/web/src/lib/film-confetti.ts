import { clamp, span } from "@/lib/film-timing";

/** Confetti for the films: each piece's path is worked out from the time since the burst, so it can be drawn at any moment. */
export type Piece = { x: number; y: number; vx: number; vy: number; delay: number; size: number; ratio: number; color: string; spin: number; flip: number; phase: number; sway: number };
export function makeConfetti(W: number, H: number, colors: readonly string[], random: () => number): Piece[] {
  const scale = clamp(H / 800, 0.7, 1.4); const pieces: Piece[] = [];
  const piece = (x: number, y: number, vx: number, vy: number, delay: number): Piece => ({ x, y, vx, vy, delay, size: 7 + random() * 6, ratio: 0.45 + random() * 0.5, color: colors[Math.floor(random() * colors.length)]!, spin: (random() - 0.5) * 12, flip: 6 + random() * 10, phase: random() * Math.PI * 2, sway: 2 + random() * 3 });
  // Two cannons from the bottom corners, aimed in toward the winner.
  const burst = W < 640 ? 36 : 56;
  for (const side of [-1, 1]) for (let index = 0; index < burst; index++) {
    const angle = (0.16 + random() * 0.45) * (side < 0 ? 1 : -1); const speed = (1300 + random() * 1100) * scale;
    pieces.push(piece(side < 0 ? -10 : W + 10, H + 10, Math.sin(angle) * speed, -Math.cos(angle) * speed, random() * 0.1));
  }
  // And a gentle shower from above.
  for (let index = 0; index < (W < 640 ? 30 : 50); index++) pieces.push(piece(random() * W, -20 - random() * 120, (random() - 0.5) * 160, 40 + random() * 140, 0.2 + random() * 0.7));
  return pieces;
}
export function drawConfetti(context: CanvasRenderingContext2D, pieces: Piece[], time: number, ratio: number, W: number, H: number) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  const drag = 2.4; const gravity = 950 * clamp(H / 800, 0.7, 1.4);
  for (const piece of pieces) {
    const t = time - piece.delay; if (t <= 0) continue;
    const alpha = 1 - span(t, 2.4, 0.8); if (alpha <= 0) continue;
    const decay = 1 - Math.exp(-drag * t);
    const x = piece.x + (piece.vx / drag) * decay + Math.sin(t * piece.sway + piece.phase) * 16 * Math.min(1, t);
    const y = piece.y + (piece.vy / drag) * decay + (gravity / drag) * (t - decay / drag);
    if (y > H + 30 || x < -30 || x > W + 30) continue;
    const angle = piece.phase + piece.spin * t; const flip = Math.cos(piece.phase + piece.flip * t);
    const cos = Math.cos(angle); const sin = Math.sin(angle);
    context.setTransform(ratio * cos, ratio * sin, -ratio * sin * flip, ratio * cos * flip, ratio * x, ratio * y);
    context.globalAlpha = alpha; context.fillStyle = piece.color;
    context.fillRect(-piece.size / 2, (-piece.size * piece.ratio) / 2, piece.size, piece.size * piece.ratio);
  }
  context.globalAlpha = 1;
}
