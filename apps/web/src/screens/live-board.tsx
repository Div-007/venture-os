"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useBoardMotion } from "@/components/ui/use-board-motion";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import Link from "next/link";
import { Columns3, Inbox, LayoutGrid, Plus, type Icon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { openNewTask, TASK_CREATED_EVENT } from "@/components/studio/new-task-dialog";
import type { Task } from "@venture-studio/contracts";
import { listLiveTasks, loadLiveSession, updateLiveTask } from "@/lib/studio-api";
import { Badge, filterControl, HeaderActions, HeaderLabel, Notice, PageFrame, PageTitle, Panel, RefreshButton, secondaryClass } from "@/components/studio/primitives";
import { FilterRow, FilterToggle, useFilterToggle } from "@/components/studio/filter-bar";
import { toast } from "@/components/ui/toast";
import { replayAnimation } from "@/lib/motion";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Status = Task["status"];
const statuses: Status[] = ["draft", "proposed", "accepted", "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled", "parked"];
const columns = ["Backlog", "Ready", "In progress", "In review", "Blocked", "Done"] as const;
type Column = typeof columns[number];
const columnStatus: Record<Column, Status> = { Backlog: "backlog", Ready: "todo", "In progress": "in_progress", "In review": "review", Blocked: "blocked", Done: "done" };
const columnForStatus = (status: Status): Column => status === "done" ? "Done" : status === "blocked" ? "Blocked" : status === "review" ? "In review" : status === "in_progress" ? "In progress" : status === "accepted" || status === "todo" ? "Ready" : "Backlog";
const label = (value: string) => value.replaceAll("_", " ");

/** Grid wraps the columns to the page; Row keeps them in one sideways-scrolling line. Remembered per browser. */
type Layout = "grid" | "row";
const LAYOUT_KEY = "vso-board-layout:live-board";
const layoutOptions: { key: Layout; text: string; icon: Icon }[] = [{ key: "grid", text: "Grid", icon: LayoutGrid }, { key: "row", text: "Row", icon: Columns3 }];
const rowColumn = "w-[18.5rem] shrink-0";


function LayoutSwitch({ layout, onChange }: { layout: Layout; onChange: (layout: Layout) => void }) {
  return <div role="group" aria-label="Board layout" className="inline-flex rounded-lg bg-neutral-100 p-0.5">{layoutOptions.map(({ key, text, icon: OptionIcon }) => <button key={key} type="button" aria-pressed={layout === key} onClick={() => onChange(key)} className={clsx("inline-flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-[background-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97] sm:px-2.5", layout === key ? "bg-white text-neutral-900" : "text-neutral-500 hover:text-neutral-800")}><OptionIcon size={15} aria-hidden="true" /><HeaderLabel>{text}</HeaderLabel></button>)}</div>;
}

export function LiveBoardScreen() {
  const { activeVentureId: ventureId } = useStudio();
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [groupId, setGroupId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [tag, setTag] = useState("");
  const filterView = useFilterToggle("live-board");
  const [busy, setBusy] = useState(false);
  // True once the first task page has answered, so the empty board never flashes before data arrives.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // A task created from the top bar's popup shows up without a manual refresh.
  useEffect(() => { const onCreated = () => setRevision((value) => value + 1); window.addEventListener(TASK_CREATED_EVENT, onCreated); return () => window.removeEventListener(TASK_CREATED_EVENT, onCreated); }, []);
  const [loadingMore, setLoadingMore] = useState(false);
  // Cards with a move in flight; only they stop being draggable.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [sessionTry, setSessionTry] = useState(0);
  const [layout, setLayout] = useState<Layout>("grid");
  const router = useRouter();

  // The layout choice is remembered per browser, like the filter row (best effort).
  useEffect(() => {
    try { if (localStorage.getItem(LAYOUT_KEY) === "row") queueMicrotask(() => setLayout("row")); } catch { /* storage unavailable: stay on the grid */ }
  }, []);
  const chooseLayout = (next: Layout) => {
    setLayout(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* storage unavailable */ }
  };

  useEffect(() => { queueMicrotask(() => { setGroupId(""); setAssigneeId(""); }); }, [ventureId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => { if (active) setSession(value); }).catch((cause: unknown) => { if (active) { setError(describeError(cause, "Could not load the workspace.")); setBusy(false); } }));
    return () => { active = false; };
  }, [sessionTry]);
  useEffect(() => {
    if (!session) return;
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      listLiveTasks(undefined, { ...(ventureId ? { ventureId } : {}), ...(groupId ? { groupId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(priority ? { priority: priority as Task["priority"] } : {}), ...(tag ? { tag } : {}) }).then((page) => {
        if (active) { setTasks(page.items); setCursor(page.nextCursor); setError(""); setBusy(false); setLoaded(true); }
      }).catch((cause: unknown) => { if (active) { setError(describeError(cause, "Could not load the board.")); setBusy(false); setLoaded(true); } });
    });
    return () => { active = false; };
  }, [session, ventureId, groupId, assigneeId, priority, tag, revision]);

  const groups = session?.hierarchy.ventures.filter((item) => !ventureId || item.id === ventureId).flatMap((item) => item.groups) ?? [];
  const ventureNames = new Map(session?.hierarchy.ventures.map((item) => [item.id, item.name]) ?? []);
  const editable = (task: Task) => session && (["admin", "venture_head"].includes(session.membership.role) || task.assigneeId === session.user.id);

  const shake = (taskId: string) => requestAnimationFrame(() => replayAnimation(document.querySelector(`[data-flip-id="${CSS.escape(taskId)}"]`), "vso-shake"));
  const setPendingId = (taskId: string, on: boolean) => setPending((current) => { const next = new Set(current); if (on) next.add(taskId); else next.delete(taskId); return next; });

  const { rootRef: boardRef, capture, cardProps, columnProps, draggingId, overColumn, refocus } = useBoardMotion<Column>((taskId, column) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || pending.has(taskId) || !editable(task) || columnForStatus(task.status) === column) return false;
    return move(task, columnStatus[column]);
  }, { scrollAxis: layout === "row" ? "x" : "page" });

  /** Moves a card at once and saves in the background; a failed save glides it back. Callers run capture() first. */
  function move(task: Task, status: Status) {
    if (status === task.status) return false;
    if (status === "blocked" && !task.blocker) {
      shake(task.id);
      toast({ id: `blocker-${task.id}`, tone: "error", title: "Add the blocker first", body: "Record what is blocking this task before moving it to Blocked.", action: { label: "Open task", onClick: () => router.push(`/tasks/live?task=${encodeURIComponent(task.id)}`) } });
      return false;
    }
    setError("");
    setTasks((items) => items.map((item) => item.id === task.id ? { ...item, status } : item));
    setPendingId(task.id, true);
    updateLiveTask(task.id, { status, ...(status !== "blocked" && task.blocker ? { blocker: null } : {}) })
      .then((changed) => setTasks((items) => items.map((item) => item.id === changed.id ? changed : item)))
      .catch((cause: unknown) => {
        capture();
        setTasks((items) => items.map((item) => item.id === task.id ? task : item));
        shake(task.id);
        toast({ tone: "error", title: "Could not move the task", body: describeError(cause, "The change was not saved.") });
      })
      .finally(() => setPendingId(task.id, false));
    return true;
  }

  const boardTasks = tasks.filter((task) => task.status !== "cancelled");

  async function more() {
    if (!cursor || !session) return;
    setLoadingMore(true);
    try { const page = await listLiveTasks(cursor, { ...(ventureId ? { ventureId } : {}), ...(groupId ? { groupId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(priority ? { priority: priority as Task["priority"] } : {}), ...(tag ? { tag } : {}) }); setTasks((items) => [...items, ...page.items]); setCursor(page.nextCursor); setError(""); }
    catch (cause) { setError(describeError(cause, "Could not load more tasks.")); }
    finally { setLoadingMore(false); }
  }

  const activeFilters = [groupId, assigneeId, priority, tag].filter(Boolean).length;
  const clearFilters = () => { setGroupId(""); setAssigneeId(""); setPriority(""); setTag(""); setTagDraft(""); };
  const canCreate = !!session && ["admin", "venture_head", "contributor"].includes(session.membership.role);
  const row = layout === "row";

  // Which of the board's states applies. A failed load is an error, never an empty board.
  const failedWithoutTasks = !!error && !boardTasks.length;
  const loadFailed = failedWithoutTasks && !busy;
  const loading = !loadFailed && (!session || !loaded || (busy && !boardTasks.length));
  const settledEmpty = !loadFailed && !loading && !boardTasks.length;
  const firstRun = settledEmpty && activeFilters === 0;
  const filteredOut = settledEmpty && activeFilters > 0;
  // With nothing on the board there is nothing to filter or lay out, so those controls step aside.
  const showControls = !firstRun && !(loadFailed && activeFilters === 0);
  const retry = () => { if (session) setRevision((value) => value + 1); else { setBusy(true); setSessionTry((value) => value + 1); } };

  return <PageFrame><PageTitle title="Kanban board" description="Move work through clear stages; each card retains its precise task status." action={<HeaderActions><RefreshButton busy={busy && !!session} onClick={() => setRevision((value) => value + 1)} />{showControls && (activeFilters > 0 || !loading) && <FilterToggle open={filterView.open} onToggle={filterView.toggle} rowId={filterView.rowId} count={boardTasks.length} noun="task" active={activeFilters} />}</HeaderActions>} />
    <Notice tone="error" message={failedWithoutTasks ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    {showControls && <FilterRow open={filterView.open} rowId={filterView.rowId} active={activeFilters} onClear={clearFilters}>
      <Select aria-label="Group" className={filterControl(!!groupId)} value={groupId} onChange={(event) => { setGroupId(event.target.value); setAssigneeId(""); }}><option value="">All groups</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
      <LiveMemberPicker compact label="Assignee" emptyLabel="All assignees" value={assigneeId} onChange={setAssigneeId} ventureId={ventureId || undefined} groupId={groupId || undefined} optional />
      <Select aria-label="Priority" className={filterControl(!!priority)} value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">All priorities</option>{(["low", "medium", "high", "urgent"] as const).map((item) => <option key={item} value={item}>{item[0]!.toUpperCase() + item.slice(1)}</option>)}</Select>
      {/* Tags are free text: Enter (or leaving the field) applies what was typed. */}
      <form onSubmit={(event) => { event.preventDefault(); setTag(tagDraft.trim()); }}><input aria-label="Tag" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onBlur={() => setTag(tagDraft.trim())} className={clsx(filterControl(!!tag), "w-36")} placeholder="Tag…" /></form>
    </FilterRow>}
    <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs font-semibold text-neutral-500"><span className="flex items-center gap-1"><Columns3 size={15} />{boardTasks.length} task{boardTasks.length === 1 ? "" : "s"} loaded{tasks.length !== boardTasks.length ? ` · ${tasks.length - boardTasks.length} cancelled hidden` : ""}{cursor ? " · more available" : ""}</span><div className="flex items-center gap-3">{showControls && <LayoutSwitch layout={layout} onChange={chooseLayout} />}<Link href="/tasks/live" className="font-bold text-primary-700 hover:underline">Open task list</Link></div></div>
    {loadFailed ? <Panel><EmptyState variant="error" title="Could not load the board" body={error} action={{ label: "Try again", onClick: retry }} /></Panel>
    : loading ? <div role="status" aria-label="Loading the board" className={row ? "flex min-w-0 gap-3 overflow-hidden" : "grid min-w-0 gap-3 lg:grid-cols-3 2xl:grid-cols-6"}>{columns.map((column) => <Panel key={column} className={clsx("min-h-48 space-y-2 p-3", row && rowColumn)}><span className="vso-skeleton mb-3 h-4 w-24" /><span className="vso-skeleton h-24 rounded-xl" /><span className="vso-skeleton h-20 rounded-xl opacity-70" /></Panel>)}</div>
    : filteredOut ? <Panel><EmptyState variant="filtered" title="No tasks match these filters" body="Try different filters, or clear them to see the whole board." action={{ label: "Clear filters", onClick: clearFilters }} /></Panel>
    : firstRun ? <EmptyState variant="page" icon={Columns3} tone="blue" title="Your board is empty" body="Create a task and it starts in Backlog. Drag it across as the work moves." action={canCreate ? { label: "Create task", icon: Plus, onClick: openNewTask } : undefined} />
    : <div ref={boardRef} className={clsx("vso-fade-enter min-w-0", row ? "thin-scroll -mx-1 flex gap-3 overflow-x-auto px-1 pb-3 pt-1" : "grid gap-3 lg:grid-cols-3 2xl:grid-cols-6")} aria-label="Live task board">{columns.map((column) => { const cards = boardTasks.filter((task) => columnForStatus(task.status) === column); const draggingFromHere = cards.some((task) => task.id === draggingId); const over = overColumn === column && !!draggingId && !draggingFromHere; const addHere = column === columns[0] && canCreate; return <div key={column} className={clsx("min-w-0", row && rowColumn)} {...columnProps(column)}><Panel className={clsx("p-3 transition-[border-color,box-shadow] duration-150", cards.length > 0 && "min-h-48", row && "h-full", over && "border-primary-500 ring-2 ring-primary-300")}><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-neutral-800">{column}</h2><Badge><span key={cards.length} className="vso-label-swap tnum">{cards.length}</span></Badge></div><div className="space-y-2">{cards.map((task) => { const canMove = !!editable(task) && !pending.has(task.id); return <article key={task.id} {...cardProps(task.id, canMove)} aria-busy={pending.has(task.id) || undefined} className={clsx("relative min-w-0 rounded-xl border border-neutral-100 bg-neutral-50 p-3 transition-[border-color,box-shadow,opacity] duration-150", canMove && "cursor-grab hover:border-neutral-200 hover:shadow-sm", draggingId === task.id && "border-dashed !border-primary-300 opacity-40 !shadow-none")}><div className="flex flex-wrap gap-1"><Badge tone={task.priority === "urgent" || task.priority === "high" ? "red" : "neutral"}>{task.priority}</Badge><Badge>{label(task.status)}</Badge>{task.deadlineRisk && !["done", "cancelled", "parked"].includes(task.status) && <Badge tone="amber">Deadline risk</Badge>}</div><Link href={`/tasks/live?task=${encodeURIComponent(task.id)}`} draggable={false} className="mt-2 block text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere] hover:text-primary-700 hover:underline">{task.title}</Link><p className="mt-1 text-xs text-neutral-500">{ventureNames.get(task.ventureId) ?? "Venture"}</p><p className="mt-1 text-xs text-neutral-400">Due {new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(task.dueAt))}</p>{editable(task) && <Select aria-label={`Move ${task.title}`} disabled={pending.has(task.id)} value={task.status} onChange={(event) => { capture(); if (move(task, event.target.value as Status)) refocus(task.id); }} className="mt-3 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs font-semibold capitalize text-neutral-600">{statuses.map((item) => <option key={item} value={item} disabled={item === "blocked" && !task.blocker && task.status !== "blocked"}>{label(item)}</option>)}</Select>}</article>; })}{over && <div aria-hidden="true" className="vso-fade-enter grid min-h-14 place-items-center rounded-xl border-2 border-dashed border-primary-300 bg-primary-50 text-xs font-semibold text-primary-700">Drop here</div>}{!cards.length && !over && <EmptyState variant="column" icon={addHere ? Plus : Inbox} title={addHere ? "Add a task" : "Drop a task here"} className={addHere ? "relative transition-colors duration-150 hover:border-primary-300 hover:text-primary-700" : undefined}>{addHere && <button type="button" onClick={openNewTask} aria-label="Create task" className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600" />}</EmptyState>}</div></Panel></div>; })}</div>}
    {cursor && !loadFailed && <div className="mt-4 text-center"><button type="button" disabled={loadingMore} onClick={more} className={secondaryClass}>{loadingMore ? "Loading…" : "Load more tasks"}</button></div>}
  </PageFrame>;
}
