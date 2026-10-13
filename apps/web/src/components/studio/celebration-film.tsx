"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import type { CelebrationFeed } from "@venture-studio/contracts";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { Check, Pause, Volume2, VolumeX } from "@/components/ui/icons";
import { createFilmAudio, filmSoundEnabled, noteHz, type Cue, type FilmAudio } from "@/lib/film-sound";
import { clamp, inOutCubic, mix, outBack, outCubic, outExpo, seeded, shuffled, span, spring } from "@/lib/film-timing";
import { drawConfetti, makeConfetti, type Piece } from "@/lib/film-confetti";
import { prefersReducedMotion } from "@/lib/motion";
import { celebrationFacts, recentCelebrationWords, rememberCelebrationWords, spellDuration, writeCelebration } from "@/lib/celebration-lines";

/*
 * The celebration: a ten-second montage, cut on the beat of its own track, when someone's task is approved or done.
 *   beats 0-2    the opener: a stamp slams down, a check draws itself, or a word punches in
 *   beats 2-6    four quick cuts, one per beat: hype words and what happened ("2 DAYS EARLY", "FIRST TRY")
 *   beats 6-10   the task itself on a card, and a DONE badge stamped on it
 *   beats 10-14  two stats that count up (tasks done, this week, on time in a row, who approved it)
 *   beats 14-18  the person, and a line for them, word by word (the music drops back)
 *   beats 18-21  the sign-off, confetti, and out
 * Each play picks its opener, colours, backgrounds, transitions, words, key, chords, and groove at random, and the
 * line library leaves out what this browser saw lately, so it's a different edit every time.
 */

type Pattern = "rays" | "stripes" | "dots" | "grid" | "glow";
type Transition = "cut" | "whip" | "zoom" | "iris";
type Palette = { bg: [string, string, string, string]; dark: string; accent: string; confetti: string[] };
const PALETTES: Palette[] = [
  { bg: ["#0f6e38", "#158a47", "#0a552a", "#1aa055"], dark: "#04190d", accent: "#ffe08a", confetti: ["#ffe08a", "#ffffff", "#7ee2a8", "#f6cb52", "#9bd8ff"] },
  { bg: ["#ff5a36", "#e91e63", "#ff8f3d", "#c2185b"], dark: "#2a0a14", accent: "#fff3b0", confetti: ["#fff3b0", "#ffffff", "#ffb3c7", "#ffd166", "#ff8fa3"] },
  { bg: ["#4f46e5", "#0891b2", "#7c3aed", "#2563eb"], dark: "#0b0a2a", accent: "#a5f3fc", confetti: ["#a5f3fc", "#ffffff", "#c4b5fd", "#fde68a", "#93c5fd"] },
  { bg: ["#16140f", "#211d12", "#2c2616", "#0e0d0a"], dark: "#000000", accent: "#f6cb52", confetti: ["#f6cb52", "#fff5c7", "#e09a1f", "#ffffff"] },
  { bg: ["#db2777", "#7c3aed", "#c026d3", "#4f46e5"], dark: "#1e0b2e", accent: "#fde68a", confetti: ["#fde68a", "#ffffff", "#f9a8d4", "#c4b5fd", "#a5f3fc"] },
  { bg: ["#0f766e", "#0d9488", "#115e59", "#15803d"], dark: "#03201d", accent: "#fef08a", confetti: ["#fef08a", "#ffffff", "#5eead4", "#86efac"] },
];
/** Chord progressions in a major key, as semitones from the key's root: four bars, then home. */
const PROGRESSIONS = [
  [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],
  [[9, 12, 16], [5, 9, 12], [0, 4, 7], [7, 11, 14]],
  [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]],
  [[5, 9, 12], [7, 11, 14], [4, 7, 11], [9, 12, 16]],
];
const KEYS = [48, 50, 51, 53, 55]; // C, D, E flat, F, G
const MAJOR_PENTATONIC = [0, 2, 4, 7, 9];

// The edit, in beats. Each shot covers [from, to); the last runs to the end.
const SHOTS = [
  { from: 0, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 }, { from: 5, to: 6 },
  { from: 6, to: 10 }, { from: 10, to: 12 }, { from: 12, to: 14 }, { from: 14, to: 18 }, { from: 18, to: 21 },
];
const END = 21;
const EXIT = 0.3; // a skip's fade, in seconds
const TRANSITION_SECONDS: Record<Transition, number> = { cut: 0.01, whip: 0.22, zoom: 0.25, iris: 0.32 };

/** White or near-black text, whichever reads better on the colour. */
function inkFor(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.32 ? "#16130d" : "#ffffff";
}

type Stat = { value?: number; text?: string; prefix?: string; suffix?: string; label: string; avatar?: { id: string; name: string } };
type Edit = {
  beat: number; palette: Palette; opener: "stamp" | "check" | "word"; openerWord: string; openerNote: string;
  cuts: { word: string; bg: string; pattern: Pattern; look: "solid" | "outline" | "tilt" | "avatar" }[];
  tasks: { title: string; chips: string[] }[]; venture?: string; more: number;
  stats: Stat[]; line: string; signoff: string; footnote: string;
  patterns: Pattern[]; transitions: Transition[];
  music: { root: number; chords: number[][]; groove: number; arp: number };
  used: string[];
};

