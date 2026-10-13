"use client";
import { describeError } from "@/lib/errors";
/* eslint-disable @next/next/no-img-element -- Authorized blob previews cannot use Next image optimization. */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Download, FileText, Paperclip, X } from "@/components/ui/icons";
import type { Message } from "@venture-studio/contracts";
import { isCompressibleImage, prepareUpload } from "@/lib/image-compress";
import { loadLiveImageThumbnail, prepareLiveFileDownload, StudioApiError, uploadLiveFile } from "@/lib/studio-api";

/** `width`/`height` are an image's pixel size; `hd` marks a photo sent untouched in original quality. */
export type ChatAttachment = { id: string; name: string; contentType: string; size: number; width?: number; height?: number; hd?: true };
export type ChatUploadScope = { ventureId: string; groupId: string } | { recipientId: string };

const allowedTypes = new Set([
  "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/markdown", "text/plain", "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav",
]);
const typeByExtension: Record<string, string> = {
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", md: "text/markdown", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
};
const errorText = (cause: unknown) => describeError(cause, "The file could not be uploaded.");
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
// Shown inside the message rather than as a file card.
const INLINE_IMAGE = /^image\/(png|jpeg|webp|gif)$/;

// Files still uploading show as placeholder chips so the tray never jumps when each one lands.
type TrayState = {
  key: string; items: ChatAttachment[]; queued: Array<{ name: string; size: number }>; uploading: boolean; error: string;
  /** HD for the next message's photos; it turns itself off after each message. */
  hd: boolean;
  /** Photos being uploaded again at the other quality. */
  switching: string[];
  /** A picked file's tray preview, and whether it is a photo HD applies to. */
  local: Record<string, { preview?: string; photo: boolean }>;
};
const emptyTray = (key: string): TrayState => ({ key, items: [], queued: [], uploading: false, error: "", hd: false, switching: [], local: {} });
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function messageAttachments(message: Message): ChatAttachment[] {
  return "attachments" in message && Array.isArray(message.attachments) ? message.attachments as ChatAttachment[] : [];
}

