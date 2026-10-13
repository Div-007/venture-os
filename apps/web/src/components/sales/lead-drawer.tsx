"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { Draft } from "@venture-studio/contracts";
import { ArrowUpRight, Check, LinkIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { Badge, DetailDrawer, primaryClass, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { getLead, type LeadDetail } from "@/lib/sales-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { useSalesOverview } from "@/components/sales/overview-context";
import { useDeliveryWork } from "@/components/sales/lead-actions";
import { LeadVerdict } from "@/components/sales/lead-verdict";
import { LeadDetails } from "@/components/sales/lead-details";
import { LeadGlance } from "@/components/sales/lead-glance";
import { LeadLog, LeadLogBar, type LogMode } from "@/components/sales/lead-log";
import { LeadNextAction } from "@/components/sales/lead-manage";
import { LeadTimeline } from "@/components/sales/lead-timeline";
import { useVentureOffers } from "@/components/sales/offer-model";
import {
  callablePhone, canDeleteLead, canEditLead, CHANNEL_LABELS, DRAFT_STATUS_LABELS, hostOf, isManager, isWonStage, OfferChip, PersonChip, Phone, safeUrl, snippet, StageChip, telHref, timeAgo, useUrlParams, VerdictChip,
} from "@/components/sales/sales-ui";

type LeadTab = "activity" | "claude" | "drafts" | "details";
const TABS: readonly LeadTab[] = ["activity", "claude", "drafts", "details"];
/** `?tab=`: Activity is the default and leaves no parameter. The old Overview and Timeline names land on Activity. */
const tabFrom = (raw: string | null): LeadTab => raw === "claude" || raw === "drafts" || raw === "details" ? raw : "activity";
const sectionLabel = "text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400";
const DRAFT_TONE: Record<string, "neutral" | "blue" | "green" | "amber" | "red" | "purple"> = { draft: "neutral", in_review: "blue", ready: "green", needs_changes: "amber", sent: "neutral", vetoed: "red", discarded: "neutral" };

function Drafts({ drafts }: { drafts: Draft[] }) {
  const sorted = [...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!sorted.length) return <p className="rounded-xl bg-neutral-50 px-3 py-3 text-sm text-neutral-500">No drafts yet. Claude writes them once the lead is approved for contact.</p>;
  return <ul className="grid grid-cols-1 gap-2">{sorted.map((draft) => <li key={draft.id}><Link href={`/sales/live/review?draft=${encodeURIComponent(draft.id)}`} className="group flex items-start gap-3 rounded-xl border border-neutral-200 p-3 transition-[background-color,transform] duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]">
    <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-1.5"><Badge tone={DRAFT_TONE[draft.status] ?? "neutral"}>{DRAFT_STATUS_LABELS[draft.status] ?? draft.status}</Badge><Badge>{CHANNEL_LABELS[draft.channel] ?? draft.channel}</Badge><span className="text-[11px] font-medium text-neutral-400">{timeAgo(draft.updatedAt)}</span></span><span className="mt-1.5 block truncate text-sm font-semibold text-neutral-800">{draft.subject || snippet(draft.body, 80)}</span>{draft.subject && <span className="mt-0.5 block truncate text-xs text-neutral-500">{snippet(draft.body, 100)}</span>}</span>
    <ArrowUpRight size={15} className="mt-1 shrink-0 text-neutral-300 transition-colors duration-150 group-hover:text-neutral-600" />
  </Link></li>)}</ul>;
}

/**
 * The lead drawer, opened by `?lead=<id>`. Top to bottom: who they are and what happens next, six tiles that answer the usual
 * questions at a glance, then Activity, Claude, Drafts and Details. A bar under it logs a call, a reply or a note.
 */
export function LeadDrawer({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const { session, ventureId, ventureName, personName, refresh, refreshKey } = useSalesShell();
  const { members } = useSalesOverview();
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [dirtyKeys, setDirtyKeys] = useState<readonly string[]>([]);
  const [editingDeal, setEditingDeal] = useState(false);
  const [composer, setComposer] = useState<LogMode | null>(null);
  const glance = useRef<HTMLDivElement>(null);
  const tabsTop = useRef<HTMLDivElement>(null);
  const { params, update } = useUrlParams();
  const tab = tabFrom(params.get("tab"));
  const tabMotion = useTabMotion(tab, TABS);
  const setDirty = useCallback((key: string, flag: boolean) => setDirtyKeys((current) => flag ? (current.includes(key) ? current : [...current, key]) : (current.includes(key) ? current.filter((item) => item !== key) : current)), []);

  useEffect(() => {
    let active = true;
    getLead(leadId).then((next) => { if (active) { setDetail(next); setError(""); } })
      .catch((cause: unknown) => { if (active) setError(describeError(cause, "Could not open this lead.")); });
    return () => { active = false; };
  }, [leadId, revision]);

  /** Something changed on the lead: reload the drawer and tell every open list to reload. */
  const changed = useCallback(() => { setRevision((value) => value + 1); refresh(); }, [refresh]);
  const { create: createDelivery, busyId } = useDeliveryWork(changed);

  const lead = detail?.lead;
  const offers = useVentureOffers(lead?.offerId ? lead.ventureId : undefined, refreshKey);
  const offerName = lead?.offerId ? offers?.find((offer) => offer.id === lead.offerId)?.name : undefined;
  const editable = !!session && !!lead && canEditLead(session, lead);
  const rawWebsite = lead?.website?.trim();
  const website = rawWebsite ? safeUrl(/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`) : undefined;
  const place = lead ? [lead.city, lead.category].filter(Boolean).join(" · ") : "";
  const dial = lead ? callablePhone(lead) : undefined;
  const tel = dial ? telHref(dial) : undefined;
  const won = !!lead && isWonStage(lead.stage);

  const openTab = (key: LeadTab, scroll = false) => {
    update({ tab: key === "activity" ? null : key });
    if (scroll) requestAnimationFrame(() => requestAnimationFrame(() => tabsTop.current?.scrollIntoView({ behavior: "smooth", block: "start" })));
  };
  const editDeal = () => { setEditingDeal(true); requestAnimationFrame(() => glance.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };

  const subtitle = lead && (place || website) ? <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">{place && <span>{place}</span>}{website && <a href={website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center inline-flex items-center gap-1 font-semibold text-primary-700 hover:underline"><LinkIcon size={11} />{hostOf(website)}</a>}</span> : undefined;

  return <DetailDrawer title={lead?.companyName ?? "Lead"} subtitle={subtitle} onClose={onClose} dirty={dirtyKeys.length > 0}
    actions={lead && tel ? <a href={tel} aria-label={`Call ${lead.companyName}`} className={clsx(primaryClass, "!min-h-10 !gap-1.5 !px-3.5 sm:hidden")}><Phone size={15} />Call</a> : undefined}
    footer={detail && lead && editable ? (composer
      ? <LeadLog lead={lead} mode={composer} onMode={setComposer} onClose={() => setComposer(null)} onLogged={() => { changed(); openTab("activity"); }} onDirty={setDirty} />
      : <LeadLogBar onPick={setComposer} />) : undefined}>
    {!detail && !error && <SkeletonRows rows={5} label="Loading lead" className="!p-0" />}
    {!detail && error && <EmptyState variant="error" title="Could not open this lead" body={error} action={{ label: "Try again", onClick: () => setRevision((value) => value + 1) }} />}
    {detail && lead && session && <div className="grid grid-cols-1 gap-5 text-sm text-neutral-600">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2"><StageChip stage={lead.stage} /><VerdictChip verdict={lead.verdict} />{lead.needsYou && <Badge tone="amber">Needs you</Badge>}{lead.doNotContact && <Badge tone="red">Do not contact</Badge>}{offerName && <OfferChip name={offerName} />}{!ventureId && <Badge>{ventureName(lead.ventureId)}</Badge>}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="inline-flex items-center gap-1.5"><span className="text-xs font-medium text-neutral-400">Owner</span><PersonChip name={personName(lead.ownerId)} /></span>{lead.contactName && <span className="text-xs font-medium text-neutral-500">Contact: <strong className="font-semibold text-neutral-700">{lead.contactName}</strong></span>}</div>
        <LeadNextAction lead={lead} canEdit={editable} onSaved={changed} onDirty={setDirty} />
      </div>

      {!editable && <p className="rounded-xl bg-neutral-50 px-3 py-2.5 text-xs leading-5 text-neutral-500">{session.membership.role === "learner" ? "You can read this lead. Learners cannot change leads." : "You can read this lead. Only its owner and the venture heads can change it."}</p>}

      {won && (lead.deliveryTaskId
        ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-success-surface p-3"><p className="flex items-center gap-2 text-sm font-semibold text-success-text"><Check size={16} />Won. Delivery work exists for this deal.</p><Link href={`/tasks/live?task=${encodeURIComponent(lead.deliveryTaskId)}`} className={clsx(secondaryClass, "!min-h-9")}>Open the task<ArrowUpRight size={14} /></Link></div>
        : <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-success-surface p-3"><p className="min-w-0 flex-1 text-sm font-semibold text-success-text">Won. Hand this over so delivery can start.</p>{(editable || isManager(session, lead.ventureId)) && <button type="button" disabled={busyId === lead.id} onClick={() => void createDelivery(lead.id, lead.companyName)} className={clsx(primaryClass, "!min-h-11")}>{busyId === lead.id ? "Creating…" : "Create delivery work"}</button>}</div>)}

      <div ref={glance} className="scroll-mt-2"><h3 className={clsx(sectionLabel, "mb-2.5")}>At a glance</h3>
        <LeadGlance lead={lead} activities={detail.activities} canEdit={editable} editingDeal={editingDeal} onEditDeal={setEditingDeal} onReadEvidence={() => openTab("claude", true)} personName={personName} onChanged={changed} onDirty={setDirty} />
      </div>

      <div ref={tabsTop} className="scroll-mt-1">
        <SlidingTabs fitContent label="Lead sections" className="sticky -top-5 z-10 -mx-1 shadow-sm" active={tab} onChange={(key) => openTab(key as LeadTab)}
          tabs={[{ key: "activity", label: "Activity", badge: detail.activities.length }, { key: "claude", label: "Claude", ...(detail.verdicts.length ? { badge: detail.verdicts.length } : {}) }, { key: "drafts", label: "Drafts", badge: detail.drafts.length }, { key: "details", label: "Details" }]} />
        <div key={tab} className={clsx(tabMotion.className, "mt-4")} style={tabMotion.style}>
          {tab === "activity" && <LeadTimeline activities={detail.activities} canEdit={editable} personName={personName} onChanged={changed} />}
          {tab === "claude" && <div className="grid grid-cols-1 gap-4">
            <LeadVerdict lead={lead} verdicts={detail.verdicts} canEdit={editable} personName={personName} onChanged={changed} onDirty={setDirty} />
            {(lead.observedSignal || lead.fitReason) && <dl className="grid grid-cols-1 gap-3 text-sm leading-6">
              {lead.observedSignal && <div><dt className={sectionLabel}>What we saw</dt><dd className="mt-1 text-neutral-700">{lead.observedSignal}</dd></div>}
              {lead.fitReason && <div><dt className={sectionLabel}>Why they might fit</dt><dd className="mt-1 text-neutral-700">{lead.fitReason}</dd></div>}
            </dl>}
          </div>}
          {tab === "drafts" && <div><div className="mb-3 flex justify-end"><Link href="/sales/live/review" className="inline-flex min-h-8 items-center text-xs font-semibold text-primary-700 hover:underline">Open Review</Link></div><Drafts drafts={detail.drafts} /></div>}
          {tab === "details" && <LeadDetails lead={lead} canEdit={editable} canReassign={isManager(session, lead.ventureId)} canDelete={canDeleteLead(session, lead)} members={members} personName={personName} editingDeal={editingDeal} onEditDeal={editDeal} onSaved={changed} onDeleted={() => { refresh(); onClose(); }} onDirty={setDirty} />}
        </div>
      </div>
    </div>}
  </DetailDrawer>;
}
