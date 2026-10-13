"use client";
import { describeError } from "@/lib/errors";

import { useDeferredValue, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowLeft, Edit, Eye } from "@/components/ui/icons";
import { MarkdownBody } from "@/components/studio/knowledge-markdown";
import { getLiveDocument, loadLiveSession, updateLiveDocument } from "@/lib/studio-api";
import { ActionLabel, Notice, SkeletonRows } from "@/components/studio/primitives";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { toast } from "@/components/ui/toast";
import { replayAnimation } from "@/lib/motion";

type DocumentDetail = Awaited<ReturnType<typeof getLiveDocument>>;
type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type EditorMode = "write" | "split" | "preview";
type Draft = { markdown: string; summary: string; sourceUri: string; savedAt: string };
const MODE_TABS = [{ key: "write", label: "Write" }, { key: "split", label: "Split" }, { key: "preview", label: "Preview" }];
const FORMATS = [{ label: "Heading", before: "## ", after: "", placeholder: "Heading" }, { label: "Bold", before: "**", after: "**", placeholder: "bold text", keys: "Control+B" }, { label: "Italic", before: "*", after: "*", placeholder: "italic text", keys: "Control+I" }, { label: "Link", before: "[", after: "](https://example.com)", placeholder: "link text", keys: "Control+K" }, { label: "Bullets", before: "- ", after: "", placeholder: "List item" }, { label: "Quote", before: "> ", after: "", placeholder: "Quoted text" }, { label: "Code", before: "`", after: "`", placeholder: "code" }];
// Drafts are per member, so a shared browser never offers one member's text to another.
const draftKey = (userId: string, documentId: string, versionId: string) => `vso-editor-draft:${userId}:${documentId}:${versionId}`;
const readDraft = (key: string): Draft | null => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as Draft : null; } catch { return null; } };
const clearDraft = (key: string) => { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } };
const clockTime = (iso: string) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function LiveKnowledgeEditorScreen({ documentId }: { documentId: string }) {
  const router = useRouter();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const discardDialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [sourceUri, setSourceUri] = useState("");
  const [summary, setSummary] = useState("");
  const [mode, setMode] = useState<EditorMode>("split");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // Unsaved work is kept in this browser so a closed tab or crash does not lose it.
  const [recovered, setRecovered] = useState<Draft | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState("");
  const summaryInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const editorScroll = useRef(0);
  const deferredMarkdown = useDeferredValue(markdown);

  useEffect(() => {
    let active = true;
    Promise.all([getLiveDocument(documentId), loadLiveSession()]).then(([nextDetail, nextSession]) => {
      if (!active) return;
      setDetail(nextDetail);
      setSession(nextSession);
      setMarkdown(nextDetail.version.markdown);
      setSourceUri(nextDetail.version.sourceUri ?? "");
      const draft = readDraft(draftKey(nextSession.user.id, nextDetail.document.id, nextDetail.version.id));
      if (draft && (draft.markdown !== nextDetail.version.markdown || draft.summary.trim())) setRecovered(draft);
      setLoading(false);
    }).catch((cause: unknown) => {
      if (active) { setError(describeError(cause, "Could not open the editor.")); setLoading(false); }
    });
    return () => { active = false; };
  }, [documentId]);

  const writer = !!session && ["venture_head", "contributor"].includes(session.membership.role);
  // Admins, and writers allowed to share with all ventures, change workspace-wide documents directly.
  const sharer = !!session && (session.membership.role === "admin" || (writer && session.membership.canShareKnowledge === true));
  const canEdit = !!detail && !!session && (session.membership.role === "admin" || (writer && (detail.document.ventureId ? session.membership.ventureIds.includes(detail.document.ventureId) : !detail.document.review || detail.document.ownerId === session.user.id || sharer)));
  // Anyone else's edit to a shared document is a suggestion: the live version stays until an approver accepts it.
  const suggesting = !!detail && !detail.document.ventureId && !detail.document.review && !sharer;
  const contentChanged = !!detail && (markdown !== detail.version.markdown || sourceUri !== (detail.version.sourceUri ?? ""));
  const dirty = contentChanged || !!summary.trim();
  const venture = session?.hierarchy.ventures.find((item) => item.id === detail?.document.ventureId)?.name ?? "Workspace";
  const wordCount = markdown.trim() ? markdown.trim().split(/\s+/).length : 0;
  const storageKey = detail && session ? draftKey(session.user.id, detail.document.id, detail.version.id) : "";

  // Save a browser draft shortly after typing stops (not while a recovered draft is waiting for a decision).
  useEffect(() => {
    if (!storageKey || recovered) return;
    if (!dirty) { clearDraft(storageKey); return; }
    const timer = window.setTimeout(() => {
      const savedAt = new Date().toISOString();
      try { localStorage.setItem(storageKey, JSON.stringify({ markdown, summary, sourceUri, savedAt } satisfies Draft)); setDraftSavedAt(savedAt); } catch { /* storage full or blocked */ }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, markdown, recovered, sourceUri, storageKey, summary]);

  function changeMode(next: EditorMode) {
    // The editor stays mounted in Preview; keep its scroll position across the switch.
    if (next === "preview" && textarea.current) editorScroll.current = textarea.current.scrollTop;
    setMode(next);
    if (next !== "preview") requestAnimationFrame(() => { if (textarea.current) textarea.current.scrollTop = editorScroll.current; });
  }

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // In-app links (sidebar, top bar) bypass beforeunload; hold the destination and ask before leaving unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      event.preventDefault(); event.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
      setConfirmDiscard(true);
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [dirty]);

  useEffect(() => {
    const dialog = discardDialog.current;
    if (!dialog || !confirmDiscard) return;
    dialog.showModal();
    return () => dialog.close();
  }, [confirmDiscard]);

  function returnToDocument() {
    if (dirty) { setConfirmDiscard(true); return; }
    router.push(`/knowledge/live?doc=${encodeURIComponent(documentId)}`);
  }

  function format(before: string, after = "", placeholder = "text") {
    const input = textarea.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = markdown.slice(start, end) || placeholder;
    const blockPrefix = ["## ", "- ", "> "].includes(before) && start > 0 && markdown[start - 1] !== "\n" ? "\n" : "";
    const blockSuffix = ["## ", "- ", "> "].includes(before) && markdown[end] !== "\n" ? "\n" : "";
    setMarkdown(`${markdown.slice(0, start)}${blockPrefix}${before}${selected}${after}${blockSuffix}${markdown.slice(end)}`);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + blockPrefix.length + before.length, start + blockPrefix.length + before.length + selected.length);
    });
  }

  async function save() {
    if (!detail || !canEdit || saving) return;
    const invalid = (message: string, field?: HTMLElement | null) => { setError(message); if (field) { field.focus(); replayAnimation(field, "vso-shake"); } };
    if (!contentChanged) { invalid("Make a change to the document before saving a new version.", textarea.current); return; }
    if (!markdown.trim()) { invalid("The document cannot be empty.", textarea.current); return; }
    if (!summary.trim()) { invalid("Add a short change summary before saving.", summaryInput.current); return; }
    if (sourceUri && !/^https?:\/\//i.test(sourceUri)) { invalid("The source URL must start with http:// or https://.", sourceInput.current); return; }
    setSaving(true); setError("");
    try {
      const latest = await getLiveDocument(documentId);
      if (latest.version.id !== detail.version.id) throw new Error("A newer version was saved while you were editing. Copy your changes before reloading this editor.");
      const saved = await updateLiveDocument(documentId, { markdown, changeSummary: summary.trim(), baseVersionId: detail.version.id, ...(sourceUri ? { sourceUri } : {}) });
      clearDraft(storageKey);
      toast("suggestion" in saved ? { title: "Suggestion sent for approval", body: `${detail.document.title} stays as it is until an approver accepts your change.` } : { title: "New draft saved", body: detail.document.title });
      router.push(`/knowledge/live?doc=${encodeURIComponent(documentId)}`);
    } catch (cause) {
      setError(describeError(cause, "Could not save this document."));
      setSaving(false);
    }
  }

  if (loading) return <div className="mx-auto max-w-5xl p-6"><SkeletonRows rows={6} label="Opening editor" /></div>;
  if (!detail || !session || !canEdit) return <div className="mx-auto max-w-xl p-8"><h1 className="text-xl font-bold text-neutral-900">Editor unavailable</h1><p role="alert" className="mt-3 text-sm text-danger-text">{error || "You do not have permission to edit this record."}</p><button type="button" onClick={() => router.push("/knowledge/live")} className="mt-5 text-sm font-semibold text-primary-700 underline">Back to Knowledge</button></div>;

  return <section aria-label={`Editing ${detail.document.title}`} onKeyDown={(event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") { event.preventDefault(); void save(); return; }
    const shortcut = event.target === textarea.current ? FORMATS.find((item) => item.keys?.endsWith(`+${key.toUpperCase()}`)) : undefined;
    if (shortcut) { event.preventDefault(); event.stopPropagation(); format(shortcut.before, shortcut.after, shortcut.placeholder); }
  }} className="flex h-[calc(100dvh-56px)] min-h-0 flex-col overflow-hidden bg-neutral-50">
    <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3 sm:px-6">
      <button type="button" onClick={returnToDocument} aria-label="Back to document" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-700 transition-[background-color,transform] duration-150 hover:bg-neutral-100 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"><ArrowLeft size={18} /></button>
      <div className="min-w-0 flex-1"><h1 className="truncate text-base font-bold text-neutral-900" title={detail.document.title}>{detail.document.title}</h1><p className="truncate text-xs text-neutral-500">{venture} · Editing version {detail.version.version} · {dirty ? <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="vso-fade-enter h-1.5 w-1.5 rounded-full bg-warning" />Unsaved changes{draftSavedAt ? ` · draft kept in this browser ${clockTime(draftSavedAt)}` : ""}</span> : "No changes"}</p></div>
      <button type="button" onClick={() => void save()} disabled={saving || !contentChanged} aria-keyshortcuts="Control+S Meta+S" className="min-h-10 rounded-xl bg-primary-700 px-4 text-sm font-bold text-white transition-[background-color,transform,opacity] duration-150 hover:bg-primary-800 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"><ActionLabel busy={saving} idle={suggesting ? "Suggest change" : "Save new draft"} /></button>
    </header>

    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4 pt-4 sm:px-6">
      {recovered && <div role="status" className="vso-row-enter mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-surface bg-warning-surface px-4 py-3 text-sm font-semibold text-warning-text"><span>Unsaved changes from {clockTime(recovered.savedAt)} were kept in this browser.</span><span className="flex gap-2"><button type="button" onClick={() => { setMarkdown(recovered.markdown); setSummary(recovered.summary); setSourceUri(recovered.sourceUri); setRecovered(null); }} className="min-h-9 rounded-lg bg-white px-3 text-xs font-bold text-neutral-800 transition-transform duration-150 active:scale-[0.97]">Restore them</button><button type="button" onClick={() => { clearDraft(storageKey); setRecovered(null); }} className="min-h-9 rounded-lg px-3 text-xs font-bold transition-[background-color,transform] duration-150 hover:bg-black/5 active:scale-[0.97]">Discard</button></span></div>}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SlidingTabs fitContent label="Editor layout" className="border border-neutral-200 !shadow-none" active={mode} onChange={(key) => changeMode(key as EditorMode)} tabs={MODE_TABS} />
        <span className="text-xs tabular-nums text-neutral-500">{wordCount.toLocaleString()} words · {markdown.length.toLocaleString()} characters</span>
      </div>

      <div data-open={mode !== "preview"} className="vso-collapse"><div><div role="toolbar" aria-label="Markdown formatting" className="mb-3 flex flex-wrap gap-1 rounded-xl border border-neutral-200 bg-white p-1.5">
        {FORMATS.map((item) => <button key={item.label} type="button" tabIndex={mode === "preview" ? -1 : 0} onClick={() => format(item.before, item.after, item.placeholder)} aria-keyshortcuts={item.keys} title={item.keys ? `${item.label} (${item.keys.replace("Control", "Ctrl")})` : item.label} className="min-h-8 rounded-lg px-2.5 text-xs font-semibold text-neutral-700 transition-[background-color,transform] duration-150 hover:bg-neutral-100 active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">{item.label}</button>)}
      </div></div></div>

      <div className={`grid min-h-0 flex-1 gap-3 ${mode === "split" ? "md:grid-cols-2" : "grid-cols-1"}`}>
        <div hidden={mode === "preview"} className="vso-fade-enter flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white"><label htmlFor="knowledge-editor-content" className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2 text-xs font-bold text-neutral-600"><Edit size={14} />Markdown source</label><textarea ref={textarea} id="knowledge-editor-content" value={markdown} onChange={(event) => setMarkdown(event.target.value)} maxLength={2_000_000} spellCheck className="min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-7 text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500" /></div>
        <div hidden={mode === "write"} className="vso-fade-enter flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white"><div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2 text-xs font-bold text-neutral-600"><Eye size={14} />Live preview</div><div className="min-h-0 flex-1 overflow-auto px-5 py-5 sm:px-7">{mode !== "write" && <MarkdownBody markdown={deferredMarkdown} view="rendered" />}</div></div>
      </div>

      <div className="mt-3 grid gap-3 rounded-xl border border-neutral-200 bg-white p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="min-w-0 text-xs font-semibold text-neutral-600">Change summary <span className="font-normal text-neutral-500">(required to save)</span><input ref={summaryInput} value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={500} placeholder="What changed in this version?" className="mt-1 block min-h-10 w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-primary-500" /></label>
        <label className="min-w-0 text-xs font-semibold text-neutral-600">Source URL <span className="font-normal text-neutral-500">(optional)</span><input ref={sourceInput} type="url" value={sourceUri} onChange={(event) => setSourceUri(event.target.value)} placeholder="https://…" className="mt-1 block min-h-10 w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-primary-500" /></label>
      </div>
      <p className="mt-2 text-xs text-neutral-500">{suggesting ? "This document is shared with all ventures. Your change goes to an approver; the live version stays until they accept it." : "Saving creates a new draft version. It does not approve or publish the record to evidence search."}</p>
      <Notice tone="error" message={error} onDismiss={() => setError("")} className="pt-2" />
    </div>
    {createPortal(<dialog ref={discardDialog} aria-labelledby="knowledge-discard-title" onCancel={(event) => { event.preventDefault(); setConfirmDiscard(false); setPendingHref(null); }} className="vso-dialog m-auto w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-neutral-200 bg-white p-0 text-neutral-900 shadow-2xl backdrop:bg-black/60">
      <div className="p-5">
        <h2 id="knowledge-discard-title" className="text-lg font-bold">Discard unsaved edits?</h2>
        <p className="mt-2 text-sm text-neutral-600">Your changes to this record will be lost.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus onClick={() => { setConfirmDiscard(false); setPendingHref(null); }} className="min-h-10 rounded-xl border border-neutral-200 px-4 text-sm font-semibold hover:bg-neutral-100">Keep editing</button>
          <button type="button" onClick={() => { setConfirmDiscard(false); clearDraft(storageKey); router.push(pendingHref ?? `/knowledge/live?doc=${encodeURIComponent(documentId)}`); }} className="min-h-10 rounded-xl bg-danger-surface px-4 text-sm font-semibold text-danger-text hover:opacity-80">Discard edits</button>
        </div>
      </div>
    </dialog>, document.body)}
  </section>;
}
