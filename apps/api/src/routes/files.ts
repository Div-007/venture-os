import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import sharp from "sharp";
import { z } from "zod";
import type { AppDb, AppDocument } from "../db.js";
import { cursorQuerySchema, groupFileSchema, idSchema, uploadCompleteSchema, uploadIntentSchema } from "@venture-studio/contracts";
import { can } from "@venture-studio/core";
import type { ObjectStore } from "../storage.js";
import { LocalObjectStore } from "../storage.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { inArchivedVenture, notArchived } from "../archive-scope.js";
import { jsonValue } from "../json.js";
import { canExtractText, MAX_TEXT_CHARS, storedFileText } from "../file-text.js";

export function fileRoutes(db: AppDb, store: ObjectStore, localStore: LocalObjectStore): Router {
  const router = Router();
  const thumbnailCache = new Map<string, { bytes: Buffer; expiresAt: number }>();
  const thumbnailInFlight = new Map<string, Promise<Buffer>>();
  const thumbnailWaiters: Array<() => void> = [];
  let thumbnailCacheBytes = 0;
  let activeThumbnailConversions = 0;

  async function withThumbnailSlot<T>(work: () => Promise<T>): Promise<T> {
    if (activeThumbnailConversions < 2) activeThumbnailConversions++;
    else {
      if (thumbnailWaiters.length >= 16) throw new AppError(503, "INTEGRATION_UNAVAILABLE", "Image previews are busy; try again shortly");
      await new Promise<void>((resolve) => thumbnailWaiters.push(resolve));
    }
    try { return await work(); }
    finally {
      const next = thumbnailWaiters.shift();
      if (next) next();
      else activeThumbnailConversions--;
    }
  }

  function rememberThumbnail(key: string, bytes: Buffer) {
    if (bytes.length > 512 * 1024) return;
    while (thumbnailCache.size >= 256 || thumbnailCacheBytes + bytes.length > 32 * 1024 * 1024) {
      const oldest = thumbnailCache.keys().next().value;
      if (!oldest) break;
      thumbnailCacheBytes -= thumbnailCache.get(oldest)!.bytes.length;
      thumbnailCache.delete(oldest);
    }
    thumbnailCache.set(key, { bytes, expiresAt: Date.now() + 5 * 60_000 });
    thumbnailCacheBytes += bytes.length;
  }

  const storedFileStore = (file: AppDocument): ObjectStore => {
    const found = fileStoreFor(file, store, localStore);
    if (!found) throw new AppError(503, "INTEGRATION_UNAVAILABLE", "The file's storage backend is not configured");
    return found;
  };
  router.get("/files", async (req, res) => {
    const actor = req.actor!;
    const query = cursorQuerySchema.extend({ ventureId: idSchema.optional() }).parse(req.query);
    if (query.ventureId && (inArchivedVenture(actor.membership, query.ventureId) || (actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(query.ventureId)))) throw new AppError(404, "NOT_FOUND", "Venture not found");
    const scope = {
      workspaceId: actor.membership.workspaceId,
      recipientId: { $exists: false },
      status: "ready",
      ...(query.ventureId ? { ventureId: query.ventureId } : actor.membership.role === "admin" ? notArchived(actor.membership) : { ventureId: { $in: actor.membership.ventureIds } }),
      ...(actor.membership.role === "admin" ? {} : { $or: [{ groupId: { $exists: false } }, { groupId: { $in: actor.membership.groupIds } }] }),
    };
    const cursor = query.cursor ? await db.collection("files").findOne({ ...scope, _id: idSchema.parse(query.cursor) }) : undefined;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "File cursor not found");
    const before = cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {};
    const files = await db.collection("files").find({ $and: [scope, before] }).sort({ createdAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: files.slice(0, query.limit).map((file) => groupFileSchema.parse(jsonValue(file))), nextCursor: files.length > query.limit ? files[query.limit - 1]?._id : undefined } });
  });
  router.get("/groups/:id/files", async (req, res) => {
    const groupId = idSchema.parse(req.params.id);
    const actor = req.actor!;
    const group = await db.collection("groups").findOne({ _id: groupId, workspaceId: actor.membership.workspaceId });
    if (!group || !can(actor.membership, "group:read", { ventureId: String(group.ventureId), groupId })) throw new AppError(404, "NOT_FOUND", "Group not found");
    const query = cursorQuerySchema.parse(req.query);
    const scope = { workspaceId: actor.membership.workspaceId, ventureId: group.ventureId, groupId, status: "ready" };
    const cursor = query.cursor ? await db.collection("files").findOne({ ...scope, _id: idSchema.parse(query.cursor) }) : undefined;
    if (query.cursor && !cursor) throw new AppError(404, "NOT_FOUND", "File cursor not found");
    const before = cursor ? { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }] } : {};
    const files = await db.collection("files").find({ ...scope, ...before }).sort({ createdAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    res.json({ ok: true, data: { items: files.slice(0, query.limit).map((file) => groupFileSchema.parse(jsonValue(file))), nextCursor: files.length > query.limit ? files[query.limit - 1]?._id : undefined } });
  });
  router.post("/uploads", async (req, res) => {
    const input = uploadIntentSchema.parse(req.body);
    const actor = req.actor!;
    if (input.recipientId) {
      if (!can(actor.membership, "message:write")) throw new AppError(403, "FORBIDDEN", "Direct-message upload access denied");
      if (input.recipientId === actor.id) throw new AppError(400, "BAD_REQUEST", "Direct-message recipient must be another member");
      const [recipient, membership] = await Promise.all([
        db.collection("users").findOne({ _id: input.recipientId, workspaceId: actor.membership.workspaceId, status: "active" }),
        db.collection("memberships").findOne({ userId: input.recipientId, workspaceId: actor.membership.workspaceId, status: "active" }),
      ]);
      if (!recipient || !membership) throw new AppError(404, "NOT_FOUND", "Direct-message recipient not found");
    } else {
      const uploadAction = input.groupId && !input.taskId ? "message:write" : "knowledge:write";
      if (!input.ventureId || !can(actor.membership, uploadAction, { ventureId: input.ventureId, groupId: input.groupId })) throw new AppError(403, "FORBIDDEN", "Upload access denied");
      if (input.groupId) {
        const group = await db.collection("groups").findOne({ _id: input.groupId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId });
        if (!group) throw new AppError(400, "BAD_REQUEST", "Upload group does not belong to the selected venture");
      }
      if (input.taskId) {
        const task = await db.collection("tasks").findOne({ _id: input.taskId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId, groupId: input.groupId });
        if (!task) throw new AppError(400, "BAD_REQUEST", "Attachment task does not belong to the selected venture and group");
      }
    }
    const id = randomUUID();
    const prefix = input.recipientId ? `${actor.membership.workspaceId}/dm` : `${actor.membership.workspaceId}/${input.ventureId}`;
    const uploadKey = `${prefix}/staging/${id}`;
    const objectKey = `${prefix}/objects/${id}`;
    const file = { _id: id, workspaceId: actor.membership.workspaceId, ...input, ownerId: actor.id, uploadKey, objectKey, status: "pending", storage: store.kind, createdAt: new Date() };
    await db.collection("files").insertOne(file);
    const uploadUrl = await store.uploadUrl(uploadKey, input.contentType, input.size);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "file.intent.create", objectType: "file", objectId: id, ...(input.ventureId ? { ventureId: input.ventureId } : {}), result: "success" });
    res.status(201).json({ ok: true, data: { file: jsonValue(file), uploadUrl, expiresInSeconds: 900 } });
  });
  router.post("/uploads/:id/complete", async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = uploadCompleteSchema.parse(req.body);
    const actor = req.actor!;
    const file = await accessibleFile(db, actor, id, true);
    const completeAction = file.recipientId ? "message:write" : file.groupId && !file.taskId ? "message:write" : "knowledge:write";
    const canComplete = can(actor.membership, completeAction, { ventureId: file.ventureId ? String(file.ventureId) : undefined, groupId: file.groupId ? String(file.groupId) : undefined });
    if (file.status === "ready" && !canComplete) return void res.json({ ok: true, data: jsonValue(file) });
    if (!canComplete) {
      throw new AppError(403, "FORBIDDEN", "Upload access denied");
    }
    const fileStore = storedFileStore(file);
    let expectedEtag = String(file.stagingEtag ?? "");
    if (file.status === "ready") {
      if (file.uploadKey) {
        await fileStore.discard(String(file.uploadKey));
        await db.collection("files").updateOne({ _id: id, status: "ready" }, { $unset: { uploadKey: "" } });
      }
      return void res.json({ ok: true, data: jsonValue(await db.collection("files").findOne({ _id: id })) });
    }
    if (file.status === "pending") {
      const metadata = await fileStore.head(String(file.uploadKey));
      if (metadata.size !== file.size) throw new AppError(409, "CONFLICT", "Uploaded object size does not match the intent");
      if (fileStore.kind === "r2" && metadata.etag !== input.etag.replaceAll('"', "")) throw new AppError(409, "CONFLICT", "Uploaded object ETag does not match");
      expectedEtag = metadata.etag;
      const claimed = await db.collection("files").updateOne({ _id: id, status: "pending" }, { $set: { status: "finalizing", stagingEtag: metadata.etag, finalizationStartedAt: new Date() } });
      if (!claimed.matchedCount) throw new AppError(409, "CONFLICT", "Upload completion is already in progress");
    } else if (file.status !== "finalizing") throw new AppError(409, "CONFLICT", "Upload cannot be completed from its current state");
    let finalized;
    try { finalized = await fileStore.head(String(file.objectKey)); }
    catch { finalized = await fileStore.finalize(String(file.uploadKey), String(file.objectKey), expectedEtag); }
    if (finalized.size !== file.size || finalized.etag !== expectedEtag) throw new AppError(409, "CONFLICT", "Finalized object no longer matches the verified upload");
    const changed = await db.collection("files").updateOne({ _id: id, status: "finalizing" }, { $set: { status: "ready", etag: finalized.etag, completedAt: new Date() }, $unset: { stagingEtag: "", finalizationStartedAt: "" } });
    if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "Upload completion state changed; reload and retry");
    try { await fileStore.discard(String(file.uploadKey)); await db.collection("files").updateOne({ _id: id, status: "ready" }, { $unset: { uploadKey: "" } }); }
    catch (error) { console.warn(JSON.stringify({ level: "warn", event: "upload_staging_cleanup_failed", fileId: id, message: error instanceof Error ? error.message : "Unknown cleanup error" })); }
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "file.complete", objectType: "file", objectId: id, ...(file.ventureId ? { ventureId: String(file.ventureId) } : {}), result: "success" });
    const ready = await db.collection("files").findOne({ _id: id });
    res.json({ ok: true, data: jsonValue(ready) });
    // Venture files are read in the background so search can find their text; direct-message files only when opened.
    if (ready && !ready.recipientId && canExtractText(ready.contentType)) void storedFileText(db, ready, fileStore).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "file_text_background_failed", fileId: id, message: error instanceof Error ? error.message : String(error) })));
  });
  router.get("/files/:id/download", async (req, res) => {
    const actor = req.actor!;
    const file = await accessibleFile(db, actor, idSchema.parse(req.params.id));
    const fileStore = storedFileStore(file);
    const downloadUrl = await fileStore.downloadUrl(String(file.objectKey));
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "file.download_url", objectType: "file", objectId: String(file._id), ...(file.ventureId ? { ventureId: String(file.ventureId) } : {}), result: "success" });
    res.json({ ok: true, data: { downloadUrl, expiresInSeconds: fileStore.kind === "r2" ? 300 : 900 } });
  });
  // The text inside a PDF, Word, Markdown, or plain-text file the person can open, read once and then served from file_texts.
  // `offset` and `maxChars` page through long files.
  router.get("/files/:id/text", async (req, res) => {
    const actor = req.actor!;
    const file = await accessibleFile(db, actor, idSchema.parse(req.params.id));
    const query = z.object({ offset: z.coerce.number().int().min(0).max(MAX_TEXT_CHARS).default(0), maxChars: z.coerce.number().int().min(200).max(100_000).default(20_000), excludeDirect: z.enum(["true", "false"]).optional() }).parse(req.query);
    if (query.excludeDirect === "true" && file.recipientId) throw new AppError(404, "NOT_FOUND", "File not found");
    const value = await storedFileText(db, file, storedFileStore(file));
    const text = value.text.slice(query.offset, query.offset + query.maxChars);
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "file.text.read", objectType: "file", objectId: String(file._id), ...(file.ventureId ? { ventureId: String(file.ventureId) } : {}), result: "success" });
    res.json({ ok: true, data: { fileId: String(file._id), name: String(file.name), contentType: String(file.contentType), direct: Boolean(file.recipientId), ...(file.ventureId ? { ventureId: String(file.ventureId) } : {}), ...(file.groupId ? { groupId: String(file.groupId) } : {}), status: value.status, ...(value.error ? { error: value.error } : {}), ...(value.pages ? { pages: value.pages } : {}), chars: value.chars, offset: query.offset, text, nextOffset: query.offset + text.length < value.chars ? query.offset + text.length : undefined, truncatedAtSource: value.truncated || undefined } });
  });
  router.get("/files/:id/thumbnail", async (req, res) => {
    const actor = req.actor!;
    const file = await accessibleFile(db, actor, idSchema.parse(req.params.id));
    if (!/^image\/(png|jpeg|webp|gif)$/.test(String(file.contentType)) || Number(file.size) > 25 * 1024 * 1024) {
      throw new AppError(415, "BAD_REQUEST", "A thumbnail is unavailable for this file");
    }
    const fileStore = storedFileStore(file);
    const cacheKey = `${file.workspaceId}:${file._id}:${file.storage}:${file.etag ?? file.completedAt ?? ""}`;
    const cached = thumbnailCache.get(cacheKey);
    if (cached && cached.expiresAt <= Date.now()) {
      thumbnailCacheBytes -= cached.bytes.length;
      thumbnailCache.delete(cacheKey);
    }
    let thumbnail = thumbnailCache.get(cacheKey)?.bytes;
    if (!thumbnail) {
      let pending = thumbnailInFlight.get(cacheKey);
      if (!pending) {
        pending = withThumbnailSlot(async () => {
          const original = await fileStore.read(String(file.objectKey), 25 * 1024 * 1024);
          try {
            return await sharp(original, { limitInputPixels: 50_000_000, animated: false, failOn: "error" })
              .rotate().resize(720, 720, { fit: "inside", withoutEnlargement: true }).webp({ quality: 76, effort: 4 }).toBuffer();
          } catch {
            throw new AppError(422, "BAD_REQUEST", "This image could not be previewed");
          }
        }).then((bytes) => { rememberThumbnail(cacheKey, bytes); return bytes; }).finally(() => { thumbnailInFlight.delete(cacheKey); });
        thumbnailInFlight.set(cacheKey, pending);
      }
      thumbnail = await pending;
    }
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "file.thumbnail", objectType: "file", objectId: String(file._id), ...(file.ventureId ? { ventureId: String(file.ventureId) } : {}), result: "success" });
    res.set({ "Content-Type": "image/webp", "Content-Length": String(thumbnail.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.send(thumbnail);
  });
  return router;
}

