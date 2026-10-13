"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { Activity, Lead } from "@venture-studio/contracts";
import { CircleAlert, Edit, Mail, MessageCircle, type Icon } from "@/components/ui/icons";
import { Badge, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { listPlays } from "@/lib/sales-api";
import { LeadConsent } from "@/components/sales/lead-consent";
import { dealFacts, LeadDeal } from "@/components/sales/lead-deal";
import { activityHeading } from "@/components/sales/lead-timeline";
import { callablePhone, emailOf, hostOf, isOverdue, Lock, mailHref, Phone, safeUrl, telHref, timeAgo, VerdictChip, waHref, whatsappTarget, when } from "@/components/sales/sales-ui";

const labelClass = "text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400";
const sub = "text-xs leading-5 text-neutral-500";

/** Play names by id, per venture, kept for a minute so opening one lead after another does not ask again. */
const playNames = new Map<string, { at: number; names: Promise<Record<string, string>> }>();
function usePlayName(lead: Lead): string {
  const [name, setName] = useState("");
  const { playId, ventureId } = lead;
  useEffect(() => {
    if (!playId) return;
    let active = true;
    const cached = playNames.get(ventureId);
    const entry = cached && Date.now() - cached.at < 60_000 ? cached : { at: Date.now(), names: listPlays({ ventureId }).then((items) => Object.fromEntries(items.map((play) => [play.id, play.name]))) };
    playNames.set(ventureId, entry);
    entry.names.then((names) => { if (active) setName(names[playId] ?? ""); }).catch(() => { playNames.delete(ventureId); });
    return () => { active = false; };
  }, [playId, ventureId]);
  return playId ? name : "";
}

function Tile({ label, aside, className, children }: { label: string; aside?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <section aria-label={label} className={clsx("min-w-0 rounded-2xl border border-neutral-100 bg-neutral-50 p-3.5", className)}>
    <div className="flex min-h-6 items-center justify-between gap-2"><h3 className={labelClass}>{label}</h3>{aside}</div>
    <div className="mt-1.5 grid grid-cols-1 gap-1.5">{children}</div>
  </section>;
}

function TileEdit({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-label={label} className="-mr-1 inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"><Edit size={12} />Edit</button>;
}

/** One way to reach them, on one row: the number or address, and its own small button. */
function RouteLine({ icon: RouteIcon, value, action }: { icon: Icon; value: string; action: React.ReactNode }) {
  return <div className="flex min-h-9 items-center justify-between gap-2">
    <span className="flex min-w-0 flex-1 items-center gap-2"><RouteIcon size={14} className="shrink-0 text-neutral-400" /><span className="line-clamp-2 min-w-0 text-sm font-semibold leading-5 text-neutral-800 [overflow-wrap:anywhere]" title={value}>{value}</span></span>
    {action}
  </div>;
}
const rowButton = "!min-h-10 min-w-[5.75rem] !gap-1.5 !px-3 !text-xs sm:!min-h-9";

function ReachTile({ lead, activities, canEdit, personName, onChanged }: { lead: Lead; activities: Activity[]; canEdit: boolean; personName: (id: string) => string; onChanged: () => void }) {
  if (lead.doNotContact) {
    return <Tile label="Reach">
      <p className="flex items-center gap-2 text-[15px] font-bold text-danger-text"><Lock size={16} />Do not contact</p>
      <p className={sub}>Calling, email and WhatsApp are switched off for this company.</p>
    </Tile>;
  }
  const phone = callablePhone(lead);
  const email = emailOf(lead);
  const whatsapp = whatsappTarget(lead);
  const tel = phone ? telHref(phone) : undefined;
  const mail = email ? mailHref(email) : undefined;
  const wa = whatsapp ? waHref(whatsapp) : undefined;
  // WhatsApp consent only matters when there is a number to message (or Claude logged a yes that a person has to confirm).
  const consent = !!phone || !!lead.whatsappOptIn || activities.some((activity) => activity.via === "claude" && (activity.callOutcome === "yes_whatsapp" || (activity.kind === "whatsapp" && activity.direction === "in")));
  return <Tile label="Reach">
    {phone || email ? <div className="grid grid-cols-1 gap-0.5">
      {phone && <RouteLine icon={Phone} value={phone} action={tel ? <a href={tel} aria-label={`Call ${phone}`} className={clsx(primaryClass, rowButton)}><Phone size={14} />Call</a> : null} />}
      {email && <RouteLine icon={Mail} value={email} action={mail ? <a href={mail} aria-label={`Email ${email}`} className={clsx(secondaryClass, rowButton)}><Mail size={14} />Email</a> : null} />}
      {wa && <RouteLine icon={MessageCircle} value="WhatsApp is open" action={<a href={wa} target="_blank" rel="noopener noreferrer" className={clsx(secondaryClass, rowButton)}><MessageCircle size={14} />WhatsApp</a>} />}
    </div> : <>
      <p className="text-sm font-semibold text-neutral-400">No contact route yet</p>
      <p className={sub}>Claude finds routes while researching.</p>
    </>}
    {consent && <div className={clsx((phone || email) && "mt-1 border-t border-neutral-200/70 pt-2.5")}><LeadConsent lead={lead} activities={activities} canEdit={canEdit} personName={personName} onChanged={onChanged} /></div>}
  </Tile>;
}

function DealTile({ lead, canEdit, editing, onEdit, onSaved, onDirty }: { lead: Lead; canEdit: boolean; editing: boolean; onEdit: (editing: boolean) => void; onSaved: () => void; onDirty: (key: string, dirty: boolean) => void }) {
  const facts = dealFacts(lead);
  const closed = lead.stage === "lost" || lead.stage === "disqualified";
  if (editing) return <Tile label="Deal" className="sm:order-first sm:col-span-2"><LeadDeal lead={lead} onSaved={onSaved} onCancel={() => onEdit(false)} onDirty={onDirty} /></Tile>;
  return <Tile label="Deal" aside={canEdit ? <TileEdit label="Edit the deal" onClick={() => onEdit(true)} /> : undefined}>
    {facts.value ? <p className="text-xl font-extrabold leading-7 text-neutral-900 tnum" title={facts.valueFull}>{facts.valueShort}</p> : <p className="text-sm font-semibold text-neutral-400">No value yet</p>}
    <p className={sub}>{[facts.closes ? `Closes ${facts.closes}` : "No close date", facts.chanceNote].join(" · ")}</p>
    {facts.value > 0 && !closed && <p className={sub} title={facts.weightedFull}>Counts as <strong className="font-semibold text-neutral-700">{facts.weightedShort}</strong> in the forecast</p>}
    {facts.lostWhy && <p className="text-xs font-semibold leading-5 text-danger-text">Lost: {facts.lostWhy}</p>}
    {!facts.value && canEdit && <button type="button" onClick={() => onEdit(true)} className="inline-flex min-h-9 items-center justify-self-start text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Add a value</button>}
  </Tile>;
}

function VerdictTile({ lead, onReadEvidence }: { lead: Lead; onReadEvidence: () => void }) {
  const verdict = lead.verdict;
  return <Tile label="Claude's verdict">
    {verdict ? <>
      <div className="flex flex-wrap items-center gap-1.5"><VerdictChip verdict={verdict} />{lead.fitBand && <Badge>Fit {lead.fitBand}</Badge>}</div>
      <p className="line-clamp-2 text-sm font-medium leading-5 text-neutral-700">{verdict.summary}</p>
    </> : <>
      <p className="text-sm font-semibold text-neutral-400">Not judged yet</p>
      <p className={sub}>Claude judges a lead before it is approved for contact.</p>
    </>}
    {lead.needsYou && <p className="flex items-start gap-1.5 text-xs font-semibold leading-5 text-warning-text"><CircleAlert size={14} className="mt-0.5 shrink-0" />Waiting for your decision</p>}
    {verdict && <button type="button" onClick={onReadEvidence} className="inline-flex min-h-8 items-center justify-self-start text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Read evidence</button>}
  </Tile>;
}

function PlayTile({ lead }: { lead: Lead }) {
  const play = usePlayName(lead);
  const source = safeUrl(lead.source);
  const tags = lead.tags.slice(0, 4);
  return <Tile label="Play and source">
    <p className={clsx("text-[15px] font-bold [overflow-wrap:anywhere]", lead.playId ? "text-neutral-900" : "text-neutral-400")}>{lead.playId ? play || "A play" : "No play"}</p>
    <p className={clsx(sub, "[overflow-wrap:anywhere]")}>{lead.source ? <>From {source ? <a href={source} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center font-semibold text-primary-700 hover:underline">{hostOf(source)}</a> : lead.source}</> : "Source not recorded"}</p>
    {tags.length > 0 && <div className="flex flex-wrap gap-1">{tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}{lead.tags.length > tags.length && <span className="self-center text-[11px] font-semibold text-neutral-400">+{lead.tags.length - tags.length}</span>}</div>}
  </Tile>;
}

function LastTouchTile({ lead, activities, personName }: { lead: Lead; activities: Activity[]; personName: (id: string) => string }) {
  const last = [...activities].filter((activity) => activity.via !== "system").sort((a, b) => b.at.localeCompare(a.at))[0];
  return <Tile label="Last touch">
    {last ? <>
      <p className="text-[15px] font-bold leading-5 text-neutral-900">{activityHeading(last)}</p>
      <p className={sub}>{timeAgo(last.at)} · {last.via === "claude" ? "logged by Claude" : `by ${personName(last.actorId)}`}</p>
    </> : lead.lastTouchAt ? <p className="text-[15px] font-bold text-neutral-900">{timeAgo(lead.lastTouchAt)}</p> : <>
      <p className="text-sm font-semibold text-neutral-400">Not contacted yet</p>
      <p className={sub}>Calls, messages and notes will show here.</p>
    </>}
  </Tile>;
}

function FollowUpTile({ lead, activities }: { lead: Lead; activities: Activity[] }) {
  const closed = lead.stage === "lost" || lead.stage === "disqualified";
  const replied = [...activities].filter((activity) => activity.direction === "in").sort((a, b) => b.at.localeCompare(a.at))[0];
  let body: React.ReactNode;
  if (closed) body = <><p className="text-sm font-semibold text-neutral-400">Closed</p><p className={sub}>No follow-ups once a lead is closed.</p></>;
  else if (lead.doNotContact) body = <><p className="text-sm font-semibold text-danger-text">Stopped: do not contact</p></>;
  else if (lead.followUpDueAt) {
    const overdue = isOverdue(lead.followUpDueAt);
    body = <><p className={clsx("text-[15px] font-bold", overdue ? "text-danger-text" : "text-neutral-900")}>{overdue ? "Overdue · " : "Due "}{when(lead.followUpDueAt)}</p><p className={sub}>It stops by itself if they reply.</p></>;
  } else if (replied) body = <><p className="text-[15px] font-bold text-neutral-900">Stopped: they replied</p><p className={sub}>{timeAgo(replied.at)}. A person takes it from here.</p></>;
  else body = <><p className="text-sm font-semibold text-neutral-400">None scheduled</p><p className={sub}>It starts after the first message goes out.</p></>;
  return <Tile label="Follow-up">{body}</Tile>;
}

/** The glance: six small tiles that answer "can I reach them, what is it worth, what does Claude think, what happened last, what is due" without opening anything. */
export function LeadGlance({ lead, activities, canEdit, editingDeal, onEditDeal, onReadEvidence, personName, onChanged, onDirty }: {
  lead: Lead; activities: Activity[]; canEdit: boolean; editingDeal: boolean; onEditDeal: (editing: boolean) => void; onReadEvidence: () => void; personName: (id: string) => string; onChanged: () => void; onDirty: (key: string, dirty: boolean) => void;
}) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <ReachTile lead={lead} activities={activities} canEdit={canEdit} personName={personName} onChanged={onChanged} />
    <DealTile lead={lead} canEdit={canEdit} editing={editingDeal} onEdit={onEditDeal} onSaved={onChanged} onDirty={onDirty} />
    <VerdictTile lead={lead} onReadEvidence={onReadEvidence} />
    <PlayTile lead={lead} />
    <LastTouchTile lead={lead} activities={activities} personName={personName} />
    <FollowUpTile lead={lead} activities={activities} />
  </div>;
}
