import { z } from "zod";
import { idSchema, isoDateSchema, timezoneSchema } from "./common.js";

// Sales (Dealflow). One lead record ("opportunity") moves through the founders' SLS-01 stages; see docs/sales-dealflow.md.

export const pipelineInputSchema = z.object({ ventureId: idSchema, name: z.string().trim().min(1).max(120), offerName: z.string().trim().min(1).max(200), status: z.enum(["active", "paused", "archived"]).default("active") });
// Zod keeps .default() values inside .partial(); updates override defaulted fields so an omitted field is never overwritten.
export const updatePipelineSchema = pipelineInputSchema.omit({ ventureId: true }).extend({ status: z.enum(["active", "paused", "archived"]) }).partial().refine((value) => Object.keys(value).length > 0);
export const pipelineSchema = pipelineInputSchema.extend({ id: idSchema, workspaceId: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema });

export const SALES_STAGES = ["identified", "researched", "approved_for_contact", "contacted", "replied", "discovery_booked", "qualified", "proposal", "invoice_contract", "cash_collected", "delivery", "retained_referred", "thinking", "lost", "disqualified"] as const;
export const salesStageSchema = z.enum(SALES_STAGES);
export type SalesStage = z.infer<typeof salesStageSchema>;
/** Stages a deal has been won in: entering the first of these from any other stage notifies the team to create delivery work. */
export const WON_STAGES: readonly SalesStage[] = ["invoice_contract", "cash_collected", "delivery", "retained_referred"];
/** Exit stages need a reason. */
export const EXIT_STAGES: readonly SalesStage[] = ["lost", "disqualified"];
/** Before first contact. */
export const PRE_CONTACT_STAGES: readonly SalesStage[] = ["identified", "researched", "approved_for_contact"];
/** Older Venture OS stage names, accepted on input and migrated in stored records. */
export const LEGACY_STAGE_MAP: Readonly<Record<string, SalesStage>> = { conversation: "replied", won: "invoice_contract" };
const stageInput = z.preprocess((value) => typeof value === "string" && value in LEGACY_STAGE_MAP ? LEGACY_STAGE_MAP[value] : value, salesStageSchema);

export const confidenceSchema = z.enum(["low", "medium", "high"]);
/** Links we store must be web links: a stored `javascript:` or `data:` URL is never acceptable, even though the web guards hrefs. */
export const webUrlSchema = z.url({ protocol: /^https?$/, error: "must be an http or https link" }).max(2_000);
/** A website as people type it: "acme.in", "www.acme.in" or an http(s) link, never another scheme. */
const websiteSchema = z.string().trim().max(500).refine((value) => !/^[a-z][a-z0-9+.-]*:/i.test(value) || /^https?:\/\//i.test(value), "must be a web address");
export const contactRouteSchema = z.object({ kind: z.enum(["email", "phone", "whatsapp", "linkedin", "website_form", "other"]), value: z.string().trim().min(1).max(320), label: z.string().trim().max(80).optional(), sourceUrl: webUrlSchema.optional(), publishedByCompany: z.boolean().default(true) })
  // An email route is one plain address (no extra recipients or mailto parameters); a phone or WhatsApp route is a number.
  .refine((route) => route.kind !== "email" || z.email().safeParse(route.value).success, { message: "must be one plain email address", path: ["value"] })
  .refine((route) => (route.kind !== "phone" && route.kind !== "whatsapp") || /^[+()\d\s./-]{6,40}$/.test(route.value), { message: "must be a phone number", path: ["value"] });
export type ContactRoute = z.infer<typeof contactRouteSchema>;

/** Zod keeps .default() inside .partial(), so an update parsed with defaults would silently reset every omitted field. Updates strip them. */
function withoutDefaults<T extends z.ZodRawShape>(shape: T) {
  return Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field instanceof z.ZodDefault ? field.unwrap() : field])) as { [K in keyof T]: T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K] };
}

/** Why a lead was lost, as a category the reports can count. A lost lead also keeps the free-text exitReason. */
export const LOST_REASONS = ["price", "no_budget", "no_need", "timing", "chose_competitor", "no_response", "not_a_fit", "wrong_person", "other"] as const;
export const lostReasonSchema = z.enum(LOST_REASONS);
export type LostReason = z.infer<typeof lostReasonSchema>;
/** An ISO 4217-style code: three letters, upper-cased on input ("inr" becomes "INR"); anything else is refused. */
export const currencyCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "must be a three-letter currency code, e.g. INR");

export const opportunityInputSchema = z.object({
  pipelineId: idSchema, companyName: z.string().trim().min(1).max(200), contactName: z.string().trim().max(200).default(""), source: z.string().trim().max(500).default(""),
  observedSignal: z.string().trim().max(2_000).default(""), fitReason: z.string().trim().max(2_000).default(""), evidenceConfidence: confidenceSchema.default("low"), stage: stageInput.default("identified"), ownerId: idSchema,
  nextAction: z.string().trim().max(1_000).default(""), nextActionAt: isoDateSchema.optional(), valueEstimateMinor: z.number().int().nonnegative().optional(), currency: currencyCodeSchema.optional(),
  city: z.string().trim().max(120).optional(), region: z.string().trim().max(120).optional(), country: z.string().trim().max(80).optional(), website: websiteSchema.optional(), category: z.string().trim().max(200).optional(),
  contactRoutes: z.array(contactRouteSchema).max(20).default([]), playId: idSchema.optional(),
  /** The offer this lead is pursued for (sales-offers.ts); its approved packet is what Claude judges and writes against. */
  offerId: idSchema.optional(), relevance: z.number().int().min(0).max(100).optional(), fitBand: z.enum(["A", "B", "C"]).optional(),
  exitReason: z.string().trim().max(500).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  // The deal: value (valueEstimateMinor + currency), when it should close, how likely (overrides the stage default, see STAGE_PROBABILITY) and, once lost, why.
  expectedCloseAt: isoDateSchema.optional(), probability: z.number().int().min(0).max(100).optional(), lostReason: lostReasonSchema.optional(),
  // Set by imports so they can be re-run: unique per workspace; a second import of the same ref returns the existing lead.
  externalRef: z.object({ system: z.string().trim().min(1).max(40), id: z.string().trim().min(1).max(200) }).optional(),
});
export const updateOpportunitySchema = z.object(withoutDefaults(opportunityInputSchema.omit({ pipelineId: true, externalRef: true }).shape)).extend({ pipelineId: idSchema, /** null clears the date. */ nextActionAt: isoDateSchema.nullable(), /** null clears the date, the probability override or the lost reason. */ expectedCloseAt: isoDateSchema.nullable(), probability: z.number().int().min(0).max(100).nullable(), lostReason: lostReasonSchema.nullable() }).partial().refine((value) => Object.keys(value).length > 0);
export const verdictSummarySchema = z.object({ verdictId: idSchema, decision: z.enum(["recommend", "hold", "reject"]), confidence: confidenceSchema, summary: z.string().max(500), at: isoDateSchema, overridden: z.boolean().default(false) });
export const whatsappOptInSchema = z.object({ at: isoDateSchema, by: idSchema, how: z.enum(["they_messaged", "yes_on_call", "yes_by_email", "form"]) });
/** A person records WhatsApp consent in the app (never Claude): they said yes on a call or by email, or messaged us. `activityId` confirms a call Claude logged. */
export const whatsappOptInInputSchema = z.object({ how: z.enum(["they_messaged", "yes_on_call", "yes_by_email", "form"]), activityId: idSchema.optional() });
export const opportunitySchema = opportunityInputSchema.extend({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
  verdict: verdictSummarySchema.optional(), needsYou: z.boolean().default(false), whatsappOptIn: whatsappOptInSchema.optional(), doNotContact: z.boolean().default(false),
  lastTouchAt: isoDateSchema.optional(), followUpDueAt: isoDateSchema.optional(), wonAt: isoDateSchema.optional(), deliveryTaskId: idSchema.optional(),
  /** A stored code that is not three letters (written before the check existed) reads as no currency instead of failing the whole list. */
  currency: currencyCodeSchema.optional().catch(undefined),
});
export type Lead = z.infer<typeof opportunitySchema>;

