"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import type { loadLiveSession } from "@/lib/studio-api";
import { commentOnLiveTask, deleteLiveTask, getLiveTask, reviewLiveEvidence, submitLiveEvidence, updateLiveTask } from "@/lib/studio-api";
import { atRisk, displayDate, priorityTone, safeHttpUrl, statusLabel, statusTone, TASK_STATUSES, taskError, type TaskStatus } from "@/lib/task-display";
import { useExitTransition } from "@/lib/motion";
import { Select } from "@/components/ui/select";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { Edit, FileText, LinkIcon, MessageCircle, MoreHorizontal, Paperclip, X } from "@/components/ui/icons";
import { ActionLabel, Badge, Field, inputClass, Notice, primaryClass, secondaryClass, SkeletonRows, useFlag } from "@/components/studio/primitives";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { LiveFileUpload } from "@/components/studio/live-file-controls";
import { MarkdownBody } from "@/components/studio/knowledge-markdown";
import { ImageTile, ImageViewer, MessageAttachmentCard, type ChatAttachment } from "@/components/studio/chat-attachments";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Detail = Awaited<ReturnType<typeof getLiveTask>>;
type Task = Detail["task"];
export type TaskTab = "overview" | "activity" | "evidence" | "files" | "people";
const TABS: TaskTab[] = ["overview", "activity", "evidence", "files", "people"];

const reviewPill = "inline-flex min-h-8 items-center rounded-lg px-2.5 text-xs font-semibold transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] disabled:opacity-50";
const sectionTitle = "text-xs font-semibold uppercase tracking-wide text-neutral-400";
const INLINE_IMAGE = /^image\/(png|jpeg|webp|gif)$/;

// Wide screens show status and people beside every tab; narrow ones give them a tab of their own.
const WIDE = "(min-width: 1024px)";
const subscribeWide = (callback: () => void) => { const query = window.matchMedia(WIDE); query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); };
const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);

/** Mirrors the API: the assignee, reviewer, venture leads, and admins update status and people. */
const updatesWork = (session: Session, task: Task) => ["admin", "venture_head"].includes(session.membership.role) || task.assigneeId === session.user.id || task.reviewerId === session.user.id;

