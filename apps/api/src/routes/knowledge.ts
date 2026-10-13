import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ClientSession, Document } from "mongodb";
import type { AppDb, AppDocument } from "../db.js";
import { classSchema, createDocumentSchema, cursorQuerySchema, decisionSchema, documentListQuerySchema, idSchema, informationRequestSchema, knowledgeReviewSchema, knowledgeSearchSchema, reviewClassApplicationSchema, updateClassSchema, updateDecisionSchema, updateDocumentSchema } from "@venture-studio/contracts";
import { can, readableSensitivities, sharesKnowledge } from "@venture-studio/core";
import { z } from "zod";
import type { Database } from "../db.js";
import { atomic } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { inArchivedVenture, notArchived } from "../archive-scope.js";
import { authorizedDocumentFilter } from "../document-access.js";
import { listedInOrAdmin } from "../assignable.js";
import { jsonValue, slug, withDates } from "../json.js";
import { assertNotBlank } from "../validation.js";

type Actor = NonNullable<Express.Request["actor"]>;

export function knowledgeRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  router.post("/documents", async (req, res) => {
    const input = createDocumentSchema.parse(req.body);
    const actor = req.actor!;
    if (!can(actor.membership, "knowledge:write", { ventureId: input.ventureId })) throw new AppError(403, "FORBIDDEN", "You cannot add knowledge in this scope");
    // Workspace-wide knowledge from someone not allowed to share with all ventures waits, hidden, for an approver.
    const request = !input.ventureId && !sharesKnowledge(actor.membership);
    if (input.sensitivity === "founder_private" && actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may create founder-private documents");
    if (!readableSensitivities(actor.membership.role).includes(input.sensitivity)) throw new AppError(403, "FORBIDDEN", "Choose a sensitivity level you can read; this one would hide the record from you");
    const now = new Date();
    const documentId = randomUUID();
    const versionId = randomUUID();
    const document = { _id: documentId, workspaceId: actor.membership.workspaceId, ...(input.ventureId ? { ventureId: input.ventureId } : {}), title: input.title, slug: slug(input.title), ownerId: actor.id, status: "draft", evidenceClass: input.evidenceClass, sensitivity: input.sensitivity, authoritativeRank: input.authoritativeRank, currentVersionId: versionId, ...(request ? { review: { state: "pending", requestedBy: actor.id, requestedAt: now } } : {}), createdAt: now, updatedAt: now };
    const viaClaude = req.interfaceChannel === "mcp";
    const version = { _id: versionId, workspaceId: actor.membership.workspaceId, documentId, version: 1, markdown: input.markdown, changeSummary: claudeSummary(input.changeSummary, viaClaude), createdBy: actor.id, createdAt: now, ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}), ...(viaClaude ? { via: "claude" } : {}) };
    await atomic(database, async (session) => {
      await db.collection("documents").insertOne(document, { session });
      await db.collection("document_versions").insertOne(version, { session });
      await db.collection("document_chunks").insertMany(chunks(input.markdown).map((chunk, index) => ({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...(input.ventureId ? { ventureId: input.ventureId } : {}), documentId, documentVersionId: versionId, headingPath: chunk.heading, ordinal: index, plainText: chunk.text, createdAt: now })), { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: request ? "document.share_request" : "document.create", objectType: "document", objectId: documentId, ventureId: input.ventureId, result: "success" }, session);
      if (request) await notifyApprovers(db, actor, { title: `${actor.name} asked to share "${input.title.slice(0, 120)}" with all ventures`, body: "Review it before it reaches every venture.", documentId, key: `knowledge:request:${documentId}:1` }, input.sensitivity, session);
    });
    res.status(201).json({ ok: true, data: documentJson({ ...document, currentVersion: documentVersionJson(version) }) });
  });

  router.get("/documents", async (req, res) => {
    const actor = req.actor!; const query = documentListQuerySchema.parse(req.query);
    const filter = authorizedDocumentFilter(actor, query.ventureId);
    if (query.status) filter.status = query.status;
    const cursor = query.cursor ? await db.collection("documents").findOne({ _id: idSchema.parse(query.cursor), ...filter }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Document cursor not found");
    const after = cursor ? { $or: [{ updatedAt: { $lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, _id: { $lt: cursor._id } }] } : {};
    const rows = await db.collection("documents").find({ $and: [filter, after] }).sort({ updatedAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: rows.slice(0, query.limit).map(documentJson), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?._id) : undefined } });
  });
  router.get("/documents/:id", async (req, res) => {
    const actor = req.actor!;
    const document = await accessibleDocument(db, actor, idSchema.parse(req.params.id));
    const [version, versions] = await Promise.all([
      db.collection("document_versions").findOne({ _id: document.currentVersionId }),
      db.collection("document_versions").find({ documentId: document._id }).sort({ version: -1 }).project({ markdown: 0 }).toArray(),
    ]);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "document.read", objectType: "document", objectId: String(document._id), ventureId: document.ventureId ? String(document.ventureId) : undefined, result: "success" });
    // Approvers see every waiting suggestion; anyone else sees only their own.
    const approver = sharesKnowledge(actor.membership);
    const suggestions = document.ventureId ? [] : await db.collection("document_suggestions").find({ documentId: document._id, ...(approver ? { state: "pending" } : { proposedBy: actor.id, state: { $in: ["pending", "declined"] } }) }).sort({ createdAt: -1 }).limit(20).toArray();
    res.json({ ok: true, data: documentJson({ ...document, currentVersion: documentVersionJson(version), versions: versions.map(documentVersionJson), suggestions: suggestions.map((item) => suggestionJson(item, true)) }) });
  });

  // An approver's queue: new documents waiting to be shared with all ventures, and suggested changes to shared ones.
  router.get("/knowledge/reviews", async (req, res) => {
    const actor = req.actor!;
    if (!sharesKnowledge(actor.membership)) { res.json({ ok: true, data: { requests: [], suggestions: [] } }); return; }
    const visible = authorizedDocumentFilter(actor);
    const requests = await db.collection("documents").find({ $and: [visible, { "review.state": "pending" }] }).sort({ "review.requestedAt": 1 }).limit(50).toArray();
    // Suggestions only on documents this approver can read, so ones they can't see never crowd out the rest.
    const suggested = await db.collection("document_suggestions").distinct("documentId", { workspaceId: actor.membership.workspaceId, state: "pending" });
    const titles = new Map((await db.collection("documents").find({ $and: [visible, { _id: { $in: suggested } }] }).project({ title: 1 }).toArray()).map((item) => [String(item._id), String(item.title)]));
    const suggestions = titles.size ? await db.collection("document_suggestions").find({ workspaceId: actor.membership.workspaceId, state: "pending", documentId: { $in: [...titles.keys()] } }).sort({ createdAt: 1 }).limit(50).toArray() : [];
    res.json({ ok: true, data: { requests: requests.map(documentJson), suggestions: suggestions.map((item) => ({ ...(suggestionJson(item, false) as object), documentTitle: titles.get(String(item.documentId)) })) } });
  });

  // Approve or decline a request to share a new document with all ventures; its author may withdraw it.
  router.post("/documents/:id/review", async (req, res) => {
    const actor = req.actor!;
    const { decision, note, versionId } = knowledgeReviewSchema.extend({ decision: z.enum(["approve", "decline", "withdraw"]) }).parse(req.body);
    const document = await accessibleDocument(db, actor, idSchema.parse(req.params.id));
    if (!document.review) throw new AppError(409, "CONFLICT", "This document isn't waiting for approval");
    if (decision === "withdraw" ? document.ownerId !== actor.id : !sharesKnowledge(actor.membership)) throw new AppError(403, "FORBIDDEN", decision === "withdraw" ? "Only its author can withdraw a request" : "Only admins and people allowed to share with all ventures may review requests");
    if (decision === "approve" && !versionId) throw new AppError(400, "BAD_REQUEST", "Say which version you reviewed");
    const now = new Date();
    const title = String(document.title).slice(0, 120);
    const author = String(document.ownerId);
    await atomic(database, async (session) => {
      // Approval publishes only the version the approver read, and never a request withdrawn meanwhile.
      const filter = { _id: document._id, status: { $ne: "archived" }, "review.state": decision === "withdraw" ? { $in: ["pending", "declined"] } : "pending", ...(decision === "approve" ? { currentVersionId: versionId } : {}) };
      const update = decision === "approve" ? { $unset: { review: "" }, $set: { status: "approved", lastReviewedAt: now, updatedAt: now } }
        : decision === "decline" ? { $set: { "review.state": "declined", ...(note ? { "review.note": note } : {}), "review.decidedBy": actor.id, "review.decidedAt": now, updatedAt: now } }
        : { $set: { status: "archived", updatedAt: now } };
      const changed = await db.collection("documents").updateOne(filter, update, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This request was changed or already decided; reload it to see the latest version");
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: `document.share_request.${decision}`, objectType: "document", objectId: String(document._id), result: "success" }, session);
      if (decision !== "withdraw" && author !== actor.id) await notifyPeople(db, actor.membership.workspaceId, [author], {
        title: decision === "approve" ? `"${title}" is now shared with all ventures` : `Not shared with all ventures: "${title}"`,
        body: decision === "approve" ? `${actor.name} approved it.` : note ? `${actor.name}: ${note}` : `${actor.name} declined it. You can edit it and send it again.`,
        documentId: String(document._id), key: `knowledge:result:${document._id}:${now.getTime()}`,
      }, session);
    });
    res.json({ ok: true, data: documentJson(await db.collection("documents").findOne({ _id: document._id })) });
  });

  // Approve (it becomes the live version) or decline a suggested change to a workspace-wide document.
  router.post("/documents/:id/suggestions/:suggestionId/review", async (req, res) => {
    const actor = req.actor!;
    const { decision, note } = knowledgeReviewSchema.parse(req.body);
    const document = await accessibleDocument(db, actor, idSchema.parse(req.params.id));
    if (!sharesKnowledge(actor.membership)) throw new AppError(403, "FORBIDDEN", "Only admins and people allowed to share with all ventures may review suggestions");
    const suggestion = await db.collection("document_suggestions").findOne({ _id: idSchema.parse(req.params.suggestionId), documentId: document._id, state: "pending" });
    if (!suggestion) throw new AppError(409, "CONFLICT", "This suggestion was already decided; reload the document");
    const now = new Date();
    const proposer = String(suggestion.proposedBy);
    const proposerName = String((await db.collection("users").findOne({ _id: proposer }, { projection: { name: 1 } }))?.name ?? "Someone");
    await atomic(database, async (session) => {
      const current = await db.collection("documents").findOne({ _id: document._id, status: { $ne: "archived" } }, { session });
      if (!current) throw new AppError(409, "CONFLICT", "This document was archived; reload it");
      // A suggestion replaces the whole text, so accepting one written on an older version would undo the changes made since.
      if (decision === "approve" && current.currentVersionId !== suggestion.baseVersionId) throw new AppError(409, "CONFLICT", "The document has changed since this was suggested, so accepting it would undo those changes. Decline it and ask for the change again on the latest version.");
      const decided = await db.collection("document_suggestions").updateOne({ _id: suggestion._id, state: "pending" }, { $set: { state: decision === "approve" ? "approved" : "declined", ...(note ? { note } : {}), decidedBy: actor.id, decidedAt: now, updatedAt: now } }, { session });
      if (!decided.modifiedCount) throw new AppError(409, "CONFLICT", "This suggestion was already decided; reload the document");
      if (decision === "approve") {
        const last = await db.collection("document_versions").find({ documentId: document._id }, { session }).sort({ version: -1 }).limit(1).next();
        const versionId = randomUUID();
        await db.collection("document_versions").insertOne({ _id: versionId, workspaceId: actor.membership.workspaceId, documentId: document._id, version: Number(last?.version ?? 0) + 1, markdown: suggestion.markdown, changeSummary: `${String(suggestion.changeSummary).slice(0, 440)} (suggested by ${proposerName.slice(0, 40)})`, createdBy: proposer, approvedBy: actor.id, ...(suggestion.sourceUri ? { sourceUri: suggestion.sourceUri } : {}), createdAt: now }, { session });
        await db.collection("document_chunks").insertMany(chunks(String(suggestion.markdown)).map((chunk, index) => ({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, documentId: document._id, documentVersionId: versionId, headingPath: chunk.heading, ordinal: index, plainText: chunk.text, createdAt: now })), { session });
        const moved = await db.collection("documents").updateOne({ _id: document._id, currentVersionId: current.currentVersionId }, { $set: { currentVersionId: versionId, status: "approved", lastReviewedAt: now, updatedAt: now } }, { session });
        if (!moved.modifiedCount) throw new AppError(409, "CONFLICT", "The document changed while you were accepting this; reload it");
      }
      await countPendingSuggestions(db, String(document._id), session);
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: `document.suggestion.${decision}`, objectType: "document", objectId: String(document._id), result: "success" }, session);
      if (proposer !== actor.id) await notifyPeople(db, actor.membership.workspaceId, [proposer], {
        title: decision === "approve" ? `Your change to "${String(document.title).slice(0, 120)}" was accepted` : `Your change to "${String(document.title).slice(0, 120)}" wasn't accepted`,
        body: decision === "approve" ? `${actor.name} approved it; it's the live version now.` : note ? `${actor.name}: ${note}` : `${actor.name} declined it.`,
        documentId: String(document._id), key: `knowledge:suggestion-result:${suggestion._id}`,
      }, session);
    });
    res.json({ ok: true, data: documentJson(await db.collection("documents").findOne({ _id: document._id })) });
  });

  router.put("/documents/:id", async (req, res) => {
    const actor = req.actor!;
    const input = updateDocumentSchema.parse(req.body);
    const document = await accessibleDocument(db, actor, idSchema.parse(req.params.id));
    if (!can(actor.membership, "knowledge:write", { ventureId: document.ventureId ? String(document.ventureId) : undefined })) throw new AppError(403, "FORBIDDEN", "You cannot edit this document");
    const now = new Date();
    const sharer = sharesKnowledge(actor.membership);
    const ownRequest = Boolean(document.review) && document.ownerId === actor.id;
    if (!document.ventureId && document.review && !ownRequest && !sharer) throw new AppError(403, "FORBIDDEN", "Only its author or an approver can change a request");
    const stale = () => new AppError(409, "CONFLICT", "This document was changed by someone else since you opened it. Reload to see the latest version before saving.");
    if (!document.ventureId && !document.review && !sharer) {
      // A suggested change: kept aside, replacing nothing, until an approver accepts it. Each person has at most one
      // waiting per document; suggesting again replaces it.
      let suggestion = {} as AppDocument;
      await atomic(database, async (session) => {
        const current = await db.collection("documents").findOne({ _id: document._id, status: { $ne: "archived" } }, { session });
        if (!current || current.review || (input.baseVersionId && input.baseVersionId !== current.currentVersionId)) throw new AppError(409, "CONFLICT", "This document was changed by someone else since you opened it. Reload to see the latest version before suggesting a change.");
        const previous = await db.collection("document_suggestions").findOne({ documentId: document._id, proposedBy: actor.id, state: "pending" }, { session });
        suggestion = { _id: previous?._id ?? randomUUID(), workspaceId: actor.membership.workspaceId, documentId: document._id, baseVersionId: current.currentVersionId, markdown: input.markdown, changeSummary: claudeSummary(input.changeSummary, req.interfaceChannel === "mcp"), ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}), proposedBy: actor.id, state: "pending", createdAt: previous?.createdAt ?? now, updatedAt: now };
        if (previous) {
          const replaced = await db.collection("document_suggestions").replaceOne({ _id: previous._id, state: "pending" }, suggestion, { session });
          if (!replaced.matchedCount) throw new AppError(409, "CONFLICT", "Your earlier suggestion was just decided; reload the document");
        } else await db.collection("document_suggestions").insertOne(suggestion, { session });
        await countPendingSuggestions(db, String(document._id), session);
        await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: previous ? "document.suggestion.update" : "document.suggestion.create", objectType: "document", objectId: String(document._id), result: "success" }, session);
        await notifyApprovers(db, actor, { title: `${actor.name} ${previous ? "updated their suggested change" : "suggested a change"} to "${String(current.title).slice(0, 120)}"`, body: input.changeSummary.slice(0, 300), documentId: String(document._id), key: `knowledge:suggestion:${suggestion._id}:${now.getTime()}` }, String(current.sensitivity), session);
      });
      res.status(202).json({ ok: true, data: { suggestion: suggestionJson(suggestion, true) } });
      return;
    }
    const versionId = randomUUID();
    let version = {} as AppDocument;
    await atomic(database, async (session) => {
      // Read and number inside the transaction so concurrent saves cannot share a version number or silently overwrite each other.
      const current = await db.collection("documents").findOne({ _id: document._id, status: { $ne: "archived" } }, { session });
      if (!current || (input.baseVersionId && current.currentVersionId !== input.baseVersionId)) throw stale();
      // Without the permission, only the author's own request is edited directly (if it was approved meanwhile, edits become suggestions).
      const ownsRequest = Boolean(current.review) && current.ownerId === actor.id;
      if (!current.ventureId && !sharer && !ownsRequest) throw stale();
      const last = await db.collection("document_versions").find({ documentId: document._id }, { session }).sort({ version: -1 }).limit(1).next();
      const viaClaude = req.interfaceChannel === "mcp";
      version = { _id: versionId, workspaceId: actor.membership.workspaceId, documentId: document._id, version: Number(last?.version ?? 0) + 1, markdown: input.markdown, changeSummary: claudeSummary(input.changeSummary, viaClaude), ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}), ...(viaClaude ? { via: "claude" } : {}), createdBy: actor.id, createdAt: now };
      await db.collection("document_versions").insertOne(version, { session });
      await db.collection("document_chunks").insertMany(chunks(input.markdown).map((chunk, index) => ({ _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...(document.ventureId ? { ventureId: document.ventureId } : {}), documentId: document._id, documentVersionId: versionId, headingPath: chunk.heading, ordinal: index, plainText: chunk.text, createdAt: now })), { session });
      // The author editing their request: a declined one is sent again; a waiting one tells the approvers it changed.
      const resend = ownsRequest && current.review?.state === "declined";
      const revised = ownsRequest && current.review?.state === "pending";
      const moved = await db.collection("documents").updateOne({ _id: document._id, currentVersionId: current.currentVersionId }, { $set: { currentVersionId: versionId, status: "draft", updatedAt: now, ...(resend ? { "review.state": "pending", "review.requestedAt": now } : {}) }, ...(resend ? { $unset: { "review.note": "", "review.decidedBy": "", "review.decidedAt": "" } } : {}) }, { session });
      if (!moved.modifiedCount) throw stale();
      if (resend || revised) await notifyApprovers(db, actor, { title: `${actor.name} ${resend ? "asked again to share" : "updated their request to share"} "${String(current.title).slice(0, 120)}" with all ventures`, body: input.changeSummary.slice(0, 300), documentId: String(document._id), key: `knowledge:request:${document._id}:${versionId}` }, String(current.sensitivity), session);
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "document.version.create", objectType: "document", objectId: String(document._id), ventureId: document.ventureId ? String(document.ventureId) : undefined, result: "success" }, session);
    });
    res.json({ ok: true, data: documentVersionJson(version) });
  });

  router.patch("/documents/:id/metadata", async (req, res) => {
    const actor = req.actor!;
    const document = await accessibleDocument(db, actor, idSchema.parse(req.params.id));
    if (document.review) throw new AppError(409, "CONFLICT", "This is a request to share with all ventures: approve or decline it in its review");
    if (!document.ventureId ? !sharesKnowledge(actor.membership) : actor.membership.role !== "admin" && actor.membership.role !== "venture_head") throw new AppError(403, "FORBIDDEN", !document.ventureId ? "Only admins and people allowed to share with all ventures may approve workspace-wide knowledge" : "Only an admin or venture head may approve knowledge metadata");
    if (req.body?.status === "stale" && !["approved", "stale"].includes(String(document.status))) throw new AppError(409, "CONFLICT", "Only an approved record can be marked stale; approve it first");
    const input = z.object({ status: z.enum(["draft", "approved", "stale", "archived"]).optional(), lastReviewedAt: z.iso.datetime({ offset: true }).optional(), authoritativeRank: z.number().int().min(0).max(100).optional() }).refine((value) => Object.keys(value).length > 0).parse(req.body);
    // Re-check approval in the write itself so a concurrent edit back to draft cannot be published as stale.
    const metadataResult = await db.collection("documents").updateOne({ _id: document._id, ...(input.status === "stale" ? { status: { $in: ["approved", "stale"] } } : {}) }, { $set: { ...input, ...(input.lastReviewedAt ? { lastReviewedAt: new Date(input.lastReviewedAt) } : {}), updatedAt: new Date() } });
    if (!metadataResult.matchedCount) throw new AppError(409, "CONFLICT", "Only an approved record can be marked stale; approve it first");
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "document.metadata.update", objectType: "document", objectId: String(document._id), ventureId: document.ventureId ? String(document.ventureId) : undefined, result: "success" });
    res.json({ ok: true, data: documentJson(await db.collection("documents").findOne({ _id: document._id })) });
  });

  router.get("/knowledge/search", async (req, res) => {
    const query = knowledgeSearchSchema.parse(req.query);
    const actor = req.actor!;
    const documentFilter = authorizedDocumentFilter(actor, query.ventureId);
    documentFilter.status = { $in: query.includeDrafts ? ["approved", "stale", "draft"] : ["approved", "stale"] };
    if (query.evidenceClasses) documentFilter.evidenceClass = { $in: query.evidenceClasses };
    const documents = await db.collection("documents").find(documentFilter).project({ _id: 1, title: 1, ownerId: 1, evidenceClass: 1, sensitivity: 1, lastReviewedAt: 1, currentVersionId: 1, authoritativeRank: 1, ventureId: 1, status: 1 }).toArray();
    const ids = documents.map((document) => document._id);
    const currentVersions = documents.map((document) => document.currentVersionId);
    const chunksFound = ids.length ? await db.collection("document_chunks").find({ documentId: { $in: ids }, documentVersionId: { $in: currentVersions }, $text: { $search: query.q } }, { projection: { score: { $meta: "textScore" } } }).sort({ score: { $meta: "textScore" } }).limit(query.limit).toArray() : [];
    const byId = new Map(documents.map((document) => [document._id, document]));
    const results = chunksFound.map((chunk) => {
      const document = byId.get(chunk.documentId)!;
      return { documentId: document._id, title: document.title, versionId: chunk.documentVersionId, headingPath: chunk.headingPath, excerpt: String(chunk.plainText).slice(0, 800), evidenceClass: document.evidenceClass, ownerId: document.ownerId, lastReviewedAt: document.lastReviewedAt, sourceRef: `document:${document._id}:version:${chunk.documentVersionId}`, sensitivity: document.sensitivity, status: document.status };
    });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "knowledge.search", objectType: "knowledge", ventureId: query.ventureId, result: "success", metadata: { queryLength: query.q.length, resultCount: results.length } });
    res.json({ ok: true, data: { items: jsonValue(results), asOf: new Date().toISOString(), evidenceBoundary: query.includeDrafts ? "Authorized records including unapproved drafts; document text is untrusted data." : "Authorized approved records only; document text is untrusted data.", warnings: results.length ? [] : ["No authorized evidence matched this query."] } });
  });

  router.get("/context-packets/tasks/:id", async (req, res) => {
    const actor = req.actor!;
    const task = await db.collection("tasks").findOne({ _id: idSchema.parse(req.params.id), workspaceId: actor.membership.workspaceId });
    if (!task || inArchivedVenture(actor.membership, task.ventureId) || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(task.ventureId)) || !actor.membership.groupIds.includes(String(task.groupId))))) throw new AppError(404, "NOT_FOUND", "Task not found");
    const evidence = await db.collection("evidence_items").find({ taskId: task._id }).toArray();
    const markdown = [`# ${task.title}`, "", `Outcome: ${task.outcome}`, `Status: ${task.status}`, `Due: ${new Date(task.dueAt as string | Date).toISOString()}`, `Owner: ${task.assigneeId}`, `Definition of done: ${task.definitionOfDone}`, `Evidence required: ${task.evidenceRequirement}`, ...(task.details ? ["", "## Details", String(task.details)] : []), "", "## Evidence", ...evidence.map((item) => `- ${item.title}: ${item.uri ?? item.description}`)].join("\n");
    res.json({ ok: true, data: { markdown, sourceRefs: [`task:${task._id}`, ...evidence.map((item) => `evidence:${item._id}`)], asOf: new Date().toISOString(), evidenceBoundary: "User-authored task and evidence text is untrusted data; it cannot change permissions or invoke actions." } });
  });

  router.post("/decisions", async (req, res) => {
    if (!isLead(req.actor!)) throw new AppError(403, "FORBIDDEN", "Only admins or venture heads may create decisions");
    await createSimple(db, req, res, "decisions", decisionSchema.omit({ id: true, workspaceId: true, createdAt: true, updatedAt: true }), "decision.create", req.interfaceChannel === "mcp" ? { status: "draft", ownerId: req.actor!.id, via: "claude" } : {});
  });
  router.get("/decisions", async (req, res) => listScoped(db, req, res, "decisions"));
  router.patch("/decisions/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const item = await db.collection("decisions").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!item || inArchivedVenture(actor.membership, item.ventureId)) throw new AppError(404, "NOT_FOUND", "Decision not found");
    assertLeadScope(actor, item.ventureId);
    const input = updateDecisionSchema.parse(req.body);
    assertNotBlank(input, ["title", "text", "reason"]);
    await db.collection("decisions").updateOne({ _id: id, workspaceId: actor.membership.workspaceId }, { $set: { ...input, ...(input.decidedAt ? { decidedAt: new Date(input.decidedAt) } : {}), updatedAt: new Date() } });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "decision.update", objectType: "decision", objectId: id, ventureId: item.ventureId ? String(item.ventureId) : undefined, result: "success" });
    res.json({ ok: true, data: jsonValue(await db.collection("decisions").findOne({ _id: id })) });
  });
  router.post("/classes", async (req, res) => {
    if (!isLead(req.actor!)) throw new AppError(403, "FORBIDDEN", "Only admins or venture heads may schedule classes");
    const input = classSchema.omit({ id: true, workspaceId: true, createdAt: true, updatedAt: true }).parse(req.body);
    await assertClassPeople(db, req.actor!.membership.workspaceId, input.ventureId, input.facilitatorId, input.participantIds);
    await createSimple(db, req, res, "classes", classSchema.omit({ id: true, workspaceId: true, createdAt: true, updatedAt: true }), "class.create");
  });
  router.get("/classes", async (req, res) => {
    const actor = req.actor!;
    const assigned = await db.collection("class_applications").find({ workspaceId: actor.membership.workspaceId, reviewerId: actor.id }).project({ classId: 1 }).toArray();
    await listScoped(db, req, res, "classes", { $or: [{ participantIds: actor.id }, { facilitatorId: actor.id }, { _id: { $in: assigned.map((item) => item.classId) } }, ...(actor.membership.role === "admin" ? [{}] : actor.membership.role === "venture_head" ? [{ ventureId: { $in: actor.membership.ventureIds } }] : [])] });
  });
  router.get("/classes/:id", async (req, res) => {
    const actor = req.actor!; const item = await accessibleClass(db, actor, idSchema.parse(req.params.id));
    if (!canReadAllApplications(actor, item) && !item.participantIds.includes(actor.id) && !(await db.collection("class_applications").findOne({ workspaceId: actor.membership.workspaceId, classId: item._id, reviewerId: actor.id }))) throw new AppError(404, "NOT_FOUND", "Class not found");
    res.json({ ok: true, data: jsonValue(item) });
  });
  router.patch("/classes/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const item = await db.collection("classes").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
    if (!item || inArchivedVenture(actor.membership, item.ventureId)) throw new AppError(404, "NOT_FOUND", "Class not found");
    assertLeadScope(actor, item.ventureId);
    const input = updateClassSchema.parse(req.body);
    assertNotBlank(input, ["title", "objective"]);
    await assertClassPeople(db, actor.membership.workspaceId, item.ventureId, input.facilitatorId ?? String(item.facilitatorId), input.participantIds ?? item.participantIds);
    await db.collection("classes").updateOne({ _id: id, workspaceId: actor.membership.workspaceId }, { $set: { ...input, ...(input.scheduledAt ? { scheduledAt: new Date(input.scheduledAt) } : {}), updatedAt: new Date() } });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "class.update", objectType: "class", objectId: id, ventureId: item.ventureId ? String(item.ventureId) : undefined, result: "success" });
    res.json({ ok: true, data: jsonValue(await db.collection("classes").findOne({ _id: id })) });
  });
  router.post("/information-requests", async (req, res) => {
    const target = z.object({ ventureId: idSchema, respondentId: idSchema }).safeParse(req.body);
    const asker = req.actor!.membership;
    if (target.success && (inArchivedVenture(asker, target.data.ventureId) || (asker.role !== "admin" && !asker.ventureIds.includes(target.data.ventureId)))) throw new AppError(403, "FORBIDDEN", "Venture access denied");
    if (target.success && !(await db.collection("memberships").findOne({ workspaceId: req.actor!.membership.workspaceId, userId: target.data.respondentId, status: "active", ...listedInOrAdmin(target.data.ventureId) }))) throw new AppError(400, "BAD_REQUEST", "The person asked must be an active member of this venture");
    await createSimple(db, req, res, "information_requests", informationRequestSchema.omit({ id: true, workspaceId: true, requesterId: true, status: true, responseMarkdown: true, sourceRefs: true, reviewedBy: true, createdAt: true, updatedAt: true }), "information_request.create", { requesterId: req.actor!.id, status: "open", sourceRefs: [] });
  });
  router.get("/information-requests", async (req, res) => listScoped(db, req, res, "information_requests", { $or: [{ requesterId: req.actor!.id }, { respondentId: req.actor!.id }, { reviewedBy: req.actor!.id }] }));
  router.patch("/information-requests/:id", async (req, res) => {
    const actor = req.actor!; const id = idSchema.parse(req.params.id);
    const item = await db.collection("information_requests").findOne({ _id: id, workspaceId: actor.membership.workspaceId, $or: [{ requesterId: actor.id }, { respondentId: actor.id }, { reviewedBy: actor.id }] });
    if (!item || inArchivedVenture(actor.membership, item.ventureId)) throw new AppError(404, "NOT_FOUND", "Information request not found");
    const input = z.object({ status: z.enum(["open", "answered", "reviewed", "closed"]), responseMarkdown: z.string().max(100_000).optional(), sourceRefs: z.array(z.string()).max(100).optional() }).parse(req.body);
    // open → answered (respondent, may revise) → reviewed (requester or lead, not the respondent) → closed; requester or lead may close or reopen.
    const allowedFrom = { answered: ["open", "answered"], reviewed: ["answered"], closed: ["open", "answered", "reviewed"], open: ["answered", "reviewed", "closed"] }[input.status];
    if (input.status === "answered") {
      if (item.respondentId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the respondent may answer this request");
      if (!input.responseMarkdown?.trim()) throw new AppError(400, "BAD_REQUEST", "Write an answer before marking the request answered");
    } else {
      const lead = actor.membership.role === "admin" || (actor.membership.role === "venture_head" && actor.membership.ventureIds.includes(String(item.ventureId)));
      if (item.requesterId !== actor.id && !lead) throw new AppError(403, "FORBIDDEN", "Only the requester or a venture lead may review, close, or reopen this request");
      if (input.status === "reviewed" && item.respondentId === actor.id) throw new AppError(403, "FORBIDDEN", "You cannot review your own answer; ask the requester or another venture lead");
    }
    const stateError = () => new AppError(409, "CONFLICT", input.status === "answered" ? "This request is not open for answers; ask the requester to reopen it" : input.status === "reviewed" ? "Only an answered request can be marked reviewed" : `This request is already ${input.status}`);
    if (!allowedFrom.includes(String(item.status))) throw stateError();
    // Only the respondent's answer writes the response; review/close/reopen never overwrite it. A new answer clears the earlier review.
    const change = input.status === "answered" ? { $set: { ...input, ...(req.interfaceChannel === "mcp" ? { answeredVia: "claude" } : {}), updatedAt: new Date() }, $unset: { reviewedBy: "", ...(req.interfaceChannel === "mcp" ? {} : { answeredVia: "" }) } } : { $set: { status: input.status, ...(input.status === "reviewed" ? { reviewedBy: actor.id } : {}), updatedAt: new Date() } };
    const changed = await db.collection("information_requests").updateOne({ _id: id, status: { $in: allowedFrom } }, change);
    if (!changed.matchedCount) throw stateError();
    res.json({ ok: true, data: jsonValue(await db.collection("information_requests").findOne({ _id: id })) });
  });
  router.post("/classes/:id/applications", async (req, res) => {
    const actor = req.actor!; const classId = idSchema.parse(req.params.id);
    const item = await db.collection("classes").findOne({ _id: classId, workspaceId: actor.membership.workspaceId, participantIds: actor.id, ...(actor.membership.role === "admin" ? notArchived(actor.membership) : { $or: [{ ventureId: { $exists: false } }, { ventureId: { $in: actor.membership.ventureIds } }] }) });
    if (!item) throw new AppError(404, "NOT_FOUND", "Class not found");
    const input = z.object({ taskId: idSchema.optional(), exercise: z.string().trim().min(1).max(5_000), evidenceItemId: idSchema.optional(), reviewerId: idSchema }).parse(req.body);
    if (input.reviewerId === actor.id) throw new AppError(400, "BAD_REQUEST", "An applicant cannot review their own application");
    if (!(await db.collection("memberships").findOne({ workspaceId: actor.membership.workspaceId, userId: input.reviewerId, status: "active", ...(item.ventureId ? listedInOrAdmin(String(item.ventureId)) : {}) }))) throw new AppError(400, "BAD_REQUEST", "Reviewer must be an active member of the class venture");
    if (input.evidenceItemId && !input.taskId) throw new AppError(400, "BAD_REQUEST", "Evidence requires a task");
    if (input.taskId) {
      const task = await db.collection("tasks").findOne({ _id: input.taskId, workspaceId: actor.membership.workspaceId, ...(item.ventureId ? { ventureId: item.ventureId } : {}), ...(actor.membership.role === "admin" ? {} : { groupId: { $in: actor.membership.groupIds } }) });
      if (!task) throw new AppError(400, "BAD_REQUEST", "Task is not accessible in this class scope");
      if (input.evidenceItemId && !(await db.collection("evidence_items").findOne({ _id: input.evidenceItemId, workspaceId: actor.membership.workspaceId, taskId: task._id }))) throw new AppError(400, "BAD_REQUEST", "Evidence is not attached to the task");
    }
    const application = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, classId, userId: actor.id, ...input, createdAt: new Date(), updatedAt: new Date() };
    await db.collection("class_applications").insertOne(application);
    res.status(201).json({ ok: true, data: jsonValue(application) });
  });
  router.get("/classes/:id/applications", async (req, res) => {
    const actor = req.actor!; const classId = idSchema.parse(req.params.id); const query = cursorQuerySchema.parse(req.query);
    const item = await accessibleClass(db, actor, classId);
    const own = canReadAllApplications(actor, item) ? {} : { $or: [{ userId: actor.id }, { reviewerId: actor.id }] };
    if (!canReadAllApplications(actor, item) && !item.participantIds.includes(actor.id) && !(await db.collection("class_applications").findOne({ workspaceId: actor.membership.workspaceId, classId, reviewerId: actor.id }))) throw new AppError(404, "NOT_FOUND", "Class not found");
    const filter = { workspaceId: actor.membership.workspaceId, classId, ...own };
    const cursor = query.cursor ? await db.collection("class_applications").findOne({ _id: idSchema.parse(query.cursor), ...filter }) : null;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "Application cursor not found");
    const rows = await db.collection("class_applications").find({ $and: [filter, cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {}] }).sort({ createdAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: jsonValue(rows.slice(0, query.limit)), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]?._id) : undefined } });
  });
  router.get("/classes/:id/applications/:applicationId", async (req, res) => {
    const actor = req.actor!; const classId = idSchema.parse(req.params.id); const item = await accessibleClass(db, actor, classId);
    const application = await db.collection("class_applications").findOne({ _id: idSchema.parse(req.params.applicationId), workspaceId: actor.membership.workspaceId, classId });
    if (!application || (!canReadAllApplications(actor, item) && application.userId !== actor.id && application.reviewerId !== actor.id)) throw new AppError(404, "NOT_FOUND", "Application not found");
    res.json({ ok: true, data: jsonValue(application) });
  });
  router.patch("/classes/:id/applications/:applicationId/review", async (req, res) => {
    const actor = req.actor!; const classId = idSchema.parse(req.params.id); const item = await accessibleClass(db, actor, classId);
    const applicationId = idSchema.parse(req.params.applicationId);
    const application = await db.collection("class_applications").findOne({ _id: applicationId, workspaceId: actor.membership.workspaceId, classId });
    if (!application) throw new AppError(404, "NOT_FOUND", "Application not found");
    if (!canReadAllApplications(actor, item) && application.reviewerId !== actor.id) throw new AppError(403, "FORBIDDEN", "Only the reviewer or class lead may review this application");
    const input = reviewClassApplicationSchema.parse(req.body); const now = new Date();
    await atomic(database, async (session) => {
      await db.collection("class_applications").updateOne({ _id: applicationId, workspaceId: actor.membership.workspaceId, classId }, { $set: { ...input, reviewedBy: actor.id, reviewedAt: now, updatedAt: now } }, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "class_application.review", objectType: "class_application", objectId: applicationId, ventureId: item.ventureId ? String(item.ventureId) : undefined, result: "success" }, session);
    });
    res.json({ ok: true, data: jsonValue(await db.collection("class_applications").findOne({ _id: applicationId })) });
  });
  return router;
}

