"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, ListTodo, Plus, Search, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { openNewTask, TASK_CREATED_EVENT } from "@/components/studio/new-task-dialog";
import type { Task } from "@venture-studio/contracts";
import { listLiveMembers, listLiveTasks, loadLiveSession, restoreLiveTask, type TaskListCounts, type TaskSort, type TaskView } from "@/lib/studio-api";
import { TaskDialog, type TaskTab } from "@/components/studio/task-dialog";
import { toast } from "@/components/ui/toast";
import { Badge, filterControl, HeaderActions, inputClass, Notice, PageFrame, PageTitle, Panel, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { FilterRow, FilterToggle, useFilterToggle } from "@/components/studio/filter-bar";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { flashById } from "@/lib/motion";
import { atRisk, dayStarts, dueBucket, dueLabel, priorityTone, statusLabel, statusTone, TASK_STATUSES, type DueBucket } from "@/lib/task-display";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Status = Task["status"];

const typingTarget = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !!target.closest('[role="combobox"], [role="dialog"]'));
const message = (cause: unknown) => describeError(cause, "The request failed. Please try again.");

const VIEWS: { key: TaskView; label: string; emptyTitle: string; emptyBody: string }[] = [
  { key: "open", label: "Open", emptyTitle: "Nothing open", emptyBody: "Every task here is done, cancelled, or parked." },
  { key: "review", label: "Needs my review", emptyTitle: "Nothing waiting for your review", emptyBody: "Tasks with evidence you can accept or reject show up here." },
  { key: "overdue", label: "Overdue", emptyTitle: "Nothing overdue", emptyBody: "Every open task is on time." },
  { key: "done", label: "Done", emptyTitle: "Nothing finished yet", emptyBody: "Tasks marked done show up here, most recent first." },
  { key: "all", label: "All", emptyTitle: "No tasks here", emptyBody: "Tasks in this venture show up here." },
];
const SORTS: { key: TaskSort; label: string }[] = [{ key: "due", label: "Soonest due" }, { key: "priority", label: "Most urgent" }, { key: "updated", label: "Recently updated" }, { key: "newest", label: "Newest" }];
const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
const DUE_FILTERS = [{ key: "today", label: "Due today" }, { key: "week", label: "Due in the next 7 days" }] as const;
const BUCKETS: DueBucket[] = ["past", "today", "week", "later"];
const bucketLabel = (bucket: DueBucket, view: TaskView) => bucket === "past" ? (view === "all" ? "Before today" : "Overdue") : bucket === "today" ? "Today" : bucket === "week" ? "Next 7 days" : "Later";
const capitalized = (value: string) => value[0]!.toUpperCase() + value.slice(1);
/** Done work reads best newest first; everything else, soonest due first. */
const defaultSort = (view: TaskView): TaskSort => view === "done" ? "updated" : "due";
/** Whether a list can hold tasks in this status (picking one it can't moves to All). */
const viewHolds = (view: TaskView, status: string) => view === "all" ? true : view === "done" ? status === "done" : view === "review" ? !["done", "cancelled"].includes(status) : !["done", "cancelled", "parked"].includes(status);
const pick = <T extends string>(value: string | null, options: readonly T[]) => (options as readonly string[]).includes(value ?? "") ? value as T : undefined;

