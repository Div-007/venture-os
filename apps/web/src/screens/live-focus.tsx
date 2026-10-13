"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Database, Pause, Play, Square, Timer } from "@/components/ui/icons";
import clsx from "clsx";
import { EmptyState } from "@/components/ui/empty-state";
import { FocusDial, formatDuration } from "@/components/studio/focus-dial";
import { toast } from "@/components/ui/toast";
import { completeLiveFocus, getCurrentLiveFocus, listLiveFocusHistory, pauseLiveFocus, resumeLiveFocus, startLiveFocus } from "@/lib/studio-api";
import { ActionLabel, Badge, HeaderActions, Notice, PageFrame, PageTitle, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { publishFocus } from "@/lib/focus-events";

type Focus = Awaited<ReturnType<typeof getCurrentLiveFocus>>;
type History = Awaited<ReturnType<typeof listLiveFocusHistory>>["items"][number];
const RING = 2 * Math.PI * 108;

/** Decision 14B: the ring drains steadily (linear, one step per second) and turns green when the planned time is up. */
function FocusRing({ fraction, done, children }: { fraction: number; done: boolean; children: React.ReactNode }) {
  return <div className="relative mx-auto mt-5 grid h-[248px] w-[248px] place-items-center">
    <svg aria-hidden="true" viewBox="0 0 240 240" className="absolute inset-0 h-full w-full -rotate-90">
      <circle cx="120" cy="120" r="108" fill="none" strokeWidth="8" className="stroke-neutral-100" />
      <circle cx="120" cy="120" r="108" fill="none" strokeWidth="8" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - fraction)} className={clsx("[transition:stroke-dashoffset_1s_linear,stroke_400ms_ease]", done ? "stroke-success" : "stroke-primary-600")} />
    </svg>
    <div className="relative">{children}</div>
  </div>;
}