export const leadListQuerySchema = z.object({
  ventureId: idSchema.optional(), pipelineId: idSchema.optional(), stage: z.string().max(400).optional(), q: z.string().trim().max(200).optional(), owner: z.union([z.literal("me"), idSchema]).optional(),
  needsYou: z.enum(["true", "false"]).optional(), playId: idSchema.optional(), offerId: z.union([idSchema, z.literal("none")]).optional(), verdict: z.enum(["recommend", "hold", "reject", "none"]).optional(),
  // Where and what they are: exact (case-insensitive) values picked from the facets; "none" means not set. Free text goes in `q`.
  city: z.string().trim().max(120).optional(), region: z.string().trim().max(120).optional(), category: z.string().trim().max(200).optional(),
  // How we can reach them: a phone or WhatsApp number, an email address, WhatsApp consent recorded, or no phone/WhatsApp/email route yet.
  contact: z.enum(["phone", "email", "whatsapp", "none"]).optional(),
  // true: also return the deal value and weighted value of everything the filters match, by currency (the board's column totals).
  totals: z.enum(["true", "false"]).optional(),
  sort: z.enum(["updated", "next", "relevance", "name"]).default("updated"), offset: z.coerce.number().int().min(0).max(100_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** The same filters as the list (without sorting and paging): the facets count what each choice would leave. */
export const leadFacetsQuerySchema = leadListQuerySchema.omit({ sort: true, offset: true, limit: true, totals: true });
const facetCountSchema = z.object({ value: z.string(), count: z.number().int().nonnegative() });
/**
 * Counts for the lead filters, like a shop sidebar: each group is counted with every OTHER active filter applied, so the numbers
 * show what choosing that value would give. Case and spacing variants ("raipur", "Raipur ") are one value. `total` is what all filters leave.
 */
export const leadFacetsSchema = z.object({
  total: z.number().int().nonnegative(),
  regions: z.array(facetCountSchema), cities: z.array(facetCountSchema.extend({ region: z.string().optional() })), categories: z.array(facetCountSchema),
  /** Leads per offer (value = the offer id, name = its name); `notSet.offers` counts leads with no offer. */
  offers: z.array(facetCountSchema.extend({ name: z.string() })).default([]),
  notSet: z.object({ regions: z.number().int().nonnegative(), cities: z.number().int().nonnegative(), categories: z.number().int().nonnegative(), offers: z.number().int().nonnegative().default(0) }),
  contact: z.object({ phone: z.number().int().nonnegative(), email: z.number().int().nonnegative(), whatsappOptIn: z.number().int().nonnegative(), none: z.number().int().nonnegative() }),
});
export type LeadFacets = z.infer<typeof leadFacetsSchema>;
/** Deal money of the filtered leads: `count` is every lead, each currency counts the leads that have a value; weighted = value x probability. Money is in minor units (paise, cents). */
export const leadTotalsSchema = z.object({
  count: z.number().int().nonnegative(),
  byCurrency: z.array(z.object({ currency: z.string().length(3), count: z.number().int().nonnegative(), valueMinor: z.number().int().nonnegative(), weightedMinor: z.number().int().nonnegative() })),
});
export const leadListSchema = z.object({ items: z.array(opportunitySchema), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive(), totals: leadTotalsSchema.optional() });

// Activities: calls, messages sent and received, meetings, notes. Inbound ones ("in") wait in the Inbox until handled.
export const CALL_OUTCOMES = ["interested_book", "send_details", "call_back", "no_answer", "busy", "not_interested", "wrong_person", "wrong_number", "yes_whatsapp"] as const;
export const REPLY_TYPES = ["interested", "send_details", "price_first", "not_now", "wrong_person", "has_system", "opt_out", "silence", "unclear", "hostile"] as const;
export const callOutcomeSchema = z.enum(CALL_OUTCOMES);
export const replyTypeSchema = z.enum(REPLY_TYPES);
export const activityKindSchema = z.enum(["call", "email", "whatsapp", "linkedin", "meeting", "note"]);
export const activityInputSchema = z.object({
  kind: activityKindSchema, direction: z.enum(["out", "in"]).optional(), body: z.string().trim().max(10_000).default(""), at: isoDateSchema.optional(),
  callOutcome: callOutcomeSchema.optional(), replyType: replyTypeSchema.optional(), draftId: idSchema.optional(),
  nextAction: z.string().trim().max(1_000).optional(), nextActionAt: isoDateSchema.optional(), requestId: z.string().trim().min(8).max(128).optional(),
});
/** Sets the reply type of an inbound item that was logged without one; the server applies that type's rules. */
export const activityReplyTypeInputSchema = z.object({ replyType: replyTypeSchema });
export const activitySchema = activityInputSchema.extend({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema, leadId: idSchema, actorId: idSchema, via: z.enum(["app", "claude", "import", "system"]), createdAt: isoDateSchema, at: isoDateSchema,
  handledAt: isoDateSchema.optional(), handledBy: idSchema.optional(), stageFrom: salesStageSchema.optional(), stageTo: salesStageSchema.optional(),
});
export type Activity = z.infer<typeof activitySchema>;

// Claude verdicts: evidence first, a written case against, then the decision.
export const verdictEvidenceSchema = z.object({ claim: z.string().trim().min(1).max(500), quote: z.string().trim().min(1).max(1_000), url: webUrlSchema, seenAt: isoDateSchema.optional() });
export const verdictGateSchema = z.object({ gate: z.string().trim().min(1).max(80), result: z.enum(["pass", "fail", "unknown"]), note: z.string().trim().max(500).default("") });
const score = z.number().int().min(1).max(3);
export const verdictInputSchema = z.object({
  decision: z.enum(["recommend", "hold", "reject"]), confidence: confidenceSchema, offer: z.string().trim().min(1).max(200), /** The offer judged against (defaults to the lead's offer). */ offerId: idSchema.optional(), offerFit: z.string().trim().min(1).max(2_000),
  evidence: z.array(verdictEvidenceSchema).min(1).max(20), gates: z.array(verdictGateSchema).max(12).default([]),
  scores: z.object({ fit: score, need: score, access: score, ability: score, timing: score }).partial().default({}),
  against: z.string().trim().min(1).max(2_000), openQuestion: z.string().trim().max(1_000).default(""), contactRoute: z.string().trim().max(500).default(""),
  signal: z.string().trim().max(1_000).default(""), signalSeenAt: isoDateSchema.optional(), summary: z.string().trim().min(1).max(500), sessionId: z.string().trim().max(128).optional(),
});
export const verdictOverrideInputSchema = z.object({ decision: z.enum(["recommend", "hold", "reject"]), reason: z.string().trim().min(3).max(1_000) });
export const verdictSchema = verdictInputSchema.extend({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema, leadId: idSchema, createdBy: idSchema, via: z.enum(["app", "claude", "import"]), createdAt: isoDateSchema,
  override: verdictOverrideInputSchema.extend({ by: idSchema, at: isoDateSchema }).optional(),
});
export type Verdict = z.infer<typeof verdictSchema>;

// Drafts: written (usually by Claude), reviewed in a separate pass, then sent by a person.
export const DRAFT_STATUSES = ["draft", "in_review", "ready", "needs_changes", "sent", "vetoed", "discarded"] as const;
export const draftStatusSchema = z.enum(DRAFT_STATUSES);
export const draftChannelSchema = z.enum(["email", "whatsapp", "call_opener", "linkedin"]);
export const draftInputSchema = z.object({
  channel: draftChannelSchema, purpose: z.enum(["first_touch", "follow_up", "reply", "proposal", "other"]).default("first_touch"), subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(5_000), playId: idSchema.optional(), inReplyTo: idSchema.optional(), sessionId: z.string().trim().max(128).optional(), submit: z.boolean().default(true),
});
export const draftUpdateSchema = z.object({ subject: z.string().trim().max(200), body: z.string().trim().min(1).max(5_000), sessionId: z.string().trim().max(128) }).partial().refine((value) => value.subject !== undefined || value.body !== undefined);
export const draftReviewInputSchema = z.object({ result: z.enum(["pass", "fail"]), issues: z.array(z.string().trim().min(1).max(300)).max(20).default([]), notes: z.string().trim().max(2_000).default(""), sessionId: z.string().trim().max(128).optional() });
export const draftSendInputSchema = z.object({ sentVia: z.enum(["manual", "smtp", "whatsapp_api"]).default("manual"), at: isoDateSchema.optional(), requestId: z.string().trim().min(8).max(128).optional() });
export const draftVetoInputSchema = z.object({ reason: z.string().trim().min(3).max(1_000) });
export const draftSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema, leadId: idSchema, playId: idSchema.optional(), inReplyTo: idSchema.optional(),
  channel: draftChannelSchema, purpose: draftInputSchema.shape.purpose, subject: z.string().optional(), body: z.string(), status: draftStatusSchema,
  authorId: idSchema, authorVia: z.enum(["app", "claude", "import"]), authorSessionId: z.string().optional(),
  review: draftReviewInputSchema.extend({ by: idSchema, via: z.enum(["app", "claude", "import"]), at: isoDateSchema }).optional(),
  /** `byHead`: the approver headed the venture (or was an admin); only those approvals count toward a play's first batch. */
  personApproval: z.object({ by: idSchema, at: isoDateSchema, byHead: z.boolean().optional() }).optional(), veto: draftVetoInputSchema.extend({ by: idSchema, at: isoDateSchema }).optional(),
  sentAt: isoDateSchema.optional(), sentBy: idSchema.optional(), sentVia: draftSendInputSchema.shape.sentVia.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
  /**
   * Computed by the server: the draft passed review but waits for a person's approval before it can be sent. `approvalReason` says why:
   * "every_message" (the venture approves every message: the lead's owner or a head approves) or "first_batch" (a play's first batch nobody
   * has read yet: only a venture head or admin approves). Lists and the Overview always carry them; a single lead's detail may not.
   */
  needsPersonApproval: z.boolean().optional(), approvalReason: z.enum(["first_batch", "every_message"]).nullable().optional(),
});
export type Draft = z.infer<typeof draftSchema>;
export const draftWithLeadSchema = draftSchema.extend({
  lead: opportunitySchema.pick({ id: true, companyName: true, contactName: true, city: true, stage: true, ownerId: true, ventureId: true, offerId: true, contactRoutes: true, observedSignal: true, verdict: true, whatsappOptIn: true, doNotContact: true }),
  needsPersonApproval: z.boolean(), approvalReason: z.enum(["first_batch", "every_message"]).nullable(),
});

// Plays: one campaign with a hypothesis, a sequence and a stop rule. The owner or a venture head approves it.
export const playStepSchema = z.object({ day: z.number().int().min(0).max(60), channel: z.enum(["call", "email", "whatsapp", "linkedin"]), action: z.string().trim().min(1).max(300) });
export const playInputSchema = z.object({
  ventureId: idSchema, pipelineId: idSchema.optional(), name: z.string().trim().min(1).max(120), motion: z.enum(["high_touch", "volume"]).default("high_touch"),
  audience: z.string().trim().max(2_000).default(""), offerName: z.string().trim().max(200).default(""), /** The offer this play sells (its name fills offerName). */ offerId: idSchema.optional(), hypothesis: z.string().trim().max(1_000).default(""), metric: z.string().trim().max(300).default(""),
  stopRule: z.string().trim().max(500).default(""), batchSize: z.number().int().min(1).max(500).default(10), steps: z.array(playStepSchema).max(10).default([]),
});
export const PLAY_STATUSES = ["draft", "approved", "running", "paused", "done"] as const;
export const playUpdateSchema = z.object(withoutDefaults(playInputSchema.omit({ ventureId: true }).shape)).extend({ status: z.enum(PLAY_STATUSES), firstBatchReviewed: z.boolean() }).partial().refine((value) => Object.keys(value).length > 0);
export const playSchema = playInputSchema.extend({
  id: idSchema, workspaceId: idSchema, status: z.enum(PLAY_STATUSES), createdBy: idSchema, createdVia: z.enum(["app", "claude", "import"]), approvedBy: idSchema.optional(), approvedAt: isoDateSchema.optional(),
  firstBatchReviewed: z.boolean().default(false), createdAt: isoDateSchema, updatedAt: isoDateSchema,
  stats: z.object({ leads: z.number().int(), contacted: z.number().int(), replied: z.number().int(), meetings: z.number().int(), won: z.number().int() }).optional(),
});
export type Play = z.infer<typeof playSchema>;

// Find-leads runs: a plan the lead finder works (the one built into the API, or an office PC engine over the bridge). The web app plans, queues and shows results.
export const findRunInputSchema = z.object({
  ventureId: idSchema, playId: idSchema.optional(), /** The offer to search for: the finder uses its packet (places, industries, search words, signals, negatives) and new leads get it. */ offerId: idSchema.optional(), request: z.string().trim().min(3).max(2_000),
  // "find" looks for new leads; "enrich" (made by POST /sales/leads/:id/enrich) fills in contact details of the named leads.
  kind: z.enum(["find", "enrich"]).default("find"), leadIds: z.array(idSchema).min(1).max(100).optional(),
  plan: z.object({ places: z.array(z.string().trim().min(1).max(120)).max(30).default([]), categories: z.array(z.string().trim().min(1).max(120)).max(30).default([]), searches: z.array(z.string().trim().min(1).max(300)).max(50).default([]), limit: z.number().int().min(1).max(500).default(50) }).default({ places: [], categories: [], searches: [], limit: 50 }),
});
export const findRunSchema = findRunInputSchema.extend({
  id: idSchema, workspaceId: idSchema, status: z.enum(["planned", "queued", "running", "done", "failed", "cancelled"]), createdBy: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
  results: z.object({ found: z.number().int(), added: z.number().int(), skipped: z.number().int(), note: z.string().optional() }).optional(),
  // Set by the office PC worker (docs/sales-dealflow.md section 10): who holds the run, how far it is, and when it ended.
  workerId: z.string().optional(), claimedAt: isoDateSchema.optional(), heartbeatAt: isoDateSchema.optional(), finishedAt: isoDateSchema.optional(), note: z.string().optional(),
  progress: z.object({ found: z.number().int(), crawled: z.number().int(), added: z.number().int() }).optional(),
});

// The venture's sales brain: fixed kinds of items. Claude and the team propose drafts; the owner or a venture head approves.
export const BRAIN_KINDS = ["offer", "target_profile", "message_rules", "venture_settings", "notes"] as const;
export const brainItemInputSchema = z.object({
  ventureId: idSchema, kind: z.enum(BRAIN_KINDS), title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(20_000),
  // Approved items of the same venture (any kind) this proposal consolidates: approving it retires them too. Its same-title predecessor is replaced anyway.
  replaces: z.array(idSchema).max(20).optional(),
});
export const brainItemUpdateSchema = brainItemInputSchema.omit({ ventureId: true, kind: true }).partial().refine((value) => Object.keys(value).length > 0);
const BRAIN_STATUSES = ["draft", "approved", "archived"] as const;
export const brainItemSchema = brainItemInputSchema.extend({
  id: idSchema, workspaceId: idSchema, status: z.enum(BRAIN_STATUSES), version: z.number().int().positive(), proposedBy: idSchema, via: z.enum(["app", "claude", "import"]),
  approvedBy: idSchema.optional(), approvedAt: isoDateSchema.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
  // The items in `replaces`, named (their status now: approved ones are what approving would retire); on a retired item, the approval that replaced it.
  replacesItems: z.array(z.object({ id: idSchema, title: z.string(), kind: z.enum(BRAIN_KINDS), version: z.number().int().positive(), status: z.enum(BRAIN_STATUSES) })).optional(),
  replacedBy: idSchema.optional(), archivedBy: idSchema.optional(), archivedAt: isoDateSchema.optional(),
  // Only on the approve answer: how many of `replaces` this approval retired.
  retired: z.number().int().nonnegative().optional(),
});
export type BrainItem = z.infer<typeof brainItemSchema>;

// One do-not-contact list for every venture.
export const suppressionInputSchema = z.object({ kind: z.enum(["email", "phone", "domain", "company"]), value: z.string().trim().min(1).max(320), reason: z.string().trim().max(300).default(""), leadId: idSchema.optional() });
export const suppressionSchema = suppressionInputSchema.extend({ id: idSchema, workspaceId: idSchema, createdBy: idSchema, createdAt: isoDateSchema });

// Lead detail and Today (Overview).
export const leadDetailSchema = z.object({ lead: opportunitySchema, activities: z.array(activitySchema), drafts: z.array(draftSchema), verdicts: z.array(verdictSchema) });
export const leadCardSchema = opportunitySchema.pick({ id: true, ventureId: true, offerId: true, companyName: true, contactName: true, city: true, stage: true, ownerId: true, nextAction: true, nextActionAt: true, verdict: true, whatsappOptIn: true, contactRoutes: true, doNotContact: true }).extend({ why: z.string() });
export const inboxItemSchema = z.object({ activity: activitySchema, lead: leadCardSchema });
export const salesOverviewSchema = z.object({
  counts: z.object({ replies: z.number().int(), callsDue: z.number().int(), followUpsDue: z.number().int(), toReview: z.number().int(), readyToSend: z.number().int(), needsYou: z.number().int(), wonToHandOver: z.number().int(), openLeads: z.number().int(), totalLeads: z.number().int() }),
  replies: z.array(inboxItemSchema), callsDue: z.array(leadCardSchema), followUpsDue: z.array(leadCardSchema), needsYou: z.array(leadCardSchema), wonToHandOver: z.array(leadCardSchema),
  toReview: z.array(draftWithLeadSchema), readyToSend: z.array(draftWithLeadSchema),
  stageCounts: z.record(z.string(), z.number().int()), week: z.object({ contacted: z.number().int(), replied: z.number().int(), meetings: z.number().int(), proposals: z.number().int(), won: z.number().int() }),
});
export const deliveryWorkInputSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), assigneeId: idSchema.optional(), dueAt: isoDateSchema.optional() });