export function useChatAttachments(scopeKey: string, scope: ChatUploadScope | null) {
  const [state, setState] = useState<TrayState>(() => emptyTray(scopeKey));
  const activeKey = useRef(scopeKey);
  // The picked originals (so HD can be switched after picking) and their tray previews, by uploaded file id.
  const sources = useRef(new Map<string, { file: File; preview?: string }>());
  const current = state.key === scopeKey ? state : emptyTray(scopeKey);

  const forget = useCallback((ids?: string[]) => {
    for (const [id, source] of sources.current) {
      if (ids && !ids.includes(id)) continue;
      if (source.preview) URL.revokeObjectURL(source.preview);
      sources.current.delete(id);
    }
  }, []);
  useEffect(() => { activeKey.current = scopeKey; forget(); setState(emptyTray(scopeKey)); }, [scopeKey, forget]);
  useEffect(() => () => forget(), [forget]);

  /** Shrinks a photo unless HD is on (see prepareUpload), then uploads it. */
  async function upload(source: File, hd: boolean): Promise<ChatAttachment> {
    const prepared = await prepareUpload(source, { hd });
    if (prepared.file.size > MAX_BYTES) throw new Error(hd ? "This photo is over 25 MB, too large to send in HD." : "Choose a supported file up to 25 MB.");
    const image = { ...(prepared.width && prepared.height ? { width: prepared.width, height: prepared.height } : {}), ...(prepared.hd ? { hd: true as const } : {}) };
    const uploaded = await uploadLiveFile(prepared.file, scope!, undefined, image);
    return { id: uploaded.id, name: uploaded.name, contentType: uploaded.contentType, size: uploaded.size, ...image };
  }

  async function addFiles(files: FileList | null) {
    if (!scope || !files?.length || current.uploading) return;
    const key = scopeKey;
    const hd = current.hd;
    const chosen = Array.from(files);
    if (chosen.length + current.items.length > 10) {
      setState((value) => value.key === key ? { ...value, error: "A message can have up to 10 files." } : value);
      return;
    }
    setState((value) => value.key === key ? { ...value, uploading: true, error: "", queued: chosen.map((file) => ({ name: file.name, size: file.size })) } : value);
    try {
      for (const picked of chosen) {
        const type = picked.type || typeByExtension[picked.name.split(".").at(-1)?.toLowerCase() ?? ""] || "";
        // A photo sent in standard quality is shrunk first, so a larger original is fine.
        const limit = isCompressibleImage(type) && !hd ? MAX_PHOTO_BYTES : MAX_BYTES;
        if (!allowedTypes.has(type) || picked.size < 1 || picked.size > limit) throw new Error("Choose a supported file up to 25 MB.");
        const source = picked.type === type ? picked : new File([picked], picked.name, { type, lastModified: picked.lastModified });
        const item = await upload(source, hd);
        if (activeKey.current !== key) return;
        const photo = isCompressibleImage(type);
        const preview = type.startsWith("image/") ? URL.createObjectURL(source) : undefined;
        sources.current.set(item.id, { file: source, preview });
        setState((value) => value.key === key ? { ...value, items: [...value.items, item], local: { ...value.local, [item.id]: { preview, photo } }, queued: value.queued.slice(1) } : value);
      }
    } catch (cause) {
      if (activeKey.current === key) setState((value) => value.key === key ? { ...value, error: errorText(cause) } : value);
    } finally {
      setState((value) => value.key === key ? { ...value, uploading: false, queued: [] } : value);
    }
  }

  /** HD on or off for the photos already picked: each one is uploaded again at the other quality. */
  async function setHd(next: boolean) {
    if (!scope || current.uploading || next === current.hd) return;
    const key = scopeKey;
    const targets = current.items.filter((item) => current.local[item.id]?.photo && sources.current.has(item.id) && (item.hd === true) !== next);
    setState((value) => value.key === key ? { ...value, hd: next, error: "", ...(targets.length ? { uploading: true, switching: targets.map((item) => item.id) } : {}) } : value);
    if (!targets.length) return;
    try {
      for (const target of targets) {
        const source = sources.current.get(target.id);
        if (!source) continue;
        const item = await upload(source.file, next);
        if (activeKey.current !== key) return;
        sources.current.delete(target.id);
        sources.current.set(item.id, source);
        setState((value) => {
          if (value.key !== key) return value;
          const { [target.id]: local, ...others } = value.local;
          return { ...value, items: value.items.map((entry) => entry.id === target.id ? item : entry), local: local ? { ...others, [item.id]: local } : others, switching: value.switching.filter((id) => id !== target.id) };
        });
      }
    } catch (cause) {
      if (activeKey.current === key) setState((value) => value.key === key ? { ...value, hd: value.items.some((item) => value.local[item.id]?.photo && item.hd === true), error: errorText(cause) } : value);
    } finally {
      setState((value) => value.key === key ? { ...value, uploading: false, switching: [] } : value);
    }
  }

  return {
    items: current.items,
    queued: current.queued,
    uploading: current.uploading,
    error: current.error,
    hd: current.hd,
    switching: current.switching,
    local: current.local,
    addFiles,
    setHd,
    remove: (id: string) => { forget([id]); setState((value) => value.key === scopeKey ? { ...value, items: value.items.filter((item) => item.id !== id) } : value); },
    /** After sending: an empty tray, and HD back off for the next message. */
    clear: () => { forget(); setState((value) => value.key === scopeKey ? { ...value, items: [], local: {}, error: "", hd: false, switching: [] } : value); },
    dismissError: () => setState((value) => value.key === scopeKey ? { ...value, error: "" } : value),
    /** Puts already-uploaded files back in the tray (editing a message that failed to send). */
    restore: (files: ChatAttachment[]) => setState((value) => value.key === scopeKey ? { ...value, items: [...value.items, ...files.filter((file) => !value.items.some((item) => item.id === file.id))].slice(0, 10) } : value),
  };
}

