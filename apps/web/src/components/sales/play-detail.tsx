"use client";
import { useState } from "react";
import clsx from "clsx";
import type { Play } from "@venture-studio/contracts";
import { Check, CircleCheck, Edit, Info, Pause, Play as PlayIcon, Sparkles } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { ActionLabel, Badge, DetailDrawer, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { approvePlay, updatePlay } from "@/lib/sales-api";
import { canHead, ChannelTile, isLearner, kickerClass, stamp } from "./draft-shared";
import { offerChip, offerHref, useVentureOffers } from "./offer-model";
import { MOTION_LABEL } from "./play-form";
import { useSalesShell } from "./sales-context";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
export const PLAY_STATUS: Record<Play["status"], { label: string; tone: Tone }> = {
  draft: { label: "Waiting for approval", tone: "amber" }, approved: { label: "Approved", tone: "blue" }, running: { label: "Running", tone: "green" }, paused: { label: "Paused", tone: "neutral" }, done: { label: "Done", tone: "purple" },
};
const STEP_LABEL: Record<string, string> = { call: "Call", email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn" };

/** One play: what it is, its steps, its numbers, and the buttons that move it along. */
export function PlayDetail({ play, onClose, onEdit, onChanged }: { play: Play; onClose: () => void; onEdit: () => void; onChanged: (play: Play) => void }) {
  const { session, ventureName, personName, refresh, refreshKey } = useSalesShell();
  const offers = useVentureOffers(play.offerId ? play.ventureId : undefined, refreshKey);
  const offer = play.offerId ? offers?.find((item) => item.id === play.offerId) : undefined;
  const offerName = offer?.name ?? play.offerName;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const head = canHead(session, play.ventureId);
  const writer = !isLearner(session);
  // The API lets a venture head change status; a proposer may still edit their own play while it waits for approval.
  const canEdit = head || (writer && !!session && play.createdBy === session.user.id && play.status === "draft");
  const status = PLAY_STATUS[play.status];
  const stats = play.stats;

  async function run(name: string, action: () => Promise<Play>, success: string) {
    setBusy(name); setError("");
    try { const updated = await action(); onChanged(updated); refresh(); toast({ title: success, body: updated.name }); }
    catch (cause) { setError(describeError(cause, "That did not work. Try again.")); }
    finally { setBusy(""); }
  }
  const setStatus = (next: Play["status"], success: string) => void run(next, () => updatePlay(play.id, { status: next }), success);

  return <DetailDrawer title={play.name} subtitle={`${ventureName(play.ventureId)} · ${MOTION_LABEL[play.motion]} · first batch ${play.batchSize}`} onClose={onClose}>
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="text-xs text-neutral-500">{play.createdVia === "claude" ? `Proposed by Claude for ${personName(play.createdBy)}` : `Proposed by ${personName(play.createdBy)}`}, {stamp(play.createdAt)}</span>
        </div>
        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        {(head || canEdit) && <div className="flex flex-wrap gap-2">
          {play.status === "draft" && head && <button type="button" onClick={() => void run("approve", () => approvePlay(play.id), "Play approved")} disabled={busy === "approve"} className={primaryClass}><ActionLabel busy={busy === "approve"} busyText="Approving…" idle={<><Check size={16} />Approve play</>} /></button>}
          {head && play.status === "approved" && <button type="button" onClick={() => setStatus("running", "Play started")} disabled={busy === "running"} className={primaryClass}><ActionLabel busy={busy === "running"} busyText="Starting…" idle={<><PlayIcon size={16} />Start the play</>} /></button>}
          {head && play.status === "running" && <button type="button" onClick={() => setStatus("paused", "Play paused")} disabled={busy === "paused"} className={secondaryClass}><ActionLabel busy={busy === "paused"} busyText="Pausing…" idle={<><Pause size={16} />Pause</>} /></button>}
          {head && play.status === "paused" && <button type="button" onClick={() => setStatus("running", "Play running again")} disabled={busy === "running"} className={primaryClass}><ActionLabel busy={busy === "running"} busyText="Starting…" idle={<><PlayIcon size={16} />Resume</>} /></button>}
          {head && (play.status === "running" || play.status === "paused") && <button type="button" onClick={() => setStatus("done", "Play marked done")} disabled={busy === "done"} className={secondaryClass}><ActionLabel busy={busy === "done"} busyText="Saving…" idle={<><CircleCheck size={16} />Mark done</>} /></button>}
          {head && play.status === "done" && <button type="button" onClick={() => setStatus("running", "Play running again")} disabled={busy === "running"} className={secondaryClass}><ActionLabel busy={busy === "running"} busyText="Starting…" idle="Run again" /></button>}
          {canEdit && <button type="button" onClick={onEdit} className={secondaryClass}><Edit size={16} />Edit</button>}
        </div>}
        {!head && writer && play.status !== "draft" && play.status !== "done" && <p className="text-xs leading-5 text-neutral-500">A venture head starts, pauses and finishes plays.</p>}
        {play.status === "draft" && !head && <p className="flex items-start gap-2 rounded-xl bg-warning-surface p-3 text-xs leading-5 text-warning-text"><Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />A venture head or the owner approves a play before it starts. Claude cannot approve its own plans.</p>}
        {play.status !== "draft" && play.approvedBy && <p className="text-xs text-neutral-500">Approved by {personName(play.approvedBy)}{play.approvedAt ? `, ${stamp(play.approvedAt)}` : ""}</p>}
      </div>

      <section className="space-y-2">
        <h3 className={kickerClass}>Numbers</h3>
        {stats ? <dl className="grid grid-cols-5 gap-2">{([["Leads", stats.leads], ["Contacted", stats.contacted], ["Replied", stats.replied], ["Meetings", stats.meetings], ["Won", stats.won]] as const).map(([label, value]) => <div key={label} className="rounded-xl bg-neutral-50 px-2 py-2.5 text-center"><dd className="tnum text-lg font-extrabold text-neutral-900">{value}</dd><dt className="text-[10px] font-semibold text-neutral-500">{label}</dt></div>)}</dl>
          : <p className="rounded-xl bg-neutral-50 p-3 text-xs text-neutral-500">No numbers yet. Add leads to this play, then they show up here.</p>}
        <WorkspaceLink href={`/sales/live/find?play=${encodeURIComponent(play.id)}`} className="inline-flex min-h-10 items-center gap-2 rounded-xl px-1 text-sm font-semibold text-primary-700 transition-colors duration-150 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Sparkles size={15} />Find leads for this play</WorkspaceLink>
      </section>

      <section className="space-y-2">
        <h3 className={kickerClass}>Steps · stop the moment anyone replies</h3>
        {play.steps.length === 0 ? <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-500">No steps yet. Edit the play to add them, or ask Claude to plan the sequence.</p>
          : <ol className="space-y-0">{play.steps.map((step, index) => <li key={index} className="flex gap-3">
            <div className="flex flex-col items-center"><ChannelTile channel={step.channel} size={32} /><span aria-hidden="true" className={clsx("mt-1 w-px flex-1 bg-neutral-200", index === play.steps.length - 1 && "invisible")} /></div>
            <div className="min-w-0 pb-4"><p className="text-sm font-bold text-neutral-900">Day {step.day} · {STEP_LABEL[step.channel]}</p><p className="mt-0.5 text-[13px] leading-6 text-neutral-600 [overflow-wrap:anywhere]">{step.action}</p></div>
          </li>)}</ol>}
        {play.stopRule && <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600"><b className="text-neutral-800">Stops: </b>{play.stopRule}</p>}
      </section>

      {Boolean(play.audience || offerName || play.hypothesis || play.metric) && <section className="space-y-3">
        <h3 className={kickerClass}>Who, and why</h3>
        <dl className="space-y-3 text-sm">
          {offerName && <div><dt className="text-xs font-semibold text-neutral-500">Offer</dt><dd className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 leading-6 text-neutral-800">
            <span className="[overflow-wrap:anywhere]">{offerName}</span>
            {offer && offerChip(offer).label !== "Active" && <Badge tone={offerChip(offer).tone}>{offerChip(offer).label}</Badge>}
            {offer && <WorkspaceLink href={offerHref(play.ventureId, offer.id)} className="inline-flex min-h-8 items-center text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Open the offer</WorkspaceLink>}
          </dd></div>}
          {([["Audience", play.audience], ["What we expect", play.hypothesis], ["How we measure it", play.metric]] as const).map(([label, value]) => value ? <div key={label}><dt className="text-xs font-semibold text-neutral-500">{label}</dt><dd className="mt-0.5 leading-6 text-neutral-800 [overflow-wrap:anywhere]">{value}</dd></div> : null)}
        </dl>
      </section>}

      <FirstBatch play={play} head={head} onChanged={onChanged} />
    </div>
  </DetailDrawer>;
}

/** The play's first messages are read by a person; once the team is happy, Claude's review alone is enough. */
function FirstBatch({ play, head, onChanged }: { play: Play; head: boolean; onChanged: (play: Play) => void }) {
  const { refresh } = useSalesShell();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const on = play.firstBatchReviewed;
  async function toggle() {
    setBusy(true); setError("");
    try {
      const updated = await updatePlay(play.id, { firstBatchReviewed: !on });
      if (updated.firstBatchReviewed === on) throw new Error("The server did not take that change.");
      onChanged(updated); refresh();
      toast({ title: updated.firstBatchReviewed ? "Claude's review is enough from now" : "A person reads each message again", body: updated.name });
    } catch (cause) { setError(describeError(cause, "Could not change this. Try again.")); }
    finally { setBusy(false); }
  }
  return <section className="space-y-2 rounded-2xl border border-neutral-200 p-4">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0"><h3 className="text-sm font-bold text-neutral-900">First batch read</h3><p className="mt-1 text-xs leading-5 text-neutral-500">{on ? "A person has read the first messages of this play. From now on Claude's review is enough before you send." : `Until a person has read the first ${play.batchSize} messages, each one needs an approval from a venture head before it can be marked sent.`}</p></div>
      <button type="button" role="switch" aria-checked={on} aria-label="First batch read: Claude's review is enough from now" disabled={!head || busy} onClick={() => void toggle()} className={clsx("relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50", on ? "bg-primary-700" : "bg-neutral-300")}><span aria-hidden="true" className={clsx("absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform duration-200", on && "translate-x-5")} /></button>
    </div>
    {!head && <p className="text-xs text-neutral-400">Only a venture head or the owner can change this.</p>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
  </section>;
}
