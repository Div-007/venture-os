/* eslint-disable @next/next/no-img-element -- Blob URLs are fetched on demand and cannot use Next image optimization. */
"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useBoardMotion } from "@/components/ui/use-board-motion";
import { useRouter } from "next/navigation";
import { Notice, RefreshButton } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { replayAnimation } from "@/lib/motion";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, ArrowUpRight, BookOpenText, ChevronLeft, ChevronRight, Download, Eye, FileText, FolderOpen, Kanban, Layers3, Paperclip, Pin, Plus, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { KnowledgeDocumentTile } from "@/components/studio/knowledge-document-tile";
import { useMentionNames, withMentionNames } from "@/lib/mention-names";
import Link from "next/link";
import type { Message, Task } from "@venture-studio/contracts";
import { getLiveDocument, listLiveDocuments, listLiveGroupFiles, listLiveGroupSavedMessages, listLiveTasks, prepareLiveFileDownload, updateLiveMessageSave, updateLiveTask, uploadLiveFile } from "@/lib/studio-api";

export type WorkspaceTab = "kanban" | "attachments" | "saved" | "knowledge";
type FileItem = Awaited<ReturnType<typeof listLiveGroupFiles>>["items"][number];
type SavedItem = Awaited<ReturnType<typeof listLiveGroupSavedMessages>>["items"][number];
type DocumentItem = Awaited<ReturnType<typeof listLiveDocuments>>["items"][number];
type DocumentDetail = Awaited<ReturnType<typeof getLiveDocument>>;
type Page<T> = { scope: string; items: T[]; cursor?: string; loading: boolean; error: string };
type Group = { id: string; name: string; channels: { id: string; name: string }[] };

const statuses: Task["status"][] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
const tabs: WorkspaceTab[] = ["kanban", "attachments", "saved", "knowledge"];
const label = (value: string) => value.replaceAll("_", " ");
const errorText = (cause: unknown) => describeError(cause, "The request failed. Please try again.");
const mediaAccept = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/ogg,audio/webm,audio/wav";
const emptyPage = <T,>(): Page<T> => ({ scope: "", items: [], loading: false, error: "" });
/** Columns with work come first; the order is fixed when the board loads so columns never jump while cards move. */
const columnOrderFor = (items: Task[]) => [...statuses.filter((status) => items.some((task) => task.status === status)), ...statuses.filter((status) => !items.some((task) => task.status === status))];
/** Refetching a list keeps what is already shown (stale-while-revalidate) instead of blanking it. */
const revalidate = <T,>(scope: string) => (page: Page<T>): Page<T> => page.scope === scope ? { ...page, loading: true, error: "" } : { scope, items: [], loading: true, error: "" };
const Spinner = ({ size = 14 }: { size?: number }) => <span aria-hidden="true" className="vso-spinner" style={{ width: size, height: size }} />;

