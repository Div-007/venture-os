"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useStudio } from "@/lib/studio-store";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { CalendarDays, FileQuestion, Plus, Scale, Search, Target } from "@/components/ui/icons";
import { listLiveClasses, listLiveDecisions, listLiveInformationRequests, listLiveMembers, listLiveOutcomes, loadLiveSession, updateLiveClass, updateLiveDecision, updateLiveInformationRequest, updateLiveOutcome } from "@/lib/studio-api";
import { ActionLabel, Badge, DetailDrawer, HeaderActions, inputClass, Notice, PageFrame, PageTitle, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { toast } from "@/components/ui/toast";
import { flashById } from "@/lib/motion";
import { LiveClassApplications } from "@/components/studio/live-class-applications";
import { PlanningCreateDrawer, type PlanningCreateKind } from "@/components/studio/planning-create-drawer";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Outcome = Awaited<ReturnType<typeof listLiveOutcomes>>[number];
type Decision = Awaited<ReturnType<typeof listLiveDecisions>>[number];
type Class = Awaited<ReturnType<typeof listLiveClasses>>[number];
type Request = Awaited<ReturnType<typeof listLiveInformationRequests>>[number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
const weekLabel = (value: string) => { const date = new Date(value); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date; };
const rowClass = "flex w-full border-b border-neutral-100 p-5 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:bg-neutral-100 aria-[current=true]:bg-primary-50";
const tabsOf = <T extends string>(keys: readonly T[], labels: Record<T, string>, count: (key: T) => number) => keys.map((key) => ({ key, label: labels[key], badge: count(key) }));
/** Says what the search text and status tab are hiding, e.g. No approved decisions match “pricing”. */
const filteredTitle = (noun: string, query: string, status: string) => {
  const text = query.trim().length > 40 ? `${query.trim().slice(0, 40)}…` : query.trim();
  const named = status === "all" ? noun : `${status} ${noun}`;
  return text ? `No ${named} match “${text}”` : `No ${named}`;
};

export function LivePlanningScreen({ view = null }: { view?: "decisions" | "classes" | "timeline" | "requests" | null }) {
  const { activeVentureId: ventureId } = useStudio();
  const [session, setSession] = useState<Session | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Request | null>(null);
  const [selectedClass, setSelectedClass] = useState<Class | null>(null);
  const [activeClass, setActiveClass] = useState<Class | null>(null);
  const [selectedDecision, setSelectedDecision] = useState<Decision | null>(null);
  const [decisionQuery, setDecisionQuery] = useState("");
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [requestQuery, setRequestQuery] = useState("");
  const [response, setResponse] = useState("");
  const [sources, setSources] = useState("");
  const [error, setError] = useState("");
  // Set only when loading the records fails, so a failed load shows the error state and never "No … yet".
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [createKind, setCreateKind] = useState<PlanningCreateKind | null>(null);
  const [result, setResult] = useState("");
  // The record being saved; only its own control waits.
  const [updatingId, setUpdatingId] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [requestFilter, setRequestFilter] = useState("all");
  const [timelineFilter, setTimelineFilter] = useState("all");
  const [now] = useState(() => Date.now());

  useEffect(() => { queueMicrotask(() => { setSelectedDecision(null); setActiveClass(null); setSelectedRequestId(""); }); }, [ventureId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      Promise.all([loadLiveSession(), listLiveOutcomes(), listLiveDecisions(), listLiveClasses(), listLiveInformationRequests(), listLiveMembers({ limit: 100 }).catch(() => null)]).then(([nextSession, nextOutcomes, nextDecisions, nextClasses, nextRequests, nextMembers]) => {
        if (!active) return;
        setSession(nextSession); setOutcomes(nextOutcomes); setDecisions(nextDecisions); setClasses(nextClasses); setRequests(nextRequests); setMemberNames(Object.fromEntries(nextMembers?.items.map((item) => [item.id, item.name]) ?? [])); setError(""); setLoadError(""); setBusy(false);
      }).catch((cause: unknown) => { if (active) { const message = describeError(cause, "Check your connection and try again."); setError(message); setLoadError(message); setBusy(false); } });
    });
    return () => { active = false; };
  }, [revision]);

  const visibleOutcomes = outcomes.filter((item) => !ventureId || item.ventureId === ventureId);
  const visibleDecisions = decisions.filter((item) => !ventureId || item.ventureId === ventureId);
  const decisionRows = visibleDecisions.filter((item) => (decisionFilter === "all" || item.status === decisionFilter) && `${item.title} ${item.reason} ${item.text}`.toLowerCase().includes(decisionQuery.trim().toLowerCase()));
  const visibleClasses = classes.filter((item) => !ventureId || item.ventureId === ventureId);
  const visibleRequests = requests.filter((item) => !ventureId || item.ventureId === ventureId);
  const requestRows = visibleRequests.filter((item) => (requestFilter === "all" || item.status === requestFilter) && `${item.question} ${item.purpose} ${item.responseMarkdown ?? ""}`.toLowerCase().includes(requestQuery.trim().toLowerCase()));
  const activeRequest = requestRows.find((item) => item.id === selectedRequestId) ?? null;
  const ventureName = (id?: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? "Workspace";
  const canManage = (id?: string) => session?.membership.role === "admin" || (session?.membership.role === "venture_head" && !!id && session.membership.ventureIds.includes(id));
  const canRequest = !!ventureId && !!session && (session.membership.role === "admin" || session.membership.ventureIds.includes(ventureId));
  const canCreatePlanning = !!session && (session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.length > 0));
  const canCreateRequest = !!session && (session.membership.role === "admin" || session.membership.ventureIds.length > 0);
  const refresh = () => setRevision((value) => value + 1);
  const openCreate = (kind: PlanningCreateKind) => { setCreateKind(kind); setResult(""); };
  const canCreateCard = (kind: PlanningCreateKind) => kind === "request" ? (ventureId ? canRequest : canCreateRequest) : (ventureId ? canManage(ventureId) : canCreatePlanning);
  const createButton = (kind: PlanningCreateKind) => <button type="button" onClick={() => openCreate(kind)} className={`${secondaryClass} !min-h-8 !rounded-lg !px-2 !text-xs`} aria-label={`Create ${kind === "request" ? "information request" : kind}`}><Plus size={13} />Create</button>;
  /** The card's Create action for its empty state, only when the person may create (same check as the small Create button). */
  const cardCreate = (kind: PlanningCreateKind, label: string) => canCreateCard(kind) ? { label, icon: Plus, onClick: () => openCreate(kind) } : undefined;
  // The header button and the page empty on /decisions, /classes and /requests share this one handler and permission check.
  const headerKind: PlanningCreateKind | null = (view === "decisions" || view === "classes") && canCreatePlanning ? (view === "decisions" ? "decision" : "class") : view === "requests" && canCreateRequest ? "request" : null;
  const headerCreate = headerKind ? { label: view === "decisions" ? "Record decision" : view === "classes" ? "Schedule class" : "New request", icon: Plus, onClick: () => setCreateKind(headerKind) } : undefined;
  const timeline = [
    ...visibleOutcomes.filter((item) => item.status !== "cancelled").map((item) => ({ id: item.id, kind: "outcome", at: item.reviewAt, type: "Outcome review", title: item.title, ventureId: item.ventureId, done: item.status === "achieved" })),
    ...visibleClasses.filter((item) => item.status !== "cancelled").map((item) => ({ id: item.id, kind: "class", at: item.scheduledAt, type: "Class", title: item.title, ventureId: item.ventureId, done: item.status === "completed" })),
    ...visibleRequests.filter((item) => item.status === "open").map((item) => ({ id: item.id, kind: "request", at: item.dueAt, type: "Request due", title: item.question, ventureId: item.ventureId, done: false })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const timelineItems = timeline.filter((item) => timelineFilter === "all" || item.kind === timelineFilter);
  const todayIndex = timelineItems.findIndex((item) => new Date(item.at).getTime() >= now);
  // A failed load shows the error state and the first load shows a skeleton; neither ever shows "No … yet".
  const hasPlanning = visibleOutcomes.length + visibleDecisions.length + visibleClasses.length + visibleRequests.length > 0;
  const hasRecords = view === "decisions" ? visibleDecisions.length > 0 : view === "classes" ? visibleClasses.length > 0 : view === "requests" ? visibleRequests.length > 0 : view === "timeline" ? timeline.length > 0 : hasPlanning;
  const showLoadError = !!loadError && !hasRecords;
  const loading = !session && !showLoadError;
  const ready = !!session && !showLoadError;
  const twoPane = view === "decisions" || view === "classes" || view === "requests";
  const loadNoun = view === "decisions" ? "decisions" : view === "classes" ? "classes" : view === "requests" ? "requests" : view === "timeline" ? "the timeline" : "planning records";
  const timelineKinds = { outcome: "outcomes", class: "classes", request: "requests" } as const;
  const outcomeCreate = cardCreate("outcome", "Create outcome");

  async function answer(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await updateLiveInformationRequest(selected.id, { status: "answered", responseMarkdown: response, sourceRefs: sources.split("\n").map((item) => item.trim()).filter(Boolean) });
      setSelected(null); setRevision((value) => value + 1);
      toast({ title: "Answer submitted", body: selected.question });
      flashById(selected.id);
    } catch (cause) { setError(describeError(cause, "Could not answer the request.")); }
    finally { setBusy(false); }
  }

  const canReviewRequest = (item: Request) => !!session && (item.requesterId === session.user.id || item.reviewedBy === session.user.id);
  async function changeRequest(item: Request, status: Request["status"]) {
    setUpdatingId(item.id); setError(""); setResult("");
    try { const updated = await updateLiveInformationRequest(item.id, { status }); setRequests((items) => items.map((entry) => entry.id === item.id ? updated : entry)); setResult(status === "open" ? "Request reopened." : status === "reviewed" ? "Answer marked reviewed." : "Request closed."); }
    catch (cause) { setError(describeError(cause, "Could not update the request.")); }
    finally { setUpdatingId(""); flashById(item.id); }
  }

  async function changeOutcome(item: Outcome, status: Outcome["status"]) {
    setUpdatingId(item.id); setError("");
    try { const updated = await updateLiveOutcome(item.id, { status }); setOutcomes((items) => items.map((entry) => entry.id === item.id ? updated : entry)); }
    catch (cause) { setError(describeError(cause, "Could not update the outcome.")); }
    finally { setUpdatingId(""); flashById(item.id); }
  }

  async function changeDecision(item: Decision, status: Decision["status"]) {
    setUpdatingId(item.id); setError("");
    try { const updated = await updateLiveDecision(item.id, { status }); setDecisions((items) => items.map((entry) => entry.id === item.id ? updated : entry)); setSelectedDecision(updated); }
    catch (cause) { setError(describeError(cause, "Could not update the decision.")); }
    finally { setUpdatingId(""); flashById(item.id); }
  }

  async function changeClass(item: Class, status: Class["status"]) {
    setUpdatingId(item.id); setError("");
    try { const updated = await updateLiveClass(item.id, { status }); setClasses((items) => items.map((entry) => entry.id === item.id ? updated : entry)); setActiveClass(updated); }
    catch (cause) { setError(describeError(cause, "Could not update the class.")); }
    finally { setUpdatingId(""); flashById(item.id); }
  }

  return <PageFrame><PageTitle title={view === "decisions" ? "Decisions" : view === "classes" ? "Classes" : view === "timeline" ? "30-day timeline" : view === "requests" ? "Questions & requests" : "Outcomes & operating records"} description={view === "decisions" ? "What was approved, why, which evidence supported it, and when to review it." : view === "classes" ? "Lessons connect to practice, live assignments, and assessment evidence." : view === "timeline" ? "Outcomes, reviews, and work that contribute to the plan." : view === "requests" ? "Assign missing information with sources and unresolved points." : "Track 30-day commitments, decisions, classes, requests, and reviews."} action={<HeaderActions><RefreshButton busy={busy && !!session} onClick={refresh} />{headerCreate && <button type="button" onClick={headerCreate.onClick} className={primaryClass}><Plus size={15} />{headerCreate.label}</button>}</HeaderActions>} />
    <Notice tone="error" message={showLoadError ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    <Notice tone="success" message={result} onDismiss={() => setResult("")} autoDismissMs={5000} className="pb-4" />
    {showLoadError && <Panel><EmptyState variant="error" title={`Could not load ${loadNoun}`} body={loadError} action={{ label: busy ? "Trying again…" : "Try again", onClick: refresh, disabled: busy }} /></Panel>}
    {loading && (twoPane ? <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]"><Panel><SkeletonRows rows={5} label={`Loading ${loadNoun}`} /></Panel></div> : <Panel><SkeletonRows rows={5} label="Loading operating records" /></Panel>)}
    {ready && view === "decisions" && (visibleDecisions.length === 0 ? <EmptyState variant="page" tone="violet" icon={Scale} title="No decisions recorded yet" body={headerCreate ? "Record what was approved, why, and when to look at it again." : "Approved decisions, with their reasons and review dates, appear here once a venture head records them."} action={headerCreate} /> : <div className="grid gap-4 [overflow-wrap:anywhere] lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]">
      <Panel>
        <div className="border-b border-neutral-100 p-4"><label className="relative block"><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input aria-label="Search decisions" value={decisionQuery} onChange={(event) => setDecisionQuery(event.target.value)} placeholder="Search decisions" className={`${inputClass} pl-9`} /></label><SlidingTabs fitContent label="Decision status" className="mt-3 bg-neutral-100 shadow-none" active={decisionFilter} onChange={setDecisionFilter} tabs={tabsOf(["all", "draft", "approved", "superseded", "stale"] as const, { all: "All", draft: "Draft", approved: "Approved", superseded: "Superseded", stale: "Stale" }, (key) => key === "all" ? visibleDecisions.length : visibleDecisions.filter((item) => item.status === key).length)} /></div>
        <div className="vso-stagger-in">{decisionRows.map((item) => <button type="button" key={item.id} data-flash-id={item.id} onClick={() => setSelectedDecision(item)} aria-current={item.id === selectedDecision?.id ? "true" : undefined} className={clsx(rowClass, "flex-wrap items-start justify-between gap-3")}><div><p className="text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 text-xs text-neutral-500">{ventureName(item.ventureId)} · {stamp(item.decidedAt)}</p></div><Badge tone={item.status === "approved" ? "green" : "amber"}>{item.status}</Badge></button>)}</div>
        {decisionRows.length === 0 && <EmptyState variant="filtered" title={filteredTitle("decisions", decisionQuery, decisionFilter)} action={{ label: "Clear filters", onClick: () => { setDecisionQuery(""); setDecisionFilter("all"); } }} />}
      </Panel>
      <Panel className={clsx(!selectedDecision && (decisionRows.length > 0 ? "max-md:hidden" : "hidden"))}>{selectedDecision ? <div key={selectedDecision.id} className="vso-fade-enter"><PanelHead title={selectedDecision.title} /><dl className="space-y-4 p-5 text-sm">{([["Status", selectedDecision.status], ["Decision", selectedDecision.text], ["Reason", selectedDecision.reason], ["Evidence", selectedDecision.evidence.join(", ")], ["Affected work", selectedDecision.affectedWork.join(", ")], ["Review trigger", selectedDecision.reviewTrigger]] as const).map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase text-neutral-400">{label}</dt><dd className="mt-1 leading-6 text-neutral-700">{value || "Not recorded"}</dd></div>)}{canManage(selectedDecision.ventureId) && <div><dt className="text-xs font-semibold uppercase text-neutral-400">Change status</dt><dd className="mt-2"><Select aria-label={`Status for decision ${selectedDecision.title}`} disabled={updatingId === selectedDecision.id} value={selectedDecision.status} onChange={(event) => changeDecision(selectedDecision, event.target.value as Decision["status"])} className={inputClass}><option value="draft">Draft</option><option value="approved">Approved</option><option value="superseded">Superseded</option><option value="stale">Stale</option></Select></dd></div>}</dl></div> : <EmptyState variant="select" title="Select a decision" body="The approval reason and review trigger appear here." />}</Panel>
    </div>)}
    {ready && view === "classes" && (visibleClasses.length === 0 ? <EmptyState variant="page" tone="blue" icon={CalendarDays} title="No classes scheduled yet" body={headerCreate ? "Schedule a class to connect a lesson to practice, assignments and assessment." : "Scheduled classes, with their assignments and assessments, appear here once a venture head adds them."} action={headerCreate} /> : <div className="grid gap-4 [overflow-wrap:anywhere] lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]">
      <Panel><PanelHead title="Schedule" aside={<CalendarDays size={16} className="text-neutral-400" />} />{[...visibleClasses].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map((item) => <button type="button" key={item.id} data-flash-id={item.id} onClick={() => setActiveClass(item)} aria-current={item.id === activeClass?.id ? "true" : undefined} className={clsx(rowClass, "items-start gap-3")}><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-50 font-mono text-sm font-semibold text-primary-700">{new Date(item.scheduledAt).getDate()}</span><span className="min-w-0"><span className="block text-sm font-semibold text-neutral-800">{item.title}</span><span className="mt-1 block text-xs text-neutral-500">{ventureName(item.ventureId)} · {new Date(item.scheduledAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}</span><span className="mt-2 block text-sm text-neutral-600">{item.objective}</span></span></button>)}</Panel>
      <Panel className={clsx(!activeClass && "max-md:hidden")}>{activeClass ? <div key={activeClass.id} className="vso-fade-enter"><PanelHead title={activeClass.title} aside={<Badge tone="blue">{activeClass.status}</Badge>} /><div className="space-y-4 p-5 text-sm"><p className="leading-6 text-neutral-700">{activeClass.objective}</p><dl className="space-y-3">{([["Scheduled", new Date(activeClass.scheduledAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })], ["Duration", `${activeClass.durationMinutes} minutes`], ["Participants", String(activeClass.participantIds.length)], ["Material", activeClass.materialDocumentId ? "Linked knowledge document" : "Not recorded"]] as const).map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase text-neutral-400">{label}</dt><dd className="mt-1 text-neutral-700">{value}</dd></div>)}</dl>{canManage(activeClass.ventureId) && <Select aria-label={`Status for class ${activeClass.title}`} disabled={updatingId === activeClass.id} value={activeClass.status} onChange={(event) => { void changeClass(activeClass, event.target.value as Class["status"]); }} className={inputClass}><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></Select>}<button type="button" onClick={() => setSelectedClass(activeClass)} className={secondaryClass}>Applications & assessments</button></div></div> : <EmptyState variant="select" title="Select a class" body="Open a class to view its schedule, participants, and applied-work assessments." />}</Panel>
    </div>)}
    {ready && view === "requests" && (visibleRequests.length === 0 ? <EmptyState variant="page" tone="blue" icon={FileQuestion} title="No requests yet" body={headerCreate ? "Ask a teammate for missing information and keep the answer with its sources." : "Information requests raised in your ventures, with their answers and sources, appear here."} action={headerCreate} /> : <div className="grid gap-4 [overflow-wrap:anywhere] lg:grid-cols-[minmax(0,1fr)_minmax(300px,.8fr)]">
      <Panel>
        <div className="border-b border-neutral-100 p-4"><label className="relative block"><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input aria-label="Search requests" value={requestQuery} onChange={(event) => setRequestQuery(event.target.value)} placeholder="Search requests" className={`${inputClass} pl-9`} /></label><SlidingTabs fitContent label="Request status" className="mt-3 bg-neutral-100 shadow-none" active={requestFilter} onChange={setRequestFilter} tabs={tabsOf(["all", "open", "answered", "reviewed", "closed"] as const, { all: "All", open: "Open", answered: "Answered", reviewed: "Reviewed", closed: "Closed" }, (key) => key === "all" ? visibleRequests.length : visibleRequests.filter((item) => item.status === key).length)} /></div>
        <div className="vso-stagger-in">{requestRows.map((item) => <button type="button" key={item.id} data-flash-id={item.id} onClick={() => setSelectedRequestId(item.id)} aria-current={item.id === selectedRequestId ? "true" : undefined} className={clsx(rowClass, "flex-wrap items-start justify-between gap-3")}><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-neutral-800">{item.question}</span><span className="mt-1 block text-xs text-neutral-500">{ventureName(item.ventureId)} · {memberNames[item.requesterId] ?? "Requester"} → {memberNames[item.respondentId] ?? "Respondent"} · Due {stamp(item.dueAt)}</span><span className="mt-2 block line-clamp-2 text-sm text-neutral-600">{item.responseMarkdown || item.purpose}</span></span><Badge tone={item.status === "open" ? "amber" : "green"}>{item.status}</Badge></button>)}</div>
        {requestRows.length === 0 && <EmptyState variant="filtered" title={filteredTitle("requests", requestQuery, requestFilter)} action={{ label: "Clear filters", onClick: () => { setRequestQuery(""); setRequestFilter("all"); } }} />}
      </Panel>
      <Panel className={clsx(!activeRequest && (requestRows.length > 0 ? "max-md:hidden" : "hidden"))}>{activeRequest ? <div key={activeRequest.id} className="vso-fade-enter"><PanelHead title={activeRequest.question} aside={<Badge tone={activeRequest.status === "open" ? "amber" : "green"}>{activeRequest.status}</Badge>} /><dl className="space-y-4 p-5 text-sm">{([["Venture", ventureName(activeRequest.ventureId)], ["Requester", memberNames[activeRequest.requesterId] ?? "Requester"], ["Respondent", memberNames[activeRequest.respondentId] ?? "Respondent"], ["Due", stamp(activeRequest.dueAt)], ["Purpose", activeRequest.purpose], ["Answer", activeRequest.responseMarkdown || "Answer pending"], ["Sources", activeRequest.sourceRefs.join(", ") || "Not recorded"]] as const).map(([label, value]) => <div key={label}><dt className="text-xs font-semibold uppercase text-neutral-400">{label}</dt><dd className="mt-1 whitespace-pre-wrap leading-6 text-neutral-700">{value}</dd></div>)}{activeRequest.respondentId === session?.user.id && activeRequest.status === "open" && <button type="button" onClick={() => { setSelected(activeRequest); setResponse(""); setSources(""); }} className={primaryClass}>Answer request</button>}{canReviewRequest(activeRequest) && <div className="flex flex-wrap gap-2 border-t border-neutral-100 pt-4">{activeRequest.status === "answered" && activeRequest.respondentId !== session?.user.id && <button type="button" disabled={updatingId === activeRequest.id} onClick={() => void changeRequest(activeRequest, "reviewed")} className={primaryClass}>Mark answer reviewed</button>}{activeRequest.status !== "closed" && <button type="button" disabled={updatingId === activeRequest.id} onClick={() => void changeRequest(activeRequest, "closed")} className={secondaryClass}>Close request</button>}{activeRequest.status !== "open" && <button type="button" disabled={updatingId === activeRequest.id} onClick={() => void changeRequest(activeRequest, "open")} className={secondaryClass}>Reopen for a new answer</button>}</div>}</dl></div> : <EmptyState variant="select" title="Select a request" body="The question, answer, and sources appear here." />}</Panel>
    </div>)}
    {ready && !twoPane && (!view && !hasPlanning ? <EmptyState variant="page" tone="blue" icon={Target} title="Nothing planned yet" body={outcomeCreate ? "Start by setting a 30-day outcome. Decisions, classes and requests build on it." : "Outcomes, decisions, classes and requests appear here once a venture head sets the first 30-day outcome."} action={outcomeCreate} /> : <div className={view ? "grid gap-4 [overflow-wrap:anywhere]" : "grid items-start gap-4 [overflow-wrap:anywhere] xl:grid-cols-2"}>
      {(!view) && (<Panel><PanelHead title="30-day outcomes" aside={<div className="flex items-center gap-2"><Badge tone="blue">{visibleOutcomes.length}</Badge>{visibleOutcomes.length > 0 && canCreateCard("outcome") && createButton("outcome")}</div>} /><div className="divide-y divide-neutral-100">{visibleOutcomes.length ? visibleOutcomes.map((item) => <article key={item.id} data-flash-id={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.title}</h2><Badge tone={item.status === "at_risk" ? "amber" : "green"}>{item.status.replaceAll("_", " ")}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.description}</p><p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · Review {stamp(item.reviewAt)} · {item.priority} priority</p><p className="mt-2 text-xs text-neutral-500">Success evidence: {item.successEvidence}</p>{item.risk && <p className="mt-1 text-xs text-danger-text">Risk: {item.risk}</p>}{canManage(item.ventureId) && <Select aria-label={`Status for outcome ${item.title}`} disabled={updatingId === item.id} value={item.status} onChange={(event) => changeOutcome(item, event.target.value as Outcome["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="draft">Draft</option><option value="approved">Approved</option><option value="active">Active</option><option value="at_risk">At risk</option><option value="achieved">Achieved</option><option value="cancelled">Cancelled</option></Select>}</article>) : <EmptyState variant="card" tone="green" icon={Target} title="No 30-day outcomes yet" body="An outcome is a commitment you can review in 30 days." action={outcomeCreate} />}</div></Panel>)}
      {(!view || view === "timeline") && (<Panel><PanelHead title="Milestone timeline" aside={<CalendarDays size={16} className="text-neutral-400" />} />{timeline.length > 0 && <div className="border-b border-neutral-100 px-4 py-3"><SlidingTabs fitContent label="Timeline filter" className="bg-neutral-100 shadow-none" active={timelineFilter} onChange={setTimelineFilter} tabs={tabsOf(["all", "outcome", "class", "request"] as const, { all: "All", outcome: "Outcomes", class: "Classes", request: "Requests" }, (key) => key === "all" ? timeline.length : timeline.filter((item) => item.kind === key).length)} /></div>}<div key={timelineFilter} className="vso-fade-enter">{timelineItems.length ? timelineItems.map((item, index) => { const week = weekLabel(item.at); const newWeek = index === 0 || weekLabel(timelineItems[index - 1].at).getTime() !== week.getTime(); const past = new Date(item.at).getTime() < now; return <div key={`${item.type}-${item.id}`}>{newWeek && <p className="sticky top-0 z-[1] border-b border-neutral-100 bg-white/95 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 backdrop-blur">Week of {stamp(week.toISOString())}</p>}{index === todayIndex && <div className="flex items-center gap-2 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-primary-700"><span className="h-px flex-1 bg-primary-300" />Today<span className="h-px flex-1 bg-primary-300" /></div>}<div className={clsx("flex gap-3 border-b border-neutral-100 p-4", past && !item.done && "bg-danger-surface/40")}><span className={clsx("w-24 shrink-0 text-xs font-semibold", past && !item.done ? "text-danger-text" : "text-neutral-500")}>{stamp(item.at)}{past && !item.done && <span className="mt-1 block text-[10px] font-bold uppercase tracking-wide">{item.kind === "class" ? "Past" : "Overdue"}</span>}</span><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{item.type}</p><p className="mt-1 text-sm font-semibold text-neutral-800">{item.title}</p><p className="mt-1 text-xs text-neutral-400">{ventureName(item.ventureId)}</p></div></div></div>; }) : timeline.length === 0 ? <EmptyState variant="card" tone="blue" icon={CalendarDays} title="No milestones yet" body="Outcome reviews, class dates and open request deadlines appear here." /> : <EmptyState variant="filtered" title={`No ${timelineKinds[timelineFilter as keyof typeof timelineKinds] ?? "milestones"} on the timeline`} action={{ label: "Clear filters", onClick: () => setTimelineFilter("all") }} />}{todayIndex === -1 && timelineItems.length > 0 && <div className="flex items-center gap-2 px-4 py-2 text-[10px] font-bold uppercase tracking-[.12em] text-primary-700"><span className="h-px flex-1 bg-primary-300" />Today<span className="h-px flex-1 bg-primary-300" /></div>}</div></Panel>)}
      {!view && (<Panel><PanelHead title="Decision log" aside={<div className="flex items-center gap-2"><Badge>{visibleDecisions.length}</Badge>{visibleDecisions.length > 0 && canCreateCard("decision") && createButton("decision")}</div>} /><div className="divide-y divide-neutral-100">{visibleDecisions.length ? visibleDecisions.map((item) => <article key={item.id} data-flash-id={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.title}</h2><Badge tone={item.status === "approved" ? "green" : "amber"}>{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.text}</p><p className="mt-2 text-xs text-neutral-500">Reason: {item.reason}</p><p className="mt-1 text-xs text-neutral-400">{ventureName(item.ventureId)} · Decided {stamp(item.decidedAt)} · {item.evidence.length} evidence references</p>{canManage(item.ventureId) && <Select aria-label={`Status for decision ${item.title}`} disabled={updatingId === item.id} value={item.status} onChange={(event) => changeDecision(item, event.target.value as Decision["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="draft">Draft</option><option value="approved">Approved</option><option value="superseded">Superseded</option><option value="stale">Stale</option></Select>}</article>) : <EmptyState variant="card" tone="violet" icon={Scale} title="No decisions recorded yet" body="Record what was approved, why, and when to look at it again." action={cardCreate("decision", "Record decision")} />}</div></Panel>)}
      {!view && (<Panel><PanelHead title="Classes" aside={<div className="flex items-center gap-2"><Badge>{visibleClasses.length}</Badge>{visibleClasses.length > 0 && canCreateCard("class") && createButton("class")}</div>} /><div className="divide-y divide-neutral-100">{visibleClasses.length ? visibleClasses.map((item) => <article key={item.id} data-flash-id={item.id} className="p-5"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.title}</h2><Badge tone="blue">{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.objective}</p><p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · {stamp(item.scheduledAt)} · {item.durationMinutes} min · {item.participantIds.length} participant{item.participantIds.length === 1 ? "" : "s"}</p>{canManage(item.ventureId) && <Select aria-label={`Status for class ${item.title}`} disabled={updatingId === item.id} value={item.status} onChange={(event) => changeClass(item, event.target.value as Class["status"])} className={`${inputClass} mt-3 max-w-48`}><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></Select>}<button type="button" onClick={() => setSelectedClass(item)} className={`${secondaryClass} mt-3`}>Applications & assessments</button></article>) : <EmptyState variant="card" tone="blue" icon={CalendarDays} title="No classes scheduled yet" body="Schedule a class to connect a lesson to practice, assignments and assessment." action={cardCreate("class", "Schedule class")} />}</div></Panel>)}
      {!view && (<Panel className="xl:col-span-2"><PanelHead title="Information requests" aside={<div className="flex items-center gap-2"><Badge tone="amber">{visibleRequests.filter((item) => item.status === "open").length} open</Badge>{visibleRequests.length > 0 && canCreateCard("request") && createButton("request")}</div>} /><div className="divide-y divide-neutral-100">{visibleRequests.length ? visibleRequests.map((item) => <article key={item.id} className="flex flex-wrap items-start gap-3 p-5"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-neutral-800">{item.question}</h2><Badge tone={item.status === "open" ? "amber" : "green"}>{item.status}</Badge></div><p className="mt-2 text-sm leading-6 text-neutral-600">{item.purpose}</p>{item.responseMarkdown && <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-neutral-700 [overflow-wrap:anywhere]">Answer: {item.responseMarkdown}</p>}<p className="mt-2 text-xs text-neutral-400">{ventureName(item.ventureId)} · Due {stamp(item.dueAt)}</p></div>{item.respondentId === session?.user.id && item.status === "open" && <button type="button" onClick={() => { setSelected(item); setResponse(""); setSources(""); }} className={secondaryClass}>Answer</button>}</article>) : <EmptyState variant="card" tone="blue" icon={FileQuestion} title="No information requests yet" body="Ask a teammate for missing information and keep the answer with its sources." action={cardCreate("request", "New request")} />}</div></Panel>)}
    </div>)}
    {selected && <DetailDrawer title="Answer information request" subtitle={selected.question} onClose={() => setSelected(null)}><form onSubmit={answer} className="space-y-4"><label className="block"><span className="mb-1 block text-xs font-semibold text-neutral-600">Response</span><textarea required maxLength={100000} value={response} onChange={(event) => setResponse(event.target.value)} className={`${inputClass} min-h-44 py-3`} /></label><label className="block"><span className="mb-1 block text-xs font-semibold text-neutral-600">Source references, one per line</span><textarea value={sources} onChange={(event) => setSources(event.target.value)} className={`${inputClass} min-h-24 py-3`} /></label><p className="text-xs text-neutral-500">Only the assigned respondent can submit an answer.</p><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} busyText="Submitting…" idle="Submit answer" /></button></form></DetailDrawer>}
    {selectedClass && session && <LiveClassApplications item={selectedClass} session={session} memberName={(id) => id === session.user.id ? "You" : memberNames[id] ?? "Team member"} onClose={() => setSelectedClass(null)} />}
    {createKind && session && <PlanningCreateDrawer key={`${createKind}-${ventureId}`} kind={createKind} ventureId={ventureId} ventureName={ventureName(ventureId)} session={session} onClose={() => setCreateKind(null)} onCreated={(kind, title, destinationId) => { setCreateKind(null); setResult(`${kind === "request" ? "Information request" : kind[0]!.toUpperCase() + kind.slice(1)} “${title}” created in ${ventureName(destinationId)}.`); setRevision((value) => value + 1); }} />}
  </PageFrame>;
}
