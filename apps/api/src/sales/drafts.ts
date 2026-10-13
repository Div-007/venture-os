// Draft state machine: draft -> in_review -> ready | needs_changes; edits return to in_review; sent, vetoed and discarded end it.
// Written by Claude or a person, reviewed in a separate pass, sent by a person (docs/sales-dealflow.md sections 1 and 5).
import type { AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import type { Via } from "./access.js";
import type { SalesSettings } from "./settings.js";

/** Statuses a draft can still change from. */
export const OPEN_DRAFT_STATUSES = ["draft", "in_review", "ready", "needs_changes"] as const;
export const isOpenDraft = (draft: AppDocument) => (OPEN_DRAFT_STATUSES as readonly string[]).includes(String(draft.status));

/**
 * A ready draft waits for a person's approval before it can be sent: the first batch of a play that no person has read yet
 * (venture setting "claude_review_enough"), or every message ("person_approves_every_message"; call openers are scripts, not messages).
 * In the every-message mode any approval (the lead's owner's too) lets it go; a play's first batch needs a head's or admin's approval
 * (`personApproval.byHead`; approvals stored before that flag existed were a head's).
 */
export function needsPersonApproval(draft: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode">): boolean {
  if (draft.status !== "ready") return false;
  if (settings?.approvalMode === "person_approves_every_message") return draft.channel !== "call_opener" && !draft.personApproval;
  const headApproved = Boolean(draft.personApproval) && draft.personApproval.byHead !== false;
  return !headApproved && Boolean(draft.playId) && Boolean(play) && play!.firstBatchReviewed !== true;
}

/** Why a draft waits for a person (the payload's `needsPersonApproval` and `approvalReason`): "every_message" or "first_batch", or nothing. */
export function approvalNeed(draft: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode">): { needsPersonApproval: boolean; approvalReason: "first_batch" | "every_message" | null } {
  if (!needsPersonApproval(draft, play, settings)) return { needsPersonApproval: false, approvalReason: null };
  return { needsPersonApproval: true, approvalReason: settings?.approvalMode === "person_approves_every_message" ? "every_message" : "first_batch" };
}

/** The channel a draft is sent on, as the venture's allowed-channels setting names it (a call opener is a call). */
export const channelOf = (draft: Record<string, any>): string => (draft.channel === "call_opener" ? "call" : String(draft.channel));

/** Why a draft cannot be marked sent right now, or undefined when it can. */
export function sendBlocker(draft: AppDocument, lead: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode" | "allowedChannels">): string | undefined {
  if (draft.status === "sent") return "This draft was already marked sent";
  if (draft.status !== "ready") return "Only a draft that passed review (ready) can be marked sent";
  if (draft.channel === "call_opener") return "A call opener is a script for call mode: it cannot be marked sent";
  if (lead.doNotContact) return "This lead is on the do-not-contact list";
  if (draft.channel === "whatsapp" && !lead.whatsappOptIn) return "No WhatsApp message goes out before the lead opts in (they message first, or say yes on a call or by email)";
  if (settings && !settings.allowedChannels.includes(channelOf(draft) as never)) return `This venture does not use ${channelOf(draft)} for outreach (see its sales settings)`;
  if (needsPersonApproval(draft, play, settings)) return settings?.approvalMode === "person_approves_every_message" ? "This venture needs a person's approval for every message before it is sent" : "The first batch of a play needs a person's approval before it is sent";
  return undefined;
}

/** What the Overview's "ready to send" list shows: ready, approved where needed, and sendable to this lead. */
export const canSendNow = (draft: AppDocument, lead: AppDocument, play: AppDocument | null | undefined, settings?: Pick<SalesSettings, "approvalMode" | "allowedChannels">) => sendBlocker(draft, lead, play, settings) === undefined;

/** The status after a review: pass -> ready, fail -> needs_changes. Throws when the draft is not waiting for review or the review comes from the writing session. */
export function reviewOutcome(draft: AppDocument, input: { result: "pass" | "fail"; sessionId?: string | undefined }, via: Via): "ready" | "needs_changes" {
  if (draft.status !== "in_review") throw new AppError(409, "CONFLICT", draft.status === "ready" || draft.status === "needs_changes" ? "This draft was already reviewed; edit it to send it back to review" : "Only a draft waiting for review can be reviewed");
  // Claude never approves its own work: its review of a Claude draft must come from another session than the one that wrote it.
  if (draft.authorVia === "claude" && via === "claude" && (!input.sessionId || input.sessionId === draft.authorSessionId)) {
    throw new AppError(409, "CONFLICT", "A Claude review of a Claude draft must come from a different session than the one that wrote it (send this session's sessionId)");
  }
  return input.result === "pass" ? "ready" : "needs_changes";
}
