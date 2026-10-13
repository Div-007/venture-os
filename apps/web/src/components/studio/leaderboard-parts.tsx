"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import clsx from "clsx";
import type { LeaderboardBoard, LeaderboardEntry, LeaderboardPeriod, LeaderboardPerson } from "@venture-studio/contracts";
import { getLeaderboardPerson } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";
import { useExitTransition } from "@/lib/motion";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/studio/primitives";
import { TrendDown, TrendUp, Trophy, X } from "@/components/ui/icons";

export const METALS = ["vso-medal-gold", "vso-medal-silver", "vso-medal-bronze"] as const;
export const ROLE_LABELS: Record<LeaderboardEntry["role"], string> = { admin: "Admin", venture_head: "Venture head", contributor: "Contributor", reviewer: "Reviewer", learner: "Learner" };
export const PERIOD_LABELS: Record<LeaderboardPeriod, string> = { all: "All time", week: "This week", last_week: "Last week", month: "This month", "30d": "Last 30 days" };
/** How far someone moved since the board was last taken (positive is up), or undefined when there is nothing to compare. */
export const movedBy = (entry: LeaderboardEntry) => entry.rank && entry.previousRank !== undefined ? entry.previousRank - entry.rank : undefined;
/** A plain share, like "92%" (or a dash when there is nothing to share). */
export const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "–";
export const ordinal = (rank: number) => `${rank}${rank % 100 >= 11 && rank % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][rank % 10] ?? "th"}`;
export const dateRange = (from: string, to: string) => {
  const format = (value: Date) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(value);
  // `to` is the start of the day after the range (or now); show the last day it covers.
  const end = new Date(new Date(to).getTime() - 1);
  return `${format(new Date(from))} – ${format(end)}`;
};
/** How late, in the plainest unit: "13 min", "5h", "2.5 days". */
export const lateLabel = (minutes: number) => minutes < 60 ? `${Math.max(1, minutes)} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round((minutes / 1440) * 10) / 10} days`;
const hoursLabel = (hours: number) => lateLabel(Math.round(hours * 60));
const GOLD = "text-[#f6cb52]";

/** Up, down, or level this week; "New" for someone ranked now and not at the start of the week. On a dark or green stage. */
export function TrendMark({ entry, className, light = false }: { entry: LeaderboardEntry; className?: string; light?: boolean }) {
  if (!entry.rank) return null;
  const moved = movedBy(entry);
  if (moved === undefined) return <span className={clsx("rounded-md px-1.5 py-0.5 text-[10px] font-bold", light ? "bg-primary-50 text-primary-700" : "bg-white/10 text-white/70", className)}>New<span className="sr-only"> this week</span></span>;
  if (!moved) return <span className={clsx("w-8 text-center text-xs font-bold", light ? "text-neutral-300" : "text-white/30", className)}><span aria-hidden="true">–</span><span className="sr-only">Same rank as at the start of the week</span></span>;
  return <span className={clsx("inline-flex w-8 items-center justify-center gap-0.5 text-xs font-bold tnum", moved > 0 ? (light ? "text-success-text" : "text-[#7ee2a8]") : (light ? "text-danger-text" : "text-[#ff9f8f]"), className)}>{moved > 0 ? <TrendUp aria-hidden="true" size={13} strokeWidth={2.4} /> : <TrendDown aria-hidden="true" size={13} strokeWidth={2.4} />}<span aria-hidden="true">{Math.abs(moved)}</span><span className="sr-only">{moved > 0 ? "Up" : "Down"} {Math.abs(moved)} this week</span></span>;
}