// ---- Office PC engine bridge (docs/sales-dealflow.md section 10): a worker with a `sales:engine` token claims queued find-lead runs and posts leads back.
export const ENGINE_SYSTEM = "dealflow-engine" as const;
export const engineProgressSchema = z.object({ found: z.number().int().min(0).max(1_000_000), crawled: z.number().int().min(0).max(1_000_000), added: z.number().int().min(0).max(1_000_000) });
/** `workerId` is the worker's own name for itself; later calls may repeat it (it must then match the claim). */
const engineWorkerId = z.string().trim().min(1).max(100);
export const engineClaimInputSchema = z.object({ workerId: engineWorkerId });
export const engineHeartbeatInputSchema = z.object({ progress: engineProgressSchema, note: z.string().trim().max(500).optional(), workerId: engineWorkerId.optional() });
/** A contact route found by the engine: only email, phone, WhatsApp and contact-form routes, each with the page it was published on. */
export const engineContactRouteSchema = contactRouteSchema
  .refine((route) => ["email", "phone", "whatsapp", "website_form"].includes(route.kind), { message: "the engine posts email, phone, whatsapp and website_form routes", path: ["kind"] })
  .refine((route) => route.sourceUrl !== undefined, { message: "needs the sourceUrl of the company's own page or official listing it was published on", path: ["sourceUrl"] })
  .refine((route) => route.publishedByCompany, { message: "only routes published by the company are accepted", path: ["publishedByCompany"] })
  .refine((route) => route.kind !== "website_form" || webUrlSchema.safeParse(route.value).success, { message: "a contact form route is an http or https link", path: ["value"] });
