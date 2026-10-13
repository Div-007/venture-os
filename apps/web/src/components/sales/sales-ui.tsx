"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { LOST_REASONS, PRE_CONTACT_STAGES, STAGE_PROBABILITY, WON_STAGES, type CALL_OUTCOMES, type ContactRoute, type Lead, type LostReason, type REPLY_TYPES, type SalesStage } from "@venture-studio/contracts";
import { Badge, filterControl } from "@/components/studio/primitives";
import type { SalesSession } from "@/components/sales/sales-context";
import { Package } from "@/components/sales/lead-icons";

export { Phone, Trash2, Lock, NotebookPen, CalendarClock, Flag, Globe, ClipboardCheck } from "@/components/sales/lead-icons";

// Small shared pieces for the Sales tabs. Keep labels in one place.

export const STAGE_LABELS: Record<SalesStage, string> = {
  identified: "Identified", researched: "Researched", approved_for_contact: "Ready to contact", contacted: "Contacted", replied: "Replied",
  discovery_booked: "Call booked", qualified: "Qualified", proposal: "Proposal", invoice_contract: "Won · invoice", cash_collected: "Won · paid",
  delivery: "In delivery", retained_referred: "Retained", thinking: "Thinking", lost: "Lost", disqualified: "Not a fit",
};

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
const STAGE_TONES: Record<SalesStage, Tone> = {
  identified: "neutral", researched: "neutral", approved_for_contact: "blue", contacted: "blue", replied: "purple", discovery_booked: "purple", qualified: "purple",
  proposal: "amber", invoice_contract: "green", cash_collected: "green", delivery: "green", retained_referred: "green", thinking: "amber", lost: "red", disqualified: "neutral",
};

