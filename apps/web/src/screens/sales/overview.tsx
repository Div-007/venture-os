"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowRight, CircleAlert, CircleCheck, MessageCircle, Send, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { StatCard } from "@/components/dashboard/stat-card";
import { Badge, Notice, Panel, PanelHead, secondaryClass } from "@/components/studio/primitives";
import { useSalesShell } from "@/components/sales/sales-context";
import { useSalesOverview } from "@/components/sales/overview-context";
import { buildQueue, KIND_META, QueueRow, type QueueKind } from "@/components/sales/overview-queue";
import { OnTheGo } from "@/components/sales/overview-phone";
import { OverviewPipeline } from "@/components/sales/overview-pipeline";
import { CalendarClock, number, Phone, STAGE_GROUPS, waiting, type Tone } from "@/components/sales/sales-ui";

const FIRST_SHOWN = 8;
const BAR: Record<Tone, string> = { neutral: "bg-neutral-400", blue: "bg-primary-400", green: "bg-primary-600", amber: "bg-warning", red: "bg-danger", purple: "bg-primary-500" };

function Skeleton() {
  return <div role="status" aria-label="Loading the overview">
    <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map((index) => <span key={index} className="vso-skeleton h-[118px] rounded-2xl" />)}</div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)]">
      <Panel className="p-5"><span className="vso-skeleton mb-5 block h-4 w-32" />{[0, 1, 2, 3].map((index) => <div key={index} className="mb-4 flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-xl" /><span className="grid flex-1 gap-2"><span className="vso-skeleton h-3 w-3/5" /><span className="vso-skeleton h-2.5 w-2/5" /></span></div>)}</Panel>
      <div className="grid content-start gap-4"><Panel className="p-5"><span className="vso-skeleton h-24 w-full rounded-xl" /></Panel><Panel className="p-5"><span className="vso-skeleton h-40 w-full rounded-xl" /></Panel></div>
    </div>
  </div>;
}

function BarRow({ label, value, max, tone, href, dim = false }: { label: string; value: number; max: number; tone: Tone; href?: string; dim?: boolean }) {
  const content = <>
    <span className={clsx("w-24 shrink-0 text-xs font-semibold", dim ? "text-neutral-400" : "text-neutral-600")}>{label}</span>
    <span aria-hidden="true" className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-100"><span className={clsx("block h-full rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]", BAR[tone], dim && "opacity-50")} style={{ width: `${max > 0 ? Math.max(value > 0 ? 3 : 0, (value / max) * 100) : 0}%` }} /></span>
    <span className={clsx("w-10 shrink-0 text-right text-sm font-bold tabular-nums", dim ? "text-neutral-400" : "text-neutral-800")}>{number(value)}</span>
  </>;
  const row = "flex min-h-8 items-center gap-3 rounded-lg";
  return href ? <Link href={href} className={clsx(row, "-mx-2 px-2 transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600")}>{content}</Link> : <div className={row}>{content}</div>;
}

