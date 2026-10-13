import type { AppDb } from "./db.js";
import type { AppDocument } from "./db.js";
import type { Collection } from "mongodb";
import { isTrustedPushEndpoint } from "@venture-studio/core";

export async function deduplicatePushEndpoints(collection: Collection<AppDocument>): Promise<number> {
  let retired = 0;
  const byEndpoint = new Map<string, AppDocument[]>();
  const cursor = collection.find({ endpoint: { $type: "string" } }, { projection: { _id: 1, endpoint: 1 } });
  for await (const row of cursor) {
    const raw = String(row.endpoint);
    const canonical = isTrustedPushEndpoint(raw) ? new URL(raw).href : raw;
    const group = byEndpoint.get(canonical) ?? [];
    group.push(row);
    byEndpoint.set(canonical, group);
  }
  const retire = async (row: AppDocument) => {
    const result = await collection.updateOne({ _id: row._id, endpoint: row.endpoint }, { $set: { active: false, retiredAt: new Date() }, $unset: { endpoint: "", keys: "" } });
    retired += result.modifiedCount;
  };
  // Retire every ambiguous or untrusted legacy row before normalizing single owners.
  for (const [canonical, rows] of byEndpoint) {
    if (rows.length === 1 && isTrustedPushEndpoint(canonical)) continue;
    for (const row of rows) await retire(row);
  }
  for (const [canonical, rows] of byEndpoint) {
    if (rows.length !== 1 || !isTrustedPushEndpoint(canonical)) continue;
    const row = rows[0]!;
    if (row.endpoint !== canonical) await collection.updateOne({ _id: row._id, endpoint: row.endpoint }, { $set: { endpoint: canonical } });
  }
  return retired;
}

export async function ensurePushEndpointIndex(collection: Collection<AppDocument>): Promise<void> {
  let indexes: Awaited<ReturnType<typeof collection.indexes>>;
  try { indexes = await collection.indexes(); }
  catch (error) {
    if ((error as { code?: number }).code !== 26) throw error; // Collection does not exist yet.
    indexes = [];
  }
  const endpointIndex = indexes.find((index) => index.name === "endpoint_1");
  if (endpointIndex && (!endpointIndex.unique || endpointIndex.key?.endpoint !== 1)) throw new Error("Unexpected push endpoint index; manual migration review required");
  // The earlier non-partial unique index cannot hold more than one retired row without an endpoint.
  if (endpointIndex && !endpointIndex.partialFilterExpression) await collection.dropIndex("endpoint_1");
  await deduplicatePushEndpoints(collection);
  await collection.createIndex({ endpoint: 1 }, { unique: true, partialFilterExpression: { endpoint: { $type: "string" } } });
}

/** Drops an index being replaced; another process starting at the same time may have dropped it first (IndexNotFound), which is fine. */
async function dropIfThere(collection: Collection<AppDocument>, name: string): Promise<void> {
  try { await collection.dropIndex(name); }
  catch (error) { if ((error as { code?: number }).code !== 27) throw error; }
}

/**
 * The do-not-contact list holds one entry per normalised value. Entries written without a key (older imports) must not collide,
 * so the unique index covers only keyed entries; the first version of this index covered all of them and is replaced.
 */
export async function ensureSuppressionKeyIndex(collection: Collection<AppDocument>): Promise<void> {
  let indexes: Awaited<ReturnType<typeof collection.indexes>>;
  try { indexes = await collection.indexes(); }
  catch (error) {
    if ((error as { code?: number }).code !== 26) throw error; // Collection does not exist yet.
    indexes = [];
  }
  const existing = indexes.find((index) => index.name === "workspaceId_1_key_1");
  if (existing && !existing.partialFilterExpression) await dropIfThere(collection, "workspaceId_1_key_1");
  await collection.createIndex({ workspaceId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: "string" } } });
}

/**
 * One lead per import reference in each venture, so the lead finder can find the same company for two ventures. The first version of this
 * index made references unique across the whole workspace and is replaced (a reference unique per workspace is unique per venture too).
 */