function makeEdit(feed: CelebrationFeed, seed: number, recent: Set<string>, now: Date): Edit {
  const random = seeded(seed);
  const pickOne = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const items = feed.items;
  const lead = items[items.length - 1]!; // the newest is the headline
  const facts = celebrationFacts(feed, now);
  const reviewer = facts.reviewer;
  const words = writeCelebration(facts, random, recent);
  const palette = pickOne(PALETTES);
  const patterns = shuffled<Pattern>(["rays", "stripes", "dots", "grid", "glow", "rays", "stripes", "dots", "grid", "glow"], random);
  const looks = shuffled(["solid", "outline", "tilt", "avatar"] as const, random);
  const cuts = words.cuts.map((word, index) => ({ word, bg: palette.bg[(index + 1) % 4]!, pattern: patterns[index + 1]!, look: looks[index]! }));
  const opener = pickOne(["stamp", "check", "word"] as const);
  const openerWord = opener === "word" ? pickOne(["SHIPPED", "DONE", "NAILED IT", "BOOM"]) : lead.trigger === "approved" ? "APPROVED" : "DONE";
  const openerNote = lead.approvedBy ? `${reviewer} approved your work` : items.length > 1 ? `${items.length} tasks finished` : "Task complete";

  const timing = (item: CelebrationFeed["items"][number]) => item.minutesEarly === undefined ? undefined : item.minutesEarly >= 60 ? `${spellDuration(item.minutesEarly)} early` : item.minutesEarly > -60 ? "Right on time" : `Done, ${spellDuration(item.minutesEarly)} past due`;
  const tasks = [...items].reverse().slice(0, 3).map((item) => ({
    title: item.title,
    chips: [timing(item), item.firstTimeRight ? "Right first time" : undefined, item.estimatedMinutes ? `${spellDuration(item.estimatedMinutes)} of work` : undefined].filter((chip): chip is string => Boolean(chip)),
  }));

  // Two stats that count up, the strongest first: a streak, this week, how early, who approved it, the total.
  const stats: Stat[] = [];
  if (feed.stats.onTimeStreak >= 2) stats.push({ value: feed.stats.onTimeStreak, label: "on time in a row" });
  if (feed.stats.thisWeek >= 2) stats.push({ value: feed.stats.thisWeek, label: "done this week" });
  if ((lead.minutesEarly ?? 0) >= 60) { const [amount, unit] = spellDuration(lead.minutesEarly!).split(" "); stats.push({ value: Number(amount), suffix: ` ${unit}`, label: "ahead of the deadline" }); }
  if (lead.approvedBy) stats.push({ text: lead.approvedBy.name.split(/\s+/)[0], label: "approved it", avatar: { id: lead.approvedBy.userId, name: lead.approvedBy.name } });
  stats.push({ value: feed.stats.finished, prefix: "#", label: feed.stats.finished === 1 ? "your first task done" : "tasks done, all time" });
  if (stats.length < 2) stats.push({ value: Math.max(1, feed.stats.thisWeek), label: "done this week" });
  const chosen = [stats[0]!, ...shuffled(stats.slice(1), random)].slice(0, 2);

  const footnote = [feed.stats.thisWeek ? `${feed.stats.thisWeek} done this week` : "", feed.stats.finished ? `${feed.stats.finished} all time` : ""].filter(Boolean).join(" · ");
  return {
    beat: 60 / (118 + Math.round(random() * 8)), palette, opener, openerWord, openerNote, cuts, tasks, venture: lead.ventureName, more: Math.max(0, items.length - 3),
    stats: chosen, line: words.line, signoff: words.signoff, footnote, patterns,
    transitions: SHOTS.map((_, index) => (index === 0 ? "cut" : index <= 4 ? "cut" : pickOne(["whip", "zoom", "iris", "cut"] as const))),
    music: { root: pickOne(KEYS), chords: pickOne(PROGRESSIONS), groove: Math.floor(random() * 2), arp: Math.floor(random() * 2) },
    used: [...words.used, ...words.cuts],
  };
}