/** A task in a large window: Overview, Activity, Evidence, and Files tabs, with status and people beside them. */
export function TaskDialog({ id, session, memberName, initialTab, onClose, onChanged, onDeleted }: {
  id: string; session: Session; memberName: (id: string) => string; initialTab?: TaskTab;
  onClose: () => void; onChanged: () => void; onDeleted: (task: Task, deletionId: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [chosenTab, setTab] = useState<TaskTab>(initialTab && TABS.includes(initialTab) ? initialTab : "overview");
  const [status, setStatus] = useState<TaskStatus>("proposed");
  const [assigneeId, setAssigneeId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [blocker, setBlocker] = useState("");
  const [evidenceTitle, setEvidenceTitle] = useState("");
  const [evidenceDescription, setEvidenceDescription] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [comment, setComment] = useState("");
  const [editingDetails, setEditingDetails] = useState(false);
  const [draft, setDraft] = useState({ title: "", outcome: "", definitionOfDone: "", evidenceRequirement: "", details: "", tags: "" });
  // The details as they were when editing began: only fields changed since then are sent, so a refresh can't revert someone else's edit.
  const [draftBase, setDraftBase] = useState(draft);
  const [allDetails, setAllDetails] = useState(false);
  const [fileNotice, setFileNotice] = useState("");
  const [pending, setPending] = useState("");
  const [saved, markSaved] = useFlag();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<"" | "delete" | "discard">("");
  const [viewing, setViewing] = useState<number | null>(null);
  // Items present at first load stay still; anything added afterwards rises in.
  const [knownIds, setKnownIds] = useState<Set<string> | null>(null);
  // The status and people as last loaded: a refresh only updates the fields the server changed, keeping unsaved picks.
  const loaded = useRef<{ status: string; assigneeId: string; reviewerId: string; blocker: string } | null>(null);
  // Evidence fields filled in after an upload don't count as typing when closing.
  const [prefilled, setPrefilled] = useState({ title: "", description: "" });
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuByKeyboard = useRef(false);
  const wide = useWide();
  const exit = useExitTransition(onClose, 130);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const activityEnd = useRef<HTMLDivElement>(null);
  const tab: TaskTab = wide && chosenTab === "people" ? "overview" : chosenTab;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => getLiveTask(id).then((result) => {
      if (!active) return;
      setDetail(result);
      setKnownIds((current) => current ?? new Set([...result.evidence, ...result.updates, ...result.attachments].map((item) => item.id)));
      const server = { status: result.task.status, assigneeId: result.task.assigneeId, reviewerId: result.task.reviewerId ?? "", blocker: result.task.blocker ?? "" };
      const before = loaded.current;
      if (!before || before.status !== server.status) setStatus(server.status);
      if (!before || before.assigneeId !== server.assigneeId) setAssigneeId(server.assigneeId);
      if (!before || before.reviewerId !== server.reviewerId) setReviewerId(server.reviewerId);
      if (!before || before.blocker !== server.blocker) setBlocker(server.blocker);
      loaded.current = server;
      setError("");
    }).catch((cause: unknown) => { if (active) setError(taskError(cause)); }));
    return () => { active = false; };
  }, [id, revision]);

  // Focus starts on Close and goes back where it was when the window closes (if that's still on the page).
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  // The newest activity is at the bottom, next to the comment box.
  useEffect(() => { if (tab === "activity") activityEnd.current?.scrollIntoView({ block: "end" }); }, [tab, detail?.updates.length]);

  async function mutate(action: () => Promise<unknown>, reset?: () => void, key = "") {
    setBusy(true); setPending(key); setError("");
    try { await action(); reset?.(); setRevision((value) => value + 1); onChanged(); if (key) markSaved(key); }
    catch (cause) { setError(taskError(cause)); }
    finally { setBusy(false); setPending(""); }
  }

  const task = detail?.task;
  const isNew = (itemId: string) => !!knownIds && !knownIds.has(itemId);
  const role = session.membership.role;
  const editable = !!task && updatesWork(session, task);
  const reviewer = !!task && (["admin", "venture_head"].includes(role) || task.reviewerId === session.user.id);
  const canUpload = ["admin", "venture_head", "contributor"].includes(role);
  // Mirrors the API: the assignee or a lead of this venture submits evidence; nobody approves their own submission or task.
  const canSubmitEvidence = !!task && (task.assigneeId === session.user.id || role === "admin" || (role === "venture_head" && session.membership.ventureIds.includes(task.ventureId)));
  const canReviewEvidence = (submittedBy: string) => reviewer && (role === "admin" || (submittedBy !== session.user.id && task?.assigneeId !== session.user.id));
  // A task's details belong to whoever created it, and admins; so does deleting it.
  const owns = !!task && (role === "admin" || (["venture_head", "contributor"].includes(role) && task.creatorId === session.user.id));
  const canEditDetails = owns && !!task && !["done", "cancelled"].includes(task.status);
  const venture = session.hierarchy.ventures.find((item) => item.id === task?.ventureId);
  const group = venture?.groups.find((item) => item.id === task?.groupId);
  const images: ChatAttachment[] = useMemo(() => (detail?.attachments ?? []).filter((file) => INLINE_IMAGE.test(file.contentType)), [detail]);
  const otherFiles = (detail?.attachments ?? []).filter((file) => !INLINE_IMAGE.test(file.contentType));
  const pendingEvidence = (detail?.evidence ?? []).filter((item) => item.reviewStatus === "pending").length;
  const dirty = (editingDetails && JSON.stringify(draft) !== JSON.stringify(draftBase)) || Boolean(comment.trim() || evidenceUrl.trim() || evidenceTitle !== prefilled.title || evidenceDescription !== prefilled.description);

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) { setConfirming("discard"); requestAnimationFrame(() => keepButton.current?.focus()); return; }
    exit.close();
  }, [busy, dirty, exit]);
  const latest = useRef({ menuOpen, confirming, requestClose });
  useEffect(() => { latest.current = { menuOpen, confirming, requestClose }; }, [menuOpen, confirming, requestClose]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const root = dialog.current;
      if (!root) return;
      const active = document.activeElement;
      // Another window on top of this one (such as the photo viewer) handles its own keys.
      const above = active instanceof HTMLElement ? active.closest('[aria-modal="true"]') : null;
      if (above && above !== root) return;
      if (event.key === "Escape") {
        // An open picker, the photo viewer, or the menu closes first.
        if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('[role="combobox"][aria-expanded="true"]'))) return;
        event.preventDefault();
        const { menuOpen: open, confirming: asking, requestClose: close } = latest.current;
        if (open) { setMenuOpen(false); menuButton.current?.focus(); } else if (asking) setConfirming(""); else close();
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented) return;
      // Focus stays inside the window, skipping hidden helpers (such as the pickers' off-screen inputs).
      const items = [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]')]
        .filter((item) => item.tabIndex >= 0 && !item.closest('[aria-hidden="true"]') && item.getClientRects().length > 0);
      if (!items.length) { event.preventDefault(); root.focus(); return; }
      const first = items[0]!; const last = items[items.length - 1]!;
      const inside = root.contains(active) && active !== root;
      if (event.shiftKey && (active === first || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !inside)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  // The menu closes on a click outside it; opened from the keyboard, it starts on its first item.
  useEffect(() => {
    if (!menuOpen) return;
    if (menuByKeyboard.current) menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: MouseEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [menuOpen]);
  function menuKeys(event: React.KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(menuRoot.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = index === -1 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]!.focus();
  }

  function startEditing() {
    if (!task) return;
    const current = { title: task.title, outcome: task.outcome, definitionOfDone: task.definitionOfDone, evidenceRequirement: task.evidenceRequirement, details: task.details ?? "", tags: task.tags.join(", ") };
    setDraft(current); setDraftBase(current); setTab("overview"); setEditingDetails(true);
  }
  function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    if (!task) return;
    const tags = [...new Set(draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean))];
    if (draft.tags !== draftBase.tags && (tags.length > 30 || tags.some((tag) => tag.length > 50))) { setError("Use up to 30 tags, each up to 50 characters."); return; }
    // Only what was changed in this form is sent, so the activity log names the right fields; emptied details are removed.
    const edited = (field: "title" | "outcome" | "definitionOfDone" | "evidenceRequirement") => draft[field].trim() !== draftBase[field].trim() ? { [field]: draft[field].trim() } : {};
    const change = { ...edited("title"), ...edited("outcome"), ...edited("definitionOfDone"), ...edited("evidenceRequirement"), ...(draft.details.trim() !== draftBase.details.trim() ? { details: draft.details.trim() || null } : {}), ...(draft.tags !== draftBase.tags ? { tags } : {}) };
    if (!Object.keys(change).length) { setEditingDetails(false); return; }
    void mutate(() => updateLiveTask(task.id, change), () => setEditingDetails(false), "details");
  }
  const edit = (field: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((value) => ({ ...value, [field]: event.target.value }));

  async function remove() {
    if (!task) return;
    setBusy(true); setPending("delete"); setError("");
    try {
      const { deletionId } = await deleteLiveTask(task.id);
      onDeleted(task, deletionId);
      exit.close();
    } catch (cause) { setError(taskError(cause)); setConfirming(""); }
    finally { setBusy(false); setPending(""); }
  }
  async function copyLink() {
    setMenuOpen(false);
    menuButton.current?.focus();
    try { await navigator.clipboard.writeText(`${window.location.origin}/tasks/live?task=${encodeURIComponent(id)}`); toast({ title: "Link copied" }); }
    catch { toast({ tone: "error", title: "Couldn't copy the link" }); }
  }

  const overview = task && <div className="space-y-6">
    {editingDetails ? <form onSubmit={saveDetails} className="vso-fade-enter space-y-3">
      <h3 className="text-sm font-semibold text-neutral-900">Edit details</h3>
      <Field label="Title"><input required maxLength={200} className={inputClass} value={draft.title} onChange={edit("title")} /></Field>
      <Field label="Outcome"><textarea required maxLength={2000} className={`${inputClass} min-h-20 py-3`} value={draft.outcome} onChange={edit("outcome")} /></Field>
      <Field label="Definition of done"><textarea required maxLength={5000} className={`${inputClass} min-h-24 py-3`} value={draft.definitionOfDone} onChange={edit("definitionOfDone")} placeholder={"- One line per thing that must be true"} /></Field>
      <Field label="Evidence required"><textarea required maxLength={2000} className={`${inputClass} min-h-16 py-3`} value={draft.evidenceRequirement} onChange={edit("evidenceRequirement")} /></Field>
      <Field label="Details: background, specs, links, plans (Markdown, optional)"><textarea maxLength={20000} className={`${inputClass} min-h-48 py-3 font-mono text-[13px] leading-6`} value={draft.details} onChange={edit("details")} /></Field>
      <Field label="Tags, separated by commas"><input className={inputClass} value={draft.tags} onChange={edit("tags")} placeholder="design, launch" /></Field>
      {task.assigneeId !== session.user.id && <p className="text-xs text-neutral-500">{memberName(task.assigneeId)} is told about the change.</p>}
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={pending === "details"} idle="Save details" /></button><button type="button" disabled={busy} onClick={() => setEditingDetails(false)} className={secondaryClass}>Cancel</button></div>
    </form> : <>
      <section><h3 className={sectionTitle}>Outcome</h3><p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-neutral-800">{task.outcome}</p>
        {!!task.tags.length && <div className="mt-2.5 flex flex-wrap gap-1.5">{task.tags.map((tag) => <span key={tag} className="rounded-md bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">{tag}</span>)}</div>}
        {atRisk(task) && <p className="mt-2 text-xs font-semibold text-warning-text">The estimated effort is longer than the time left before the due date.</p>}
        {task.blocker && <p className="mt-2 rounded-lg bg-danger-surface px-3 py-2 text-sm text-danger-text">Blocked: {task.blocker}</p>}
      </section>
      <div className="grid gap-4 rounded-xl bg-neutral-50 p-4 text-sm sm:grid-cols-2">
        <section><h3 className={sectionTitle}>Definition of done</h3><p className="mt-1.5 whitespace-pre-wrap leading-6 text-neutral-700">{task.definitionOfDone}</p></section>
        <section><h3 className={sectionTitle}>Evidence required</h3><p className="mt-1.5 whitespace-pre-wrap leading-6 text-neutral-700">{task.evidenceRequirement}</p></section>
      </div>
      {task.details ? <section className="vso-fade-enter"><h3 className={clsx(sectionTitle, "mb-2")}>Details</h3><div className={clsx("relative overflow-hidden", !allDetails && task.details.length > 2500 && "max-h-96")}><MarkdownBody markdown={task.details} view="rendered" noImages compact />{!allDetails && task.details.length > 2500 && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white" />}</div>{task.details.length > 2500 && <button type="button" aria-expanded={allDetails} onClick={() => setAllDetails((value) => !value)} className="mt-2 text-xs font-semibold text-primary-700 hover:underline">{allDetails ? "Show less" : "Show all details"}</button>}</section>
        : canEditDetails && <button type="button" onClick={startEditing} className="text-xs font-semibold text-primary-700 hover:underline">Add details: background, specs, links</button>}
    </>}
  </div>;

  const activity = detail && (detail.updates.length ? <><ol className="space-y-2">{detail.updates.map((item) => <li key={item.id} className={clsx("rounded-xl px-3 py-2.5 text-xs", item.type === "comment" ? "bg-neutral-50 text-neutral-700" : "border border-dashed border-neutral-200 text-neutral-500", isNew(item.id) && "vso-row-enter")}>
    <p className="font-semibold text-neutral-800">{item.authorId === session.user.id ? "You" : memberName(item.authorId)} <span className="font-medium capitalize text-neutral-500">· {item.type} · {displayDate(item.createdAt)}</span>{item.via === "claude" && <span className="font-medium text-neutral-500"> · via Claude</span>}</p>
    <p className="mt-1 whitespace-pre-wrap leading-5">{item.body}</p>
  </li>)}</ol><div ref={activityEnd} /></> : <EmptyState variant="compact" icon={MessageCircle} title="No activity yet" body="Comments and status changes appear here." />);

  const evidence = detail && task && <div className="space-y-4">
    {detail.evidence.length ? <ul className="space-y-2">{detail.evidence.map((item) => <li key={item.id} className={clsx("rounded-xl bg-neutral-50 p-3", isNew(item.id) && "vso-row-enter")}>
      <p className="text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-neutral-500">{item.description}</p>
      {item.uri && safeHttpUrl(item.uri) && <a href={item.uri} target="_blank" rel="noopener noreferrer" className="mt-1 block break-all text-xs font-semibold text-primary-700 underline">Open source</a>}
      <div className="mt-2 flex flex-wrap items-center gap-2"><Badge tone={item.reviewStatus === "accepted" || item.reviewStatus === "exception" ? "green" : item.reviewStatus === "rejected" ? "red" : "amber"}>{item.reviewStatus}</Badge>{canReviewEvidence(item.submittedBy) && item.reviewStatus === "pending" && <><button type="button" disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "accepted"))} className={clsx(reviewPill, "bg-success-surface text-success-text")}>Accept</button><button type="button" disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "rejected"))} className={clsx(reviewPill, "bg-danger-surface text-danger-text")}>Reject</button><button type="button" disabled={busy} onClick={() => mutate(() => reviewLiveEvidence(item.id, "exception"))} className={clsx(reviewPill, "bg-primary-50 text-primary-700")}>Exception</button></>}</div>
    </li>)}</ul> : <EmptyState variant="compact" icon={FileText} title="No evidence submitted yet" body={canSubmitEvidence ? "Submit it below for review." : "Submitted evidence appears here for review."} />}
    <p className="text-xs leading-5 text-neutral-500"><span className="font-semibold text-neutral-700">Required:</span> {task.evidenceRequirement}</p>
    {canSubmitEvidence && <form onSubmit={(event) => { event.preventDefault(); if (evidenceUrl && !safeHttpUrl(evidenceUrl)) { setError("Evidence links must use http:// or https://."); return; } mutate(() => submitLiveEvidence(task.id, { title: evidenceTitle, description: evidenceDescription, ...(evidenceUrl ? { uri: evidenceUrl } : {}) }), () => { setEvidenceTitle(""); setEvidenceDescription(""); setEvidenceUrl(""); setPrefilled({ title: "", description: "" }); }, "evidence"); }} className="grid gap-2 border-t border-neutral-100 pt-4">
      <h3 className="text-sm font-semibold text-neutral-900">Submit evidence</h3>
      <Field label="Evidence title"><input required className={inputClass} value={evidenceTitle} onChange={(event) => setEvidenceTitle(event.target.value)} /></Field>
      <Field label="Description"><textarea required className={`${inputClass} min-h-20 py-3`} value={evidenceDescription} onChange={(event) => setEvidenceDescription(event.target.value)} /></Field>
      <Field label="Source URL, optional"><input type="url" className={inputClass} value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} /></Field>
      <div><button disabled={busy} className={secondaryClass}><ActionLabel busy={pending === "evidence"} done={saved === "evidence"} idle="Submit evidence for review" busyText="Submitting…" doneText="Submitted for review" /></button></div>
    </form>}
  </div>;

  const files = detail && task && <div className="space-y-5">
    {detail.attachments.length ? <>
      {images.length > 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{images.map((file, index) => <ImageTile key={file.id} file={file} className="aspect-square w-full" onOpen={() => setViewing(index)} />)}</div>}
      {otherFiles.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{otherFiles.map((file) => <MessageAttachmentCard key={file.id} file={file} />)}</div>}
    </> : <EmptyState variant="compact" icon={Paperclip} title="No files attached" body={canUpload ? "Upload one below." : undefined} />}
    {canUpload && <div className="border-t border-neutral-100 pt-4"><h3 className="mb-2 text-sm font-semibold text-neutral-900">Attach a file</h3><p className="mb-3 text-xs leading-5 text-neutral-500">Files stay with this task. Attaching one doesn&apos;t submit it as evidence.</p>
      <LiveFileUpload ventureId={task.ventureId} groupId={task.groupId} taskId={task.id} onUploaded={(file) => { setFileNotice(`${file.name} is attached. To count it as evidence, submit it in the Evidence tab; it's filled in for you.`); const filled = { title: file.name, description: `Review task attachment ${file.id} (${file.name}) as supporting evidence.` }; setEvidenceTitle(filled.title); setEvidenceDescription(filled.description); setPrefilled(filled); setEvidenceUrl(""); setRevision((value) => value + 1); onChanged(); }} />
      <Notice tone="success" message={fileNotice} onDismiss={() => setFileNotice("")} autoDismissMs={8000} className="pt-3" /></div>}
    {viewing !== null && <ImageViewer images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />}
  </div>;

  const statusAndPeople = task && <div className="space-y-6">
    <section className="space-y-3"><h3 className="text-sm font-semibold text-neutral-900">Status</h3>
      {editable ? <form onSubmit={(event) => { event.preventDefault(); mutate(() => updateLiveTask(task.id, { status, blocker: status === "blocked" ? blocker : null }), () => setBlocker((value) => value.trim()), "status"); }} className="space-y-3">
        <Field label="Status"><Select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>{TASK_STATUSES.map((item) => <option key={item} value={item}>{statusLabel(item)}</option>)}</Select></Field>
        <div data-open={status === "blocked"} className="vso-collapse"><div><Field label="Blocker"><input className={inputClass} value={blocker} onChange={(event) => setBlocker(event.target.value)} placeholder="What is stopping work?" /></Field></div></div>
        <p className="text-[11px] leading-4 text-neutral-500">Done needs accepted evidence or a reviewed exception.</p>
        <button type="submit" disabled={busy || status === task.status && (status !== "blocked" || blocker === (task.blocker ?? "")) || (status === "blocked" && !blocker.trim())} className={clsx(primaryClass, "w-full")}><ActionLabel busy={pending === "status"} done={saved === "status"} idle="Save status" /></button>
      </form> : <p><Badge tone={statusTone(task)}>{statusLabel(task.status)}</Badge></p>}
    </section>
    <section className="space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">People</h3>
      {editable ? <form onSubmit={(event) => { event.preventDefault(); if (!assigneeId) return; mutate(() => updateLiveTask(task.id, { assigneeId, ...(reviewerId ? { reviewerId } : {}) }), undefined, "people"); }} className="space-y-3">
        <LiveMemberPicker label="Assignee" value={assigneeId} onChange={setAssigneeId} ventureId={task.ventureId} groupId={task.groupId} />
        <LiveMemberPicker label="Reviewer" value={reviewerId} onChange={setReviewerId} ventureId={task.ventureId} groupId={task.groupId} optional />
        <p className="text-[11px] leading-4 text-neutral-500">Both must be members of this venture and group. An existing reviewer can be changed, not removed.</p>
        <button type="submit" disabled={busy || !assigneeId || (!!task.reviewerId && !reviewerId) || (assigneeId === task.assigneeId && reviewerId === (task.reviewerId ?? ""))} className={clsx(secondaryClass, "w-full")}><ActionLabel busy={pending === "people"} done={saved === "people"} idle="Save people" /></button>
      </form> : <dl className="space-y-1.5 text-sm"><div className="flex justify-between gap-3"><dt className="text-neutral-500">Assignee</dt><dd className="font-medium text-neutral-800">{memberName(task.assigneeId)}</dd></div><div className="flex justify-between gap-3"><dt className="text-neutral-500">Reviewer</dt><dd className="font-medium text-neutral-800">{task.reviewerId ? memberName(task.reviewerId) : "None"}</dd></div></dl>}
    </section>
    <section className="border-t border-neutral-100 pt-5"><h3 className="mb-2 text-sm font-semibold text-neutral-900">Plan</h3>
      <dl className="space-y-1.5 text-sm">{([["Priority", `${task.priority[0]!.toUpperCase()}${task.priority.slice(1)}`], ["Due", displayDate(task.dueAt)], ["Estimate", `${task.estimatedMinutes} min`], ["Time zone", task.timezone], ["Venture", venture?.name ?? "Venture"], ["Group", group?.name ?? "Group"], ["Created by", memberName(task.creatorId)]] as const).map(([name, value]) => <div key={name} className="flex justify-between gap-3"><dt className="text-neutral-500">{name}</dt><dd className="min-w-0 truncate text-right font-medium text-neutral-800">{value}</dd></div>)}</dl>
    </section>
  </div>;

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "activity", label: "Activity", badge: detail?.updates.length || undefined },
    { key: "evidence", label: "Evidence", badge: pendingEvidence || undefined },
    { key: "files", label: "Files", badge: detail?.attachments.length || undefined },
    ...(!wide ? [{ key: "people", label: "Status & people" }] : []),
  ];
  const menuItem = "flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] text-neutral-700 transition-colors duration-100 hover:bg-neutral-50 focus-visible:bg-neutral-50 focus-visible:outline-none";

  return createPortal(<div data-state={exit.state} className="vso-backdrop fixed inset-0 z-[60] grid place-items-center bg-neutral-900/30 backdrop-blur-[2px] sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="task-dialog-title" className="vso-enter-modal flex outline-none h-[100dvh] w-full max-w-5xl flex-col overflow-hidden bg-white shadow-2xl sm:h-[min(92dvh,900px)] sm:rounded-3xl">
      <header className="flex items-start gap-2 border-b border-neutral-100 px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          {task && <div className="mb-1.5 flex flex-wrap items-center gap-1.5"><Badge tone={priorityTone(task)}>{task.priority}</Badge><Badge tone={statusTone(task)}>{statusLabel(task.status)}</Badge>{atRisk(task) && <Badge tone="amber">Deadline risk</Badge>}</div>}
          <h2 id="task-dialog-title" className="text-lg font-bold leading-snug text-neutral-900 [overflow-wrap:anywhere]">{task?.title ?? "Task"}</h2>
          {task && <p className="mt-1 text-xs text-neutral-500">{venture?.name ?? "Venture"} · Due {displayDate(task.dueAt)} · {task.estimatedMinutes} min · {memberName(task.assigneeId)}{task.reviewerId ? ` → ${memberName(task.reviewerId)}` : ""}</p>}
        </div>
        {task && <div ref={menuRoot} className="relative shrink-0" onKeyDown={menuKeys}>
          <button ref={menuButton} type="button" aria-label="Task actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => { menuByKeyboard.current = event.detail === 0; setMenuOpen((value) => !value); }} className={clsx("grid h-9 w-9 place-items-center rounded-full text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-800 active:scale-[0.96]", menuOpen && "bg-neutral-100 text-neutral-800")}><MoreHorizontal size={18} /></button>
          {menuOpen && <div role="menu" aria-label="Task actions" data-side="bottom" data-align="right" className="vso-enter-popover absolute right-0 top-full z-10 mt-1 w-52 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-e3">
            {canEditDetails && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); startEditing(); requestAnimationFrame(() => dialog.current?.querySelector<HTMLInputElement>("form input")?.focus()); }} className={menuItem}><Edit size={14} />Edit details</button>}
            <button type="button" role="menuitem" onClick={() => void copyLink()} className={menuItem}><LinkIcon size={14} />Copy link</button>
            {owns && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setConfirming("delete"); requestAnimationFrame(() => keepButton.current?.focus()); }} className={clsx(menuItem, "!text-red-700 hover:!bg-red-50")}><X size={14} />Delete task</button>}
          </div>}
        </div>}
        <button ref={closeButton} type="button" aria-label="Close" onClick={requestClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-800 active:scale-[0.96]"><X size={16} /></button>
      </header>
      <div data-open={Boolean(confirming)} className="vso-collapse"><div>
        <div role="alertdialog" aria-label={confirming === "delete" ? "Delete this task?" : "Discard your changes?"} className={clsx("flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6", confirming === "delete" ? "bg-danger-surface" : "bg-warning-surface")}>
          <p className={clsx("text-sm font-semibold", confirming === "delete" ? "text-danger-text" : "text-warning-text")}>{confirming === "delete" ? "Delete this task? Its comments, evidence, files, and reminders go with it. You can undo right after." : "Discard what you typed? It will be lost."}</p>
          <div className="flex gap-2">
            <button ref={keepButton} type="button" onClick={() => { setConfirming(""); (menuButton.current ?? closeButton.current)?.focus(); }} className={clsx(secondaryClass, "!min-h-9")}>{confirming === "delete" ? "Keep task" : "Keep editing"}</button>
            {confirming === "delete"
              ? <button type="button" disabled={busy} onClick={() => void remove()} className={clsx(primaryClass, "!min-h-9 !bg-red-600 hover:!bg-red-700")}><ActionLabel busy={pending === "delete"} busyText="Deleting…" idle="Delete task" /></button>
              : <button type="button" onClick={() => { setConfirming(""); exit.close(); }} className={clsx(primaryClass, "!min-h-9")}>Discard</button>}
          </div>
        </div>
      </div></div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-neutral-100 px-4 py-2.5 sm:px-6"><SlidingTabs fitContent label="Task sections" className="bg-neutral-100 shadow-none" active={tab} onChange={(key) => setTab(key as TaskTab)} tabs={tabs} /></div>
          <Notice tone="error" message={error} onDismiss={() => setError("")} className="px-5 pt-4 sm:px-6" />
          <div key={tab} className="vso-fade-enter thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-5 [overflow-wrap:anywhere] sm:px-6">
            {!detail ? !error && <SkeletonRows rows={5} label="Loading task" className="!p-0" />
              : tab === "overview" ? overview : tab === "activity" ? activity : tab === "evidence" ? evidence : tab === "files" ? files : statusAndPeople}
          </div>
          {detail && task && tab === "activity" && <form onSubmit={(event) => { event.preventDefault(); mutate(() => commentOnLiveTask(task.id, comment.trim()), () => setComment(""), "comment"); }} className="flex items-end gap-2 border-t border-neutral-100 px-5 py-3 sm:px-6">
            <label className="min-w-0 flex-1"><span className="sr-only">Add a comment</span><textarea rows={2} required aria-keyshortcuts="Control+Enter" placeholder="Add a comment… (Ctrl+Enter to post)" className={`${inputClass} min-h-11 py-2.5`} value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /></label>
            <button disabled={busy || !comment.trim()} className={primaryClass}><ActionLabel busy={pending === "comment"} done={saved === "comment"} idle="Post" busyText="Posting…" doneText="Posted" /></button>
          </form>}
        </div>
        {wide && detail && <aside aria-label="Status and people" className="thin-scroll w-80 shrink-0 overflow-y-auto border-l border-neutral-100 bg-neutral-50/50 p-5">{statusAndPeople}</aside>}
      </div>
    </section>
  </div>, document.body);
}
