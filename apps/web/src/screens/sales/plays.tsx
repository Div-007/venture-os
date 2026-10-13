"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import type { Play } from "@venture-studio/contracts";
import { ChevronRight, Plus, Target } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, HeaderActions, HeaderLabel, Panel, primaryClass } from "@/components/studio/primitives";
import { listPlays } from "@/lib/sales-api";
import { ChannelTile, isLearner, Segmented, useQueryParam, useSalesLoad } from "@/components/sales/draft-shared";
import { PlayDetail, PLAY_STATUS } from "@/components/sales/play-detail";
import { PopCard } from "@/components/sales/pop-card";
import { MOTION_LABEL, PlayForm } from "@/components/sales/play-form";
import { useSalesShell } from "@/components/sales/sales-context";

const isActive = (play: Play) => play.status !== "done";

/** Plays: campaigns with a hypothesis, a few steps and a stop rule. A venture head approves each one. */
export function PlaysScreen() {
  const { session, ventureId, ventureName } = useSalesShell();
  const [filter, setFilter] = useState<"active" | "done">("active");
  const [selectedId, setSelectedId] = useQueryParam("play");
  const [form, setForm] = useState<"new" | "edit" | null>(null);
  const plays = useSalesLoad(`plays|${ventureId}`, () => listPlays(ventureId ? { ventureId } : {}));
  const loaded = plays.data !== null;
  const writer = !isLearner(session);

  const all = useMemo(() => [...(plays.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [plays.data]);
  const shown = all.filter((play) => filter === "active" ? isActive(play) : !isActive(play));
  const selected = all.find((play) => play.id === selectedId);

  function changed(updated: Play) { plays.mutate((list) => list.map((play) => play.id === updated.id ? updated : play)); }
  function saved(play: Play) { plays.mutate((list) => list.some((item) => item.id === play.id) ? list.map((item) => item.id === play.id ? play : item) : [play, ...list]); setSelectedId(play.id, { replace: true }); }

  const toolbar = <div className="mb-4 flex flex-wrap items-center gap-2">
    <Segmented label="Which plays" value={filter} onChange={setFilter} options={[{ value: "active", label: loaded ? `Active · ${all.filter(isActive).length}` : "Active" }, { value: "done", label: loaded ? `Done · ${all.filter((play) => !isActive(play)).length}` : "Done" }]} />
    <HeaderActions className="ml-auto">
      {writer && <button type="button" onClick={() => setForm("new")} className={primaryClass}><Plus size={15} /><HeaderLabel>New play</HeaderLabel></button>}
    </HeaderActions>
  </div>;

  let body: React.ReactNode;
  if (plays.error && !loaded) body = <Panel><EmptyState variant="error" title="Could not load the plays" body={plays.error} action={{ label: plays.busy ? "Trying again…" : "Try again", onClick: plays.reload, disabled: plays.busy }} /></Panel>;
  else if (!loaded) body = <div role="status" aria-label="Loading plays" className="space-y-3">{[0, 1, 2].map((index) => <Panel key={index} className="space-y-3 p-5"><span className="vso-skeleton block h-4 w-1/3" /><span className="vso-skeleton block h-3 w-2/3" /><span className="vso-skeleton block h-3 w-1/2" /></Panel>)}</div>;
  else if (all.length === 0) body = <Panel><EmptyState variant="card" tone="amber" icon={Target} title="No plays yet" body="A play is a short campaign: who you are reaching, the few steps, and when to stop. Ask Claude to plan one from the venture's offer, or start one yourself." action={writer ? { label: "New play", icon: Plus, onClick: () => setForm("new") } : undefined} /></Panel>;
  else if (shown.length === 0) body = <Panel><EmptyState variant="filtered" title={filter === "active" ? "No active plays" : "No finished plays"} body={filter === "active" ? "Everything is done. Start a new play to keep going." : "Plays you mark as done show up here."} action={{ label: filter === "active" ? "Show done plays" : "Show active plays", onClick: () => setFilter(filter === "active" ? "done" : "active") }} /></Panel>;
  else body = <ul className="space-y-3">{shown.map((play) => {
    const status = PLAY_STATUS[play.status];
    const stats = play.stats;
    return <li key={play.id}><PopCard className="rounded-2xl"><button type="button" onClick={() => setSelectedId(play.id)} className="group block w-full rounded-2xl border border-neutral-100 bg-white p-4 text-left shadow-card transition-[border-color] duration-150 hover:border-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-extrabold tracking-[-.01em] text-neutral-900 [overflow-wrap:anywhere]">{play.name}</h2><Badge tone={status.tone}>{status.label}</Badge></div>
          <p className="mt-1 text-xs text-neutral-500">{[!ventureId ? ventureName(play.ventureId) : "", MOTION_LABEL[play.motion], `batch of ${play.batchSize}`, play.offerName].filter(Boolean).join(" · ")}</p>
          {play.audience && <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-neutral-600">{play.audience}</p>}
        </div>
        <ChevronRight size={18} className="mt-1 hidden shrink-0 text-neutral-300 transition-transform duration-150 group-hover:translate-x-0.5 sm:block" aria-hidden="true" />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <span className="flex items-center gap-1.5" aria-label={play.steps.length ? `${play.steps.length} steps` : "No steps yet"}>{play.steps.length ? play.steps.map((step, index) => <ChannelTile key={index} channel={step.channel} size={24} />) : <span className="text-xs text-neutral-400">No steps yet</span>}</span>
        {stats ? <dl className="flex flex-wrap gap-x-5 gap-y-1">{([["leads", stats.leads], ["contacted", stats.contacted], ["replied", stats.replied], ["meetings", stats.meetings], ["won", stats.won]] as const).map(([label, value]) => <div key={label} className="flex items-baseline gap-1"><dd className={clsx("tnum text-sm font-extrabold", value ? "text-neutral-900" : "text-neutral-300")}>{value}</dd><dt className="text-[11px] font-medium text-neutral-500">{label}</dt></div>)}</dl>
          : <span className="text-xs text-neutral-400">No numbers yet</span>}
      </div>
    </button></PopCard></li>;
  })}</ul>;

  return <>
    {toolbar}
    {body}
    {selected && form !== "edit" && <PlayDetail key={selected.id} play={selected} onClose={() => setSelectedId("", { replace: true })} onEdit={() => setForm("edit")} onChanged={changed} />}
    {form === "new" && <PlayForm onClose={() => setForm(null)} onSaved={saved} />}
    {form === "edit" && selected && <PlayForm play={selected} onClose={() => setForm(null)} onSaved={saved} />}
  </>;
}