export function LiveTasksScreen() {
  const { activeVentureId: ventureId } = useStudio();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // The latest link, for changes made later (the search pause, a toast's button) that must not bring back old filters.
  const latestParams = useRef(params);
  useEffect(() => { latestParams.current = params; }, [params]);
  /** Lists, filters, and the open task live in the link, so it can be shared and Back works. */
  const setParams = (patch: Record<string, string | null>) => {
    const current = latestParams.current;
    const next = new URLSearchParams(current);
    for (const [name, value] of Object.entries(patch)) { if (value) next.set(name, value); else next.delete(name); }
    const search = next.toString();
    if (search === current.toString()) return;
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  };
  const view = pick(params.get("view"), VIEWS.map((item) => item.key)) ?? "open";
  const sort = pick(params.get("sort"), SORTS.map((item) => item.key)) ?? defaultSort(view);
  const ownerParam = params.get("owner") ?? "";
  const status = pick(params.get("status"), TASK_STATUSES) ?? "";
  const priority = pick(params.get("priority"), PRIORITIES) ?? "";
  const due = pick(params.get("due"), DUE_FILTERS.map((item) => item.key)) ?? "";
  const q = (params.get("q") ?? "").trim().slice(0, 100);

  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [counts, setCounts] = useState<TaskListCounts | null>(null);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof listLiveMembers>>["items"]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(params.get("task"));
  const [query, setQuery] = useState(q);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const filterView = useFilterToggle("live-tasks");
  const canCreate = !!session && ["admin", "venture_head", "contributor"].includes(session.membership.role);
  const ownerId = ownerParam === "me" ? session?.user.id ?? "" : ownerParam;

  // "/" focuses search and "c" starts a task, unless the member is typing or a task is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typingTarget(event.target) || selectedId) return;
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
      else if (event.key === "c" && canCreate) { event.preventDefault(); openNewTask(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canCreate, selectedId]);

  const linkedTask = useRef(params.get("task"));
  useEffect(() => {
    const taskId = params.get("task"); const before = linkedTask.current;
    linkedTask.current = taskId;
    if (taskId) queueMicrotask(() => setSelectedId(taskId));
    else if (before) queueMicrotask(() => setSelectedId((current) => current === before ? null : current));
  }, [params]);
  // Old links with ?new=1 still open the form (the shared popup), then drop the parameter.
  useEffect(() => { if (params.get("new") === "1") queueMicrotask(() => { openNewTask(); setParams({ new: null }); }); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  // A task created in the popup appears in the list and opens, as it did with the old drawer.
  useEffect(() => {
    const onCreated = (event: Event) => { const task = (event as CustomEvent<Task>).detail; setSelectedId(task.id); setRevision((value) => value + 1); flashById(task.id); };
    window.addEventListener(TASK_CREATED_EVENT, onCreated);
    return () => window.removeEventListener(TASK_CREATED_EVENT, onCreated);
  }, []);
  // Typing searches on the server after a short pause.
  const searchTimer = useRef(0);
  const written = useRef(q);
  useEffect(() => {
    const trimmed = query.trim();
    window.clearTimeout(searchTimer.current);
    if (trimmed === (latestParams.current.get("q") ?? "").trim()) return;
    searchTimer.current = window.setTimeout(() => { written.current = trimmed; setParams({ q: trimmed || null }); }, 300);
    return () => window.clearTimeout(searchTimer.current);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  // A search changed elsewhere (a link, Back) shows in the box; the box's own writes don't echo back over typing.
  useEffect(() => {
    if (q === written.current) return;
    written.current = q;
    window.clearTimeout(searchTimer.current);
    queueMicrotask(() => setQuery(q));
  }, [q]);

  /** The list's filters for the server; "me" needs the session first. */
  const filters = (me: string) => {
    const { today, tomorrow, week } = dayStarts();
    return {
      view, sort, ...(ventureId ? { ventureId } : {}), ...(ownerParam ? { assigneeId: ownerParam === "me" ? me : ownerParam } : {}),
      ...(status ? { status: status as Status } : {}), ...(priority ? { priority } : {}), ...(q ? { q } : {}),
      ...(due ? { dueFrom: today.toISOString(), dueTo: (due === "today" ? tomorrow : week).toISOString() } : {}),
    };
  };

  // Who is signed in and everyone's names: on arrival and after a change, not on every switch of list or filter.
  useEffect(() => {
    let active = true;
    Promise.all([loadLiveSession(), listLiveMembers({ limit: 100 }).catch(() => null)]).then(([nextSession, directory]) => {
      if (!active) return;
      setSession(nextSession); if (directory) setMembers(directory.items);
    }).catch((cause: unknown) => { if (active) { setError(message(cause)); setBusy(false); } });
    return () => { active = false; };
  }, [revision]);

  // Only the latest request may fill the list, so a slow answer (or "Load more") for old filters is dropped.
  const generation = useRef(0);
  const countedFor = useRef("");
  const me = ownerParam === "me" ? session?.user.id ?? "" : "";
  useEffect(() => {
    if (ownerParam === "me" && !me) return; // waits for the session
    const current = ++generation.current;
    // Counts follow the venture, people, priority, and search, so switching lists, sorts, or status doesn't recount.
    const countsKey = [ventureId, ownerParam === "me" ? me : ownerParam, priority, q, revision].join("|");
    queueMicrotask(() => {
      setBusy(true);
      listLiveTasks(undefined, { ...filters(me), counts: countedFor.current !== countsKey }).then((first) => {
        if (current !== generation.current) return;
        setTasks(first.items); setCursor(first.nextCursor); setError(""); setBusy(false);
        if (first.counts) { setCounts(first.counts); countedFor.current = countsKey; }
      }).catch((cause: unknown) => { if (current === generation.current) { setError(message(cause)); setBusy(false); } });
    });
  }, [ventureId, view, sort, ownerParam, status, priority, due, q, revision, me]); // eslint-disable-line react-hooks/exhaustive-deps

  async function more() {
    if (!cursor) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await listLiveTasks(cursor, filters(me));
      if (current !== generation.current) return;
      setTasks((items) => [...items, ...page.items]); setCursor(page.nextCursor); setError("");
    }
    catch (cause) { if (current === generation.current) setError(message(cause)); }
    finally { setLoadingMore(false); }
  }

  const memberName = (id: string) => members.find((member) => member.id === id)?.name ?? (id === session?.user.id ? session.user.name : "Assigned member");
  const activeFilters = [ownerParam, status, priority, due].filter(Boolean).length;
  const filtered = activeFilters > 0 || !!q;
  const clearFilters = () => { setQuery(""); setParams({ owner: null, status: null, priority: null, due: null, q: null }); };
  const chooseView = (key: string) => {
    const next = key as TaskView;
    setParams({ view: next === "open" ? null : next, ...(sort === defaultSort(next) ? { sort: null } : {}), ...(status && !viewHolds(next, status) ? { status: null } : {}) });
  };
  const chooseStatus = (value: string) => setParams({ status: value || null, ...(value && !viewHolds(view, value) ? { view: "all", ...(sort === defaultSort("all") ? { sort: null } : {}) } : {}) });
  const refresh = () => setRevision((value) => value + 1);
  // A failed load is an error, never an empty list; the error state carries the message, so the notice stays quiet.
  const failedWithoutTasks = !!error && !tasks.length;
  const loadFailed = failedWithoutTasks && !busy;
  const firstRun = !!counts && counts.all === 0 && !filtered && !busy && !error;
  const viewInfo = VIEWS.find((item) => item.key === view)!;
  const searchLabel = q.length > 32 ? `${q.slice(0, 32)}…` : q;
  const now = new Date();
  // Soonest-due lists read in date sections; one section would only repeat the tab, so Overdue has none.
  const sections = sort === "due" && view !== "overdue" && view !== "done"
    ? BUCKETS.map((bucket) => ({ key: bucket, label: bucketLabel(bucket, view), items: tasks.filter((task) => dueBucket(task, now, view !== "all") === bucket) })).filter((section) => section.items.length)
    : [{ key: "list", label: "", items: tasks }];
  const badge = (key: TaskView) => counts && (key === "open" || (key !== "done" && key !== "all" && counts[key] > 0)) ? counts[key] : undefined;

  const row = (task: Task) => {
    const dueText = dueLabel(task, now);
    return <button key={task.id} type="button" data-flash-id={task.id} onClick={() => setSelectedId(task.id)} className="group flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:bg-neutral-100">
      <span className="min-w-0 flex-1">
        <span className="mb-1 flex flex-wrap items-center gap-2"><span className="min-w-0 text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere]">{task.title}</span><Badge tone={priorityTone(task)}>{task.priority}</Badge>{atRisk(task) && <Badge tone="amber">Deadline risk</Badge>}{view === "review" && <Badge tone="purple">Evidence to review</Badge>}</span>
        <span className="block line-clamp-2 text-sm leading-5 text-neutral-500 [overflow-wrap:anywhere]">{task.outcome}</span>
        <span className="mt-1 block text-xs text-neutral-400">{session?.hierarchy.ventures.find((item) => item.id === task.ventureId)?.name ?? "Venture"} · {memberName(task.assigneeId)}{task.reviewerId ? ` → ${memberName(task.reviewerId)}` : ""}</span>
      </span>
      <span className="text-right"><Badge tone={statusTone(task)}>{statusLabel(task.status)}</Badge><span title={new Date(task.dueAt).toLocaleString()} className={clsx("mt-1 block text-xs font-semibold tnum", dueText.tone === "red" ? "text-danger-text" : dueText.tone === "amber" ? "text-warning-text" : "text-neutral-500")}>{dueText.text}</span></span>
      <ArrowRight size={15} className="text-neutral-400 transition-transform duration-150 group-hover:translate-x-0.5" />
    </button>;
  };

  return <PageFrame><PageTitle title="Tasks" description="Track assignments, evidence, reviews, and activity." action={<HeaderActions><RefreshButton busy={busy && !!session} onClick={refresh} />{!firstRun && <FilterToggle open={filterView.open} onToggle={filterView.toggle} rowId={filterView.rowId} count={counts && !status && !due ? counts[view] : tasks.length} noun="task" active={activeFilters} />}</HeaderActions>} />
    <Notice tone="error" message={failedWithoutTasks ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    {!firstRun && <FilterRow open={filterView.open} rowId={filterView.rowId} active={activeFilters} onClear={() => setParams({ owner: null, status: null, priority: null, due: null })}>
      <button type="button" aria-pressed={ownerParam === "me"} onClick={() => setParams({ owner: ownerParam === "me" ? null : "me" })} className={filterControl(ownerParam === "me")}>Assigned to me</button>
      <LiveMemberPicker compact label="Assignee" emptyLabel="Any assignee" value={ownerId} onChange={(id) => setParams({ owner: !id ? null : id === session?.user.id ? "me" : id })} ventureId={ventureId || undefined} optional />
      <Select aria-label="Status" className={filterControl(!!status)} value={status} onChange={(event) => chooseStatus(event.target.value)}><option value="">Any status</option>{TASK_STATUSES.map((item) => <option key={item} value={item}>{capitalized(statusLabel(item))}</option>)}</Select>
      <Select aria-label="Priority" className={filterControl(!!priority)} value={priority} onChange={(event) => setParams({ priority: event.target.value || null })}><option value="">Any priority</option>{PRIORITIES.map((item) => <option key={item} value={item}>{capitalized(item)}</option>)}</Select>
      <Select aria-label="Due date" className={filterControl(!!due)} value={due} onChange={(event) => setParams({ due: event.target.value || null })}><option value="">Any due date</option>{DUE_FILTERS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select>
    </FilterRow>}
    {firstRun ? <EmptyState variant="page" icon={ListTodo} tone="green" title="No tasks yet" body="Tasks you create or are assigned land here, with their evidence and reviews." action={canCreate ? { label: "Create task", icon: Plus, onClick: openNewTask } : undefined} secondary={{ label: "Open the board", href: "/board/live" }} /> : <Panel>
      <div className="space-y-3 border-b border-neutral-100 p-4">
        <div>
          <label className="relative block min-w-0"><Search size={16} className="pointer-events-none absolute left-3 top-3.5 text-neutral-400" /><input ref={searchRef} aria-label="Search tasks" aria-keyshortcuts="/" maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} placeholder="Search titles, outcomes, and tags" className={`${inputClass} pl-9 pr-10`} />{query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }} className="vso-fade-enter absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700"><X size={14} /></button> : <kbd aria-hidden="true" className="pointer-events-none absolute right-3 top-3 hidden rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neutral-400 sm:block">/</kbd>}</label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1"><SlidingTabs label="Task lists" className="bg-neutral-100 shadow-none" active={view} onChange={chooseView} tabs={VIEWS.map((item) => ({ key: item.key, label: item.label, badge: badge(item.key) }))} /></div>
          <div className="w-full sm:w-48 sm:shrink-0"><Select aria-label="Sort by" value={sort} onChange={(event) => setParams({ sort: event.target.value === defaultSort(view) ? null : event.target.value })} className={inputClass}>{SORTS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select></div>
        </div>
      </div>
      {tasks.length ? <div aria-busy={busy || undefined} className={clsx("vso-stagger-in transition-opacity duration-200", busy && "opacity-60")}>{sections.map((section) => <div key={section.key} className="border-b border-neutral-100 last:border-b-0">
        {section.label && <h3 className={clsx("flex items-center gap-2 border-b border-neutral-100 bg-neutral-50/70 px-5 py-2 text-[11px] font-bold uppercase tracking-wide", section.key === "past" && view !== "all" ? "text-danger-text" : "text-neutral-500")}>{section.label}<span className="font-semibold text-neutral-400 tnum">{section.items.length}</span></h3>}
        <div className="divide-y divide-neutral-100">{section.items.map(row)}</div>
      </div>)}</div>
      : loadFailed ? <EmptyState variant="error" title="Could not load tasks" body={error} action={{ label: "Try again", onClick: refresh }} />
      : busy ? <SkeletonRows rows={5} label="Loading tasks" />
      : filtered ? <EmptyState variant="filtered" title={searchLabel ? `No tasks match "${searchLabel}"` : "No tasks match these filters"} body={`Nothing in ${viewInfo.label} matches. Try different words or filters, or clear them.`} action={{ label: "Clear filters", onClick: clearFilters }} />
      : <EmptyState variant="filtered" icon={ListTodo} title={viewInfo.emptyTitle} body={viewInfo.emptyBody} />}
      {cursor && <div className="border-t border-neutral-100 p-4 text-center"><button type="button" disabled={loadingMore || busy} onClick={more} className={secondaryClass}>{loadingMore ? "Loading…" : "Load more"}</button></div>}
    </Panel>}
    {session && selectedId && <TaskDialog key={selectedId} id={selectedId} session={session} memberName={memberName} initialTab={(params.get("tab") ?? undefined) as TaskTab | undefined}
      onClose={() => { setSelectedId(null); setParams({ task: null, tab: null }); }} onChanged={refresh}
      onDeleted={(task, deletionId) => {
        setTasks((items) => items.filter((item) => item.id !== task.id));
        refresh();
        let undone = false;
        toast({ title: "Task deleted", body: task.title, duration: 10_000, action: { label: "Undo", onClick: () => { if (undone) return; undone = true; void restoreLiveTask(deletionId).then((restored) => { refresh(); toast({ title: "Task restored", body: restored.title, action: { label: "Open", onClick: () => { const next = new URLSearchParams(latestParams.current); next.set("task", restored.id); next.delete("tab"); router.push(`${pathname}?${next}`); } } }); }, (cause: unknown) => toast({ tone: "error", title: "Couldn't restore the task", body: message(cause) })); } } });
      }} />}
  </PageFrame>;
}