export function GroupWorkspaceSheet({ tab, onTabChange, onClose, ventureId, ventureName, group, userId, role, onSavedChange, onOpenMessage }: {
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onClose: () => void;
  ventureId: string;
  ventureName: string;
  group?: Group;
  userId: string;
  role: string;
  onSavedChange: (message: Message) => void;
  onOpenMessage?: (message: { id: string; channelId: string }) => void;
}) {
  const router = useRouter();
  const tabMotion = useTabMotion(tab, tabs);
  const mentionNames = useMentionNames();
  const groupId = group?.id ?? "";
  const [tasks, setTasks] = useState<Page<Task>>(emptyPage);
  const [files, setFiles] = useState<Page<FileItem>>(emptyPage);
  const [saved, setSaved] = useState<Page<SavedItem>>(emptyPage);
  const [knowledge, setKnowledge] = useState<Page<DocumentItem>>(emptyPage);
  const [knowledgeDetail, setKnowledgeDetail] = useState<{ scope: string; value: DocumentDetail } | null>(null);
  const [taskRevision, setTaskRevision] = useState(0);
  const [fileRevision, setFileRevision] = useState(0);
  const [savedRevision, setSavedRevision] = useState(0);
  const [knowledgeRevision, setKnowledgeRevision] = useState(0);
  const [busyTaskId, setBusyTaskId] = useState("");
  const [pendingTasks, setPendingTasks] = useState<Set<string>>(new Set());
  const [columnOrder, setColumnOrder] = useState<Task["status"][]>(statuses);
  const [leavingSaved, setLeavingSaved] = useState<Set<string>>(new Set());
  const [busyFileId, setBusyFileId] = useState("");
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const uploading = Boolean(uploadProgress);
  const [busySavedId, setBusySavedId] = useState("");
  const [busyKnowledgeId, setBusyKnowledgeId] = useState("");
  const [actionError, setActionError] = useState("");
  const [preview, setPreview] = useState<{ file: FileItem; url: string; groupId: string } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const previewUrlRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);
  const previewReturnRef = useRef<HTMLElement | null>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => { previewRequestRef.current++; if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); }, []);
  useEffect(() => { queueMicrotask(() => closePreview(false)); }, [groupId]);
  // Focus moves into the preview when it opens, not on every step between files.
  const previewOpen = Boolean(preview);
  useEffect(() => { if (previewOpen) previewCloseRef.current?.focus(); }, [previewOpen]);

  useEffect(() => {
    if (tab !== "kanban" || !groupId || !ventureId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setTasks(revalidate<Task>(groupId));
      listLiveTasks(undefined, { ventureId, groupId }).then((page) => {
        if (!active) return;
        if (page.items.some((task) => task.groupId !== groupId || task.ventureId !== ventureId)) throw new Error("The task response included an item outside this group.");
        setColumnOrder(columnOrderFor(page.items));
        setTasks({ scope: groupId, items: page.items, cursor: page.nextCursor, loading: false, error: "" });
      }).catch((cause: unknown) => { if (active) setTasks({ scope: groupId, items: [], loading: false, error: errorText(cause) }); });
    });
    return () => { active = false; };
  }, [tab, groupId, ventureId, taskRevision]);

  useEffect(() => {
    if (tab !== "attachments" || !groupId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setFiles(revalidate<FileItem>(groupId));
      listLiveGroupFiles(groupId).then((page) => {
        if (active) setFiles({ scope: groupId, items: page.items, cursor: page.nextCursor, loading: false, error: "" });
      }).catch((cause: unknown) => { if (active) setFiles({ scope: groupId, items: [], loading: false, error: errorText(cause) }); });
    });
    return () => { active = false; };
  }, [tab, groupId, fileRevision]);

  useEffect(() => {
    if (tab !== "saved" || !groupId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSaved(revalidate<SavedItem>(groupId));
      listLiveGroupSavedMessages(groupId).then((page) => { if (active) setSaved({ scope: groupId, items: page.items, cursor: page.nextCursor, loading: false, error: "" }); })
        .catch((cause: unknown) => { if (active) setSaved({ scope: groupId, items: [], loading: false, error: errorText(cause) }); });
    });
    return () => { active = false; };
  }, [tab, groupId, savedRevision]);

  useEffect(() => {
    if (tab !== "knowledge" || !ventureId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setKnowledge(revalidate<DocumentItem>(ventureId));
      listLiveDocuments(undefined, { ventureId }).then((page) => {
        if (!active) return;
        if (page.items.some((document) => document.ventureId && document.ventureId !== ventureId)) throw new Error("The knowledge response included another venture.");
        setKnowledge({ scope: ventureId, items: page.items, cursor: page.nextCursor, loading: false, error: "" });
      }).catch((cause: unknown) => { if (active) setKnowledge({ scope: ventureId, items: [], loading: false, error: errorText(cause) }); });
    });
    return () => { active = false; };
  }, [tab, ventureId, knowledgeRevision]);

  const currentTasks = tasks.scope === groupId ? tasks : { ...emptyPage<Task>(), loading: Boolean(groupId) };
  const currentFiles = files.scope === groupId ? files : { ...emptyPage<FileItem>(), loading: Boolean(groupId) };
  const currentSaved = saved.scope === groupId ? saved : { ...emptyPage<SavedItem>(), loading: Boolean(groupId) };
  const currentKnowledge = knowledge.scope === ventureId ? knowledge : { ...emptyPage<DocumentItem>(), loading: Boolean(ventureId) };
  const currentKnowledgeDetail = knowledgeDetail?.scope === ventureId ? knowledgeDetail.value : null;
  const orderedStatuses = columnOrder;
  const canUpload = ["admin", "venture_head", "contributor"].includes(role);
  const canMove = (task: Task) => ["admin", "venture_head"].includes(role) || task.assigneeId === userId;
  const canPreview = (file: FileItem) => mediaAccept.split(",").includes(file.contentType);
  const previewable = currentFiles.items.filter(canPreview);
  const previewIndex = preview ? previewable.findIndex((file) => file.id === preview.file.id) : -1;
  const { rootRef: boardRef, capture, cardProps, columnProps, draggingId, overColumn, refocus } = useBoardMotion<Task["status"]>((taskId, status) => {
    const task = currentTasks.items.find((item) => item.id === taskId && item.groupId === groupId && item.ventureId === ventureId);
    if (!task || !canMove(task) || pendingTasks.has(taskId) || task.status === status) return false;
    return move(task, status);
  }, { scrollAxis: "x" });
  const setPendingTask = (taskId: string, on: boolean) => setPendingTasks((current) => { const next = new Set(current); if (on) next.add(taskId); else next.delete(taskId); return next; });
  const shakeTask = (taskId: string) => replayAnimation(boardRef.current?.querySelector(`[data-flip-id="${CSS.escape(taskId)}"]`), "vso-shake");

  function closePreview(returnFocus = true) {
    previewRequestRef.current++;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null); setPreviewError("");
    if (returnFocus) requestAnimationFrame(() => previewReturnRef.current?.getClientRects().length && previewReturnRef.current.focus());
  }

  async function openPreview(file: FileItem) {
    if (!canPreview(file)) return;
    // Stepping between previews keeps the original return point.
    if (!preview) previewReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const requestId = ++previewRequestRef.current;
    setBusyFileId(file.id); setActionError(""); setPreviewError("");
    try {
      const url = await prepareLiveFileDownload(file.id);
      if (requestId !== previewRequestRef.current) { URL.revokeObjectURL(url); return; }
      closePreview(false);
      previewUrlRef.current = url;
      setPreview({ file, url, groupId });
    } catch (cause) {
      // The preview covers the sheet's notice, so a failed step reports itself as a toast.
      if (preview) toast({ tone: "error", title: `Could not open ${file.name}`, body: errorText(cause) });
      else setActionError(errorText(cause));
    }
    finally { setBusyFileId(""); }
  }

  function stepPreview(delta: number) {
    const next = previewable[previewIndex + delta];
    if (next && !busyFileId) void openPreview(next);
  }

  /** Moves a card at once and saves in the background; a failed save glides it back. Callers run capture() first. */
  function move(task: Task, status: Task["status"]) {
    if (status === task.status) return false;
    if (status === "blocked" && !task.blocker) {
      shakeTask(task.id);
      toast({ id: `blocker-${task.id}`, tone: "error", title: "Add the blocker first", body: "Record what is blocking this task before moving it to Blocked.", action: { label: "Open task", onClick: () => router.push(`/tasks/live?task=${encodeURIComponent(task.id)}`) } });
      return false;
    }
    setActionError("");
    setTasks((page) => page.scope === task.groupId ? { ...page, items: page.items.map((item) => item.id === task.id ? { ...item, status } : item) } : page);
    setPendingTask(task.id, true);
    updateLiveTask(task.id, { status, ...(status !== "blocked" && task.blocker ? { blocker: null } : {}) })
      .then((changed) => setTasks((page) => page.scope === task.groupId && changed.groupId === task.groupId ? { ...page, items: page.items.map((item) => item.id === changed.id ? changed : item) } : page))
      .catch((cause: unknown) => {
        capture();
        setTasks((page) => page.scope === task.groupId ? { ...page, items: page.items.map((item) => item.id === task.id ? task : item) } : page);
        shakeTask(task.id);
        toast({ tone: "error", title: "Could not move the task", body: errorText(cause) });
      })
      .finally(() => setPendingTask(task.id, false));
    return true;
  }

  async function moreTasks() {
    if (!currentTasks.cursor || !groupId) return;
    setBusyTaskId("more"); setActionError("");
    try {
      const page = await listLiveTasks(currentTasks.cursor, { ventureId, groupId });
      if (page.items.some((task) => task.groupId !== groupId || task.ventureId !== ventureId)) throw new Error("The task response included an item outside this group.");
      setTasks((value) => value.scope === groupId ? { ...value, items: [...value.items, ...page.items], cursor: page.nextCursor } : value);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyTaskId(""); }
  }

  async function moreFiles() {
    if (!currentFiles.cursor || !groupId) return;
    setBusyFileId("more"); setActionError("");
    try {
      const page = await listLiveGroupFiles(groupId, currentFiles.cursor);
      setFiles((value) => value.scope === groupId ? { ...value, items: [...value.items, ...page.items], cursor: page.nextCursor } : value);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyFileId(""); }
  }

  async function moreSaved() {
    if (!currentSaved.cursor || !groupId) return;
    setBusySavedId("more"); setActionError("");
    try {
      const page = await listLiveGroupSavedMessages(groupId, currentSaved.cursor);
      setSaved((value) => value.scope === groupId ? { ...value, items: [...value.items, ...page.items], cursor: page.nextCursor } : value);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusySavedId(""); }
  }

  async function moreKnowledge() {
    if (!currentKnowledge.cursor || !ventureId) return;
    setBusyKnowledgeId("more"); setActionError("");
    try {
      const page = await listLiveDocuments(currentKnowledge.cursor, { ventureId });
      if (page.items.some((document) => document.ventureId && document.ventureId !== ventureId)) throw new Error("The knowledge response included another venture.");
      setKnowledge((value) => value.scope === ventureId ? { ...value, items: [...value.items, ...page.items], cursor: page.nextCursor } : value);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyKnowledgeId(""); }
  }

  async function openKnowledge(documentId: string) {
    if (!ventureId) return;
    setBusyKnowledgeId(documentId); setActionError("");
    try {
      const detail = await getLiveDocument(documentId);
      if (detail.document.ventureId && detail.document.ventureId !== ventureId) throw new Error("This record belongs to another venture.");
      setKnowledgeDetail({ scope: ventureId, value: detail });
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyKnowledgeId(""); }
  }

  async function upload(chosen: File[]) {
    if (!groupId || !ventureId || !chosen.length) return;
    if (chosen.length > 10) { setActionError("Add up to 10 files at a time."); return; }
    const unsupported = chosen.find((file) => !mediaAccept.split(",").includes(file.type));
    if (unsupported) { setActionError(`${unsupported.name} is not a supported image, video, or audio file.`); return; }
    const large = chosen.find((file) => file.size > 25 * 1024 * 1024);
    if (large) { setActionError(`${large.name} is larger than 25 MB.`); return; }
    setActionError(""); setUploadProgress({ done: 0, total: chosen.length });
    let done = 0;
    try {
      for (const file of chosen) { await uploadLiveFile(file, { ventureId, groupId }); done += 1; setUploadProgress({ done, total: chosen.length }); }
      toast({ title: chosen.length === 1 ? "File added" : `${chosen.length} files added`, body: `Shared in ${group?.name ?? "this group"}.` });
    } catch (cause) { setActionError(done ? `${done} of ${chosen.length} files were added. ${errorText(cause)}` : errorText(cause)); }
    finally { setUploadProgress(null); if (done) setFileRevision((value) => value + 1); }
  }

  async function download(file: FileItem) {
    setBusyFileId(file.id); setActionError("");
    try {
      const objectUrl = await prepareLiveFileDownload(file.id);
      const link = document.createElement("a");
      link.href = objectUrl; link.download = file.name; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusyFileId(""); }
  }

  async function unsave(item: SavedItem) {
    setBusySavedId(item.id); setActionError("");
    try {
      const changed = await updateLiveMessageSave(item.id, false);
      // The row folds away, then leaves the list; Undo saves it again.
      setLeavingSaved((current) => new Set(current).add(item.id));
      window.setTimeout(() => { setSaved((value) => ({ ...value, items: value.items.filter((message) => message.id !== item.id) })); setLeavingSaved((current) => { const next = new Set(current); next.delete(item.id); return next; }); }, 320);
      onSavedChange(changed);
      toast({ title: "Removed from saved", action: { label: "Undo", onClick: () => { void updateLiveMessageSave(item.id, true).then((restored) => { onSavedChange(restored); setSavedRevision((value) => value + 1); }).catch((cause: unknown) => toast({ tone: "error", title: "Could not save it again", body: errorText(cause) })); } } });
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusySavedId(""); }
  }

  return <section role="region" aria-label="Group workspace" className="vso-enter-bottom pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex h-[80dvh] max-h-full min-h-0 flex-col border-t border-[var(--color-neutral-200)] bg-white shadow-[0_-18px_48px_rgba(38,38,55,.12)]">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-neutral-200)] px-4 py-3 sm:px-6"><div className="min-w-0"><h2 className="text-sm font-semibold text-[var(--color-neutral-800)]">Group workspace</h2><p className="truncate text-[11px] text-[var(--color-neutral-400)]">{group ? `${ventureName} · ${group.name}` : "Choose a group"}</p></div><button type="button" onClick={onClose} aria-label="Close group workspace" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-neutral-500)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-neutral-100)] active:scale-[0.94]"><X size={18} /></button></header>
    <SlidingTabs tabs={tabs.map((item) => ({ key: item, label: item === "saved" ? "Saved messages" : item }))} active={tab} onChange={(key) => { setActionError(""); onTabChange(key as WorkspaceTab); }} label="Group workspace views" fitContent className="mx-3 my-2 shrink-0 self-start !border !border-[var(--color-neutral-200)] !bg-[var(--color-neutral-100)] !shadow-none sm:mx-5" />
    <Notice tone="error" message={actionError} onDismiss={() => setActionError("")} className="mx-4 pt-2 sm:mx-6" />
    <div key={tab} role="tabpanel" aria-label={tab === "saved" ? "Saved messages" : label(tab)} style={tabMotion.style} className={clsx(tabMotion.className, "thin-scroll min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6")}>
      {!group ? <EmptyState variant="card" tone="teal" icon={Layers3} title="Choose a group" body="Pick a group in the navigator to see its workspace." /> : tab === "kanban" ? <>
        <div className="mb-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--color-neutral-400)]">{currentTasks.items.length} task{currentTasks.items.length === 1 ? "" : "s"} in {group.name}</p><RefreshButton busy={currentTasks.loading} onClick={() => setTaskRevision((value) => value + 1)} label="Refresh tasks" /></div>
        {currentTasks.loading && !currentTasks.items.length ? <div role="status" aria-label="Loading group tasks" className="grid grid-flow-col auto-cols-[minmax(210px,240px)] gap-3 overflow-hidden pb-3">{[0, 1, 2, 3].map((index) => <div key={index} className="min-h-48 space-y-2 rounded-xl border border-[var(--color-neutral-100)] p-3"><span className="vso-skeleton mb-3 h-3 w-20" /><span className="vso-skeleton h-20 rounded-lg" /><span className="vso-skeleton h-16 rounded-lg opacity-70" /></div>)}</div> : currentTasks.error ? <EmptyState variant="error" title="Could not load tasks" body={currentTasks.error} action={{ label: "Try again", onClick: () => setTaskRevision((value) => value + 1) }} /> : currentTasks.items.length === 0 ? <EmptyState variant="card" tone="green" icon={Kanban} title="No tasks in this group yet" body="Tasks for this group appear here, grouped by status." /> : <>
          <p className="mb-2 text-[11px] text-[var(--color-neutral-400)]">Drag cards between columns, or use Move task for keyboard and touch.</p>
          <div ref={boardRef} aria-label="Group Kanban board" className="thin-scroll grid grid-flow-col auto-cols-[minmax(210px,240px)] gap-3 overflow-x-auto pb-3">
            {orderedStatuses.map((status) => { const cards = currentTasks.items.filter((task) => task.status === status); const draggingFromHere = cards.some((task) => task.id === draggingId); const over = overColumn === status && !!draggingId && !draggingFromHere; return <div key={status} {...columnProps(status)} className={clsx("min-h-48 rounded-xl border border-transparent bg-[var(--color-neutral-100)] p-3 transition-[border-color,box-shadow,background-color] duration-150", over && "border-[var(--color-primary-500)] bg-[var(--color-primary-50)] ring-2 ring-[var(--color-primary-200)]")}>
              <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold capitalize text-[var(--color-neutral-700)]">{label(status)}</h3><span key={cards.length} className="vso-label-swap tnum text-[10px] text-[var(--color-neutral-400)]">{cards.length}</span></div>
              <div className="space-y-2">{cards.map((task) => { const movable = canMove(task) && !pendingTasks.has(task.id); return <article key={task.id} {...cardProps(task.id, movable)} aria-busy={pendingTasks.has(task.id) || undefined} className={clsx("rounded-lg bg-white p-3 transition-[box-shadow,opacity] duration-150", movable && "cursor-grab hover:shadow-sm", draggingId === task.id && "opacity-40 outline-2 outline-dashed outline-[var(--color-primary-300)]")}>
                <p className="break-words text-xs font-semibold text-[var(--color-neutral-800)]">{task.title}</p><p className="mt-1 text-[10px] capitalize text-[var(--color-neutral-400)]">{task.priority} priority · Due {new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(task.dueAt))}</p>
                {canMove(task) && <label className="mt-3 block text-[10px] font-semibold text-[var(--color-neutral-500)]">Move task<Select aria-label={`Move ${task.title}`} disabled={pendingTasks.has(task.id)} value={task.status} onChange={(event) => { capture(); if (move(task, event.target.value as Task["status"])) refocus(task.id); }} className="mt-1 block min-h-9 w-full rounded-lg bg-[var(--color-neutral-100)] px-2 text-xs capitalize text-[var(--color-neutral-700)]">{statuses.map((item) => <option key={item} value={item} disabled={item === "blocked" && !task.blocker && task.status !== "blocked"}>{label(item)}</option>)}</Select></label>}
              </article>; })}{over && <div aria-hidden="true" className="vso-fade-enter grid min-h-14 place-items-center rounded-lg border-2 border-dashed border-[var(--color-primary-300)] bg-white/70 text-[11px] font-semibold text-[var(--color-primary-700)]">Drop here</div>}{cards.length === 0 && !over && <EmptyState variant="column" icon={Kanban} title={currentTasks.items.some(canMove) ? "Drop a task here" : "No tasks"} />}</div>
            </div>; })}
          </div>
          {currentTasks.cursor && <button type="button" disabled={Boolean(busyTaskId)} onClick={moreTasks} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--color-primary-100)] px-4 text-xs font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-200)] active:scale-[0.97] disabled:opacity-70">{busyTaskId === "more" && <Spinner size={12} />}{busyTaskId === "more" ? "Loading…" : "Load more tasks"}</button>}
        </>}
      </> : tab === "attachments" ? <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold text-[var(--color-neutral-700)]">Group attachments</p><p className="mt-1 text-[11px] text-[var(--color-neutral-400)]">Ready files shared in {group.name}</p></div><div className="flex items-center gap-2"><RefreshButton busy={currentFiles.loading} onClick={() => setFileRevision((value) => value + 1)} label="Refresh files" />{canUpload && <label className={clsx("flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-primary-600)] px-3 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-700)] active:scale-[0.97] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary-300)] has-[:focus-visible]:ring-offset-2", uploading && "cursor-progress opacity-80")}>{uploadProgress ? <Spinner size={13} /> : <Plus size={14} />}<span key={uploadProgress ? uploadProgress.done : "idle"} className="vso-label-swap tnum">{uploadProgress ? uploadProgress.total > 1 ? `Uploading ${uploadProgress.done + 1} of ${uploadProgress.total}…` : "Uploading…" : "Add media"}</span><input type="file" multiple accept={mediaAccept} disabled={uploading} className="sr-only" onChange={(event) => { const chosen = Array.from(event.target.files ?? []); event.target.value = ""; void upload(chosen); }} /></label>}</div></div>
        {currentFiles.loading && !currentFiles.items.length ? <div role="status" aria-label="Loading group files" className="space-y-2">{[0, 1, 2].map((index) => <div key={index} className="flex items-center gap-3 rounded-xl border border-[var(--color-neutral-100)] p-3"><span className="vso-skeleton h-10 w-10 shrink-0 rounded-lg" /><span className="grid flex-1 gap-1.5"><span className="vso-skeleton h-3 w-1/3" /><span className="vso-skeleton h-2.5 w-1/4" /></span></div>)}</div> : currentFiles.error ? <EmptyState variant="error" title="Could not load files" body={currentFiles.error} action={{ label: "Try again", onClick: () => setFileRevision((value) => value + 1) }} /> : currentFiles.items.length ? <><div className="vso-stagger-in space-y-2">{currentFiles.items.map((file) => <article key={file.id} className="flex min-w-0 items-center gap-3 rounded-xl bg-[var(--color-neutral-50)] p-3 transition-colors duration-150 hover:bg-[var(--color-neutral-100)]"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white text-[var(--color-primary-600)]"><Paperclip size={18} /></span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[var(--color-neutral-800)]">{file.name}</p><p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{file.contentType} · {(file.size / 1024).toFixed(1)} KB</p></div>{canPreview(file) && <button type="button" disabled={Boolean(busyFileId)} onClick={() => openPreview(file)} aria-label={`Preview ${file.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-100)] active:scale-[0.92] disabled:opacity-50">{busyFileId === file.id ? <Spinner /> : <Eye size={17} />}</button>}<button type="button" disabled={Boolean(busyFileId)} onClick={() => download(file)} aria-label={`Download ${file.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-100)] active:scale-[0.92] disabled:opacity-50"><Download size={17} /></button></article>)}</div>{currentFiles.cursor && <button type="button" disabled={Boolean(busyFileId)} onClick={moreFiles} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--color-primary-100)] px-4 text-xs font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-200)] active:scale-[0.97] disabled:opacity-70">{busyFileId === "more" && <Spinner size={12} />}{busyFileId === "more" ? "Loading…" : "Load more files"}</button>}</> : <EmptyState variant="card" tone="teal" icon={FolderOpen} title="No files in this group yet" body={canUpload ? "Use Add media to share images, video or audio with the group." : "Images, video and audio shared in this group appear here."} />}
        {canUpload && <p className="mt-4 text-[10px] text-[var(--color-neutral-400)]">Supported images, video, and audio · Up to 25 MB each.</p>}
      </> : tab === "knowledge" ? <>
        {currentKnowledgeDetail ? <div key="detail" className="vso-fade-enter"><div className="flex flex-wrap items-center justify-between gap-3"><button type="button" onClick={() => setKnowledgeDetail(null)} className="inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-semibold text-[var(--color-neutral-600)] hover:bg-[var(--color-neutral-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-500)]"><ArrowLeft size={15} />Back to documents</button><Link href={`/knowledge/live?doc=${encodeURIComponent(currentKnowledgeDetail.document.id)}`} className="inline-flex min-h-9 items-center rounded-lg bg-[var(--color-primary-600)] px-3 text-xs font-semibold text-white">Open in Knowledge</Link></div><article className="mx-auto max-w-4xl py-6"><span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-[var(--color-primary-100)] text-[var(--color-primary-700)]"><FileText size={22} /></span><h3 className="break-words text-2xl font-bold tracking-tight text-[var(--color-neutral-900)]">{currentKnowledgeDetail.document.title}</h3><p className="mt-2 text-xs text-[var(--color-neutral-500)]">{currentKnowledgeDetail.document.ventureId ? ventureName : "Shared workspace"} · Version {currentKnowledgeDetail.version.version} · {label(currentKnowledgeDetail.document.evidenceClass)}</p><span className="mt-3 inline-flex rounded-md bg-[var(--color-primary-100)] px-2 py-1 text-[10px] font-semibold capitalize text-[var(--color-primary-700)]">{label(currentKnowledgeDetail.document.status)}</span><div className="mt-6 border-t border-[var(--color-neutral-200)] pt-5"><p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-neutral-400)]">Markdown document</p><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-[var(--color-neutral-700)]">{currentKnowledgeDetail.version.markdown}</pre></div></article></div> : <div key="list" className="vso-fade-enter">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-[var(--color-neutral-800)]">{ventureName} knowledge</p><p className="mt-1 text-xs text-[var(--color-neutral-500)]">Choose a document to open it here.</p></div><RefreshButton busy={currentKnowledge.loading} onClick={() => setKnowledgeRevision((value) => value + 1)} label="Refresh knowledge" /></div>
          {busyKnowledgeId && busyKnowledgeId !== "more" && <p role="status" className="vso-fade-enter mb-3 flex items-center gap-2 text-xs text-[var(--color-neutral-500)]"><Spinner size={12} />Opening document…</p>}
          {currentKnowledge.loading && !currentKnowledge.items.length ? <div role="status" aria-label="Loading venture knowledge" className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">{[0, 1, 2, 3].map((index) => <div key={index} className="space-y-2"><span className="vso-skeleton h-36 rounded-xl" /><span className="vso-skeleton h-3 w-3/4" /><span className="vso-skeleton h-2.5 w-1/2" /></div>)}</div> : currentKnowledge.error ? <EmptyState variant="error" title="Could not load knowledge" body={currentKnowledge.error} action={{ label: "Try again", onClick: () => setKnowledgeRevision((value) => value + 1) }} /> : currentKnowledge.items.length ? <><div aria-label="Knowledge documents" className="vso-stagger-in grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">{currentKnowledge.items.map((document) => <KnowledgeDocumentTile key={document.id} title={document.title} venture={document.ventureId ? ventureName : "Shared workspace"} status={label(document.status)} updatedAt={new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(document.updatedAt))} onOpen={() => void openKnowledge(document.id)} />)}</div>{currentKnowledge.cursor && <button type="button" disabled={Boolean(busyKnowledgeId)} onClick={() => void moreKnowledge()} className="mt-6 min-h-10 rounded-lg bg-[var(--color-primary-100)] px-4 text-xs font-semibold text-[var(--color-primary-700)]">Load more documents</button>}</> : <EmptyState variant="card" tone="teal" icon={BookOpenText} title="No knowledge documents yet" body={`Documents added to ${ventureName} appear here.`} />}
        </div>}
      </> : <>
        <div className="mb-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--color-neutral-400)]">Saved messages in {group.name}</p><RefreshButton busy={currentSaved.loading} onClick={() => setSavedRevision((value) => value + 1)} label="Refresh saved" /></div>
        {currentSaved.loading && !currentSaved.items.length ? <div role="status" aria-label="Loading saved messages" className="space-y-2">{[0, 1, 2].map((index) => <div key={index} className="space-y-2 rounded-xl border border-[var(--color-neutral-100)] p-4"><span className="vso-skeleton h-2.5 w-24" /><span className="vso-skeleton h-3 w-5/6" /><span className="vso-skeleton h-3 w-2/3" /></div>)}</div> : currentSaved.error ? <EmptyState variant="error" title="Could not load saved messages" body={currentSaved.error} action={{ label: "Try again", onClick: () => setSavedRevision((value) => value + 1) }} /> : currentSaved.items.length ? <><div className="vso-stagger-in">{currentSaved.items.map((item) => <div key={item.id} data-open={!leavingSaved.has(item.id)} className="vso-collapse"><div><article className="mb-2 rounded-xl bg-[var(--color-neutral-50)] p-4"><div className="flex items-center justify-between gap-3"><p className="text-[10px] font-semibold text-[var(--color-primary-700)]"># {group.channels.find((channel) => channel.id === item.channelId)?.name ?? "Channel"}</p><time className="text-[10px] text-[var(--color-neutral-400)]">{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(item.createdAt))}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-neutral-700)]">{withMentionNames(item.body, mentionNames)}</p><div className="mt-3 flex flex-wrap items-center gap-1">{onOpenMessage && item.channelId && <button type="button" onClick={() => onOpenMessage({ id: item.id, channelId: item.channelId! })} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-100)] active:scale-[0.97]">Go to message<ArrowUpRight size={13} /></button>}<button type="button" disabled={Boolean(busySavedId)} onClick={() => unsave(item)} className="min-h-8 rounded-lg px-2 text-[11px] font-semibold text-[var(--color-neutral-500)] transition-[background-color,color] duration-150 hover:bg-[var(--color-neutral-100)] hover:text-[var(--color-neutral-700)] disabled:opacity-50">{busySavedId === item.id ? "Removing…" : "Remove from saved"}</button></div></article></div></div>)}</div>{currentSaved.cursor && <button type="button" disabled={Boolean(busySavedId)} onClick={moreSaved} className="mt-3 min-h-10 rounded-lg bg-[var(--color-primary-100)] px-4 text-xs font-semibold text-[var(--color-primary-700)]">Load more saved messages</button>}</> : <EmptyState variant="card" tone="teal" icon={Pin} title="No saved messages in this group yet" body="Save a message from its menu to keep it here." />}
      </>}
    </div>
    {preview && preview.groupId === groupId && <div role="dialog" aria-label={`Preview ${preview.file.name}`} onKeyDownCapture={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); closePreview(); return; }
      // ←/→ step through the group's previewable files (media controls keep their own arrow keys).
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !(event.target instanceof HTMLMediaElement)) { event.preventDefault(); stepPreview(event.key === "ArrowLeft" ? -1 : 1); }
    }} className="vso-fade-enter absolute inset-0 z-40 flex min-h-0 flex-col bg-white">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-neutral-200)] px-4 py-3 sm:px-6"><div className="min-w-0"><p className="truncate text-xs font-semibold text-[var(--color-neutral-800)]">{preview.file.name}</p><p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{group?.name} · {preview.file.contentType}</p></div><div className="flex shrink-0 items-center gap-1">{previewable.length > 1 && <><button type="button" aria-disabled={previewIndex <= 0} onClick={() => stepPreview(-1)} aria-label="Previous file" className="grid h-9 w-9 place-items-center rounded-lg text-[var(--color-neutral-600)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-neutral-100)] active:scale-[0.92] aria-disabled:pointer-events-none aria-disabled:opacity-35"><ChevronLeft size={17} /></button><span className="tnum min-w-10 text-center text-[11px] text-[var(--color-neutral-400)]">{busyFileId && busyFileId !== preview.file.id ? <Spinner size={12} /> : `${previewIndex + 1} / ${previewable.length}`}</span><button type="button" aria-disabled={previewIndex >= previewable.length - 1} onClick={() => stepPreview(1)} aria-label="Next file" className="grid h-9 w-9 place-items-center rounded-lg text-[var(--color-neutral-600)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-neutral-100)] active:scale-[0.92] aria-disabled:pointer-events-none aria-disabled:opacity-35"><ChevronRight size={17} /></button><span className="mx-1 h-5 w-px bg-[var(--color-neutral-200)]" /></>}<button type="button" disabled={Boolean(busyFileId)} onClick={() => download(preview.file)} aria-label={`Download ${preview.file.name}`} className="grid h-9 w-9 place-items-center rounded-lg text-[var(--color-primary-700)] hover:bg-[var(--color-primary-100)]"><Download size={17} /></button><button ref={previewCloseRef} type="button" onClick={() => closePreview()} aria-label="Close attachment preview" className="grid h-9 w-9 place-items-center rounded-lg text-[var(--color-neutral-500)] hover:bg-[var(--color-neutral-100)]"><X size={18} /></button></div></div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--color-neutral-100)] p-4">{previewError ? <p role="alert" className="max-w-sm text-center text-xs leading-5 text-red-700">{previewError} Use Download to keep a copy.</p> : preview.file.contentType.startsWith("image/") ? <img key={preview.file.id} src={preview.url} alt={preview.file.name} onError={() => setPreviewError("This image could not be previewed.")} className="vso-fade-enter max-h-full max-w-full object-contain" /> : preview.file.contentType.startsWith("video/") ? <video src={preview.url} controls playsInline onError={() => setPreviewError("This video could not be played.")} className="max-h-full max-w-full" /> : <audio src={preview.url} controls onError={() => setPreviewError("This audio could not be played.")} className="w-full max-w-lg" />}</div>
    </div>}
  </section>;
}
