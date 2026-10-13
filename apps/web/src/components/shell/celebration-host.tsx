"use client";

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CelebrationFeed } from "@venture-studio/contracts";
import { CelebrationFilm } from "@/components/studio/celebration-film";
import { toast } from "@/components/ui/toast";
import { celebrationFacts, recentCelebrationWords, rememberCelebrationWords, writeCelebration } from "@/lib/celebration-lines";
import { prefersReducedMotion } from "@/lib/motion";
import { getCelebrations, markCelebrationsSeen, pauseCelebrations } from "@/lib/studio-api";
import { useStudio } from "@/lib/studio-store";
import { celebrationNudgeEvent } from "@/lib/use-live-realtime";
import { filmEndedEvent } from "@/components/studio/leaderboard-film";

const FIRST_LOOK_MS = 1500;
const POLL_MS = 3 * 60_000;
const WATCHDOG_MS = 45_000; // a film that somehow never ends is taken down
const PAUSE_LABELS = { 1: "an hour", 3: "3 hours", 24: "a day" } as const;
const editable = (target: EventTarget | Element | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
/** Something written in the focused box and not yet sent. */
const unsent = (target: Element | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value.trim().length > 0 : target instanceof HTMLElement && target.isContentEditable && (target.textContent ?? "").trim().length > 0;

/** A film that fails to render is skipped, not allowed to take the app down. */
class FilmBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Plays a celebration on whatever page the person is on when one of their tasks is approved or done: at once when the
 * server nudges this tab, and otherwise when the app opens, comes back into view, or every few minutes. It waits for a
 * clear moment (the tab in view, no other film playing or Saturday's on its way, nothing half-written in the box in
 * focus) and plays one film for everything waiting, checking again just before, since another tab may have played it.
 */
export function CelebrationHost() {
  const { currentUserId } = useStudio();
  const [feed, setFeed] = useState<CelebrationFeed | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const typedAt = useRef(0);
  // Never the same one twice in this tab, even if telling the server it was seen fails.
  const played = useRef(new Set<string>());

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    let playing = false;
    try {
      const waiting = (await getCelebrations()).items.filter((item) => !played.current.has(item.id));
      if (!waiting.length) return;
      for (let waited = 0; ; waited++) {
        if (!alive.current) return;
        const active = document.activeElement;
        const typing = editable(active) && (Date.now() - typedAt.current < 4000 || unsent(active));
        const { vsoFilm, vsoWeekly } = document.documentElement.dataset;
        if (document.visibilityState === "visible" && !vsoFilm && !vsoWeekly && !typing) break;
        if (waited > 600) return; // ten minutes: the next look tries again
        await wait(1000);
      }
      // What's waiting now: another tab may have played it meanwhile, or celebrations been paused.
      const latest = await getCelebrations();
      const next = { ...latest, items: latest.items.filter((item) => !played.current.has(item.id)) };
      if (!next.items.length || !alive.current) return;
      for (const item of next.items) played.current.add(item.id);
      if (prefersReducedMotion()) {
        // Without the film: the same words, quietly, in a notice.
        const words = writeCelebration(celebrationFacts(next, new Date()), Math.random, recentCelebrationWords());
        rememberCelebrationWords(words.used);
        const lead = next.items[next.items.length - 1]!;
        toast({ tone: "success", title: next.items.length > 1 ? `${next.items.length} tasks finished` : `${lead.trigger === "approved" ? "Approved" : "Done"}: ${lead.title}`, body: words.line, duration: 8000 });
        await markCelebrationsSeen(next.items.map((item) => item.id)).catch(() => undefined);
        return;
      }
      playing = true;
      setFeed(next);
    } catch { /* A celebration is a nicety: the next look tries again. */ }
    finally { if (!playing) busy.current = false; }
  }, []);

  useEffect(() => {
    alive.current = true;
    const onKey = (event: KeyboardEvent) => { if (editable(event.target)) typedAt.current = Date.now(); };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    const onNudge = () => { void check(); };
    // A leaderboard film just finished: anything that waited for it can play now.
    const onFilmEnded = () => { window.setTimeout(() => void check(), 800); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(celebrationNudgeEvent, onNudge);
    window.addEventListener(filmEndedEvent, onFilmEnded);
    const first = window.setTimeout(onNudge, FIRST_LOOK_MS);
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void check(); }, POLL_MS);
    return () => {
      alive.current = false;
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(celebrationNudgeEvent, onNudge);
      window.removeEventListener(filmEndedEvent, onFilmEnded);
      window.clearTimeout(first); window.clearInterval(poll);
    };
  }, [check]);

  const done = () => { setFeed(null); busy.current = false; window.setTimeout(() => void check(), 1500); };
  if (!feed) return null;
  return <FilmBoundary key={feed.items.map((item) => item.id).join(",")} onError={done}><Watchdog onExpire={done} /><CelebrationFilm feed={feed} userId={currentUserId}
    // Seen once it's on screen, so it isn't shown again (here or on another device).
    onShown={() => { void markCelebrationsSeen(feed.items.map((item) => item.id)).catch(() => undefined); }}
    onDone={done}
    onPause={(hours) => {
      pauseCelebrations(hours).then(() => {
        toast({ tone: "info", title: `Celebrations paused for ${PAUSE_LABELS[hours]}`, body: "Tasks you finish meanwhile won't play one.", duration: 6000, action: { label: "Undo", onClick: () => { void pauseCelebrations(0).catch(() => toast({ tone: "error", title: "Could not turn celebrations back on" })); } } });
      }, () => toast({ tone: "error", title: "Could not pause celebrations", body: "Try again from the next one." }));
    }} /></FilmBoundary>;
}

/** Ends a film that somehow never does (it's about ten seconds). */
function Watchdog({ onExpire }: { onExpire: () => void }) {
  const expire = useRef(onExpire);
  useEffect(() => { expire.current = onExpire; });
  useEffect(() => { const timer = window.setTimeout(() => expire.current(), WATCHDOG_MS); return () => window.clearTimeout(timer); }, []);
  return null;
}
