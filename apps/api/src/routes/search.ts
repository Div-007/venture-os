import { Router } from "express";
import { searchQuerySchema } from "@venture-studio/contracts";
import type { AppDb } from "../db.js";
import { audit } from "../audit.js";
import { jsonValue } from "../json.js";
import { inArchivedVenture, notArchived } from "../archive-scope.js";

export function searchRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/search", async (req, res) => {
    const query = searchQuerySchema.parse({ ...req.query, types: typeof req.query.types === "string" ? req.query.types.split(",") : undefined });
    const actor = req.actor!;
    const ventureIds = actor.membership.role === "admin" ? (query.ventureId ? (inArchivedVenture(actor.membership, query.ventureId) ? [] : [query.ventureId]) : undefined) : query.ventureId ? (actor.membership.ventureIds.includes(query.ventureId) ? [query.ventureId] : []) : actor.membership.ventureIds;
    const ventureScope = ventureIds ? { ventureId: { $in: ventureIds } } : notArchived(actor.membership);
    const allowedGroup = !query.groupId || actor.membership.role === "admin" || actor.membership.groupIds.includes(query.groupId);
    const groupScope = query.groupId ? { groupId: allowedGroup ? query.groupId : { $in: [] as string[] } } : actor.membership.role === "admin" ? {} : { groupId: { $in: actor.membership.groupIds } };
    const channels = query.types.includes("message") ? await db.collection("channels").find({ workspaceId: actor.membership.workspaceId, ...ventureScope, ...groupScope }).project({ _id: 1, groupId: 1 }).toArray() : [];
    const channelIds = channels.map((item) => item._id);
    const channelGroupIds = new Map(channels.map((item) => [item._id, item.groupId]));
    const escapedActor = actor.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Venture files the person can open; direct-message files never appear in search.
    const fileScope = { workspaceId: actor.membership.workspaceId, recipientId: { $exists: false }, ...ventureScope, ...(query.groupId ? groupScope : actor.membership.role === "admin" ? {} : { $or: [{ groupId: { $exists: false } }, { groupId: { $in: actor.membership.groupIds } }] }) };
    const [tasks, messages, files, fileTexts] = await Promise.all([
      query.types.includes("task") ? db.collection("tasks").find({ workspaceId: actor.membership.workspaceId, ...ventureScope, ...groupScope, $text: { $search: query.q } }).limit(query.limit).toArray() : [],
      query.types.includes("message") ? db.collection("messages").find({ workspaceId: actor.membership.workspaceId, $text: { $search: query.q }, ...(query.groupId ? { channelId: { $in: channelIds } } : { $or: [{ channelId: { $in: channelIds } }, { dmKey: { $regex: `(^|:)${escapedActor}(:|$)` } }] }) }).limit(query.limit).toArray() : [],
      query.types.includes("file") ? db.collection("files").find({ ...fileScope, status: "ready", $text: { $search: query.q } }).limit(query.limit).toArray() : [],
      // Matches inside the text read out of PDF, Word, Markdown, and plain-text files.
      // Only ids and scores here: a file's text can be 400,000 characters.
      query.types.includes("file") ? db.collection("file_texts").find({ ...fileScope, status: "ready", $text: { $search: query.q } }, { projection: { _id: 1, score: { $meta: "textScore" } } }).sort({ score: { $meta: "textScore" } }).limit(Math.min(query.limit, 20)).toArray() : [],
    ]);
    const named = new Set(files.map((item) => String(item._id)));
    const contentIds = fileTexts.map((item) => String(item._id)).filter((id) => !named.has(id));
    const contentFiles = contentIds.length ? await db.collection("files").find({ ...fileScope, _id: { $in: contentIds }, status: "ready" }).toArray() : [];
    const contentOrder = new Map(contentIds.map((id, index) => [id, index]));
    contentFiles.sort((a, b) => (contentOrder.get(String(a._id)) ?? 0) - (contentOrder.get(String(b._id)) ?? 0));
    // Snippets for the content matches that are shown, cut from the start of each text (the first 20,000 characters).
    const shownContentIds = [...files, ...contentFiles].slice(0, query.limit).map((item) => String(item._id)).filter((id) => contentOrder.has(id));
    const heads = shownContentIds.length ? await db.collection("file_texts").aggregate([{ $match: { _id: { $in: shownContentIds } } }, { $project: { head: { $substrCP: ["$text", 0, 20_000] } } }]).toArray() : [];
    const snippets = new Map(heads.map((item) => [String(item._id), snippet(String(item.head ?? ""), query.q)]));
    const buckets = [
      tasks.map((item) => ({ type: "task", id: item._id, title: item.title, excerpt: item.outcome, ventureId: item.ventureId, sourceRef: `task:${item._id}` })),
      messages.map((item) => ({ type: "message", id: item._id, title: item.channelId ? "Channel message" : "Direct message", excerpt: item.body, ventureId: item.ventureId, groupId: item.groupId ?? channelGroupIds.get(item.channelId), channelId: item.channelId, sourceRef: `message:${item._id}` })),
      [...files, ...contentFiles].slice(0, query.limit).map((item) => ({ type: "file", id: item._id, title: item.name, excerpt: snippets.get(String(item._id)) ?? item.contentType, ventureId: item.ventureId, groupId: item.groupId, contentType: item.contentType, sourceRef: `file:${item._id}` })),
    ];
    const items: (typeof buckets)[number][number][] = [];
    for (let index = 0; index < query.limit && items.length < query.limit; index++) {
      let found = false;
      for (const bucket of buckets) {
        const item = bucket[index];
        if (item && items.length < query.limit) { items.push(item); found = true; }
      }
      if (!found) break;
    }
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "search", objectType: "search", ventureId: query.ventureId, result: "success", metadata: { queryLength: query.q.length, resultCount: items.length } });
    res.json({ ok: true, data: { items: jsonValue(items), nextCursor: undefined } });
  });
  return router;
}

/** About 260 characters of a file's text around the first word of the query it contains (the start when none is found). */
function snippet(text: string, q: string): string {
  const words = q.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
  const lower = text.toLowerCase();
  const at = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 260).replace(/\s+/g, " ").trim()}${start + 260 < text.length ? "…" : ""}`;
}