/** A top-three card on the poster: score, how it was earned, the person, and the trophy. The winner's card stands taller. */
function PosterCard({ entry, spot, delay, you, onOpen }: { entry: LeaderboardEntry; spot: 1 | 2 | 3; delay: number; you: boolean; onOpen: () => void }) {
  const place = entry.rank ?? spot;
  const stats: [string, string][] = [[percent(entry.onTime, entry.tasksDue), "On time"], [percent(entry.firstTimeRight, entry.delivered), "First time"], [String(entry.delivered), "Delivered"]];
  return <button type="button" onClick={onOpen} aria-haspopup="dialog" aria-label={`${ordinal(place)} place: ${entry.name}${you ? " (you)" : ""}, score ${entry.score}`} style={{ "--rise-delay": `${delay}ms` } as React.CSSProperties}
    className={clsx("vso-podium-rise group relative flex w-full min-w-0 flex-col overflow-hidden rounded-3xl p-5 text-left shadow-[0_18px_50px_rgba(0,0,0,.35)] transition-transform duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 active:scale-[0.98] sm:p-6",
      METALS[Math.min(place, 3) - 1], spot === 1 ? "min-h-[300px] sm:min-h-[340px] md:-mt-6" : "min-h-[280px] sm:min-h-[300px]")}>
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[11px] font-bold uppercase tracking-[.14em] opacity-70">Score</p><p className="mt-1 text-5xl font-extrabold leading-none tracking-[-.05em] tnum sm:text-6xl">{entry.score}</p></div>
      <span className="shrink-0 rounded-full bg-white/50 p-1 shadow-sm"><ChatAvatar id={entry.userId} name={entry.name} size={place === 1 ? 64 : 54} /></span>
    </div>
    <div className="mt-4 flex gap-4">{stats.map(([value, label]) => <div key={label}><p className="text-sm font-extrabold tnum">{value}</p><p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</p></div>)}</div>
    {(() => { const moved = movedBy(entry); return moved ? <p className="mt-3 inline-flex w-fit items-center gap-1 rounded-full bg-black/10 px-2.5 py-1 text-[11px] font-bold tnum">{moved > 0 ? <TrendUp aria-hidden="true" size={12} strokeWidth={2.4} /> : <TrendDown aria-hidden="true" size={12} strokeWidth={2.4} />}{moved > 0 ? "Up" : "Down"} {Math.abs(moved)} this week</p> : null; })()}
    <Trophy aria-hidden="true" size={150} strokeWidth={1.2} className="pointer-events-none absolute -bottom-6 -right-6 opacity-25 transition-transform duration-300 group-hover:-rotate-6" />
    <span aria-hidden="true" className="pointer-events-none absolute bottom-16 right-6 text-3xl font-extrabold italic tracking-[-.03em] opacity-40">{ordinal(place)}</span>
    <p className="relative mt-auto max-w-[75%] pt-6 text-2xl font-extrabold uppercase leading-[1.05] tracking-[-.02em] [overflow-wrap:anywhere] sm:text-[1.65rem]">{entry.name}{you && <span className="ml-2 align-middle text-xs font-bold normal-case tracking-normal opacity-70">You</span>}</p>
  </button>;
}

/** The top three as cards, in rank order (for keyboards and phones), arranged 2nd, 1st, 3rd on wide screens like a podium. */
export function PosterPodium({ ranked, currentUserId, onOpen }: { ranked: LeaderboardEntry[]; currentUserId: string; onOpen: (entry: LeaderboardEntry) => void }) {
  const top = ranked.slice(0, 3);
  const order = top.length === 3 ? ["md:order-2", "md:order-1", "md:order-3"] : top.length === 2 ? ["md:order-2", "md:order-1"] : [""];
  return <div className={clsx("mx-auto grid gap-4 md:items-end", top.length === 3 ? "max-w-5xl md:grid-cols-3" : top.length === 2 ? "max-w-3xl md:grid-cols-2" : "max-w-sm")}>
    {top.map((entry, index) => <div key={entry.userId} className={order[index]}><PosterCard entry={entry} spot={(index + 1) as 1 | 2 | 3} delay={[0, 120, 220][index]!} you={entry.userId === currentUserId} onOpen={() => onOpen(entry)} /></div>)}
  </div>;
}

/** Everyone after the top three, and those not ranked yet (with how many tasks they still need), on the poster. */
export function PosterRow({ entry, you, minimumTasks, trend = false, onOpen }: { entry: LeaderboardEntry; you: boolean; minimumTasks: number; trend?: boolean; onOpen: () => void }) {
  return <button type="button" aria-haspopup="dialog" onClick={onOpen} className={clsx("vso-weekly-row flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-[background-color,transform] duration-150 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[0.99] sm:gap-4 sm:px-5", you && "ring-1 ring-[#f6cb52]/60")}>
    <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-extrabold", entry.rank ? "vso-medal-silver" : "bg-white/10 text-white/60")}>{entry.rank ? ordinal(entry.rank) : <><span aria-hidden="true">–</span><span className="sr-only">Not ranked yet</span></>}</span>
    <ChatAvatar id={entry.userId} name={entry.name} size={40} />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-base font-bold">{entry.name}{you && <span className={clsx("ml-2 text-xs font-semibold", GOLD)}>You</span>}</span>
      <span className="block truncate text-xs text-white/50">{ROLE_LABELS[entry.role]} · {entry.rank ? `${entry.tasksDue} task${entry.tasksDue === 1 ? "" : "s"}` : `${entry.tasksDue} of ${minimumTasks} tasks to be ranked`}</span>
    </span>
    <span className="hidden items-center gap-7 md:flex">{[[percent(entry.onTime, entry.tasksDue), "On time"], [percent(entry.firstTimeRight, entry.delivered), "First time"], [String(entry.delivered), "Delivered"]].map(([value, label]) => <span key={label} className="w-16 text-center"><span className="block text-sm font-bold tnum">{value}</span><span className="block text-[10px] font-semibold uppercase tracking-wide text-white/50">{label}</span></span>)}</span>
    {trend && <TrendMark entry={entry} className="hidden shrink-0 sm:inline-flex" />}
    <span className="w-14 shrink-0 text-right">{entry.rank ? <><span className="block text-xl font-extrabold tracking-[-.03em] tnum">{entry.score}</span><span className="block text-[10px] font-semibold uppercase tracking-wide text-white/50">Score</span></> : <span title="Scored once they have enough tasks" className="block text-xl font-bold text-white/50"><span aria-hidden="true">–</span><span className="sr-only">No score yet</span></span>}</span>
  </button>;
}