export function LiveFocusScreen() {
  const [focus, setFocus] = useState<Focus>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [minutes, setMinutes] = useState(25);
  const [freshId, setFreshId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Only a failed load replaces the history list; a failed Start or Pause shows in the notice instead.
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([getCurrentLiveFocus(), listLiveFocusHistory()]).then(([value, page]) => { if (active) { setFocus(value); setHistory(page.items); setCursor(page.nextCursor); setLoading(false); setError(""); setLoadError(""); } }).catch((cause: unknown) => { if (active) { setLoadError(describeError(cause, "Could not load the focus sessions.")); setLoading(false); } }));
    return () => { active = false; };
  }, [revision]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  // Keep the top-bar timer in step with this screen.
  useEffect(() => { if (!loading) publishFocus(focus); }, [focus, loading]);

  async function act(action: () => Promise<Focus>) {
    setBusy(true); setError("");
    try {
      const next = await action();
      if (next?.completedAt) {
        // Paused time isn't focus time.
        const spent = Math.max(1, Math.round((new Date(next.completedAt).getTime() - new Date(next.startedAt).getTime() - (next.pausedMs ?? 0)) / 60000));
        toast({ title: "Focus session saved", body: `${spent} minute${spent === 1 ? "" : "s"} logged to your workspace.` });
        setFreshId(next.id);
      }
      setFocus(next?.completedAt ? null : next); setRevision((value) => value + 1);
    }
    catch (cause) { setError(describeError(cause, "Could not update the focus session. Refresh before retrying.")); }
    finally { setBusy(false); }
  }

  async function moreHistory() {
    if (!cursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveFocusHistory(cursor); setHistory((items) => [...items, ...page.items]); setCursor(page.nextCursor); }
    catch (cause) { setError(describeError(cause, "Could not load more focus sessions.")); }
    finally { setBusy(false); }
  }

  // While paused the clock stands still at the moment of the pause.
  const paused = Boolean(focus?.pausedAt);
  const seconds = focus ? Math.max(0, Math.ceil((new Date(focus.endsAt).getTime() - (focus.pausedAt ? new Date(focus.pausedAt).getTime() : now)) / 1000)) : 0;
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const fraction = focus ? Math.min(1, seconds / Math.max(1, focus.plannedMinutes * 60)) : 1;
  const canStart = !busy && minutes >= 1 && minutes <= 240;
  const start = () => { if (canStart) void act(() => startLiveFocus({ plannedMinutes: minutes })); };
  const retry = () => { setLoading(true); setRevision((value) => value + 1); };
  // One content width for the header, banner, and cards so they line up.
  return <PageFrame><div className="mx-auto max-w-xl"><PageTitle title="Focus session" description="Your active timer stays available after refresh or reconnect." action={<HeaderActions><RefreshButton busy={loading} onClick={retry} /></HeaderActions>} />
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-primary-100 bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Database size={16} className="shrink-0" /><p>Focus time is saved to your workspace. <Link href="/tasks/live" className="font-bold underline">Open tasks</Link>.</p></div>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="pb-4" />
    <Panel className="p-6 text-center sm:p-8">{loading && !focus ? <div role="status" aria-label="Checking for an active session" className="grid justify-items-center gap-3 py-4"><span className="vso-skeleton h-[200px] w-[200px] rounded-full" /><span className="vso-skeleton h-4 w-48" /></div> : focus ? <div key="active" className="vso-fade-enter"><p className={clsx("text-xs font-semibold uppercase tracking-wide", paused ? "text-amber-700" : "text-primary-700")}>{paused ? "Paused" : seconds ? "Active focus session" : "Planned time is up"}</p>
      <FocusRing fraction={fraction} done={!seconds}><p className="font-mono text-[clamp(2.75rem,10vw,3.75rem)] font-extrabold leading-none tracking-tight text-neutral-900 tnum" role="timer" aria-live="off">{clock}</p><p className="mt-2 text-xs font-semibold text-neutral-400">of {focus.plannedMinutes} min</p></FocusRing>
      <p className="mt-4 text-sm leading-6 text-neutral-500">Started {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(focus.startedAt))}{paused ? " · The clock waits until you resume." : seconds === 0 ? " · Complete it when you finish." : ""}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {/* Pause only while time is left; once the planned time is up there is nothing to hold. */}
        {(paused || seconds > 0) && <button type="button" disabled={busy} onClick={() => act(() => paused ? resumeLiveFocus(focus.id) : pauseLiveFocus(focus.id))} className={paused ? primaryClass : secondaryClass}>{paused ? <Play size={14} /> : <Pause size={14} />}<ActionLabel busy={busy} busyText={paused ? "Resuming…" : "Pausing…"} idle={paused ? "Resume" : "Pause"} /></button>}
        <button type="button" disabled={busy} onClick={() => act(() => completeLiveFocus(focus.id))} className={paused ? secondaryClass : primaryClass}><Square size={14} /><ActionLabel busy={busy} busyText="Saving…" idle="Complete session" /></button>
      </div></div>
      : <div key="ready" className="vso-fade-enter"><p className="text-xs font-semibold uppercase tracking-wide text-primary-700">Ready to focus</p><h2 className="mt-2 text-xl font-bold text-neutral-900">Start a focused work block</h2><p className="mt-2 text-sm leading-6 text-neutral-500">Your start and end times are saved. Refreshing this page will not reset the session.</p>
        <div className="mt-6"><FocusDial value={minutes} onChange={setMinutes} now={now} disabled={busy} /></div>
        <p className="mt-3 text-xs text-neutral-500">Outer ring: minutes. Inner ring: hours. Arrow keys work too.</p>
        <button type="button" disabled={!canStart} onClick={start} className={clsx(primaryClass, "mt-5")}><Play size={15} /><ActionLabel busy={busy} busyText="Starting…" idle={minutes > 0 ? `Start ${formatDuration(minutes)} session` : "Pick a duration"} /></button></div>}</Panel>
    <Panel className="mt-4"><PanelHead title="Completed sessions" aside={<Badge tone="blue">{history.length}{cursor ? "+" : ""}</Badge>} /><div className="divide-y divide-neutral-100">{loading && !history.length ? <SkeletonRows rows={2} label="Loading completed sessions" /> : history.length ? history.map((item) => <article key={item.id} className={clsx("flex items-center justify-between gap-3 p-4", item.id === freshId && "vso-row-enter")}><div><p className="text-sm font-semibold text-neutral-800">{item.plannedMinutes} minute focus block</p><p className="mt-1 text-xs text-neutral-500">Started {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.startedAt))}</p></div><Badge tone="green">Completed</Badge></article>) : loadError ? <EmptyState variant="error" title="Couldn't load your sessions" body={loadError} action={{ label: "Try again", onClick: retry }} /> : <EmptyState variant="card" icon={Timer} tone="amber" title="No focus sessions yet" body="Finished focus blocks and their minutes are listed here." />}</div>{cursor && <div className="p-4 text-center"><button type="button" disabled={busy} onClick={moreHistory} className={secondaryClass}>Load more sessions</button></div>}</Panel>
  </div></PageFrame>;
}
