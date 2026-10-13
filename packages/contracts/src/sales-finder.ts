import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";
import { engineEnrichLeadInputSchema, engineLeadInputSchema, verdictEvidenceSchema } from "./sales.js";

// The lead finder built into the API (apps/api/src/sales/finder): it works queued find-leads and enrich runs itself, the way the office PC
// engine does over the bridge, and its leads go through the same duplicate and do-not-contact checks. Only whether a company-search key is
// set is ever shown, never a key.

/** The external reference of a lead the built-in finder added: one per company website domain in the workspace. */
export const FINDER_SYSTEM = "builtin-finder" as const;
/** What the finder quotes from a company's own page, word for word, with the page and when it read it. */
export const finderEvidenceSchema = verdictEvidenceSchema.pick({ claim: true, quote: true, url: true, seenAt: true });
export const finderLeadInputSchema = engineLeadInputSchema.extend({
  evidence: z.array(finderEvidenceSchema).max(10).optional(), externalRef: z.object({ system: z.literal(FINDER_SYSTEM), id: z.string().trim().min(1).max(200) }),
});
export const finderEnrichLeadInputSchema = engineEnrichLeadInputSchema.extend({ evidence: z.array(finderEvidenceSchema).max(10).optional() });

export const FINDER_ENGINES = ["tinyfish", "exa"] as const;
const finderRunKind = z.enum(["find", "enrich"]);
/** GET /sales/finder/status: is the built-in finder on, can it search (a key is set for TinyFish or Exa), what it is doing, and how its last run ended. */
export const finderStatusSchema = z.object({
  builtIn: z.object({
    on: z.boolean(), searchReady: z.boolean(), engines: z.array(z.enum(FINDER_ENGINES)),
    running: z.object({
      runId: idSchema, ventureId: idSchema, kind: finderRunKind, request: z.string(), startedAt: isoDateSchema, note: z.string().optional(),
      progress: z.object({ found: z.number().int(), crawled: z.number().int(), added: z.number().int() }).optional(),
    }).optional(),
    lastRun: z.object({
      runId: idSchema, ventureId: idSchema, kind: finderRunKind, request: z.string(), status: z.enum(["done", "failed"]), finishedAt: isoDateSchema,
      found: z.number().int(), added: z.number().int(), skipped: z.number().int(), note: z.string().optional(),
    }).optional(),
  }),
});
export type FinderStatus = z.infer<typeof finderStatusSchema>;
