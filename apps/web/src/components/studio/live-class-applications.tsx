"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState } from "react";
import { createLiveClassApplication, listLiveClassApplications, listLiveClasses, loadLiveSession, reviewLiveClassApplication } from "@/lib/studio-api";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";
import { ActionLabel, Badge, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { EmptyState } from "@/components/ui/empty-state";
import { FileText } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { flashById } from "@/lib/motion";

type Class = Awaited<ReturnType<typeof listLiveClasses>>[number];
type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Application = Awaited<ReturnType<typeof listLiveClassApplications>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));

export function LiveClassApplications({ item, session, memberName, onClose }: { item: Class; session: Session; memberName: (id: string) => string; onClose: () => void }) {
  const [applications, setApplications] = useState<Application[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [exercise, setExercise] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [reviewing, setReviewing] = useState<Application | null>(null);
  const [assessment, setAssessment] = useState("");
  const [nextGap, setNextGap] = useState("");
  const [error, setError] = useState("");
  // The first load has not finished yet, and whether the last load failed; neither may look like "No applications yet".
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => listLiveClassApplications(item.id).then((page) => { if (active) { setApplications(page.items); setCursor(page.nextCursor); setError(""); setLoadError(""); setLoaded(true); } }).catch((cause: unknown) => { if (active) { const message = describeError(cause, "Check your connection and try again."); setError(message); setLoadError(message); } }));
    return () => { active = false; };
  }, [item.id, revision]);

  async function more() {
    if (!cursor) return;
    setBusy(true); setError("");
    try { const page = await listLiveClassApplications(item.id, cursor); setApplications((items) => [...items, ...page.items]); setCursor(page.nextCursor); }
    catch (cause) { setError(describeError(cause, "Could not load more applications.")); }
    finally { setBusy(false); }
  }

  async function apply(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { await createLiveClassApplication(item.id, { exercise, reviewerId }); setExercise(""); setReviewerId(""); setRevision((value) => value + 1); toast({ title: "Application submitted for review" }); }
    catch (cause) { setError(describeError(cause, "Could not submit the application.")); }
    finally { setBusy(false); }
  }

  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (!reviewing) return;
    setBusy(true); setError("");
    try { await reviewLiveClassApplication(item.id, reviewing.id, { assessment, ...(nextGap ? { nextGap } : {}) }); flashById(reviewing.id); setReviewing(null); setAssessment(""); setNextGap(""); setRevision((value) => value + 1); toast({ title: "Assessment recorded" }); }
    catch (cause) { setError(describeError(cause, "Could not review the application.")); }
    finally { setBusy(false); }
  }

  const showLoadError = !!loadError && applications.length === 0;
  const loading = !loaded && !showLoadError;
  const canApply = item.participantIds.includes(session.user.id);
  const canReviewAll = session.membership.role === "admin" || (session.membership.role === "venture_head" && !!item.ventureId && session.membership.ventureIds.includes(item.ventureId)) || item.facilitatorId === session.user.id;

  return <DetailDrawer title={item.title} subtitle="Class applications and assessments" onClose={onClose}>
    <p className="mb-4 text-sm text-neutral-600">{item.objective}</p>
    <Notice tone="error" message={showLoadError ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    <section><h3 className="text-sm font-semibold text-neutral-900">Applications</h3><div className="mt-3 space-y-3">{loading ? <SkeletonRows rows={2} label="Loading applications" className="px-0" /> : showLoadError ? <EmptyState variant="error" title="Could not load applications" body={loadError} action={{ label: "Try again", onClick: () => setRevision((value) => value + 1) }} className="rounded-2xl border border-neutral-100" /> : applications.length ? applications.map((application) => <article key={application.id} data-flash-id={application.id} className="rounded-xl bg-neutral-50 p-4"><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-neutral-700">Applicant {memberName(application.userId)}</p><Badge tone={application.reviewedAt ? "green" : "amber"}>{application.reviewedAt ? "Reviewed" : "Awaiting review"}</Badge></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">{application.exercise}</p>{application.assessment && <p className="mt-2 text-sm text-neutral-700">Assessment: {application.assessment}</p>}{application.nextGap && <p className="mt-1 text-xs text-neutral-500">Next gap: {application.nextGap}</p>}<p className="mt-2 text-xs text-neutral-400">Submitted {stamp(application.createdAt)} · Reviewer {memberName(application.reviewerId)}</p>{(canReviewAll || application.reviewerId === session.user.id) && <button type="button" onClick={() => { setReviewing(application); setAssessment(application.assessment ?? ""); setNextGap(application.nextGap ?? ""); }} className={`${secondaryClass} mt-3`}>{application.reviewedAt ? "Update assessment" : "Review application"}</button>}{reviewing?.id === application.id && <form onSubmit={review} className="vso-row-enter mt-4 space-y-3 border-t border-neutral-200 pt-4"><h3 className="text-sm font-semibold text-neutral-900">Assess application</h3><Field label="Assessment"><textarea required autoFocus maxLength={5000} value={assessment} onChange={(event) => setAssessment(event.target.value)} className={`${inputClass} min-h-32 py-3`} /></Field><Field label="Next gap, optional"><textarea maxLength={2000} value={nextGap} onChange={(event) => setNextGap(event.target.value)} className={`${inputClass} min-h-20 py-3`} /></Field><div className="flex gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} idle="Save assessment" /></button><button type="button" onClick={() => setReviewing(null)} className={secondaryClass}>Cancel</button></div></form>}</article>) : <EmptyState variant="card" tone="blue" icon={FileText} title="No applications yet" body={canApply ? "Submit your applied work below to get it reviewed." : "Applied work from participants appears here once it is submitted for review."} className="rounded-2xl border border-neutral-100" />}</div>{cursor && <button type="button" disabled={busy} onClick={more} className="mt-3 text-xs font-semibold text-primary-700 underline">Load more applications</button>}</section>
    {canApply && <form onSubmit={apply} className="mt-6 space-y-3 border-t border-neutral-100 pt-5"><h3 className="text-sm font-semibold text-neutral-900">Submit your applied work</h3><Field label="Exercise and evidence summary"><textarea required maxLength={5000} value={exercise} onChange={(event) => setExercise(event.target.value)} className={`${inputClass} min-h-32 py-3`} /></Field><LiveMemberPicker label="Reviewer" value={reviewerId} onChange={setReviewerId} ventureId={item.ventureId} excludeIds={[session.user.id]} /><p className="text-xs leading-5 text-neutral-500">The reviewer must be a different active member in this class scope. The server validates this.</p><button disabled={busy || !reviewerId} className={primaryClass}>Submit application</button></form>}
  </DetailDrawer>;
}
