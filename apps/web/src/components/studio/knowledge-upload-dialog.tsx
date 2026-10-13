"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Select } from "@/components/ui/select";
import { createLiveDocument, uploadLiveFile } from "@/lib/studio-api";
import clsx from "clsx";
import { Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { X } from "@/components/ui/icons";
import { useExitTransition } from "@/lib/motion";

type UploadSession = { membership: { role: string; ventureIds: string[]; canShareKnowledge?: boolean | undefined }; hierarchy: { ventures: Array<{ id: string; name: string }> } };
type UploadItem = { id: string; file: File; status: "queued" | "reading" | "uploading" | "finalizing" | "done" | "failed"; progress: number; error?: string };
const supported = ".pdf,.docx,.md,.txt,.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.mp3,.m4a,.ogg,.wav";

export function KnowledgeUploadDialog({ mode, session, activeVentureId, initialFiles, onClose, onComplete, onMarkdown, onFile, demo = false }: {
  mode: "markdown" | "file";
  session: UploadSession;
  activeVentureId: string;
  /** Files dropped onto the page before the dialog opened. */
  initialFiles?: File[];
  onClose: () => void;
  onComplete: (summary: { failed: number }) => void;
  onMarkdown?: (file: File, markdown: string, ventureId: string) => Promise<void>;
  onFile?: (file: File, ventureId: string, progress: (percent: number, phase: "uploading" | "finalizing") => void) => Promise<void>;
  demo?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [ventureId, setVentureId] = useState(activeVentureId);
  const [items, setItems] = useState<UploadItem[]>(() => (initialFiles ?? []).map((file) => ({ id: crypto.randomUUID(), file, status: "queued" as const, progress: 0 })));
  const [dragging, setDragging] = useState(false);
  const { state, close } = useExitTransition(onClose, 130);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const ventures = session.membership.role === "admin" ? session.hierarchy.ventures : session.hierarchy.ventures.filter((venture) => session.membership.ventureIds.includes(venture.id));
  const activeVenture = ventures.find((venture) => venture.id === activeVentureId);
  const update = (id: string, change: Partial<UploadItem>) => setItems((current) => current.map((item) => item.id === id ? { ...item, ...change } : item));

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    return () => node.close();
  }, []);

  function addFiles(files: FileList | File[] | null) {
    if (!files?.length) return;
    setError("");
    setItems((current) => [...current, ...Array.from(files).map((file) => ({ id: crypto.randomUUID(), file, status: "queued" as const, progress: 0 }))]);
  }

  async function submit() {
    if (uploading) return;
    // Files belong to a venture; Markdown and text become documents, which may go to the whole workspace.
    if (!ventureId && mode === "file") { setError("Choose a venture for these files."); return; }
    if (!items.some((item) => item.status === "queued" || item.status === "failed")) return;
    setError(""); setUploading(true);
    let completed = false;
    let failed = 0;
    for (const item of items.filter((item) => item.status === "queued" || item.status === "failed")) {
      try {
        if (mode === "markdown" || /\.(md|markdown|txt)$/i.test(item.file.name)) {
          if (!/\.(md|markdown|txt)$/i.test(item.file.name) || !item.file.size || item.file.size > 2_000_000) throw new Error("Choose a nonempty Markdown or text file up to 2 MB.");
          update(item.id, { status: "reading", progress: 0, error: undefined });
          const markdown = await item.file.text();
          if (!markdown.trim() || markdown.length > 2_000_000) throw new Error("The file must contain Markdown text under 2 million characters.");
          update(item.id, { status: "finalizing", progress: 0 });
          if (onMarkdown) await onMarkdown(item.file, markdown, ventureId);
          else await createLiveDocument({ ...(ventureId ? { ventureId } : {}), title: item.file.name.replace(/\.(md|markdown|txt)$/i, ""), markdown, evidenceClass: "founder_reported", sensitivity: "team", changeSummary: `Imported ${item.file.name}` });
        } else {
          if (!item.file.size || item.file.size > 25 * 1024 * 1024) throw new Error("Choose a nonempty file up to 25 MB.");
          update(item.id, { status: "uploading", progress: 0, error: undefined });
          const progress = (percent: number, phase: "uploading" | "finalizing") => update(item.id, { progress: percent, status: phase });
          if (onFile) await onFile(item.file, ventureId, progress);
          else await uploadLiveFile(item.file, { ventureId }, progress);
        }
        completed = true;
        update(item.id, { status: "done", progress: 100 });
      } catch (cause) {
        failed += 1;
        update(item.id, { status: "failed", error: describeError(cause, "Upload failed.") });
      }
    }
    setUploading(false);
    if (completed) onComplete({ failed });
  }

  const title = mode === "markdown" ? "Upload Markdown" : "Upload files";
  return createPortal(<dialog ref={dialog} aria-label={title} data-state={state} onCancel={(event) => { event.preventDefault(); if (!uploading) close(); }} onClick={(event) => { if (!uploading && event.target === dialog.current) close(); }} className="vso-dialog knowledge-upload-modal fixed inset-0 m-auto w-[min(640px,calc(100vw-32px))] max-h-[min(780px,calc(100dvh-32px))] overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-0 text-neutral-900 shadow-2xl backdrop:bg-black/50">
    <div className="border-b border-neutral-100 px-5 py-4 sm:px-6"><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-bold">{title}</h2><p className="mt-1 text-sm leading-5 text-neutral-500">{demo ? "Demo only: selected files stay in this browser tab and are not sent to the server." : "Markdown and text become draft records for review. Other files stay private to their venture."}</p></div><button type="button" disabled={uploading} onClick={close} className="min-h-9 rounded-lg px-3 text-sm font-semibold text-neutral-600 transition-[background-color,transform] duration-150 hover:bg-neutral-50 active:scale-[0.97] disabled:opacity-50">Close</button></div></div>
    <div className="space-y-5 p-5 sm:p-6">
      {activeVentureId ? <div aria-label="Upload destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Destination · fixed to current venture</span><span className="mt-1 block text-sm font-bold">{activeVenture?.name ?? "Current venture"}</span></div> : <Field label="Destination venture"><Select className={inputClass} value={ventureId} disabled={uploading} onChange={(event) => setVentureId(event.target.value)}>{mode === "markdown" ? <option value="">{session.membership.role === "admin" || session.membership.canShareKnowledge ? "Workspace" : "Workspace (needs approval)"}</option> : <option value="">Choose venture</option>}{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}
      <label onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files") || uploading) return; event.preventDefault(); setDragging(true); }} onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files") || uploading) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={(event) => { if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return; setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!uploading) addFiles(event.dataTransfer.files); }} className={clsx("block cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition-[background-color,border-color,transform] duration-150 focus-within:ring-2 focus-within:ring-primary-400", dragging ? "scale-[1.01] border-primary-500 bg-primary-100" : "border-primary-300 bg-primary-50")}><span className="block text-sm font-semibold text-primary-800">{dragging ? "Drop to add" : `Drop or choose ${mode === "markdown" ? "Markdown files" : "files"}`}</span><span className="mt-1 block text-xs text-neutral-500">{mode === "markdown" ? ".md, .markdown, .txt · 2 MB each" : "PDF, text, images, video, or audio · 25 MB each"}</span><span aria-hidden="true" className="mx-auto mt-3 inline-flex min-h-9 items-center justify-center rounded-lg border border-neutral-200 bg-white px-4 text-xs font-semibold text-neutral-800">Browse files</span><input type="file" multiple accept={mode === "markdown" ? ".md,.markdown,.txt,text/markdown,text/plain" : supported} disabled={uploading} onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} className="sr-only" /></label>
      {items.length > 0 && <div aria-label="Selected files" className="max-h-64 space-y-2 overflow-y-auto">{items.map((item) => <div key={item.id} className="vso-row-enter rounded-xl border border-neutral-200 px-3 py-2"><div className="flex items-start justify-between gap-2"><span className="min-w-0 break-all text-sm font-semibold">{item.file.name}</span><span className="flex shrink-0 items-center gap-1"><span key={item.status} className={clsx("vso-label-swap text-xs capitalize", item.status === "done" ? "font-semibold text-success-text" : item.status === "failed" ? "font-semibold text-danger-text" : "text-neutral-500")}>{item.status === "done" ? "✓ Ready" : item.status}</span>{!uploading && (item.status === "queued" || item.status === "failed") && <button type="button" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} aria-label={`Remove ${item.file.name}`} className="-mr-1 grid h-6 w-6 place-items-center rounded-md text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700"><X size={13} /></button>}</span></div>{item.status === "uploading" || (item.status === "finalizing" && mode === "file") ? <div className="mt-2 flex items-center gap-2"><div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress} aria-label={`${item.file.name} upload progress`} className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-100"><span className="block h-full origin-left rounded-full bg-primary-600 transition-transform duration-300 ease-out" style={{ transform: `scaleX(${item.progress / 100})` }} /></div><span className="w-9 text-right text-xs tabular-nums text-neutral-500">{item.progress}%</span></div> : item.status === "reading" || item.status === "finalizing" ? <span role="progressbar" aria-label={`${item.file.name} processing`} className="vso-skeleton mt-2 block h-2 w-full rounded-full" /> : null}{item.error && <p role="alert" className="mt-1 text-xs text-danger-text">{item.error}</p>}</div>)}</div>}
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={uploading} onClick={close} className={secondaryClass}>Done</button><button type="button" disabled={uploading || !items.some((item) => item.status === "queued" || item.status === "failed")} onClick={() => void submit()} className={primaryClass}>{uploading ? "Uploading…" : items.some((item) => item.status === "failed") ? "Retry failed" : `Upload ${items.filter((item) => item.status === "queued").length} ${mode === "markdown" ? "document" : "file"}${items.filter((item) => item.status === "queued").length === 1 ? "" : "s"}`}</button></div>
    </div>
  </dialog>, document.body);
}