/** The period's most delivered and its top reviewers, on the poster. */
export function PosterHighlights({ board, reviewers = 1 }: { board: LeaderboardBoard; reviewers?: number }) {
  const shown = board.reviewers.slice(0, reviewers);
  if (!board.mostDelivered && !shown.length) return null;
  return <div className="mx-auto grid max-w-5xl gap-2.5 sm:grid-cols-2">
    {board.mostDelivered && <div className="vso-weekly-row flex items-center gap-3 rounded-2xl px-4 py-3"><ChatAvatar id={board.mostDelivered.userId} name={board.mostDelivered.name} size={36} /><p className="min-w-0 text-sm"><span className={clsx("block text-[10px] font-bold uppercase tracking-[.14em]", GOLD)}>Most delivered</span><span className="font-semibold">{board.mostDelivered.name}</span><span className="text-white/60"> · {board.mostDelivered.delivered} task{board.mostDelivered.delivered === 1 ? "" : "s"}</span></p></div>}
    {shown.length > 0 && <div className="vso-weekly-row rounded-2xl px-4 py-3">
      <p className={clsx("text-[10px] font-bold uppercase tracking-[.14em]", GOLD)}>{shown.length > 1 ? "Top reviewers" : "Top reviewer"}</p>
      <ul className="mt-1.5 space-y-1.5">{shown.map((item) => <li key={item.userId} className="flex items-center gap-2.5 text-sm"><ChatAvatar id={item.userId} name={item.name} size={28} /><span className="shrink-0 font-semibold">{item.name}</span><span className="min-w-0 truncate text-white/60">· {item.reviews} review{item.reviews === 1 ? "" : "s"}, usually within {item.medianHours < 1 ? "an hour" : item.medianHours < 48 ? `${Math.round(item.medianHours)}h` : `${Math.round(item.medianHours / 24)} days`}</span></li>)}</ul>
    </div>}
  </div>;
}

/** Team only, or with learners too. */
export function LearnersToggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <div role="group" aria-label="Who's on the board" className="flex rounded-full bg-white/10 p-1 text-xs font-bold">
    {([[false, "Team"], [true, "With learners"]] as const).map(([option, label]) => <button key={label} type="button" aria-pressed={value === option} onClick={() => onChange(option)} className={clsx("min-h-8 rounded-full px-3 transition-colors duration-150", value === option ? "bg-[#f6cb52] text-[#3a2604]" : "text-white/70 hover:text-white")}>{label}</button>)}
  </div>;
}

