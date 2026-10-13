"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import type { LeaderboardEntry } from "@venture-studio/contracts";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { METALS, ordinal } from "@/components/studio/leaderboard-parts";
import { DitherBackground } from "@/components/ui/dither-background";
import { Crown, Trophy, Volume2, VolumeX } from "@/components/ui/icons";
import { CHORDS, createFilmAudio, filmSoundEnabled, PENTATONIC, type Cue, type FilmAudio } from "@/lib/film-sound";
import { prefersReducedMotion } from "@/lib/motion";
import { clamp, inCubic, inOutCubic, inOutQuint, mix, outBack, outCubic, outExpo, seeded, shuffled, span, spring } from "@/lib/film-timing";
import { drawConfetti, makeConfetti, type Piece } from "@/lib/film-confetti";

/*
 * The leaderboard's opening film, about ten seconds, cut to a 120 bpm score:
 *   0.0  cold open: a dark stage, a line of light drawing across it
 *   1.0  hit: the line opens into the green stage and the title slams in, letter by letter
 *   2.0  the title lifts away and everyone pops onto the stage, the counts ticking up
 *   3.6  the crowd forms the board: rows race their scores up, overtaking as they go, then lock
 *   5.85 the rest step down to a strip; the top three stand on the floor
 *   6.0  3rd, then 2nd, rise on their steps; a drumroll and lights on the empty top step
 *   8.0  the winner launches up with a flash, confetti and a fanfare; the crown drops
 *   8.8  your place, then the film dissolves into the live board
 * Everything on screen is a function of the film's clock, written straight to the DOM each frame, and every sound is
 * scheduled on the audio clock against the same timeline.
 */

const AV = 96; // avatars are drawn at this size and scaled
const INTRO = 2; // the title card; it can hold here while the board loads
const HOLD_LIMIT = 6; // seconds to wait on the title for the board before going straight to it
const EXIT = 0.35; // a skip's fade
const MAX_CROWD = 24;
const MAX_RACE = 8;

export type FilmTheme = "board" | "weekly";
const THEMES = {
  board: { stage: "vso-board", dark: "#03140b", dither: [255, 255, 255, 30] as const, letter: "", sub: "text-white/80", pill: "bg-white text-primary-800", confetti: ["#ffe08a", "#ffffff", "#7ee2a8", "#f6cb52", "#ff9f8f", "#9bd8ff", "#c4b5fd"] },
  weekly: { stage: "vso-weekly", dark: "#020604", dither: [246, 203, 82, 26] as const, letter: "vso-weekly-title", sub: "text-[#f6cb52]", pill: "bg-[#f6cb52] text-[#3a2604]", confetti: ["#f6cb52", "#fff5c7", "#e09a1f", "#ffffff", "#7ee2a8", "#fbe39a"] },
};

/* ---------- The plan: who appears where and when ---------- */
type Actor = {
  entry: LeaderboardEntry; you: boolean;
  /** Place in the race (top eight ranked), on the podium (0 is the winner), and in the strip below it. */
  racer?: number; spot?: number; strip?: number;
  /** Where in the crowd (its place in a shuffled grid that fits the screen), nudged off the grid a little. */
  slot: number; jitter: { x: number; y: number }; pan: number; pop: number; phase: number;
  /** How this person's score runs up in the race: when it starts, how long it takes, and how it eases. */
  start: number; length: number; curve: number;
};
type Caption = { from: number; to: number; text: (t: number) => string; big?: boolean };
type Times = { race: number; run: number; lock: number; podium: number; launches: number[]; roll: number; first: number; crown: number; you: number; out: number; end: number };
type Plan = { actors: Actor[]; racers: Actor[]; podium: Actor[]; strip: Actor[]; crowdMore: number; rankedMore: number; seed: number; times: Times; captions: Caption[]; you: string };

function makePlan(people: LeaderboardEntry[], currentUserId: string, minimumTasks: number, seed: number): Plan {
  const random = seeded(seed);
  const ranked = people.filter((entry) => entry.rank);
  const shown = [...ranked, ...people.filter((entry) => !entry.rank)].slice(0, MAX_CROWD);
  const count = shown.length;
  const popOrder = shuffled(Array.from({ length: count }, (_, index) => index), random);
  const popGap = count > 1 ? Math.min(0.11, 0.8 / (count - 1)) : 0;
  const racerCount = Math.min(ranked.length, MAX_RACE);
  const run = 4.1; const lock = 5.5;
  const actors = shown.map((entry, index): Actor => {
    const racer = index < racerCount ? index : undefined;
    const start = run + random() * 0.45;
    return {
      entry, you: entry.userId === currentUserId, racer,
      spot: racer !== undefined && racer < 3 ? racer : undefined, strip: racer !== undefined && racer >= 3 ? racer - 3 : undefined,
      slot: index, jitter: { x: random() - 0.5, y: random() - 0.5 }, pan: random() * 1.2 - 0.6, pop: 2.25 + popOrder.indexOf(index) * popGap,
      phase: random() * Math.PI * 2, start, length: Math.min(0.85 + random() * 0.45, lock - 0.12 - start), curve: 1.5 + random() * 2,
    };
  });
  const racers = actors.filter((actor) => actor.racer !== undefined);
  const podium = racers.slice(0, 3);
  const launches = podium.length === 3 ? [8, 6.5, 6] : podium.length === 2 ? [7.5, 6] : [7];
  const first = launches[0]!;
  const out = ranked.length ? first + 1.6 : count ? 3.8 : 2.9;
  const times: Times = { race: 3.6, run, lock, podium: 5.85, launches, roll: first - 1, first, crown: first + 0.3, you: first + 0.8, out, end: out + 0.7 };

  const tasks = people.reduce((sum, entry) => sum + entry.tasksDue, 0);
  const counted = (t: number) => {
    const share = outCubic(span(t, 2.4, 0.9)); const shownPeople = Math.round(people.length * share); const shownTasks = Math.round(tasks * share);
    return `${shownPeople} ${shownPeople === 1 ? "person" : "people"} · ${shownTasks} task${shownTasks === 1 ? "" : "s"}`;
  };
  const tops = ranked.filter((entry) => entry.rank === 1);
  const winner = tops.length > 1 ? `${tops[0]!.name} and ${tops.length === 2 ? tops[1]!.name : `${tops.length - 1} others`} share first` : tops[0] ? `${tops[0].name} is number one` : "";
  const captions: Caption[] = !count ? [{ from: 2.35, to: 99, text: () => "No one on the board yet" }]
    : !ranked.length ? [{ from: 2.35, to: 3.1, text: counted }, { from: 3.1, to: 99, text: () => "No one's ranked yet" }]
    : [{ from: 2.35, to: 3.6, text: counted }, { from: 3.75, to: 5.85, text: () => "Counting every task to date" }, { from: times.roll + 0.05, to: first + 0.2, text: () => "And at the top…", big: true }, { from: first + 0.3, to: 99, text: () => winner, big: true }];

  const me = people.find((entry) => entry.userId === currentUserId);
  const needed = me ? Math.max(1, minimumTasks - me.tasksDue) : 0;
  const you = !ranked.length || !me ? "" : me.rank ? (me.rank <= 3 ? `You're ${ordinal(me.rank)}. Well done!` : `You're ${ordinal(me.rank)} overall`) : `${needed} more task${needed === 1 ? "" : "s"} and you're on the board`;
  return { actors, racers, podium, strip: racers.slice(3), crowdMore: people.length - count, rankedMore: ranked.length - racerCount, seed, times, captions, you };
}

