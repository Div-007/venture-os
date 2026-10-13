"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Lead } from "@venture-studio/contracts";
import { Check, ChevronDown, RotateCcw } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { Badge, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass } from "@/components/studio/primitives";
import { getLead, getSalesOverview, logActivity, type LeadDetail } from "@/lib/sales-api";
import { CallCard, type CallLead, type CallLogger } from "@/components/sales/call-card";
import { PopCard } from "@/components/sales/pop-card";
import { CALL_OUTCOME_LABEL, canEditLead, canWriteIn, OWNER_ONLY_NOTE, useQueryParam, useSalesLoad } from "@/components/sales/draft-shared";
import { Phone } from "@/components/sales/draft-icons";
import { useSalesShell } from "@/components/sales/sales-context";
import { when } from "@/components/sales/sales-ui";

type Run = { key: string; queue: CallLead[]; index: number; results: Record<string, string> };

const cardOf = (lead: Lead): CallLead => ({
  id: lead.id, ventureId: lead.ventureId, companyName: lead.companyName, contactName: lead.contactName, ...(lead.city ? { city: lead.city } : {}), stage: lead.stage, ownerId: lead.ownerId, nextAction: lead.nextAction,
  ...(lead.nextActionAt ? { nextActionAt: lead.nextActionAt } : {}), ...(lead.verdict ? { verdict: lead.verdict } : {}), ...(lead.whatsappOptIn ? { whatsappOptIn: lead.whatsappOptIn } : {}), contactRoutes: lead.contactRoutes, why: lead.observedSignal || lead.fitReason, doNotContact: lead.doNotContact,
});