export function localObjectRoutes(db: AppDb, store: LocalObjectStore): Router {
  const router = Router();
  router.put("/local-objects/:token", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
    try { const key = store.verify(req.params.token, "put"); const pending = await db.collection("files").findOne({ uploadKey: key, status: "pending" }); if (!pending) throw new Error("Upload completed"); await store.write(key, Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body)); res.status(204).end(); }
    catch { throw new AppError(403, "FORBIDDEN", "Upload URL is invalid or expired"); }
  });
  router.get("/local-objects/:token", async (req, res) => {
    try { const key = store.verify(req.params.token, "get"); res.send(await store.read(key, 25 * 1024 * 1024)); }
    catch { throw new AppError(403, "FORBIDDEN", "Download URL is invalid or expired"); }
  });
  return router;
}

/** The store a file's bytes live in, or undefined when that backend is not configured here. */
export function fileStoreFor(file: AppDocument, store: ObjectStore, localStore: LocalObjectStore): ObjectStore | undefined {
  if (file.storage === "local") return localStore;
  if (file.storage === "r2" && store.kind === "r2") return store;
  return undefined;
}

async function accessibleFile(db: AppDb, actor: NonNullable<Express.Request["actor"]>, id: string, allowPending = false) {
  const file = await db.collection("files").findOne({ _id: id, workspaceId: actor.membership.workspaceId, ...(allowPending ? {} : { status: "ready" }) });
  if (!file || (allowPending && file.ownerId !== actor.id)) throw new AppError(404, "NOT_FOUND", "File not found");
  if (file.recipientId) {
    if (file.ownerId !== actor.id && file.recipientId !== actor.id) throw new AppError(404, "NOT_FOUND", "File not found");
  } else if (inArchivedVenture(actor.membership, file.ventureId) || (actor.membership.role !== "admin" && (!actor.membership.ventureIds.includes(String(file.ventureId)) || (file.groupId && !actor.membership.groupIds.includes(String(file.groupId)))))) throw new AppError(404, "NOT_FOUND", "File not found");
  return file;
}
