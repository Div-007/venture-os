"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Leaderboard, LeaderboardEntry } from "@venture-studio/contracts";
import { getLeaderboard, getWeeklyLeaderboardStatus } from "@/lib/studio-api";
import { useStudio } from "@/lib/studio-store";
import { describeError } from "@/lib/errors";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { ChevronDown, Crown, Play, RefreshCw, Trophy } from "@/components/ui/icons";
import { SkeletonRows } from "@/components/studio/primitives";
import { DitherBackground } from "@/components/ui/dither-background";
import { LeaderboardFilm } from "@/components/studio/leaderboard-film";
import { lateLabel, LeaderboardPersonDialog, ordinal, percent, ROLE_LABELS, TrendMark } from "@/components/studio/leaderboard-parts";

/** One spot on the podium: the person above a frosted step; 2nd, 1st, and 3rd stand side by side, the winner tallest. */
function Spot({ entry, spot, you, onOpen }: { entry: LeaderboardEntry; spot: 1 | 2 | 3; you: boolean; onOpen: () => void }) {
  const place = entry.rank ?? spot;
  return <button type="button" onClick={onOpen} aria-haspopup="dialog" aria-label={`${ordinal(place)} place: ${entry.name}${you ? " (you)" : ""}, score ${entry.score}`}
    style={{ "--rise-delay": `${spot === 1 ? 0 : spot === 2 ? 90 : 170}ms` } as React.CSSProperties}
    className={clsx("vso-podium-rise group flex min-w-0 flex-1 flex-col items-center rounded-2xl text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80", spot === 1 ? "order-2" : spot === 2 ? "order-1" : "order-3")}>
    <span className="relative">
      {place === 1 && <Crown aria-hidden="true" size={26} className="absolute -top-8 left-1/2 -translate-x-1/2 text-[#ffe08a] drop-shadow" />}
      <span className={clsx("block rounded-full p-1 shadow-[0_10px_30px_rgba(0,0,0,.18)] transition-transform duration-200 group-hover:-translate-y-0.5", place === 1 ? "bg-[#ffe08a]" : "bg-white/70")}><ChatAvatar id={entry.userId} name={entry.name} size={spot === 1 ? 84 : 64} /></span>
    </span>
    <span className="mt-2.5 max-w-full truncate px-1 text-sm font-bold sm:text-base">{entry.name}{you && <span className="font-semibold text-white/80"> (you)</span>}</span>
    <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-1.5 text-sm font-extrabold text-primary-800 shadow-[0_6px_18px_rgba(0,0,0,.12)] tnum"><Trophy aria-hidden="true" size={14} />{entry.score}</span>
    <span aria-hidden="true" className={clsx("vso-board-step mt-4 flex w-full justify-center rounded-t-2xl pt-3 text-5xl font-black text-white/90 [text-shadow:0_2px_12px_rgba(0,0,0,.12)] sm:text-6xl", spot === 1 ? "h-40 sm:h-48" : spot === 2 ? "h-32 sm:h-36" : "h-24 sm:h-28")}>{place}</span>
  </button>;
}