export async function ensureLeadReferenceIndex(collection: Collection<AppDocument>): Promise<void> {
  let indexes: Awaited<ReturnType<typeof collection.indexes>>;
  try { indexes = await collection.indexes(); }
  catch (error) {
    if ((error as { code?: number }).code !== 26) throw error; // Collection does not exist yet.
    indexes = [];
  }
  if (indexes.some((index) => index.name === "workspaceId_1_externalRef.system_1_externalRef.id_1")) await dropIfThere(collection, "workspaceId_1_externalRef.system_1_externalRef.id_1");
  await collection.createIndex({ workspaceId: 1, ventureId: 1, "externalRef.system": 1, "externalRef.id": 1 }, { unique: true, partialFilterExpression: { "externalRef.id": { $type: "string" } } });
}

/** A collection has one text index: the task one now covers details too, so an older one without them is replaced. */
async function ensureTaskTextIndex(db: AppDb): Promise<void> {
  const tasks = db.collection("tasks");
  const existing = (await tasks.listIndexes().toArray().catch(() => [])).find((index) => index.key?._fts === "text");
  if (existing && !existing.weights?.details) await tasks.dropIndex(String(existing.name));
  await tasks.createIndex({ title: "text", outcome: "text", definitionOfDone: "text", details: "text", tags: "text" });
}

