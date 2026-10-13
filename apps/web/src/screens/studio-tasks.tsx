"use client";

import { Select } from "@/components/ui/select";
import { useKanbanDnd } from "@/components/ui/use-kanban-dnd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "@/components/shell/demo-link";
import { Clock3, Plus, Search } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";
import { displayDate, personName, type Task, type TaskStatus, ventureName } from "@/lib/studio-demo";
import { Badge, DetailDrawer, Empty, Field, filterControl, inputClass, PageFrame, PageTitle, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { FilterRow, FilterToggle, useFilterToggle } from "@/components/studio/filter-bar";

const statuses: TaskStatus[] = ["Backlog", "Ready", "In progress", "In review", "Blocked", "Done"];
const newTask = (ventureId: string, groupId: string, userId: string): Task => ({ id: `task-${Date.now()}`, ventureId, groupId, title: "", outcome: "", ownerId: userId, reviewerId: userId, priority: "P2", dueAt: "2026-09-30", reviewAt: "2026-09-30", effort: "", doneWhen: "", dependencies: "", evidence: "", status: "Backlog", blocker: "", accepted: false, tags: [], activity: ["Draft created"], reminderAt: "" });

function TaskEditor({ task, fresh, onClose }: { task: Task; fresh: boolean; onClose: () => void }) {
  const { data, updateSection } = useStudio();
  const [draft, setDraft] = useState(task);
  const [error, setError] = useState("");
  const set = <K extends keyof Task>(key: K, value: Task[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  const save = () => {
    if (!draft.title.trim() || !draft.outcome.trim() || !draft.doneWhen.trim() || !draft.dueAt || !draft.reviewAt) { setError("Add a title, desired outcome, definition of done, due date, and review date."); return; }
    if (draft.status === "Done" && !draft.evidence.trim()) { setError("Completion needs evidence or a recorded exception in the evidence field."); return; }
    if (draft.status === "Blocked" && !draft.blocker.trim()) { setError("Describe the blocker so the reviewer can act."); return; }
    const saved = { ...draft, activity: [...draft.activity, `${fresh ? "Created" : "Updated"} in the demo workspace`] };
    updateSection("tasks", (items) => fresh ? [saved, ...items] : items.map((item) => item.id === saved.id ? saved : item));
    onClose();
  };
  const groups = data.groups.filter((group) => group.ventureId === draft.ventureId);
  return <DetailDrawer title={fresh ? "Draft task" : draft.title} subtitle="Complete work assignment · demo data" onClose={onClose}><div className="grid gap-4 sm:grid-cols-2">
    <Field label="Task title"><input className={inputClass} value={draft.title} onChange={(event) => set("title", event.target.value)} placeholder="Actionable task name" /></Field>
    <Field label="Venture"><Select className={inputClass} value={draft.ventureId} onChange={(event) => { const ventureId = event.target.value; setDraft((item) => ({ ...item, ventureId, groupId: data.groups.find((group) => group.ventureId === ventureId)?.id ?? "" })); }}>{data.ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>
    <div className="sm:col-span-2"><Field label="Desired outcome"><textarea className={clsx(inputClass,"min-h-20 py-3")} value={draft.outcome} onChange={(event) => set("outcome",event.target.value)} placeholder="What result should exist?" /></Field></div>
    <Field label="Group"><Select className={inputClass} value={draft.groupId} onChange={(event) => set("groupId",event.target.value)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</Select></Field>
    <Field label="Priority"><Select className={inputClass} value={draft.priority} onChange={(event) => set("priority", event.target.value as Task["priority"])}><option>P1</option><option>P2</option><option>P3</option></Select></Field>
    <Field label="Owner"><Select className={inputClass} value={draft.ownerId} onChange={(event) => set("ownerId",event.target.value)}>{data.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Select></Field>
    <Field label="Reviewer"><Select className={inputClass} value={draft.reviewerId} onChange={(event) => set("reviewerId",event.target.value)}>{data.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Select></Field>
    <Field label="Due date"><input className={inputClass} type="date" value={draft.dueAt} onChange={(event) => set("dueAt",event.target.value)} /></Field>
    <Field label="Review date"><input className={inputClass} type="date" value={draft.reviewAt} onChange={(event) => set("reviewAt",event.target.value)} /></Field>
    <Field label="Estimated focused effort"><input className={inputClass} value={draft.effort} onChange={(event) => set("effort",event.target.value)} placeholder="e.g. 90 minutes" /></Field>
    <Field label="Status"><Select className={inputClass} value={draft.status} onChange={(event) => set("status",event.target.value as TaskStatus)}>{statuses.map((status) => <option key={status}>{status}</option>)}</Select></Field>
    <div className="sm:col-span-2"><Field label="Definition of done"><textarea className={clsx(inputClass,"min-h-20 py-3")} value={draft.doneWhen} onChange={(event) => set("doneWhen",event.target.value)} placeholder="Evidence the reviewer should see" /></Field></div>
    <div className="sm:col-span-2"><Field label="Dependencies"><input className={inputClass} value={draft.dependencies} onChange={(event) => set("dependencies",event.target.value)} placeholder="Required input, decision, or person" /></Field></div>
    <div className="sm:col-span-2"><Field label="Evidence link or recorded exception"><input className={inputClass} value={draft.evidence} onChange={(event) => set("evidence",event.target.value)} placeholder="Source URL, record ID, or explicit exception" /></Field></div>
    <div className="sm:col-span-2"><Field label="Blocker"><input className={inputClass} value={draft.blocker} onChange={(event) => set("blocker",event.target.value)} placeholder="What is stopping this task?" /></Field></div>
    <Field label="Reminder"><input className={inputClass} type="datetime-local" value={draft.reminderAt?.slice(0,16) ?? ""} onChange={(event) => set("reminderAt",event.target.value)} /></Field>
    <Field label="Tags"><input className={inputClass} value={draft.tags.join(", ")} onChange={(event) => set("tags",event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean))} placeholder="research, sales" /></Field>
    <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-4"><label className="flex items-center gap-2 text-sm font-semibold text-neutral-700"><input type="checkbox" role="switch" checked={draft.accepted} onChange={(event) => set("accepted",event.target.checked)} className="vso-toggle" />Owner accepted assignment</label><div className="flex gap-2"><button onClick={onClose} className={secondaryClass}>Cancel</button><button onClick={save} className={primaryClass}>{fresh ? "Create task" : "Save changes"}</button></div></div>
    {error && <p role="alert" className="sm:col-span-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    {!fresh && <div className="sm:col-span-2 border-t border-neutral-100 pt-4"><h3 className="text-sm font-semibold text-neutral-800">Activity history</h3><ul className="mt-2 space-y-1 text-sm text-neutral-500">{draft.activity.map((event, index) => <li key={`${index}-${event}`}>· {event}</li>)}</ul></div>}
  </div></DetailDrawer>;
}

export function TasksScreen() {
  const { data, currentUserId } = useStudio();
  const params = useSearchParams();
  const [query,setQuery] = useState("");
  const [scope,setScope] = useState("All owners");
  const [venture,setVenture] = useState("All ventures");
  const [status,setStatus] = useState("All statuses");
  const [selected,setSelected] = useState<Task | null>(null);
  const [fresh,setFresh] = useState(false);
  const handledQuery = useRef("");
  useEffect(() => { const queryKey = params.toString(); if (handledQuery.current === queryKey) return; handledQuery.current = queryKey; queueMicrotask(() => { if (params.get("new") === "1") { setSelected(newTask(data.ventures[0]?.id ?? "",data.groups[0]?.id ?? "",currentUserId)); setFresh(true); } else if (params.get("task")) { const found = data.tasks.find((task) => task.id === params.get("task")); if (found) { setSelected(found); setFresh(false); } } }); }, [params, data.tasks, data.groups, data.ventures, currentUserId]);
  const rows = useMemo(() => data.tasks.filter((task) => (scope !== "Mine" || task.ownerId === currentUserId) && (venture === "All ventures" || task.ventureId === venture) && (status === "All statuses" || task.status === status) && `${task.title} ${task.outcome} ${task.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())), [data.tasks,scope,venture,status,query,currentUserId]);
  const openNew = () => { setSelected(newTask(data.ventures[0]?.id ?? "",data.groups[0]?.id ?? "",currentUserId)); setFresh(true); };
  return <PageFrame><PageTitle title="Tasks" description="Every assignment carries an owner, outcome, review, and evidence requirement." action={<div className="flex flex-wrap gap-2"><Link href="/tasks/live" className={secondaryClass}>Workspace tasks</Link><button type="button" onClick={openNew} className={primaryClass}><Plus size={16} />Draft task</button></div>} />
    <Panel><div className="grid gap-2 border-b border-neutral-100 p-4 sm:grid-cols-2 xl:grid-cols-[minmax(200px,1fr)_repeat(3,160px)]"><label className="relative"><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work and tags" className={clsx(inputClass,"pl-9")} /></label><Select aria-label="Owner filter" value={scope} onChange={(event) => setScope(event.target.value)} className={inputClass}><option>All owners</option><option>Mine</option></Select><Select aria-label="Venture filter" value={venture} onChange={(event) => setVenture(event.target.value)} className={inputClass}><option>All ventures</option>{data.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value)} className={inputClass}><option>All statuses</option>{statuses.map((item) => <option key={item}>{item}</option>)}</Select></div>
    {rows.length ? <div data-vso-stagger-group className="divide-y divide-neutral-100">{rows.map((task) => <button key={task.id} type="button" onClick={() => { setSelected(task); setFresh(false); }} className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left hover:bg-neutral-50"><span className="min-w-0 flex-1"><span className="mb-1 flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-neutral-800">{task.title}</span><Badge tone={task.priority === "P1" ? "red" : "neutral"}>{task.priority}</Badge></span><span className="block text-sm leading-5 text-neutral-500">{task.outcome}</span><span className="mt-1 block text-xs text-neutral-400">{ventureName(data,task.ventureId)} · {personName(data,task.ownerId)} → {personName(data,task.reviewerId)}</span></span><span className="text-right"><Badge tone={task.status === "Blocked" ? "red" : task.status === "Done" ? "green" : "blue"}>{task.status}</Badge><span className="mt-1 block text-xs font-semibold text-neutral-500">Due {displayDate(task.dueAt)}</span></span></button>)}</div> : <Empty title="No matching tasks" body="Try another filter or draft a new assignment." />}</Panel>
    {selected && <TaskEditor key={selected.id} task={selected} fresh={fresh} onClose={() => setSelected(null)} />}
  </PageFrame>;
}

export function BoardScreen() {
  const { data, updateSection } = useStudio();
  const [venture,setVenture] = useState("All ventures");
  const [group,setGroup] = useState("All groups");
  const [owner,setOwner] = useState("All people");
  const [tag,setTag] = useState("All tags");
  const [deadline,setDeadline] = useState("Any deadline");
  const [selected,setSelected] = useState<Task | null>(null);
  const filterView = useFilterToggle("board");
  const tags = [...new Set(data.tasks.flatMap((task) => task.tags))];
  const filtered = data.tasks.filter((task) => (venture === "All ventures" || task.ventureId === venture) && (group === "All groups" || task.groupId === group) && (owner === "All people" || task.ownerId === owner) && (tag === "All tags" || task.tags.includes(tag)) && (deadline !== "Due this week" || task.dueAt <= "2026-09-27"));
  const move = (task: Task, status: TaskStatus) => { if (status === task.status) return; if ((status === "Done" && !task.evidence.trim()) || (status === "Blocked" && !task.blocker.trim())) { setSelected({ ...task, status }); return; } updateSection("tasks", (items) => items.map((item) => item.id === task.id ? { ...item, status, activity: [...item.activity, `Moved to ${status}`] } : item)); };
  const dnd = useKanbanDnd<TaskStatus>((taskId, status) => { const task = filtered.find((item) => item.id === taskId); if (task) move(task, status); });
  const filters = [
    { label:"Venture", value:venture, set:setVenture, values:[["All ventures","All ventures"],...data.ventures.map((item)=>[item.id,item.name])] },
    { label:"Group", value:group, set:setGroup, values:[["All groups","All groups"],...data.groups.map((item)=>[item.id,item.name])] },
    { label:"Person", value:owner, set:setOwner, values:[["All people","All people"],...data.people.map((item)=>[item.id,item.name])] },
    { label:"Tag", value:tag, set:setTag, values:[["All tags","All tags"],...tags.map((item)=>[item,item])] },
    { label:"Deadline", value:deadline, set:setDeadline, values:[["Any deadline","Any deadline"],["Due this week","Due this week"]] },
  ];
  // The first option of each filter is its "everything" state.
  const activeFilters = filters.filter((filter) => filter.value !== filter.values[0][0]).length;
  const clearFilters = () => filters.forEach((filter) => filter.set(filter.values[0][0]));
  return <PageFrame><PageTitle title="Kanban board" description="Filter work by venture, group, person, tag, and deadline. Drag cards between columns, or use their Move menu." action={<FilterToggle open={filterView.open} onToggle={filterView.toggle} rowId={filterView.rowId} count={filtered.length} noun="card" active={activeFilters} />} />
    <FilterRow open={filterView.open} rowId={filterView.rowId} active={activeFilters} onClear={clearFilters}>{filters.map((filter) => <Select key={filter.label} aria-label={filter.label} value={filter.value} onChange={(event) => filter.set(event.target.value)} className={filterControl(filter.value !== filter.values[0][0])}>{filter.values.map(([value,label])=><option key={value} value={value}>{label}</option>)}</Select>)}</FilterRow>
    <div className="grid gap-3 lg:grid-cols-3 2xl:grid-cols-6">{statuses.map((status) => <div key={status} {...dnd.columnProps(status)}><Panel className={clsx("min-h-52 p-3 transition-[border-color,box-shadow] duration-150", dnd.overStatus === status && "border-primary-500 ring-2 ring-primary-300")}><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-neutral-800">{status}</h2><Badge>{filtered.filter((task) => task.status === status).length}</Badge></div><div className="space-y-2">{filtered.filter((task) => task.status === status).map((task) => <article key={task.id} {...dnd.cardProps(task.id)} className={clsx("cursor-grab rounded-xl border border-neutral-100 bg-neutral-50 p-3 active:cursor-grabbing", dnd.draggingId === task.id && "opacity-45")}><button type="button" onClick={() => setSelected(task)} className="w-full text-left"><Badge tone={task.priority === "P1" ? "red" : "neutral"}>{task.priority}</Badge><h3 className="mt-2 text-sm font-semibold text-neutral-800">{task.title}</h3><p className="mt-1 text-xs text-neutral-500">{ventureName(data,task.ventureId)}</p><p className="mt-2 flex items-center gap-1 text-xs text-neutral-500"><Clock3 size={12} />{displayDate(task.dueAt)} · {personName(data,task.ownerId)}</p></button><Select aria-label={`Move ${task.title}`} value={task.status} onChange={(event) => move(task,event.target.value as TaskStatus)} className="mt-3 w-full rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs font-semibold text-neutral-600">{statuses.map((item) => <option key={item}>{item}</option>)}</Select></article>)}</div></Panel></div>)}</div>
    {selected && <TaskEditor key={selected.id} task={selected} fresh={false} onClose={() => setSelected(null)} />}
  </PageFrame>;
}
