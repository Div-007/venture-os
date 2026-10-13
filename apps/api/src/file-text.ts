import { spawn } from "node:child_process";
import type { AppDb, AppDocument } from "./db.js";
import type { ObjectStore } from "./storage.js";
import { AppError } from "./errors.js";

export const WORD_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PARSED = new Set(["application/pdf", WORD_CONTENT_TYPE]);
const PLAIN = new Set(["text/markdown", "text/plain"]);
/** Kept per file: enough for a long handbook, small enough for one index entry. */
export const MAX_TEXT_CHARS = 400_000;
const MAX_PAGES = 500;
const TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// A Word file is a zip: refuse ones whose contents would unpack to more than this before any parser sees them.
const MAX_UNPACKED_BYTES = 80 * 1024 * 1024;
// Control characters other than tab and newline (PDFs often carry form feeds and NULs).
const NOISE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const canExtractText = (contentType: unknown) => typeof contentType === "string" && (PARSED.has(contentType) || PLAIN.has(contentType));

type Extracted = { text: string; truncated: boolean; pages?: number };

/** Why a file has no text. The message is safe to show; the same file always fails the same way, so it is kept. */
class ParseFailure extends Error {}
const DAMAGED = "The file could not be read; it may be damaged or in an unsupported format";
const TOO_BIG = "The file is too large or complex to read";

// Every step is linear (a regex like /[ \t]+\n/ is quadratic on long runs of spaces), and the text is cut to size first.
function capped(raw: string, truncated: boolean, pages?: number): Extracted {
  const head = raw.length > MAX_TEXT_CHARS * 2 ? raw.slice(0, MAX_TEXT_CHARS * 2) : raw;
  const clean = head.replace(NOISE, "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean.slice(0, MAX_TEXT_CHARS), truncated: truncated || raw.length > head.length || clean.length > MAX_TEXT_CHARS, ...(pages ? { pages } : {}) };
}

/** The total size a zip says its entries unpack to, from its central directory; undefined when it is not a readable zip. */
export function zipUnpackedSize(bytes: Buffer): { entries: number; total: number; largest: number } | undefined {
  // The end-of-central-directory record sits in the last 22 to 65,557 bytes.
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (bytes.readUInt32LE(at) !== 0x06054b50) continue;
    const entries = bytes.readUInt16LE(at + 10);
    let cursor = bytes.readUInt32LE(at + 16);
    let total = 0; let largest = 0;
    for (let index = 0; index < entries; index++) {
      if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) return undefined;
      const size = bytes.readUInt32LE(cursor + 24);
      // 0xFFFFFFFF means a ZIP64 size: far beyond anything a document needs.
      if (size === 0xffffffff) return { entries, total: Number.POSITIVE_INFINITY, largest: Number.POSITIVE_INFINITY };
      total += size; largest = Math.max(largest, size);
      cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    }
    return { entries, total, largest };
  }
  return undefined;
}

// The parser runs as a separate, short-lived Node process: a hostile file can exhaust only that process (its own heap
// cap, a hard kill on timeout, no secrets in its environment), never the API. The code is inline, so dev, tests, and the
// compiled build run the same thing; the libraries are passed in as absolute URLs. No eval and no font loading in pdf.js.
const CHILD_SOURCE = `
const job = JSON.parse(process.env.VSO_TEXT_JOB);
const NL = String.fromCharCode(10);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const bytes = Buffer.concat(chunks);
  (job.contentType === "application/pdf" ? pdfText(bytes) : wordText(bytes)).then(
    (value) => process.stdout.write(JSON.stringify({ ok: true, ...value })),
    (error) => process.stdout.write(JSON.stringify({ ok: false, name: (error && error.name) || "Error", message: String((error && error.message) || error).slice(0, 300) })),
  );
});
async function pdfText(bytes) {
  const { getDocumentProxy } = await import(job.pdfUrl);
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
  const parts = []; let length = 0; let truncated = pdf.numPages > job.maxPages;
  const pages = Math.min(pdf.numPages, job.maxPages);
  for (let number = 1; number <= pages; number++) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) { text += (item.str || "") + (item.hasEOL ? NL : " "); if (text.length > job.maxChars) break; }
    page.cleanup();
    parts.push(text.trim()); length += text.length;
    if (length >= job.maxChars) { truncated = truncated || number < pdf.numPages; break; }
  }
  return { text: parts.join(NL + NL).slice(0, job.maxChars + 1000), pages: pdf.numPages, truncated };
}
async function wordText(bytes) {
  const imported = await import(job.wordUrl);
  const mammoth = imported.default || imported;
  const result = await mammoth.extractRawText({ buffer: bytes });
  return { text: result.value.slice(0, job.maxChars + 1000), truncated: result.value.length > job.maxChars };
}
`;
const LIBRARIES = { pdfUrl: import.meta.resolve("unpdf"), wordUrl: import.meta.resolve("mammoth") };
// A full answer is at most the kept text, JSON-escaped (up to 6 bytes a character), plus room for the envelope.
const MAX_ANSWER_BYTES = MAX_TEXT_CHARS * 6 + 64 * 1024;

