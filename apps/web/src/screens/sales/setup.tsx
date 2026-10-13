"use client";
import { useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, CircleCheck, Plus, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { createLivePipeline } from "@/lib/studio-api";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { ActionLabel, Badge, Field, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { useStudio } from "@/lib/studio-store";
import { canHead, isLearner, useSalesLoad } from "@/components/sales/draft-shared";
import { Package } from "@/components/sales/lead-icons";
import { OfferEditor } from "@/components/sales/offer-editor";
import { newestFirst, offerHref } from "@/components/sales/offer-model";
import { PlayForm } from "@/components/sales/play-form";
import { useSalesShell } from "@/components/sales/sales-context";
import { DEFAULT_SETTINGS } from "@/components/sales/setup-api";
import { daysLabel, evaluateSetup, loadSetupData, sellersOf, SETUP_TOTAL, usableOffersOf, type SetupData, type SetupItem, type SetupKey } from "@/components/sales/setup-checks";
import { SetupItemCard } from "@/components/sales/setup-item";
import { SetupSearchKeys } from "@/components/sales/setup-search-keys";
import { SetupSettingsForm } from "@/components/sales/setup-settings-form";

const ROLE_LABEL: Record<string, string> = { admin: "Admin", venture_head: "Venture head", contributor: "Contributor", reviewer: "Reviewer", learner: "Learner" };

/** Set up sales for {venture} (route /sales/live/setup): a checklist that makes a venture sales-ready, each step completed in place. */
export function SetupScreen() {
  const { session, ventureId, ventureName, refresh } = useSalesShell();
  const { setActiveVentureId } = useStudio();
  const checks = useSalesLoad<SetupData | null>(`setup|${ventureId}`, () => ventureId ? loadSetupData(ventureId) : Promise.resolve(null));
  const [offerForm, setOfferForm] = useState(false);
  const [playForm, setPlayForm] = useState(false);
  const [pipelineForm, setPipelineForm] = useState(false);
  const learner = isLearner(session);
  const head = canHead(session, ventureId);
  const canWrite = !learner;
  const data = checks.data;

  function changed() { checks.reload(); refresh(); }

  if (!ventureId) {
    const ventures = session?.hierarchy.ventures.filter((venture) => session.membership.role === "admin" || session.membership.ventureIds.includes(venture.id)) ?? [];
    return <Panel><EmptyState variant="card" tone="blue" icon={Sparkles} title="Pick a venture to set up for sales" body="Each venture has its own pipeline, offer, buyers and rules. Choose one in the sidebar, or open one here.">
      {ventures.map((venture) => <button key={venture.id} type="button" onClick={() => setActiveVentureId(venture.id)} className={secondaryClass}>{venture.name}</button>)}
    </EmptyState></Panel>;
  }
  if (checks.error && !data) return <Panel><EmptyState variant="error" title="Could not check the setup" body={checks.error} action={{ label: checks.busy ? "Trying again…" : "Try again", onClick: checks.reload, disabled: checks.busy }} /></Panel>;
  if (!data) return <div role="status" aria-label="Checking the setup" className="space-y-4"><Panel className="space-y-3 p-5"><span className="vso-skeleton block h-5 w-1/3" /><span className="vso-skeleton block h-2 w-full" /></Panel>{[0, 1, 2, 3].map((index) => <Panel key={index} className="flex items-center gap-3 p-4"><span className="vso-skeleton h-8 w-8 shrink-0 rounded-full" /><span className="vso-skeleton h-3 w-1/2" /></Panel>)}</div>;

  const items = evaluateSetup(data);
  const done = items.filter((item) => item.done).length;
  const name = ventureName(ventureId);

  const offers = data.offers.data ?? [];
  const usable = usableOffersOf(offers);
  const offerAction = (item: SetupItem) => {
    if (item.unknown) return <WorkspaceLink href={offerHref(ventureId)} className={secondaryClass}><Package size={15} />Open Offers</WorkspaceLink>;
    if (item.done) return <WorkspaceLink href={offerHref(ventureId, usable.length === 1 ? usable[0]!.id : undefined)} className={secondaryClass}><Package size={15} />Open {usable.length === 1 ? "the offer" : "Offers"}</WorkspaceLink>;
    // A proposal waiting comes first: approving it is the shortest way to a usable offer. Then a paused offer, then a new one.
    const waiting = offers.filter((offer) => offer.state !== "archived" && offer.proposals.length > 0);
    const first = waiting[0];
    const paused = offers.find((offer) => offer.approved && offer.state === "paused");
    const proposals = waiting.reduce((sum, offer) => sum + offer.proposals.length, 0);
    return <div className="flex flex-wrap items-center gap-2">
      {first && <WorkspaceLink href={offerHref(ventureId, first.id, newestFirst(first.proposals)[0]!.id)} className={head ? primaryClass : secondaryClass}>{head ? `Review ${proposals === 1 ? "the proposal" : `${proposals} proposals`}` : `See ${proposals === 1 ? "the proposal" : "the proposals"}`}<ArrowUpRight size={14} aria-hidden="true" /></WorkspaceLink>}
      {!first && paused && <WorkspaceLink href={offerHref(ventureId, paused.id)} className={head ? primaryClass : secondaryClass}>{head ? `Activate ${paused.name}` : `Open ${paused.name}`}<ArrowUpRight size={14} aria-hidden="true" /></WorkspaceLink>}
      {canWrite && !first && !paused && <button type="button" onClick={() => setOfferForm(true)} className={primaryClass}><Plus size={15} />Create the offer</button>}
      {first && !head && <span className="text-xs text-neutral-500">A venture head approves it.</span>}
      {!first && !paused && <span className="text-xs text-neutral-500">Or tell Claude about the offer and it proposes the packet.</span>}
    </div>;
  };

  const actions: Record<SetupKey, (item: SetupItem) => React.ReactNode> = {
    pipeline: (item) => item.done ? null : !head ? <p className="text-xs text-neutral-500">A venture head or admin creates the pipeline.</p> : pipelineForm
      ? <PipelineForm ventureId={ventureId} defaultName={`${name} opportunities`} defaultOffer={usable[0]?.name ?? ""} onCancel={() => setPipelineForm(false)} onCreated={() => { setPipelineForm(false); changed(); }} />
      : <button type="button" onClick={() => setPipelineForm(true)} className={primaryClass}><Plus size={15} />Create the pipeline</button>,
    offer: offerAction,
    play: (item) => <div className="flex flex-wrap items-center gap-2">
      {item.done ? <WorkspaceLink href="/sales/live/plays" className={secondaryClass}>See the plays<ArrowUpRight size={14} aria-hidden="true" /></WorkspaceLink> : canWrite && !item.unknown && <button type="button" onClick={() => setPlayForm(true)} className={primaryClass}><Plus size={15} />Plan the first play</button>}
      {!item.done && <span className="text-xs text-neutral-500">A venture head approves it before it starts.</span>}
    </div>,
    team: () => {
      const members = data.members.data ?? [];
      return <div className="space-y-3">
        {members.length > 0 && <ul className="flex flex-wrap gap-2">{members.map((member) => <li key={member.id} className="inline-flex items-center gap-2 rounded-xl bg-neutral-50 py-1.5 pl-1.5 pr-3 text-xs"><span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-primary-50 text-[10px] font-bold text-primary-700">{member.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("")}</span><span className="font-semibold text-neutral-800">{member.name}</span><Badge tone={member.role === "learner" ? "neutral" : "blue"}>{ROLE_LABEL[member.role] ?? member.role}</Badge></li>)}</ul>}
        <div className="flex flex-wrap items-center gap-2">
          {session?.membership.role === "admin" ? <WorkspaceLink href="/admin/live" className={secondaryClass}>People &amp; access<ArrowUpRight size={14} aria-hidden="true" /></WorkspaceLink> : <span className="text-xs text-neutral-500">An admin adds people to {name} in People &amp; access.</span>}
          {sellersOf(members).length > 0 && <span className="text-xs text-neutral-500">Learners can read but not write.</span>}
        </div>
      </div>;
    },
    settings: () => {
      const settings = data.settings.data;
      if (data.settings.error === undefined && !settings) return <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">Defaults in use: {daysLabel(DEFAULT_SETTINGS.workingDays)}, follow-up after {DEFAULT_SETTINGS.followUpAfterWorkingDays} working days, {DEFAULT_SETTINGS.dailyCaps.email} emails and {DEFAULT_SETTINGS.dailyCaps.whatsapp} WhatsApp a day. This server cannot change them yet.</p>;
      if (!settings) return null;
      return head
        ? <SetupSettingsForm key={settings.updatedAt ?? "defaults"} ventureId={ventureId} initial={settings} onSaved={changed} />
        : <p className="text-xs text-neutral-500">A venture head or admin sets these.</p>;
    },
    connect: (item) => <div className="flex flex-wrap items-center gap-2">
      <WorkspaceLink href="/connect/live" className={item.done ? secondaryClass : primaryClass}><Sparkles size={15} />{item.done ? "Manage keys" : "Connect Claude"}</WorkspaceLink>
      <span className="text-xs text-neutral-500">Choose the <b className="font-semibold text-neutral-700">Dealflow Sales</b> connector. Claude never sends anything: you do.</span>
    </div>,
  };

  return <>
    <Panel className="mb-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-lg font-extrabold tracking-[-.02em] text-neutral-900">Set up sales for {name}</h2><p className="mt-1 max-w-xl text-xs leading-5 text-neutral-500">Six things make a venture ready for Claude to research leads and write drafts for. Do them in any order.</p></div>
        <span className={clsx("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold", done === SETUP_TOTAL ? "bg-success-surface text-success-text" : "bg-neutral-100 text-neutral-700")}>{done === SETUP_TOTAL && <CircleCheck size={14} aria-hidden="true" />}<span className="tnum">{done} of {SETUP_TOTAL} done</span></span>
      </div>
      <div role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={SETUP_TOTAL} aria-valuenow={done} className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-100"><div className="h-full rounded-full bg-primary-600 transition-[width] duration-300" style={{ width: `${(done / SETUP_TOTAL) * 100}%` }} /></div>
      {learner && <p className="mt-3 text-xs text-neutral-500">You can read the checklist. A contributor or venture head does the steps.</p>}
    </Panel>
    {checks.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{checks.error}</p>}
    <ol className="space-y-3">{items.map((item, index) => <SetupItemCard key={`${item.key}-${item.done}`} number={index + 1} item={item}>{learner ? null : actions[item.key](item)}</SetupItemCard>)}</ol>
    {session?.membership.role === "admin" && <SetupSearchKeys />}
    {offerForm && <OfferEditor ventureId={ventureId} target={{ mode: "new" }} onClose={() => setOfferForm(false)} onSaved={changed} />}
    {playForm && <PlayForm onClose={() => setPlayForm(false)} onSaved={changed} />}
  </>;
}

/** Inline form for the pipeline: a name, and the offer it sells (taken from the approved offer when there is one). */
function PipelineForm({ ventureId, defaultName, defaultOffer, onCancel, onCreated }: { ventureId: string; defaultName: string; defaultOffer: string; onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState(defaultName);
  const [offer, setOffer] = useState(defaultOffer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !offer.trim()) { setError("Give the pipeline a name and say which offer it sells."); return; }
    setBusy(true); setError("");
    try { const created = await createLivePipeline({ ventureId, name: name.trim(), offerName: offer.trim(), status: "active" }); toast({ title: "Pipeline created", body: created.name }); onCreated(); }
    catch (cause) { setError(describeError(cause, "Could not create the pipeline. Try again.")); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-3 rounded-2xl bg-neutral-50 p-4">
    <Field label="Pipeline name"><input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} /></Field>
    <Field label="Which offer does it sell?"><input required maxLength={200} value={offer} onChange={(event) => setOffer(event.target.value)} placeholder="Dealer catalogue and orders" className={inputClass} /></Field>
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
    <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} busyText="Creating…" idle="Create the pipeline" /></button><button type="button" onClick={onCancel} className={secondaryClass}>Cancel</button></div>
  </form>;
}

