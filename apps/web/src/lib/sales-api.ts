import { z } from "zod";
import {
  activityInputSchema, activityReplyTypeInputSchema, activitySchema, brainItemInputSchema, brainItemSchema, brainItemUpdateSchema, deliveryWorkInputSchema, draftInputSchema, draftReviewInputSchema, draftSchema,
  draftSendInputSchema, draftUpdateSchema, draftVetoInputSchema, draftWithLeadSchema, findRunInputSchema, findRunSchema, inboxItemSchema, leadDetailSchema, leadFacetsQuerySchema, leadFacetsSchema, leadListQuerySchema, leadListSchema, pipelineValueQuerySchema, pipelineValueSchema,
  opportunityInputSchema, opportunitySchema, playInputSchema, playSchema, playUpdateSchema, salesOverviewSchema, successEnvelope, suppressionInputSchema, suppressionSchema,
  updateOpportunitySchema, verdictOverrideInputSchema, verdictSchema, taskSchema, whatsappOptInInputSchema,
} from "@venture-studio/contracts";
import { request as send } from "@/lib/studio-api";

// Client for the Sales (Dealflow) API. Every route lives under /v1/sales; see docs/sales-dealflow.md.

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });
const id = encodeURIComponent;
function query(input: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type SalesOverview = z.infer<typeof salesOverviewSchema>;
export type LeadList = z.infer<typeof leadListSchema>;
export type LeadDetail = z.infer<typeof leadDetailSchema>;
export type InboxItem = z.infer<typeof inboxItemSchema>;
export type DraftWithLead = z.infer<typeof draftWithLeadSchema>;
export type FindRun = z.infer<typeof findRunSchema>;
export type Suppression = z.infer<typeof suppressionSchema>;

/**
 * Reads asked for by two parts of a screen at once (the Sales layout and the sidebar counts both read the Overview; the Overview's money card
 * is mounted for phones and for laptops) share one request while it is in flight. A later call always fetches afresh.
 */
const inFlight = new Map<string, Promise<unknown>>();
/** Every Sales request. A change (anything but a read) lets go of the shared reads, so a refresh after it never gets an answer from before it. */
function request(path: string, init?: RequestInit, options?: { devAuth?: boolean }) {
  if (init?.method && init.method !== "GET") inFlight.clear();
  return send(path, init, options);
}
function shared<T>(path: string, load: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(path) as Promise<T> | undefined;
  if (pending) return pending;
  const next = load().finally(() => inFlight.delete(path));
  inFlight.set(path, next);
  return next;
}

export async function getSalesOverview(input: { ventureId?: string; owner?: "me" } = {}) {
  const path = `/v1/sales/overview${query(input)}`;
  return shared(path, async () => successEnvelope(salesOverviewSchema).parse(await request(path)).data);
}

export async function listLeads(input: Partial<z.input<typeof leadListQuerySchema>> = {}) {
  const valid = leadListQuerySchema.parse(input);
  return successEnvelope(leadListSchema).parse(await request(`/v1/sales/leads${query(valid)}`)).data;
}
/** The pipeline in money for the Overview: open and weighted value, the forecast by expected close month, won this month. */
export async function getPipelineValue(input: Partial<z.input<typeof pipelineValueQuerySchema>> = {}) {
  const path = `/v1/sales/pipeline-value${query(pipelineValueQuerySchema.parse(input))}`;
  return shared(path, async () => successEnvelope(pipelineValueSchema).parse(await request(path)).data);
}
/** Counts for the lead filters (state, city, industry, how to reach), with every other active filter applied. */
export async function getLeadFacets(input: Partial<z.input<typeof leadFacetsQuerySchema>> = {}) {
  const valid = leadFacetsQuerySchema.parse(input);
  return successEnvelope(leadFacetsSchema).parse(await request(`/v1/sales/leads/facets${query(valid)}`)).data;
}
export async function getLead(leadId: string) {
  return successEnvelope(leadDetailSchema).parse(await request(`/v1/sales/leads/${id(leadId)}`)).data;
}
export async function createLead(input: z.input<typeof opportunityInputSchema>) {
  return successEnvelope(opportunitySchema).parse(await request("/v1/sales/leads", json(opportunityInputSchema.parse(input)))).data;
}
export async function updateLead(leadId: string, input: z.input<typeof updateOpportunitySchema>) {
  return successEnvelope(opportunitySchema).parse(await request(`/v1/sales/leads/${id(leadId)}`, patch(updateOpportunitySchema.parse(input)))).data;
}
export async function deleteLead(leadId: string) {
  await request(`/v1/sales/leads/${id(leadId)}`, { method: "DELETE" });
}
export async function logActivity(leadId: string, input: z.input<typeof activityInputSchema>) {
  return successEnvelope(z.object({ activity: activitySchema, lead: opportunitySchema })).parse(await request(`/v1/sales/leads/${id(leadId)}/activities`, json(activityInputSchema.parse(input)))).data;
}
export async function markActivityHandled(activityId: string) {
  return successEnvelope(activitySchema).parse(await request(`/v1/sales/activities/${id(activityId)}/handled`, json({}))).data;
}
/** Classifies an inbound item logged without a reply type; the server applies that type's rules (opt-out, not now, …). */
export async function setActivityReplyType(activityId: string, input: z.input<typeof activityReplyTypeInputSchema>) {
  return successEnvelope(z.object({ activity: activitySchema, lead: opportunitySchema })).parse(await request(`/v1/sales/activities/${id(activityId)}`, patch(activityReplyTypeInputSchema.parse(input)))).data;
}
/** A person records WhatsApp consent (Claude cannot). Pass the call's activityId to confirm a "said yes to WhatsApp" call Claude logged. */
export async function recordWhatsappOptIn(leadId: string, input: z.input<typeof whatsappOptInInputSchema>) {
  return successEnvelope(opportunitySchema).parse(await request(`/v1/sales/leads/${id(leadId)}/whatsapp-opt-in`, json(whatsappOptInInputSchema.parse(input)))).data;
}
export async function createDeliveryWork(leadId: string, input: z.input<typeof deliveryWorkInputSchema> = {}) {
  return successEnvelope(z.object({ lead: opportunitySchema, task: taskSchema })).parse(await request(`/v1/sales/leads/${id(leadId)}/delivery-work`, json(deliveryWorkInputSchema.parse(input)))).data;
}

export async function saveVerdict(leadId: string, input: unknown) {
  return successEnvelope(z.object({ verdict: verdictSchema, lead: opportunitySchema })).parse(await request(`/v1/sales/leads/${id(leadId)}/verdicts`, json(input))).data;
}
export async function overrideVerdict(verdictId: string, input: z.input<typeof verdictOverrideInputSchema>) {
  return successEnvelope(z.object({ verdict: verdictSchema, lead: opportunitySchema })).parse(await request(`/v1/sales/verdicts/${id(verdictId)}/override`, json(verdictOverrideInputSchema.parse(input)))).data;
}

export async function listDrafts(input: { ventureId?: string; status?: string; owner?: "me"; limit?: number } = {}) {
  return successEnvelope(z.array(draftWithLeadSchema)).parse(await request(`/v1/sales/drafts${query(input)}`)).data;
}
export async function createDraft(leadId: string, input: z.input<typeof draftInputSchema>) {
  return successEnvelope(draftSchema).parse(await request(`/v1/sales/leads/${id(leadId)}/drafts`, json(draftInputSchema.parse(input)))).data;
}
export async function updateDraft(draftId: string, input: z.input<typeof draftUpdateSchema>) {
  return successEnvelope(draftSchema).parse(await request(`/v1/sales/drafts/${id(draftId)}`, patch(draftUpdateSchema.parse(input)))).data;
}
export async function reviewDraft(draftId: string, input: z.input<typeof draftReviewInputSchema>) {
  return successEnvelope(draftSchema).parse(await request(`/v1/sales/drafts/${id(draftId)}/review`, json(draftReviewInputSchema.parse(input)))).data;
}
export async function approveDraft(draftId: string) {
  return successEnvelope(draftSchema).parse(await request(`/v1/sales/drafts/${id(draftId)}/approve`, json({}))).data;
}
export async function markDraftSent(draftId: string, input: z.input<typeof draftSendInputSchema> = {}) {
  return successEnvelope(z.object({ draft: draftSchema, activity: activitySchema, lead: opportunitySchema })).parse(await request(`/v1/sales/drafts/${id(draftId)}/sent`, json(draftSendInputSchema.parse(input)))).data;
}
export async function vetoDraft(draftId: string, input: z.input<typeof draftVetoInputSchema>) {
  return successEnvelope(draftSchema).parse(await request(`/v1/sales/drafts/${id(draftId)}/veto`, json(draftVetoInputSchema.parse(input)))).data;
}
export async function discardDraft(draftId: string) {
  return successEnvelope(draftSchema).parse(await request(`/v1/sales/drafts/${id(draftId)}/discard`, json({}))).data;
}

export async function listInbox(input: { ventureId?: string; handled?: "true" | "false"; owner?: "me"; limit?: number } = {}) {
  return successEnvelope(z.array(inboxItemSchema)).parse(await request(`/v1/sales/inbox${query(input)}`)).data;
}

export async function listPlays(input: { ventureId?: string } = {}) {
  return successEnvelope(z.array(playSchema)).parse(await request(`/v1/sales/plays${query(input)}`)).data;
}
export async function createPlay(input: z.input<typeof playInputSchema>) {
  return successEnvelope(playSchema).parse(await request("/v1/sales/plays", json(playInputSchema.parse(input)))).data;
}
export async function updatePlay(playId: string, input: z.input<typeof playUpdateSchema>) {
  return successEnvelope(playSchema).parse(await request(`/v1/sales/plays/${id(playId)}`, patch(playUpdateSchema.parse(input)))).data;
}
export async function approvePlay(playId: string) {
  return successEnvelope(playSchema).parse(await request(`/v1/sales/plays/${id(playId)}/approve`, json({}))).data;
}

export async function listFindRuns(input: { ventureId?: string } = {}) {
  return successEnvelope(z.array(findRunSchema)).parse(await request(`/v1/sales/find-runs${query(input)}`)).data;
}
export async function createFindRun(input: z.input<typeof findRunInputSchema>, options: { queue?: boolean } = {}) {
  return successEnvelope(findRunSchema).parse(await request(`/v1/sales/find-runs${query({ queue: options.queue ? "true" : undefined })}`, json(findRunInputSchema.parse(input)))).data;
}
export async function cancelFindRun(runId: string) {
  return successEnvelope(findRunSchema).parse(await request(`/v1/sales/find-runs/${id(runId)}/cancel`, json({}))).data;
}

/** Queues a saved plan (one Claude saved without running it) for the lead finder: its planner or a venture head, in the app. */
export async function queueFindRun(runId: string) {
  return successEnvelope(findRunSchema).parse(await request(`/v1/sales/find-runs/${id(runId)}/queue`, json({}))).data;
}

// The lead finder built into the API: on or off, whether company search has a key (never the key), the run it is on and how its last one ended.
import { finderStatusSchema } from "@venture-studio/contracts";
export type FinderStatus = z.infer<typeof finderStatusSchema>;
export async function getFinderStatus() {
  return successEnvelope(finderStatusSchema).parse(await request("/v1/sales/finder/status")).data;
}

export async function listBrain(input: { ventureId?: string; status?: string } = {}) {
  return successEnvelope(z.array(brainItemSchema)).parse(await request(`/v1/sales/brain${query(input)}`)).data;
}
export async function proposeBrainItem(input: z.input<typeof brainItemInputSchema>) {
  return successEnvelope(brainItemSchema).parse(await request("/v1/sales/brain", json(brainItemInputSchema.parse(input)))).data;
}
export async function updateBrainItem(itemId: string, input: z.input<typeof brainItemUpdateSchema>) {
  return successEnvelope(brainItemSchema).parse(await request(`/v1/sales/brain/${id(itemId)}`, patch(brainItemUpdateSchema.parse(input)))).data;
}
export async function approveBrainItem(itemId: string) {
  return successEnvelope(brainItemSchema).parse(await request(`/v1/sales/brain/${id(itemId)}/approve`, json({}))).data;
}
/** Archives a pending draft (or an approved item being retired). Venture head, admin, or the person who proposed a draft. */
export async function archiveBrainItem(itemId: string) {
  return successEnvelope(brainItemSchema).parse(await request(`/v1/sales/brain/${id(itemId)}/archive`, json({}))).data;
}

// ---- Offers (docs/sales-offers.md): one packet per offer. Anyone who can open the venture reads; a writer (or Claude) proposes a draft
// version; its proposer or a venture head edits or discards it; a venture head or admin approves it as a whole and changes the offer's state.
import { offerProposalInputSchema, offerProposalUpdateSchema, offerSchema, offerStateInputSchema, offerVersionSchema, type Offer, type OfferVersion } from "@venture-studio/contracts";
export type { Offer, OfferVersion };
/** One offer with its history: archived versions, newest first (up to 20). */
export type OfferDetail = Offer & { history: OfferVersion[] };
const offerDetailSchema = z.union([
  offerSchema.extend({ history: z.array(offerVersionSchema).default([]) }),
  z.object({ offer: offerSchema, history: z.array(offerVersionSchema).default([]) }).transform(({ offer, history }) => ({ ...offer, history })),
]);
/** What approving answers with: the offer, the version, or both (the screens reload the offer either way). */
const approvedSchema = z.union([
  z.object({ offer: offerSchema, version: offerVersionSchema.optional() }).transform(({ offer, version }) => ({ offer, version: version ?? offer.approved ?? null })),
  offerSchema.transform((offer) => ({ offer, version: offer.approved })),
  offerVersionSchema.transform((version) => ({ offer: null, version })),
]);

/** The venture's offers: name, state, the approved version, the proposals waiting and the lead counts. */
export async function listOffers(input: { ventureId: string }) {
  return successEnvelope(z.array(offerSchema)).parse(await request(`/v1/sales/offers${query(input)}`)).data;
}
export async function getOffer(offerId: string): Promise<OfferDetail> {
  return successEnvelope(offerDetailSchema).parse(await request(`/v1/sales/offers/${id(offerId)}`)).data;
}
/** A new offer (its draft v1), or with `offerId` a new draft version of that offer. Answers the draft version. */
export async function proposeOffer(input: z.input<typeof offerProposalInputSchema>) {
  return successEnvelope(offerVersionSchema).parse(await request("/v1/sales/offers", json(offerProposalInputSchema.parse(input)))).data;
}
/** Edits a draft version: its proposer or a venture head. */
export async function updateOfferDraft(versionId: string, input: z.input<typeof offerProposalUpdateSchema>) {
  return successEnvelope(offerVersionSchema).parse(await request(`/v1/sales/offers/versions/${id(versionId)}`, patch(offerProposalUpdateSchema.parse(input)))).data;
}
/** Approves a draft version as a whole (a venture head or admin, in the app): the version approved before is archived. */
export async function approveOfferVersion(versionId: string) {
  return successEnvelope(approvedSchema).parse(await request(`/v1/sales/offers/versions/${id(versionId)}/approve`, json({}))).data;
}
/** Archives a draft version: its proposer or a venture head. */
export async function discardOfferVersion(versionId: string) {
  return successEnvelope(offerVersionSchema).parse(await request(`/v1/sales/offers/versions/${id(versionId)}/discard`, json({}))).data;
}
/** Active, paused or archived: a venture head or admin, in the app. */
export async function setOfferState(offerId: string, input: z.input<typeof offerStateInputSchema>) {
  return successEnvelope(offerSchema).parse(await request(`/v1/sales/offers/${id(offerId)}/state`, json(offerStateInputSchema.parse(input)))).data;
}

/**
 * The venture's offers, kept per venture for a minute so lists that show offer names (leads, plays, runs) share one read. A failed read is
 * not kept. `forgetOffers` drops a venture's entry after a change.
 */
const OFFERS_TTL_MS = 60_000;
const offersCache = new Map<string, { at: number; value: Promise<Offer[]> }>();
export function getCachedOffers(ventureId: string): Promise<Offer[]> {
  const hit = offersCache.get(ventureId);
  if (hit && Date.now() - hit.at < OFFERS_TTL_MS) return hit.value;
  const value = listOffers({ ventureId }).catch((cause: unknown) => { offersCache.delete(ventureId); throw cause; });
  offersCache.set(ventureId, { at: Date.now(), value });
  return value;
}
export const forgetOffers = (ventureId?: string) => { if (ventureId) offersCache.delete(ventureId); else offersCache.clear(); };

export async function listSuppression() {
  return successEnvelope(z.array(suppressionSchema)).parse(await request("/v1/sales/suppression")).data;
}
export async function addSuppression(input: z.input<typeof suppressionInputSchema>) {
  return successEnvelope(suppressionSchema).parse(await request("/v1/sales/suppression", json(suppressionInputSchema.parse(input)))).data;
}
/** Owner only, with a reason: taking someone off the do-not-contact list is rare and audited. */
export async function removeSuppression(entryId: string, reason: string) {
  await request(`/v1/sales/suppression/${id(entryId)}`, { method: "DELETE", body: JSON.stringify({ reason }) });
}

// ---- Per-venture sales settings (working days, caps, approval mode...). Anyone who can open the venture reads; a venture head or admin saves, in the app.
import { salesSettingsSchema, salesSettingsViewSchema } from "@venture-studio/contracts";

export type SalesSettingsView = z.infer<typeof salesSettingsViewSchema>;
export type SalesSettingsInput = z.input<typeof salesSettingsSchema>;

/** The venture's settings (defaults when none were saved; `updatedAt` is set only once someone saved them). */
export async function getSalesSettings(ventureId: string) {
  return successEnvelope(salesSettingsViewSchema).parse(await request(`/v1/sales/settings${query({ ventureId })}`)).data;
}
/** Replaces the venture's settings: whatever the body leaves out takes its default. */
export async function putSalesSettings(ventureId: string, input: SalesSettingsInput) {
  return successEnvelope(salesSettingsViewSchema).parse(await request(`/v1/sales/settings${query({ ventureId })}`, { method: "PUT", body: JSON.stringify(salesSettingsSchema.parse(input)) })).data;
}

// ---- Reports and Daybreak (docs/sales-reports-and-daybreak.md): read-only numbers for the Reports tab and the morning work list.
import { daybreakQuerySchema, daybreakSchema, salesReportQuerySchema, salesReportSchema, type Daybreak, type SalesReport } from "@venture-studio/contracts";
export type { Daybreak, SalesReport };
/** The Reports tab: `from`/`to` are days (YYYY-MM-DD) or ISO times; without them the last 30 days. */
export async function getSalesReport(input: Partial<z.input<typeof salesReportQuerySchema>> = {}) {
  const valid = salesReportQuerySchema.parse(input);
  return successEnvelope(salesReportSchema).parse(await request(`/v1/sales/reports${query(valid)}`)).data;
}
/** The morning work list: follow-ups due, stale verdicts, leads without contacts, calls, replies and approvals waiting, caps, summary. */
export async function getDaybreak(input: Partial<z.input<typeof daybreakQuerySchema>> = {}) {
  const valid = daybreakQuerySchema.parse(input);
  return successEnvelope(daybreakSchema).parse(await request(`/v1/sales/daybreak${query(valid)}`)).data;
}

/** Asks the lead finder to fill in a lead's contact details. The lead joins your queued enrich run in its venture (made on the first call, up to 100 leads): 201 for a new run, 200 for one joined. 409 for a do-not-contact lead. */
export async function enrichLead(leadId: string) {
  return successEnvelope(findRunSchema).parse(await request(`/v1/sales/leads/${id(leadId)}/enrich`, json({}))).data;
}

// ---- Lists at scale (docs/sales-dealflow.md, "Lists at scale"): bulk edits, the CSV export and import, saved views. People only, never Claude.
import {
  bulkLeadsInputSchema, bulkResultSchema, errorEnvelopeSchema, importCommitInputSchema, importInputSchema, importPreviewSchema, importResultSchema, savedViewInputSchema, savedViewSchema,
  type BulkResult, type ImportPreview, type ImportResult, type SavedView,
} from "@venture-studio/contracts";
import { localDevUserId } from "@/lib/dev-identity";
import { StudioApiError } from "@/lib/studio-api";
export type { BulkResult, ImportPreview, ImportResult, SavedView };

/** Assign, tag, untag, move to a stage, add to a play, move to an offer or delete up to 500 leads, named by id or by the list filters. Refused leads are skipped and listed. */
export async function bulkLeads(input: z.input<typeof bulkLeadsInputSchema>) {
  return successEnvelope(bulkResultSchema).parse(await request("/v1/sales/leads/bulk", json(bulkLeadsInputSchema.parse(input)))).data;
}

const exportQuerySchema = leadListQuerySchema.omit({ offset: true, limit: true, totals: true });
/**
 * The leads the list filters match, as a CSV file (business fields only, at most 10,000 rows). A plain link cannot carry the dev identity
 * header, so this fetches the file and hands back a Blob with the server's file name and how many rows it holds out of how many match.
 */
export async function exportLeadsCsv(input: Partial<z.input<typeof exportQuerySchema>> = {}) {
  const valid = exportQuerySchema.parse(input);
  const devUserId = localDevUserId();
  const response = await fetch(`/v1/sales/leads/export.csv${query(valid)}`, { cache: "no-store", credentials: "same-origin", headers: devUserId ? { "x-dev-user-id": devUserId } : undefined });
  if (!response.ok) {
    const error = errorEnvelopeSchema.safeParse(await response.json().catch(() => null));
    throw error.success ? new StudioApiError(error.data.error.message, error.data.error.code, error.data.error.requestId) : new StudioApiError(`The export returned HTTP ${response.status}.`);
  }
  const fileName = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "leads.csv";
  const rows = Number(response.headers.get("x-exported-rows") ?? 0);
  const matching = Number(response.headers.get("x-matching-rows") ?? rows);
  return { blob: await response.blob(), fileName, rows, matching };
}

/** Reads a CSV file and says what importing it would do, row by row, without creating anything. Leave `mapping` out to get a guess from the header row. */
export async function previewImport(input: z.input<typeof importInputSchema>) {
  return successEnvelope(importPreviewSchema).parse(await request("/v1/sales/leads/import/preview", json(importInputSchema.parse(input)))).data;
}
/** Creates the clean rows as Identified leads owned by you; duplicates are skipped unless `importDuplicates`. Running the same file twice creates nothing new. */
export async function commitImport(input: z.input<typeof importCommitInputSchema>) {
  return successEnvelope(importResultSchema).parse(await request("/v1/sales/leads/import/commit", json(importCommitInputSchema.parse(input)))).data;
}

/** Your saved Leads filters (at most 20), oldest first. */
export async function listViews() {
  return successEnvelope(z.array(savedViewSchema)).parse(await request("/v1/sales/views")).data;
}
/** Saves the filters under a name; the same name (any case) replaces the earlier view. */
export async function saveView(input: z.input<typeof savedViewInputSchema>) {
  return successEnvelope(savedViewSchema).parse(await request("/v1/sales/views", json(savedViewInputSchema.parse(input)))).data;
}
export async function deleteView(viewId: string) {
  await request(`/v1/sales/views/${id(viewId)}`, { method: "DELETE" });
}

// ---- Review: drafts with their approval state. The API says per draft whether a person still has to approve it before it is sent
// (`needsPersonApproval`) and why (`approvalReason`: a play's first batch, or a venture that approves every message). These readers keep
// both fields even where the shared draft schema does not list them yet; they are absent from an API that does not send them.
const draftApprovalShape = { needsPersonApproval: z.boolean().optional(), approvalReason: z.enum(["first_batch", "every_message"]).nullable().optional() };
const reviewDraftSchema = draftWithLeadSchema.extend(draftApprovalShape);
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

/** Drafts for Review (same query as `listDrafts`), with `needsPersonApproval` and `approvalReason` when the API sends them. */
export async function listReviewDrafts(input: { ventureId?: string; status?: string; owner?: "me"; limit?: number } = {}) {
  return successEnvelope(z.array(reviewDraftSchema)).parse(await request(`/v1/sales/drafts${query(input)}`)).data;
}

/**
 * One draft by id, in any venture you can open and any status, or null when there is none. Reads GET /v1/sales/drafts/:id; an API
 * without that route answers "Route not found", and then your 500 most recently changed drafts are searched instead.
 */
export async function getDraft(draftId: string): Promise<ReviewDraft | null> {
  try {
    const body = await request(`/v1/sales/drafts/${id(draftId)}`);
    const parsed = successEnvelope(z.union([reviewDraftSchema, z.object({ draft: reviewDraftSchema })])).parse(body).data;
    return "draft" in parsed && typeof parsed.draft === "object" ? parsed.draft : parsed as ReviewDraft;
  } catch (cause) {
    if (!(cause instanceof StudioApiError) || cause.code !== "NOT_FOUND") throw cause;
    if (!/route/i.test(cause.message)) return null;
  }
  const recent = await listReviewDrafts({ status: "draft,in_review,ready,needs_changes,sent,vetoed,discarded", limit: 500 });
  return recent.find((draft) => draft.id === draftId) ?? null;
}

// ---- Venture settings, cached: screens that only read a venture's settings (the reply clock, approval mode) share one read per venture
// for five minutes. A failed read is not kept, so the next screen tries again; callers fall back to the defaults meanwhile.
const SETTINGS_TTL_MS = 5 * 60_000;
const settingsCache = new Map<string, { at: number; value: Promise<SalesSettingsView | null> }>();
export function getCachedSalesSettings(ventureId: string): Promise<SalesSettingsView | null> {
  const hit = settingsCache.get(ventureId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  const value = getSalesSettings(ventureId).catch(() => { settingsCache.delete(ventureId); return null; });
  settingsCache.set(ventureId, { at: Date.now(), value });
  return value;
}
/** After a save: the cache holds what was saved, so other screens see it at once. */
export function rememberSalesSettings(settings: SalesSettingsView) {
  settingsCache.set(settings.ventureId, { at: Date.now(), value: Promise.resolve(settings) });
}

// ---- Company-search keys (TinyFish, Exa) for search_companies and the lead finder: admins only, for the whole workspace. The API never
// sends a key back, only whether one is set, where from, and a saved key's last four characters.
import { salesSearchKeyInputSchema, salesSearchKeysSchema, salesSearchKeyTestSchema, type SalesSearchEngine, type SalesSearchKeys, type SalesSearchKeyStatus, type SalesSearchKeyTest } from "@venture-studio/contracts";
export type { SalesSearchEngine, SalesSearchKeys, SalesSearchKeyStatus, SalesSearchKeyTest };

export async function getSearchKeys() {
  return successEnvelope(salesSearchKeysSchema).parse(await request("/v1/sales/search-keys")).data;
}
/** Saves (or replaces) the engine's key, encrypted on the server; it wins over a key set on the server. Answers the new status. */
export async function saveSearchKey(engine: SalesSearchEngine, key: string) {
  return successEnvelope(salesSearchKeysSchema).parse(await request(`/v1/sales/search-keys/${id(engine)}`, { method: "PUT", body: JSON.stringify(salesSearchKeyInputSchema.parse({ key })) })).data;
}
/** Removes the key saved in the app; a key set on the server (if any) is used again. Answers the new status. */
export async function removeSearchKey(engine: SalesSearchEngine) {
  return successEnvelope(salesSearchKeysSchema).parse(await request(`/v1/sales/search-keys/${id(engine)}`, { method: "DELETE" })).data;
}
/** One small search with the key in use (it counts against the allowance): `{ ok: true }`, or `{ ok: false, message }`. */
export async function testSearchKey(engine: SalesSearchEngine) {
  return successEnvelope(salesSearchKeyTestSchema).parse(await request(`/v1/sales/search-keys/${id(engine)}/test`, json({}))).data;
}