/** The track and the hits, on the edit's beat grid. */
function cues(edit: Edit): Cue[] {
  const list: Cue[] = [];
  const at = (beat: number, play: Cue["play"]) => { list.push({ at: beat * edit.beat, play }); };
  const { root, chords, groove, arp } = edit.music;
  const chordAt = (beat: number) => chords[Math.min(3, Math.floor(beat / 4))]!;
  const notes = (chord: number[], octave = 0) => chord.map((step) => noteHz(root + 12 + step + octave));
  const scale = Array.from({ length: 10 }, (_, index) => noteHz(root + 24 + MAJOR_PENTATONIC[index % 5]! + 12 * Math.floor(index / 5)));
  const beatSeconds = edit.beat;

  // The opener.
  if (edit.opener === "stamp") { at(0, (s, w) => s.riser(w, 0.35 * beatSeconds + 0.1, 0.16)); at(0.4, (s, w) => { s.impact(w, 1.1); s.crash(w, 0.12); s.stab(w, notes(chords[0]!), 0.5, 0.05); }); }
  else if (edit.opener === "check") { at(0, (s, w) => s.whoosh(w, { duration: 0.5, peak: 0.12, high: 2400 })); at(1.1, (s, w) => { s.impact(w, 0.7); s.chime(w, scale[5]!, 0.08); s.chime(w + 0.08, scale[7]!, 0.06); }); }
  else { for (let index = 0; index < edit.openerWord.length; index++) at(0.1 + index * 0.08, (s, w) => s.tick(w, 1500 + index * 140, 0.03)); at(1.05, (s, w) => { s.impact(w, 0.9); s.crash(w, 0.1); }); }
  at(0, (s, w) => s.pad(w, 2 * beatSeconds, notes(chords[0]!, -12), 0.02));

  // The montage: a hit, a stab, and a whoosh on every cut, four on the floor underneath.
  for (let beat = 2; beat < 6; beat++) {
    at(beat, (s, w) => { s.kick(w, 0.4); s.stab(w, notes(chordAt(beat)), 0.22, 0.045); s.whoosh(w - 0.06, { duration: 0.22, peak: 0.08, high: 3200, from: 0.4, to: -0.4 }); });
    if (beat % 2) at(beat, (s, w) => s.clap(w, 0.13));
    for (const step of [0.25, 0.5, 0.75]) at(beat + step, (s, w) => s.hat(w, step === 0.5 ? 0.035 : 0.022));
  }
  // The task, the stats: the groove, a bass line, and an arpeggio.
  for (let beat = 6; beat < 14; beat++) {
    const chord = chordAt(beat);
    at(beat, (s, w) => s.kick(w, 0.36));
    if (beat % 2) at(beat, (s, w) => s.clap(w, 0.12));
    for (const step of groove ? [0.5] : [0.25, 0.5, 0.75]) at(beat + step, (s, w) => s.hat(w, step === 0.5 ? 0.032 : 0.02));
    for (const step of [0, 0.5]) at(beat + step, (s, w) => s.bass(w, noteHz(root - 12 + chord[0]! + (step ? 12 : 0)), 0.22, 0.11));
    if (beat % 4 === 2) at(beat, (s, w) => s.pad(w, 4 * beatSeconds, notes(chord, -12), 0.016));
    const tones = notes(chord, 12);
    const pattern = arp ? [0, 1, 2, 1] : [0, 2, 1, 2];
    for (let step = 0; step < 4; step++) at(beat + step * 0.25, (s, w) => s.pluck(w, tones[pattern[step]!]!, 0.035, step % 2 ? 0.3 : -0.3));
  }
  at(6, (s, w) => s.whoosh(w - 0.05, { duration: 0.35, peak: 0.14, high: 2600 }));
  at(8, (s, w) => { s.impact(w, 0.55); s.tick(w, 2637, 0.05); });
  for (const start of [10, 12]) {
    at(start, (s, w) => s.whoosh(w - 0.06, { duration: 0.3, peak: 0.13, high: 3000, from: -0.5, to: 0.5 }));
    for (let step = 0; step < 8; step++) at(start + 0.15 + step * 0.1, (s, w) => s.tick(w, 1800 + step * 120, 0.018));
    at(start + 1, (s, w) => s.chime(w, scale[(start / 2) % 5 + 3]!, 0.06));
  }
  // The line: the beat drops away, a chime for each word, and a rise into the finale.
  at(14, (s, w) => { s.impact(w, 0.5); s.pad(w, 4 * beatSeconds + 0.2, notes(chords[3]!, -12), 0.026); });
  at(16, (s, w) => s.kick(w, 0.2));
  const lineWords = edit.line.split(/\s+/).length;
  for (let index = 0; index < lineWords; index++) at(14.4 + (index * 2.4) / Math.max(1, lineWords), (s, w) => s.chime(w, scale[index % scale.length]!, 0.03, (index % 3) * 0.3 - 0.3));
  at(17, (s, w) => s.riser(w, beatSeconds, 0.18));
  // The finale: home chord, a crash, sparkle, and the groove to the end.
  at(18, (s, w) => { s.impact(w, 1.2); s.crash(w, 0.16); s.fanfare(w); s.sparkle(w + 0.05, 1.4, 20, 0.04); s.bass(w, noteHz(root - 12), 1, 0.14); });
  for (let beat = 18.5; beat < 20.5; beat += 0.5) at(beat, (s, w) => (beat % 1 ? s.hat(w, 0.025) : s.kick(w, 0.28)));
  at(19, (s, w) => s.clap(w, 0.1));
  at(20, (s, w) => s.whoosh(w, { duration: 0.6, peak: 0.12, from: 0.3, to: -0.3 }));
  return list;
}

const subscribeNever = () => () => {};
const PATTERN_STYLE: Record<Pattern, React.CSSProperties> = {
  rays: { background: "repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,.13) 0deg 9deg, transparent 9deg 18deg)" },
  stripes: { background: "repeating-linear-gradient(135deg, rgba(255,255,255,.1) 0 26px, transparent 26px 52px)" },
  dots: { background: "radial-gradient(rgba(255,255,255,.2) 2.2px, transparent 2.8px) 0 0 / 24px 24px" },
  grid: { background: "linear-gradient(rgba(255,255,255,.09) 1px, transparent 1px) 0 0 / 44px 44px, linear-gradient(90deg, rgba(255,255,255,.09) 1px, transparent 1px) 0 0 / 44px 44px" },
  glow: { background: "radial-gradient(60% 50% at 50% 50%, rgba(255,255,255,.28), transparent 70%)" },
};
/** A moving background for a shot; rays are a large square turned around the centre, the rest drift. */
function Backdrop({ pattern }: { pattern: Pattern }) {
  return <span aria-hidden="true" data-pattern={pattern} className={clsx("pointer-events-none absolute", pattern === "rays" ? "left-1/2 top-1/2 h-[220vmax] w-[220vmax]" : "-inset-[60px]")} style={PATTERN_STYLE[pattern]} />;
}

