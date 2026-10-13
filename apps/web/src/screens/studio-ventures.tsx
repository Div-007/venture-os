"use client";

import { WorkspaceLink as Link, workspaceHref } from "@/components/shell/workspace-link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { ArrowRight, BookOpenText, CircleCheck, Clock3, ListTodo, Scale, Target, TrendingUp, Users } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { newTaskAction } from "@/components/studio/new-task-dialog";
import { useStudio } from "@/lib/studio-store";
import { displayDate, personName, ventureName } from "@/lib/studio-demo";
import { Badge, HeaderActions, HeaderLabel, PageFrame, PageTitle, Panel, PanelHead, secondaryClass } from "@/components/studio/primitives";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { VentureGoal } from "@/components/studio/venture-goal";
import type { StudioData } from "@/lib/studio-demo";

const tabs = ["Overview", "Outcomes", "Tasks", "Knowledge", "Decisions", "People", "Sales"] as const;
type Tab = typeof tabs[number];
const tabFromParam = (value: string | null): Tab => tabs.find((item) => item.toLowerCase() === value) ?? "Overview";
const rowLink = "flex flex-wrap justify-between gap-3 p-5 transition-colors duration-150 hover:bg-neutral-50 focus-visible:bg-neutral-50 focus-visible:outline-none";

/**
 * The connected page passes `onSaveGoal` with `canEditGoal`, which is checked against the venture actually shown.
 * Header order is Manage access and `menu` (both secondary), then `action` (the primary, last).
 */