function isLead(actor: Actor): boolean { return actor.membership.role === "admin" || actor.membership.role === "venture_head"; }
function assertLeadScope(actor: Actor, ventureId: unknown): void {
  if (inArchivedVenture(actor.membership, ventureId)) throw new AppError(404, "NOT_FOUND", "Venture not found");
  if (actor.membership.role === "admin") return;
  if (actor.membership.role !== "venture_head" || typeof ventureId !== "string" || !actor.membership.ventureIds.includes(ventureId)) throw new AppError(403, "FORBIDDEN", "Venture lead access required");
}
async function accessibleClass(db: AppDb, actor: Actor, classId: string) {
  const item = await db.collection("classes").findOne({ _id: classId, workspaceId: actor.membership.workspaceId, ...(actor.membership.role === "admin" ? notArchived(actor.membership) : { $or: [{ ventureId: { $exists: false } }, { ventureId: { $in: actor.membership.ventureIds } }] }) });
  if (!item) throw new AppError(404, "NOT_FOUND", "Class not found");
  return item;
}
function canReadAllApplications(actor: Actor, item: AppDocument): boolean {
  return actor.membership.role === "admin" || item.facilitatorId === actor.id || (actor.membership.role === "venture_head" && typeof item.ventureId === "string" && actor.membership.ventureIds.includes(item.ventureId));
}
async function assertClassPeople(db: AppDb, workspaceId: string, ventureId: unknown, facilitatorId: string, participantIds: string[]): Promise<void> {
  const people = [...new Set([facilitatorId, ...participantIds])];
  if (new Set(participantIds).size !== participantIds.length) throw new AppError(400, "BAD_REQUEST", "Class participants must be unique");
  const count = await db.collection("memberships").countDocuments({ workspaceId, userId: { $in: people }, status: "active", ...(typeof ventureId === "string" ? listedInOrAdmin(ventureId) : {}) });
  if (count !== people.length) throw new AppError(400, "BAD_REQUEST", "Class people must be active members of the class venture");
}

