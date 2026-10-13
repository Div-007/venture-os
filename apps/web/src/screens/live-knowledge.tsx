"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, BookOpenText, Copy, Download, Edit, FileQuestion, Plus, Search, Upload } from "@/components/ui/icons";
import { createLiveDocument, getLiveDocument, listLiveDocuments, listLiveFiles, listLiveKnowledgeReviews, listLiveMembers, loadLiveSession, prepareLiveFileDownload, reviewLiveDocumentRequest, reviewLiveSuggestion, searchLiveKnowledge, StudioApiError, updateLiveDocumentMetadata } from "@/lib/studio-api";
import { ActionLabel, Badge, DetailDrawer, Field, HeaderActions, HeaderLabel, inputClass, Notice, PageTitle, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass, SkeletonRows, useFlag } from "@/components/studio/primitives";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { KnowledgeDocumentTile } from "@/components/studio/knowledge-document-tile";
import { KnowledgeFileIcon } from "@/components/studio/knowledge-file-icon";
import { MarkdownBody, MarkdownViewToggle, type MarkdownView } from "@/components/studio/knowledge-markdown";
import { SkillsPanel, VentureContextPanel } from "@/components/studio/knowledge-agent-sections";
import { ChatFilesPanel, TaskFilesPanel } from "@/components/studio/knowledge-shared-files";
import { KnowledgeUploadDialog } from "@/components/studio/knowledge-upload-dialog";
import { useStudio } from "@/lib/studio-store";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Results = Awaited<ReturnType<typeof searchLiveKnowledge>>;
type DocumentDetail = Awaited<ReturnType<typeof getLiveDocument>>;
type DocumentMetadata = Awaited<ReturnType<typeof listLiveDocuments>>["items"][number];
type FileMetadata = Awaited<ReturnType<typeof listLiveFiles>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
const SECTION_TABS = [{ key: "library", label: "Library" }, { key: "context", label: "Venture context" }, { key: "skills", label: "Skills" }, { key: "tasks", label: "Tasks" }, { key: "chats", label: "Group chats" }, { key: "search", label: "Evidence search" }];
type Section = "library" | "context" | "skills" | "tasks" | "chats" | "search";
const SECTIONS = SECTION_TABS.map((tab) => tab.key) as Section[];
/** Wraps the searched words in <mark> so a reader sees why a result matched. */
function highlight(text: string, query: string) {
  const terms = query.trim().split(/\s+/).filter((term) => term.length >= 2).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return text;
  return text.split(new RegExp(`(${terms.join("|")})`, "gi")).map((part, index) => index % 2 ? <mark key={index} className="rounded bg-warning-surface px-0.5 text-inherit">{part}</mark> : part);
}
/** Esc returns to the library; "e" opens the editor. Ignored while typing or when a dialog is open. */
function useReaderKeys(onBack: () => void, onEdit?: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open], [role="listbox"]')) return;
      if (event.key === "Escape") { event.preventDefault(); onBack(); }
      else if (event.key === "e" && onEdit) { event.preventDefault(); onEdit(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onBack, onEdit]);
}

function ReaderShell({ name, subtitle, onBack, action, children }: { name: string; subtitle: string; onBack: () => void; action: React.ReactNode; children: React.ReactNode }) {
  return <section aria-label={`Viewing ${name}`} className="vso-fade-enter relative flex h-[calc(100dvh-56px)] min-h-0 w-full flex-col overflow-hidden bg-neutral-50">
    <header className="absolute inset-x-0 top-0 z-10 flex min-h-14 items-center gap-3 border-b border-white/10 bg-[#183027]/85 px-4 text-white backdrop-blur-xl sm:px-6">
      <button type="button" onClick={onBack} aria-label="Back to library" aria-keyshortcuts="Escape" title="Back to library (Esc)" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-[background-color,transform] duration-150 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 active:scale-[0.94]"><ArrowLeft size={17} /></button>
      <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-semibold" title={name}>{name}</h1><p className="truncate text-[10px] text-white/60">{subtitle}</p></div>
      {action}
    </header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto pt-14">{children}</div>
  </section>;
}