/** One person's score and the tasks behind it: what each earned and why. */
export function LeaderboardPersonDialog({ entry, period, ventureId, learners, week, minimumTasks, onClose }: { entry: LeaderboardEntry; period: LeaderboardPeriod; ventureId?: string; learners: boolean; week?: string; minimumTasks: number; onClose: () => void }) {
  const [person, setPerson] = useState<LeaderboardPerson | null>(null);
  const [error, setError] = useState("");
  const exit = useExitTransition(onClose, 160);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    getLeaderboardPerson(entry.userId, { period, ventureId, learners, week }).then((data) => { if (active) setPerson(data); }, (cause: unknown) => { if (active) setError(describeError(cause, "Could not load this breakdown.")); });
    return () => { active = false; };
  }, [entry.userId, period, ventureId, learners, week]);
  // Focus starts on Close and returns where it was; Escape closes and Tab stays inside, wherever focus is.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current; if (!root) return;
      if (event.key === "Escape") { event.preventDefault(); exit.close(); return; }
      if (event.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0]!; const last = items[items.length - 1]!;
      const inside = root.contains(document.activeElement) && document.activeElement !== root;
      if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stats: [string, string][] = [
    ["On time", `${entry.onTime} of ${entry.tasksDue}`],
    ["Right first time", entry.delivered ? `${entry.firstTimeRight} of ${entry.delivered}` : "–"],
    ["Late on average", entry.averageMinutesLate === undefined ? "–" : lateLabel(entry.averageMinutesLate)],
    ["Overdue now", String(entry.overdueNow)],
  ];
  const formatTime = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  return createPortal(<div data-state={exit.state} className="vso-backdrop fixed inset-0 z-[60] grid place-items-center bg-[#272736]/45 p-0 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) exit.close(); }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="leaderboard-person-title" className="vso-enter-modal thin-scroll flex max-h-[100dvh] w-full max-w-2xl flex-col overflow-y-auto bg-white shadow-2xl outline-none sm:max-h-[min(90dvh,820px)] sm:rounded-3xl">
      <header className="flex items-start gap-4 border-b border-neutral-100 p-5 sm:p-6">
        <ChatAvatar id={entry.userId} name={entry.name} size={52} />
        <div className="min-w-0 flex-1">
          <h2 id="leaderboard-person-title" className="truncate text-lg font-extrabold tracking-[-.02em] text-neutral-900">{entry.name}</h2>
          <p className="mt-0.5 text-sm text-neutral-500">{entry.rank ? `${ordinal(entry.rank)} place` : `Not ranked yet: ${entry.tasksDue} of ${minimumTasks} tasks`} · {week ? "Standings at the end of the week" : PERIOD_LABELS[period]}</p>
        </div>
        {/* Someone not ranked yet has no score to show: a few tasks don't make one. */}
        <div className="text-right">{entry.rank ? <p className="text-3xl font-extrabold tracking-[-.04em] text-primary-700 tnum">{entry.score}</p> : <p title="Scored once they have enough tasks" className="text-3xl font-bold text-neutral-400"><span aria-hidden="true">–</span><span className="sr-only">No score yet</span></p>}<p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Score</p></div>
        <button ref={closeButton} type="button" onClick={exit.close} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800"><X size={18} /></button>
      </header>
      <div className="grid grid-cols-2 gap-px bg-neutral-100 sm:grid-cols-4">{stats.map(([label, value]) => <div key={label} className="bg-white px-5 py-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p><p className="mt-0.5 text-sm font-bold text-neutral-800 tnum">{value}</p></div>)}</div>
      <div className="flex-1 p-5 sm:p-6">
        <h3 className="text-sm font-bold text-neutral-900">Tasks that counted</h3>
        <p className="mt-1 text-xs leading-5 text-neutral-500">Full credit for on time, less the later it came in, nothing if it wasn&apos;t delivered. Bigger tasks count for more.</p>
        {error ? <EmptyState variant="error" title="Could not load the breakdown" body={error} /> : !person ? <SkeletonRows rows={4} label="Loading the breakdown" /> : <>
          <ul className="mt-4 divide-y divide-neutral-100">{person.tasks.map((task) => {
            const notes = [task.blockedHours ? `${hoursLabel(task.blockedHours)} blocked, added to the due date` : "", task.allowanceHours ? `${hoursLabel(task.allowanceHours)} added: given less time than its estimate` : "", task.firstTimeRight === false ? "Evidence was sent back once" : ""].filter(Boolean);
            return <li key={task.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/tasks/live?task=${encodeURIComponent(task.id)}`} className="text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere] hover:text-primary-700 hover:underline">{task.title}</Link>
                <p className="mt-0.5 text-xs text-neutral-500">Due {formatTime(task.dueAt)}{task.deliveredAt ? ` · handed in ${formatTime(task.deliveredAt)}` : ""}</p>
                {notes.map((note) => <p key={note} className="mt-0.5 text-xs text-neutral-400">{note}</p>)}
              </div>
              <span className={clsx("rounded-md px-2 py-1 text-[11px] font-semibold", task.outcome === "on_time" ? "bg-success-surface text-success-text" : task.outcome === "late" ? "bg-warning-surface text-warning-text" : "bg-danger-surface text-danger-text")}>
                {task.outcome === "on_time" ? "On time" : task.outcome === "late" ? `${lateLabel(task.minutesLate ?? 0)} late · ${Math.round(task.credit * 100)}%` : "Not delivered"}
              </span>
            </li>;
          })}</ul>
          {person.hidden > 0 && <p className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">{person.hidden} more task{person.hidden === 1 ? "" : "s"} counted in ventures or groups you can&apos;t open.</p>}
        </>}
      </div>
    </section>
  </div>, document.body);
}