/** A suggestion as JSON; the proposed text only where the reader may see it. */
function suggestionJson(item: Document, withMarkdown: boolean): unknown {
  const { markdown, workspaceId: _workspace, ...rest } = item;
  return jsonValue({ ...rest, id: item._id, ...(withMarkdown ? { markdown } : {}) });
}

/** Tells approvers (admins, and people allowed to share with all ventures) who can read the document; never its author. */
async function notifyApprovers(db: AppDb, actor: Actor, notice: { title: string; body: string; documentId: string; key: string }, sensitivity: string, session?: ClientSession) {
  const writers = ["venture_head", "contributor"].filter((role) => readableSensitivities(role).includes(sensitivity));
  const approvers = await db.collection("memberships").find({ workspaceId: actor.membership.workspaceId, status: "active", userId: { $ne: actor.id }, $or: [{ role: "admin" }, { canShareKnowledge: true, role: { $in: writers } }] }, { projection: { userId: 1 }, ...(session ? { session } : {}) }).limit(500).toArray();
  await notifyPeople(db, actor.membership.workspaceId, approvers.map((row) => String(row.userId)), notice, session, "knowledge_request");
}

/** Stores how many suggestions wait on a document, recounted on every change so it can't drift. */
async function countPendingSuggestions(db: AppDb, documentId: string, session?: ClientSession) {
  const pending = await db.collection("document_suggestions").countDocuments({ documentId, state: "pending" }, session ? { session } : {});
  await db.collection("documents").updateOne({ _id: documentId }, { $set: { pendingSuggestions: pending } }, session ? { session } : {});
}