export const engineLeadInputSchema = z.object({
  companyName: z.string().trim().min(1).max(200), website: opportunityInputSchema.shape.website, city: z.string().trim().max(120).optional(), region: z.string().trim().max(120).optional(), country: z.string().trim().max(80).optional(), category: z.string().trim().max(200).optional(),
  /** Where it was found: a URL or the name of a list. */
  source: z.string().trim().min(1).max(500), observedSignal: z.string().trim().max(2_000).optional(), contactRoutes: z.array(engineContactRouteSchema).max(20).default([]),
  evidence: z.array(verdictEvidenceSchema.pick({ claim: true, quote: true, url: true })).max(10).optional(), relevance: z.number().int().min(0).max(100).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(19).default([]),
  externalRef: z.object({ system: z.literal(ENGINE_SYSTEM), id: z.string().trim().min(1).max(200) }),
});
/** Up to 50 leads; each is checked on its own, so one invalid lead is skipped as "invalid" instead of failing the batch. */
export const engineLeadsInputSchema = z.object({ leads: z.array(z.unknown()).min(1).max(50), workerId: engineWorkerId.optional() });
export const engineLeadsResultSchema = z.object({
  added: z.array(z.object({ id: idSchema, companyName: z.string() })),
  skipped: z.array(z.object({ companyName: z.string(), reason: z.enum(["duplicate", "do_not_contact", "invalid"]), id: idSchema.optional(), detail: z.string().optional() })),
});
export const engineFinishInputSchema = z.object({
  status: z.enum(["done", "failed"]), results: z.object({ found: z.number().int().min(0), added: z.number().int().min(0), skipped: z.number().int().min(0), note: z.string().trim().max(2_000).optional() }), workerId: engineWorkerId.optional(),
});