export async function ensureIndexes(db: AppDb): Promise<void> {
  await ensurePushEndpointIndex(db.collection("push_subscriptions"));
  await ensureSuppressionKeyIndex(db.collection("sales_suppression"));
  await ensureLeadReferenceIndex(db.collection("opportunities"));
  await Promise.all([
    db.collection("workspaces").createIndex({ slug: 1 }, { unique: true }),
    // Recovery copies from permanent venture deletes expire on their own after 30 days.
    db.collection("deleted_records").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("deleted_records").createIndex({ deletionId: 1 }),
    db.collection("memberships").createIndex({ workspaceId: 1, userId: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ userId: 1 }, { unique: true, partialFilterExpression: { status: "active" } }),
    db.collection("ventures").createIndex({ workspaceId: 1, name: 1 }, { unique: true }),
    db.collection("groups").createIndex({ ventureId: 1, name: 1 }, { unique: true }),
    db.collection("channels").createIndex({ groupId: 1, name: 1 }, { unique: true }),
    db.collection("messages").createIndex({ channelId: 1, createdAt: -1 }),
    db.collection("messages").createIndex({ dmKey: 1, createdAt: -1 }),
    db.collection("messages").createIndex({ body: "text" }),
    db.collection("messages").createIndex({ workspaceId: 1, authorId: 1, clientId: 1 }, { unique: true }),
    db.collection("message_reactions").createIndex({ messageId: 1, userId: 1, emoji: 1 }, { unique: true }),
    db.collection("message_saves").createIndex({ userId: 1, messageId: 1 }, { unique: true }),
    db.collection("message_saves").createIndex({ userId: 1, createdAt: -1, _id: -1 }),
    db.collection("tasks").createIndex({ workspaceId: 1, assigneeId: 1, status: 1, dueAt: 1 }),
    db.collection("tasks").createIndex({ ventureId: 1, groupId: 1, status: 1 }),
    ensureTaskTextIndex(db),
    db.collection("command_executions").createIndex({ workspaceId: 1, actorId: 1, idempotencyKey: 1 }, { unique: true }),
    db.collection("reminders").createIndex({ state: 1, scheduledAt: 1, leaseUntil: 1 }),
    db.collection("notification_outbox").createIndex({ idempotencyKey: 1 }, { unique: true }),
    db.collection("notification_outbox").createIndex({ state: 1, nextAttemptAt: 1, leaseUntil: 1 }),
    db.collection("notifications").createIndex({ outboxId: 1 }, { unique: true }),
    db.collection("notifications").createIndex({ workspaceId: 1, userId: 1, createdAt: -1, _id: -1 }),
    db.collection("notifications").createIndex({ workspaceId: 1, userId: 1, chatKind: 1, chatId: 1, createdAt: -1, _id: -1 }),
    db.collection("documents").createIndex({ workspaceId: 1, ventureId: 1, sensitivity: 1 }),
    db.collection("document_versions").createIndex({ documentId: 1, version: 1 }, { unique: true }),
    db.collection("document_suggestions").createIndex({ documentId: 1, state: 1, createdAt: -1 }),
    // Venture context, skills, and Claude's record of having read a venture's context.
    db.collection("venture_context").createIndex({ workspaceId: 1, ventureId: 1, createdAt: 1, _id: 1 }),
    db.collection("skills").createIndex({ workspaceId: 1, ventureId: 1, title: 1, _id: 1 }),
    db.collection("mcp_context_reads").createIndex({ patId: 1, ventureId: 1 }, { unique: true }),
    db.collection("mcp_context_reads").createIndex({ patId: 1, readAt: -1 }),
    // A read only counts for 12 hours, so week-old rows are cleared away.
    db.collection("mcp_context_reads").createIndex({ readAt: 1 }, { expireAfterSeconds: 7 * 86_400 }),
    // The Knowledge screen's chat and task file browsers, newest first.
    db.collection("messages").createIndex({ workspaceId: 1, groupId: 1, createdAt: -1, _id: -1 }, { partialFilterExpression: { "attachments.0": { $exists: true } } }),
    db.collection("files").createIndex({ workspaceId: 1, createdAt: -1, _id: -1 }, { partialFilterExpression: { taskId: { $exists: true } } }),
    // Finding everything about one task (its page, and deleting or restoring it).
    db.collection("task_updates").createIndex({ taskId: 1, createdAt: 1 }),
    db.collection("evidence_items").createIndex({ taskId: 1, submittedAt: 1 }),
    // Evidence waiting for review, for the "Needs my review" task list.
    db.collection("evidence_items").createIndex({ workspaceId: 1, reviewStatus: 1 }),
    // Work handed in during a period (early work counts then), for the leaderboard.
    db.collection("evidence_items").createIndex({ workspaceId: 1, submittedAt: 1 }),
    // Reviews done in a period, for the leaderboard's reviewers.
    db.collection("evidence_items").createIndex({ workspaceId: 1, reviewedAt: 1 }, { partialFilterExpression: { reviewedAt: { $exists: true } } }),
    // Tasks due in a period, and open tasks past due, for the leaderboard.
    db.collection("tasks").createIndex({ workspaceId: 1, dueAt: 1 }),
    db.collection("tasks").createIndex({ workspaceId: 1, status: 1, dueAt: 1 }),
    // One celebration per person per finished task, and each person's waiting ones.
    db.collection("celebrations").createIndex({ workspaceId: 1, userId: 1, taskId: 1 }, { unique: true }),
    db.collection("celebrations").createIndex({ workspaceId: 1, userId: 1, state: 1, createdAt: 1 }),
    db.collection("reminders").createIndex({ taskId: 1 }, { partialFilterExpression: { taskId: { $exists: true } } }),
    db.collection("notification_outbox").createIndex({ resourceId: 1 }, { partialFilterExpression: { resourceId: { $exists: true } } }),
    db.collection("notification_outbox").createIndex({ reminderId: 1 }, { partialFilterExpression: { reminderId: { $exists: true } } }),
    db.collection("notifications").createIndex({ resourceId: 1 }, { partialFilterExpression: { resourceId: { $exists: true } } }),
    db.collection("notifications").createIndex({ reminderId: 1 }, { partialFilterExpression: { reminderId: { $exists: true } } }),
    db.collection("files").createIndex({ taskId: 1 }, { partialFilterExpression: { taskId: { $exists: true } } }),
    db.collection("focus_sessions").createIndex({ taskId: 1 }, { partialFilterExpression: { taskId: { $exists: true } } }),
    db.collection("class_applications").createIndex({ taskId: 1 }, { partialFilterExpression: { taskId: { $exists: true } } }),
    db.collection("tasks").createIndex({ parentTaskId: 1 }, { partialFilterExpression: { parentTaskId: { $exists: true } } }),
    db.collection("tasks").createIndex({ dependencies: 1 }),
    db.collection("command_executions").createIndex({ "result.task._id": 1 }, { partialFilterExpression: { "result.task._id": { $exists: true } } }),
    // Mentions in notices are looked up by handle.
    db.collection("users").createIndex({ workspaceId: 1, handle: 1 }),
    db.collection("document_suggestions").createIndex({ workspaceId: 1, state: 1, createdAt: 1 }),
    // One waiting suggestion per person per document: suggesting again replaces it.
    db.collection("document_suggestions").createIndex({ documentId: 1, proposedBy: 1 }, { unique: true, partialFilterExpression: { state: "pending" } }),
    // Approvers' queue of requests to share with all ventures.
    db.collection("documents").createIndex({ workspaceId: 1, "review.state": 1, "review.requestedAt": 1 }, { partialFilterExpression: { "review.state": { $exists: true } } }),
    db.collection("document_chunks").createIndex({ plainText: "text", headingPath: "text" }),
    db.collection("files").createIndex({ workspaceId: 1, ventureId: 1, status: 1 }),
    db.collection("files").createIndex({ workspaceId: 1, groupId: 1, status: 1, createdAt: -1, _id: -1 }),
    db.collection("files").createIndex({ name: "text" }),
    // Text read out of PDF, Word, Markdown, and plain-text files (see file-text.ts), searched alongside file names.
    db.collection("file_texts").createIndex({ text: "text" }),
    db.collection("file_texts").createIndex({ workspaceId: 1, ventureId: 1 }),
    // Calendar: my events and invitations, shared calendars by venture, and the date window every range query uses.
    db.collection("channel_notification_settings").createIndex({ workspaceId: 1, userId: 1, channelId: 1 }, { unique: true }),
    db.collection("channel_notification_settings").createIndex({ workspaceId: 1, channelId: 1, level: 1 }),
    db.collection("calendar_events").createIndex({ workspaceId: 1, organizerId: 1, startAt: 1 }),
    db.collection("calendar_events").createIndex({ workspaceId: 1, "attendees.userId": 1, startAt: 1 }),
    db.collection("calendar_events").createIndex({ workspaceId: 1, ventureId: 1, visibility: 1, startAt: 1 }),
    db.collection("calendar_events").createIndex({ workspaceId: 1, groupId: 1, visibility: 1, startAt: 1 }, { partialFilterExpression: { visibility: "group" } }),
    db.collection("calendar_events").createIndex({ seriesEndAt: 1, startAt: 1 }),
    db.collection("calendar_feeds").createIndex({ workspaceId: 1, userId: 1 }, { unique: true }),
    db.collection("calendar_feeds").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("reminders").createIndex({ eventId: 1, state: 1 }, { partialFilterExpression: { eventId: { $exists: true } } }),
    db.collection("pats").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("pats").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("mcp_executions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("events").createIndex({ workspaceId: 1, occurredAt: 1, _id: 1 }),
    db.collection("audit_events").createIndex({ workspaceId: 1, occurredAt: -1 }),
    db.collection("api_rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Sales (Dealflow): leads are the `opportunities` collection. List, owner, next-action, play and do-not-contact lookups.
    db.collection("opportunities").createIndex({ workspaceId: 1, ventureId: 1, stage: 1, updatedAt: -1 }),
    db.collection("opportunities").createIndex({ workspaceId: 1, ownerId: 1, stage: 1 }),
    db.collection("opportunities").createIndex({ workspaceId: 1, ventureId: 1, nextActionAt: 1 }),
    db.collection("opportunities").createIndex({ pipelineId: 1 }),
    db.collection("opportunities").createIndex({ workspaceId: 1, playId: 1 }, { partialFilterExpression: { playId: { $exists: true } } }),
    // The leads of an offer: the Offer filter, its counts and the offer facet.
    db.collection("opportunities").createIndex({ workspaceId: 1, offerId: 1, stage: 1 }, { partialFilterExpression: { offerId: { $exists: true } } }),
    db.collection("opportunities").createIndex({ workspaceId: 1, suppressKeys: 1 }),
    // Imports can be re-run: one lead per external reference in each venture (ensureLeadReferenceIndex, above).
    db.collection("sales_activities").createIndex({ leadId: 1, at: -1 }),
    db.collection("sales_activities").createIndex({ workspaceId: 1, ventureId: 1, direction: 1, handledAt: 1, at: -1 }),
    db.collection("sales_activities").createIndex({ workspaceId: 1, ventureId: 1, at: -1 }),
    // The same requestId repeats the first answer instead of logging an activity twice.
    db.collection("sales_activities").createIndex({ workspaceId: 1, leadId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: "string" } } }),
    db.collection("sales_verdicts").createIndex({ leadId: 1, createdAt: -1 }),
    // Reports and Daybreak read a venture's verdicts by date (Claude's calibration, stale signals).
    db.collection("sales_verdicts").createIndex({ workspaceId: 1, ventureId: 1, createdAt: -1 }),
    // A lead's next-action reminder is looked up on every lead edit; reports ask how leads without an import reference were made.
    db.collection("reminders").createIndex({ workspaceId: 1, leadId: 1 }, { partialFilterExpression: { leadId: { $exists: true } } }),
    db.collection("audit_events").createIndex({ workspaceId: 1, objectId: 1 }, { partialFilterExpression: { action: "sales.lead.create" } }),
    // Company-search counters (one per workspace, engine and day or month) clear themselves two months on.
    db.collection("mcp_search_usage").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("sales_drafts").createIndex({ leadId: 1, createdAt: -1 }),
    db.collection("sales_drafts").createIndex({ workspaceId: 1, ventureId: 1, status: 1, updatedAt: -1 }),
    db.collection("sales_plays").createIndex({ workspaceId: 1, ventureId: 1, status: 1 }),
    db.collection("sales_find_runs").createIndex({ workspaceId: 1, ventureId: 1, createdAt: -1 }),
    db.collection("sales_find_runs").createIndex({ workspaceId: 1, status: 1, createdAt: 1 }),
    // The built-in lead finder looks across workspaces for the oldest queued (or stale) run.
    db.collection("sales_find_runs").createIndex({ status: 1, createdAt: 1 }),
    db.collection("sales_brain_items").createIndex({ workspaceId: 1, ventureId: 1, kind: 1, title: 1, status: 1 }),
    // Offers (sales/offers.ts): one name per venture (any case), and one number per version of an offer.
    db.collection("sales_offers").createIndex({ workspaceId: 1, ventureId: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } }),
    db.collection("sales_offer_versions").createIndex({ offerId: 1, version: -1 }, { unique: true }),
    db.collection("sales_offer_versions").createIndex({ workspaceId: 1, offerId: 1, status: 1 }),
    // One do-not-contact list for every venture: one entry per normalised value.
    db.collection("sales_suppression").createIndex({ workspaceId: 1, createdAt: -1 }),
    // Saved Leads filters, one list per person; one view per name (any case) and page.
    db.collection("sales_views").createIndex({ workspaceId: 1, userId: 1, createdAt: 1 }),
    db.collection("sales_views").createIndex({ workspaceId: 1, userId: 1, page: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } }),
    // Daily send counters (sales/leads.ts claimSendSlot): one row per person, venture, channel and day, gone about 90 days after the day.
    db.collection("sales_send_counters").createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }),
    // Claude's sales conversations (start_sales): expired sessions clear themselves; lookups are by _id.
    db.collection("mcp_sales_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}