function DocumentReader({ detail, venture, onBack, onDetails, onEdit }: { detail: DocumentDetail; venture: string; onBack: () => void; onDetails: () => void; onEdit?: () => void }) {
  const [markdownView, setMarkdownView] = useState<MarkdownView>("rendered");
  useReaderKeys(onBack, onEdit);
  return <ReaderShell name={detail.document.title} subtitle={`${venture} · Version ${detail.version.version} · ${detail.document.status}`} onBack={onBack} action={<div className="flex shrink-0 items-center gap-2"><MarkdownViewToggle value={markdownView} onChange={setMarkdownView} />{onEdit && <button type="button" onClick={onEdit} aria-label={`Edit ${detail.document.title}`} aria-keyshortcuts="e" title="Open editor (E)" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-[background-color,transform] duration-150 active:scale-[0.94] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"><Edit size={17} /></button>}<button type="button" onClick={onDetails} className="min-h-9 shrink-0 rounded-xl px-3 text-xs font-semibold text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">Details & actions</button></div>}><div className="h-full w-full overflow-auto bg-white px-5 pb-12 pt-6 sm:px-10"><article className="mx-auto w-full max-w-5xl"><MarkdownBody markdown={detail.version.markdown} view={markdownView} /></article></div></ReaderShell>;
}

function FileReader({ file, url, venture, onBack }: { file: FileMetadata; url: string; venture: string; onBack: () => void }) {
  const isMarkdown = file.contentType.startsWith("text/markdown") || /\.(md|markdown)$/i.test(file.name);
  const isText = file.contentType.startsWith("text/") || /\.(md|markdown|txt)$/i.test(file.name);
  const [textPreview, setTextPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(isText);
  const [markdownView, setMarkdownView] = useState<MarkdownView>("rendered");
  useReaderKeys(onBack);
  useEffect(() => {
    if (!isText) return;
    let active = true;
    fetch(url).then((response) => { if (!response.ok) throw new Error("Preview unavailable"); return response.text(); }).then((value) => { if (active) setTextPreview(value); }).catch(() => { if (active) setPreviewError("This text file could not be previewed. Download it instead."); }).finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [isText, url]);
  const preview = isText ? <div className="h-full w-full overflow-auto bg-white px-5 pb-10 pt-6 sm:px-10"><article className="mx-auto w-full max-w-5xl">{previewLoading ? <SkeletonRows rows={6} label="Loading preview" className="!p-0" /> : previewError ? <p role="alert" className="text-sm text-danger-text">{previewError}</p> : isMarkdown ? <MarkdownBody markdown={textPreview} view={markdownView} /> : <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-7 text-neutral-900">{textPreview}</pre>}</article></div>
    : file.contentType === "application/pdf" ? <iframe src={url} title={`Preview of ${file.name}`} className="h-full w-full border-0 bg-white" />
    : file.contentType.startsWith("image/") ? <Image src={url} alt={file.name} width={1600} height={1200} unoptimized className="max-h-full max-w-full object-contain" />
    : file.contentType.startsWith("video/") ? <video src={url} controls className="max-h-full max-w-full" />
    : file.contentType.startsWith("audio/") ? <audio src={url} controls className="w-full max-w-xl" /> : <div className="text-center"><KnowledgeFileIcon name={file.name} contentType={file.contentType} className="mx-auto mb-4 h-20 w-20" /><p className="text-sm text-neutral-500">A browser preview is not available for this file type.</p></div>;
  return <ReaderShell name={file.name} subtitle={`${venture} · ${(file.size / 1024).toFixed(1)} KB`} onBack={onBack} action={<div className="flex shrink-0 items-center gap-2">{isMarkdown && <MarkdownViewToggle value={markdownView} onChange={setMarkdownView} />}<a href={url} download={file.name} aria-label={`Download ${file.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"><Download size={16} /></a></div>}>{preview}</ReaderShell>;
}

export function LiveKnowledgeScreen() {
  const { activeVentureId: ventureId } = useStudio();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDocumentId = searchParams.get("doc");
  // ?tab=skills&skill=… opens a section (and a skill) directly, as links from Claude do.
  const requestedSection = SECTIONS.find((key) => key === searchParams.get("tab"));
  const requestedSkillId = searchParams.get("skill") ?? undefined;
  const [view, setView] = useState<Section>(requestedSection ?? "library");
  const sectionMotion = useTabMotion(view, SECTIONS);
  const [packetMode, setPacketMode] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "draft" | "approved" | "stale">("");
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [cursor, setCursor] = useState<string | undefined>();
  const [fileCursor, setFileCursor] = useState<string | undefined>();
  const [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<DocumentDetail | null>(null);
  const [missingDocumentId, setMissingDocumentId] = useState<string | null>(null);
  // Set when opening a linked document failed for a reason other than "not found" or "no access".
  const [documentError, setDocumentError] = useState("");
  const [selectedFile, setSelectedFile] = useState<{ file: FileMetadata; url: string } | null>(null);
  const [uploadMode, setUploadMode] = useState<"markdown" | "file" | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The last library load failure. The shared `error` also carries action errors, so the empty-state choice reads this one.
  const [loadError, setLoadError] = useState("");
  const [result, setResult] = useState("");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createVentureId, setCreateVentureId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createMarkdown, setCreateMarkdown] = useState("");
  const [createEvidenceClass, setCreateEvidenceClass] = useState("founder_reported");
  const [createSensitivity, setCreateSensitivity] = useState("team");
  const [createSourceUri, setCreateSourceUri] = useState("");
  const [createSummary, setCreateSummary] = useState("Initial version");
  const [importName, setImportName] = useState("");
  const [createError, setCreateError] = useState("");
  const [packetIds, setPacketIds] = useState<string[]>([]);
  const [packetBusy, setPacketBusy] = useState(false);
  const [packetAction, setPacketAction] = useState<"" | "copy" | "export">("");
  const [packetDone, markPacketDone] = useFlag();
  const [reviewing, setReviewing] = useState("");
  // Approvers: documents waiting to be shared with all ventures and suggested changes; names for who asked.
  const [reviews, setReviews] = useState<Awaited<ReturnType<typeof listLiveKnowledgeReviews>>>({ requests: [], suggestions: [] });
  const [names, setNames] = useState<Record<string, string>>({});
  const [reviewNote, setReviewNote] = useState("");
  const [previewSuggestion, setPreviewSuggestion] = useState("");
  const [searchedQ, setSearchedQ] = useState("");
  // Files dropped anywhere on the library open the upload dialog with them already listed.
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => { queueMicrotask(() => { setSelected(null); setSelectedFile(null); setResults(null); setPacketIds([]); setPacketMode(false); }); }, [ventureId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setLoadingDocuments(true); });
    queueMicrotask(() => Promise.all([loadLiveSession(), listLiveDocuments(undefined, { ...(ventureId ? { ventureId } : {}), ...(status ? { status } : {}) }), listLiveFiles(undefined, ventureId || undefined)]).then(([nextSession, page, filePage]) => {
      if (active) { setSession(nextSession); setDocuments(page.items); setCursor(page.nextCursor); setFiles(filePage.items); setFileCursor(filePage.nextCursor); setLoadingDocuments(false); setError(""); setLoadError(""); }
    }).catch((cause: unknown) => { if (active) { const message = describeError(cause, "Could not load the document library."); setLoadingDocuments(false); setError(message); setLoadError(message); } }));
    return () => { active = false; };
  }, [ventureId, status, revision]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => void listLiveMembers({ limit: 100 }).then((page) => { if (active) setNames(Object.fromEntries(page.items.map((item) => [item.id, item.name]))); }).catch(() => undefined));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => void listLiveKnowledgeReviews().then((value) => { if (active) setReviews(value); }).catch(() => undefined));
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    if (!requestedDocumentId) return;
    let active = true;
    queueMicrotask(() => getLiveDocument(requestedDocumentId).then((detail) => {
      if (active) { setSelected(detail); setSelectedFile(null); setView("library"); setDetailOpen(Boolean(detail.document.review) || detail.suggestions.length > 0); }
    }).catch((cause: unknown) => {
      if (!active) return;
      const code = cause instanceof StudioApiError ? cause.code : undefined;
      setDocumentError(code === "NOT_FOUND" || code === "FORBIDDEN" ? "" : describeError(cause, "Could not open the document."));
      setMissingDocumentId(requestedDocumentId);
    }));
    return () => { active = false; };
  }, [requestedDocumentId]);

  useEffect(() => () => { if (selectedFile?.url) URL.revokeObjectURL(selectedFile.url); }, [selectedFile]);

  async function more() {
    if (!cursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveDocuments(cursor, { ...(ventureId ? { ventureId } : {}), ...(status ? { status } : {}) }); setDocuments((items) => [...items, ...page.items]); setCursor(page.nextCursor); }
    catch (cause) { setError(describeError(cause, "Could not load more documents.")); }
    finally { setBusy(false); }
  }

  async function moreFiles() {
    if (!fileCursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveFiles(fileCursor, ventureId || undefined); setFiles((items) => [...items, ...page.items]); setFileCursor(page.nextCursor); }
    catch (cause) { setError(describeError(cause, "Could not load more files.")); }
    finally { setBusy(false); }
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { setResults(await searchLiveKnowledge(q.trim(), ventureId || undefined)); setSearchedQ(q.trim()); }
    catch (cause) { setError(describeError(cause, "Search failed.")); }
    finally { setBusy(false); }
  }

  async function openDocument(id: string) {
    setBusy(true); setError(""); setResult("");
    try { setSelected(await getLiveDocument(id)); setSelectedFile(null); setDetailOpen(false); }
    catch (cause) { setError(describeError(cause, "Could not open the document.")); }
    finally { setBusy(false); }
  }

  async function openFile(file: FileMetadata) {
    setBusy(true); setError(""); setResult("");
    try { const url = await prepareLiveFileDownload(file.id, file.contentType); setSelected(null); setSelectedFile({ file, url }); }
    catch (cause) { setError(describeError(cause, "Could not open the file.")); }
    finally { setBusy(false); }
  }

  async function reviewDocument(status: "approved" | "stale") {
    if (!selected) return;
    setBusy(true); setReviewing(status); setError(""); setResult("");
    try {
      await updateLiveDocumentMetadata(selected.document.id, { status, ...(status === "approved" ? { lastReviewedAt: new Date().toISOString() } : {}) });
      setSelected(await getLiveDocument(selected.document.id)); setRevision((value) => value + 1);
      setResult(status === "approved" ? "The current document version was approved and audited." : "The document was marked stale and audited.");
    } catch (cause) { setError(describeError(cause, "Could not update document review status.")); }
    finally { setBusy(false); setReviewing(""); }
  }

  async function decideRequest(decision: "approve" | "decline" | "withdraw") {
    if (!selected) return;
    setBusy(true); setReviewing(decision); setError(""); setResult("");
    try {
      await reviewLiveDocumentRequest(selected.document.id, decision, reviewNote.trim() || undefined, selected.version.id);
      setReviewNote(""); setRevision((value) => value + 1);
      if (decision === "withdraw") { setResult(""); closeDocument(); return; }
      setSelected(await getLiveDocument(selected.document.id));
      setResult(decision === "approve" ? "Approved: every venture can see this document now." : "Declined. The author was told and can edit it and send it again.");
    } catch (cause) { setError(describeError(cause, "Could not save the review.")); }
    finally { setBusy(false); setReviewing(""); }
  }

  async function decideSuggestion(suggestionId: string, decision: "approve" | "decline") {
    if (!selected) return;
    setBusy(true); setReviewing(`${decision}:${suggestionId}`); setError(""); setResult("");
    try {
      await reviewLiveSuggestion(selected.document.id, suggestionId, decision, reviewNote.trim() || undefined);
      setReviewNote(""); setPreviewSuggestion(""); setRevision((value) => value + 1);
      setSelected(await getLiveDocument(selected.document.id));
      setResult(decision === "approve" ? "Accepted: the suggested change is the live version now." : "Declined. The person who suggested it was told.");
    } catch (cause) { setError(describeError(cause, "Could not save the review.")); }
    finally { setBusy(false); setReviewing(""); }
  }

  const role = session?.membership.role ?? "";
  const writer = role === "venture_head" || role === "contributor";
  // Admins, and writers allowed to share with all ventures, publish there directly and approve others' requests.
  const sharer = role === "admin" || (writer && session?.membership.canShareKnowledge === true);
  const me = session?.user.id;
  // Anyone who writes knowledge may edit a workspace-wide document: without the permission, their edit is a suggestion.
  const canEditDocument = (document: DocumentMetadata) => role === "admin" || (writer && (document.ventureId ? !!session?.membership.ventureIds.includes(document.ventureId) : !document.review || document.ownerId === me || sharer));
  const canEdit = !!selected && canEditDocument(selected.document);
  const canApprove = !!selected && !selected.document.review && (selected.document.ventureId ? role === "admin" || (role === "venture_head" && !!session?.membership.ventureIds.includes(selected.document.ventureId)) : sharer);
  const docStatus = (document: DocumentMetadata) => document.review ? (document.review.state === "pending" ? "Waiting for approval" : "Not approved")
    : `Record · ${document.status}${sharer && document.pendingSuggestions ? ` · ${document.pendingSuggestions} suggested change${document.pendingSuggestions === 1 ? "" : "s"}` : ""}`;
  const nameOf = (id: string) => id === me ? "You" : names[id] ?? "Someone";
  const ventureName = (id?: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? "Workspace";
  const canCreate = session?.membership.role === "admin" || ((session?.membership.role === "venture_head" || session?.membership.role === "contributor") && session.hierarchy.ventures.length > 0);
  const lockedCreateScope = Boolean(ventureId);
  const createRequest = !sharer && !lockedCreateScope && createVentureId === "";
  const libraryItems = [
    ...documents.map((item) => ({ kind: "document" as const, item, date: item.updatedAt })),
    ...files.map((item) => ({ kind: "file" as const, item, date: item.createdAt })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  function startCreate() {
    setCreateVentureId(ventureId);
    setCreateTitle(""); setCreateMarkdown(""); setCreateEvidenceClass("founder_reported"); setCreateSensitivity("team");
    setCreateSourceUri(""); setCreateSummary("Initial version"); setImportName(""); setCreateError(""); setCreating(true);
  }

  async function importMarkdown(file?: File) {
    if (!file) return;
    if (!/\.(md|markdown|txt)$/i.test(file.name) || file.size > 2_000_000 || file.size === 0) { setCreateError("Choose a nonempty .md or .txt file up to 2 MB."); return; }
    try {
      const text = await file.text();
      if (!text.trim() || text.length > 2_000_000) throw new Error("The file must contain Markdown text under 2 million characters.");
      setCreateMarkdown(text); setImportName(file.name); setCreateError("");
      if (!createTitle.trim()) setCreateTitle(file.name.replace(/\.(md|markdown|txt)$/i, ""));
    } catch (cause) { setCreateError(describeError(cause, "Could not read the file.")); }
  }

  async function createDocument(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !canCreate || (session.membership.role !== "admin" && createVentureId && !session.membership.ventureIds.includes(createVentureId)) || (lockedCreateScope && createVentureId !== ventureId)) { setCreateError("The selected destination is unavailable."); return; }
    setBusy(true); setCreateError("");
    try {
      const created = await createLiveDocument({ ...(createVentureId ? { ventureId: createVentureId } : {}), title: createTitle, markdown: createMarkdown, evidenceClass: createEvidenceClass, sensitivity: createSensitivity, sourceUri: createSourceUri || undefined, changeSummary: createSummary });
      if ((created.ventureId ?? "") !== createVentureId) throw new Error("The document was created in an unexpected destination.");
      const detail = await getLiveDocument(created.id).catch(() => null);
      setCreating(false); setStatus(""); setRevision((value) => value + 1);
      if (detail) { setSelected(detail); setDetailOpen(true); }
      setResult(created.review ? "Sent for approval. Only you and the approvers can see it until it's approved; you'll be told when it is." : detail ? "Document created as a draft. Approval is a separate review action." : "Document created as a draft. Refresh the library to open it.");
    } catch (cause) { setCreateError(describeError(cause, "Could not create the document.")); }
    finally { setBusy(false); }
  }

  function closeDocument() {
    setSelected(null); setDetailOpen(false);
    if (requestedDocumentId) router.replace("/knowledge/live");
  }

  async function preparePacket() {
    if (packetIds.length === 0) return;
    setPacketBusy(true); setError(""); setResult("");
    try {
      const details = await Promise.all(packetIds.map((id) => getLiveDocument(id)));
      if (details.some((item) => item.document.status !== "approved")) throw new Error("One selected record is no longer approved. Refresh the library and select approved records again.");
      const text = details.map((item) => `## ${item.document.title}\nRecord: ${item.document.id} · Version: ${item.version.version}\nEvidence: ${item.document.evidenceClass.replaceAll("_", " ")} · Sensitivity: ${item.document.sensitivity.replaceAll("_", " ")}\nSource: ${item.version.sourceUri || "Not recorded"}\n\n${item.version.markdown}`).join("\n\n---\n\n");
      return text;
    } catch (cause) { setError(describeError(cause, "Could not prepare the context packet.")); return null; }
    finally { setPacketBusy(false); }
  }

  async function copyPacket() {
    setPacketAction("copy");
    const text = await preparePacket();
    setPacketAction("");
    if (!text) return;
    try { await navigator.clipboard.writeText(text); markPacketDone("copy"); }
    catch { setError("Clipboard access failed. Try the Markdown export instead."); }
  }

  async function exportPacket() {
    setPacketAction("export");
    const text = await preparePacket();
    setPacketAction("");
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "venture-studio-context-packet.md"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    markPacketDone("export");
  }

  if (selectedFile) return <FileReader file={selectedFile.file} url={selectedFile.url} venture={ventureName(selectedFile.file.ventureId)} onBack={() => setSelectedFile(null)} />;

  const dropEnabled = !!session && canCreate && !selected && !uploadMode && view === "library";
  const firstLoad = loadingDocuments && !libraryItems.length;
  // A failed load shows the error, never "nothing yet". With nothing to show and no status filter the library is genuinely empty (first run);
  // with a status filter the filtered variant lets the person clear it.
  const libraryFailed = !!loadError && !libraryItems.length && !loadingDocuments;
  const libraryEmpty = !firstLoad && !libraryFailed && !libraryItems.length;
  const libraryErrorShown = view === "library" && libraryFailed;
  const quoted = (value: string) => value.length > 40 ? `${value.slice(0, 40)}…` : value;
  const isFileDrag = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
  return <div className={selected ? "min-w-0 w-full" : "relative mx-auto min-w-0 w-full max-w-[1580px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6"}
    onDragEnter={(event) => { if (!dropEnabled || !isFileDrag(event)) return; event.preventDefault(); dragDepth.current += 1; setDropActive(true); }}
    onDragOver={(event) => { if (!dropEnabled || !isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={() => { if (!dropActive) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropActive(false); }}
    onDrop={(event) => { if (!dropEnabled || !isFileDrag(event)) return; event.preventDefault(); dragDepth.current = 0; setDropActive(false); const dropped = Array.from(event.dataTransfer.files); if (dropped.length) { setDroppedFiles(dropped); setUploadMode("file"); } }}>
    {dropActive && <div aria-hidden="true" className="vso-backdrop pointer-events-none fixed inset-0 z-40 grid place-items-center bg-primary-900/10 p-6 backdrop-blur-[2px]"><div className="vso-enter-modal rounded-2xl border-2 border-dashed border-primary-500 bg-white px-8 py-7 text-center shadow-e4"><p className="text-base font-bold text-neutral-900">Drop files to upload</p><p className="mt-1 text-sm text-neutral-500">They go to {ventureId ? ventureName(ventureId) : "a venture you choose next"}. Markdown and text become draft records.</p></div></div>}
    {!selected && <PageTitle title="Knowledge" description="Browse records and files in one library." action={<HeaderActions><RefreshButton busy={loadingDocuments && !!session} onClick={() => setRevision((value) => value + 1)} />{canCreate && view === "library" && <><button type="button" onClick={() => setUploadMode("file")} className={secondaryClass}><Upload size={15} /><HeaderLabel>Upload file</HeaderLabel></button><button type="button" onClick={startCreate} className={primaryClass}><Plus size={15} />New record</button></>}</HeaderActions>} />}
    {!selected && <><Notice tone="error" message={libraryErrorShown && error === loadError ? "" : error} onDismiss={() => setError("")} className="pb-4" /><Notice tone="success" message={result} onDismiss={() => setResult("")} autoDismissMs={5000} className="pb-4" /></>}
    {requestedDocumentId && missingDocumentId === requestedDocumentId && !selected && <Panel className="mb-4"><EmptyState variant="error" icon={FileQuestion} title={documentError ? "Couldn't open this document" : "This document is not available"} body={documentError || "It may have been removed, or you may not have access to it."} action={{ label: "Back to library", icon: ArrowLeft, onClick: () => router.replace("/knowledge/live") }} /></Panel>}
    {requestedDocumentId && !selected && missingDocumentId !== requestedDocumentId ? <Panel><SkeletonRows rows={5} label="Opening document" /></Panel> : selected ? <DocumentReader key={selected.document.id} detail={selected} venture={ventureName(selected.document.ventureId)} onBack={closeDocument} onDetails={() => setDetailOpen(true)} onEdit={canEdit ? () => router.push(`/knowledge/live/edit/${encodeURIComponent(selected.document.id)}`) : undefined} /> : <>
      <SlidingTabs fitContent label="Knowledge sections" className="mb-4 bg-neutral-100 shadow-none" active={view} onChange={(key) => setView(key as Section)} tabs={SECTION_TABS} />
      {session && view === "context" && <div key="context" className={sectionMotion.className} style={sectionMotion.style}><VentureContextPanel session={session} ventureId={ventureId} nameOf={nameOf} /></div>}
      {session && view === "skills" && <div key="skills" className={sectionMotion.className} style={sectionMotion.style}><SkillsPanel session={session} ventureId={ventureId} nameOf={nameOf} initialSkillId={requestedSkillId} /></div>}
      {view === "tasks" && <div key="tasks" className={sectionMotion.className} style={sectionMotion.style}><TaskFilesPanel ventureId={ventureId} nameOf={nameOf} /></div>}
      {session && view === "chats" && <div key="chats" className={sectionMotion.className} style={sectionMotion.style}><ChatFilesPanel session={session} ventureId={ventureId} nameOf={nameOf} /></div>}
      {view === "library" && <div key="library" className={sectionMotion.className} style={sectionMotion.style}>{libraryEmpty && !status ? <EmptyState variant="page" icon={BookOpenText} tone="violet" title="Your library is empty"
        body={canCreate ? "Add a record, or drop files anywhere on this page to upload them." : "Records and files shared with you will appear here."}
        action={canCreate ? { label: "New record", icon: Plus, onClick: startCreate } : undefined}
        secondary={canCreate ? { label: "Upload files", icon: Upload, onClick: () => setUploadMode("file") } : undefined} /> : <><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div className="w-full max-w-xs flex-1"><Field label="Record status"><Select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="">All visible statuses</option><option value="draft">Draft</option><option value="approved">Approved</option><option value="stale">Stale</option></Select></Field></div><button type="button" onClick={() => { setPacketMode((value) => !value); setPacketIds([]); }} className={secondaryClass}>{packetMode ? "Done selecting" : "Create context packet"}</button></div>
        <div data-open={packetMode} className="vso-collapse"><div><div className="pb-4"><Panel className="flex flex-wrap items-center justify-between gap-3 border-primary-200 bg-primary-50 p-4"><p className="text-sm text-neutral-700"><span className="font-semibold"><span key={packetIds.length} className="vso-label-swap inline-block tnum">{packetIds.length}</span> approved record{packetIds.length === 1 ? "" : "s"} selected.</span> Click thumbnails to choose them, then copy or export the authorized Markdown.</p><div className="flex gap-2"><button type="button" disabled={!packetIds.length || packetBusy} onClick={() => void copyPacket()} className={secondaryClass}><ActionLabel busy={packetBusy && packetAction === "copy"} done={packetDone === "copy"} busyText="Preparing…" doneText="Copied" idle={<><Copy size={15} />Copy packet</>} /></button><button type="button" disabled={!packetIds.length || packetBusy} onClick={() => void exportPacket()} className={secondaryClass}><ActionLabel busy={packetBusy && packetAction === "export"} done={packetDone === "export"} busyText="Preparing…" doneText="Exported" idle={<><Download size={15} />Export</>} /></button></div></Panel></div></div></div>
        {sharer && (reviews.requests.length > 0 || reviews.suggestions.length > 0) && <Panel className="vso-fade-enter mb-4 p-4 sm:p-5"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-neutral-900">Waiting for your approval</h2><Badge tone="amber">{reviews.requests.length + reviews.suggestions.length}</Badge></div><ul className="divide-y divide-neutral-100">
          {reviews.requests.map((item) => <li key={item.id}><button type="button" onClick={() => void openDocument(item.id).then(() => setDetailOpen(true))} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left transition-colors duration-150 hover:bg-neutral-50"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-neutral-800">{item.title}</span><span className="block text-xs text-neutral-500">{nameOf(item.review?.requestedBy ?? item.ownerId)} asked to share it with all ventures</span></span><span className="shrink-0 text-xs font-semibold text-primary-700">Review</span></button></li>)}
          {reviews.suggestions.map((item) => <li key={item.id}><button type="button" onClick={() => void openDocument(item.documentId).then(() => setDetailOpen(true))} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left transition-colors duration-150 hover:bg-neutral-50"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-neutral-800">{item.documentTitle}</span><span className="block truncate text-xs text-neutral-500">{nameOf(item.proposedBy)} suggested a change: {item.changeSummary}</span></span><span className="shrink-0 text-xs font-semibold text-primary-700">Review</span></button></li>)}
        </ul></Panel>}
        <Panel className="p-4 sm:p-5"><div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-neutral-900">Library</h2><span className="text-xs text-neutral-500">{firstLoad ? "Loading…" : `${documents.length} records · ${files.length} files`}</span></div>{firstLoad ? <div role="status" aria-label="Loading the library" className="grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index}><span className="vso-skeleton aspect-[4/3] w-full rounded-xl" /><span className="vso-skeleton mt-2.5 h-3.5 w-3/4" /><span className="vso-skeleton mt-1.5 h-2.5 w-1/2" /></div>)}</div> : libraryItems.length ? <div aria-busy={loadingDocuments || undefined} className={clsx("vso-stagger-in grid grid-cols-2 gap-x-4 gap-y-6 transition-opacity duration-200 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", loadingDocuments && "opacity-60")}>{libraryItems.map((entry) => entry.kind === "document" ? <KnowledgeDocumentTile key={`document-${entry.item.id}`} title={entry.item.title} venture={ventureName(entry.item.ventureId)} status={docStatus(entry.item)} updatedAt={stamp(entry.item.updatedAt)} onOpen={() => void openDocument(entry.item.id)} onEdit={!packetMode && canEditDocument(entry.item) ? () => router.push(`/knowledge/live/edit/${encodeURIComponent(entry.item.id)}`) : undefined} selected={packetIds.includes(entry.item.id)} onSelect={packetMode && entry.item.status === "approved" ? (checked) => setPacketIds((ids) => checked ? [...ids, entry.item.id] : ids.filter((id) => id !== entry.item.id)) : undefined} unavailable={packetMode && entry.item.status !== "approved" ? "Only approved records can go into a context packet" : undefined} /> : <KnowledgeDocumentTile key={`file-${entry.item.id}`} unavailable={packetMode ? "Files cannot go into a context packet" : undefined} fileId={entry.item.id} title={entry.item.name} fileName={entry.item.name} contentType={entry.item.contentType} venture={ventureName(entry.item.ventureId)} status="File" updatedAt={stamp(entry.item.createdAt)} onOpen={() => void openFile(entry.item)} />)}</div> : libraryFailed ? <EmptyState variant="error" title="Could not load the library" body={loadError} action={{ label: "Try again", onClick: () => { setError(""); setRevision((value) => value + 1); } }} />
        : <EmptyState variant="filtered" title={`No ${status} records`} body="Files are always shown. Clear the filter to see records with every status." action={{ label: "Clear filters", onClick: () => setStatus("") }} />}{(cursor || fileCursor) && <div className="mt-6 flex flex-wrap gap-3">{cursor && <button type="button" disabled={busy} onClick={more} className={clsx(secondaryClass, "!min-h-9 !text-xs")}>{busy ? "Loading…" : "Load more records"}</button>}{fileCursor && <button type="button" disabled={busy} onClick={() => void moreFiles()} className={clsx(secondaryClass, "!min-h-9 !text-xs")}>{busy ? "Loading…" : "Load more files"}</button>}</div>}</Panel></>}
      </div>}
      {view === "search" && <div key="search" className={sectionMotion.className} style={sectionMotion.style}><Panel><PanelHead title="Evidence search" /><form onSubmit={search} className="flex flex-wrap gap-2 border-b border-neutral-100 p-4"><label className="relative min-w-48 flex-1"><span className="sr-only">Search knowledge</span><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input required minLength={2} maxLength={200} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search approved evidence" className={`${inputClass} pl-9`} /></label><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} busyText="Searching…" idle="Search" /></button></form>{!results ? <EmptyState variant="card" icon={Search} tone="violet" title="Find a verified source" body="Enter at least two characters to search approved evidence." /> : results.items.length ? <div key={searchedQ} className="vso-stagger-in divide-y divide-neutral-100">{results.items.map((item, index) => <button key={`${item.documentId}-${item.versionId}-${index}`} type="button" onClick={() => void openDocument(item.documentId)} className="w-full px-5 py-4 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:bg-neutral-100"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-neutral-800">{item.title}</span><Badge tone="purple">{item.evidenceClass.replaceAll("_", " ")}</Badge></span><span className="mt-2 line-clamp-3 block whitespace-pre-wrap text-sm leading-6 text-neutral-600">{highlight(item.excerpt, searchedQ)}</span><span className="mt-2 block break-all font-mono text-[10px] text-neutral-400">{item.sourceRef}</span></button>)}</div> : <EmptyState variant="filtered" title={`No evidence matches “${quoted(searchedQ)}”`} body={results.warnings[0] ?? "Only approved evidence you can access is searched. Try different words."} action={{ label: "Clear search", onClick: () => { setQ(""); setResults(null); setSearchedQ(""); } }} />}</Panel></div>}
    </>}
    {selected && detailOpen && <DetailDrawer title={selected.document.title} subtitle={`${ventureName(selected.document.ventureId)} · version ${selected.version.version}`} onClose={() => setDetailOpen(false)}>
      <div className="mb-3 flex flex-wrap items-center gap-2"><Badge tone="purple">{selected.document.evidenceClass.replaceAll("_", " ")}</Badge><Badge>{selected.document.sensitivity.replaceAll("_", " ")}</Badge>{selected.document.review ? <Badge tone={selected.document.review.state === "pending" ? "amber" : "red"}>{selected.document.review.state === "pending" ? "waiting for approval" : "not approved"}</Badge> : <Badge tone={selected.document.status === "approved" ? "green" : "amber"}>{selected.document.status}</Badge>}</div>
      <p className="text-xs text-neutral-500">Last changed {stamp(selected.version.createdAt)} · Document {selected.document.id}</p>
      <p className="mt-2 text-xs text-neutral-500">{selected.versions.length} version{selected.versions.length === 1 ? "" : "s"} recorded. Only the current version can be opened here.</p>
      <Notice tone="error" message={error} onDismiss={() => setError("")} className="pt-3" />
      <Notice tone="success" message={result} onDismiss={() => setResult("")} autoDismissMs={5000} className="pt-3" />
      {selected.document.review && <div className="mt-4 space-y-3 rounded-xl bg-neutral-50 p-4">
        {selected.document.review.state === "pending"
          ? <p className="text-sm leading-6 text-neutral-700"><strong className="font-semibold">{nameOf(selected.document.review.requestedBy)}</strong> asked to share this with all ventures. Until it&apos;s approved, only {selected.document.review.requestedBy === me ? "you" : "they"} and the approvers can see it.</p>
          : <p className="text-sm leading-6 text-neutral-700">Not approved{selected.document.review.decidedBy ? ` by ${nameOf(selected.document.review.decidedBy)}` : ""}{selected.document.review.note ? `: “${selected.document.review.note}”` : "."} {selected.document.ownerId === me ? "Edit it and save to send it again." : ""}</p>}
        {sharer && selected.document.review.state === "pending" && selected.document.review.requestedBy !== me && <>
          <Field label="Note to the author (optional)"><textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={1000} rows={2} className={inputClass} placeholder="Why, or what to change" /></Field>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void decideRequest("approve")} className={primaryClass}><ActionLabel busy={reviewing === "approve"} busyText="Approving…" idle="Approve and share" /></button><button type="button" disabled={busy} onClick={() => void decideRequest("decline")} className={secondaryClass}><ActionLabel busy={reviewing === "decline"} busyText="Declining…" idle="Decline" /></button></div>
        </>}
        {selected.document.ownerId === me && <button type="button" disabled={busy} onClick={() => void decideRequest("withdraw")} className={secondaryClass}><ActionLabel busy={reviewing === "withdraw"} busyText="Withdrawing…" idle="Withdraw request" /></button>}
      </div>}
      {selected.suggestions.length > 0 && <div className="mt-4 space-y-3"><p className="text-xs font-semibold uppercase tracking-[.08em] text-neutral-400">{sharer ? "Suggested changes" : "Your suggested changes"}</p>
        {selected.suggestions.map((item) => <div key={item.id} className="space-y-2 rounded-xl border border-neutral-100 p-3">
          <p className="text-sm text-neutral-800"><strong className="font-semibold">{nameOf(item.proposedBy)}</strong>: {item.changeSummary}</p>
          <p className="text-xs text-neutral-500">{stamp(item.createdAt)}{item.state === "declined" ? ` · not accepted${item.note ? `: “${item.note}”` : ""}` : item.state === "pending" ? " · waiting for approval" : ""}{item.baseVersionId !== selected.version.id && item.state === "pending" ? " · written on an older version" : ""}</p>
          {item.markdown && <button type="button" onClick={() => setPreviewSuggestion((current) => current === item.id ? "" : item.id)} className="text-xs font-semibold text-primary-700">{previewSuggestion === item.id ? "Hide the suggested text" : "Show the suggested text"}</button>}
          {previewSuggestion === item.id && item.markdown && <div className="max-h-80 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-sm"><MarkdownBody markdown={item.markdown} view="rendered" /></div>}
          {sharer && item.state === "pending" && item.proposedBy !== me && <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || item.baseVersionId !== selected.version.id} title={item.baseVersionId !== selected.version.id ? "The document changed after this was suggested; accepting it would undo those changes" : undefined} onClick={() => void decideSuggestion(item.id, "approve")} className={clsx(primaryClass, "!min-h-9 !text-xs")}><ActionLabel busy={reviewing === `approve:${item.id}`} busyText="Accepting…" idle="Accept change" /></button><button type="button" disabled={busy} onClick={() => void decideSuggestion(item.id, "decline")} className={clsx(secondaryClass, "!min-h-9 !text-xs")}><ActionLabel busy={reviewing === `decline:${item.id}`} busyText="Declining…" idle="Decline" /></button></div>}
        </div>)}
        {sharer && selected.suggestions.some((item) => item.state === "pending" && item.proposedBy !== me) && !selected.document.review && <Field label="Note to the person who suggested it (optional)"><textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} maxLength={1000} rows={2} className={inputClass} placeholder="Why, or what to change" /></Field>}
      </div>}
      {canApprove && <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={busy || selected.document.status === "approved"} onClick={() => reviewDocument("approved")} className={primaryClass}><ActionLabel busy={reviewing === "approved"} busyText="Approving…" idle="Approve current version" /></button><button type="button" disabled={busy || selected.document.status !== "approved"} title={selected.document.status === "approved" ? undefined : "Only an approved record can be marked stale"} onClick={() => reviewDocument("stale")} className={secondaryClass}><ActionLabel busy={reviewing === "stale"} idle="Mark stale" /></button></div>}
      {canEdit && <button type="button" onClick={() => router.push(`/knowledge/live/edit/${encodeURIComponent(selected.document.id)}`)} className={`${secondaryClass} mt-4`}><Edit size={15} />Open editor</button>}
    </DetailDrawer>}
    {creating && <DetailDrawer title="New knowledge document" subtitle="Create a draft in the selected destination" dirty={Boolean(createTitle.trim() || createMarkdown.trim()) && !busy} onClose={() => setCreating(false)}>
      <form onSubmit={createDocument} className="space-y-4">
        {lockedCreateScope ? <div aria-label="Document destination" className="rounded-xl bg-neutral-50 p-3 text-sm"><span className="block text-xs font-semibold text-neutral-500">Destination</span><span className="font-bold text-neutral-800">{ventureName(ventureId)}</span></div> : <Field label="Destination"><Select className={inputClass} value={createVentureId} onChange={(event) => setCreateVentureId(event.target.value)}>{sharer ? <option value="">Workspace</option> : <option value="">Workspace (needs approval)</option>}{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>}
        <Field label="Title"><input required maxLength={200} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} className={inputClass} placeholder="What should this source be called?" /></Field>
        <Field label="Markdown"><textarea required maxLength={2_000_000} value={createMarkdown} onChange={(event) => setCreateMarkdown(event.target.value)} className={`${inputClass} min-h-56 py-3 font-mono`} placeholder="# Heading&#10;&#10;Write or paste the source content…" /></Field>
        <label className="block text-xs font-semibold text-neutral-600">Import Markdown or text file<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(event) => { void importMarkdown(event.target.files?.[0]); event.target.value = ""; }} className="mt-2 block w-full min-w-0 text-xs text-neutral-600 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-2 file:font-bold" /></label>
        {importName && <p key={importName} className="vso-fade-enter text-xs text-neutral-500">Loaded {importName} into the editor. It is saved only when you create the document.</p>}
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Evidence class"><Select className={inputClass} value={createEvidenceClass} onChange={(event) => setCreateEvidenceClass(event.target.value)}>{["verified_fact", "founder_reported", "approved_decision", "planning_assumption", "hypothesis", "open_question", "historical"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</Select></Field><Field label="Sensitivity"><Select className={inputClass} value={createSensitivity} onChange={(event) => setCreateSensitivity(event.target.value)}>{["team", "venture_restricted", ...(session?.membership.role === "admin" || session?.membership.role === "venture_head" ? ["manager"] : []), ...(session?.membership.role === "admin" ? ["founder_private"] : [])].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</Select></Field></div>
        <Field label="Source URL, optional"><input type="url" value={createSourceUri} onChange={(event) => setCreateSourceUri(event.target.value)} className={inputClass} placeholder="https://…" /></Field>
        <Field label="Change summary"><input required maxLength={500} value={createSummary} onChange={(event) => setCreateSummary(event.target.value)} className={inputClass} /></Field>
        <p className="text-xs leading-5 text-neutral-500">The source URL records provenance; it does not fetch or import the webpage. {createRequest ? "An approver reviews it first; once they approve it, every venture sees it." : "New documents start as drafts and are not in approved evidence search."}</p>
        <Notice tone="error" message={createError} onDismiss={() => setCreateError("")} />
        <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}>{busy ? (createRequest ? "Sending…" : "Creating…") : createRequest ? "Send for approval" : "Create draft document"}</button><button type="button" onClick={() => setCreating(false)} className={secondaryClass}>Cancel</button></div>
      </form>
    </DetailDrawer>}
    {uploadMode && session && <KnowledgeUploadDialog mode={uploadMode} session={session} activeVentureId={ventureId} initialFiles={droppedFiles} onClose={() => { setUploadMode(null); setDroppedFiles([]); }} onComplete={({ failed }) => { setRevision((value) => value + 1); setResult(failed ? `Some files uploaded; ${failed} ${failed === 1 ? "file" : "files"} failed. Check the upload list for details.` : "Upload complete. Markdown and text become draft records; other files stay private to their venture."); }} />}
  </div>;
}
