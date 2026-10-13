import { z } from "zod";
import { cursorQuerySchema, idSchema, isoDateSchema, successEnvelope } from "./common.js";

export const evidenceClassSchema = z.enum(["verified_fact", "founder_reported", "approved_decision", "planning_assumption", "hypothesis", "open_question", "historical"]);
export const sensitivitySchema = z.enum(["team", "venture_restricted", "manager", "founder_private"]);

export const documentSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200),
  slug: z.string().min(1).max(160), ownerId: idSchema, status: z.enum(["draft", "approved", "stale", "archived"]),
  evidenceClass: evidenceClassSchema, sensitivity: sensitivitySchema, authoritativeRank: z.number().int().min(0).max(100),
  currentVersionId: idSchema, lastReviewedAt: isoDateSchema.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
  /** A request to share a new document with all ventures: hidden from everyone but its author and approvers until approved. */
  review: z.object({ state: z.enum(["pending", "declined"]), requestedBy: idSchema, requestedAt: isoDateSchema, note: z.string().max(1000).optional(), decidedBy: idSchema.optional(), decidedAt: isoDateSchema.optional() }).optional(),
  /** Changes suggested to a workspace-wide document that wait for approval. */
  pendingSuggestions: z.number().int().min(0).optional(),
});

/** A change someone without the sharing permission suggested to a workspace-wide document; it replaces nothing until approved. */
export const documentSuggestionSchema = z.object({
  id: idSchema, documentId: idSchema, baseVersionId: idSchema, markdown: z.string().max(2_000_000).optional(), changeSummary: z.string(),
  proposedBy: idSchema, createdAt: isoDateSchema, state: z.enum(["pending", "approved", "declined"]),
  note: z.string().max(1000).optional(), decidedBy: idSchema.optional(), decidedAt: isoDateSchema.optional(),
});
/** `versionId` is the version the reviewer read; approving a request needs it, so a later edit can't be published unread. */
export const knowledgeReviewSchema = z.object({ decision: z.enum(["approve", "decline"]), note: z.string().trim().max(1000).optional(), versionId: idSchema.optional() });
export const documentListQuerySchema = cursorQuerySchema.extend({ ventureId: idSchema.optional(), status: z.enum(["draft", "approved", "stale"]).optional() });

export const documentVersionSchema = z.object({
  id: idSchema, workspaceId: idSchema, documentId: idSchema, version: z.number().int().positive(),
  markdown: z.string().min(1).max(2_000_000), changeSummary: z.string().min(1).max(500),
  createdBy: idSchema, createdAt: isoDateSchema, sourceUri: z.url().optional(),
});
/** Saving an edit gives a new version, or, for a workspace-wide document the editor may not publish to, a suggestion. */
export const documentUpdateResultSchema = z.union([z.object({ suggestion: documentSuggestionSchema }), documentVersionSchema]);
/** An approver's queue: new documents waiting to be shared with all ventures, and suggested changes to shared ones. */
export const knowledgeReviewQueueSchema = z.object({ requests: z.array(documentSchema), suggestions: z.array(documentSuggestionSchema.extend({ documentTitle: z.string() })) });

const markdownSchema = z.string().max(2_000_000).refine((value) => value.trim().length > 0, "Document content cannot be blank");
export const createDocumentSchema = z.object({
  ventureId: idSchema.optional(), title: z.string().trim().min(1).max(200), markdown: markdownSchema,
  evidenceClass: evidenceClassSchema, sensitivity: sensitivitySchema, authoritativeRank: z.number().int().min(0).max(100).default(50),
  sourceUri: z.url().optional(), changeSummary: z.string().trim().min(1).max(500).default("Initial version"),
});

export const updateDocumentSchema = z.object({
  markdown: markdownSchema, changeSummary: z.string().trim().min(1).max(500), sourceUri: z.url().optional(),
  /** The version the editor started from; a newer saved version makes the update fail with 409 instead of overwriting it. */
  baseVersionId: idSchema.optional(),
});

export const knowledgeSearchSchema = cursorQuerySchema.extend({
  q: z.string().trim().min(2).max(200), ventureId: idSchema.optional(), evidenceClasses: z.array(evidenceClassSchema).optional(),
  // Drafts are left out unless asked for; a query string carries "true" or "false".
  includeDrafts: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
});

export const knowledgeSearchHitSchema = z.object({
  documentId: idSchema, title: z.string(), versionId: idSchema, headingPath: z.string(), excerpt: z.string(),
  evidenceClass: evidenceClassSchema, ownerId: idSchema, lastReviewedAt: isoDateSchema.optional(),
  sourceRef: z.string(), sensitivity: sensitivitySchema, status: z.enum(["draft", "approved", "stale"]).optional(),
});
export const knowledgeSearchResponseSchema = successEnvelope(z.object({
  items: z.array(knowledgeSearchHitSchema), asOf: isoDateSchema, evidenceBoundary: z.string(), warnings: z.array(z.string()),
}));

export const decisionSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200),
  text: z.string().min(1).max(10_000), ownerId: idSchema, decidedAt: isoDateSchema, evidence: z.array(z.string()).max(100),
  reason: z.string().min(1).max(5_000), affectedWork: z.array(idSchema).max(100), reviewTrigger: z.string().max(1_000),
  status: z.enum(["draft", "approved", "superseded", "stale"]), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export const updateDecisionSchema = decisionSchema.omit({ id: true, workspaceId: true, ventureId: true, createdAt: true, updatedAt: true }).partial().refine((value) => Object.keys(value).length > 0);

export const informationRequestSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema, requesterId: idSchema, respondentId: idSchema,
  question: z.string().min(1).max(5_000), purpose: z.string().min(1).max(2_000), dueAt: isoDateSchema,
  status: z.enum(["open", "answered", "reviewed", "closed"]), responseMarkdown: z.string().max(100_000).optional(),
  sourceRefs: z.array(z.string()).max(100), reviewedBy: idSchema.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export const updateInformationRequestSchema = z.object({
  status: z.enum(["open", "answered", "reviewed", "closed"]),
  responseMarkdown: z.string().max(100_000).optional(), sourceRefs: z.array(z.string()).max(100).optional(),
});

export const classSchema = z.object({
  id: idSchema, workspaceId: idSchema, ventureId: idSchema.optional(), title: z.string().min(1).max(200),
  objective: z.string().min(1).max(2_000), scheduledAt: isoDateSchema, durationMinutes: z.number().int().min(1).max(480),
  facilitatorId: idSchema, materialDocumentId: idSchema.optional(), participantIds: z.array(idSchema).max(100),
  status: z.enum(["scheduled", "completed", "cancelled"]), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export const updateClassSchema = classSchema.omit({ id: true, workspaceId: true, ventureId: true, createdAt: true, updatedAt: true }).partial().refine((value) => Object.keys(value).length > 0);

export const classApplicationSchema = z.object({
  id: idSchema, workspaceId: idSchema, classId: idSchema, userId: idSchema, taskId: idSchema.optional(),
  exercise: z.string().min(1).max(5_000), evidenceItemId: idSchema.optional(), assessment: z.string().max(5_000).optional(),
  reviewerId: idSchema, nextGap: z.string().max(2_000).optional(), reviewedBy: idSchema.optional(), reviewedAt: isoDateSchema.optional(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
});
export const reviewClassApplicationSchema = z.object({ assessment: z.string().trim().min(1).max(5_000), nextGap: z.string().trim().max(2_000).optional() });