export function StageChip({ stage }: { stage: SalesStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>;
}

export function VerdictChip({ verdict }: { verdict?: { decision: "recommend" | "hold" | "reject"; confidence: "low" | "medium" | "high"; overridden?: boolean } }) {
  if (!verdict) return <Badge>Not judged</Badge>;
  const tone: Tone = verdict.decision === "recommend" ? "green" : verdict.decision === "hold" ? "amber" : "red";
  const word = verdict.decision === "recommend" ? "Go" : verdict.decision === "hold" ? "Hold" : "No";
  return <Badge tone={tone}>{word} · {verdict.confidence}{verdict.overridden ? " · changed" : ""}</Badge>;
}

/** The offer a lead is pursued for, as a quiet chip (shown where a venture sells more than one). */
export function OfferChip({ name }: { name: string }) {
  return <span title={`Offer: ${name}`} className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 rounded-md bg-neutral-100 px-2 py-1 text-[11px] font-semibold text-neutral-600"><Package size={12} aria-hidden="true" className="shrink-0 text-neutral-400" /><span className="truncate">{name}</span></span>;
}

// ---- Stage groups: the seven Pipeline columns (spec §2). Also the stage filter on Leads and the funnel on Overview. ----

export type StageGroupKey = "new" | "contacted" | "talking" | "meeting" | "proposal" | "won" | "closed";
export type StageGroup = { key: StageGroupKey; label: string; stages: readonly SalesStage[]; /** Where a card lands when dropped on the column; null asks first (lost or not a fit). */ dropStage: SalesStage | null; tone: Tone };
export const STAGE_GROUPS: readonly StageGroup[] = [
  { key: "new", label: "New", stages: ["identified", "researched", "approved_for_contact"], dropStage: "identified", tone: "neutral" },
  { key: "contacted", label: "Contacted", stages: ["contacted"], dropStage: "contacted", tone: "blue" },
  { key: "talking", label: "Talking", stages: ["replied", "thinking"], dropStage: "replied", tone: "purple" },
  { key: "meeting", label: "Meeting", stages: ["discovery_booked", "qualified"], dropStage: "discovery_booked", tone: "purple" },
  { key: "proposal", label: "Proposal", stages: ["proposal"], dropStage: "proposal", tone: "amber" },
  { key: "won", label: "Won", stages: WON_STAGES, dropStage: "invoice_contract", tone: "green" },
  { key: "closed", label: "Closed", stages: ["lost", "disqualified"], dropStage: null, tone: "red" },
];
export const stageGroup = (key: string | null | undefined) => STAGE_GROUPS.find((group) => group.key === key);
export const groupOfStage = (stage: SalesStage) => STAGE_GROUPS.find((group) => group.stages.includes(stage)) ?? STAGE_GROUPS[0]!;
export const isWonStage = (stage: SalesStage) => WON_STAGES.includes(stage);
export const stageList = (group: StageGroup) => group.stages.join(",");

export const CALL_OUTCOME_LABELS: Record<(typeof CALL_OUTCOMES)[number], string> = {
  interested_book: "Interested: book a call", send_details: "Asked for details", call_back: "Call back later", no_answer: "No answer", busy: "Busy",
  not_interested: "Not interested", wrong_person: "Wrong person", wrong_number: "Wrong number", yes_whatsapp: "Said yes to WhatsApp",
};
export const REPLY_TYPE_LABELS: Record<(typeof REPLY_TYPES)[number], string> = {
  interested: "Interested", send_details: "Wants details", price_first: "Asks the price first", not_now: "Not now", wrong_person: "Wrong person",
  has_system: "Already has a system", opt_out: "Asked us to stop", silence: "No reply", unclear: "Unclear", hostile: "Hostile",
};
export const LOST_REASON_LABELS: Record<LostReason, string> = {
  price: "Price was too high", no_budget: "No budget", no_need: "No real need", timing: "Bad timing", chose_competitor: "Chose a competitor",
  no_response: "Stopped replying", not_a_fit: "Not a fit", wrong_person: "Wrong person", other: "Something else",
};
export { LOST_REASONS, STAGE_PROBABILITY };
export const CHANNEL_LABELS: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", call: "Call", linkedin: "LinkedIn", meeting: "Meeting", note: "Note", call_opener: "Call script" };
export const DRAFT_STATUS_LABELS: Record<string, string> = { draft: "Draft", in_review: "In review", ready: "Ready to send", needs_changes: "Needs changes", sent: "Sent", vetoed: "Vetoed", discarded: "Discarded" };

// ---- Money (stored in minor units: paise, cents) ----

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED"] as const;
const trimmed = (value: number, digits: number) => String(Number(value.toFixed(digits)));
/** A code Intl does not know (the API refuses them, but old data may hold one) is shown as a plain number and the code: "12,500 XYZ". */
const plainMoney = (value: number, currency: string, locale = "en-US") => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)} ${String(currency).toUpperCase().slice(0, 8)}`.trim();
/** Full amount with the local digit grouping: ₹12,34,567 for rupees, $1,234,567 for dollars. Never throws on a bad currency code. */
export function moneyFull(minor: number, currency = "INR"): string {
  const locale = currency === "INR" ? "en-IN" : "en-US";
  try { return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100); }
  catch { return plainMoney(minor / 100, currency, locale); }
}
/** Short form for cards: ₹12.4L, ₹3.5 Cr, $12.4K. Under a lakh the full amount is short enough. */
export function moneyShort(minor: number, currency = "INR"): string {
  const value = minor / 100;
  if (currency === "INR") {
    if (Math.abs(value) >= 1e7) return `₹${trimmed(value / 1e7, 2)} Cr`;
    if (Math.abs(value) >= 1e5) return `₹${trimmed(value / 1e5, 1)}L`;
    return moneyFull(minor, currency);
  }
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(value); }
  catch { return plainMoney(value, currency); }
}
/** "₹12.4L + $3K" for rows in several currencies; "₹0" when there is nothing. */
export function moneyLine(rows: { currency: string; minor: number }[], short = true): string {
  const parts = rows.filter((row) => row.minor > 0).map((row) => short ? moneyShort(row.minor, row.currency) : moneyFull(row.minor, row.currency));
  return parts.length ? parts.join(" + ") : "₹0";
}
/** An amount typed by a person ("12,50,000" or "1250000.50") as minor units, or null when it is not an amount. */
export function parseMoney(text: string): number | null {
  const clean = text.replace(/[\s,₹$€£]/g, "");
  if (!clean || !/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}
export const minorToInput = (minor?: number) => minor ? String(minor / 100) : "";
/** The chance (0 to 100) a lead counts with: its own, else its stage's default. */
export const probabilityOf = (lead: { stage: SalesStage; probability?: number | undefined }) => lead.probability ?? STAGE_PROBABILITY[lead.stage];

// ---- Dates and text ----

/** "Today 4:30 pm", "Tomorrow", "12 Oct", or "No date". */
export function when(value?: string, now = new Date()): string {
  if (!value) return "No date";
  const date = new Date(value);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(date) - day(now)) / 86_400_000);
  const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(date);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(date);
}

/** "just now", "5m ago", "3h ago", "2d ago", then "12 Oct". */
export function timeAgo(value?: string, now = Date.now()): string {
  if (!value) return "";
  const diff = Math.max(0, now - new Date(value).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(value));
}

/** "1h 20m" style span since a moment, for items that are waiting. */
export function waiting(value?: string, now = Date.now()): string {
  if (!value) return "";
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const absoluteDate = (value?: string) => value ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "";
export const isOverdue = (value?: string, now = Date.now()) => !!value && new Date(value).getTime() < now;
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
export const snippet = (text: string, length = 120) => { const clean = text.replace(/\s+/g, " ").trim(); return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean; };
export const number = (value: number) => new Intl.NumberFormat("en-IN").format(value);
/** A value for <input type="datetime-local"> in the viewer's own time zone. */
export function toLocalInput(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const newRequestId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// ---- Contact routes ----

type Routed = { contactRoutes: ContactRoute[] };
// Links are only built from plain values: one email address, one dialable number. Anything else (old data, a pasted list, mailto
// parameters) is shown as text without a link.
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PLAIN_NUMBER = /^[+()\d\s./-]{6,40}$/;
export const isPlainEmail = (value: string) => PLAIN_EMAIL.test(value.trim());
export const isDialable = (value: string) => PLAIN_NUMBER.test(value.trim()) && value.replace(/\D/g, "").length >= 6;
export const routeOf = (lead: Routed, kind: ContactRoute["kind"]) => lead.contactRoutes.find((route) => route.kind === kind);
/** The first phone route that can be dialled, or undefined. */
export const phoneOf = (lead: Routed) => lead.contactRoutes.find((route) => route.kind === "phone" && isDialable(route.value))?.value;
/** The first email route that is one plain address, or undefined. */
export const emailOf = (lead: Routed) => lead.contactRoutes.find((route) => route.kind === "email" && isPlainEmail(route.value))?.value;
export const telHref = (value: string): string | undefined => isDialable(value) ? `tel:${value.replace(/[^\d+]/g, "")}` : undefined;
export const mailHref = (value: string): string | undefined => isPlainEmail(value) ? `mailto:${value.trim()}` : undefined;
/** wa.me wants digits with the country code; a bare 10-digit Indian number gets 91. */
export function waDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}
export const waHref = (value: string): string | undefined => {
  const digits = waDigits(value);
  return isDialable(value) && digits.length >= 10 && digits.length <= 15 ? `https://wa.me/${digits}` : undefined;
};
/** The WhatsApp number to open, or undefined: only for a lead that opted in. */
export function whatsappTarget(lead: Routed & Pick<Lead, "whatsappOptIn">): string | undefined {
  if (!lead.whatsappOptIn) return undefined;
  return lead.contactRoutes.find((route) => route.kind === "whatsapp" && isDialable(route.value))?.value ?? phoneOf(lead);
}
/**
 * No calls, email or WhatsApp for a lead on the do-not-contact list. Overview and draft summaries do not carry the flag, and an
 * opt-out or hostile reply always ends in "disqualified", so that stage counts as blocked too.
 */