export function VenturesScreen({ snapshot, action, menu, onSaveGoal, canEditGoal }: { snapshot?: StudioData; action?: React.ReactNode; menu?: React.ReactNode; onSaveGoal?: (ventureId: string, goal: string) => Promise<void>; canEditGoal?: (ventureId: string) => boolean }) {
  const { data: contextData, mode, role, activeVentureId, setActiveVentureId, updateSection } = useStudio();
  const data = snapshot ?? contextData;
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const requestedVenture = params.get("venture");
  const selectedId = requestedVenture ?? (activeVentureId || data.ventures[0]?.id);
  const venture = data.ventures.find((item) => item.id === selectedId) ?? data.ventures[0];
  useEffect(() => { if (requestedVenture && data.ventures.some((item) => item.id === requestedVenture)) queueMicrotask(() => setActiveVentureId(requestedVenture)); }, [requestedVenture, data.ventures, setActiveVentureId]);
  // Changing the sidebar scope here opens that venture (the link's ?venture would otherwise keep winning).
  const previousScope = useRef(activeVentureId);
  useEffect(() => {
    if (previousScope.current === activeVentureId) return;
    previousScope.current = activeVentureId;
    if (activeVentureId === (requestedVenture ?? "")) return;
    router.replace(`${pathname}${activeVentureId ? `?venture=${encodeURIComponent(activeVentureId)}` : ""}`, { scroll: false });
  }, [activeVentureId, requestedVenture, pathname, router]);
  const tabMotion = useTabMotion(tabFromParam(params.get("tab")), tabs);
  if (!venture) return null;
  // The section lives in the URL so a refresh, a shared link, or Back returns to it.
  const tab = tabFromParam(params.get("tab"));
  const setTab = (next: Tab) => {
    const query = new URLSearchParams(params.toString());
    if (next === "Overview") query.delete("tab"); else query.set("tab", next.toLowerCase());
    router.replace(`${pathname}${query.size ? `?${query}` : ""}`, { scroll: false });
  };
  const outcomes = data.outcomes.filter((item) => item.ventureId === venture.id);
  const tasks = data.tasks.filter((item) => item.ventureId === venture.id);
  const docs = data.knowledge.filter((item) => item.ventureId === venture.id && (mode === "connected" || item.sensitivity !== "Founder private"));
  const decisions = data.decisions.filter((item) => item.ventureId === venture.id);
  const members = data.people.filter((person) => person.ventureIds.includes(venture.id));
  const deals = data.deals.filter((deal) => deal.ventureId === venture.id);
  const groups = data.groups.filter((group) => group.ventureId === venture.id);
  const to = (path: string) => workspaceHref(path, mode);
  const attention = tasks.filter((item) => item.status !== "Done").slice(0, 3);
  const manageAccess = mode === "demo" || role === "admin";
  const saveGoal = mode === "demo"
    ? async (goal: string) => updateSection("ventures", (items) => items.map((item) => item.id === venture.id ? { ...item, goal } : item))
    : onSaveGoal && canEditGoal?.(venture.id) ? (goal: string) => onSaveGoal(venture.id, goal) : undefined;
  return <PageFrame>
    <PageTitle title={venture.name} description="A separate operating context for goals, work, evidence, and decisions." action={manageAccess || menu || action ? <HeaderActions>{manageAccess && <Link href="/admin" className={secondaryClass}><Users size={15} /><HeaderLabel>Manage access</HeaderLabel></Link>}{menu}{action}</HeaderActions> : undefined} />
    <SlidingTabs tabs={tabs.map((item) => { const count = { Overview: undefined, Outcomes: outcomes.length, Tasks: tasks.length, Knowledge: docs.length, Decisions: decisions.length, People: members.length, Sales: deals.length }[item]; return { key: item, label: item, ...(count ? { badge: count } : {}) }; })} active={tab} onChange={(key) => setTab(key as Tab)} label="Venture sections" fitContent className="mb-4" />
    <div key={`${venture.id}-${tab}`} className={tabMotion.className} style={tabMotion.style}>
    {tab === "Overview" && <div className="grid items-start gap-4 xl:grid-cols-3"><Panel className="p-5 xl:col-span-3"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><div className="mb-2 flex flex-wrap gap-2"><Badge tone="green">{venture.status}</Badge>{mode === "demo" && <Badge tone="blue">{venture.stage}</Badge>}</div><VentureGoal key={venture.id} goal={venture.goal} onSave={saveGoal} /></div><div className="text-sm text-neutral-500">{mode === "demo" ? <><p><span className="font-bold text-neutral-700">Accountable owner:</span> {personName(data, venture.ownerId)}</p><p className="mt-2"><span className="font-bold text-neutral-700">Last reviewed:</span> {displayDate(venture.reviewedAt)}</p><p className="mt-2 flex items-center gap-1"><Clock3 size={14} />{venture.id === "spotlyst" ? "Context needs review" : "Current context"}</p></> : <p><Clock3 size={14} className="inline" /> Created {displayDate(venture.reviewedAt)}</p>}</div></div></Panel><Panel className="xl:col-span-2"><PanelHead title="Current outcomes" aside={<button onClick={() => setTab("Outcomes")} className="text-xs font-semibold text-primary-600">View all <ArrowRight size={13} className="inline" /></button>} />{outcomes.length ? <div className="space-y-4 p-5">{outcomes.map((item) => <div key={item.id}><div className="flex justify-between gap-3"><p className="text-sm font-semibold text-neutral-800">{item.title}</p><span className="text-xs font-semibold">{mode === "demo" ? `${item.progress}%` : item.status}</span></div><p className="mt-1 text-xs text-neutral-500">Due {displayDate(item.dueAt)}{mode === "demo" ? ` · ${item.status}` : ""}</p>{mode === "demo" && <div className="mt-2 h-2 rounded-full bg-neutral-100"><div className="vso-progress h-full rounded-full bg-primary-600" style={{width:`${item.progress}%`}} /></div>}</div>)}</div> : <EmptyState variant="card" icon={Target} tone="green" title={`No outcomes for ${venture.name} yet`} body="A 30-day outcome gives this venture's work a target." action={{ label: "Open timeline", href: to("/timeline") }} />}</Panel><Panel><PanelHead title="Working structure" />{groups.length ? <div className="p-5">{groups.map((group) => <div key={group.id} className="mb-4 rounded-xl bg-neutral-50 p-3"><p className="text-sm font-semibold text-neutral-800">{group.name}</p><p className="mt-1 text-xs text-neutral-500">{mode === "demo" ? `${group.memberIds.length} members · ` : ""}{((count) => `${count} ${count === 1 ? "channel" : "channels"}`)(data.channels.filter((channel) => channel.groupId === group.id).length)}</p><div className="mt-2 flex flex-wrap gap-1">{data.channels.filter((channel) => channel.groupId === group.id).map((channel) => <Link key={channel.id} href={`/channels?channel=${channel.id}`} className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-primary-700"># {channel.name}</Link>)}</div></div>)}</div> : <EmptyState variant="card" icon={Users} tone="teal" title="No groups yet" body="Groups and their channels for this venture will appear here." />}</Panel><Panel className="xl:col-span-3"><PanelHead title="Needs attention" />{attention.length ? <div className="grid gap-3 p-5 md:grid-cols-3">{attention.map((item) => <Link key={item.id} href={`/tasks?task=${item.id}`} className="rounded-xl bg-neutral-50 p-4 hover:bg-neutral-100"><div className="mb-2"><Badge tone={item.status === "Blocked" ? "red" : "blue"}>{item.status}</Badge></div><p className="text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-2 text-xs text-neutral-500">{personName(data,item.ownerId)} · Due {displayDate(item.dueAt)}</p></Link>)}</div> : <EmptyState variant="card" icon={CircleCheck} tone="teal" title="Nothing needs attention" body="Blocked or overdue work shows up here." />}</Panel></div>}
    {tab === "Outcomes" && <Panel><PanelHead title="30-day outcomes" />{!outcomes.length && <EmptyState icon={Target} tone="green" title="No outcomes yet" body="Set a 30-day outcome to give this venture's work a target." action={{ label: "Open timeline", href: to("/timeline") }} />}<div className="divide-y divide-neutral-100">{outcomes.map((item) => <div key={item.id} className="p-5"><div className="flex flex-wrap justify-between gap-2"><h2 className="text-base font-bold text-neutral-800">{item.title}</h2><Badge tone={item.status === "At risk" ? "amber" : "green"}>{item.status}</Badge></div><p className="mt-2 text-sm text-neutral-500">Owner: {personName(data,item.ownerId)} · Due {displayDate(item.dueAt)}</p><p className="mt-2 text-sm text-neutral-600">Success evidence: {item.evidence}</p>{mode === "demo" && <div className="mt-3 h-2 rounded-full bg-neutral-100"><div className="vso-progress h-full rounded-full bg-primary-600" style={{width:`${item.progress}%`}} /></div>}</div>)}</div></Panel>}
    {tab === "Tasks" && <Panel><PanelHead title="Venture tasks" aside={<Link href="/tasks" className="text-xs font-semibold text-primary-600">Open task workspace</Link>} />{!tasks.length && <EmptyState icon={ListTodo} tone="green" title="No tasks yet" body="Tasks created for this venture will appear here." action={mode === "connected" ? newTaskAction(mode) : { label: "Draft a task", href: to("/tasks?new=1") }} />}<div className="divide-y divide-neutral-100">{tasks.map((item) => <Link key={item.id} href={`/tasks?task=${item.id}`} className={rowLink}><div><p className="text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 text-xs text-neutral-500">{item.outcome}</p></div><Badge tone={item.status === "Blocked" ? "red" : "blue"}>{item.status}</Badge></Link>)}</div></Panel>}
    {tab === "Knowledge" && <Panel><PanelHead title="Venture knowledge" aside={<Link href="/knowledge" className="text-xs font-semibold text-primary-600">Search all knowledge</Link>} />{!docs.length && <EmptyState icon={BookOpenText} tone="violet" title="No knowledge yet" body="Notes and evidence for this venture will appear here." secondary={{ label: "Open knowledge", href: to("/knowledge") }} />}<div className="divide-y divide-neutral-100">{docs.map((doc) => <Link key={doc.id} href={`/knowledge?doc=${doc.id}`} className={rowLink}><p className="text-sm font-semibold text-neutral-800">{doc.title}</p><Badge tone="purple">{doc.evidenceClass}</Badge></Link>)}</div></Panel>}
    {tab === "Decisions" && <Panel><PanelHead title="Decision register" aside={<Link href="/decisions" className="text-xs font-semibold text-primary-600">Open register</Link>} />{!decisions.length && <EmptyState icon={Scale} tone="violet" title="No decisions recorded" body="Decisions logged for this venture will appear here." secondary={{ label: "Open register", href: to("/decisions") }} />}<div className="divide-y divide-neutral-100">{decisions.map((item) => <div key={item.id} className="flex flex-wrap justify-between gap-3 p-5"><p className="text-sm font-semibold text-neutral-800">{item.title}</p><Badge tone={item.status === "Approved" ? "green" : "amber"}>{item.status}</Badge></div>)}</div></Panel>}
    {tab === "People" && <Panel><PanelHead title="Members with venture access" />{!members.length && <EmptyState icon={Users} tone="green" title="No members yet" body="People with access to this venture will appear here." />}<div className="grid gap-3 p-5 empty:hidden md:grid-cols-2 xl:grid-cols-3">{members.map((person) => <div key={person.id} className="flex items-center gap-3 rounded-xl bg-neutral-50 p-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-primary-50 text-xs font-semibold text-primary-700">{person.initials}</span><div><p className="text-sm font-semibold text-neutral-800">{person.name}</p><p className="text-xs text-neutral-500">{person.role}</p></div></div>)}</div></Panel>}
    {tab === "Sales" && <Panel><PanelHead title="Venture pipeline" aside={<Link href={`/sales?venture=${venture.id}`} className="text-xs font-semibold text-primary-600">Open pipeline</Link>} />{!deals.length && <EmptyState icon={TrendingUp} tone="amber" title="No pipeline records yet" body={`Deals for ${ventureName(data, venture.id)} will appear here.`} secondary={{ label: "Open pipeline", href: to(`/sales?venture=${venture.id}`) }} />}<div className="divide-y divide-neutral-100">{deals.map((deal) => <div key={deal.id} className="flex flex-wrap justify-between gap-3 p-5"><div><p className="text-sm font-semibold text-neutral-800">{deal.lead}</p><p className="mt-1 text-xs text-neutral-500">{deal.offer} · Next: {deal.nextAction}</p></div><Badge tone="blue">{deal.stage}</Badge></div>)}</div></Panel>}
    </div>
  </PageFrame>;
}