/** The everyday leaderboard: everyone's lifetime standing, full screen, with each person's move this week. */
export function LiveLeaderboardScreen() {
  const { activeVentureId: ventureId, currentUserId, data } = useStudio();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const learners = params.get("learners") === "true";
  const setLearners = (value: boolean) => {
    const next = new URLSearchParams(params);
    if (value) next.set("learners", "true"); else next.delete("learners");
    const search = next.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  };
  // The board follows the venture switcher; say which venture it's showing.
  const scope = ventureId ? data.ventures.find((venture) => venture.id === ventureId)?.name ?? "This venture" : "All ventures";
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [weekly, setWeekly] = useState(false);
  const [selected, setSelected] = useState<LeaderboardEntry | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  // The opening film plays each time the page opens (and on Replay); the board comes in underneath as it dissolves.
  const [film, setFilm] = useState<"playing" | "revealed" | "done">("playing");
  const [take, setTake] = useState(0);
  const replayButton = useRef<HTMLButtonElement>(null);
  // After a replay, keyboard focus goes back to Replay (it was hidden with the board while the film played).
  useEffect(() => { if (film === "done" && take > 0) replayButton.current?.focus({ preventScroll: true }); }, [film, take]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      getLeaderboard({ period: "all", ventureId: ventureId || undefined, learners }).then((result) => { if (active) { setBoard(result); setError(""); setBusy(false); } }, (cause: unknown) => { if (active) { setError(describeError(cause, "Could not load the leaderboard.")); setBusy(false); } });
    });
    return () => { active = false; };
  }, [ventureId, learners, revision]);
  useEffect(() => { getWeeklyLeaderboardStatus().then((status) => setWeekly(status.ranked > 0), () => setWeekly(false)); }, []);

  const ranked = board?.people.filter((entry) => entry.rank) ?? [];
  const waiting = board?.people.filter((entry) => !entry.rank) ?? [];
  const minimum = board?.minimumTasks ?? 2;
  const here = `${pathname}${params.toString() ? `?${params}` : ""}`;
  const chip = (active: boolean) => clsx("min-h-9 rounded-full px-4 text-sm font-bold transition-[background-color,color,transform] duration-150 active:scale-[0.97]", active ? "bg-white text-primary-800 shadow-sm" : "text-white ring-1 ring-inset ring-white/60 hover:bg-white/10");

  const row = (entry: LeaderboardEntry) => {
    const you = entry.userId === currentUserId;
    return <li key={entry.userId}><button type="button" aria-haspopup="dialog" onClick={() => setSelected(entry)} className={clsx("group flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 sm:gap-4 sm:px-4", you && "bg-primary-50")}>
      <span className="w-7 shrink-0 text-center text-sm font-bold text-neutral-400 tnum">{entry.rank ?? <><span aria-hidden="true">–</span><span className="sr-only">Not ranked yet</span></>}</span>
      <ChatAvatar id={entry.userId} name={entry.name} size={44} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-extrabold tracking-[-.01em] text-neutral-900 tnum">{entry.rank ? <>{entry.score} <span className="text-xs font-semibold text-neutral-400">score</span></> : <span className="text-sm font-bold text-neutral-500">{entry.tasksDue} of {minimum} tasks to be ranked</span>}</span>
        <span className="block truncate text-sm font-medium text-primary-700">{entry.name}{you && <span className="ml-1.5 rounded-md bg-primary-100 px-1.5 py-0.5 text-[10px] font-bold text-primary-800">You</span>}<span className="font-normal text-neutral-400"> · {ROLE_LABELS[entry.role]}</span></span>
      </span>
      <span className="hidden shrink-0 items-center gap-6 md:flex">{[[percent(entry.onTime, entry.tasksDue), "On time"], [percent(entry.firstTimeRight, entry.delivered), "First time"], [String(entry.delivered), "Delivered"]].map(([value, label]) => <span key={label} className="w-16 text-center"><span className="block text-sm font-bold text-neutral-800 tnum">{value}</span><span className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{label}</span></span>)}</span>
      <TrendMark entry={entry} light className="shrink-0" />
    </button></li>;
  };

  // Full bleed: the green stage fills the whole content area beside the sidebar, with a slowly moving dither behind it.
  return <>
    <section aria-busy={busy || undefined} data-vso-stagger-group className="vso-fullbleed vso-board relative isolate flex flex-col overflow-hidden">
      <DitherBackground color={[255, 255, 255, 30]} density={0.6} className="absolute inset-0 -z-10 h-full w-full" />
      {/* Quiet shapes behind the stage, like the reference. */}
      <span aria-hidden="true" className="pointer-events-none absolute -left-24 top-24 -z-10 h-72 w-72 rounded-full border-2 border-white/20" />
      <span aria-hidden="true" className="pointer-events-none absolute -right-20 top-10 -z-10 h-56 w-56 rotate-12 rounded-[48px] bg-white/10" />
      <span aria-hidden="true" className="pointer-events-none absolute -right-28 top-64 -z-10 h-80 w-80 rounded-full border-2 border-white/15" />

      {film !== "playing" && <div className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-6 sm:px-8 sm:pt-8">
        <div className="min-w-0">
          <h1 className="text-3xl font-extrabold tracking-[-.03em] sm:text-4xl">Leaderboard</h1>
          <p className="mt-1 text-sm font-semibold text-white/80">All time · {scope} · arrows show this week&apos;s moves</p>
        </div>
        <div className="flex items-center gap-2">
          <button ref={replayButton} type="button" onClick={() => { setTake((value) => value + 1); setFilm("playing"); }} aria-label="Replay the opening" title="Replay the opening" className="grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white transition-[background-color,transform] duration-150 hover:bg-white/25 active:scale-[0.95] motion-reduce:hidden"><Play size={16} /></button>
          <span className="text-sm font-semibold text-white/80">Score</span>
          <button type="button" onClick={() => setRevision((value) => value + 1)} aria-label="Refresh the leaderboard" className="grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white transition-[background-color,transform] duration-150 hover:bg-white/25 active:scale-[0.95]"><RefreshCw size={16} className={clsx(busy && board && "vso-spin")} /></button>
        </div>
      </header>
      <div role="group" aria-label="Who's on the board" className="mt-4 flex flex-wrap gap-2 px-5 sm:px-8">
        <button type="button" aria-pressed={!learners} onClick={() => setLearners(false)} className={chip(!learners)}>Team</button>
        <button type="button" aria-pressed={learners} onClick={() => setLearners(true)} className={chip(learners)}>With learners</button>
      </div>

      {!board ? (error
        ? <div className="mx-auto my-16 max-w-md px-5 text-center"><p className="text-lg font-bold">Could not load the leaderboard</p><p className="mt-2 text-sm leading-6 text-white/80">{error}</p><button type="button" onClick={() => setRevision((value) => value + 1)} className="mt-4 inline-flex min-h-10 items-center rounded-xl bg-white px-4 text-sm font-bold text-primary-800 transition-transform duration-150 active:scale-[0.97]">Try again</button></div>
        : <div className="mx-auto my-10 w-full max-w-2xl px-5"><div className="rounded-2xl bg-white/15 p-4"><SkeletonRows rows={4} label="Loading the leaderboard" /></div></div>)
      : <>
        {error && <p role="alert" className="mx-5 mt-4 rounded-xl bg-white/15 px-4 py-2 text-sm sm:mx-8">{error}</p>}
        {ranked.length ? <div key={`${learners}-${ventureId}`} className="mx-auto mt-12 flex w-full max-w-2xl items-end gap-2 px-4 sm:mt-14 sm:gap-4 sm:px-6">
          {ranked.slice(0, 3).map((entry, index) => <Spot key={entry.userId} entry={entry} spot={(index + 1) as 1 | 2 | 3} you={entry.userId === currentUserId} onOpen={() => setSelected(entry)} />)}
        </div>
        : <div className="mx-auto my-14 max-w-md px-5 text-center"><Trophy aria-hidden="true" size={40} className="mx-auto text-white/80" /><p className="mt-3 text-lg font-bold">No one ranked yet</p><p className="mt-2 text-sm leading-6 text-white/80">People are ranked once they have {minimum} tasks handed in or due. Finished work counts as soon as it&apos;s handed in.</p></div>}

        {/* The sheet: everyone else, those not ranked yet, and the extras. */}
        <div className={clsx("flex-1 rounded-t-[28px] bg-white px-3 pb-6 pt-4 text-neutral-900 shadow-[0_-12px_40px_rgba(0,0,0,.12)] transition-opacity duration-200 sm:px-6", busy && "opacity-70", !ranked.length && "mt-4")}>
          {ranked.length > 3 && <ol className="vso-stagger-in divide-y divide-neutral-100">{ranked.slice(3).map(row)}</ol>}
          {waiting.length > 0 && <div className={clsx(ranked.length > 3 && "mt-4")}>
            <h2 className="px-3 pb-1 text-[11px] font-bold uppercase tracking-[.12em] text-neutral-400 sm:px-4">Not ranked yet <span className="font-semibold normal-case tracking-normal">· fewer than {minimum} tasks</span></h2>
            <ul className="divide-y divide-neutral-100">{waiting.map(row)}</ul>
          </div>}
          {ranked.length > 0 && ranked.length <= 3 && !waiting.length && <p className="px-4 py-3 text-sm text-neutral-500">Everyone with tasks is on the podium.</p>}

          {(board.mostDelivered || board.reviewers.length > 0) && <div className="mt-5 grid gap-3 px-1 sm:grid-cols-2 sm:px-2">
            {board.mostDelivered && <div className="flex items-center gap-3 rounded-2xl bg-neutral-50 px-4 py-3"><ChatAvatar id={board.mostDelivered.userId} name={board.mostDelivered.name} size={40} /><p className="min-w-0 text-sm"><span className="block text-[10px] font-bold uppercase tracking-[.12em] text-primary-700">Most delivered</span><span className="font-semibold text-neutral-800">{board.mostDelivered.name}</span><span className="text-neutral-500"> · {board.mostDelivered.delivered} task{board.mostDelivered.delivered === 1 ? "" : "s"}</span></p></div>}
            {board.reviewers.length > 0 && <div className="rounded-2xl bg-neutral-50 px-4 py-3"><p className="text-[10px] font-bold uppercase tracking-[.12em] text-primary-700">Top reviewers</p><ul className="mt-1.5 space-y-1.5">{board.reviewers.map((item) => <li key={item.userId} className="flex items-center gap-2.5 text-sm"><ChatAvatar id={item.userId} name={item.name} size={28} /><span className="shrink-0 font-semibold text-neutral-800">{item.name}</span><span className="min-w-0 truncate text-neutral-500">· {item.reviews} review{item.reviews === 1 ? "" : "s"}, usually within {item.medianHours < 1 ? "an hour" : lateLabel(Math.round(item.medianHours * 60))}</span></li>)}</ul></div>}
          </div>}

          <details className="group mt-3 rounded-2xl bg-neutral-50 px-4 py-3 sm:mx-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold text-neutral-800 [&::-webkit-details-marker]:hidden">How scores work<ChevronDown size={16} className="text-neutral-400 transition-transform duration-200 group-open:rotate-180" /></summary>
            <ul className="mt-3 grid gap-3 text-xs leading-5 text-neutral-600 sm:grid-cols-2">
              <li><strong className="text-neutral-800">Every task counts.</strong> The board covers all the work to date. A task counts once it&apos;s handed in (finishing early counts straight away) or once it&apos;s due.</li>
              <li><strong className="text-neutral-800">70% on time.</strong> Full credit on time, less the later it comes in, and nothing if it isn&apos;t delivered. Bigger tasks count for more.</li>
              <li><strong className="text-neutral-800">30% right first time.</strong> Evidence accepted without being sent back.</li>
              <li><strong className="text-neutral-800">Fair whatever the workload.</strong> Everyone&apos;s rates are evened out toward the team&apos;s, so a handful of tasks can&apos;t decide a rank. You&apos;re ranked from {minimum} tasks.</li>
              <li className="sm:col-span-2"><strong className="text-neutral-800">Not your fault, not counted.</strong> The clock stops when evidence is sent, not when it&apos;s reviewed. Too-short deadlines, and time blocked before a task was late (up to a week), move the due date back. Cancelled and parked tasks don&apos;t count.</li>
            </ul>
          </details>
          {weekly && <div className="mt-4 flex justify-center"><Link href={`/leaderboard/weekly/live?next=${encodeURIComponent(here)}`} className="inline-flex min-h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50"><Trophy size={16} />This week&apos;s top performers</Link></div>}
        </div>
      </>}
      </div>}
    </section>
    {film !== "done" && <LeaderboardFilm key={take} theme="board" title="Leaderboard" subtitle={`All time · ${scope}`} people={board?.people ?? null} failed={Boolean(error) && !board} minimumTasks={minimum} currentUserId={currentUserId}
      onReveal={() => setFilm((state) => (state === "playing" ? "revealed" : state))} onDone={() => setFilm("done")} />}
    {selected && board && <LeaderboardPersonDialog key={selected.userId} entry={selected} period="all" ventureId={ventureId || undefined} learners={learners} minimumTasks={minimum} onClose={() => setSelected(null)} />}
  </>;
}
