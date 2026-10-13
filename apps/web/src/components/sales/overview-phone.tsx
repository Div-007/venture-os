"use client";
import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowLeft, ChevronRight, CircleCheck, MessageCircle, Send, ShieldCheck, CircleAlert, type Icon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { Badge, inputClass, Notice, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { discardDraft, vetoDraft, type DraftWithLead, type SalesOverview } from "@/lib/sales-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { KIND_META, QueueActions, tileClass, type QueueItem, type QueueKind } from "@/components/sales/overview-queue";
import { CalendarClock, isManager, Phone, number, waiting, type Tone } from "@/components/sales/sales-ui";

type Section = { key: string; label: string; icon: Icon; tone: Tone; count: number; kinds: QueueKind[]; hint: string; empty: string; href?: string };

function sections(overview: SalesOverview): Section[] {
  const { counts } = overview;
  const oldest = [...overview.replies].sort((a, b) => a.activity.at.localeCompare(b.activity.at))[0];
  const list: Section[] = [
    { key: "replies", label: "Replies", icon: MessageCircle, tone: "amber", count: counts.replies, kinds: ["reply"], hint: oldest ? `Oldest waiting ${waiting(oldest.activity.at)}` : "Nobody is waiting on you", empty: "No replies waiting." },
    { key: "calls", label: "Calls today", icon: Phone, tone: "blue", count: counts.callsDue, kinds: ["call"], hint: counts.callsDue ? "Open the call list" : "No calls due", empty: "No calls due.", href: "/sales/live/calls" },
    { key: "send", label: "Ready to send", icon: Send, tone: "green", count: counts.readyToSend, kinds: ["send"], hint: counts.readyToSend ? "Passed Claude's review" : "Nothing to send", empty: "Nothing is ready to send." },
    { key: "review", label: "To review", icon: ShieldCheck, tone: "purple", count: counts.toReview, kinds: ["review"], hint: counts.toReview ? "Claude's drafts to check" : "Nothing to check", empty: "No drafts to review." },
    { key: "decide", label: "Needs you", icon: CircleAlert, tone: "red", count: counts.needsYou + counts.wonToHandOver, kinds: ["decide", "won"], hint: counts.wonToHandOver ? `${counts.wonToHandOver} won to hand over` : counts.needsYou ? "Claude wants your call" : "Nothing to decide", empty: "Nothing needs a decision." },
  ];
  if (counts.followUpsDue > 0) list.push({ key: "follow", label: "Follow-ups due", icon: CalendarClock, tone: "purple", count: counts.followUpsDue, kinds: ["follow"], hint: "No reply since the first touch", empty: "No follow-ups due." });
  return list;
}

/** Quick decisions on a draft, sized for a thumb: veto with a reason, or discard. Both ask first. Approving is only done after reading the whole message in Review. */
function DraftQuick({ draft, onDone }: { draft: DraftWithLead; onDone: () => void }) {
  const [mode, setMode] = useState<"" | "veto" | "discard">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function run(kind: string, action: () => Promise<unknown>, title: string) {
    setBusy(kind); setError("");
    try { await action(); toast({ title, body: draft.lead.companyName }); onDone(); }
    catch (cause) { setError(describeError(cause, "Could not do that. Try again.")); }
    finally { setBusy(""); }
  }
  const small = "!min-h-11 flex-1 !text-sm";
  return <div className="mt-2.5 grid gap-2.5">
    {mode === "" && <div className="flex gap-2">
      <button type="button" onClick={() => setMode("veto")} className={clsx(secondaryClass, small)}>Veto</button>
      <button type="button" onClick={() => setMode("discard")} className={clsx(secondaryClass, small)}>Discard</button>
    </div>}
    {mode === "veto" && <form className="vso-fade-enter grid gap-2" onSubmit={(event) => { event.preventDefault(); if (reason.trim().length < 3) { setError("Say why in a few words."); return; } void run("veto", () => vetoDraft(draft.id, { reason: reason.trim() }), "Draft vetoed"); }}>
      <input autoFocus aria-label="Why veto this draft" maxLength={1000} className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why not? A few words." />
      <div className="flex gap-2"><button disabled={!!busy} className={clsx(secondaryClass, small, "!border-danger-surface !bg-danger-surface !text-danger-text")}>{busy === "veto" ? "Vetoing…" : "Veto draft"}</button><button type="button" onClick={() => { setMode(""); setReason(""); setError(""); }} className={clsx(secondaryClass, small)}>Cancel</button></div>
    </form>}
    {mode === "discard" && <div className="vso-fade-enter grid gap-2"><p className="text-sm font-semibold text-neutral-700">Discard this draft?</p><div className="flex gap-2"><button type="button" disabled={!!busy} onClick={() => void run("discard", () => discardDraft(draft.id), "Draft discarded")} className={clsx(secondaryClass, small, "!border-danger-surface !bg-danger-surface !text-danger-text")}>{busy === "discard" ? "Discarding…" : "Discard"}</button><button type="button" onClick={() => setMode("")} className={clsx(secondaryClass, small)}>Keep it</button></div></div>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
  </div>;
}

function QueueCard({ item, onDone }: { item: QueueItem; onDone: () => void }) {
  const { openLead, session } = useSalesShell();
  const meta = KIND_META[item.kind];
  const KindIcon = meta.icon;
  const draft = item.draft;
  // A message that still needs a person's approval is read in full in Review first; only admins and venture heads can approve it.
  const needsApproval = !!draft && draft.status === "ready" && !!draft.playId && !draft.personApproval && !!session && isManager(session, draft.lead.ventureId);
  const canAct = !!session && session.membership.role !== "learner";
  return <li className="vso-fade-enter rounded-2xl border border-neutral-100 bg-white p-4 shadow-card">
    <div className="flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500"><span aria-hidden="true" className={clsx("grid h-6 w-6 place-items-center rounded-lg", tileClass(meta.tone))}><KindIcon size={13} /></span>{meta.label}</span><Badge tone={item.badge.tone}>{item.badge.label}</Badge></div>
    <button type="button" onClick={() => openLead(item.leadId)} className="mt-2.5 block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><span className="block text-base font-bold text-neutral-900 [overflow-wrap:anywhere]">{item.company}</span><span className="mt-1 line-clamp-3 block text-sm leading-5 text-neutral-500">{item.detail}</span></button>
    {needsApproval && <p className="mt-2.5 rounded-xl bg-warning-surface px-3 py-2 text-xs font-semibold leading-5 text-warning-text">This message needs a person to approve it. Read all of it first.</p>}
    <div className="mt-3.5 flex gap-2"><QueueActions item={item} big onDone={onDone} mainLabel={needsApproval ? "Read and approve" : undefined} /></div>
    {draft && canAct && <DraftQuick draft={draft} onDone={onDone} />}
  </li>;
}

/** The phone Overview: a few big rows with counts; each opens a focused list with big buttons. */
export function OnTheGo({ overview, queue, onChanged }: { overview: SalesOverview; queue: QueueItem[]; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const all = sections(overview);
  const current = all.find((section) => section.key === open);

  if (current) {
    const items = queue.filter((item) => current.kinds.includes(item.kind));
    const CurrentIcon = current.icon;
    return <div className="vso-fade-enter">
      <button type="button" onClick={() => setOpen(null)} className="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-neutral-500 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><ArrowLeft size={16} />On the go</button>
      <div className="mb-3 flex items-center gap-3"><span aria-hidden="true" className={clsx("grid h-10 w-10 place-items-center rounded-xl", tileClass(current.tone))}><CurrentIcon size={19} /></span><h2 className="text-lg font-extrabold tracking-[-.02em] text-neutral-900">{current.label}</h2><Badge>{number(current.count)}</Badge></div>
      {items.length ? <ul className="grid grid-cols-1 gap-3">{items.map((item) => <QueueCard key={item.key} item={item} onDone={onChanged} />)}</ul>
        : <EmptyState variant="card" icon={CircleCheck} tone="green" title="All clear" body={current.empty} className="rounded-2xl border border-neutral-100 bg-white" />}
      {current.count > items.length && items.length > 0 && <p className="mt-3 text-center text-xs font-medium text-neutral-400">Showing {items.length} of {number(current.count)}. The rest are in the full lists.</p>}
    </div>;
  }

  return <ul aria-label="On the go" className="grid grid-cols-1 gap-3">
    {all.map((section) => {
      const SectionIcon = section.icon;
      const body = <>
        <span aria-hidden="true" className={clsx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", tileClass(section.tone))}><SectionIcon size={20} /></span>
        <span className="min-w-0 flex-1 text-left"><span className="block text-base font-bold text-neutral-900">{section.label}</span><span className="mt-0.5 block truncate text-xs font-medium text-neutral-500">{section.hint}</span></span>
        <span className={clsx("text-2xl font-extrabold tabular-nums tracking-tight", section.count ? "text-neutral-900" : "text-neutral-300")}>{number(section.count)}</span>
        <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-neutral-300" />
      </>;
      const row = "flex min-h-[76px] w-full items-center gap-3.5 rounded-2xl border border-neutral-100 bg-white p-4 shadow-card transition-[transform,box-shadow] duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";
      return <li key={section.key}>{section.href
        ? <Link href={section.href} className={row}>{body}</Link>
        : <button type="button" onClick={() => setOpen(section.key)} className={row}>{body}</button>}</li>;
    })}
  </ul>;
}