// An enrich run names the leads to fill in (`leadIds`); the worker posts what it found per lead to the same /runs/:id/leads route.
export const engineEnrichLeadInputSchema = z.object({
  leadId: idSchema, website: opportunityInputSchema.shape.website, city: z.string().trim().max(120).optional(), region: z.string().trim().max(120).optional(), country: z.string().trim().max(80).optional(), category: z.string().trim().max(200).optional(),
  observedSignal: z.string().trim().max(2_000).optional(), contactRoutes: z.array(engineContactRouteSchema).max(20).default([]),
  evidence: z.array(verdictEvidenceSchema.pick({ claim: true, quote: true, url: true })).max(10).optional(),
});
/** What the worker gets for each lead of an enrich run (do-not-contact and deleted leads are left out). */
export const engineTargetSchema = z.object({
  leadId: idSchema, companyName: z.string(), website: z.string().optional(), city: z.string().optional(), region: z.string().optional(), country: z.string().optional(), category: z.string().optional(), observedSignal: z.string().optional(),
  contactRoutes: z.array(z.object({ kind: z.string(), value: z.string() })),
});
export const engineEnrichResultSchema = z.object({
  added: z.array(z.never()),
  updated: z.array(z.object({ id: idSchema, companyName: z.string(), routesAdded: z.number().int(), fieldsFilled: z.array(z.string()), evidenceAdded: z.boolean() })),
  skipped: engineLeadsResultSchema.shape.skipped,
});

// ---- Per-venture sales settings (docs/sales-dealflow.md section 5): working days, blackout dates, follow-up and reply timing, caps, channels and the approval mode.
export const SALES_CHANNELS = ["call", "email", "whatsapp", "linkedin"] as const;
/** The festival blackout days that applied before settings were per venture (2026-10-20 and 2026-11-06 to 2026-11-11). */
export const DEFAULT_BLACKOUT_DATES: readonly string[] = ["2026-10-20", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"];
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine((value) => { const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value); }, "not a real date");
export const salesSettingsSchema = z.object({
  /** ISO weekdays that count as working days: 1 = Monday ... 7 = Sunday. */
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6]).transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  blackoutDates: z.array(calendarDay).max(400).default([...DEFAULT_BLACKOUT_DATES]).transform((days) => [...new Set(days)].sort()),
  followUpAfterWorkingDays: z.number().int().min(1).max(30).default(4),
  /** Working hours within which a warm reply is answered. */
  replySlaHours: z.number().int().min(1).max(72).default(2),
  /** Messages one person sends a day, per channel. */
  dailyCaps: z.object({ email: z.number().int().min(0).max(1_000).default(20), whatsapp: z.number().int().min(0).max(1_000).default(20) }).default({ email: 20, whatsapp: 20 }),
  approvalMode: z.enum(["claude_review_enough", "person_approves_every_message"]).default("claude_review_enough"),
  allowedChannels: z.array(z.enum(SALES_CHANNELS)).min(1).default([...SALES_CHANNELS]).transform((channels) => [...new Set(channels)]),
  timezone: timezoneSchema.default("Asia/Kolkata"),
});
export type SalesSettings = z.infer<typeof salesSettingsSchema>;
export const salesSettingsViewSchema = salesSettingsSchema.extend({ ventureId: idSchema, updatedAt: isoDateSchema.optional(), updatedBy: idSchema.optional() });