async function notifyPeople(db: AppDb, workspaceId: string, userIds: string[], notice: { title: string; body: string; documentId: string; key: string }, session?: ClientSession, type: "knowledge_request" | "knowledge_result" = "knowledge_result") {
  if (!userIds.length) return;
  const now = new Date();
  await db.collection("notification_outbox").bulkWrite(userIds.map((userId) => ({ updateOne: { filter: { idempotencyKey: `${notice.key}:${userId}` }, update: { $setOnInsert: { _id: randomUUID(), workspaceId, userId, type, title: notice.title.slice(0, 200), body: notice.body.slice(0, 500), resourceType: "document", resourceId: notice.documentId, idempotencyKey: `${notice.key}:${userId}`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now } }, upsert: true } })), { ...(session ? { session } : {}) });
}

function documentJson(document: AppDocument | null): unknown {
  return document ? jsonValue({ ...document, ventureId: document.ventureId ?? undefined }) : null;
}

function documentVersionJson(version: Document | null): unknown {
  return version ? jsonValue({ ...version, sourceUri: version.sourceUri ?? undefined }) : null;
}

async function accessibleDocument(db: AppDb, actor: Actor, id: string) {
  const document = await db.collection("documents").findOne({ _id: id, ...authorizedDocumentFilter(actor) });
  if (!document) throw new AppError(404, "NOT_FOUND", "Document not found");
  return document;
}

