"use client";
import { useState } from "react";
import clsx from "clsx";
import { Play, RotateCcw, X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { cancelFindRun, queueFindRun, type FindRun } from "@/lib/sales-api";
import { canHead, stamp } from "./draft-shared";
import { since, STALE_HEARTBEAT_MS } from "./find-engine";
import { useOffersById } from "./offer-model";
import { useSalesShell } from "./sales-context";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
export const RUN_STATUS: Record<FindRun["status"], { label: string; tone: Tone }> = {
  planned: { label: "Plan saved", tone: "neutral" }, queued: { label: "Waiting for the lead finder", tone: "amber" }, running: { label: "Running", tone: "blue" },
  done: { label: "Done", tone: "green" }, failed: { label: "Failed", tone: "red" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
export const isLiveRun = (run: FindRun) => run.status === "queued" || run.status === "running";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const RESULT_LABELS = { find: ["Found", "Added", "Skipped"], enrich: ["Looked at", "Filled in", "Skipped"] } as const;

/** Past and current runs, newest first: a search for new leads (Find) or a fill-in of contact details (Fill contacts). */
export function FindRunList({ runs, now, canEdit, onReuse, onChanged }: { runs: FindRun[]; now: number; canEdit: boolean; onReuse: (run: FindRun) => void; onChanged: (run: FindRun) => void }) {
  const { session, ventureId, ventureName, personName, refresh, refreshKey } = useSalesShell();
  const offers = useOffersById(runs.map((run) => run.ventureId), refreshKey);
  const [confirming, setConfirming] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function cancel(run: FindRun) {
    setBusyId(run.id); setError("");
    try { const updated = await cancelFindRun(run.id); onChanged(updated); refresh(); setConfirming(""); toast({ title: "Run cancelled", body: run.request.slice(0, 80) }); }
    catch (cause) { setError(describeError(cause, "Could not cancel the run. Try again.")); }
    finally { setBusyId(""); }
  }
  async function queue(run: FindRun) {
    setBusyId(run.id); setError("");
    try { const updated = await queueFindRun(run.id); onChanged(updated); refresh(); toast({ title: "Queued for the lead finder", body: run.request.slice(0, 80) }); }
    catch (cause) { setError(describeError(cause, "Could not queue the plan. Try again.")); }
    finally { setBusyId(""); }
  }
  // The API lets the person who made a run, or a venture head, cancel it, and queue it while it is a saved plan.
  const ownsRun = (run: FindRun) => run.createdBy === session?.user.id || canHead(session, run.ventureId);
  const mayCancel = (run: FindRun) => canEdit && (run.status === "planned" || isLiveRun(run)) && ownsRun(run);
  const mayQueue = (run: FindRun) => canEdit && run.status === "planned" && ownsRun(run);

  return <div>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="p-4 pb-0" />
    <ul className="divide-y divide-neutral-100">{runs.map((run) => {
      const status = RUN_STATUS[run.status];
      const enrich = run.kind === "enrich";
      const plan = run.plan;
      const parts = enrich ? [plural(run.leadIds?.length ?? 0, "lead")] : [plan.places.length ? plural(plan.places.length, "place") : "", plan.categories.length ? plural(plan.categories.length, "category", "categories") : "", plan.searches.length ? plural(plan.searches.length, "search", "searches") : "", `up to ${plan.limit}`].filter(Boolean);
      const heartbeatAge = run.heartbeatAt ? now - new Date(run.heartbeatAt).getTime() : undefined;
      const stuck = run.status === "running" && heartbeatAge !== undefined && heartbeatAge > STALE_HEARTBEAT_MS;
      const labels = RESULT_LABELS[run.kind ?? "find"];
      const open = confirming === run.id;
      return <li key={run.id} className="space-y-2.5 p-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Badge tone={enrich ? "purple" : "blue"}>{enrich ? "Fill contacts" : "Find"}</Badge>
          <Badge tone={status.tone}>{status.label}</Badge>
          {run.status === "running" && run.progress && <span className="tnum text-xs font-semibold text-neutral-700">{run.progress.found} found · {run.progress.crawled} crawled · {run.progress.added} added</span>}
          {run.status === "running" && <span className={clsx("text-xs", stuck ? "font-semibold text-warning-text" : "text-neutral-500")}>{run.heartbeatAt ? `heartbeat ${since(run.heartbeatAt, now)} ago` : "just started"}{run.workerId ? ` · ${run.workerId}` : ""}{stuck ? ". It may have stopped." : ""}</span>}
          <span className="text-xs text-neutral-500 sm:ml-auto" title={stamp(run.createdAt)}>{personName(run.createdBy)} · {stamp(run.createdAt)}{!ventureId ? ` · ${ventureName(run.ventureId)}` : ""}</span>
        </div>
        <p className="line-clamp-3 text-sm font-semibold leading-5 text-neutral-900 [overflow-wrap:anywhere]">{run.request}</p>
        <p className="text-xs text-neutral-500">{run.offerId && offers[run.offerId] && <><span className="font-semibold text-neutral-700">{offers[run.offerId]!.name}</span> · </>}{parts.join(" · ")}</p>
        {run.results && <dl className="grid max-w-md grid-cols-3 gap-2">{([[labels[0], run.results.found], [labels[1], run.results.added], [labels[2], run.results.skipped]] as const).map(([label, value]) => <div key={label} className="rounded-xl bg-neutral-50 px-2 py-2 text-center"><dd className="tnum text-base font-extrabold text-neutral-900">{value}</dd><dt className="text-[10px] font-semibold text-neutral-500">{label}</dt></div>)}</dl>}
        {run.results?.note && <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">{run.results.note}</p>}
        {run.status === "failed" && <p className="rounded-xl bg-danger-surface p-3 text-xs font-semibold leading-5 text-danger-text [overflow-wrap:anywhere]">{run.note || run.results?.note || "The lead finder could not finish this run. Queue it again, or ask Claude to look at it."}</p>}
        {run.note && run.status !== "failed" && run.status !== "done" && <p className="text-xs leading-5 text-neutral-500 [overflow-wrap:anywhere]">{run.note}</p>}
        {(canEdit && !enrich || mayCancel(run)) && <div className="flex flex-wrap gap-2">
          {mayQueue(run) && <button type="button" disabled={busyId === run.id} onClick={() => void queue(run)} className={`${primaryClass} !min-h-9 !px-3 !text-xs`}><Play size={13} /><ActionLabel busy={busyId === run.id} busyText="Queueing…" idle="Queue it" /></button>}
          {canEdit && !enrich && <button type="button" onClick={() => onReuse(run)} className={`${secondaryClass} !min-h-9 !px-3 !text-xs`}><RotateCcw size={13} />Use this plan again</button>}
          {mayCancel(run) && <button type="button" aria-expanded={open} onClick={() => setConfirming(open ? "" : run.id)} className={`${secondaryClass} !min-h-9 !px-3 !text-xs !text-danger-text`}><X size={13} />Cancel</button>}
        </div>}
        {open && <div role="alertdialog" aria-label="Confirm cancel" className="vso-fade-enter space-y-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3.5">
          <p className="text-sm font-bold text-neutral-900">Cancel this run?</p>
          <p className="text-xs leading-5 text-neutral-500">{run.status === "running" ? "The lead finder stops within a minute or two. What it already added stays." : run.status === "queued" ? "Nothing has started, so nothing is lost." : "The plan is kept in the list as cancelled."}</p>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busyId === run.id} onClick={() => void cancel(run)} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50"><ActionLabel busy={busyId === run.id} busyText="Cancelling…" idle="Yes, cancel it" /></button><button type="button" onClick={() => setConfirming("")} className={secondaryClass}>{run.status === "running" ? "Keep it running" : "Keep it"}</button></div>
        </div>}
      </li>;
    })}</ul>
  </div>;
}