type AttachmentState = ReturnType<typeof useChatAttachments>;

export function AttachmentTray({ attachments }: { attachments: AttachmentState }) {
  // A removed chip shrinks away before it leaves the tray.
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const open = attachments.items.length > 0 || attachments.queued.length > 0;
  const photos = attachments.items.some((file) => attachments.local[file.id]?.photo);
  function remove(id: string) {
    setLeaving((value) => new Set(value).add(id));
    window.setTimeout(() => { attachments.remove(id); setLeaving((value) => { const next = new Set(value); next.delete(id); return next; }); }, 120);
  }
  return <>
    <div data-open={open} className="vso-collapse"><div><div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Files ready to send">
      {attachments.items.map((file) => {
        const preview = attachments.local[file.id]?.preview;
        const switching = attachments.switching.includes(file.id);
        return <span key={file.id} data-leaving={leaving.has(file.id)} className={clsx("vso-chip-in inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--color-neutral-100)] py-1 pr-1 text-[11px] text-[var(--color-neutral-700)]", preview ? "pl-1" : "pl-2")}>
          {preview ? <span className="relative h-7 w-7 shrink-0 overflow-hidden rounded-md bg-[var(--color-neutral-200)]"><img src={preview} alt="" className="h-full w-full object-cover" />{switching && <span className="absolute inset-0 grid place-items-center bg-black/40"><span className="vso-spinner h-3 w-3 text-white" aria-hidden="true" /></span>}</span> : <FileText size={13} className="shrink-0" />}
          <span className="max-w-44 truncate">{file.name}</span><span className="text-[var(--color-neutral-400)] tabular-nums">{fileSize(file.size)}</span>
          <button type="button" aria-label={`Remove ${file.name}`} disabled={switching} onClick={() => remove(file.id)} className="grid h-6 w-6 place-items-center rounded-md transition-[background-color,transform] duration-150 hover:bg-[var(--color-neutral-200)] active:scale-90 disabled:opacity-40"><X size={13} /></button>
        </span>;
      })}
      {attachments.queued.map((file, index) => <span key={`${file.name}-${index}`} className="vso-chip-in inline-flex max-w-full items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-neutral-200)] px-2 py-1 text-[11px] text-[var(--color-neutral-500)]">{index === 0 ? <span className="vso-spinner h-3 w-3 text-[var(--color-primary-600)]" aria-hidden="true" /> : <FileText size={13} className="shrink-0 opacity-60" />}<span className="max-w-44 truncate">{file.name}</span><span className="text-[var(--color-neutral-400)]">{index === 0 ? "Uploading…" : "Waiting"}</span></span>)}
      {/* Photos go smaller by default, like WhatsApp; HD sends the originals. It turns itself off after each message. */}
      {photos && <button type="button" aria-pressed={attachments.hd} aria-label="Send photos in HD" disabled={attachments.uploading} onClick={() => void attachments.setHd(!attachments.hd)}
        title={attachments.hd ? "Photos go in original quality. Click to send them smaller." : "Photos are made smaller so they send fast. Click to send the originals in HD."}
        className={clsx("vso-chip-in inline-flex h-7 items-center rounded-lg px-2 text-[11px] font-bold tracking-wide transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)] disabled:opacity-60", attachments.hd ? "bg-[var(--color-primary-600)] text-white" : "text-[var(--color-neutral-500)] ring-1 ring-inset ring-[var(--color-neutral-200)] hover:bg-[var(--color-neutral-100)]")}>HD</button>}
      {attachments.uploading && <span role="status" className="sr-only">{attachments.switching.length ? `Switching ${attachments.switching.length} ${attachments.switching.length === 1 ? "photo" : "photos"} to ${attachments.hd ? "HD" : "standard quality"}` : `Uploading ${attachments.queued.length} ${attachments.queued.length === 1 ? "file" : "files"}`}</span>}
    </div></div></div>
    {attachments.error && <p role="alert" className="vso-row-enter mb-2 flex items-start gap-1 text-[11px] text-red-700"><span className="flex-1">{attachments.error}</span><button type="button" aria-label="Dismiss upload error" onClick={attachments.dismissError} className="-mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors duration-150 hover:bg-red-50"><X size={12} /></button></p>}
  </>;
}

