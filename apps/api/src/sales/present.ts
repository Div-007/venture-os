// How stored Sales rows leave the API: `id` instead of `_id`, dates as ISO strings, no nulls or internal fields, and the
// small lead cards and "why" lines the Overview, Inbox and Review screens show.
import type { AppDocument } from "../db.js";
import { jsonValue } from "../json.js";
import { normalizeStage } from "./rules.js";
import { FOLLOW_UP_WORKING_DAYS } from "./rules.js";
import { workingDaysBetween, type WorkCalendar } from "./workdays.js";

const INTERNAL_FIELDS = new Set(["deletedAt", "deletedBy", "suppressKeys", "suppressKeysV", "disqualifiedByVerdict", "approvedForContactBy", "payloadHash", "importUpdatedAt", "claimedBy", "key", "rawValue", "keyV"]);

/** A stored row as API JSON. Fields the driver wrote as null (it turns undefined into null) read as absent. */
export function present(doc: AppDocument): Record<string, unknown> {
  return jsonValue(Object.fromEntries(Object.entries(doc).filter(([key, value]) => value !== null && value !== undefined && !INTERNAL_FIELDS.has(key)))) as Record<string, unknown>;
}

export function leadJson(lead: AppDocument): Record<string, unknown> {
  return present({ ...lead, stage: normalizeStage(lead.stage) });
}

/** The small lead summary shown beside drafts and inbox items, with the offer it is pursued for. */
export function leadSummary(lead: AppDocument) {
  return present({
    _id: lead._id, ventureId: lead.ventureId, offerId: lead.offerId, companyName: lead.companyName ?? "", contactName: lead.contactName ?? "", city: lead.city, stage: normalizeStage(lead.stage), ownerId: lead.ownerId,
    contactRoutes: lead.contactRoutes ?? [], observedSignal: lead.observedSignal ?? "", verdict: lead.verdict, whatsappOptIn: lead.whatsappOptIn, doNotContact: lead.doNotContact === true,
  });
}

export function leadCard(lead: AppDocument, why: string) {
  return present({
    _id: lead._id, ventureId: lead.ventureId, offerId: lead.offerId, companyName: lead.companyName ?? "", contactName: lead.contactName ?? "", city: lead.city, stage: normalizeStage(lead.stage), ownerId: lead.ownerId,
    nextAction: lead.nextAction ?? "", nextActionAt: lead.nextActionAt, verdict: lead.verdict, whatsappOptIn: lead.whatsappOptIn, contactRoutes: lead.contactRoutes ?? [], doNotContact: lead.doNotContact === true, why,
  });
}

export function ago(then: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const CHANNEL_LABEL: Record<string, string> = { email: "email", whatsapp: "WhatsApp", linkedin: "LinkedIn", call: "a call", meeting: "a meeting", note: "a note" };

export type WhyContext =
  | { kind: "reply"; activity: AppDocument; now: Date }
  | { kind: "call"; now: Date; dayStart: Date }
  | { kind: "followUp"; now: Date; calendar?: WorkCalendar; followUpDays?: number }
  | { kind: "needsYou" }
  | { kind: "won" };

/** One plain sentence on why a lead is in a queue: "Replied on WhatsApp 2 h ago", "Follow-up due (day 4)", "Claude: hold, low confidence". */
export function whyFor(lead: AppDocument, context: WhyContext): string {
  switch (context.kind) {
    case "reply": {
      const channel = String(context.activity.kind);
      const label = CHANNEL_LABEL[channel] ?? channel;
      return `${channel === "call" ? "Called us" : channel === "meeting" ? "Met us" : `Replied on ${label}`} ${ago(new Date(context.activity.at), context.now)}`;
    }
    case "call": {
      const due = lead.nextActionAt ? new Date(lead.nextActionAt) : undefined;
      if (!due) return "Approved for contact: ready for a first call";
      const label = String(lead.nextAction || "Call");
      return due < context.dayStart ? `${label}: overdue (was due ${ago(due, context.now)})` : `${label}: due today`;
    }
    case "followUp": {
      const from = lead.lastTouchAt ? new Date(lead.lastTouchAt) : undefined;
      const day = from ? workingDaysBetween(from, context.now, context.calendar) : (context.followUpDays ?? FOLLOW_UP_WORKING_DAYS) + (lead.followUpDueAt ? workingDaysBetween(new Date(lead.followUpDueAt), context.now, context.calendar) : 0);
      return `Follow-up due (day ${Math.max(day, 1)})`;
    }
    case "needsYou": {
      const verdict = lead.verdict as { decision?: string; confidence?: string } | undefined;
      return verdict?.decision ? `Claude: ${verdict.decision}, ${verdict.confidence ?? "unknown"} confidence` : "Needs your decision";
    }
    case "won": return "Won: create delivery work";
  }
}