/** Call mode: one lead at a time from today's calls, with the opener, a big Call button and one-tap outcomes. */
export function CallsScreen() {
  const { session, ventureId, refresh, openLead } = useSalesShell();
  const [callParam] = useQueryParam("call");
  const [leadParam] = useQueryParam("lead");
  const startId = callParam || leadParam;
  const [generation, setGeneration] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);

  const overview = useSalesLoad(`calls|${ventureId}|${generation}`, () => getSalesOverview({ ...(ventureId ? { ventureId } : {}), owner: "me" }));
  const start = useSalesLoad(`call-start|${startId}|${generation}`, () => startId ? getLead(startId).then((detail) => ({ lead: detail.lead as Lead | null })) : Promise.resolve({ lead: null as Lead | null }));

  // The queue is fixed when the screen opens, so it does not shift under your thumb as calls are logged.
  const key = `${ventureId}|${startId}|${generation}`;
  const [run, setRun] = useState<Run | null>(null);
  const ready = overview.data !== null && (start.data !== null || start.error !== "");
  if (ready && run?.key !== key) {
    const due = overview.data!.callsDue;
    const first = start.data?.lead ? cardOf(start.data.lead) : undefined;
    setRun({ key, queue: first ? [first, ...due.filter((item) => item.id !== first.id)] : due, index: 0, results: {} });
  }
  const current = run?.key === key ? run : null;
  const lead = current?.queue[current.index];
  const detail = useSalesLoad<{ detail: LeadDetail | null }>(`call-lead|${lead?.id ?? ""}`, () => lead ? getLead(lead.id).then((value) => ({ detail: value })) : Promise.resolve({ detail: null }));

  // Each new lead opens at its top, not where the last one's buttons were.
  const cardTop = useRef<HTMLDivElement>(null);
  const shownIndex = useRef<number | null>(null);
  const index = current?.index ?? null;
  useEffect(() => {
    if (index !== null && shownIndex.current !== null && shownIndex.current !== index) cardTop.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    shownIndex.current = index;
  }, [index]);

  // Logging a call is for the lead's owner, the venture head or an admin (as the API allows); a teammate sees why, a learner only looks.
  const canLog = lead ? canEditLead(session, lead) : false;
  const readOnlyNote = lead && !canLog && canWriteIn(session, lead.ventureId) ? OWNER_ONLY_NOTE : "";
  // One request id per call outcome being logged: a retry of the same outcome, note and time reuses it, so a retry after a lost answer
  // repeats the first answer instead of logging the call twice. Anything new (another outcome, the next lead) gets a fresh id.
  const pending = useRef<{ key: string; requestId: string } | null>(null);

  const done = current ? Object.keys(current.results).length : 0;
  const total = current?.queue.length ?? 0;
  const go = (index: number) => setRun((value) => value && { ...value, index: Math.max(0, Math.min(value.queue.length, index)) });

  const logCall: CallLogger = async (outcome, input) => {
    if (!lead || !current) return;
    const payload = { kind: "call" as const, direction: "out" as const, callOutcome: outcome, body: input.note.trim(), ...(input.at ? { nextActionAt: input.at } : {}) };
    const key = JSON.stringify([lead.id, payload]);
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() };
    const result = await logActivity(lead.id, { ...payload, requestId: pending.current.requestId });
    pending.current = null;
    toast({ title: `Logged: ${CALL_OUTCOME_LABEL[outcome]}`, body: `${lead.companyName}${result.lead.nextAction ? `. Next: ${result.lead.nextAction}` : ""}` });
    setRun((value) => value && { ...value, results: { ...value.results, [lead.id]: outcome }, index: Math.min(value.queue.length, value.index + 1) });
    refresh();
  };
  function reload() { setRun(null); setGeneration((value) => value + 1); }

  if (overview.error && !overview.data) return <Panel><EmptyState variant="error" title="Could not load today's calls" body={overview.error} action={{ label: overview.busy ? "Trying again…" : "Try again", onClick: overview.reload, disabled: overview.busy }} /></Panel>;
  if (!current) return <div role="status" aria-label="Loading calls" className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]"><Panel className="space-y-3 p-4 max-lg:hidden">{[0, 1, 2, 3].map((index) => <span key={index} className="vso-skeleton block h-10 rounded-xl" />)}</Panel><Panel className="space-y-4 p-5"><span className="vso-skeleton block h-3 w-24" /><span className="vso-skeleton block h-8 w-2/3" /><span className="vso-skeleton block h-14 rounded-2xl" /><span className="vso-skeleton block h-24 rounded-2xl" /></Panel></div>;
  if (current.queue.length === 0) return <Panel><EmptyState variant="card" tone="blue" icon={Phone} title="No calls due right now" body="A lead shows up here when a call is due: approved for contact with a phone number, or a call back you set. Ask Claude: &ldquo;who should I call today?&rdquo; or find more leads." action={{ label: "Find leads", href: "/sales/live/find" }} secondary={{ label: "See all leads", href: "/sales/live/leads" }} /></Panel>;

  const left = current.queue.filter((item) => !current.results[item.id]).length;
  const finished = current.index >= current.queue.length;
  const skipped = current.queue.findIndex((item) => !current.results[item.id]);

  const queue = <Panel className={clsx("overflow-hidden", !queueOpen && "max-lg:hidden", "lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto thin-scroll")}>
    <PanelHead title="Queue" aside={<span className="flex items-center gap-2"><Badge>{left} left</Badge><RefreshButton busy={overview.busy} onClick={reload} label="Reload today's calls" className="!min-h-9 !w-9" /></span>} />
    <ul>{current.queue.map((item, index) => {
      const outcome = current.results[item.id];
      const active = index === current.index;
      return <li key={item.id}><button type="button" aria-current={active ? "true" : undefined} onClick={() => { go(index); setQueueOpen(false); }} className={clsx("flex min-h-14 w-full items-center gap-3 border-b border-neutral-50 px-4 py-2.5 text-left transition-[background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600", active ? "bg-primary-50" : "hover:bg-neutral-50")}>
        <span aria-hidden="true" className={clsx("grid h-8 w-8 shrink-0 place-items-center rounded-lg", outcome ? "bg-success-surface text-success-text" : "bg-neutral-100 text-neutral-500")}>{outcome ? <Check size={15} /> : <Phone size={15} />}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold text-neutral-900">{item.companyName}</span><span className="block truncate text-xs text-neutral-500">{outcome ? CALL_OUTCOME_LABEL[outcome] : [item.city, item.nextActionAt ? when(item.nextActionAt) : ""].filter(Boolean).join(" · ") || "Call due"}</span></span>
        {active && !finished && <span className="text-[11px] font-semibold text-primary-700">now</span>}
      </button></li>;
    })}</ul>
  </Panel>;

  return <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
    <div className="order-2 min-w-0 lg:order-1">{queue}</div>
    <div ref={cardTop} className="order-1 min-w-0 scroll-mt-4 lg:order-2">
      <button type="button" aria-expanded={queueOpen} onClick={() => setQueueOpen(!queueOpen)} className="mb-3 flex min-h-11 w-full items-center justify-between rounded-xl border border-neutral-200 bg-white px-4 text-sm font-semibold text-neutral-700 transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 lg:hidden"><span>Queue · {left} left of {total}</span><ChevronDown size={16} className={clsx("transition-transform duration-150", queueOpen && "rotate-180")} /></button>
      <PopCard tilt={4} className="rounded-2xl"><Panel className="p-4 sm:p-6">
        {finished ? <div className="vso-fade-enter space-y-4 py-4 text-center">
          <span aria-hidden="true" className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-success-surface text-success-text"><Check size={22} /></span>
          <div><h2 className="text-lg font-extrabold tracking-[-.02em] text-neutral-900">{left === 0 ? "That was the last call" : "You reached the end"}</h2><p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-neutral-500">{done} of {total} logged{left > 0 ? `, ${left} skipped` : ""}. Each outcome already set the lead&apos;s next step.</p></div>
          {done > 0 && <ul className="mx-auto flex max-w-md flex-wrap justify-center gap-1.5">{Object.entries(Object.values(current.results).reduce<Record<string, number>>((counts, outcome) => ({ ...counts, [outcome]: (counts[outcome] ?? 0) + 1 }), {})).map(([outcome, count]) => <li key={outcome}><Badge>{count} · {CALL_OUTCOME_LABEL[outcome]}</Badge></li>)}</ul>}
          <div className="flex flex-wrap justify-center gap-2">
            {left > 0 && skipped >= 0 && <button type="button" onClick={() => go(skipped)} className={primaryClass}>Go back to the skipped ones</button>}
            <button type="button" onClick={reload} className={left > 0 ? secondaryClass : primaryClass}><RotateCcw size={15} />Check for more calls</button>
          </div>
        </div>
          : lead && <div className="mx-auto max-w-3xl"><CallCard key={lead.id} lead={lead} detail={detail.data?.detail ?? null} detailError={detail.error} position={current.index + 1} total={total} canLog={canLog} readOnlyNote={readOnlyNote} onLog={logCall} onSkip={() => go(current.index + 1)} onBack={current.index > 0 ? () => go(current.index - 1) : undefined} onOpenLead={() => openLead(lead.id)} /></div>}
      </Panel></PopCard>
    </div>
  </div>;
}
