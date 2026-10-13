// Sales rules engine: stage transitions, what an activity, a verdict or an override does to a lead, and the verdict mapping.
// Everything here is pure (no database): the routes load a lead, ask for a plan, and write it. One place for the rules in
// docs/sales-dealflow.md section 5.
import { z } from "zod";
import { EXIT_STAGES, LEGACY_STAGE_MAP, PRE_CONTACT_STAGES, SALES_STAGES, WON_STAGES, activityInputSchema, verdictInputSchema, type SalesStage } from "@venture-studio/contracts";
import type { AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import type { Via } from "./access.js";
import { DEFAULT_SETTINGS, calendarOf, type SalesSettings } from "./settings.js";
import { FOLLOW_UP_HOUR, addWorkingDays, addWorkingHours, nextWorkingDay, workingMomentAfterDays } from "./workdays.js";

export type LeadDoc = AppDocument;
export type ActivityInput = z.infer<typeof activityInputSchema>;
export type VerdictInput = z.infer<typeof verdictInputSchema>;

export const OUTBOUND_KINDS = ["call", "email", "whatsapp", "linkedin"] as const;
/** Working days from a first touch to the follow-up. */
export const FOLLOW_UP_WORKING_DAYS = 4;

/** An activity may be dated this far ahead (clock differences); further is refused. */
export const FUTURE_SLACK_MS = 60 * 60_000;
const RANK = new Map<SalesStage, number>(SALES_STAGES.map((stage, index) => [stage, index]));
export const isWonStage = (stage: string) => (WON_STAGES as readonly string[]).includes(stage);
export const isExitStage = (stage: string) => (EXIT_STAGES as readonly string[]).includes(stage);
export const isPreContactStage = (stage: string) => (PRE_CONTACT_STAGES as readonly string[]).includes(stage);
/** Stages from which a first reply or touch still moves the lead along: before first contact, or contacted. */
const EARLY_STAGES: readonly string[] = [...PRE_CONTACT_STAGES, "contacted"];

/** A stored stage name as a current stage (older names are mapped; anything unknown reads as identified). */
export function normalizeStage(value: unknown): SalesStage {
  const mapped = typeof value === "string" && value in LEGACY_STAGE_MAP ? LEGACY_STAGE_MAP[value] : value;
  return (SALES_STAGES as readonly unknown[]).includes(mapped) ? mapped as SalesStage : "identified";
}

/** The target stage when it is further along than the current one; thinking, lost and disqualified leads are reopened; won stays won. */
export function forwardStage(current: SalesStage, target: SalesStage): SalesStage {
  if (isWonStage(current)) return current;
  if (current === "thinking" || isExitStage(current)) return target;
  return (RANK.get(current) ?? 0) < (RANK.get(target) ?? 0) ? target : current;
}

/**
 * Where Claude's own rule-driven moves (logging activity, sorting a reply) may take a lead: never out of lost or disqualified
 * (other than between those two), never to approved_for_contact or a won stage, never back to an earlier funnel stage.
 */
export function clampClaudeStage(from: SalesStage, to: SalesStage): SalesStage {
  if (to === from) return from;
  if (isExitStage(from)) return isExitStage(to) ? to : from;
  if (isWonStage(to) || to === "approved_for_contact") return from;
  if (isExitStage(to)) return isWonStage(from) ? from : to;
  if (from !== "thinking" && to !== "thinking" && (RANK.get(to) ?? 0) < (RANK.get(from) ?? 0)) return from;
  return to;
}

export type LeadChange = { set: Record<string, unknown>; unset: string[] };
export type DraftDiscard = "none" | "follow_ups" | "all";

export type ActivityPlan = LeadChange & {
  direction?: "in" | "out";
  at: Date;
  stageFrom: SalesStage;
  stageTo?: SalesStage;
  /** Which unsent drafts of the lead to discard: stop on reply (follow-ups), opt-out, lost. */
  discardDrafts: DraftDiscard;
  /** Reason for the suppression entries to create (opt-out, hostile), if any. */
  suppress?: string;
  enteredWon: boolean;
};

const maxDate = (a: unknown, b: Date): Date => (a && new Date(a as string | Date) > b ? new Date(a as string | Date) : b);

type NextAction = { text: string; at: Date | null };

/** Applies a stage change to a pending lead change: exit reason, follow-up clock, won date. Returns whether the lead entered a won stage. */
function applyStage(lead: LeadDoc, change: LeadChange, stageFrom: SalesStage, stage: SalesStage, exitReason: string | undefined, now: Date, lostReason?: string): boolean {
  let enteredWon = false;
  if (stage !== stageFrom) {
    change.set.stage = stage;
    // Who approved the lead and whether a verdict closed it describe the stage it just left.
    if (lead.approvedForContactBy !== undefined) change.unset.push("approvedForContactBy");
    if (lead.disqualifiedByVerdict !== undefined) change.unset.push("disqualifiedByVerdict");
    if (isExitStage(stage)) { change.set.exitReason = exitReason ?? lead.exitReason ?? ""; change.set.nextAction = ""; change.unset.push("nextActionAt"); }
    else if (lead.exitReason !== undefined) change.unset.push("exitReason");
    // Why it was lost belongs to the lost stage only.
    if (stage === "lost") { if (lostReason) change.set.lostReason = lostReason; } else if (lead.lostReason !== undefined) change.unset.push("lostReason");
    if (isWonStage(stage) && !isWonStage(stageFrom) && !lead.wonAt) { change.set.wonAt = now; enteredWon = true; }
  }
  // Only a lead waiting on its first answer carries a follow-up date.
  if (stage !== "contacted") { delete change.set.followUpDueAt; if (lead.followUpDueAt !== undefined) change.unset.push("followUpDueAt"); }
  return enteredWon;
}

function finish(change: LeadChange): LeadChange {
  const unset = [...new Set(change.unset)].filter((field) => !(field in change.set));
  return { set: change.set, unset };
}

/** What logging one activity does to the lead (docs/sales-dealflow.md section 5: outbound, inbound, reply types, call outcomes). */
export function planActivity(lead: LeadDoc, input: ActivityInput, ctx: { now: Date; actorId: string; via?: string; settings?: SalesSettings }): ActivityPlan {
  const { now } = ctx;
  const settings = ctx.settings ?? DEFAULT_SETTINGS;
  const cal = calendarOf(settings);
  const channelKind = (OUTBOUND_KINDS as readonly string[]).includes(input.kind);
  // A reply can also be given in person: a meeting may be inbound. Notes have no direction.
  const direction: "in" | "out" | undefined = channelKind ? (input.direction ?? (input.replyType ? "in" : "out")) : input.kind === "meeting" && (input.direction === "in" || input.replyType) ? "in" : undefined;
  if (input.replyType && direction !== "in") throw new AppError(400, "BAD_REQUEST", "A reply type needs an inbound message (direction \"in\")");
  // Silence ends a sequence (the follow-up rule); it is never a message from them.
  if (input.replyType === "silence") throw new AppError(400, "BAD_REQUEST", "Silence is not a reply: a lead that never answers is not logged as a message from them");
  if (input.callOutcome && !(input.kind === "call" && direction === "out")) throw new AppError(400, "BAD_REQUEST", "A call outcome belongs to an outbound call");
  if (direction === "out" && lead.doNotContact) throw new AppError(409, "CONFLICT", "This lead is on the do-not-contact list: nothing can be sent or logged as sent to it");
  const at = input.at ? new Date(input.at) : now;
  if (at.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new AppError(400, "BAD_REQUEST", "That time is in the future: log what already happened (a later next action goes in nextActionAt)");
  const claude = ctx.via === "claude";
  const stageFrom = normalizeStage(lead.stage);
  const change: LeadChange = { set: {}, unset: [] };
  let stage = stageFrom;
  let exitReason: string | undefined;
  let lostReason: string | undefined;
  let nextAction: NextAction | undefined;
  let discard: DraftDiscard = "none";
  let suppress: string | undefined;

  const touch = direction === "out" && input.callOutcome !== "wrong_number";
  if (touch) {
    change.set.lastTouchAt = maxDate(lead.lastTouchAt, at);
    if (isPreContactStage(stage)) stage = "contacted";
    if (!lead.lastTouchAt) change.set.followUpDueAt = addWorkingDays(at, settings.followUpAfterWorkingDays, FOLLOW_UP_HOUR, cal);
    // A touch on or after the follow-up date is the follow-up: the sequence stops there.
    else if (lead.followUpDueAt && at >= new Date(lead.followUpDueAt)) change.unset.push("followUpDueAt");
  }

  if (direction === "in") {
    change.set.lastTouchAt = maxDate(lead.lastTouchAt, at);
    if (EARLY_STAGES.includes(stage)) stage = "replied";
    change.unset.push("followUpDueAt");
    discard = "follow_ups";
    // Claude cannot grant the opt-in: a person records it by marking the message handled (see markHandled).
    if (input.kind === "whatsapp" && !lead.whatsappOptIn && !claude) change.set.whatsappOptIn = { at, by: ctx.actorId, how: "they_messaged" };
    switch (input.replyType) {
      case "opt_out": case "hostile":
        if (!isWonStage(stage)) { stage = "disqualified"; exitReason = input.replyType === "opt_out" ? "Asked not to be contacted" : "Hostile reply"; }
        suppress = input.replyType === "opt_out" ? "Asked not to be contacted" : "Hostile reply";
        discard = "all"; change.set.doNotContact = true;
        break;
      case "not_now":
        // Claude moves a lead to thinking only from replied (or contacted, which the reply has just moved to replied); a person decides for later stages.
        if (!isWonStage(stage)) { if (!claude || stage === "replied" || stage === "thinking") stage = "thinking"; nextAction = { text: "Check back: they said not now", at: workingMomentAfterDays(now, 30, FOLLOW_UP_HOUR, cal) }; }
        break;
      case "interested": nextAction = { text: "Book the discovery call", at: addWorkingHours(now, settings.replySlaHours, cal) }; break;
      case "send_details": nextAction = { text: "Send details", at: now }; break;
      case "wrong_person": nextAction = { text: "Find the right person", at: now }; break;
      case "price_first": nextAction = { text: "Answer price with a range and ask for a call", at: now }; break;
      default: break;
    }
  }

  switch (input.callOutcome) {
    case "interested_book": stage = forwardStage(stage, "discovery_booked"); nextAction = { text: "Discovery call", at: null }; break;
    case "send_details": stage = forwardStage(stage, "replied"); nextAction = { text: "Send details", at: now }; break;
    case "call_back": nextAction = { text: "Call back", at: input.nextActionAt ? new Date(input.nextActionAt) : nextWorkingDay(now, FOLLOW_UP_HOUR, cal) }; break;
    case "no_answer": case "busy": nextAction = { text: "Call again", at: nextWorkingDay(now, FOLLOW_UP_HOUR, cal) }; break;
    case "not_interested": if (!isWonStage(stage)) { stage = "lost"; exitReason = "Not interested on call"; lostReason = "no_need"; } break;
    case "wrong_person": nextAction = { text: "Find the right person", at: now }; break;
    case "yes_whatsapp":
      stage = forwardStage(stage, "replied");
      // Consent is a person's to record: Claude's log of a call does not grant it (POST /leads/:id/whatsapp-opt-in does).
      if (!lead.whatsappOptIn && !claude) change.set.whatsappOptIn = { at, by: ctx.actorId, how: "yes_on_call" };
      nextAction = { text: "Send details on WhatsApp", at: now };
      break;
    default: break; // wrong_number: a note only
  }

  if (claude) stage = clampClaudeStage(stageFrom, stage);
  // A closed lead stays closed when Claude logs on it: the activity is recorded, nothing else about the lead moves.
  const frozen = claude && isExitStage(stageFrom) && stage === stageFrom;
  if (frozen) nextAction = undefined;
  // What the person typed with the activity wins over the automatic next step.
  else if (input.nextAction !== undefined) nextAction = { text: input.nextAction, at: input.nextActionAt ? new Date(input.nextActionAt) : nextAction?.at ?? null };
  else if (input.nextActionAt) nextAction = { text: nextAction?.text ?? String(lead.nextAction ?? ""), at: new Date(input.nextActionAt) };
  if (nextAction) { change.set.nextAction = nextAction.text; if (nextAction.at) change.set.nextActionAt = nextAction.at; else change.unset.push("nextActionAt"); }

  const enteredWon = applyStage(lead, change, stageFrom, stage, exitReason, now, lostReason);
  if (stage !== stageFrom && isExitStage(stage) && discard !== "all") discard = "all";
  const { set, unset } = finish(change);
  return { set, unset, direction, at, stageFrom, ...(stage !== stageFrom ? { stageTo: stage } : {}), discardDrafts: discard, ...(suppress ? { suppress } : {}), enteredWon };
}

/**
 * Direct stage edits (PATCH, the older deal routes, creating a lead) by Claude: one step at a time along a short whitelist.
 * Everything else is a person's decision in the app: approving for contact, any won stage, reopening a lost or disqualified lead,
 * going back to an earlier stage, and skipping ahead. "Contacted" comes from logging the outreach (activities), not from an edit.
 * Closing a lead (lost, disqualified, with a reason) and moving it to thinking from contacted or replied are allowed.
 */
const CLAUDE_STEPS: Readonly<Record<string, readonly SalesStage[]>> = {
  identified: ["researched"], contacted: ["replied", "thinking"], replied: ["discovery_booked", "thinking"], thinking: ["replied"], discovery_booked: ["qualified"], qualified: ["proposal"],
};
export function assertClaudeMayMove(from: SalesStage, to: SalesStage): void {
  if (from === to) return;
  const person = (message: string) => new AppError(403, "FORBIDDEN", `${message}: a person does that in the app`);
  if (isWonStage(to)) throw person("Marking a deal won (invoice, cash, delivery) is a person's decision");
  if (to === "approved_for_contact") throw person("Approving a lead for contact is a person's decision");
  if (isExitStage(from)) { if (isExitStage(to)) return; throw person("Reopening a lost or disqualified lead is a person's decision"); }
  if (isWonStage(from)) throw person("A won deal is moved by a person");
  if (isExitStage(to)) return;
  if (CLAUDE_STEPS[from]?.includes(to)) return;
  if (to !== "thinking" && from !== "thinking" && (RANK.get(to) ?? 0) < (RANK.get(from) ?? 0)) throw person("A lead cannot go back to an earlier stage");
  throw person(`Claude moves a lead one step at a time (${from} -> ${(CLAUDE_STEPS[from] ?? []).join(" or ") || "nothing by itself"}); contacted comes from logging the outreach`);
}

/** A manual stage change (board drag, edit): exit stages need a reason; leaving contacted stops the follow-up clock. */
export function planStageChange(lead: LeadDoc, to: SalesStage, exitReason: string | undefined, now: Date, who?: { via: Via; actorId: string }, lostReason?: string): LeadChange & { stageFrom: SalesStage; stageTo?: SalesStage; enteredWon: boolean; discardDrafts: DraftDiscard } {
  const stageFrom = normalizeStage(lead.stage);
  const reason = exitReason?.trim() || (stageFrom === to ? String(lead.exitReason ?? "") : "");
  if (isExitStage(to) && !reason) throw new AppError(400, "BAD_REQUEST", "Say why: a lost or disqualified lead needs an exit reason");
  const change: LeadChange = { set: {}, unset: [] };
  const enteredWon = applyStage(lead, change, stageFrom, to, isExitStage(to) ? reason : undefined, now, lostReason);
  // A person moving a lead to approved_for_contact is remembered: Claude's later verdicts cannot pull it back.
  if (to === "approved_for_contact" && who?.via === "app") change.set.approvedForContactBy = who.actorId;
  const { set, unset } = finish(change);
  return { set, unset, stageFrom, ...(to !== stageFrom ? { stageTo: to } : {}), enteredWon, discardDrafts: to !== stageFrom && isExitStage(to) ? "all" : "none" };
}

// ---- Verdicts -------------------------------------------------------------------------------------------------------------

/**
 * Verdicts only move a lead that has not been contacted yet. A lead a verdict disqualified (and nobody contacted) is open again
 * for a person's new verdict or override, never for Claude's.
 */
export function openForVerdict(lead: LeadDoc, via: Via): boolean {
  const stage = normalizeStage(lead.stage);
  return isPreContactStage(stage) || (via === "app" && stage === "disqualified" && lead.disqualifiedByVerdict === true && !lead.lastTouchAt);
}

export const needsYouFor = (decision: string, confidence: string) => decision === "hold" || confidence === "low";

/** recommend (medium/high) -> approved_for_contact; recommend (low) or hold -> researched; reject (medium/high) -> disqualified; a low-confidence reject only asks a person (researched + needs you). */
export function verdictStage(decision: "recommend" | "hold" | "reject", confidence: "low" | "medium" | "high"): SalesStage {
  if (decision === "reject") return confidence === "low" ? "researched" : "disqualified";
  if (decision === "hold") return "researched";
  return confidence === "low" ? "researched" : "approved_for_contact";
}

const notAFit = (text: string) => `Not a fit: ${text}`.slice(0, 500);
type Who = { via: Via; actorId: string };

function verdictChange(lead: LeadDoc, summary: Record<string, unknown>, to: SalesStage, reason: string, needsYou: boolean, now: Date, who: Who) {
  const stageFrom = normalizeStage(lead.stage);
  const change: LeadChange = { set: { verdict: summary, needsYou }, unset: [] };
  let enteredWon = false;
  let stage = stageFrom;
  // Claude never pulls a lead back from where it is: on a lead already approved for contact, a hold, a low-confidence recommend or a
  // reject leaves the stage and asks a person (needs you) instead.
  if (who.via === "claude" && stageFrom === "approved_for_contact" && to !== "approved_for_contact") change.set.needsYou = true;
  else if (openForVerdict(lead, who.via)) {
    stage = to;
    enteredWon = applyStage(lead, change, stageFrom, stage, to === "disqualified" ? notAFit(reason) : undefined, now);
    if (stage === "disqualified") change.set.disqualifiedByVerdict = true;
  }
  // A person's own verdict (or override) that approves a lead is a person's approval.
  if (who.via === "app" && stage === "approved_for_contact") change.set.approvedForContactBy = who.actorId;
  const { set, unset } = finish(change);
  return { set, unset, stageFrom, ...(stage !== stageFrom ? { stageTo: stage } : {}), enteredWon, discardDrafts: (stage !== stageFrom && isExitStage(stage) ? "all" : "none") as DraftDiscard };
}

/** Saving a verdict: summary (with who set it) and needs-you flag on the lead, and the stage move for a lead before first contact. */
export function planVerdict(lead: LeadDoc, input: VerdictInput, verdictId: string, now: Date, who: Who) {
  const summary = { verdictId, decision: input.decision, confidence: input.confidence, summary: input.summary, at: now, overridden: false, via: who.via, by: who.actorId };
  const result = verdictChange(lead, summary, verdictStage(input.decision, input.confidence), input.summary, needsYouFor(input.decision, input.confidence), now, who);
  result.set.evidenceConfidence = input.confidence;
  if (input.signal && !String(lead.observedSignal ?? "").trim()) result.set.observedSignal = input.signal.slice(0, 2_000);
  if (input.offerFit && !String(lead.fitReason ?? "").trim()) result.set.fitReason = input.offerFit.slice(0, 2_000);
  return result;
}

/** A person's override: the same mapping with the person's decision (treated as certain), and the needs-you flag is cleared. */
export function planOverride(lead: LeadDoc, current: Record<string, unknown>, decision: "recommend" | "hold" | "reject", reason: string, now: Date, actorId: string) {
  const who: Who = { via: "app", actorId };
  const summary = { ...current, decision, at: now, overridden: true, via: who.via, by: actorId };
  return verdictChange(lead, summary, verdictStage(decision, "high"), reason, false, now, who);
}

// ---- Do not contact -------------------------------------------------------------------------------------------------------

/** Whether a lead may be written to or sent anything. */
export const canContact = (lead: LeadDoc) => !lead.doNotContact;
