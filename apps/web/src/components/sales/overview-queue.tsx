"use client";
import Link from "next/link";
import clsx from "clsx";
import { Check, CircleAlert, MessageCircle, Send, ShieldCheck, type Icon } from "@/components/ui/icons";
import { Badge, primaryClass, secondaryClass } from "@/components/studio/primitives";
import type { DraftWithLead, SalesOverview } from "@/lib/sales-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { useDeliveryWork } from "@/components/sales/lead-actions";
import { callablePhone, CalendarClock, CHANNEL_LABELS, Phone, plural, snippet, telHref, waiting, when, type Tone } from "@/components/sales/sales-ui";

// The "Needs you now" queue: everything in the Overview payload that waits on a person, in one list, each with its one action.

export type QueueKind = "reply" | "won" | "call" | "send" | "review" | "decide" | "follow";
export type QueueItem = {
  key: string; kind: QueueKind; leadId: string; company: string; title: string; detail: string; badge: { label: string; tone: Tone };
  phone?: string; /** In-app link for the main action; otherwise the action opens the lead drawer. */ href?: string; at?: string; draft?: DraftWithLead;
};

export const KIND_META: Record<QueueKind, { label: string; plural: string; icon: Icon; tone: Tone; action: string }> = {
  reply: { label: "Reply", plural: "Replies", icon: MessageCircle, tone: "amber", action: "Reply" },
  won: { label: "Won", plural: "Won deals", icon: Check, tone: "green", action: "Create delivery work" },
  call: { label: "Call", plural: "Calls", icon: Phone, tone: "blue", action: "Call" },
  send: { label: "Send", plural: "Ready to send", icon: Send, tone: "green", action: "Open" },
  review: { label: "Review", plural: "To review", icon: ShieldCheck, tone: "purple", action: "Review" },
  decide: { label: "Decide", plural: "Needs you", icon: CircleAlert, tone: "red", action: "Decide" },
  follow: { label: "Follow up", plural: "Follow-ups", icon: CalendarClock, tone: "purple", action: "Open" },
};
const ORDER: QueueKind[] = ["reply", "won", "call", "send", "follow", "review", "decide"];

const TILE: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-600", blue: "bg-primary-50 text-primary-700", green: "bg-success-surface text-success-text",
  amber: "bg-warning-surface text-warning-text", red: "bg-danger-surface text-danger-text", purple: "bg-ai-surface text-ai-text",
};
export const tileClass = (tone: Tone) => TILE[tone];

const channelName = (channel: string) => CHANNEL_LABELS[channel] ?? channel;
export const draftSummary = (draft: DraftWithLead) => `${channelName(draft.channel)} · ${draft.subject ? `${draft.subject} · ` : ""}${snippet(draft.body, 90)}`;

export function buildQueue(overview: SalesOverview): QueueItem[] {
  const items: QueueItem[] = [];
  for (const { activity, lead } of overview.replies) {
    items.push({ key: `reply-${activity.id}`, kind: "reply", leadId: lead.id, company: lead.companyName, title: `Reply to ${lead.companyName}`, detail: `${channelName(activity.kind)}${activity.body ? ` · “${snippet(activity.body, 110)}”` : ""}`, badge: { label: `Waiting ${waiting(activity.at)}`, tone: "amber" }, phone: callablePhone(lead), href: `/sales/live/inbox?reply=${encodeURIComponent(activity.id)}`, at: activity.at });
  }
  for (const lead of overview.wonToHandOver) items.push({ key: `won-${lead.id}`, kind: "won", leadId: lead.id, company: lead.companyName, title: `Won: ${lead.companyName}`, detail: lead.why || "Hand this over so delivery can start.", badge: { label: "Won", tone: "green" }, phone: callablePhone(lead) });
  for (const lead of overview.callsDue) items.push({ key: `call-${lead.id}`, kind: "call", leadId: lead.id, company: lead.companyName, title: `Call ${lead.companyName}`, detail: lead.why || lead.nextAction || "Due for a call.", badge: { label: lead.nextActionAt ? when(lead.nextActionAt) : "Due", tone: "blue" }, phone: callablePhone(lead), at: lead.nextActionAt });
  for (const draft of overview.readyToSend) items.push({ key: `send-${draft.id}`, kind: "send", leadId: draft.lead.id, company: draft.lead.companyName, title: `Send to ${draft.lead.companyName}`, detail: draftSummary(draft), badge: { label: "Ready", tone: "green" }, phone: callablePhone(draft.lead), href: `/sales/live/review?draft=${encodeURIComponent(draft.id)}`, at: draft.updatedAt, draft });
  for (const lead of overview.followUpsDue) items.push({ key: `follow-${lead.id}`, kind: "follow", leadId: lead.id, company: lead.companyName, title: `Follow up ${lead.companyName}`, detail: lead.why || "No reply since the first touch.", badge: { label: lead.nextActionAt ? when(lead.nextActionAt) : "Due", tone: "purple" }, phone: callablePhone(lead), at: lead.nextActionAt });
  for (const draft of overview.toReview) items.push({ key: `review-${draft.id}`, kind: "review", leadId: draft.lead.id, company: draft.lead.companyName, title: `Review the draft for ${draft.lead.companyName}`, detail: draftSummary(draft), badge: { label: "To review", tone: "purple" }, phone: callablePhone(draft.lead), href: `/sales/live/review?draft=${encodeURIComponent(draft.id)}`, at: draft.updatedAt, draft });
  for (const lead of overview.needsYou) items.push({ key: `decide-${lead.id}`, kind: "decide", leadId: lead.id, company: lead.companyName, title: `Decide on ${lead.companyName}`, detail: lead.verdict?.summary || lead.why || "Claude wants your call on this one.", badge: { label: "Needs you", tone: "red" }, phone: callablePhone(lead) });
  // Kind first (most urgent kinds on top), then oldest first inside a kind.
  return items.map((item, index) => ({ item, index })).sort((a, b) => ORDER.indexOf(a.item.kind) - ORDER.indexOf(b.item.kind) || (a.item.at ?? "").localeCompare(b.item.at ?? "") || a.index - b.index).map(({ item }) => item);
}