/* ---------- The score ---------- */
function introCues(letters: number): Cue[] {
  const cues: Cue[] = [
    { at: 0, play: (s, when) => s.drone(when, 2.6) },
    { at: 0.15, play: (s, when) => s.whoosh(when, { duration: 0.8, from: -0.2, to: 0.2, peak: 0.1, high: 1600 }) },
    { at: 0.4, play: (s, when) => s.riser(when, 0.6, 0.24) },
    { at: 1, play: (s, when) => { s.impact(when, 1); s.crash(when, 0.1); s.sparkle(when + 0.05, 0.5, 8, 0.03); } },
    { at: 1.45, play: (s, when) => s.tick(when, 2637, 0.05) },
  ];
  for (let index = 0; index < letters; index++) cues.push({ at: 1 + index * 0.035, play: (s, when) => s.tick(when, 1400 + index * 110, 0.02, (index / Math.max(1, letters - 1)) * 1.2 - 0.6) });
  return cues;
}

function mainCues(plan: Plan, offset: number): Cue[] {
  const { times } = plan; const cues: Cue[] = [];
  const at = (time: number, play: Cue["play"]) => { cues.push({ at: time + offset, play }); };
  const ranked = plan.racers.length > 0;
  at(2, (s, w) => s.whoosh(w, { duration: 0.6, from: 0, to: 0, peak: 0.2, high: 3000 }));
  // Bar 1, A minor: a light pulse while everyone arrives.
  at(2, (s, w) => s.pad(w, ranked ? 2.05 : times.end - 2 + 0.3, CHORDS.am));
  for (const beat of [2, 2.5, 3, 3.5]) if (beat < times.out) { at(beat, (s, w) => s.kick(w, 0.22)); at(beat + 0.25, (s, w) => s.hat(w, 0.025)); }
  at(2, (s, w) => s.bass(w, 110)); at(3, (s, w) => s.bass(w, 110));
  const pop = 0.1 * Math.min(1, Math.sqrt(8 / Math.max(1, plan.actors.length)));
  plan.actors.forEach((actor, index) => at(actor.pop, (s, w) => s.pop(w, PENTATONIC[index % PENTATONIC.length]!, actor.pan, pop)));
  for (let step = 0, time = 2.4; time < 3.25; time += 0.07, step++) { const pitch = 2400 + step * 60; at(time, (s, w) => s.tick(w, pitch, 0.016)); }
  if (!ranked) { at(times.out, (s, w) => s.whoosh(w, { duration: 0.7, from: 0.3, to: -0.3, peak: 0.15 })); return cues; }

  // Bar 2, F: the race, four on the floor, the numbers ticking up.
  at(3.5, (s, w) => s.bass(w, 110, 0.3));
  at(times.race, (s, w) => s.whoosh(w, { duration: 0.55, from: -0.4, to: 0.4, peak: 0.18 }));
  at(4, (s, w) => s.pad(w, 2.05, CHORDS.f));
  for (let beat = 4; beat < 6; beat += 0.5) { at(beat, (s, w) => s.kick(w, 0.34)); at(beat + 0.25, (s, w) => s.hat(w, 0.03)); }
  for (const beat of [4, 4.75, 5, 5.5]) at(beat, (s, w) => s.bass(w, 87.31));
  at(4.5, (s, w) => s.snare(w, 0.1));
  for (let step = 0, time = times.run; time < times.lock - 0.08; time += 0.06, step++) { const pitch = 1800 + step * 55; at(time, (s, w) => s.tick(w, pitch, 0.014)); }
  at(times.lock, (s, w) => { s.snare(w, 0.16); s.tick(w, 1760, 0.06); s.tick(w, 2637, 0.04); });

  // Bar 3, G: the podium, step by step, then the roll.
  at(times.podium, (s, w) => s.whoosh(w, { duration: 0.5, from: 0.3, to: -0.3, peak: 0.15, high: 1800 }));
  at(6, (s, w) => s.pad(w, times.first - 6 + 0.12, CHORDS.g));
  for (let beat = 6; beat < times.roll; beat += 0.25) at(beat, (s, w) => s.hat(w, 0.028));
  for (let beat = 6; beat < times.roll; beat += 0.5) at(beat, (s, w) => s.bass(w, 98));
  plan.podium.forEach((_, spot) => {
    if (!spot) return;
    const launch = times.launches[spot]!;
    at(launch, (s, w) => { s.impact(w, 0.42); s.whoosh(w, { duration: 0.3, from: 0, to: 0, peak: 0.1, high: 2000 }); });
    at(launch + 0.18, (s, w) => s.chime(w, spot === 2 ? 392 : 493.88, 0.08, spot === 2 ? 0.35 : -0.35));
  });
  at(times.roll, (s, w) => { s.drumroll(w, times.first - times.roll); s.riser(w, times.first - times.roll, 0.22); });

  // C major: the winner.
  at(times.first, (s, w) => { s.impact(w, 1.3); s.crash(w, 0.18); s.fanfare(w); s.sparkle(w + 0.05, 1.6, 24, 0.04); s.bass(w, 65.41, 1.2, 0.16); s.pad(w, times.end - times.first + 0.4, CHORDS.c, 0.022); });
  [523.25, 659.25, 783.99, 1046.5].forEach((note, step) => at(times.crown + step * 0.09, (s, w) => s.chime(w, note, 0.06, -0.3 + step * 0.2)));
  for (let beat = times.first + 0.5; beat < times.out; beat += 0.5) at(beat, (s, w) => s.kick(w, 0.26));
  for (let beat = times.first + 0.25; beat < times.out + 0.3; beat += 0.25) at(beat, (s, w) => s.hat(w, 0.025));
  if (plan.you) at(times.you, (s, w) => { s.chime(w, 659.25, 0.05); s.chime(w + 0.12, 987.77, 0.045); });
  at(times.out, (s, w) => s.whoosh(w, { duration: 0.7, from: 0.3, to: -0.3, peak: 0.15 }));
  return cues;
}

