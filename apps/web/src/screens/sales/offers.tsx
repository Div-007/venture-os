"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { BrainItem, Offer, OfferVersion } from "@venture-studio/contracts";
import { ArrowLeft, ChevronDown, ChevronRight, Plus } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, HeaderActions, HeaderLabel, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { useStudio } from "@/lib/studio-store";
import { forgetOffers, getOffer, listBrain, listOffers } from "@/lib/sales-api";
import { BrainForm, type BrainFormTarget } from "@/components/sales/brain-form";
import { approvedTwin, isApproved, liveItems, proposalsFor, retiredBy, sameTitle } from "@/components/sales/brain-model";
import { BrainReader } from "@/components/sales/brain-reader";
import { canHead, canWriteIn, useSalesLoad } from "@/components/sales/draft-shared";
import { Package } from "@/components/sales/lead-icons";
import { OfferEditor, type OfferEditorTarget } from "@/components/sales/offer-editor";
import { newestFirst, offerChip, sortOffers } from "@/components/sales/offer-model";
import { legacyItems, SHARED_KINDS, SharedNotes, sharedNotes } from "@/components/sales/offer-notes";
import { OfferPage } from "@/components/sales/offer-page";
import { useSalesShell } from "@/components/sales/sales-context";
import { forgetSetup } from "@/components/sales/setup-checks";
import { number, plural, useUrlParams } from "@/components/sales/sales-ui";

const backClass = "mb-3 inline-flex min-h-10 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";

/** One card per offer: name, state, the one-line summary, its leads, and how many changes wait for approval. */
function OfferCard({ offer, onOpen }: { offer: Offer; onOpen: () => void }) {
  const chip = offerChip(offer);
  const summary = (offer.approved ?? newestFirst(offer.proposals)[0])?.packet.summary;
  const waiting = offer.proposals.length;
  return <li className="min-w-0"><button type="button" onClick={onOpen} className="group flex h-full w-full flex-col rounded-2xl border border-neutral-100 bg-white p-4 text-left shadow-card transition-[border-color,transform] duration-150 hover:border-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.995] sm:p-5">
    <span className="flex items-start justify-between gap-3">
      <span className="min-w-0 text-[15px] font-extrabold leading-6 tracking-[-.01em] text-neutral-900 [overflow-wrap:anywhere]">{offer.name}</span>
      <span className="shrink-0 pt-0.5"><Badge tone={chip.tone}>{chip.label}</Badge></span>
    </span>
    <span className={clsx("mt-1 line-clamp-2 text-[13px] leading-5", summary ? "text-neutral-600" : "text-neutral-400")}>{summary || "No summary yet."}</span>
    <span className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-3.5 text-xs text-neutral-500">
      <span><b className="font-bold text-neutral-800 tnum">{number(offer.counts.leads)}</b> {offer.counts.leads === 1 ? "lead" : "leads"}</span>
      <span><b className="font-bold text-neutral-800 tnum">{number(offer.counts.open)}</b> open</span>
      {waiting > 0 && <Badge tone="amber">{waiting === 1 ? "1 change waiting" : `${waiting} changes waiting`}</Badge>}
      <ChevronRight size={16} aria-hidden="true" className="ml-auto shrink-0 text-neutral-300 transition-transform duration-150 group-hover:translate-x-0.5" />
    </span>
  </button></li>;
}

/**
 * Offers (route /sales/live/brain): what a venture sells, one packet per offer. The list shows a card per offer and, below, the notes
 * every offer shares; `?offer=` opens one offer (and `?version=` one of its versions), `?note=` one shared note, `?new=1` a new offer.
 */