function parseInChild(bytes: Buffer, contentType: string, fileId: string): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=256", "-e", CHILD_SOURCE], {
      // Only what the parser needs; nothing from the API's environment (database or storage secrets).
      env: { VSO_TEXT_JOB: JSON.stringify({ contentType, maxChars: MAX_TEXT_CHARS, maxPages: MAX_PAGES, ...LIBRARIES }), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const out: Buffer[] = []; let outBytes = 0; let errText = ""; let timedOut = false; let settled = false;
    const fail = (message: string, detail: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill("SIGKILL");
      console.warn(JSON.stringify({ level: "warn", event: "file_text_parse_failed", fileId, contentType, ...detail }));
      reject(new ParseFailure(message));
    };
    const timer = setTimeout(() => { timedOut = true; fail("Reading the file took too long", { reason: "timeout" }); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > MAX_ANSWER_BYTES) fail(TOO_BIG, { reason: "answer too large" }); else out.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (errText.length < 600) errText += chunk.toString("utf8").slice(0, 600 - errText.length); });
    // The child may stop reading early (it crashed); that must not throw in the API.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => fail(DAMAGED, { reason: "spawn", message: error.message.slice(0, 200) }));
    child.on("close", (code, signal) => {
      if (settled) return;
      let answer: { ok?: boolean; text?: string; truncated?: boolean; pages?: number; name?: string; message?: string } | undefined;
      try { answer = JSON.parse(Buffer.concat(out).toString("utf8")); } catch { answer = undefined; }
      if (!answer) return fail(timedOut ? "Reading the file took too long" : TOO_BIG, { reason: "no answer", code, signal, stderr: errText.slice(0, 300) });
      if (!answer.ok) return fail(answer.name === "PasswordException" ? "The PDF is password-protected" : DAMAGED, { reason: "parser error", name: answer.name, message: answer.message });
      settled = true; clearTimeout(timer);
      resolve(capped(answer.text ?? "", Boolean(answer.truncated), answer.pages));
    });
    child.stdin.end(bytes);
  });
}

/** The text inside a PDF, Word, Markdown, or plain-text file. Throws ParseFailure (safe message) when it has none. */
export async function extractText(bytes: Buffer, contentType: string, fileId = "unknown"): Promise<Extracted> {
  // Plain text: decode only as much as can be kept (UTF-8 is at most 4 bytes a character).
  if (PLAIN.has(contentType)) return capped(new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_TEXT_CHARS * 4)).replace(/^﻿/, ""), bytes.length > MAX_TEXT_CHARS * 4);
  if (!PARSED.has(contentType)) throw new ParseFailure("This kind of file has no text to read");
  if (contentType === WORD_CONTENT_TYPE) {
    const unpacked = zipUnpackedSize(bytes);
    if (!unpacked) throw new ParseFailure(DAMAGED);
    if (unpacked.total > MAX_UNPACKED_BYTES || unpacked.entries > 5_000) {
      console.warn(JSON.stringify({ level: "warn", event: "file_text_parse_failed", fileId, contentType, reason: "unpacks too large", entries: unpacked.entries, total: unpacked.total }));
      throw new ParseFailure(TOO_BIG);
    }
  }
  return parseInChild(bytes, contentType, fileId);
}

