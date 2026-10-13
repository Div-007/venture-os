"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import type { Task } from "@venture-studio/contracts";
import { Select } from "@/components/ui/select";
import { ditherTone, EmptyTile, type EmptyAction } from "@/components/ui/empty-state";
import { Dither } from "@/components/ui/dither";
import { ListTodo, Plus, X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { Field, inputClass, Notice, primaryClass, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { createLiveTask, loadLiveSession } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";
import { useExitTransition } from "@/lib/motion";
import { useStudio } from "@/lib/studio-store";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;

/** Any screen can open the task form with `openNewTask()`; screens that list tasks refresh on `TASK_CREATED_EVENT`. */
export const NEW_TASK_EVENT = "vso:new-task";
export const TASK_CREATED_EVENT = "vso:task-created";
export const openNewTask = () => window.dispatchEvent(new Event(NEW_TASK_EVENT));
/** A create-task action for empty states: the popup in the live app, the demo's task page otherwise. */
export const newTaskAction = (mode: "demo" | "connected", label = "Draft a task"): EmptyAction => mode === "connected" ? { label, icon: Plus, onClick: openNewTask } : { label, icon: Plus, href: "/tasks?new=1" };

const isoDay = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const chipClass = (active: boolean) => clsx("min-h-7 rounded-lg border px-2 text-[11px] font-semibold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]", active ? "border-primary-300 bg-primary-50 text-primary-800" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50");

/** The create-task form in a centred dialog over the current screen. Closing a half-filled form asks first. */
function NewTaskDialog({ session, activeVentureId, onClose, onCreated }: { session: Session | null; activeVentureId: string; onClose: () => void; onCreated: (task: Task) => void }) {
  const firstVenture = session?.hierarchy.ventures.find((item) => item.id === activeVentureId);
  const [ventureId, setVentureId] = useState(firstVenture?.id ?? "");
  const [groupId, setGroupId] = useState(firstVenture?.groups[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [outcome, setOutcome] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [dueDate, setDueDate] = useState(() => isoDay(1));
  const [minutes, setMinutes] = useState(60);
  const [definition, setDefinition] = useState("");
  const [evidenceRequirement, setEvidenceRequirement] = useState("");
  const [details, setDetails] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const exit = useExitTransition(onClose, 130);
  const groups = session?.hierarchy.ventures.find((item) => item.id === ventureId)?.groups ?? [];
  const dueAt = dueDate ? new Date(`${dueDate}T17:00:00`) : null;
  const tight = !!dueAt && !Number.isNaN(dueAt.getTime()) && minutes > 0 && dueAt.getTime() - openedAt <= minutes * 60_000;
  const dirty = Boolean(title.trim() || outcome.trim() || definition.trim() || evidenceRequirement.trim() || details.trim() || tags.trim() || assigneeId);

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) { setConfirming(true); requestAnimationFrame(() => keepEditing.current?.focus()); return; }
    exit.close();
  }, [busy, dirty, exit]);

  useEffect(() => { if (session) titleInput.current?.focus(); }, [session]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const task = await createLiveTask({ ventureId, groupId, title, outcome, assigneeId, ...(details.trim() ? { details: details.trim() } : {}), ...(reviewerId ? { reviewerId } : {}), priority, dueAt: new Date(`${dueDate}T17:00:00`).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", estimatedMinutes: minutes, definitionOfDone: definition, evidenceRequirement, tags: tags.split(",").map((item) => item.trim()).filter(Boolean), dependencies: [], evidenceLinks: [] });
      onCreated(task);
    } catch (cause) { setError(describeError(cause, "The task could not be created. Please try again.")); }
    finally { setBusy(false); }
  }

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      if (event.target instanceof HTMLElement && event.target.closest('[role="combobox"][aria-expanded="true"]')) return;
      event.stopPropagation();
      if (confirming) setConfirming(false); else requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((item) => item.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return createPortal(<div data-state={exit.state} className="vso-backdrop fixed inset-0 z-[60] grid place-items-center bg-neutral-900/30 p-3 backdrop-blur-[2px] sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="new-task-title" onKeyDownCapture={onKey} className="vso-enter-modal flex max-h-[min(92dvh,880px)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
      <header className="relative flex items-start gap-3 overflow-hidden border-b border-neutral-100 px-5 py-5 sm:px-6">
        {/* A slowly drifting dither behind the title, strongest at the right so the text stays clear. */}
        <div aria-hidden="true" className="vso-dialog-glow absolute inset-0" />
        <Dither colors={ditherTone("green")} origin={[1.05, -0.4]} reach={1.25} pixel={3} animated className="vso-dialog-dither opacity-90" />
        <span className="relative"><EmptyTile icon={ListTodo} tone="green" size={40} /></span>
        <div className="relative min-w-0 flex-1"><h2 id="new-task-title" className="text-base font-bold text-neutral-900">New task</h2><p className="text-xs text-neutral-500">Assign it to a member of the venture and group.</p></div>
        <button type="button" aria-label="Close" onClick={requestClose} className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-800 active:scale-[0.96]"><X size={16} /></button>
      </header>
      <div data-open={confirming} className="vso-collapse"><div><div role="alertdialog" aria-label="Discard this task?" className="flex flex-wrap items-center justify-between gap-3 bg-warning-surface px-5 py-3 sm:px-6"><p className="text-sm font-semibold text-warning-text">Discard this task? What you typed will be lost.</p><div className="flex gap-2"><button ref={keepEditing} type="button" tabIndex={confirming ? 0 : -1} onClick={() => setConfirming(false)} className={clsx(secondaryClass, "!min-h-9")}>Keep editing</button><button type="button" tabIndex={confirming ? 0 : -1} onClick={exit.close} className="min-h-9 rounded-xl bg-[#b42318] px-3 text-sm font-semibold text-white transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.97]">Discard</button></div></div></div></div>
      {!session ? <SkeletonRows rows={5} label="Loading the task form" /> : <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
        <div className="thin-scroll grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-5 sm:grid-cols-2 sm:px-6">
          <div className="sm:col-span-2"><Field label="Task title"><input ref={titleInput} required maxLength={200} className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs to happen?" /></Field></div>
          {activeVentureId && firstVenture ? <div aria-label="Task destination" className="rounded-xl bg-neutral-50 p-3 text-sm"><span className="block text-xs font-semibold text-neutral-500">Venture</span><span className="font-bold text-neutral-800">{firstVenture.name}</span></div> : <Field label="Venture"><Select className={inputClass} value={ventureId} onChange={(event) => { const next = session.hierarchy.ventures.find((item) => item.id === event.target.value); setVentureId(event.target.value); setGroupId(next?.groups[0]?.id ?? ""); setAssigneeId(""); setReviewerId(""); }}><option value="">Choose venture</option>{session.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>}
          <Field label="Group"><Select className={inputClass} value={groupId} onChange={(event) => { setGroupId(event.target.value); setAssigneeId(""); setReviewerId(""); }}>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
          <LiveMemberPicker label="Assignee" value={assigneeId} onChange={setAssigneeId} ventureId={ventureId} groupId={groupId} />
          <LiveMemberPicker label="Reviewer" value={reviewerId} onChange={setReviewerId} ventureId={ventureId} groupId={groupId} optional />
          <div className="sm:col-span-2"><Field label="Desired outcome"><textarea required className={`${inputClass} min-h-20 py-3`} value={outcome} onChange={(event) => setOutcome(event.target.value)} /></Field></div>
          <Field label="Priority"><Select className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value as Task["priority"])}>{(["low", "medium", "high", "urgent"] as const).map((item) => <option key={item} value={item}>{item}</option>)}</Select></Field>
          <Field label="Due date"><input required type="date" className={inputClass} value={dueDate} onChange={(event) => setDueDate(event.target.value)} /><span className="mt-2 flex flex-wrap gap-1.5">{([["Today", 0], ["Tomorrow", 1], ["Next week", 7]] as const).map(([text, offset]) => <button key={text} type="button" onClick={() => setDueDate(isoDay(offset))} className={chipClass(dueDate === isoDay(offset))}>{text}</button>)}</span></Field>
          <Field label="Estimated minutes"><input required min={1} max={100800} type="number" className={inputClass} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /><span className="mt-2 flex flex-wrap gap-1.5">{([[15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"], [480, "1 day"]] as const).map(([value, text]) => <button key={value} type="button" onClick={() => setMinutes(value)} className={chipClass(minutes === value)}>{text}</button>)}</span></Field>
          <Field label="Tags, comma-separated"><input className={inputClass} value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
          <div data-open={tight} className="vso-collapse sm:col-span-2"><div><p role="status" className="rounded-xl bg-warning-surface p-3 text-xs font-semibold text-warning-text">Deadline risk: {minutes} estimated minutes is more than the time left before 5 PM on the due date. You can still create it; the assignee will be warned.</p></div></div>
          <div className="sm:col-span-2"><Field label="Definition of done"><textarea required className={`${inputClass} min-h-20 py-3`} value={definition} onChange={(event) => setDefinition(event.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Evidence requirement"><textarea required className={`${inputClass} min-h-20 py-3`} value={evidenceRequirement} onChange={(event) => setEvidenceRequirement(event.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label="Details: background, specs, links, plans (optional)"><textarea maxLength={20000} className={`${inputClass} min-h-24 py-3`} value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Markdown works: - lists, ## headings, links" /></Field></div>
          <div className="sm:col-span-2"><Notice tone="error" message={error} onDismiss={() => setError("")} /></div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-4 sm:px-6"><button type="button" onClick={requestClose} className={secondaryClass}>Cancel</button><button disabled={busy || !groupId || !assigneeId} className={primaryClass}>{busy ? "Creating…" : "Create task"}</button></footer>
      </form>}
    </section>
  </div>, document.body);
}

/**
 * Mounted once in the connected shell: opens the task form over whatever screen is showing, confirms with a toast
 * that links to the task, and tells task lists to refresh.
 */
export function NewTaskHost() {
  const router = useRouter();
  const { activeVentureId } = useStudio();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(NEW_TASK_EVENT, onOpen);
    return () => window.removeEventListener(NEW_TASK_EVENT, onOpen);
  }, []);

  // Loaded ahead of time (and refreshed on each open) so the form opens ready, with the current venture chosen.
  useEffect(() => {
    let active = true;
    loadLiveSession().then((value) => { if (active) setSession(value); }, (cause: unknown) => { if (active && open) { setError(describeError(cause, "The task form could not load.")); setOpen(false); } });
    return () => { active = false; };
  }, [open]);

  useEffect(() => { if (error) { toast({ tone: "error", title: "Could not open the task form", body: error }); queueMicrotask(() => setError("")); } }, [error]);

  if (!open) return null;
  return <NewTaskDialog key={`${activeVentureId || "all"}:${session ? "ready" : "loading"}`} session={session} activeVentureId={activeVentureId} onClose={() => setOpen(false)} onCreated={(task) => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent<Task>(TASK_CREATED_EVENT, { detail: task }));
    toast({ title: "Task created", body: task.title, action: { label: "Open task", onClick: () => router.push(`/tasks/live?task=${encodeURIComponent(task.id)}`) } });
  }} />;
}
