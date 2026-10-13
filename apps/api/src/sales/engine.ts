// The office PC engine bridge (docs/sales-dealflow.md section 10): what a find-lead run's worker may do, and how a lead it found
// becomes a Sales lead. Leads go through the same creation rules as every other lead (createLead); duplicates and do-not-contact
// companies are checked with the same match keys as the do-not-contact list. The lead finder built into the API (sales/finder) works
// runs with these same helpers.
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { engineEnrichLeadInputSchema, engineLeadInputSchema, finderEnrichLeadInputSchema, finderLeadInputSchema, opportunityInputSchema } from "@venture-studio/contracts";
import type { AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { canSeeVenture, canWriteIn, isHeadOf, notFound } from "./access.js";
import type { SalesCtx } from "./ctx.js";
import { createLead, stopContactWork, suppressedBy } from "./leads.js";
import { SUPPRESS_KEYS_VERSION, isSharedDomain, leadSuppressKeys, normalizeCompany, normalizeDomain, normalizeEmail, normalizePhone, sameCity, suppressionKey } from "./suppression.js";

/** A claim with no heartbeat for this long can be taken over by another worker. */
export const STALE_CLAIM_MS = 15 * 60_000;

/** Who worked a run: the office PC engine over the bridge, or the lead finder built into the API (sales/finder). */
export type RunWorker = "engine" | "finder";
const WORKER_NAME: Record<RunWorker, string> = { engine: "the office PC engine", finder: "the built-in lead finder" };
/** One line of evidence in a lead's note: the claim, the quote word for word, its page and (from the finder) the day it was read. */
const evidenceLine = (item: { claim: string; quote: string; url: string; seenAt?: string | undefined }) => `- ${item.claim}: "${item.quote}" (${item.url}${item.seenAt ? `, seen ${item.seenAt.slice(0, 10)}` : ""})`;

/** The token's owner may work a run in a venture they can write in, if they head it (or are an admin) or planned the run themselves. */
export function canWorkRun(ctx: SalesCtx, run: AppDocument): boolean {
  return canWriteIn(ctx.actor, run.ventureId) && (isHeadOf(ctx.actor, run.ventureId) || run.createdBy === ctx.actor.id);
}

/** The run, if it is in a venture the token owner can open; 403 when they may not work it. */
export async function loadRun(ctx: SalesCtx, id: string): Promise<AppDocument> {
  const run = await ctx.db.collection("sales_find_runs").findOne({ _id: id, workspaceId: ctx.workspaceId });
  if (!run || !canSeeVenture(ctx.actor, run.ventureId)) throw notFound("Run");
  if (!canWorkRun(ctx, run)) throw new AppError(403, "FORBIDDEN", "Only a head of this venture, or the person who planned this run, can work it");
  return run;
}

/** Why a worker's call about a run was refused: the run is gone, finished, cancelled, unclaimed, or held by someone else. */
export function runConflict(run: AppDocument | null, patId: string, workerId?: string): AppError {
  if (!run) return notFound("Run");
  if (run.status === "cancelled") return new AppError(409, "CONFLICT", "This run was cancelled: stop working on it");
  if (run.status === "done" || run.status === "failed") return new AppError(409, "CONFLICT", `This run already finished (${run.status})`);
  if (run.status !== "running") return new AppError(409, "CONFLICT", `This run is ${run.status}, not running: claim it first`);
  if (run.claimedBy !== patId || (workerId && run.workerId !== workerId)) return new AppError(409, "CONFLICT", "Another worker holds this run (the claim may have been taken over after 15 minutes without a heartbeat)");
  return new AppError(409, "CONFLICT", "This run changed: reload it");
}

/** The venture's first active pipeline: where a run's leads go. */
export async function firstActivePipeline(ctx: SalesCtx, ventureId: string): Promise<AppDocument | null> {
  return ctx.db.collection("pipelines").findOne({ workspaceId: ctx.workspaceId, ventureId, status: "active" }, { sort: { createdAt: 1, _id: 1 } });
}

/**
 * A lead of the venture (deleted ones included: a company someone removed is not found again) that has the same website domain, or the
 * same normalised company name where the cities don't differ (as the CSV import counts it: "Sharma Traders" of Indore is not the one in Raipur).
 */
export async function findDuplicateLead(ctx: SalesCtx, ventureId: string, lead: { companyName: string; website?: string | undefined; city?: string | undefined }): Promise<AppDocument | null> {
  const leads = ctx.db.collection("opportunities");
  const domain = lead.website ? normalizeDomain(lead.website) : null;
  if (domain && !isSharedDomain(domain)) {
    const twin = await leads.findOne({ workspaceId: ctx.workspaceId, ventureId, suppressKeys: suppressionKey("domain", domain) }, { projection: { _id: 1, companyName: 1 } });
    if (twin) return twin;
  }
  const company = normalizeCompany(lead.companyName);
  if (!company) return null;
  const named = await leads.find({ workspaceId: ctx.workspaceId, ventureId, suppressKeys: suppressionKey("company", company) }, { projection: { _id: 1, companyName: 1, city: 1 } }).limit(1_000).toArray();
  return named.find((row) => sameCity(row.city, lead.city)) ?? null;
}

export type EngineSkip = { companyName: string; reason: "duplicate" | "do_not_contact" | "invalid"; id?: string; detail?: string };
export type EngineOutcome = { added: { id: string; companyName: string } } | { skipped: EngineSkip };

/**
 * One lead from a run: checked on its own, then created for the run's creator in the run's venture, pipeline, play and offer (a run with
 * no offer names none, and createLead gives the lead the venture's only usable offer). The built-in finder (`worker` "finder") posts its
 * own external reference system and dated evidence; everything else is the same.
 */
export async function ingestEngineLead(ctx: SalesCtx, run: AppDocument, pipelineId: string, raw: unknown, worker: RunWorker = "engine"): Promise<EngineOutcome> {
  const given = typeof raw === "object" && raw !== null && typeof (raw as { companyName?: unknown }).companyName === "string" ? (raw as { companyName: string }).companyName.trim().slice(0, 200) : "";
  const parsed = (worker === "finder" ? finderLeadInputSchema : engineLeadInputSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { skipped: { companyName: given, reason: "invalid", detail: issue ? `${issue.path.join(".") || "lead"}: ${issue.message}`.slice(0, 300) : "invalid lead" } };
  }
  const lead = parsed.data;
  // The same engine id again in this venture (a re-posted batch) is a duplicate, never a second lead; another venture may find the same company.
  const known = await ctx.db.collection("opportunities").findOne({ workspaceId: ctx.workspaceId, ventureId: run.ventureId, "externalRef.system": lead.externalRef.system, "externalRef.id": lead.externalRef.id }, { projection: { _id: 1 } });
  if (known) return { skipped: { companyName: lead.companyName, reason: "duplicate", id: String(known._id) } };
  const keys = leadSuppressKeys({ companyName: lead.companyName, ...(lead.website ? { website: lead.website } : {}), contactRoutes: lead.contactRoutes });
  if (await suppressedBy(ctx, keys)) return { skipped: { companyName: lead.companyName, reason: "do_not_contact" } };
  const twin = await findDuplicateLead(ctx, String(run.ventureId), lead);
  if (twin) return { skipped: { companyName: lead.companyName, reason: "duplicate", id: String(twin._id) } };
  let created: AppDocument;
  try {
    const input = opportunityInputSchema.parse({
      pipelineId, companyName: lead.companyName, source: lead.source, observedSignal: lead.observedSignal ?? "", stage: "identified", ownerId: String(run.createdBy),
      ...(lead.website ? { website: lead.website } : {}), ...(lead.city ? { city: lead.city } : {}), ...(lead.region ? { region: lead.region } : {}), ...(lead.country ? { country: lead.country } : {}), ...(lead.category ? { category: lead.category } : {}),
      contactRoutes: lead.contactRoutes, ...(typeof run.playId === "string" ? { playId: run.playId } : {}), ...(typeof run.offerId === "string" ? { offerId: run.offerId } : {}), ...(lead.relevance !== undefined ? { relevance: lead.relevance } : {}), tags: [...new Set([...lead.tags, worker])], externalRef: lead.externalRef,
    });
    const result = await createLead(ctx, input);
    if (!result.created) return { skipped: { companyName: lead.companyName, reason: "duplicate", id: String(result.lead._id) } };
    created = result.lead;
  } catch (error) {
    if (error instanceof ZodError) return { skipped: { companyName: lead.companyName, reason: "invalid", detail: error.issues[0] ? `${error.issues[0].path.join(".")}: ${error.issues[0].message}`.slice(0, 300) : "invalid lead" } };
    if (error instanceof AppError && error.status === 409) return { skipped: { companyName: lead.companyName, reason: "duplicate" } };
    // A rule about this one lead (say the run's planner is no longer in the venture, so the lead has no valid owner) skips it: never the batch.
    if (error instanceof AppError && error.status === 400) return { skipped: { companyName: lead.companyName, reason: "invalid", detail: error.message.slice(0, 300) } };
    throw error;
  }
  // What the engine found, with its quotes and links, as the first note on the lead.
  const evidence = (lead.evidence ?? []).map(evidenceLine);
  const now = new Date();
  await ctx.db.collection("sales_activities").insertOne({ _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: created.ventureId, leadId: created._id, actorId: ctx.actor.id, via: "import", kind: "note", body: [`Found by ${WORKER_NAME[worker]} (run ${String(run._id)}). Source: ${lead.source}`, ...evidence].join("\n").slice(0, 10_000), at: now, createdAt: now });
  return { added: { id: String(created._id), companyName: String(created.companyName) } };
}


// ---- Enrich runs: fill in the contact details of leads that already exist ------------------------------------------------------

/** What the worker needs to look up for each lead of an enrich run (leads that are deleted or on the do-not-contact list are left out). */
export async function enrichTargets(ctx: SalesCtx, run: AppDocument): Promise<Record<string, unknown>[]> {
  const ids = Array.isArray(run.leadIds) ? (run.leadIds as string[]) : [];
  if (!ids.length) return [];
  const leads = await ctx.db.collection("opportunities").find({ _id: { $in: ids }, workspaceId: ctx.workspaceId, ventureId: run.ventureId, deletedAt: null, doNotContact: { $ne: true } }).toArray();
  return leads.map((lead) => Object.fromEntries(Object.entries({
    leadId: String(lead._id), companyName: String(lead.companyName ?? ""), website: lead.website, city: lead.city, region: lead.region, country: lead.country, category: lead.category, observedSignal: lead.observedSignal || undefined,
    contactRoutes: ((lead.contactRoutes ?? []) as { kind: string; value: string }[]).map((route) => ({ kind: route.kind, value: route.value })),
  }).filter(([, value]) => value !== undefined && value !== null)));
}

/** A route's identity for merging: the same mailbox or number (whatever the spelling) or the same page is the same route. */
function routeIdentity(route: { kind: string; value: string }): string {
  if (route.kind === "email") return `email:${normalizeEmail(route.value) ?? route.value.trim().toLowerCase()}`;
  if (route.kind === "phone" || route.kind === "whatsapp") return `phone:${normalizePhone(route.value) ?? route.value.trim()}`;
  return `${route.kind}:${route.value.trim().toLowerCase().replace(/\/+$/, "")}`;
}

export type EnrichOutcome = { updated: { id: string; companyName: string; routesAdded: number; fieldsFilled: string[]; evidenceAdded: boolean } } | { skipped: EngineSkip };

/**
 * One lead of an enrich run: contact routes are merged by value, website, city, region, country, category and signal are filled only when
 * empty, and the evidence is added as a note. Nothing is created, nothing the people typed is overwritten, and a lead the do-not-contact
 * list matches (also by what was just found) is flagged and left alone.
 */
export async function enrichEngineLead(ctx: SalesCtx, run: AppDocument, raw: unknown, worker: RunWorker = "engine"): Promise<EnrichOutcome> {
  const parsed = (worker === "finder" ? finderEnrichLeadInputSchema : engineEnrichLeadInputSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { skipped: { companyName: "", reason: "invalid", detail: issue ? `${issue.path.join(".") || "lead"}: ${issue.message}`.slice(0, 300) : "invalid lead" } };
  }
  const input = parsed.data;
  const named = Array.isArray(run.leadIds) && (run.leadIds as string[]).includes(input.leadId);
  const lead = named ? await ctx.db.collection("opportunities").findOne({ _id: input.leadId, workspaceId: ctx.workspaceId, ventureId: run.ventureId, deletedAt: null }) : null;
  if (!lead) return { skipped: { companyName: "", reason: "invalid", id: input.leadId, detail: named ? "that lead no longer exists" : "that lead is not part of this run" } };
  const companyName = String(lead.companyName);
  if (lead.doNotContact) return { skipped: { companyName, reason: "do_not_contact", id: input.leadId } };
  const existing = ((lead.contactRoutes ?? []) as { kind: string; value: string }[]).slice();
  const known = new Set(existing.map(routeIdentity));
  const merged = existing.slice();
  for (const route of input.contactRoutes) {
    if (merged.length >= 20) break;
    const identity = routeIdentity(route);
    if (known.has(identity)) continue;
    known.add(identity);
    merged.push(route);
  }
  const routesAdded = merged.length - existing.length;
  const fill: Record<string, string> = {};
  for (const field of ["website", "city", "region", "country", "category"] as const) if (input[field] && !String(lead[field] ?? "").trim()) fill[field] = input[field]!;
  if (input.observedSignal && !String(lead.observedSignal ?? "").trim()) fill.observedSignal = input.observedSignal;
  const evidenceAdded = Boolean(input.evidence?.length);
  if (!routesAdded && !Object.keys(fill).length && !evidenceAdded) return { updated: { id: input.leadId, companyName, routesAdded: 0, fieldsFilled: [], evidenceAdded: false } };
  const keys = leadSuppressKeys({ companyName, website: fill.website ?? lead.website, contactRoutes: merged });
  const flagged = await suppressedBy(ctx, keys);
  const now = new Date();
  await ctx.db.collection("opportunities").updateOne({ _id: lead._id, workspaceId: ctx.workspaceId, deletedAt: null }, { $set: { ...fill, ...(routesAdded ? { contactRoutes: merged } : {}), suppressKeys: keys, suppressKeysV: SUPPRESS_KEYS_VERSION, ...(flagged ? { doNotContact: true } : {}), updatedAt: now } });
  // What was found matches the do-not-contact list: its unsent drafts and its next-action reminder stop too.
  if (flagged) await stopContactWork(ctx, [String(lead._id)], now);
  const lines = [`Enriched by ${WORKER_NAME[worker]} (run ${String(run._id)}).`, ...(routesAdded ? [`Added ${routesAdded} contact route${routesAdded > 1 ? "s" : ""}: ${merged.slice(existing.length).map((route) => `${route.kind} ${route.value}`).join(", ")}`] : []), ...(Object.keys(fill).length ? [`Filled in: ${Object.keys(fill).join(", ")}`] : []), ...(input.evidence ?? []).map(evidenceLine), ...(flagged ? ["It matches the do-not-contact list: marked do not contact."] : [])];
  await ctx.db.collection("sales_activities").insertOne({ _id: randomUUID(), workspaceId: ctx.workspaceId, ventureId: lead.ventureId, leadId: lead._id, actorId: ctx.actor.id, via: "import", kind: "note", body: lines.join("\n").slice(0, 10_000), at: now, createdAt: now });
  return { updated: { id: input.leadId, companyName, routesAdded, fieldsFilled: Object.keys(fill), evidenceAdded } };
}