// ---- Revenue (docs/sales-dealflow.md section 11): the chance a deal closes, by stage, unless a person sets one on the lead.
export const STAGE_PROBABILITY: Readonly<Record<SalesStage, number>> = {
  identified: 2, researched: 5, approved_for_contact: 8, contacted: 10, replied: 20, discovery_booked: 35, qualified: 50, proposal: 65,
  invoice_contract: 90, cash_collected: 100, delivery: 100, retained_referred: 100, thinking: 10, lost: 0, disqualified: 0,
};
/** The probability (0 to 100) a lead counts with: its own, else its stage's default. */
export const leadProbability = (lead: { stage: SalesStage; probability?: number | undefined }): number => lead.probability ?? STAGE_PROBABILITY[lead.stage];
/** The pipeline in money for the Overview card: open and weighted value, the weighted forecast by expected close month, and what was won this month. One row per currency. */
export const pipelineValueQuerySchema = z.object({ ventureId: idSchema.optional(), owner: z.union([z.literal("me"), idSchema]).optional(), tz: timezoneSchema.optional() });
export const pipelineValueSchema = z.object({
  /** The calendar months the forecast covers, as YYYY-MM in the sales time zone. */
  months: z.object({ current: z.string(), next: z.string() }),
  rows: z.array(z.object({
    currency: z.string().length(3), openDeals: z.number().int().nonnegative(), openValueMinor: z.number().int().nonnegative(), openWeightedMinor: z.number().int().nonnegative(),
    forecastThisMonthMinor: z.number().int().nonnegative(), forecastNextMonthMinor: z.number().int().nonnegative(), unscheduledWeightedMinor: z.number().int().nonnegative(),
    wonThisMonthDeals: z.number().int().nonnegative(), wonThisMonthMinor: z.number().int().nonnegative(),
  })),
  /** Open leads that have no value yet, so the numbers above leave them out. */
  openWithoutValue: z.number().int().nonnegative(),
});
export type PipelineValue = z.infer<typeof pipelineValueSchema>;

// ---- Reports and Daybreak (docs/sales-reports-and-daybreak.md): read-only numbers for the Reports tab and the morning work list.
/** Below this many cases a share, median or average is not shown as a number: the screen says "too few". */
export const REPORT_MIN_N = 5;
/** Below this many cases a number is marked as a small sample. */
export const REPORT_SMALL_N = 30;
const reportCount = z.number().int().nonnegative();
/** A share with its sample: `count` of `n`. `value` (0 to 1) is null below REPORT_MIN_N; `small` is true below REPORT_SMALL_N. */
export const reportRateSchema = z.object({ count: reportCount, n: reportCount, value: z.number().min(0).max(1).nullable(), small: z.boolean() });
/** A median, percentile or average with its sample. `value` is null below REPORT_MIN_N. */
export const reportStatSchema = z.object({ value: z.number().nullable(), n: reportCount, small: z.boolean() });
export type ReportRate = z.infer<typeof reportRateSchema>;
export type ReportStat = z.infer<typeof reportStatSchema>;
/** `from` and `to` are days (YYYY-MM-DD, whole days in the time zone) or ISO times; the default is the last 30 days, the most one year. */
/** Only the leads of one offer (its id), or `none` for the leads that have no offer. */
const offerFilterSchema = z.union([idSchema, z.literal("none")]);
export const salesReportQuerySchema = z.object({
  ventureId: idSchema.optional(), offerId: offerFilterSchema.optional(), from: z.string().trim().max(40).optional(), to: z.string().trim().max(40).optional(), owner: z.enum(["me", "all"]).default("all"), tz: timezoneSchema.optional(),
});
/** The funnel steps, in order (the Pipeline columns without Closed). */
export const REPORT_STAGE_GROUPS = ["new", "contacted", "talking", "meeting", "proposal", "won"] as const;
/** Where a lead came from: a lead finder (the one built into Venture OS, or the office PC engine), Claude (connector), a person in the app, an import, or unknown. */
export const REPORT_SOURCES = ["engine", "claude", "manual", "import", "other"] as const;
const reportHistogramSchema = z.array(z.object({ key: z.string(), label: z.string(), count: reportCount }));
/** One row of "where leads come from": the leads that moved in the period, and how many reached each step (or further). */
export const reportFunnelRowSchema = z.object({
  key: z.string(), label: z.string(), leads: reportCount, contacted: reportCount, replied: reportCount, meetings: reportCount, proposals: reportCount, won: reportCount, lostOrDisqualified: reportCount,
  /** replied ÷ contacted */
  replyRate: reportRateSchema,
});
/** What happened to the leads behind a set of verdicts: `contacted` counts every lead contacted; the other counts split the leads by where they are now. */
export const reportOutcomesSchema = z.object({
  n: reportCount, contacted: reportCount, replied: reportCount, meeting: reportCount, won: reportCount, lost: reportCount, disqualified: reportCount, open: reportCount,
  /** leads that ever replied ÷ leads contacted */
  replyRate: reportRateSchema, small: z.boolean(),
});
/**
 * The working rules a venture's reply-time promise is measured with, exactly as the server uses them: the warm-reply time in working hours,
 * the working days (ISO, 1 = Monday), the blackout days, the time zone, and the working hours of a day (local, start included, end excluded).
 */