export function OffersScreen() {
  const { session, ventureId, ventureName, refresh } = useSalesShell();
  const { setActiveVentureId } = useStudio();
  const { params, update } = useUrlParams();
  const offerId = params.get("offer") ?? "";
  const versionId = params.get("version") ?? "";
  // `?item=` is the old Sales knowledge link to one brain item: it opens the same reader.
  const noteId = params.get("note") || params.get("item") || "";
  const wantsNew = params.get("new") === "1";
  const canWrite = canWriteIn(session, ventureId);
  const head = canHead(session, ventureId);
  const offers = useSalesLoad(`offers|${ventureId}`, () => ventureId ? listOffers({ ventureId }) : Promise.resolve([] as Offer[]));
  const detail = useSalesLoad(`offer|${offerId}`, () => offerId ? getOffer(offerId) : Promise.resolve(null));
  const brain = useSalesLoad(`brain|${ventureId}`, () => ventureId ? listBrain({ ventureId }) : Promise.resolve([] as BrainItem[]));
  const [editor, setEditor] = useState<OfferEditorTarget | null>(null);
  const [noteForm, setNoteForm] = useState<BrainFormTarget | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  // Setup links here with ?new=1 to start an offer: open the editor, then drop the parameter.
  useEffect(() => {
    if (!wantsNew) return;
    queueMicrotask(() => { if (canWrite) setEditor({ mode: "new" }); update({ new: null }); });
  }, [wantsNew, canWrite, update]);
  // Opening an offer or a note (or going back) starts at the top of the page.
  const place = `${offerId}|${noteId}`;
  const lastPlace = useRef(place);
  useEffect(() => {
    if (lastPlace.current === place) return;
    lastPlace.current = place;
    top.current?.scrollIntoView({ block: "start" });
  }, [place]);

  const items = useMemo(() => brain.data ?? [], [brain.data]);
  const notes = useMemo(() => sharedNotes(items), [items]);
  const legacy = useMemo(() => legacyItems(items), [items]);
  const note = noteId ? liveItems(items).find((item) => item.id === noteId) : undefined;
  // A link to a note that is gone (discarded, or replaced by a newer approval) lets go.
  useEffect(() => {
    if (!noteId || brain.data === null || note) return;
    queueMicrotask(() => update({ note: null, item: null }, "replace"));
  }, [noteId, brain.data, note, update]);

  const listed = offers.data?.find((offer) => offer.id === offerId);
  const offer = detail.data ?? listed;
  const all = useMemo(() => sortOffers(offers.data ?? []), [offers.data]);
  const current = all.filter((item) => item.state !== "archived");
  const archived = all.filter((item) => item.state === "archived");

  const go = (changes: Record<string, string | null>) => update(changes, "push");
  const back = () => go({ offer: null, version: null, note: null, item: null });
  function changed() { forgetOffers(ventureId); forgetSetup(ventureId); refresh(); }
  function saved(version: OfferVersion) { changed(); go({ offer: version.offerId, version: version.id, note: null }); }
  function noteSaved(item: BrainItem) { brain.mutate((list) => list.some((entry) => entry.id === item.id) ? list.map((entry) => entry.id === item.id ? item : entry) : [item, ...list]); go({ offer: null, version: null, note: item.id }); }
  // Approving a note retires the version approved before under the same title, and the approved items it replaces.
  function noteApproved(item: BrainItem) { brain.mutate((list) => list.map((entry) => entry.id === item.id ? item : isApproved(entry) && (sameTitle(entry, item) || item.replaces?.includes(entry.id)) ? { ...entry, status: "archived" as const, replacedBy: item.id } : entry)); }
  function noteArchived(item: BrainItem) { brain.mutate((list) => list.map((entry) => entry.id === item.id ? item : entry)); update({ note: null, item: null }, "replace"); }

  if (!ventureId) {
    const ventures = session?.hierarchy.ventures.filter((venture) => session.membership.role === "admin" || session.membership.ventureIds.includes(venture.id)) ?? [];
    return <Panel><EmptyState variant="card" tone="blue" icon={Package} title="Pick a venture to see its offers" body="Each venture sells its own offers, each with the buyers, gates and message rules Claude works with. Choose one in the sidebar, or open one here.">
      {ventures.map((venture) => <button key={venture.id} type="button" onClick={() => setActiveVentureId(venture.id)} className={secondaryClass}>{venture.name}</button>)}
    </EmptyState></Panel>;
  }

  const backButton = <button type="button" onClick={back} className={backClass}><ArrowLeft size={15} aria-hidden="true" />All offers</button>;
  let content: React.ReactNode;
  if (noteId) {
    content = <>{backButton}{note
      ? <Panel className="overflow-hidden"><BrainReader key={note.id} item={note} twin={approvedTwin(note, items)} proposals={proposalsFor(note, items)} retires={retiredBy(note, items)} canApprove={head} canWrite={canWrite} showBack={false}
        onBack={back} onSelect={(item) => go({ note: item.id, item: null })} onEdit={(item) => setNoteForm({ mode: "edit", item })} onPropose={setNoteForm} onApproved={noteApproved} onArchived={noteArchived} /></Panel>
      : brain.error ? <Panel><EmptyState variant="error" title="Could not open this note" body={brain.error} action={{ label: brain.busy ? "Trying again…" : "Try again", onClick: brain.reload, disabled: brain.busy }} /></Panel>
        : <Panel className="space-y-3 p-6"><span className="vso-skeleton block h-6 w-1/2" /><span className="vso-skeleton block h-40 rounded-2xl" /></Panel>}</>;
  } else if (offerId) {
    content = <>{backButton}{offer
      ? <OfferPage key={offer.id} ventureId={ventureId} offer={offer} detail={detail.data} versionId={versionId} onVersion={(id) => go({ version: id || null })} onEditor={setEditor} onChanged={changed} />
      : detail.error && offers.data !== null
        ? <Panel><EmptyState variant="error" title="Could not open this offer" body={detail.error} action={{ label: detail.busy ? "Trying again…" : "Try again", onClick: detail.reload, disabled: detail.busy }} secondary={{ label: "All offers", onClick: back }} /></Panel>
        : <div role="status" aria-label="Loading the offer" className="space-y-4"><Panel className="space-y-3 p-6"><span className="vso-skeleton block h-3 w-16" /><span className="vso-skeleton block h-7 w-1/2" /><span className="vso-skeleton block h-4 w-2/3" /></Panel><Panel className="space-y-3 p-6"><span className="vso-skeleton block h-4 w-1/4" /><span className="vso-skeleton block h-32 rounded-2xl" /></Panel></div>}</>;
  } else {
    const loaded = offers.data !== null;
    const name = ventureName(ventureId);
    content = <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <p className="min-w-0 text-sm font-semibold text-neutral-600">{name}{loaded && all.length > 0 ? ` · ${plural(current.length, "offer")}` : ""}</p>
        {canWrite && loaded && all.length > 0 && <HeaderActions className="ml-auto"><button type="button" onClick={() => setEditor({ mode: "new" })} className={primaryClass}><Plus size={15} /><HeaderLabel>New offer</HeaderLabel></button></HeaderActions>}
      </div>
      {offers.error && !loaded
        ? <Panel><EmptyState variant="error" title="Could not load the offers" body={offers.error} action={{ label: offers.busy ? "Trying again…" : "Try again", onClick: offers.reload, disabled: offers.busy }} /></Panel>
        : !loaded
          ? <ul role="status" aria-label="Loading the offers" className="grid gap-3 md:grid-cols-2">{[0, 1].map((index) => <li key={index}><Panel className="space-y-3 p-5"><span className="vso-skeleton block h-4 w-1/3" /><span className="vso-skeleton block h-3 w-4/5" /><span className="vso-skeleton block h-3 w-1/2" /></Panel></li>)}</ul>
          : current.length === 0 && archived.length === 0
            ? <Panel><EmptyState variant="card" tone="green" icon={Package} title="No offers yet" body="Create one, or ask Claude to draft one: tell Claude about the offer and it proposes the packet for a venture head to approve." action={canWrite ? { label: "New offer", icon: Plus, onClick: () => setEditor({ mode: "new" }) } : undefined} /></Panel>
            : <>
              {current.length > 0
                ? <ul aria-label="Offers" className="grid gap-3 md:grid-cols-2">{current.map((item) => <OfferCard key={item.id} offer={item} onOpen={() => go({ offer: item.id, version: null, note: null })} />)}</ul>
                : <Panel><EmptyState variant="compact" title="Every offer is archived" body="Activate one from its page, or start a new one." /></Panel>}
              {archived.length > 0 && <div className="mt-3">
                <button type="button" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1 text-xs font-semibold text-neutral-500 transition-colors duration-150 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{showArchived ? "Hide archived offers" : `Archived offers · ${archived.length}`}<ChevronDown size={14} aria-hidden="true" className={clsx("transition-transform duration-150", showArchived && "rotate-180")} /></button>
                {showArchived && <ul aria-label="Archived offers" className="vso-fade-enter mt-2 grid gap-3 md:grid-cols-2">{archived.map((item) => <OfferCard key={item.id} offer={item} onOpen={() => go({ offer: item.id, version: null, note: null })} />)}</ul>}
              </div>}
            </>}
      <div className="mt-6"><SharedNotes ventureName={name} items={notes} legacy={legacy} loading={brain.data === null && !brain.error} error={brain.error} canWrite={canWrite} onOpen={(item) => go({ note: item.id })} onAdd={() => setNoteForm({ mode: "propose", kind: "notes" })} /></div>
    </>;
  }

  return <div ref={top} className="scroll-mt-4">
    {content}
    {editor && <OfferEditor ventureId={ventureId} target={editor} onClose={() => setEditor(null)} onSaved={saved} />}
    {noteForm && <BrainForm ventureId={ventureId} target={noteForm} kinds={SHARED_KINDS} onClose={() => setNoteForm(null)} onSaved={noteSaved} />}
  </div>;
}
