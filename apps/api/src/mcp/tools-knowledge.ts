import { z } from "zod";
import { evidenceClassSchema, sensitivitySchema } from "@venture-studio/contracts";
import { clean, clip, compact, localTime, ToolError, UNTRUSTED_NOTE, validTimeZone } from "./format.js";
import { id, type Look, once, READ_ONLY, type Register, requestIdField, timezoneField, type ToolContext, writes } from "./kit.js";

const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// What Claude may upload, by file extension: documents and images (no audio or video).
const UPLOAD_TYPES: Record<string, string> = { pdf: "application/pdf", docx: WORD, md: "text/markdown", markdown: "text/markdown", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const READABLE = new Set(["application/pdf", WORD, "text/markdown", "text/plain"]);
const KIND: Record<string, string> = { "application/pdf": "pdf", [WORD]: "word", "text/markdown": "markdown", "text/plain": "text" };
const docLink = (ctx: ToolContext, documentId: string) => `${ctx.origin}/knowledge/live?doc=${encodeURIComponent(documentId)}`;
const size = (bytes: unknown) => typeof bytes !== "number" ? undefined : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const evidenceField = evidenceClassSchema.describe("How sure this is: verified_fact, founder_reported, approved_decision, planning_assumption, hypothesis, open_question, or historical");
const sensitivityField = sensitivitySchema.default("team").describe("Who may read it: team (default), venture_restricted, manager, or founder_private (admins only)");
const DRAFT_NOTE = "Saved as a draft. It counts as approved knowledge only after an admin or venture head approves it in the app.";
// Requests to /mcp are capped at 64 KB, so one call carries at most this much Markdown. Longer texts: upload a file and import it.
const markdownField = z.string().min(1).max(50_000).describe("Markdown, up to 50,000 characters; for longer material upload a file and use import_file_as_document");

/** Knowledge documents and uploaded files: browse, read, draft, and upload. */
export function registerKnowledgeTools(tool: Register, ctx: ToolContext, look: Look): void {
  tool("list_documents", "knowledge:read", {
    title: "List documents", annotations: READ_ONLY,
    description: "Knowledge documents I can read, newest first: title, status (draft, approved, stale), evidence label, and venture. Filter by venture or status. Read one with get_document.",
    inputSchema: z.object({ ventureId: id.optional(), status: z.enum(["draft", "approved", "stale"]).optional(), limit: z.number().int().min(1).max(50).default(20), cursor: id.optional(), timezone: timezoneField }),
  }, async ({ ventureId, status, limit, cursor, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const params = new URLSearchParams({ limit: String(limit) });
    if (ventureId) params.set("ventureId", ventureId); if (status) params.set("status", status); if (cursor) params.set("cursor", cursor);
    const page = await ctx.api<{ items: any[]; nextCursor?: string }>("GET", `/documents?${params}`);
    const { ventures } = await look.ventures();
    const items = await Promise.all(page.items.map(async (item) => compact({ id: item.id, title: clip(item.title, 160), status: item.status, evidence: item.evidenceClass, sensitivity: item.sensitivity, venture: item.ventureId ? ventures.get(item.ventureId)?.name : "Workspace", owner: await look.person(item.ownerId), updated: localTime(item.updatedAt, timeZone), url: docLink(ctx, item.id) })));
    return compact({ items, nextCursor: page.nextCursor, note: items.length ? UNTRUSTED_NOTE : undefined, hint: items.length ? undefined : "No documents here yet. Uploaded files are listed by list_files." });
  });

  tool("create_document", "knowledge:write", {
    title: "Create document", annotations: writes(false),
    description: `Write a new knowledge document in Markdown. ${DRAFT_NOTE} Leave out ventureId only for workspace-wide knowledge (every venture sees it): admins and people allowed to share with all ventures publish it as a draft; for anyone else it becomes a request that an approver reviews in the app, hidden from others until approved.`,
    inputSchema: z.object({ title: z.string().trim().min(1).max(200), markdown: markdownField, ventureId: id.optional(), evidence: evidenceField, sensitivity: sensitivityField, changeSummary: z.string().trim().min(1).max(500).optional(), requestId: requestIdField }),
  }, async ({ title, markdown, ventureId, evidence, sensitivity, changeSummary, requestId }) => once(ctx, "create_document", requestId, { title, markdown, ventureId, evidence, sensitivity, changeSummary }, async () => {
    if (!markdown.trim()) throw new ToolError("The document has no text.");
    const document = await ctx.api<any>("POST", "/documents", { title, markdown, ...(ventureId ? { ventureId } : {}), evidenceClass: evidence, sensitivity, changeSummary: changeSummary ?? "Written with Claude" });
    if (document.review) return { documentId: document.id, status: "waiting_for_approval", version: document.currentVersion?.version, versionId: document.currentVersion?.id, url: docLink(ctx, document.id), note: "Sent for approval: an admin or someone allowed to share with all ventures reviews it in the app. Only you and they can see it until then." };
    return { documentId: document.id, status: document.status, version: document.currentVersion?.version, versionId: document.currentVersion?.id, url: docLink(ctx, document.id), note: DRAFT_NOTE };
  }));

  tool("update_document", "knowledge:write", {
    title: "Update document", annotations: writes(false),
    description: "Save a new version of a document (the whole Markdown, not a diff). baseVersionId is the versionId from get_document: if someone saved a newer version meanwhile, nothing is overwritten and you are told to read it again. The document goes back to draft until a person approves the new version. For a workspace-wide document, if I'm not allowed to share with all ventures, this becomes a suggested change that an approver accepts or declines in the app; the live version stays until then.",
    inputSchema: z.object({ documentId: id, markdown: markdownField, changeSummary: z.string().trim().min(1).max(400), baseVersionId: id, requestId: requestIdField }),
  }, async ({ documentId, markdown, changeSummary, baseVersionId, requestId }) => once(ctx, "update_document", requestId, { documentId, markdown, changeSummary, baseVersionId }, async () => {
    const version = await ctx.api<any>("PUT", `/documents/${encodeURIComponent(documentId)}`, { markdown, changeSummary, baseVersionId });
    if (version.suggestion) return { documentId, suggestionId: version.suggestion.id, status: "suggested", url: docLink(ctx, documentId), note: "Sent as a suggested change: the live version stays until an approver accepts it in the app." };
    return { documentId, version: version.version, versionId: version.id, status: "draft", url: docLink(ctx, documentId), note: "The new version is a draft until someone approves it in the app." };
  }));

  tool("list_files", "files:read", {
    title: "List files", annotations: READ_ONLY,
    description: "Files uploaded to ventures I can open (never direct-message files), newest first, with whether their text can be read by read_file.",
    inputSchema: z.object({ ventureId: id.optional(), limit: z.number().int().min(1).max(50).default(20), cursor: id.optional(), timezone: timezoneField }),
  }, async ({ ventureId, limit, cursor, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const params = new URLSearchParams({ limit: String(limit) });
    if (ventureId) params.set("ventureId", ventureId); if (cursor) params.set("cursor", cursor);
    const page = await ctx.api<{ items: any[]; nextCursor?: string }>("GET", `/files?${params}`);
    const { ventures, groups } = await look.ventures();
    const items = await Promise.all(page.items.map(async (item) => compact({ id: item.id, name: clip(item.name, 200), kind: KIND[item.contentType] ?? item.contentType, size: size(item.size), venture: ventures.get(item.ventureId)?.name, group: item.groupId ? groups.get(item.groupId)?.name : undefined, uploadedBy: await look.person(item.ownerId), uploaded: localTime(item.completedAt ?? item.createdAt, timeZone), readable: READABLE.has(item.contentType) })));
    return compact({ items, nextCursor: page.nextCursor, note: items.length ? UNTRUSTED_NOTE : undefined, hint: items.length ? undefined : "No files uploaded here yet." });
  });

  tool("read_file", "files:read", {
    title: "Read file", annotations: READ_ONLY,
    description: "The text inside an uploaded PDF, Word, Markdown, or plain-text file, from `offset` up to `maxChars`; continue with nextOffset. Scanned PDFs have no text to read.",
    inputSchema: z.object({ fileId: id, offset: z.number().int().min(0).default(0), maxChars: z.number().int().min(500).max(50_000).default(8000) }),
  }, async ({ fileId, offset, maxChars }) => {
    const file = await readableFile(ctx, fileId, offset, maxChars);
    return compact({ fileId, name: clip(file.name, 200), pages: file.pages, chars: file.chars, offset, text: clean(file.text), nextOffset: file.nextOffset, cutShort: file.truncatedAtSource ? "Very long file: only its first 400,000 characters are kept." : undefined, note: UNTRUSTED_NOTE });
  });

  tool("import_file_as_document", ["files:read", "knowledge:write"], {
    title: "Import file as document", annotations: writes(false),
    description: `Turn an uploaded PDF, Word, Markdown, or text file into a knowledge document with its text, in the file's venture. ${DRAFT_NOTE} To restructure the text first, use read_file and create_document instead.`,
    inputSchema: z.object({ fileId: id, title: z.string().trim().min(1).max(200).optional(), evidence: evidenceField, sensitivity: sensitivityField, requestId: requestIdField }),
  }, async ({ fileId, title, evidence, sensitivity, requestId }) => once(ctx, "import_file_as_document", requestId, { fileId, title, evidence, sensitivity }, async () => {
    // Collect the whole text (the app keeps up to 400,000 characters per file).
    let file = await readableFile(ctx, fileId, 0, 100_000);
    let text = file.text;
    while (file.nextOffset !== undefined && text.length < 400_000) { file = await readableFile(ctx, fileId, file.nextOffset, 100_000); text += file.text; }
    if (!file.ventureId) throw new ToolError("Only files uploaded to a venture can become knowledge documents.");
    if (file.groupId) throw new ToolError("This file was shared in one group; a knowledge document would show it to the whole venture. Ask someone to upload it to the venture's knowledge instead.", 403);
    const name = clip(file.name, 200) ?? "file";
    const document = await ctx.api<any>("POST", "/documents", { title: title ?? name.replace(/\.[A-Za-z0-9]{1,8}$/, "").slice(0, 200), markdown: `_Imported from the file ${JSON.stringify(name.replace(/[*_`[\]<>]/g, ""))}._\n\n${text}`, ventureId: file.ventureId, evidenceClass: evidence, sensitivity, changeSummary: `Imported from ${name}` });
    return { documentId: document.id, status: document.status, chars: text.length, url: docLink(ctx, document.id), note: DRAFT_NOTE };
  }));

  tool("start_upload", "files:write", {
    title: "Start upload", annotations: writes(false),
    description: "Upload a file from this computer to a venture (PDF, Word .docx, Markdown, text, or an image; up to 25 MB). Returns a one-time uploadUrl valid for 15 minutes: send the file's bytes to it with an HTTP PUT and the given Content-Type, e.g. `curl -sS -D - -X PUT -H \"Content-Type: <contentType>\" --data-binary @<path> \"<uploadUrl>\"`, then call finish_upload with the ETag response header. Without a groupId it is a venture file (knowledge permission); with a groupId it is shared in that group.",
    inputSchema: z.object({ ventureId: id, groupId: id.optional(), fileName: z.string().trim().min(1).max(255).describe("Name with its extension, e.g. sales-book.pdf"), sizeBytes: z.number().int().min(1).max(25 * 1024 * 1024), requestId: requestIdField }),
  }, async ({ ventureId, groupId, fileName, sizeBytes, requestId }) => {
    const extension = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
    const contentType = UPLOAD_TYPES[extension];
    if (!contentType) throw new ToolError(`Files ending in .${extension || "(none)"} can't be uploaded here; use PDF, .docx, .md, .txt, PNG, JPEG, WebP, or GIF.`);
    if (groupId && !ctx.scopes.has("messages:write")) throw new ToolError("Sharing a file in a group needs a key that can post messages; leave out groupId to add it to the venture.", 403);
    return once(ctx, "start_upload", requestId, { ventureId, groupId, fileName, sizeBytes }, async () => {
      await ctx.uploadBudget(sizeBytes);
      const intent = await ctx.api<any>("POST", "/uploads", { ventureId, ...(groupId ? { groupId } : {}), name: fileName, contentType, size: sizeBytes });
      return { fileId: intent.file.id, uploadUrl: intent.uploadUrl, method: "PUT", contentType, expiresAt: new Date(Date.now() + Number(intent.expiresInSeconds ?? 900) * 1000).toISOString(), next: "PUT the exact bytes (same size) to uploadUrl with this Content-Type before expiresAt, then call finish_upload with fileId and the ETag response header." };
    });
  });

  tool("finish_upload", "files:write", {
    title: "Finish upload", annotations: writes(true),
    description: "Complete an upload started with start_upload once its bytes are sent. Pass the ETag header the upload answered with (a local test server sends none; leave it out there).",
    inputSchema: z.object({ fileId: id, etag: z.string().trim().min(1).max(200).optional() }),
  }, async ({ fileId, etag }) => {
    const file = await ctx.api<any>("POST", `/uploads/${encodeURIComponent(fileId)}/complete`, { etag: etag ?? "local" });
    return compact({ fileId, name: clip(file.name, 200), status: file.status, size: size(file.size), readable: READABLE.has(file.contentType) || undefined, next: READABLE.has(file.contentType) ? "Use read_file to read it, or import_file_as_document to make it a knowledge document." : undefined });
  });
}

type FileText = { name: string; ventureId?: string; groupId?: string; text: string; pages?: number; chars: number; nextOffset?: number; truncatedAtSource?: boolean };

/** A file's text for Claude: refuses direct-message files without that permission and explains unreadable files. */
async function readableFile(ctx: ToolContext, fileId: string, offset: number, maxChars: number): Promise<FileText> {
  const direct = ctx.scopes.has("direct_messages:read");
  const file = await ctx.api<any>("GET", `/files/${encodeURIComponent(fileId)}/text?offset=${offset}&maxChars=${maxChars}${direct ? "" : "&excludeDirect=true"}`);
  if (file.direct && !direct) throw new ToolError("That file was shared in a direct message; this connection can't open direct messages.", 403);
  if (file.status !== "ready") throw new ToolError(file.error ?? "This file has no readable text.", 422);
  return file;
}