/**
 * Plays one celebration over the whole window, then calls `onDone`. `onShown` runs once it's on screen (so it isn't
 * shown again), `onPause` when the person pauses celebrations for a while. Escape or Skip ends it early.
 */
export function CelebrationFilm({ feed, userId, onShown, onDone, onPause }: { feed: CelebrationFeed; userId: string; onShown: () => void; onDone: () => void; onPause: (hours: 1 | 3 | 24) => void }) {
  const canPlay = useSyncExternalStore(subscribeNever, () => !prefersReducedMotion(), () => false);
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [recent] = useState(() => (typeof window === "undefined" ? new Set<string>() : recentCelebrationWords()));
  const [now] = useState(() => new Date());
  const edit = useMemo(() => makeEdit(feed, seed, recent, now), [feed, seed, recent, now]);
  const [sound, setSound] = useState<"on" | "off" | "blocked">(() => (filmSoundEnabled() ? "on" : "off"));
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);
  const audio = useRef<FilmAudio | null>(null);
  const leave = useRef<() => void>(() => {});
  const live = useRef({ onShown, onDone, edit });
  useEffect(() => { live.current = { onShown, onDone, edit }; });

  // Declared first, so it notes where focus was before Skip takes it, and puts it back after. Escape skips (or closes
  // the pause menu); Tab stays on the film's buttons; any key lets the browser start the sound.
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
    // Not on the first, hydrating pass (which can't know yet): only when the browser really can't play it.
    if (!canPlay) { if (prefersReducedMotion()) live.current.onDone(); return; }
    const node = root.current;
    if (!node) return;
    const plan = live.current.edit;
    const beat = plan.beat;
    let startedAt: number | null = null;
    const clock = () => (startedAt === null ? 0 : (performance.now() - startedAt) / 1000);
    const track = createFilmAudio(clock);
    audio.current = track;
    document.documentElement.dataset.vsoFilm = "celebration";

    const shots = [...node.querySelectorAll<HTMLElement>("[data-shot]")];
    const animated = shots.map((shot) => [...shot.querySelectorAll<HTMLElement>("[data-k]")]);
    const backdrops = shots.map((shot) => shot.querySelector<HTMLElement>("[data-pattern]"));
    const camera = node.querySelector<HTMLElement>("[data-el='camera']")!;
    const flashLayer = node.querySelector<HTMLElement>("[data-el='flash']")!;
    const progress = node.querySelector<HTMLElement>("[data-el='progress']")!;
    const controls = node.querySelector<HTMLElement>("[data-el='controls']")!;
    const canvas = node.querySelector<HTMLCanvasElement>("canvas")!;
    const fitted = [...node.querySelectorAll<HTMLElement>("[data-fit]")];
    const paint = canvas.getContext("2d");
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    let confetti: Piece[] | null = null; let size = "";
    let exitAt: number | null = null; let finished = false; let shown = false; let soundState = ""; let raf = 0;

    const finish = () => { if (finished) return; finished = true; cancelAnimationFrame(raf); track.stop(0.25); live.current.onDone(); };
    leave.current = () => { if (exitAt !== null || finished) return; exitAt = clock(); track.stop(0.3); };
    // Hits that shake the camera and flash the screen: the opener, each cut, the badge, the stats landing, the finale.
    const hits = [plan.opener === "stamp" ? 0.4 : plan.opener === "check" ? 1.1 : 1.05, 2, 3, 4, 5, 8, 11, 13, 18];

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (startedAt === null) { startedAt = now; track.add(cues(plan)); track.start(); }
      const t = Math.max(0, (now - startedAt) / 1000);
      const b = t / beat;
      if (!shown) { shown = true; live.current.onShown(); }
      if (b >= END || (exitAt !== null && t - exitAt >= EXIT)) { finish(); return; }
      const W = window.innerWidth; const H = window.innerHeight;
      const key = `${W}x${H}`;
      if (key !== size) {
        size = key; canvas.width = Math.round(W * ratio); canvas.height = Math.round(H * ratio);
        // Big type fits its share of the window, whatever the words: measured, then shrunk if it would overflow.
        for (const element of fitted) {
          element.style.fontSize = "";
          const [width, height] = (element.dataset.fit ?? "0.9,0.4").split(",").map(Number) as [number, number];
          for (let pass = 0; pass < 3; pass++) {
            const factor = Math.min(1, (W * width) / Math.max(1, element.scrollWidth, element.offsetWidth), (H * height) / Math.max(1, element.offsetHeight));
            if (factor >= 0.98) break;
            element.style.fontSize = `${Math.floor(parseFloat(getComputedStyle(element).fontSize) * factor)}px`;
          }
        }
      }

      // The camera pumps on every beat of the montage and shakes on the hits; the whole film dissolves at the end.
      let shakeX = 0; let shakeY = 0;
      for (const hit of hits) { if (b < hit) continue; const since = (b - hit) * beat; const amount = (hit === 18 || hit < 1.2 ? 9 : 4) * Math.exp(-since * 13); shakeX += amount * Math.sin(since * 71); shakeY += amount * Math.cos(since * 57); }
      const pump = b >= 2 && b < 14 ? 0.014 * Math.exp(-(b % 1) * 6) : 0;
      const out = exitAt !== null ? inOutCubic(span(t, exitAt, EXIT)) : inOutCubic(span(b, END - 1, 1));
      node.style.opacity = String(1 - out);
      camera.style.transform = `translate3d(${shakeX}px, ${shakeY}px, 0) scale(${1 + pump + 0.04 * out})`;
      camera.style.filter = out > 0.01 ? `blur(${out * 6}px)` : "none";
      const flashes = hits.map((hit) => (b >= hit ? (hit === 18 ? 0.5 : hit < 1.2 ? 0.4 : 0.22) * (1 - outCubic(span((b - hit) * beat, 0, 0.28))) : 0));
      flashLayer.style.opacity = String(Math.max(0, ...flashes));

      // Each shot comes in by its transition and stays until the next one has covered it.
      shots.forEach((shot, index) => {
        const { from, to } = SHOTS[index]!;
        const transition = plan.transitions[index]!;
        const next = SHOTS[index + 1];
        const covered = next ? b >= next.from + TRANSITION_SECONDS[plan.transitions[index + 1]!] / beat : false;
        const visible = b >= from && !covered;
        shot.style.visibility = visible ? "visible" : "hidden";
        if (!visible) return;
        const since = (b - from) * beat;
        const p = span(since, 0, TRANSITION_SECONDS[transition]);
        if (transition === "whip") { shot.style.transform = `translate3d(${(1 - outExpo(p)) * 100}%, 0, 0)`; shot.style.filter = p < 1 ? `blur(${(1 - p) * 10}px)` : "none"; }
        else if (transition === "zoom") { shot.style.transform = `scale(${mix(1.35, 1, outExpo(p))})`; shot.style.opacity = String(span(since, 0, 0.1)); shot.style.filter = p < 1 ? `blur(${(1 - p) * 8}px)` : "none"; }
        else if (transition === "iris") { shot.style.clipPath = p < 1 ? `circle(${mix(0, 150, outCubic(p))}% at 50% 50%)` : "none"; }
        const backdrop = backdrops[index];
        if (backdrop) {
          const kind = backdrop.dataset.pattern as Pattern;
          backdrop.style.transform = kind === "rays" ? `translate(-50%, -50%) rotate(${b * 7}deg)` : kind === "glow" ? `scale(${1 + 0.08 * Math.exp(-(b % 1) * 5)})` : `translate3d(${((b * 18) % 52) - 26}px, ${kind === "grid" ? ((b * 22) % 44) - 22 : 0}px, 0)`;
        }
        // Everything inside the shot, on its own cue (in beats from the shot's start).
        for (const element of animated[index]!) {
          const local = b - from - Number(element.dataset.at ?? 0);
          const length = Number(element.dataset.len ?? 0.5);
          const kind = element.dataset.k;
          const progressIn = span(local, 0, length);
          if (kind === "pop") {
            const q = outBack(progressIn, 2.2);
            element.style.opacity = String(span(local, 0, length * 0.3));
            element.style.transform = `${element.dataset.base ?? ""} scale(${mix(1.5, 1, q)})`;
            element.style.filter = progressIn < 1 ? `blur(${(1 - outExpo(progressIn)) * 10}px)` : "none";
          } else if (kind === "rise") {
            element.style.opacity = String(span(local, 0, length * 0.35));
            element.style.transform = `${element.dataset.base ?? ""} translate3d(0, ${(1 - outExpo(progressIn)) * 46}px, 0)`;
            element.style.filter = progressIn < 1 ? `blur(${(1 - outExpo(progressIn)) * 6}px)` : "none";
          } else if (kind === "slam") {
            const q = local < 0 ? 0 : spring(local * beat, 0.42, 0.38);
            element.style.opacity = String(span(local, 0, 0.08));
            element.style.transform = `${element.dataset.base ?? ""} scale(${mix(2.6, 1, q)}) rotate(${mix(-26, Number(element.dataset.rot ?? -8), q)}deg)`;
          } else if (kind === "fade") {
            element.style.opacity = String(span(local, 0, length));
          } else if (kind === "count") {
            const target = Number(element.dataset.to ?? 0);
            element.style.opacity = String(span(local, 0, 0.1));
            const value = Math.round(target * outCubic(progressIn));
            const text = `${element.dataset.prefix ?? ""}${value}${element.dataset.suffix ?? ""}`;
            if (element.textContent !== text) element.textContent = text;
            element.style.transform = `scale(${1 + 0.12 * Math.exp(-Math.max(0, local - length) * beat * 9) * (local >= length ? 1 : 0)})`;
          } else if (kind === "draw") {
            const total = Number(element.dataset.length ?? 300);
            element.style.strokeDashoffset = String(total * (1 - outCubic(progressIn)));
            element.style.opacity = String(local >= 0 ? 1 : 0);
          } else if (kind === "pulse") {
            element.style.transform = `${element.dataset.base ?? ""} scale(${(1 + 0.06 * Math.exp(-(b % 1) * 6)) * mix(0.6, 1, outBack(span(local, 0, 0.6), 1.8))})`;
            element.style.opacity = String(span(local, 0, 0.2));
          } else if (kind === "drift") {
            element.style.transform = `scale(${1 + 0.05 * span(local, 0, to - from)})`;
          }
        }
      });

      // Confetti for the finale.
      if (paint) {
        if (b >= 18) { confetti ??= makeConfetti(W, H, plan.palette.confetti, seeded(Math.floor(Math.random() * 1e9))); drawConfetti(paint, confetti, (b - 18) * beat, ratio, W, H); }
      }
      progress.style.transform = `scaleX(${clamp(b / END, 0, 1)})`;
      controls.style.opacity = String(outCubic(span(t, 0.3, 0.4)));
      const state = !track.enabled() ? "off" : track.playing() || t < 0.8 ? "on" : "blocked";
      if (state !== soundState) { soundState = state; setSound(state); }
    };
    raf = requestAnimationFrame(frame);
    skipButton.current?.focus({ preventScroll: true });
    const onVisibility = () => { if (document.hidden) finish(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVisibility); track.stop(0.2); audio.current = null;
      if (document.documentElement.dataset.vsoFilm === "celebration") delete document.documentElement.dataset.vsoFilm;
    };
  }, [canPlay]);

  // The words it used are remembered, so the next one picks others.
  useEffect(() => { if (canPlay) rememberCelebrationWords(edit.used); }, [canPlay, edit]);

  if (!canPlay) return null;
  const { palette } = edit;
  const toggleSound = () => { const track = audio.current; if (!track) return; if (sound === "blocked") track.start(); else track.setEnabled(sound === "off"); };
  const pauseFor = (hours: 1 | 3 | 24) => { setMenu(false); onPause(hours); leave.current(); };
  const lineWords = edit.line.split(/\s+/);
  const shot = (index: number, background: string, children: React.ReactNode, pattern = edit.patterns[index % edit.patterns.length]!) => (
    <section key={index} data-shot={index} className="absolute inset-0 overflow-hidden" style={{ background, color: inkFor(background), visibility: "hidden" }}>
      <Backdrop pattern={pattern} />
      {children}
    </section>
  );
  const big = "font-black uppercase leading-[.9] tracking-[-.045em] text-center [overflow-wrap:anywhere]";

  return createPortal(<div ref={root} role="dialog" aria-modal="true" aria-label="Task celebration" onPointerUp={() => audio.current?.start()} className="fixed inset-0 z-[100] select-none overflow-hidden text-white" style={{ background: palette.dark }}>
    <p className="sr-only">{edit.openerNote}: {edit.tasks.map((task) => task.title).join(", ")}. {edit.line} Press Escape or Skip to close.</p>
    <div data-el="camera" aria-hidden="true" className="absolute inset-0">
      {/* The opener. */}
      {shot(0, palette.bg[0], <div className="absolute inset-0 grid place-items-center px-6">
        <div className="flex flex-col items-center">
          {edit.opener === "stamp" && <span data-k="slam" data-at="0.4" data-rot="-8" data-fit="0.84,0.34" className="rounded-[28px] border-[10px] px-8 py-3 text-[clamp(52px,13vw,160px)] font-black uppercase leading-none tracking-[-.03em] sm:px-12" style={{ opacity: 0, borderColor: palette.accent, color: palette.accent, boxShadow: `0 0 0 4px ${palette.bg[0]}, 0 20px 60px rgba(0,0,0,.25)` }}>{edit.openerWord}</span>}
          {edit.opener === "check" && <svg viewBox="0 0 200 200" className="h-[min(46vw,280px)] w-[min(46vw,280px)]" fill="none" stroke={palette.accent} strokeWidth="14" strokeLinecap="round" strokeLinejoin="round">
            <circle data-k="draw" data-at="0" data-len="0.9" data-length="534" cx="100" cy="100" r="85" strokeDasharray="534" style={{ strokeDashoffset: 534, opacity: 0 }} transform="rotate(-90 100 100)" />
            <path data-k="draw" data-at="0.65" data-len="0.45" data-length="150" d="M58 104 l28 28 l56 -62" strokeDasharray="150" style={{ strokeDashoffset: 150, opacity: 0 }} />
          </svg>}
          {edit.opener === "check" && <span data-k="pop" data-at="1.1" data-len="0.4" data-fit="0.9,0.2" className={clsx(big, "mt-4 text-[clamp(44px,10vw,120px)]")} style={{ opacity: 0 }}>{edit.openerWord}.</span>}
          {edit.opener === "word" && <span data-fit="0.9,0.42" className={clsx(big, "flex max-w-[92vw] flex-wrap justify-center text-[clamp(56px,15vw,190px)]")}>{[...edit.openerWord].map((letter, index) => <span key={index} data-k="pop" data-at={String(0.1 + index * 0.08)} data-len="0.35" className="inline-block whitespace-pre" style={{ opacity: 0 }}>{letter}</span>)}</span>}
          <span data-k="rise" data-at="1.1" data-len="0.6" className="mt-6 rounded-full bg-black/20 px-4 py-1.5 text-sm font-bold uppercase tracking-[.18em] backdrop-blur-sm" style={{ opacity: 0 }}>{edit.openerNote}</span>
        </div>
      </div>, edit.patterns[0])}

      {/* Four quick cuts. */}
      {edit.cuts.map((cut, index) => shot(index + 1, cut.bg, <div className="absolute inset-0 grid place-items-center px-5">
        <div className="flex max-w-[92vw] flex-col items-center gap-5">
          {cut.look === "avatar" && <span data-k="pop" data-at="0" data-len="0.4" className="rounded-full p-1.5 shadow-[0_14px_40px_rgba(0,0,0,.25)]" style={{ opacity: 0, background: palette.accent }}><ChatAvatar id={userId} name={feed.name} size={96} /></span>}
          <span data-k="pop" data-at="0" data-len="0.35" data-fit={cut.look === "avatar" ? "0.88,0.3" : "0.88,0.45"} data-base={cut.look === "tilt" ? "rotate(-6deg)" : ""}
            className={clsx(big, "text-[clamp(52px,14vw,200px)]", cut.look === "tilt" && "italic")}
            style={{ opacity: 0, ...(cut.look === "outline" ? { color: "transparent", WebkitTextStroke: `3px ${inkFor(cut.bg)}` } : {}), ...(cut.look === "tilt" ? { background: palette.accent, color: inkFor(palette.accent), padding: "0 .18em" } : {}) }}>{cut.word}</span>
        </div>
      </div>, cut.pattern))}

      {/* The task. */}
      {shot(5, palette.bg[2], <div className="absolute inset-0 grid place-items-center px-5">
        <div data-k="drift" className="relative w-full max-w-2xl">
          {edit.tasks.slice(1).map((task, index) => <div key={index} data-k="rise" data-at={String(0.15 + index * 0.1)} data-len="0.6" data-base={`rotate(${index ? 5 : -5}deg) translateY(${(index + 1) * -14}px)`} className="absolute inset-x-6 top-0 h-full rounded-[28px] bg-white/80 p-6 text-neutral-900 shadow-[0_20px_60px_rgba(0,0,0,.25)]" style={{ opacity: 0 }}><p className="truncate text-sm font-bold opacity-50">{task.title}</p></div>)}
          <div data-k="rise" data-at="0" data-len="0.7" className="relative rounded-[28px] bg-white p-6 text-neutral-900 shadow-[0_24px_70px_rgba(0,0,0,.3)] sm:p-9" style={{ opacity: 0 }}>
            {edit.venture && <p className="text-xs font-extrabold uppercase tracking-[.18em] text-neutral-400">{edit.venture}{edit.tasks.length > 1 ? ` · ${feed.items.length} tasks` : ""}</p>}
            <h2 data-fit="0.84,0.3" className="mt-2 text-[clamp(26px,4.6vw,46px)] font-black leading-[1.05] tracking-[-.03em] [overflow-wrap:anywhere]">
              {edit.tasks[0]!.title.split(/\s+/).slice(0, 18).map((word, index) => <span key={index} data-k="rise" data-at={String(0.35 + index * 0.09)} data-len="0.5" className="mr-[.25em] inline-block" style={{ opacity: 0 }}>{word}</span>)}
            </h2>
            <div className="mt-5 flex flex-wrap gap-2">{edit.tasks[0]!.chips.map((chip, index) => <span key={chip} data-k="pop" data-at={String(1.3 + index * 0.25)} data-len="0.35" className="rounded-full px-3 py-1.5 text-sm font-bold" style={{ opacity: 0, background: `${palette.bg[0]}1f`, color: palette.bg[0] === "#16140f" ? "#7a5b06" : palette.bg[0] }}>{chip}</span>)}{edit.more > 0 && <span className="rounded-full bg-neutral-100 px-3 py-1.5 text-sm font-bold text-neutral-500">+{edit.more} more</span>}</div>
            <span data-k="slam" data-at="2" data-rot="12" className="absolute -right-4 -top-6 grid h-24 w-24 place-items-center rounded-full text-center text-sm font-black uppercase leading-tight shadow-[0_10px_30px_rgba(0,0,0,.3)] sm:-right-8 sm:-top-8 sm:h-28 sm:w-28" style={{ opacity: 0, background: palette.accent, color: inkFor(palette.accent) }}><span className="flex flex-col items-center"><Check size={28} strokeWidth={3} />Done</span></span>
          </div>
        </div>
      </div>)}

      {/* Two stats. */}
      {edit.stats.map((stat, index) => shot(6 + index, palette.bg[index ? 3 : 1], <div className="absolute inset-0 grid place-items-center px-5">
        <div className="flex flex-col items-center text-center">
          {stat.avatar && <span data-k="pop" data-at="0.1" data-len="0.45" className="mb-5 rounded-full p-1.5 shadow-[0_14px_40px_rgba(0,0,0,.25)]" style={{ opacity: 0, background: palette.accent }}><ChatAvatar id={stat.avatar.id} name={stat.avatar.name} size={110} /></span>}
          {stat.value !== undefined
            ? <span data-k="count" data-at="0.15" data-len="0.85" data-to={String(stat.value)} data-prefix={stat.prefix ?? ""} data-suffix={stat.suffix ?? ""} data-fit={stat.suffix ? "0.9,0.34" : "0.9,0.4"} className={clsx(big, "tnum text-[clamp(84px,24vw,260px)]")} style={{ opacity: 0 }}>0</span>
            : <span data-k="pop" data-at="0.3" data-len="0.4" data-fit="0.9,0.3" className={clsx(big, "text-[clamp(56px,16vw,180px)]")} style={{ opacity: 0 }}>{stat.text}</span>}
          <span data-k="rise" data-at="0.6" data-len="0.5" className="mt-4 text-lg font-extrabold uppercase tracking-[.16em] sm:text-2xl" style={{ opacity: 0 }}>{stat.label}</span>
        </div>
      </div>))}

      {/* The person, and their line. */}
      {shot(8, palette.dark, <div className="absolute inset-0 grid place-items-center px-6" style={{ background: `radial-gradient(70% 60% at 50% 35%, ${palette.bg[0]}cc, transparent 75%)` }}>
        <div className="flex max-w-4xl flex-col items-center text-center">
          <span data-k="pulse" data-at="0" className="rounded-full p-2" style={{ opacity: 0, background: palette.accent, boxShadow: `0 0 0 10px ${palette.accent}33, 0 0 80px ${palette.accent}66` }}><ChatAvatar id={userId} name={feed.name} size={120} /></span>
          <p data-fit="0.9,0.42" className="mt-8 text-[clamp(30px,5.6vw,68px)] font-black leading-[1.08] tracking-[-.035em] text-white [overflow-wrap:anywhere]">
            {lineWords.map((word, index) => <span key={index} data-k="rise" data-at={String(0.4 + (index * 2.4) / Math.max(1, lineWords.length))} data-len="0.45" className="mr-[.24em] inline-block" style={{ opacity: 0 }}>{word}</span>)}
          </p>
        </div>
      </div>, "glow")}

      {/* The sign-off. */}
      {shot(9, palette.bg[0], <div className="absolute inset-0 grid place-items-center px-6">
        <div className="flex flex-col items-center text-center">
          <span data-k="pop" data-at="0" data-len="0.45" data-fit="0.9,0.46" className={clsx(big, "max-w-[92vw] text-[clamp(56px,14vw,190px)]")} style={{ opacity: 0, color: palette.accent }}>{edit.signoff}</span>
          {edit.footnote && <span data-k="rise" data-at="0.6" data-len="0.5" className="mt-6 rounded-full bg-black/20 px-4 py-1.5 text-sm font-bold uppercase tracking-[.16em]" style={{ opacity: 0 }}>{edit.footnote}</span>}
        </div>
      </div>, "rays")}
      <canvas className="pointer-events-none absolute inset-0 h-full w-full" />
      <div data-el="flash" className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: 0 }} />
    </div>

    <div data-el="controls" className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 sm:p-5" style={{ opacity: 0 }}>
      <button type="button" onClick={toggleSound} aria-pressed={sound === "blocked" ? undefined : sound === "on"} aria-label={sound === "blocked" ? "Start the sound" : "Sound"}
        className={clsx("inline-flex h-10 items-center gap-2 rounded-full bg-black/25 px-3 text-sm font-semibold text-white ring-1 ring-inset backdrop-blur-sm transition-[background-color,transform] duration-150 hover:bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.97]", sound === "blocked" ? "ring-white/80" : "ring-white/25")}>
        {sound === "off" ? <VolumeX size={18} /> : <Volume2 size={18} />}
        <span className="hidden sm:inline">{sound === "off" ? "Sound off" : sound === "blocked" ? "Tap for sound" : "Sound on"}</span>
      </button>
      <div className="flex items-start gap-2">
        <div className="relative">
          <button type="button" onClick={() => setMenu((open) => !open)} aria-expanded={menu} aria-haspopup="true" className="inline-flex h-10 items-center gap-2 rounded-full bg-black/25 px-3 text-sm font-semibold text-white ring-1 ring-inset ring-white/25 backdrop-blur-sm transition-[background-color,transform] duration-150 hover:bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.97]"><Pause size={16} /><span className="hidden sm:inline">Pause celebrations</span><span className="sr-only sm:hidden">Pause celebrations</span></button>
          {menu && <div className="vso-enter-popover absolute right-0 top-12 w-48 rounded-2xl bg-white p-1.5 text-neutral-800 shadow-[0_18px_50px_rgba(0,0,0,.3)]">
            <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[.12em] text-neutral-400">No celebrations for</p>
            {([[1, "An hour"], [3, "3 hours"], [24, "A day"]] as const).map(([hours, label]) => <button key={hours} type="button" onClick={() => pauseFor(hours)} className="flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition-colors duration-150 hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none">{label}</button>)}
          </div>}
        </div>
        <button ref={skipButton} type="button" onClick={() => leave.current()} className="inline-flex h-10 items-center gap-2 rounded-full bg-black/25 px-4 text-sm font-semibold text-white ring-1 ring-inset ring-white/25 backdrop-blur-sm transition-[background-color,transform] duration-150 hover:bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.97]">
          Skip<kbd className="hidden rounded bg-white/15 px-1.5 py-0.5 font-sans text-[11px] font-bold sm:inline">Esc</kbd>
        </button>
      </div>
    </div>
    <div data-el="progress" className="absolute inset-x-0 bottom-0 h-[3px] origin-left bg-white/60" style={{ transform: "scaleX(0)" }} />
  </div>, document.body);
}
