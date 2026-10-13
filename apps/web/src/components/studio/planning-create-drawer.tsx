"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useState } from "react";
import { createLiveClass, createLiveDecision, createLiveInformationRequest, createLiveOutcome, loadLiveSession } from "@/lib/studio-api";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { X } from "@/components/ui/icons";
import { LiveMemberPicker } from "@/components/studio/live-member-picker";

export type PlanningCreateKind = "outcome" | "decision" | "class" | "request";
type Session = Awaited<ReturnType<typeof loadLiveSession>>;
const titles: Record<PlanningCreateKind, string> = { outcome: "30-day outcome", decision: "decision", class: "class", request: "information request" };
const localDateTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const now = () => localDateTime(new Date());
const later = (days: number) => localDateTime(new Date(Date.now() + days * 86_400_000));
const toIso = (value: string) => new Date(value).toISOString();

export function PlanningCreateDrawer({ kind, ventureId, ventureName, session, onClose, onCreated }: {
  kind: PlanningCreateKind; ventureId: string; ventureName: string; session: Session;
  onClose: () => void; onCreated: (kind: PlanningCreateKind, title: string, destinationId: string) => void;
}) {
  const [destinationId, setDestinationId] = useState(ventureId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ownerId, setOwnerId] = useState(session.user.id);
  const [priority, setPriority] = useState("medium");
  const [startAt, setStartAt] = useState(now);
  const [reviewAt, setReviewAt] = useState(() => later(30));
  const [successEvidence, setSuccessEvidence] = useState("");
  const [risk, setRisk] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reviewTrigger, setReviewTrigger] = useState("");
  const [scheduledAt, setScheduledAt] = useState(() => later(1));
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [facilitatorId, setFacilitatorId] = useState("");
  const [participantCandidate, setParticipantCandidate] = useState("");
  const [participants, setParticipants] = useState<Array<{ id: string; name: string }>>([]);
  const [respondentId, setRespondentId] = useState("");
  const [dueAt, setDueAt] = useState(() => later(7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!session.hierarchy.ventures.some((venture) => venture.id === destinationId) || (ventureId && destinationId !== ventureId)) { setError("The selected venture is unavailable. Reopen creation from the current venture."); return; }
    setBusy(true); setError("");
    try {
      if (kind === "outcome") {
        if (new Date(reviewAt) <= new Date(startAt)) throw new Error("Review must be after the start date.");
        const created = await createLiveOutcome({ ventureId: destinationId, title, description, ownerId, priority, startAt: toIso(startAt), reviewAt: toIso(reviewAt), successEvidence, status: "draft", ...(risk.trim() ? { risk: risk.trim() } : {}) });
        if (created.ventureId !== destinationId) throw new Error("The outcome was created outside the selected venture.");
      } else if (kind === "decision") {
        const created = await createLiveDecision({ ventureId: destinationId, title, text: description, ownerId, decidedAt: toIso(startAt), evidence: evidence.split("\n").map((line) => line.trim()).filter(Boolean), reason, affectedWork: [], reviewTrigger, status: "draft" });
        if (created.ventureId !== destinationId) throw new Error("The decision was created outside the selected venture.");
      } else if (kind === "class") {
        const created = await createLiveClass({ ventureId: destinationId, title, objective: description, scheduledAt: toIso(scheduledAt), durationMinutes, facilitatorId, participantIds: participants.map((member) => member.id), status: "scheduled" });
        if (created.ventureId !== destinationId) throw new Error("The class was created outside the selected venture.");
      } else {
        const created = await createLiveInformationRequest({ ventureId: destinationId, respondentId, question: title, purpose: description, dueAt: toIso(dueAt) });
        if (created.ventureId !== destinationId) throw new Error("The request was created outside the selected venture.");
      }
      onCreated(kind, title, destinationId);
    } catch (cause) { setError(describeError(cause, "Could not create the record.")); }
    finally { setBusy(false); }
  }

  const allowed = kind === "outcome" || kind === "decision" || kind === "class"
    ? session.membership.role === "admin" || (session.membership.role === "venture_head" && session.membership.ventureIds.includes(destinationId))
    : session.membership.role === "admin" || session.membership.ventureIds.includes(destinationId);
  const destinations = session.hierarchy.ventures.filter((venture) => session.membership.role === "admin" || session.membership.ventureIds.includes(venture.id));

  function changeDestination(id: string) {
    setDestinationId(id);
    setOwnerId(session.user.id);
    setFacilitatorId("");
    setRespondentId("");
    setParticipantCandidate("");
    setParticipants([]);
    setError("");
  }

  const dirty = Boolean(title.trim() || description.trim() || successEvidence.trim() || reason.trim() || risk.trim() || participants.length);
  return <DetailDrawer title={`New ${titles[kind]}`} subtitle="Connected planning record" dirty={dirty && !busy} onClose={onClose}>
    <form onSubmit={create} className="space-y-4">
      {ventureId ? <div aria-label="Planning destination" className="rounded-xl bg-neutral-50 p-3 text-sm"><span className="block text-xs font-semibold text-neutral-500">Destination venture</span><span className="font-bold text-neutral-800">{ventureName}</span></div> : <Field label="Destination venture"><Select required value={destinationId} onChange={(event) => changeDestination(event.target.value)} className={inputClass}><option value="">Choose a venture</option>{destinations.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}
      <Notice tone="error" message={destinationId && !allowed ? "Your role cannot create this record in the selected venture." : ""} />
      <Field label={kind === "request" ? "Question" : "Title"}><input required maxLength={kind === "request" ? 5000 : 200} value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} /></Field>
      <Field label={kind === "outcome" ? "Description" : kind === "decision" ? "Decision" : kind === "class" ? "Objective" : "Purpose"}><textarea required maxLength={kind === "decision" ? 10000 : kind === "request" || kind === "class" ? 2000 : 5000} value={description} onChange={(event) => setDescription(event.target.value)} className={`${inputClass} min-h-28 py-3`} /></Field>
      {(kind === "outcome" || kind === "decision") && destinationId && <LiveMemberPicker label="Owner" value={ownerId} onChange={setOwnerId} ventureId={destinationId} />}
      {kind === "outcome" && <><div className="grid gap-4 sm:grid-cols-2"><Field label="Start"><input type="datetime-local" required value={startAt} onChange={(event) => setStartAt(event.target.value)} className={inputClass} /></Field><Field label="Review"><input type="datetime-local" required value={reviewAt} onChange={(event) => setReviewAt(event.target.value)} className={inputClass} /></Field></div><Field label="Priority"><Select value={priority} onChange={(event) => setPriority(event.target.value)} className={inputClass}>{["low", "medium", "high", "urgent"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field><Field label="Success evidence"><textarea required maxLength={2000} value={successEvidence} onChange={(event) => setSuccessEvidence(event.target.value)} className={`${inputClass} min-h-20 py-3`} /></Field><Field label="Risk, optional"><textarea maxLength={2000} value={risk} onChange={(event) => setRisk(event.target.value)} className={`${inputClass} min-h-20 py-3`} /></Field></>}
      {kind === "decision" && <><Field label="Decided at"><input type="datetime-local" required value={startAt} onChange={(event) => setStartAt(event.target.value)} className={inputClass} /></Field><Field label="Reason"><textarea required maxLength={5000} value={reason} onChange={(event) => setReason(event.target.value)} className={`${inputClass} min-h-24 py-3`} /></Field><Field label="Evidence references, one per line"><textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} className={`${inputClass} min-h-20 py-3`} placeholder="document:…" /></Field><Field label="Review trigger, optional"><input maxLength={1000} value={reviewTrigger} onChange={(event) => setReviewTrigger(event.target.value)} className={inputClass} /></Field></>}
      {kind === "class" && <><div className="grid gap-4 sm:grid-cols-2"><Field label="Scheduled at"><input type="datetime-local" required value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} className={inputClass} /></Field><Field label="Duration in minutes"><input type="number" required min={1} max={480} value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} className={inputClass} /></Field></div>{destinationId && <><LiveMemberPicker label="Facilitator" value={facilitatorId} onChange={setFacilitatorId} ventureId={destinationId} /><LiveMemberPicker label="Add participant" value={participantCandidate} onChange={(id, member) => { if (member && !participants.some((item) => item.id === id)) setParticipants((items) => [...items, { id, name: member.name }]); setParticipantCandidate(""); }} ventureId={destinationId} excludeIds={participants.map((item) => item.id)} optional /></>}{participants.length > 0 && <div aria-label="Class participants" className="flex flex-wrap gap-2">{participants.map((member) => <button key={member.id} type="button" onClick={() => setParticipants((items) => items.filter((item) => item.id !== member.id))} aria-label={`Remove ${member.name}`} className="vso-enter-popover inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-neutral-100 pl-3 pr-2 text-xs font-semibold text-neutral-700 transition-[background-color,transform] duration-150 [transform-origin:left_center] hover:bg-danger-surface hover:text-danger-text active:scale-[0.95]">{member.name}<X size={12} aria-hidden="true" /></button>)}</div>}</>}
      {kind === "request" && <>{destinationId && <LiveMemberPicker label="Respondent" value={respondentId} onChange={setRespondentId} ventureId={destinationId} />}<Field label="Due at"><input type="datetime-local" required value={dueAt} onChange={(event) => setDueAt(event.target.value)} className={inputClass} /></Field></>}
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy || !allowed || !destinationId} className={primaryClass}><ActionLabel busy={busy} busyText="Creating…" idle={`Create ${titles[kind]}`} /></button><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button></div>
    </form>
  </DetailDrawer>;
}