/* ---------- Layout: where things sit for this window ---------- */
function measure(W: number, H: number, size: number, titleHeight: number, plan: Plan | null) {
  const narrow = W < 640;
  const lift = (narrow ? 26 : 38) / size;
  const titleTop = narrow ? 20 : 24;
  const liftedTitle = titleTop + (titleHeight * lift) / 2;
  const liftedSub = titleTop + titleHeight * lift + 14;
  const caption = liftedSub + 30;
  const top = caption + 26;
  const introTitle = H / 2 - 24;
  // The crowd
  const padX = Math.max(32, W * 0.08); const crowdTop = top + 34; const crowdBottom = Math.max(crowdTop + 40, H - 64);
  const count = Math.max(1, plan?.actors.length ?? 1);
  const cols = clamp(Math.round(Math.sqrt((count * (W - padX * 2)) / (crowdBottom - crowdTop))), 1, count); const rows = Math.ceil(count / cols);
  const cells = shuffled(Array.from({ length: cols * rows }, (_, index) => index), seeded(plan?.seed ?? 1));
  const crowd = (plan?.actors ?? []).map((actor) => {
    const cell = cells[actor.slot] ?? 0;
    return { x: padX + (((cell % cols) + 0.5 + actor.jitter.x * 0.45) / cols) * (W - padX * 2), y: crowdTop + ((Math.floor(cell / cols) + 0.5 + actor.jitter.y * 0.45) / rows) * (crowdBottom - crowdTop) };
  });
  const crowdAvatar = clamp(Math.min(((W - padX * 2) / cols) * 0.55, ((crowdBottom - crowdTop) / rows) * 0.5, Math.min(W, H) * 0.08), 30, 64);
  // The race
  const racers = Math.max(1, plan?.racers.length ?? 1);
  const rowH = clamp((H - top - 60) / racers, 26, 60);
  const listTop = top + Math.max(4, (H - top - 50 - rowH * racers) / 2);
  const rowW = Math.min(700, W - 28); const rowLeft = (W - rowW) / 2; const rowAvatar = Math.max(18, Math.min(40, rowH - 12));
  // The podium and the strip below it
  const stripCount = (plan?.strip.length ?? 0) + (plan?.rankedMore ? 1 : 0);
  const floor = H - (stripCount ? (H < 560 ? 76 : 100) : 34);
  const block = Math.min(210, (W - 40) / 3.25); const gap = Math.max(8, block * 0.08);
  const spots = plan?.podium.length ?? 0;
  const xs = spots === 3 ? [W / 2, W / 2 - block - gap, W / 2 + block + gap] : spots === 2 ? [W / 2 + (block + gap) / 2, W / 2 - (block + gap) / 2] : [W / 2];
  const big = Math.min(clamp(H * 0.11, Math.min(58, H * 0.1), 104), block * 0.8); const avatars = [big, big * 0.8, big * 0.8];
  // The winner's step is as tall as fits between the floor and the captions (with room for the name and the crown).
  const tall = clamp(Math.min(H * 0.26, floor - top - 62 - big - 36), 40, 230); const heights = [tall, tall * 0.74, tall * 0.56];
  const stand = (spot: number, rise: number) => floor - heights[spot]! * rise - 62 - avatars[spot]! / 2;
  const aim = (Math.atan2(xs[0]! - W * 0.16, stand(0, 1) + 40) * 180) / Math.PI;
  return {
    W, H, narrow, size, lift, liftedTitle, liftedSub, caption, you: caption + 34, introTitle, introSub: introTitle + titleHeight / 2 + 30,
    padX, crowdTop, crowdBottom, crowd, crowdAvatar, rowH, listTop, rowW, rowLeft, rowAvatar,
    floor, block, xs, heights, avatars, stand, aim, stripCount, stripGap: Math.min(64, (W - 40) / Math.max(1, stripCount)), stripY: floor + (H < 560 ? 40 : 52), stripAvatar: H < 560 ? 32 : 38,
  };
}
type Layout = ReturnType<typeof measure>;
const titleSize = (W: number, H: number, title: string) => {
  const longest = Math.max(1, ...title.split(/\s+/).map((word) => word.length));
  return Math.round(clamp(Math.min((W - 40) / (longest * 0.74), H * 0.2, 150), 28, 150));
};

type ActorEls = { root: HTMLElement; avatar: HTMLElement; pulse: HTMLElement | null; label: HTMLElement; row: HTMLElement; rank: HTMLElement; info: HTMLElement; fill: HTMLElement; metal: HTMLElement; score: HTMLElement; stand: HTMLElement; standScore: HTMLElement; badge: HTMLElement };
const subscribeNever = () => () => {};
/** Fired on the window when a leaderboard film ends, so a celebration that waited for it can play. */
export const filmEndedEvent = "venture:film-ended";
const setText = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };

/**
 * The opening film for a leaderboard page: plays over the whole window when the page opens, then dissolves into the
 * board (`onReveal` as the dissolve starts, so the board can come in underneath, and `onDone` once it's gone).
 * Skippable (Escape or Skip), with sound that can be muted; people who prefer reduced motion go straight to the board.
 */
