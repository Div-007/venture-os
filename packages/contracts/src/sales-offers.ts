import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// Offers (docs/sales-dealflow.md, "Offers"). A venture sells one or more offers; each offer is ONE packet: who it is for, the gates a lead
// must pass, the signals the lead finder looks for, what we say, the message rules and the price boundary. A packet is proposed (by a
// person or Claude) as a draft version and a venture head approves it as a whole; approving archives the version approved before. Claude
// judges every lead against its own offer's approved packet (plus the venture's shared notes), and the lead finder searches with it.

const line = (max: number) => z.string().trim().min(1).max(max);
const text = (max: number) => z.string().trim().max(max).default("");
const list = (itemMax: number, count: number) => z.array(line(itemMax)).max(count).default([]);

export const OFFER_STATES = ["active", "paused", "archived"] as const;
export const offerStateSchema = z.enum(OFFER_STATES);
export const OFFER_VERSION_STATUSES = ["draft", "approved", "archived"] as const;

/** One gate: what must be true, and what happens when it isn't (reject the lead, or hold it with a question for a person). */
export const offerGateSchema = z.object({
  code: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9-]+$/, "a short code such as G1"),
  rule: line(500),
  ifFails: z.enum(["reject", "hold"]),
  note: text(500),
});
export type OfferGate = z.infer<typeof offerGateSchema>;

/** A phrase the lead finder looks for on a company's own pages (quoted verbatim when found), and what it means for this offer. */
export const offerSignalSchema = z.object({ phrase: line(80), meaning: line(200) });

export const offerPacketSchema = z.object({
  /** One line under the name: what is sold, to whom. */
  summary: line(300),
  whoFor: z.object({
    description: text(3_000),
    industries: list(120, 40), customerTypes: list(120, 20), places: list(120, 60), companySizes: list(300, 20), buyerRoles: list(300, 20),
  }),
  /** Every gate must pass; a failed "reject" gate rejects, a failed "hold" gate holds the lead with a question. */
  gates: z.array(offerGateSchema).max(20).default([]),
  signals: z.object({
    /** Phrases to find on company pages (the finder quotes them; Claude opens messages with them). */
    lookFor: z.array(offerSignalSchema).max(40).default([]),
    /** Words the finder adds to each search, most specific first (e.g. "dealer enquiry", "manufacturer"). */
    searchWords: list(60, 10),
    /** Words that rule a search result out before any page is read (e.g. "pesticide formulations"). */
    negatives: list(60, 10),
  }),
  /** Sentence exclusions Claude applies when judging (beyond the gates). */
  exclusions: list(500, 30),
  say: z.object({
    valueProposition: text(3_000), pitchAngles: list(600, 20), proofWords: text(500), approvedClaims: list(500, 20), claimsToAvoid: list(500, 30),
  }),
  /** How first messages and follow-ups are written for this offer (structure, channels, length, follow-up, review checklist). */
  messages: text(12_000),
  /** What may be said about price, and when. */
  price: text(2_000),
  /** How leads that pass every gate are sorted (1 to 3 per criterion). */
  scoring: text(3_000),
  /** Anything else Claude should know for this offer. */
  notes: text(6_000),
});
export type OfferPacket = z.infer<typeof offerPacketSchema>;

/** A new offer (its first version, a draft) or a new version of an existing one (`offerId`). */
export const offerProposalInputSchema = z.object({
  ventureId: idSchema,
  /** Set to propose the next version of this offer; leave out to create a new offer. */
  offerId: idSchema.optional(),
  name: line(120),
  packet: offerPacketSchema,
  /** What changed, in a sentence (shown to the approver). */
  change: text(1_000),
});
export type OfferProposalInput = z.infer<typeof offerProposalInputSchema>;
export const offerProposalUpdateSchema = offerProposalInputSchema.pick({ name: true, packet: true, change: true }).partial().refine((value) => Object.keys(value).length > 0);
export const offerStateInputSchema = z.object({ state: offerStateSchema });

export const offerVersionSchema = z.object({
  id: idSchema, offerId: idSchema, workspaceId: idSchema, ventureId: idSchema, version: z.number().int().positive(),
  status: z.enum(OFFER_VERSION_STATUSES), name: z.string(), packet: offerPacketSchema, change: z.string(),
  proposedBy: idSchema, via: z.enum(["app", "claude", "import"]), approvedBy: idSchema.optional(), approvedAt: isoDateSchema.optional(),
  /** On an archived version: when and by whom (replaced by a later approval, or a draft discarded). */
  archivedAt: isoDateSchema.optional(), archivedBy: idSchema.optional(),
  createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export type OfferVersion = z.infer<typeof offerVersionSchema>;

/** An offer: its name and state, the approved packet Claude uses (none until a first version is approved) and the proposals waiting. */
export const offerSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema, name: z.string(), state: offerStateSchema,
  approved: offerVersionSchema.nullable(), proposals: z.array(offerVersionSchema),
  counts: z.object({ leads: z.number().int().nonnegative(), open: z.number().int().nonnegative(), plays: z.number().int().nonnegative() }),
  createdBy: idSchema, createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export type Offer = z.infer<typeof offerSchema>;
/** GET /sales/offers/:id: the offer, plus its archived versions (newest first, up to 20). */
export const offerDetailSchema = offerSchema.extend({ history: z.array(offerVersionSchema) });
export type OfferDetail = z.infer<typeof offerDetailSchema>;
/** Usable for new leads, verdicts and find runs: active, with an approved version. */
export const offerIsUsable = (offer: Pick<Offer, "state" | "approved">) => offer.state === "active" && offer.approved !== null;