export const salesWorkRulesSchema = z.object({
  ventureId: idSchema, replySlaHours: reportCount, workingDays: z.array(z.number().int().min(1).max(7)), blackoutDates: z.array(z.string()), timezone: z.string(),
  workStartHour: reportCount, workEndHour: reportCount,
});
export type SalesWorkRules = z.infer<typeof salesWorkRulesSchema>;
export const salesReportSchema = z.object({
  range: z.object({ from: isoDateSchema, to: isoDateSchema, days: reportCount, tz: z.string(), owner: z.enum(["me", "all"]), ventureId: idSchema.optional(), offerId: offerFilterSchema.optional() }),
  /** Each venture's working rules the speed and reply-time numbers were measured with (one row per venture in the report). */
  workRules: z.array(salesWorkRulesSchema),
  generatedAt: isoDateSchema,
  thresholds: z.object({ minN: reportCount, smallN: reportCount }),
  funnel: z.object({
    /** Leads that moved in the period: added, or anything logged or changed on them. */
    active: reportCount,
    /** `leads`: active leads that reached this step or further by the end of the period. `entered`: leads that got to this step during the period. `conversion`: leads ÷ the step before. */
    stages: z.array(z.object({ key: z.enum(REPORT_STAGE_GROUPS), label: z.string(), leads: reportCount, entered: reportCount, conversion: reportRateSchema.nullable() })),
    closed: z.object({ lost: reportCount, disqualified: reportCount }),
    by: z.object({ source: z.array(reportFunnelRowSchema), play: z.array(reportFunnelRowSchema), owner: z.array(reportFunnelRowSchema), city: z.array(reportFunnelRowSchema) }),
  }),
  activity: z.object({
    /** Per day (in `range.tz`): outbound calls and messages per channel, and replies received. */
    days: z.array(z.object({ day: z.string(), call: reportCount, email: reportCount, whatsapp: reportCount, linkedin: reportCount, replies: reportCount })),
    totals: z.object({ calls: reportCount, messages: reportCount, replies: reportCount }),
    callOutcomes: reportHistogramSchema, replyTypes: reportHistogramSchema,
    /** How long a reply waited for our next call or message (the first reply of a run of replies counts). */
    firstResponse: z.object({ medianHours: reportStatSchema, medianWorkingHours: reportStatSchema, unanswered: reportCount }),
    /** Warm replies (interested, wants details, asks the price) answered within the venture's reply time in working hours. Replies still inside that time are `pending` and not counted. */
    sla: z.object({ hours: reportCount, rate: reportRateSchema, pending: reportCount, late: reportCount, missed: reportCount }),
  }),
  stageAging: z.object({
    groups: z.array(z.object({ key: z.enum(["new", "contacted", "talking", "meeting", "proposal"]), label: z.string(), open: reportCount, medianDays: reportStatSchema, p90Days: reportStatSchema })),
    /** The 10 open leads (contacted or further) that have waited longest in their step. */
    oldest: z.array(z.object({ leadId: idSchema, ventureId: idSchema, companyName: z.string(), stage: salesStageSchema, group: z.string(), days: z.number().nonnegative(), since: isoDateSchema, ownerId: idSchema })),
  }),
  calibration: z.object({
    /** Claude's verdicts saved in the period (the latest per lead). */
    verdicts: reportCount,
    grid: z.array(reportOutcomesSchema.extend({ decision: z.enum(["recommend", "hold", "reject"]), confidence: confidenceSchema })),
    /** Claude said hold or reject, a person overrode it: what happened to those leads. */
    overridden: reportOutcomesSchema,
    overrides: z.object({
      count: reportCount, toRecommend: reportCount, fromRecommend: reportCount,
      recent: z.array(z.object({ verdictId: idSchema, leadId: idSchema, companyName: z.string(), decision: z.enum(["recommend", "hold", "reject"]), confidence: confidenceSchema, to: z.enum(["recommend", "hold", "reject"]), reason: z.string(), by: idSchema, at: isoDateSchema })),
    }),
    /** Recommended leads that replied or booked ÷ recommended leads contacted at least `waitDays` working days ago. */
    precision: z.object({ rate: reportRateSchema, waitDays: reportCount, tooRecent: reportCount, notContacted: reportCount }),
    signals: z.array(z.object({ keyword: z.string(), leads: reportCount, contacted: reportCount, replied: reportCount, replyRate: reportRateSchema })),
  }),
  winsLosses: z.object({
    won: z.object({ count: reportCount, value: z.array(z.object({ currency: z.string(), minor: reportCount })), withoutValue: reportCount, daysToWin: reportStatSchema }),
    lost: z.object({ count: reportCount, reasons: reportHistogramSchema }),
    disqualified: z.object({ count: reportCount, reasons: reportHistogramSchema }),
  }),
});
export type SalesReport = z.infer<typeof salesReportSchema>;

/** The morning work list (GET /sales/daybreak): what a scheduled Claude Code run, or a person, works through first. Read only. */
export const daybreakQuerySchema = z.object({ ventureId: idSchema.optional(), offerId: offerFilterSchema.optional(), owner: z.enum(["me", "all"]).default("me"), tz: timezoneSchema.optional() });
const daybreakLeadSchema = z.object({ id: idSchema, ventureId: idSchema, offerId: idSchema.optional(), companyName: z.string(), contactName: z.string(), city: z.string().optional(), stage: salesStageSchema, ownerId: idSchema });
export const daybreakSchema = z.object({
  generatedAt: isoDateSchema, today: z.string(), tz: z.string(), owner: z.enum(["me", "all"]), ventureId: idSchema.optional(), offerId: offerFilterSchema.optional(),
  /**
   * The warm-reply time (working hours) the summary speaks of: the venture's, or the one every venture in the list shares; null when they differ.
   * `overSla` on each reply uses its own venture's rules (`workRules`). Only warm replies (interested, send_details, price_first) are ever over it.
   */
  replySlaHours: reportCount.nullable(), workRules: z.array(salesWorkRulesSchema),
  counts: z.object({ followUpsDue: reportCount, staleVerdicts: reportCount, needsContacts: reportCount, callsToday: reportCount, repliesWaiting: reportCount, repliesOverSla: reportCount, draftsToApprove: reportCount, needsYou: reportCount }),
  /** Contacted leads whose follow-up is due by the end of today and have no follow-up draft waiting, with the first message (to refer back to). */
  followUpsDue: z.array(daybreakLeadSchema.extend({
    followUpDueAt: isoDateSchema, lastTouchAt: isoDateSchema.optional(), channel: z.string(), signal: z.string(),
    firstTouch: z.object({ draftId: idSchema.optional(), activityId: idSchema.optional(), channel: z.string(), subject: z.string().optional(), body: z.string(), at: isoDateSchema }).optional(),
  })),
  /** Leads not contacted yet whose verdict is older than 30 days or whose signal was seen more than 60 days ago. */
  staleVerdicts: z.array(daybreakLeadSchema.extend({
    verdict: z.object({ id: idSchema, decision: z.enum(["recommend", "hold", "reject"]), confidence: confidenceSchema, at: isoDateSchema, signal: z.string(), signalSeenAt: isoDateSchema.optional(), setBy: z.enum(["claude", "person"]) }),
    reasons: z.array(z.string()), claudeCanRejudge: z.boolean(),
  })),
  /** Open leads with no phone, WhatsApp or email route (candidates for an enrich run), newest first. */
  needsContacts: z.array(daybreakLeadSchema.extend({ createdAt: isoDateSchema, website: z.string().optional(), enrichPending: z.boolean() })),
  callsToday: z.array(daybreakLeadSchema.extend({
    why: z.string(), nextAction: z.string(), nextActionAt: isoDateSchema.optional(),
    phones: z.array(z.object({ kind: z.enum(["phone", "whatsapp"]), value: z.string(), label: z.string().optional() })), callOpenerDraftId: idSchema.optional(),
  })),
  repliesWaiting: z.array(z.object({
    activityId: idSchema, at: isoDateSchema, kind: z.string(), replyType: replyTypeSchema.optional(), body: z.string(), waitingHours: z.number().nonnegative(), slaDueAt: isoDateSchema, overSla: z.boolean(),
    lead: daybreakLeadSchema, lastOutbound: z.object({ kind: z.string(), body: z.string(), at: isoDateSchema, draftId: idSchema.optional() }).optional(),
  })),
  approvalsWaiting: z.object({
    drafts: z.array(z.object({ draftId: idSchema, leadId: idSchema, ventureId: idSchema, companyName: z.string(), channel: draftChannelSchema, purpose: z.string(), subject: z.string().optional(), body: z.string(), playId: idSchema.optional(), why: z.string() })),
    needsYou: z.array(daybreakLeadSchema.extend({ why: z.string(), verdict: z.object({ verdictId: idSchema, decision: z.enum(["recommend", "hold", "reject"]), confidence: confidenceSchema, summary: z.string() }).optional() })),
  }),
  /** What the person running Daybreak has sent today per venture and channel, against the venture's daily caps (null: no cap). */
  caps: z.array(z.object({ ventureId: idSchema, channels: z.array(z.object({ channel: z.enum(SALES_CHANNELS), used: reportCount, cap: reportCount.nullable(), left: reportCount.nullable() })) })),
  summary: z.string(),
});
export type Daybreak = z.infer<typeof daybreakSchema>;