export function AttachmentMenu({ attachments, disabled }: { attachments: AttachmentState; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(0);
  /** Pointer dismissals fade out; keyboard ones and picks close at once. */
  function close(animate: boolean) {
    window.clearTimeout(closeTimer.current);
    if (!animate) { setClosing(false); setOpen(false); return; }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => { setOpen(false); setClosing(false); }, 100);
  }
  function pick(input: React.RefObject<HTMLInputElement | null>) { close(false); input.current?.click(); }
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const images = useRef<HTMLInputElement>(null);
  const documents = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLInputElement>(null);
  const onFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    void attachments.addFiles(event.target.files);
    event.target.value = "";
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(true); };
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [open]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return <div ref={root} className="relative shrink-0" onKeyDown={(event) => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(false); trigger.current?.focus(); return; }
    if (event.key === "Tab") { close(false); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }}>
    <input ref={images} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm" onChange={onFiles} />
    <input ref={documents} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" accept=".pdf,.docx,.md,.txt" onChange={onFiles} />
    <input ref={audio} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" accept=".mp3,.m4a,.ogg,.wav,.webm" onChange={onFiles} />
    <button ref={trigger} type="button" aria-label="Attach files" title="Attach files" aria-haspopup="menu" aria-expanded={open} disabled={disabled || attachments.uploading || attachments.items.length >= 10} onClick={(event) => {
      if (open) { close(event.detail !== 0); return; }
      setOpen(true);
      // Opened from the keyboard, focus lands on the first choice.
      if (event.detail === 0) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
    }} className={clsx("grid h-8 w-8 place-items-center rounded-lg text-[var(--color-primary-600)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)] active:scale-[0.92] disabled:opacity-40", open && !closing && "bg-[var(--color-primary-100)]")}><Paperclip size={16} /></button>
    {open && <div role="menu" aria-label="Choose attachment type" data-side="top" data-align="left" data-state={closing ? "closing" : undefined} className="vso-enter-popover absolute bottom-full left-0 z-30 mb-2 w-48 rounded-xl border border-[var(--color-neutral-200)] bg-white p-1.5 shadow-e3">
      <button type="button" role="menuitem" onClick={() => pick(images)} className="flex min-h-9 w-full items-center rounded-lg px-3 text-left text-xs text-[var(--color-neutral-700)] transition-colors duration-100 hover:bg-[var(--color-primary-50)] focus-visible:bg-[var(--color-primary-50)] focus-visible:outline-none active:bg-[var(--color-primary-100)]">Images & videos</button>
      <button type="button" role="menuitem" onClick={() => pick(documents)} className="flex min-h-9 w-full items-center rounded-lg px-3 text-left text-xs text-[var(--color-neutral-700)] transition-colors duration-100 hover:bg-[var(--color-primary-50)] focus-visible:bg-[var(--color-primary-50)] focus-visible:outline-none active:bg-[var(--color-primary-100)]">Documents</button>
      <button type="button" role="menuitem" onClick={() => pick(audio)} className="flex min-h-9 w-full items-center rounded-lg px-3 text-left text-xs text-[var(--color-neutral-700)] transition-colors duration-100 hover:bg-[var(--color-primary-50)] focus-visible:bg-[var(--color-primary-50)] focus-visible:outline-none active:bg-[var(--color-primary-100)]">Audio</button>
    </div>}
  </div>;
}

export function AttachmentPicker({ attachments, disabled }: { attachments: AttachmentState; disabled?: boolean }) {
  return <><AttachmentTray attachments={attachments} /><AttachmentMenu attachments={attachments} disabled={disabled} /></>;
}