function chunks(markdown: string): Array<{ heading: string; text: string }> {
  let heading = "Document";
  const result: Array<{ heading: string; text: string }> = [];
  for (const block of markdown.split(/\n\s*\n/)) {
    const value = block.trim();
    if (!value) continue;
    const match = value.match(/^#{1,6}\s+(.+)$/m);
    if (match?.[1]) heading = match[1].trim();
    result.push({ heading, text: value.replace(/^#{1,6}\s+/gm, "") });
  }
  return result;
}

async function createSimple(db: AppDb, req: Request, res: Response, collection: string, schema: { parse(value: unknown): Record<string, unknown> }, action: string, extra: Record<string, unknown> = {}) {
  const actor = req.actor!;
  const input = schema.parse(req.body);
  assertNotBlank(input, ["title", "text", "reason", "objective", "question", "purpose"]);
  const ventureId = typeof input.ventureId === "string" ? input.ventureId : undefined;
  if ((collection === "decisions" || collection === "classes") && !ventureId && actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may create workspace-wide records");
  if (ventureId && (inArchivedVenture(actor.membership, ventureId) || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(ventureId)))) throw new AppError(403, "FORBIDDEN", "Venture access denied");
  const now = new Date();
  const item = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...withDates(input, ["decidedAt", "scheduledAt", "dueAt"]), ...extra, createdAt: now, updatedAt: now };
  await db.collection(collection).insertOne(item);
  await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action, objectType: collection, objectId: String(item._id), ventureId, result: "success" });
  res.status(201).json({ ok: true, data: jsonValue(item) });
}

async function listScoped(db: AppDb, req: Request, res: Response, collection: string, extra: Record<string, unknown> = {}) {
  const actor = req.actor!;
  const ventureScope = actor.membership.role === "admin" ? notArchived(actor.membership) : { $or: [{ ventureId: { $exists: false } }, { ventureId: { $in: actor.membership.ventureIds } }] };
  const items = await db.collection(collection).find({ workspaceId: actor.membership.workspaceId, $and: [ventureScope, extra] }).sort({ updatedAt: -1 }).limit(100).toArray();
  res.json({ ok: true, data: jsonValue(items) });
}

/** The change summary an approver reads; versions written through Claude end with "(via Claude)". */
function claudeSummary(summary: string, viaClaude: boolean): string {
  return viaClaude && !/via claude/i.test(summary) ? `${summary.slice(0, 485)} (via Claude)` : summary;
}