// ---- Lists at scale: bulk edits, CSV export and import, saved views (docs/sales-dealflow.md, "Lists at scale") ----

/** What a person can do to many leads at once. Each lead is checked on its own, exactly like a single edit; leads that refuse are reported. */
export const BULK_ACTIONS = ["assign", "tag", "untag", "stage", "play", "offer", "delete"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** At most this many leads per bulk call, whether they are named by id or by the filters that match them. */
export const BULK_MAX = 500;
const bulkTargets = { ids: z.array(idSchema).min(1).max(BULK_MAX).optional(), /** Everything these filters match (the same filters as the list), up to BULK_MAX leads. */ filter: leadFacetsQuerySchema.optional() };
export const bulkLeadsInputSchema = z.discriminatedUnion("action", [
  z.object({ ...bulkTargets, action: z.literal("assign"), ownerId: idSchema }),
  z.object({ ...bulkTargets, action: z.literal("tag"), tag: z.string().trim().min(1).max(40) }),
  z.object({ ...bulkTargets, action: z.literal("untag"), tag: z.string().trim().min(1).max(40) }),
  z.object({ ...bulkTargets, action: z.literal("stage"), stage: salesStageSchema, exitReason: z.string().trim().max(500).optional(), lostReason: lostReasonSchema.optional() }),
  z.object({ ...bulkTargets, action: z.literal("play"), playId: idSchema }),
  z.object({ ...bulkTargets, action: z.literal("offer"), offerId: idSchema }),
  z.object({ ...bulkTargets, action: z.literal("delete") }),
]).refine((value) => (value.ids ? 1 : 0) + (value.filter ? 1 : 0) === 1, { message: "Send either ids or a filter", path: ["ids"] });
export type BulkLeadsInput = z.infer<typeof bulkLeadsInputSchema>;
export const bulkResultSchema = z.object({
  action: z.enum(BULK_ACTIONS),
  /** Leads the ids or filters named that the person can open. */
  matched: z.number().int().nonnegative(),
  /**
   * Leads that changed. Leads that already had the tag, stage, owner or play are `unchanged`; for a filter call that counts every
   * matching lead already like that (a filter call only takes leads that are not).
   */
  changed: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(),
  /** Leads that were refused or failed, with the reason; `skippedCount` is the full number, `skipped` lists the first 100. */
  skippedCount: z.number().int().nonnegative(), skipped: z.array(z.object({ id: idSchema, companyName: z.string(), reason: z.string() })),
  /** A filter matched more than BULK_MAX leads not yet like that: the BULK_MAX most recently updated were used. */
  truncated: z.boolean(),
  /** With `truncated`: matching leads still to go (not counting the ones refused in this call); the same call again takes the next ones. */
  remaining: z.number().int().nonnegative().optional(),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;

/** The columns an import understands. A CSV column is mapped to each field by its index (null: not in the file). */
/** `offer` names one of the venture's offers (any case); a row without one gets the venture's only usable offer, when there is one. */
export const IMPORT_FIELDS = ["company", "contactName", "website", "category", "city", "region", "country", "phone", "email", "source", "tags", "value", "offer"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const importFieldSchema = z.enum(IMPORT_FIELDS);
export const importMappingSchema = z.partialRecord(importFieldSchema, z.number().int().min(0).max(255).nullable());
export type ImportMapping = z.infer<typeof importMappingSchema>;
export const IMPORT_MAX_CHARS = 5_000_000;
export const IMPORT_MAX_ROWS = 5_000;
export const importInputSchema = z.object({
  ventureId: idSchema, /** The pipeline the leads join; the venture's first active pipeline when left out. */ pipelineId: idSchema.optional(),
  csv: z.string().min(1).max(IMPORT_MAX_CHARS), /** Omit on the preview to get a guess from the header row. */ mapping: importMappingSchema.optional(), hasHeader: z.boolean().default(true),
});
export const importCommitInputSchema = importInputSchema.extend({ mapping: importMappingSchema, /** Import rows that look like a lead already in the venture too (default: skip them). */ importDuplicates: z.boolean().default(false) });
export const IMPORT_ROW_STATUSES = ["ok", "duplicate", "invalid", "do_not_contact"] as const;
export const importRowSchema = z.object({
  /** The row as a spreadsheet numbers it (the header is row 1). */
  row: z.number().int().positive(), status: z.enum(IMPORT_ROW_STATUSES), problems: z.array(z.string()),
  values: z.record(z.string(), z.string()),
  duplicateOf: z.object({ leadId: idSchema.optional(), row: z.number().int().positive().optional(), companyName: z.string(), match: z.string() }).optional(),
});
export const importPreviewSchema = z.object({
  columns: z.array(z.string()), delimiter: z.string(), mapping: importMappingSchema, guessed: z.boolean(), /** Required fields no column is mapped to. */ missing: z.array(importFieldSchema),
  total: z.number().int().nonnegative(),
  counts: z.object({ ok: z.number().int().nonnegative(), duplicate: z.number().int().nonnegative(), invalid: z.number().int().nonnegative(), doNotContact: z.number().int().nonnegative() }),
  sample: z.array(importRowSchema), issues: z.array(importRowSchema), issuesTruncated: z.boolean(),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export const importResultSchema = z.object({
  batchId: idSchema, total: z.number().int().nonnegative(), created: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative(), doNotContact: z.number().int().nonnegative(), invalid: z.number().int().nonnegative(),
  /** This file (same rows, columns and venture) was imported before: nothing was created again. `batchId` is that earlier import's. */
  alreadyImported: z.object({ batchId: idSchema, at: isoDateSchema, created: z.number().int().nonnegative() }).optional(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

/** A named set of Leads filters kept for one person (the URL's filter parameters as they were when it was saved). At most SAVED_VIEW_MAX per person. */
export const SAVED_VIEW_MAX = 20;
export const savedViewInputSchema = z.object({
  name: z.string().trim().min(1).max(60), page: z.enum(["leads", "pipeline"]).default("leads"),
  filters: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/), z.string().max(200)).refine((value) => Object.keys(value).length <= 20, { message: "At most 20 filters" }),
});
export const savedViewSchema = savedViewInputSchema.extend({ id: idSchema, createdAt: isoDateSchema });
export type SavedView = z.infer<typeof savedViewSchema>;