// At most two reads at once (bytes in memory and a parser each), a short queue, and a clear "busy" beyond that.
let running = 0;
const waiting: Array<() => void> = [];
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running < 2) running++;
  else {
    if (waiting.length >= 20) throw new AppError(503, "INTEGRATION_UNAVAILABLE", "File reading is busy; try again shortly");
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else running--; }
}

export type FileText = { status: "ready" | "empty" | "failed" | "unsupported"; text: string; truncated: boolean; pages?: number; chars: number; error?: string };
const UNSUPPORTED: FileText = { status: "unsupported", text: "", truncated: false, chars: 0, error: "Only PDF, Word, Markdown, and plain-text files have readable text" };
// One read per file at a time: the background read after upload and a first request share it.
const inFlight = new Map<string, Promise<FileText>>();

/**
 * A ready file's text, read once and kept in `file_texts` (keyed by file id and ETag, so a replaced object is read again).
 * Parse failures are kept too (the same file fails the same way); a busy server or unreachable storage is not kept.
 */
export async function storedFileText(db: AppDb, file: AppDocument, fileStore: ObjectStore): Promise<FileText> {
  if (!canExtractText(file.contentType)) return UNSUPPORTED;
  const etag = String(file.etag ?? "");
  const cached = await db.collection("file_texts").findOne({ _id: file._id, etag });
  if (cached) return { status: cached.status, text: String(cached.text ?? ""), truncated: Boolean(cached.truncated), ...(cached.pages ? { pages: Number(cached.pages) } : {}), chars: Number(cached.chars ?? 0), ...(cached.error ? { error: String(cached.error) } : {}) };
  const key = `${String(file._id)}:${etag}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const reading = withSlot(async () => {
    let bytes: Buffer;
    try { bytes = await fileStore.read(String(file.objectKey), MAX_FILE_BYTES); }
    catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "file_text_storage_failed", fileId: String(file._id), message: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
      throw new AppError(503, "INTEGRATION_UNAVAILABLE", "The file's storage could not be reached; try again shortly");
    }
    let value: FileText;
    try {
      const extracted = await extractText(bytes, String(file.contentType), String(file._id));
      value = { status: extracted.text ? "ready" : "empty", ...extracted, chars: extracted.text.length, ...(extracted.text ? {} : { error: "The file has no selectable text (a scanned PDF needs text recognition first)" }) };
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
      value = { status: "failed", text: "", truncated: false, chars: 0, error: error.message };
    }
    const scope = { workspaceId: file.workspaceId, ...(file.ventureId ? { ventureId: file.ventureId } : {}), ...(file.groupId ? { groupId: file.groupId } : {}), ...(file.recipientId ? { recipientId: file.recipientId } : {}) };
    // Another API instance may store the same text at the same moment; whichever stores first wins.
    try { await db.collection("file_texts").replaceOne({ _id: file._id }, { ...scope, etag, ...value, extractedAt: new Date() }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    return value;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, reading);
  return reading;
}

/** Reads venture files whose text was never stored (uploaded before this existed, or while reading was busy), after startup. */
export async function backfillFileTexts(db: AppDb, storeFor: (file: AppDocument) => ObjectStore | undefined, limit = 200): Promise<number> {
  let read = 0;
  const cursor = db.collection("files").find({ status: "ready", recipientId: { $exists: false }, contentType: { $in: [...PARSED, ...PLAIN] } }).project({ _id: 1 }).sort({ _id: 1 });
  let batch: string[] = [];
  const run = async () => {
    const done = new Set((await db.collection("file_texts").find({ _id: { $in: batch } }).project({ _id: 1 }).toArray()).map((row) => String(row._id)));
    for (const id of batch) {
      if (read >= limit || done.has(id)) continue;
      const file = await db.collection("files").findOne({ _id: id, status: "ready" });
      const store = file ? storeFor(file) : undefined;
      if (!file || !store) continue;
      // Busy or storage trouble: stop and leave the rest for the next start (or the first time someone opens them).
      try { await storedFileText(db, file, store); read++; } catch { return false; }
    }
    batch = [];
    return read < limit;
  };
  for await (const row of cursor) {
    batch.push(String(row._id));
    if (batch.length === 200 && !(await run())) return read;
  }
  if (batch.length) await run();
  return read;
}