export function MessageAttachmentCard({ file }: { file: ChatAttachment }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const previewable = file.contentType.startsWith("image/") || file.contentType.startsWith("video/") || file.contentType.startsWith("audio/") || file.contentType === "application/pdf";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function preview() {
    if (url) { setUrl(""); return; }
    setLoading(true); setError("");
    try {
      const previewUrl = await prepareLiveFileDownload(file.id, file.contentType);
      if (mounted.current) setUrl(previewUrl);
      else URL.revokeObjectURL(previewUrl);
    }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }

  async function download() {
    setLoading(true); setError("");
    try {
      const downloadUrl = await prepareLiveFileDownload(file.id);
      const link = document.createElement("a");
      link.href = downloadUrl; link.download = file.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }

  return <div className="min-w-0 max-w-full rounded-xl bg-[var(--color-neutral-100)] p-2 text-left text-[var(--color-neutral-700)]">
    <div className="flex min-w-0 items-center gap-2"><FileText size={15} className="shrink-0 text-[var(--color-primary-700)]" /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold" title={file.name}>{file.name}</p><p className="text-[10px] text-[var(--color-neutral-400)]">{fileSize(file.size)}</p></div>{previewable && <button type="button" disabled={loading} onClick={preview} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[10px] font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-100)] active:scale-[0.96] disabled:opacity-70">{loading && <span className="vso-spinner h-2.5 w-2.5" aria-hidden="true" />}{url ? "Close" : "Preview"}</button>}<button type="button" disabled={loading} onClick={download} aria-label={`Download ${file.name}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-md transition-[background-color,transform] duration-150 hover:bg-[var(--color-neutral-200)] active:scale-90"><Download size={14} /></button></div>
    {loading && <p role="status" className="sr-only">Loading file…</p>}
    {error && <p role="alert" className="vso-row-enter mt-2 text-[10px] text-red-700">{error}</p>}
    {url && <div className="vso-fade-enter mt-2 overflow-hidden rounded-lg bg-white">{file.contentType.startsWith("image/") ? <img src={url} alt={file.name} className="max-h-72 max-w-full object-contain" /> : file.contentType.startsWith("video/") ? <video src={url} controls className="max-h-72 max-w-full" /> : file.contentType.startsWith("audio/") ? <audio src={url} controls className="w-full" /> : <iframe src={url} title={`Preview ${file.name}`} className="h-72 w-full" />}</div>}
  </div>;
}

export function MessageAttachmentList({ files, mine }: { files: ChatAttachment[]; mine?: boolean }) {
  if (!files.length) return null;
  const images = files.filter((file) => INLINE_IMAGE.test(file.contentType));
  const others = files.filter((file) => !INLINE_IMAGE.test(file.contentType));
  return <div className="mt-1 flex max-w-80 flex-col gap-1.5">
    {images.length > 0 && <div className={clsx("flex", mine && "justify-end")}><ImageGallery images={images} /></div>}
    {others.map((file) => <MessageAttachmentCard key={file.id} file={file} />)}
  </div>;
}

// Thumbnails are fetched a few at a time (the server makes two at once and turns away a long queue), retried while it is
// busy, and the latest 200 kept for this visit. Each tile makes its own object URL from the shared bytes and frees it when it goes.
const thumbnailBlobs = new Map<string, Promise<Blob>>();
const THUMBNAILS_AT_ONCE = 3;
let thumbnailsRunning = 0;
const thumbnailQueue: Array<() => void> = [];
async function thumbnailSlot<T>(work: () => Promise<T>): Promise<T> {
  if (thumbnailsRunning < THUMBNAILS_AT_ONCE) thumbnailsRunning += 1;
  else await new Promise<void>((resolve) => thumbnailQueue.push(resolve));
  try { return await work(); }
  finally { const next = thumbnailQueue.shift(); if (next) next(); else thumbnailsRunning -= 1; }
}
const serverBusy = (cause: unknown) => !(cause instanceof StudioApiError) || ["HTTP_429", "HTTP_502", "HTTP_503", "HTTP_504"].includes(String(cause.code));
function thumbnailBlob(id: string): Promise<Blob> {
  const cached = thumbnailBlobs.get(id);
  if (cached) { thumbnailBlobs.delete(id); thumbnailBlobs.set(id, cached); return cached; }
  const pending = thumbnailSlot(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await loadLiveImageThumbnail(id); }
      catch (cause) {
        if (attempt >= 3 || !serverBusy(cause)) throw cause;
        await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  });
  pending.catch(() => thumbnailBlobs.delete(id));
  thumbnailBlobs.set(id, pending);
  if (thumbnailBlobs.size > 200) thumbnailBlobs.delete(thumbnailBlobs.keys().next().value!);
  return pending;
}

function useThumbnail(id: string, enabled = true) {
  const [state, setState] = useState({ id, url: "", failed: false });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let url = "";
    thumbnailBlob(id).then((blob) => { if (!active) return; url = URL.createObjectURL(blob); setState({ id, url, failed: false }); }, () => { if (active) setState({ id, url: "", failed: true }); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [id, enabled]);
  return state.id === id ? state : { id, url: "", failed: false };
}

export function ImageTile({ file, className, style, more = 0, onOpen, onSize }: { file: ChatAttachment; className?: string; style?: React.CSSProperties; more?: number; onOpen: () => void; onSize?: (width: number, height: number) => void }) {
  const tile = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = tile.current;
    if (!node || near) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect(); } }, { rootMargin: "400px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  const thumbnail = useThumbnail(file.id, near);
  const [loaded, setLoaded] = useState(false);
  if (thumbnail.failed) return <MessageAttachmentCard file={file} />;
  return <button ref={tile} type="button" onClick={onOpen} aria-label={more ? `Open ${file.name} and ${more} more` : `Open image ${file.name}`} style={style}
    className={clsx("relative block shrink-0 overflow-hidden rounded-xl bg-[var(--color-neutral-100)] transition-transform duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)]", !loaded && "animate-pulse", className)}>
    {thumbnail.url && <img src={thumbnail.url} alt={file.name} draggable={false} onLoad={(event) => { setLoaded(true); onSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight); }} className={clsx("h-full w-full object-cover transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")} />}
    {file.hd && !more && <span className="absolute left-1.5 top-1.5 rounded bg-black/55 px-1 py-px text-[9px] font-bold tracking-wide text-white">HD</span>}
    {more > 0 && <span className="absolute inset-0 grid place-items-center bg-black/45 text-lg font-semibold text-white tabular-nums">+{more}</span>}
  </button>;
}

/** Images inside a message, as in WhatsApp: one shown at its own shape, several as a grid; a click opens them full size. */
function ImageGallery({ images }: { images: ChatAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const viewer = open !== null && <ImageViewer images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />;
  if (images.length === 1) {
    const file = images[0]!;
    const size = file.width && file.height ? { width: file.width, height: file.height } : natural;
    // At most 280 × 320; very tall or wide pictures are cropped to a sensible shape here (the viewer shows them whole).
    const ratio = size ? Math.min(2, Math.max(0.6, size.width / size.height)) : 4 / 3;
    const width = Math.max(72, Math.min(280, 320 * ratio, size?.width ?? 280));
    return <>{<ImageTile file={file} style={{ width, aspectRatio: String(ratio) }} className="max-w-full" onOpen={() => setOpen(0)} onSize={(width, height) => { if (!file.width) setNatural({ width, height }); }} />}{viewer}</>;
  }
  const shown = images.slice(0, 4);
  const extra = images.length - shown.length;
  return <>
    <div className="grid w-[264px] max-w-full grid-cols-2 gap-1">{shown.map((file, index) => <ImageTile key={file.id} file={file} className="aspect-square w-full" more={index === shown.length - 1 ? extra : 0} onOpen={() => setOpen(index)} />)}</div>
    {viewer}
  </>;
}

/** Full-size images of one message: arrows (or ← →) between them, download, and Escape or a click outside to close. */
export function ImageViewer({ images, index, onIndex, onClose }: { images: ChatAttachment[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const file = images[index]!;
  const thumbnail = useThumbnail(file.id);
  const [full, setFull] = useState<{ id: string; url: string } | null>(null);
  const [fullFailed, setFullFailed] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const many = images.length > 1;
  const step = useCallback((by: number) => { setError(""); onIndex((index + by + images.length) % images.length); }, [index, images.length, onIndex]);

  // The full image replaces the thumbnail once it arrives.
  useEffect(() => {
    let active = true;
    let made = "";
    prepareLiveFileDownload(file.id, file.contentType).then((url) => { made = url; if (active) setFull({ id: file.id, url }); else URL.revokeObjectURL(url); }).catch(() => { if (active) setFullFailed(file.id); });
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [file.id, file.contentType]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (many && (event.key === "ArrowRight" || event.key === "ArrowLeft")) { event.preventDefault(); event.stopPropagation(); step(event.key === "ArrowRight" ? 1 : -1); return; }
      if (event.key !== "Tab") return;
      // Focus stays inside the viewer.
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!focusable.length) return;
      const position = focusable.indexOf(document.activeElement as HTMLElement);
      if (position === -1 || (event.shiftKey ? position === 0 : position === focusable.length - 1)) { event.preventDefault(); focusable[event.shiftKey ? focusable.length - 1 : 0]!.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [many, onClose, step]);

  async function download() {
    setBusy(true); setError("");
    try {
      const url = full?.id === file.id ? full.url : await prepareLiveFileDownload(file.id);
      const link = document.createElement("a");
      link.href = url; link.download = file.name; link.click();
      if (url !== full?.url) window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  const source = full?.id === file.id ? full.url : thumbnail.url;
  const control = "grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/80 transition-[background-color,color,transform] duration-150 hover:bg-white/10 hover:text-white active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-50";
  return createPortal(<div ref={root} role="dialog" aria-modal="true" aria-label={many ? `${file.name}, image ${index + 1} of ${images.length}` : file.name} className="vso-fade-enter fixed inset-0 z-[90] flex flex-col bg-black/90 text-white"
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onContextMenu={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
      <p className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold"><span className="truncate">{file.name}</span>{file.hd && <span className="shrink-0 rounded bg-white/15 px-1.5 py-px text-[10px] font-bold tracking-wide">HD</span>}</p>
      {many && <span className="shrink-0 text-xs text-white/60 tabular-nums">{index + 1} of {images.length}</span>}
      <button type="button" onClick={() => void download()} disabled={busy} aria-label={`Download ${file.name}`} title="Download" className={control}><Download size={17} /></button>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className={control}><X size={18} /></button>
    </div>
    <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-6 sm:px-16" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {source ? <img key={file.id} src={source} alt={file.name} className="vso-fade-enter max-h-full max-w-full select-none rounded-md object-contain" /> : thumbnail.failed && fullFailed === file.id ? <p className="text-sm text-white/70">This image couldn&apos;t be shown. Try downloading it.</p> : <span className="vso-spinner h-6 w-6 text-white/70" aria-hidden="true" />}
      {many && <>
        <button type="button" onClick={() => step(-1)} aria-label="Previous image" className={clsx(control, "absolute left-2 top-1/2 -translate-y-1/2 bg-white/10 sm:left-4")}><ChevronLeft size={20} /></button>
        <button type="button" onClick={() => step(1)} aria-label="Next image" className={clsx(control, "absolute right-2 top-1/2 -translate-y-1/2 bg-white/10 sm:right-4")}><ChevronRight size={20} /></button>
      </>}
    </div>
    {error && <p role="alert" className="px-4 pb-4 text-center text-xs text-red-300">{error}</p>}
  </div>, document.body);
}