export const contactBlocked = (lead: { stage: SalesStage; doNotContact?: boolean }) => lead.doNotContact === true || lead.stage === "disqualified";
/** The number to put behind a Call button: dialable, and never for a lead that must not be contacted. */
export const callablePhone = (lead: Routed & { stage: SalesStage; doNotContact?: boolean }) => contactBlocked(lead) ? undefined : phoneOf(lead);
export const OPT_IN_LABELS: Record<string, string> = { they_messaged: "They messaged us first", yes_on_call: "They said yes on a call", yes_by_email: "They said yes by email", form: "They agreed on a form" };
export const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
export const safeUrl = (url?: string) => { if (!url) return undefined; try { return ["http:", "https:"].includes(new URL(url).protocol) ? url : undefined; } catch { return undefined; } };

// ---- Permissions (the API enforces the same rules; this only hides what would be refused) ----

export type SalesPermissionSession = Pick<NonNullable<SalesSession>, "user" | "membership">;
export const isManager = (session: SalesPermissionSession, ventureId: string) => session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.includes(ventureId));
export const canCreateLeads = (session: SalesPermissionSession) => session.membership.role !== "learner";
export const canEditLead = (session: SalesPermissionSession, lead: Pick<Lead, "ventureId" | "ownerId">) => isManager(session, lead.ventureId) || (["contributor", "reviewer"].includes(session.membership.role) && lead.ownerId === session.user.id);
export const canDeleteLead = (session: SalesPermissionSession, lead: Pick<Lead, "ventureId" | "ownerId" | "stage" | "lastTouchAt">) => isManager(session, lead.ventureId) || (canEditLead(session, lead) && PRE_CONTACT_STAGES.includes(lead.stage) && !lead.lastTouchAt);

// ---- Hooks and small controls ----

/** Query-string state for a Sales page: `update` keeps every other parameter (venture, lead) and never scrolls. */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const update = useCallback((changes: Record<string, string | null | undefined>, mode: "replace" | "push" = "replace") => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) { if (value === null || value === undefined || value === "") next.delete(key); else next.set(key, value); }
    const text = next.toString();
    router[mode](text ? `${pathname}?${text}` : pathname, { scroll: false });
  }, [router, pathname]);
  return { params, update };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(timer); }, [value, ms]);
  return debounced;
}

/** A pill toggle that sits in a filter row beside the select pills. */
export function FilterChip({ active, onClick, children, className }: { active: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={clsx(filterControl(active), "inline-flex items-center gap-1.5 whitespace-nowrap transition-transform active:scale-[0.97]", className)}>{children}</button>;
}

/** Initials in a soft circle, with the first name beside it when there is room. */
export function PersonChip({ name, compact = false }: { name: string; compact?: boolean }) {
  return <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold text-neutral-600"><span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary-50 text-[10px] font-bold text-primary-700">{initials(name)}</span>{!compact && <span className="truncate">{firstName(name)}</span>}</span>;
}