/** The one line under the greeting. */
export function summarize(counts: SalesOverview["counts"]): string {
  const parts = [
    counts.replies > 0 && `${plural(counts.replies, "reply", "replies")} waiting`,
    counts.callsDue > 0 && `${plural(counts.callsDue, "call")} due`,
    counts.readyToSend > 0 && `${plural(counts.readyToSend, "draft")} ready to send`,
    counts.toReview > 0 && `${plural(counts.toReview, "draft")} to review`,
    counts.needsYou > 0 && `${counts.needsYou} for you to decide`,
    counts.wonToHandOver > 0 && `${plural(counts.wonToHandOver, "won deal")} to hand over`,
    counts.followUpsDue > 0 && `${plural(counts.followUpsDue, "follow-up")} due`,
  ].filter((part): part is string => !!part);
  if (!parts.length) return counts.totalLeads > 0 ? "Nothing is waiting on you. Time to find the next leads." : "No leads yet. Find some, or add one by hand.";
  const shown = parts.slice(0, 4); const rest = parts.length - shown.length;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
  return `${list}${rest ? `, plus ${plural(rest, "other thing")}` : ""}.`;
}

/** The buttons for one queue item. `big` makes them phone-sized and spells out "Call". */
export function QueueActions({ item, big = false, onDone, mainLabel }: { item: QueueItem; big?: boolean; onDone?: () => void; /** Replaces the main button text (e.g. "Read and approve"). */ mainLabel?: string }) {
  const { openLead, refresh } = useSalesShell();
  const { create, busyId } = useDeliveryWork(() => { refresh(); onDone?.(); });
  const meta = KIND_META[item.kind];
  const tel = item.phone ? telHref(item.phone) : undefined;
  const canCall = !!tel && (item.kind === "reply" || item.kind === "call" || item.kind === "follow" || item.kind === "decide");
  const callIsMain = item.kind === "call" && canCall;
  const size = big ? "!min-h-12 flex-1 !text-[15px]" : "!min-h-9 !px-3.5 !text-[13px]";
  const labelled = big || callIsMain;

  const callButton = canCall && tel ? <a href={tel} aria-label={`Call ${item.company}`} className={clsx(callIsMain ? primaryClass : secondaryClass, labelled ? size : "!min-h-9 !w-9 shrink-0 !px-0")}><Phone size={big ? 18 : 15} className="shrink-0" />{labelled ? "Call" : null}</a> : null;
  const openButton = <button type="button" onClick={() => openLead(item.leadId)} className={clsx(callIsMain ? secondaryClass : primaryClass, size)}>{callIsMain ? "Open" : mainLabel ?? meta.action}</button>;

  if (item.kind === "won") return <button type="button" disabled={busyId === item.leadId} onClick={() => void create(item.leadId, item.company)} className={clsx(primaryClass, size)}>{busyId === item.leadId ? "Creating…" : meta.action}</button>;
  if (callIsMain) return <>{callButton}{openButton}</>;
  return <>{callButton}{item.href ? <Link href={item.href} className={clsx(primaryClass, size)}>{mainLabel ?? meta.action}</Link> : openButton}</>;
}

/** One row of the desktop queue. */
export function QueueRow({ item }: { item: QueueItem }) {
  const { openLead } = useSalesShell();
  const meta = KIND_META[item.kind];
  const KindIcon = meta.icon;
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3.5 transition-colors duration-150 hover:bg-neutral-50 sm:px-5">
    <span aria-hidden="true" className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", TILE[meta.tone])}><KindIcon size={17} /></span>
    <button type="button" onClick={() => openLead(item.leadId)} className="min-w-0 flex-1 basis-48 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
      <span className="block truncate text-sm font-semibold text-neutral-800">{item.title}</span>
      <span className="mt-0.5 block truncate text-xs text-neutral-500">{item.detail}</span>
    </button>
    <Badge tone={item.badge.tone}>{item.badge.label}</Badge>
    <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1"><QueueActions item={item} /></div>
  </li>;
}