export function LeaderboardFilm({ theme, title, subtitle, people, failed, minimumTasks, currentUserId, onReveal, onDone }: {
  theme: FilmTheme; title: string; subtitle: string; people: LeaderboardEntry[] | null; failed: boolean; minimumTasks: number; currentUserId: string; onReveal: () => void; onDone: () => void;
}) {
  // False on the server and while hydrating, so nothing renders until the browser can play it.
  const canPlay = useSyncExternalStore(subscribeNever, () => !prefersReducedMotion(), () => false);
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const plan = useMemo(() => (people ? makePlan(people, currentUserId, minimumTasks, seed) : null), [people, currentUserId, minimumTasks, seed]);
  // Once the board's part starts, the cast is fixed for the rest of the film.
  const [cast, setCast] = useState<Plan | null>(null);
  const shown = cast ?? plan;
  const [sound, setSound] = useState<"on" | "off" | "blocked">(() => (filmSoundEnabled() ? "on" : "off"));
  const root = useRef<HTMLDivElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);
  const audio = useRef<FilmAudio | null>(null);
  const leave = useRef<() => void>(() => {});
  const live = useRef({ plan, failed, onReveal, onDone, theme, letters: title.replace(/\s+/g, "").length });
  useEffect(() => { live.current = { plan, failed, onReveal, onDone, theme, letters: title.replace(/\s+/g, "").length }; });

  // Declared before the film's own effect, so it notes where focus was before Skip takes it, and puts it back after.
  // Escape skips; Tab stays on the film's two buttons; any key or tap lets the browser start the sound.
  useEffect(() => {
    if (!canPlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      audio.current?.start();
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); leave.current(); return; }
      if (event.key !== "Tab") return;
      const items = [...(root.current?.querySelectorAll<HTMLElement>("button") ?? [])];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault(); event.stopPropagation();
      items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [canPlay]);

  useEffect(() => {
    if (!canPlay) { if (prefersReducedMotion()) { live.current.onReveal(); live.current.onDone(); } return; }
    const node = root.current;
    if (!node) return;
    // The clock starts on the first frame drawn, so a page opened in a background tab waits until it's seen.
    let startedAt: number | null = null;
    const clock = () => (startedAt === null ? 0 : (performance.now() - startedAt) / 1000);
    const track = createFilmAudio(clock);
    audio.current = track;
    document.documentElement.dataset.vsoFilm = "leaderboard";

    const one = (name: string) => node.querySelector<HTMLElement>(`[data-el="${name}"]`)!;
    const E = {
      camera: one("camera"), stage: one("stage"), dither: one("dither"), lineTop: one("line-top"), lineBottom: one("line-bottom"), flash: one("flash"),
      title: one("title"), sub: one("sub"), hold: one("hold"), holdBar: one("hold-bar"), caption: one("caption"), you: one("you"),
      floor: one("floor"), blocks: one("blocks"), glow: one("glow"), crown: one("crown"), beamLeft: one("beam-left"), beamRight: one("beam-right"), vignette: one("vignette"),
      crowdMore: one("crowd-more"), rankedMore: one("ranked-more"), stripMore: one("strip-more"), controls: one("controls"), progress: one("progress"),
      shapes: [...node.querySelectorAll<HTMLElement>("[data-shape]")], letters: [...node.querySelectorAll<HTMLElement>("[data-letter]")],
    };
    const canvas = node.querySelector<HTMLCanvasElement>("canvas[data-el='confetti']")!;
    const paint = canvas.getContext("2d");
    let actors: ActorEls[] = []; let blocks: HTMLElement[] = [];
    let mainAt: number | null = null; let main: Plan | null = null;
    let exitAt: number | null = null; let revealed = false; let finished = false;
    let layout: Layout | null = null; let sizeKey = "";
    let slots: number[] = []; let order = ""; let lastSwap = -1; let lastFrame = 0;
    let confetti: Piece[] | null = null; let confettiDrawn = false;
    let soundState = ""; let raf = 0;
    const ratio = Math.min(2, window.devicePixelRatio || 1);

    const reveal = () => { if (!revealed) { revealed = true; live.current.onReveal(); } };
    const finish = () => { if (finished) return; finished = true; cancelAnimationFrame(raf); track.stop(0.25); reveal(); live.current.onDone(); };
    leave.current = () => { if (exitAt !== null || finished) return; exitAt = clock(); track.stop(0.3); reveal(); };

    const bind = () => {
      actors = [...node.querySelectorAll<HTMLElement>("[data-actor]")].map((actorRoot) => {
        const part = (name: string) => actorRoot.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
        return { root: actorRoot, avatar: part("avatar"), pulse: actorRoot.querySelector<HTMLElement>('[data-part="pulse"]'), label: part("label"), row: part("row"), rank: part("rank"), info: part("info"), fill: part("fill"), metal: part("metal"), score: part("score"), stand: part("stand"), standScore: part("stand-score"), badge: part("badge") };
      });
      blocks = [...node.querySelectorAll<HTMLElement>("[data-block]")];
    };
    const applyLayout = (L: Layout) => {
      canvas.width = Math.round(L.W * ratio); canvas.height = Math.round(L.H * ratio); confettiDrawn = true;
      // The steps stay shut away until the board's part starts and they have their places.
      E.blocks.style.height = main && blocks.length ? `${L.floor}px` : "0px";
      blocks.forEach((block, spot) => {
        const height = L.heights[spot]!;
        Object.assign(block.style, { left: `${L.xs[spot]! - L.block / 2}px`, top: `${L.floor - height}px`, width: `${L.block}px`, height: `${height + 40}px`, fontSize: `${Math.round(Math.min(64, height * 0.42))}px` });
      });
      E.floor.style.transform = `translate3d(-50%, ${L.floor}px, 0) translateY(-50%)`;
      E.floor.style.width = `${Math.min(L.W - 24, L.block * 3.6)}px`;
      const info = L.rowW - 34 - L.rowAvatar - 12 - 64;
      actors.forEach((els, index) => {
        const spot = main?.actors[index]?.spot;
        els.label.style.transform = `translate(-50%, ${L.crowdAvatar / 2 + 6}px)`;
        els.rank.style.transform = `translate(${-(L.rowAvatar / 2 + 40)}px, -50%)`;
        els.info.style.transform = `translate(${L.rowAvatar / 2 + 12}px, -50%)`; els.info.style.width = `${info}px`;
        els.score.style.transform = `translate(${L.rowAvatar / 2 + 12 + info + 8}px, -50%)`;
        if (spot !== undefined) els.stand.style.maxWidth = `${L.block - 6}px`;
        els.badge.style.transform = `translate(${-L.stripAvatar / 2 - 6}px, ${-L.stripAvatar / 2 - 6}px)`;
      });
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (startedAt === null) { startedAt = now; track.add(introCues(live.current.letters)); track.start(); }
      const f = Math.max(0, (now - startedAt) / 1000);
      const dt = Math.min(0.05, Math.max(0, f - lastFrame)); lastFrame = f;
      // The board's part starts once the title has played and the board has arrived.
      if (mainAt === null && exitAt === null) {
        const { plan: ready, failed: broken } = live.current;
        if (ready && f >= INTRO) { mainAt = f; main = ready; setCast(ready); track.add(mainCues(ready, mainAt - INTRO)); }
        else if (broken || f > INTRO + HOLD_LIMIT) leave.current();
      }
      const t = mainAt === null ? Math.min(f, INTRO) : f - mainAt + INTRO;
      const T = main?.times;
      if (T && t >= T.out) reveal();
      if ((T && t >= T.end) || (exitAt !== null && f - exitAt >= EXIT)) { finish(); return; }
      if (main && actors.length !== main.actors.length) bind();

      const W = window.innerWidth; const H = window.innerHeight;
      const size = titleSize(W, H, title);
      const key = `${W}x${H}:${main ? 1 : 0}:${actors.length}`;
      if (key !== sizeKey || !layout) {
        sizeKey = key;
        E.title.style.fontSize = `${size}px`; E.title.style.maxWidth = `${W - 40}px`;
        layout = measure(W, H, size, E.title.offsetHeight, main);
        applyLayout(layout);
      }
      const L = layout;

      // The camera: a push in on the drumroll, a shake on each hit, and the dissolve at the end.
      const exitShare = exitAt !== null ? inOutCubic(span(f, exitAt, EXIT)) : T ? inOutCubic(span(t, T.out, T.end - T.out)) : 0;
      node.style.opacity = String(1 - exitShare);
      let zoom = 1 + 0.035 * exitShare; let shakeX = 0; let shakeY = 0;
      const shake = (at: number, amount: number) => { if (t < at) return; const since = t - at; const strength = amount * Math.exp(-since * 11); shakeX += strength * Math.sin(since * 73); shakeY += strength * Math.cos(since * 59); };
      shake(1, 5);
      const podium = main?.podium.length ?? 0;
      if (T && podium) { zoom += t < T.first ? 0.045 * inCubic(span(t, T.roll, T.first - T.roll)) : 0.045 * (1 - spring(t - T.first, 0.5, 0.25)); shake(T.first, 10); }
      E.camera.style.transform = `translate3d(${shakeX}px, ${shakeY}px, 0) scale(${zoom})`;
      E.camera.style.filter = exitShare > 0.01 ? `blur(${exitShare * 6}px)` : "none";

      // Cold open: a line of light draws across, then opens like doors onto the stage.
      const line = outExpo(span(t, 0.15, 0.8)); const open = outExpo(span(t, 1, 0.6));
      const lineFade = t < 0.15 ? 0 : 1 - span(t, 1, 0.45);
      E.lineTop.style.transform = `translate3d(-50%, ${H / 2 - (open * H) / 2}px, 0) scaleX(${line})`;
      E.lineBottom.style.transform = `translate3d(-50%, ${H / 2 + (open * H) / 2}px, 0) scaleX(${line})`;
      E.lineTop.style.opacity = E.lineBottom.style.opacity = String(lineFade);
      E.stage.style.clipPath = open >= 0.999 ? "none" : `inset(${(1 - open) * 50}% 0 ${(1 - open) * 50}% 0)`;
      E.dither.style.opacity = String(outCubic(span(t, 1, 0.8)));
      E.shapes.forEach((shape, index) => { shape.style.transform = `rotate(${(index % 2 ? -1 : 1) * f * (5 + index * 2)}deg) scale(${mix(0.85, 1, outCubic(span(t, 1, 1.2)))})`; });
      let flash = t >= 1 ? 0.35 * (1 - outCubic(span(t, 1, 0.35))) : 0;
      if (T && podium && t >= T.first) flash = Math.max(flash, 0.55 * (1 - outCubic(span(t, T.first, 0.45))));
      E.flash.style.opacity = String(flash);

      // The title slams in letter by letter, drifts closer, then lifts away to the top.
      if (t < 2.3) E.letters.forEach((letter, index) => {
        const at = 1 + index * 0.035; const p = outExpo(span(t, at, 0.6));
        letter.style.opacity = String(span(t, at, 0.18));
        letter.style.transform = `translate3d(0, ${(1 - p) * L.size * 0.45}px, 0) scale(${1.4 - 0.4 * p})`;
        letter.style.filter = p >= 0.999 ? "none" : `blur(${(1 - p) * 9}px)`;
      });
      const lift = T ? inOutQuint(span(t, 2, 0.65)) : 0;
      const waiting = mainAt === null && f > INTRO;
      const breathe = waiting ? 1 + 0.012 * Math.sin((f - INTRO) * 2.6) : 1;
      E.title.style.transform = `translate3d(-50%, ${mix(L.introTitle, L.liftedTitle, lift)}px, 0) translateY(-50%) scale(${mix((1 + 0.03 * outCubic(span(t, 1, 1.1))) * breathe, L.lift, lift)})`;
      const subIn = outCubic(span(t, 1.45, 0.45));
      E.sub.style.opacity = String(subIn);
      E.sub.style.transform = `translate3d(-50%, ${mix(L.introSub, L.liftedSub, lift) + (1 - subIn) * 10}px, 0) translateY(-50%)`;
      E.hold.style.opacity = String(waiting && exitAt === null ? outCubic(span(f, INTRO + 0.3, 0.4)) : 0);
      if (waiting) { E.hold.style.transform = `translate3d(-50%, ${L.introSub + 34}px, 0)`; E.holdBar.style.transform = `translateX(${(((f - INTRO) * 0.9) % 1) * 300 - 100}%)`; }

      // Captions under the title: the counts, then what's happening, then the winner.
      const caption = main?.captions.find((item) => t >= item.from && t < item.to);
      if (caption) {
        setText(E.caption, caption.text(t)); E.caption.dataset.big = String(Boolean(caption.big));
        const p = outCubic(span(t, caption.from, 0.3));
        E.caption.style.opacity = String(p * (1 - span(t, caption.to - 0.2, 0.2)));
        E.caption.style.transform = `translate3d(-50%, ${L.caption + (1 - p) * 8}px, 0) translateY(-50%)`;
      } else E.caption.style.opacity = "0";
      if (T && main?.you) {
        const p = span(t, T.you, 0.45);
        E.you.style.opacity = String(outCubic(Math.min(1, p * 2)));
        E.you.style.transform = `translate3d(-50%, ${L.you}px, 0) translateY(-50%) scale(${mix(0.8, 1, outBack(p))})`;
      }

      if (main && T) {
        // The race: every bar runs up to its score at its own pace, and the rows re-sort as people overtake.
        const values = main.racers.map((actor) => actor.entry.score * (1 - (1 - span(t, actor.start, actor.length)) ** actor.curve));
        const targets: number[] = [];
        if (t >= T.lock) main.racers.forEach((_, index) => { targets[index] = index; });
        else {
          const standings = values.map((_, index) => index).sort((a, b) => values[b]! - values[a]! || a - b);
          standings.forEach((racer, slot) => { targets[racer] = slot; });
          const now = standings.join(",");
          if (order && now !== order && t >= T.run && t - lastSwap > 0.08) { lastSwap = t; track.live((s, when) => s.tick(when, 1900 + Math.random() * 900, 0.05)); }
          order = now;
        }
        slots = targets.map((target, index) => (slots[index] === undefined ? target : slots[index]! + (target - slots[index]!) * (1 - Math.exp(-dt * 13))));

        const crowdScale = L.crowdAvatar / AV; const rowScale = L.rowAvatar / AV; const stripScale = L.stripAvatar / AV;
        const racing = main.racers.length > 0;
        main.actors.forEach((actor, index) => {
          const els = actors[index]; if (!els) return;
          const home = L.crowd[index] ?? { x: W / 2, y: H / 2 };
          const cx = home.x + Math.sin(f * 0.7 + actor.phase) * 5; const cy = home.y + Math.sin(f * 1.6 + actor.phase) * 5;
          let x = cx; let y = cy; let scale = crowdScale * mix(0.4, 1, outBack(span(t, actor.pop, 0.5), 2.2));
          let opacity = t < actor.pop ? 0 : span(t, actor.pop, 0.16) * (actor.entry.rank ? 1 : 0.65);
          let label = opacity; let row = 0; let stand = 0; let badge = 0; let squashX = 1; let squashY = 1;
          const racer = actor.racer;
          if (t >= T.race && racer === undefined && racing) {
            // Not in the race (not ranked yet, or past the top eight): they step aside.
            const p = span(t, T.race, 0.35); opacity *= 1 - p; scale *= 1 - 0.3 * p; y += 16 * outCubic(p); label *= 1 - p;
          } else if (t >= T.race && racer !== undefined) {
            const p = inOutQuint(span(t, T.race + racer * 0.035, 0.55));
            x = mix(cx, L.rowLeft + 34 + L.rowAvatar / 2, p); y = mix(cy, L.listTop + L.rowH * (slots[racer]! + 0.5), p); scale = mix(crowdScale, rowScale, p);
            label *= 1 - span(t, T.race, 0.15);
            row = outCubic(span(t, T.race + 0.3 + racer * 0.035, 0.3));
            if (t >= T.podium) row *= 1 - span(t, T.podium, 0.18);
            if (t >= T.podium && actor.spot !== undefined) {
              // The top three walk to the floor, then rise on their steps.
              const spot = actor.spot; const launch = T.launches[spot]!;
              const p2 = inOutQuint(span(t, T.podium + spot * 0.05, 0.5));
              const rise = t < launch ? 0 : spring(t - launch, spot === 0 ? 0.7 : 0.55, spot === 0 ? 0.42 : 0.32);
              x = mix(x, L.xs[spot]!, p2); y = mix(y, L.stand(spot, rise), p2); scale = mix(scale, L.avatars[spot]! / AV, p2);
              if (spot === 0 && t < launch) {
                // Anticipation: a tremble on the roll, then a crouch before the jump.
                x += Math.sin(f * 55) * 1.4 * span(t, T.roll, launch - T.roll);
                const crouch = inCubic(span(t, launch - 0.3, 0.3)); squashY = 1 - 0.1 * crouch; squashX = 1 + 0.06 * crouch;
              }
              if (t >= launch) { const wobble = Math.exp(-(t - launch) * 8) * Math.cos((t - launch) * 24) * 0.12; squashY = 1 + wobble; squashX = 1 - wobble * 0.6; }
              stand = t < launch ? 0 : outCubic(span(t, launch + 0.18, 0.3));
              els.stand.style.transform = `translate(-50%, ${L.avatars[spot]! / 2 + 8 + (1 - stand) * 8}px)`;
              setText(els.standScore, String(Math.round(actor.entry.score * outCubic(span(t, launch + 0.18, 0.6)))));
            } else if (t >= T.podium && actor.strip !== undefined) {
              const p2 = inOutQuint(span(t, T.podium + actor.strip * 0.04, 0.5));
              x = mix(x, L.W / 2 + (actor.strip - (L.stripCount - 1) / 2) * L.stripGap, p2); y = mix(y, L.stripY, p2); scale = mix(scale, stripScale, p2);
              badge = outCubic(span(t, T.podium + 0.35 + actor.strip * 0.04, 0.25));
            }
            if (row > 0) {
              const value = values[racer] ?? 0;
              setText(els.rank, String(t >= T.lock ? actor.entry.rank ?? racer + 1 : (targets[racer] ?? racer) + 1));
              setText(els.score, String(t >= T.lock ? actor.entry.score : Math.round(value)));
              els.fill.style.transform = `scaleX(${clamp(value / 100, 0, 1)})`;
              els.metal.style.opacity = String(racer < 3 ? span(t, T.lock, 0.25) : 0);
            }
          }
          let lifted = 1;
          if (racer !== undefined && t >= T.run && t < T.podium) {
            const moving = (targets[racer] ?? racer) - (slots[racer] ?? racer);
            const passing = clamp(Math.abs(moving) * 2, 0, 1);
            els.root.style.zIndex = moving < -0.02 ? "3" : moving > 0.02 ? "1" : "2";
            if (moving < 0) lifted = 1 + 0.04 * passing; else row *= 1 - 0.45 * passing;
          } else els.root.style.zIndex = "";
          els.root.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${lifted})`;
          els.root.style.opacity = String(opacity);
          els.avatar.style.transform = `translate(-50%, -50%) scale(${scale * squashX}, ${scale * squashY})`;
          els.label.style.opacity = String(label);
          els.row.style.opacity = String(row); els.row.style.visibility = row > 0.01 ? "visible" : "hidden";
          els.stand.style.opacity = String(stand);
          els.badge.style.opacity = String(badge);
          if (els.pulse) { const beat = t >= T.you ? ((t - T.you) % 1.2) / 1.2 : 0; els.pulse.style.opacity = String(t >= T.you ? 1 - beat : 0); els.pulse.style.transform = `scale(${1 + beat * 0.45})`; }
        });

        // The extras that say how many more there are.
        const lastPop = Math.max(2.25, ...main.actors.map((actor) => actor.pop));
        E.crowdMore.style.opacity = String(main.crowdMore ? span(t, lastPop + 0.1, 0.25) * (1 - span(t, T.race, 0.3)) : 0);
        E.crowdMore.style.transform = `translate3d(${W - L.padX}px, ${L.crowdBottom}px, 0) translate(-50%, -50%)`;
        E.rankedMore.style.opacity = String(main.rankedMore ? span(t, T.race + 0.4, 0.3) * (1 - span(t, T.podium, 0.2)) : 0);
        E.rankedMore.style.transform = `translate3d(-50%, ${L.listTop + L.rowH * main.racers.length + 18}px, 0)`;
        E.stripMore.style.opacity = String(main.rankedMore ? span(t, T.podium + 0.4, 0.3) : 0);
        E.stripMore.style.transform = `translate3d(${L.W / 2 + (main.strip.length - (L.stripCount - 1) / 2) * L.stripGap}px, ${L.stripY}px, 0) translate(-50%, -50%)`;

        // The podium: steps rise out of the floor, and the lights find the top step.
        E.floor.style.opacity = String(podium ? outCubic(span(t, T.podium, 0.5)) : 0);
        blocks.forEach((block, spot) => {
          const launch = T.launches[spot]!;
          const rise = t < launch ? 0 : spring(t - launch, spot === 0 ? 0.7 : 0.55, spot === 0 ? 0.42 : 0.32);
          block.style.transform = `translate3d(0, ${(1 - rise) * (L.heights[spot]! + 40)}px, 0)`;
        });
        const lights = podium ? outCubic(span(t, T.roll, 0.35)) * (1 - outCubic(span(t, T.first + 0.1, 0.5))) : 0;
        E.vignette.style.opacity = String(lights * 0.9);
        const sweep = span(t, T.roll, T.first - T.roll);
        const angle = mix(L.aim + 22, L.aim, inOutCubic(sweep)) + Math.sin((t - T.roll) * 4.4) * 7 * (1 - sweep);
        E.beamLeft.style.opacity = E.beamRight.style.opacity = String(lights);
        E.beamLeft.style.transform = `translate3d(${W * 0.16}px, -40px, 0) translateX(-50%) rotate(${-angle}deg)`;
        E.beamRight.style.transform = `translate3d(${W * 0.84}px, -40px, 0) translateX(-50%) rotate(${angle}deg)`;
        if (podium) {
          const rise = t < T.first ? 0 : spring(t - T.first, 0.7, 0.42);
          const top = L.stand(0, rise);
          const glow = t < T.first ? 0 : outCubic(span(t, T.first, 0.35));
          E.glow.style.opacity = String(glow * (0.85 + 0.15 * Math.sin(f * 3)));
          E.glow.style.transform = `translate3d(${L.xs[0]}px, ${top}px, 0) translate(-50%, -50%) scale(${mix(0.6, 1, glow) * (L.avatars[0]! / 60)})`;
          const drop = t < T.crown ? 0 : spring(t - T.crown, 0.5, 0.45);
          const crown = L.avatars[0]! * 0.46;
          E.crown.style.opacity = String(span(t, T.crown, 0.1));
          E.crown.style.transform = `translate3d(${L.xs[0]}px, ${top - L.avatars[0]! / 2 - crown * 0.55 - (1 - drop) * 160}px, 0) translate(-50%, -50%) rotate(${(1 - drop) * -25}deg) scale(${crown / 48})`;
        }

        // Confetti from the winner's moment.
        if (podium && t >= T.first && paint) {
          confetti ??= makeConfetti(W, H, THEMES[live.current.theme].confetti, seeded(Math.floor(Math.random() * 1e9)));
          drawConfetti(paint, confetti, t - T.first, ratio, W, H); confettiDrawn = true;
        } else if (confettiDrawn && paint) { paint.setTransform(1, 0, 0, 1, 0, 0); paint.clearRect(0, 0, canvas.width, canvas.height); confettiDrawn = false; }
      }

      E.progress.style.transform = `scaleX(${T ? clamp(t / T.end, 0, 1) : clamp(t / 10, 0, 1)})`;
      E.controls.style.opacity = String(outCubic(span(f, 0.3, 0.4)));
      const state = !track.enabled() ? "off" : track.playing() || f < 0.8 ? "on" : "blocked";
      if (state !== soundState) { soundState = state; setSound(state); }
    };
    raf = requestAnimationFrame(frame);
    skipButton.current?.focus({ preventScroll: true });
    const onVisibility = () => { if (document.hidden) finish(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVisibility); track.stop(0.2); audio.current = null;
      if (document.documentElement.dataset.vsoFilm === "leaderboard") delete document.documentElement.dataset.vsoFilm;
      delete document.documentElement.dataset.vsoWeekly;
      window.dispatchEvent(new Event(filmEndedEvent));
    };
  }, [canPlay, title]);

  if (!canPlay) return null;
  const look = THEMES[theme];
  // Each letter is numbered across the whole title, for its place in the stagger.
  const words = title.split(/\s+/).filter(Boolean).map((word, index, all) => ({ word, offset: all.slice(0, index).join("").length }));
  const toggleSound = () => {
    const track = audio.current; if (!track) return;
    if (sound === "blocked") track.start();
    else track.setEnabled(sound === "off");
  };

  return createPortal(<div ref={root} role="dialog" aria-modal="true" aria-label={`${title}: opening`} onPointerUp={() => audio.current?.start()} className="fixed inset-0 z-[100] select-none overflow-hidden text-white" style={{ background: look.dark }}>
    <p className="sr-only">A short animated opening for the {title.toLowerCase()}. Press Escape or Skip to go straight to it.</p>
    <div data-el="camera" aria-hidden="true" className="absolute inset-0 origin-[50%_55%]">
      <div data-el="stage" className={clsx(look.stage, "absolute inset-0")} style={{ clipPath: "inset(50% 0 50% 0)" }}>
        <div data-el="dither" className="absolute inset-0" style={{ opacity: 0 }}><DitherBackground color={look.dither} density={0.6} className="absolute inset-0 h-full w-full" /></div>
        <span data-shape className="absolute -left-24 top-24 h-72 w-72 rounded-full border-2 border-white/20" />
        <span data-shape className="absolute -right-20 top-10 h-56 w-56 rounded-[48px] bg-white/10" />
        <span data-shape className="absolute -right-28 top-[45%] h-80 w-80 rounded-full border-2 border-white/15" />
      </div>
      <div data-el="glow" className="absolute left-0 top-0 h-[180px] w-[180px] rounded-full" style={{ opacity: 0, background: "radial-gradient(circle, rgba(255,224,138,.55) 0%, rgba(255,224,138,.18) 40%, transparent 70%)" }} />
      <div data-el="floor" className="absolute left-1/2 top-0 h-10 rounded-[50%]" style={{ opacity: 0, background: "radial-gradient(closest-side, rgba(255,255,255,.22), transparent)" }} />
      <div data-el="blocks" className="absolute left-0 top-0 w-full overflow-hidden" style={{ height: 0 }}>
        {shown?.podium.map((actor, spot) => {
          const metal = METALS[Math.min(actor.entry.rank ?? spot + 1, 3) - 1];
          return <div key={actor.entry.userId} data-block={spot} className={clsx("absolute flex justify-center rounded-t-2xl pt-3 font-black leading-none", theme === "weekly" ? metal : "vso-board-step text-white/90 [text-shadow:0_2px_12px_rgba(0,0,0,.15)]")} style={{ transform: "translate3d(0, 120%, 0)" }}>
            {theme === "board" && <span className={clsx("absolute inset-x-0 top-0 h-1.5 rounded-t-2xl", metal)} />}
            {actor.entry.rank ?? spot + 1}
          </div>;
        })}
      </div>
      {shown?.actors.map((actor, index) => {
        const name = actor.entry.name; const first = name.split(/\s+/)[0] ?? name;
        return <div key={actor.entry.userId} data-actor={index} className="absolute left-0 top-0 will-change-transform" style={{ opacity: 0 }}>
          <div data-part="avatar" className="absolute left-0 top-0" style={{ width: AV, height: AV }}>
            <span className={clsx("block rounded-full p-[5px] shadow-[0_10px_30px_rgba(0,0,0,.28)]", actor.you ? "bg-[#ffe08a]" : "bg-white/75")}><ChatAvatar id={actor.entry.userId} name={name} size={AV - 10} /></span>
            {actor.you && <span data-part="pulse" className="absolute inset-0 rounded-full ring-4 ring-[#ffe08a]" style={{ opacity: 0 }} />}
          </div>
          <span data-part="label" className={clsx("absolute left-0 top-0 max-w-[120px] truncate whitespace-nowrap text-xs font-semibold", actor.you ? "text-[#ffe08a]" : "text-white/85")}>{actor.you ? "You" : first}</span>
          <div data-part="row" className="absolute left-0 top-0" style={{ opacity: 0, visibility: "hidden" }}>
            <span data-part="rank" className="absolute left-0 top-0 w-[30px] text-right text-sm font-extrabold text-white/70 tnum" />
            <span data-part="info" className="absolute left-0 top-0 block">
              <span className={clsx("block truncate text-[13px] font-bold sm:text-sm", actor.you && "text-[#ffe08a]")}>{name}{actor.you && " (you)"}</span>
              <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-white/15"><span data-part="fill" className="relative block h-full origin-left rounded-full bg-white" style={{ transform: "scaleX(0)" }}><span data-part="metal" className={clsx("absolute inset-0 rounded-full", actor.spot !== undefined && METALS[Math.min(actor.entry.rank ?? 3, 3) - 1])} style={{ opacity: 0 }} /></span></span>
            </span>
            <span data-part="score" className="absolute left-0 top-0 w-14 text-right text-xl font-extrabold tracking-[-.03em] tnum" />
          </div>
          <div data-part="stand" className="absolute left-0 top-0 flex w-max flex-col items-center" style={{ opacity: 0 }}>
            <span className="max-w-full truncate text-sm font-bold sm:text-base">{name}</span>
            <span className={clsx("mt-1.5 inline-flex items-center gap-1.5 rounded-xl px-3 py-1 text-sm font-extrabold shadow-[0_6px_18px_rgba(0,0,0,.15)] tnum", look.pill)}><Trophy aria-hidden="true" size={14} /><span data-part="stand-score">0</span></span>
          </div>
          <span data-part="badge" className="absolute left-0 top-0 grid h-5 min-w-5 place-items-center rounded-full bg-white px-1 text-[10px] font-extrabold text-primary-800 shadow tnum" style={{ opacity: 0 }}>{actor.entry.rank ?? ""}</span>
        </div>;
      })}
      <span data-el="crowd-more" className="absolute left-0 top-0 grid h-12 min-w-12 place-items-center rounded-full bg-white/15 px-3 text-sm font-extrabold ring-1 ring-inset ring-white/25" style={{ opacity: 0 }}>+{shown?.crowdMore ?? 0}</span>
      <span data-el="ranked-more" className="absolute left-1/2 top-0 text-xs font-bold uppercase tracking-[.14em] text-white/60" style={{ opacity: 0 }}>+{shown?.rankedMore ?? 0} more ranked</span>
      <span data-el="strip-more" className="absolute left-0 top-0 grid h-10 min-w-10 place-items-center rounded-full bg-white/15 px-2 text-xs font-extrabold ring-1 ring-inset ring-white/25" style={{ opacity: 0 }}>+{shown?.rankedMore ?? 0}</span>
      <div data-el="vignette" className="pointer-events-none absolute inset-0" style={{ opacity: 0, background: "radial-gradient(ellipse 55% 60% at 50% 62%, transparent 0%, rgba(0,0,0,.45) 60%, rgba(0,0,0,.75) 100%)" }} />
      <div data-el="beam-left" className="absolute left-0 top-0 h-[160vh] w-[min(260px,40vw)] origin-top [mask-image:linear-gradient(to_bottom,black,transparent)]" style={{ opacity: 0, background: "linear-gradient(90deg, transparent, rgba(255,255,255,.26) 50%, transparent)" }} />
      <div data-el="beam-right" className="absolute left-0 top-0 h-[160vh] w-[min(260px,40vw)] origin-top [mask-image:linear-gradient(to_bottom,black,transparent)]" style={{ opacity: 0, background: "linear-gradient(90deg, transparent, rgba(255,255,255,.26) 50%, transparent)" }} />
      <div data-el="crown" className="absolute left-0 top-0 text-[#ffe08a] drop-shadow-[0_4px_14px_rgba(0,0,0,.3)]" style={{ opacity: 0 }}><Crown size={48} /></div>
      <div data-el="title" className="absolute left-1/2 top-0 flex w-max flex-wrap justify-center gap-x-[.28em] text-center font-black uppercase leading-[.95] tracking-[-.04em]">
        {words.map(({ word, offset }) => <span key={offset} className="inline-flex whitespace-nowrap">{[...word].map((letter, index) => <span key={index} data-letter={offset + index} className={clsx("inline-block", look.letter)} style={{ opacity: 0 }}>{letter}</span>)}</span>)}
      </div>
      <p data-el="sub" className={clsx("absolute left-1/2 top-0 w-max max-w-[calc(100vw-40px)] truncate text-center text-xs font-extrabold uppercase tracking-[.2em] sm:text-sm", look.sub)} style={{ opacity: 0 }}>{subtitle}</p>
      <div data-el="hold" className="absolute left-1/2 top-0 h-[3px] w-40 overflow-hidden rounded-full bg-white/15" style={{ opacity: 0 }}><span data-el="hold-bar" className="block h-full w-1/3 rounded-full bg-white/70" /></div>
      <p data-el="caption" data-big="false" className="absolute left-1/2 top-0 w-max max-w-[calc(100vw-32px)] truncate text-center text-sm font-bold text-white/85 data-[big=true]:text-2xl data-[big=true]:font-extrabold data-[big=true]:tracking-[-.02em] data-[big=true]:text-white sm:data-[big=true]:text-3xl" style={{ opacity: 0 }} />
      <p data-el="you" hidden={!shown?.you} className="absolute left-1/2 top-0 w-max max-w-[calc(100vw-32px)] truncate rounded-full bg-[#ffe08a] px-4 py-1.5 text-sm font-extrabold text-[#3a2604] shadow-[0_8px_24px_rgba(0,0,0,.2)]" style={{ opacity: 0 }}>{shown?.you}</p>
      <canvas data-el="confetti" className="pointer-events-none absolute inset-0 h-full w-full" />
      <div data-el="line-top" className="absolute left-1/2 top-0 h-[2px] w-[76vw] rounded-full bg-white shadow-[0_0_18px_3px_rgba(255,255,255,.75)]" style={{ opacity: 0 }} />
      <div data-el="line-bottom" className="absolute left-1/2 top-0 h-[2px] w-[76vw] rounded-full bg-white shadow-[0_0_18px_3px_rgba(255,255,255,.75)]" style={{ opacity: 0 }} />
      <div data-el="flash" className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: 0 }} />
    </div>
    <div data-el="controls" className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 sm:p-5" style={{ opacity: 0 }}>
      <button type="button" onClick={toggleSound} aria-pressed={sound === "blocked" ? undefined : sound === "on"} aria-label={sound === "blocked" ? "Start the sound" : "Sound"}
        className={clsx("inline-flex h-10 items-center gap-2 rounded-full bg-white/10 px-3 text-sm font-semibold text-white ring-1 ring-inset backdrop-blur-sm transition-[background-color,transform] duration-150 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.97]", sound === "blocked" ? "ring-[#ffe08a]/80" : "ring-white/20")}>
        {sound === "off" ? <VolumeX size={18} /> : <Volume2 size={18} />}
        <span className="hidden sm:inline">{sound === "off" ? "Sound off" : sound === "blocked" ? "Tap for sound" : "Sound on"}</span>
      </button>
      <button ref={skipButton} type="button" onClick={() => leave.current()} className="inline-flex h-10 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-semibold text-white ring-1 ring-inset ring-white/20 backdrop-blur-sm transition-[background-color,transform] duration-150 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.97]">
        Skip<kbd className="hidden rounded bg-white/15 px-1.5 py-0.5 font-sans text-[11px] font-bold sm:inline">Esc</kbd>
      </button>
    </div>
    <div data-el="progress" className="absolute inset-x-0 bottom-0 h-[3px] origin-left bg-white/50" style={{ transform: "scaleX(0)" }} />
  </div>, document.body);
}