/** Sales Overview: what needs you now, how the week went, and where the leads sit. Phones get "On the go". */
export function OverviewScreen() {
  const { refresh } = useSalesShell();
  const { overview, loading, error, scope, setScope } = useSalesOverview();
  const [kind, setKind] = useState<QueueKind | "all">("all");
  const [expanded, setExpanded] = useState(false);
  const queue = useMemo(() => overview ? buildQueue(overview) : [], [overview]);

  if (loading) return <Skeleton />;
  if (!overview) return <Panel><EmptyState variant="error" title="Could not load the overview" body={error || "Check your connection and try again."} action={{ label: "Try again", onClick: refresh }} /></Panel>;

  const { counts, week } = overview;
  const kinds = (Object.keys(KIND_META) as QueueKind[]).filter((key) => queue.some((item) => item.kind === key));
  const activeKind = kinds.includes(kind as QueueKind) ? kind : "all";
  const filtered = activeKind === "all" ? queue : queue.filter((item) => item.kind === activeKind);
  const visible = expanded ? filtered : filtered.slice(0, FIRST_SHOWN);
  const oldest = [...overview.replies].sort((a, b) => a.activity.at.localeCompare(b.activity.at))[0];
  const groups = STAGE_GROUPS.map((group) => ({ ...group, count: group.stages.reduce((sum, stage) => sum + (overview.stageCounts[stage] ?? 0), 0) }));
  const funnelMax = Math.max(1, ...groups.filter((group) => group.key !== "closed").map((group) => group.count));
  const weekRows: { label: string; value: number }[] = [{ label: "Contacted", value: week.contacted }, { label: "Replied", value: week.replied }, { label: "Calls booked", value: week.meetings }, { label: "Proposals", value: week.proposals }, { label: "Won", value: week.won }];
  const weekMax = Math.max(1, ...weekRows.map((row) => row.value));

  return <div>
    <Notice tone="error" message={error} className="pb-4" />
    <div className="grid gap-4 md:hidden"><OnTheGo overview={overview} queue={queue} onChanged={refresh} /><OverviewPipeline scope={scope} /></div>
    <div className="hidden md:block">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-neutral-500">{scope === "me" ? "Showing what is yours." : "Showing the whole team."}</p>
        <SlidingTabs fitContent label="Whose work" className="!p-0.5 bg-neutral-100 shadow-none" active={scope} onChange={(key) => setScope(key as "me" | "all")} tabs={[{ key: "me", label: "Mine" }, { key: "all", label: "Everyone" }]} />
      </div>
      <section aria-label="Your day in numbers" className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard icon={MessageCircle} label="Replies waiting" value={counts.replies} note={oldest ? `Oldest waiting ${waiting(oldest.activity.at)}` : "Nobody waiting"} tone="amber" href="/sales/live/inbox" />
        <StatCard icon={Phone} label="Calls due" value={counts.callsDue} note={counts.followUpsDue ? `${counts.followUpsDue} follow-ups due` : "No follow-ups due"} tone="blue" href="/sales/live/calls" />
        <StatCard icon={Send} label="Ready to send" value={counts.readyToSend} note={counts.toReview ? `${counts.toReview} more to review` : "Passed Claude's review"} tone="green" href="/sales/live/review" />
        <StatCard icon={CircleAlert} label="Needs you" value={counts.needsYou} note={counts.wonToHandOver ? `${counts.wonToHandOver} won to hand over` : "Claude wants your call"} tone="red" href="/sales/live/leads?needsYou=true" />
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)]">
        <Panel>
          <PanelHead title="Needs you now" aside={<Badge tone={queue.length ? "amber" : "green"}>{queue.length ? number(queue.length) : "All clear"}</Badge>} />
          {queue.length > 0 && kinds.length > 1 && <div role="group" aria-label="Filter the queue" className="flex flex-wrap gap-1.5 border-b border-neutral-100 px-4 py-3 sm:px-5">
            {(["all", ...kinds] as const).map((key) => {
              const count = key === "all" ? queue.length : queue.filter((item) => item.kind === key).length;
              const active = activeKind === key;
              return <button key={key} type="button" aria-pressed={active} onClick={() => { setKind(key); setExpanded(false); }} className={clsx("inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]", active ? "bg-primary-100 text-primary-800" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200/70")}>{key === "all" ? "Everything" : KIND_META[key].plural}<span className="tnum opacity-70">{count}</span></button>;
            })}
          </div>}
          {queue.length === 0
            ? <EmptyState variant="card" icon={CircleCheck} tone="green" title="You are clear" body={counts.totalLeads > 0 ? "No replies, calls or drafts are waiting on you. Find the next leads, or check the board." : "There are no leads yet. Find some, or import a list."} action={{ label: "Find leads", href: "/sales/live/find", icon: Sparkles }} secondary={counts.totalLeads > 0 ? { label: "Open the board", href: "/sales/live/pipeline" } : undefined} />
            : <>
              <ul className="divide-y divide-neutral-100">{visible.map((item) => <QueueRow key={item.key} item={item} />)}</ul>
              {filtered.length > FIRST_SHOWN && <div className="border-t border-neutral-100 p-3 text-center"><button type="button" onClick={() => setExpanded(!expanded)} className={clsx(secondaryClass, "!min-h-9 !text-xs")}>{expanded ? "Show fewer" : `Show ${filtered.length - FIRST_SHOWN} more`}</button></div>}
            </>}
        </Panel>
        <div className="grid content-start gap-4">
          <OverviewPipeline scope={scope} />
          <Panel>
            <PanelHead title="Last 7 days" aside={<span className="text-xs font-medium text-neutral-400">{scope === "me" ? "Yours" : "Team"}</span>} />
            <div className="grid grid-cols-1 gap-1.5 p-5">{weekRows.map((row, index) => <BarRow key={row.label} label={row.label} value={row.value} max={weekMax} tone={index === 4 ? "green" : "blue"} />)}</div>
          </Panel>
          <Panel>
            <PanelHead title="Where the leads are" aside={<Link href="/sales/live/pipeline" className="text-xs font-semibold text-primary-600">Open board <ArrowRight size={12} className="inline" /></Link>} />
            <div className="grid grid-cols-1 gap-1.5 p-5 pt-4">
              {groups.map((group) => <BarRow key={group.key} label={group.label} value={group.count} max={funnelMax} tone={group.tone} href={`/sales/live/leads?group=${group.key}`} dim={group.key === "closed"} />)}
              <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-neutral-500"><CalendarClock size={13} />{number(counts.openLeads)} open of {number(counts.totalLeads)} leads</p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  </div>;
}

