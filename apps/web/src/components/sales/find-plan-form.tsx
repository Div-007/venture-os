"use client";
import { useState } from "react";
import clsx from "clsx";
import { Plus } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Field, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { createFindRun, listPlays, type FindRun } from "@/lib/sales-api";
import { ChipsField } from "./chips-field";
import { kickerClass, useSalesLoad, writableVentures } from "./draft-shared";
import { offerHref, offerIsUsable, sortOffers, useVentureOffers } from "./offer-model";
import { useSalesShell } from "./sales-context";

export type FindTemplate = { request: string; places: string[]; categories: string[]; searches: string[]; limit: number; ventureId?: string; playId?: string; offerId?: string };
export const templateOf = (run: FindRun): FindTemplate => ({ request: run.request, places: run.plan.places, categories: run.plan.categories, searches: run.plan.searches, limit: run.plan.limit, ventureId: run.ventureId, ...(run.playId ? { playId: run.playId } : {}), ...(run.offerId ? { offerId: run.offerId } : {}) });

/** Describe the audience, add optional places, categories and searches, then save the plan or queue it for the lead finder. */
export function FindPlanForm({ template, onCreated }: { template?: FindTemplate | undefined; onCreated: (run: FindRun) => void }) {
  const { session, ventureId, ventureName, refresh, refreshKey } = useSalesShell();
  const ventures = writableVentures(session);
  const [request, setRequest] = useState(template?.request ?? "");
  const [places, setPlaces] = useState(template?.places ?? []);
  const [categories, setCategories] = useState(template?.categories ?? []);
  const [searches, setSearches] = useState(template?.searches ?? []);
  const [limit, setLimit] = useState(String(template?.limit ?? 50));
  const [venturePick, setVenturePick] = useState(template?.ventureId ?? "");
  const [playPick, setPlayPick] = useState(template?.playId ?? "");
  const [offerPick, setOfferPick] = useState(template?.offerId ?? "");
  const [more, setMore] = useState(Boolean(template && (template.places.length || template.categories.length || template.searches.length)));
  const [busy, setBusy] = useState<"" | "save" | "queue">("");
  const [error, setError] = useState("");

  const targetVenture = ventureId || venturePick || (ventures.length === 1 ? ventures[0]!.id : "");
  const plays = useSalesLoad(`find-plays|${targetVenture}`, () => targetVenture ? listPlays({ ventureId: targetVenture }) : Promise.resolve([]));
  const playOptions = (plays.data ?? []).filter((play) => play.status !== "done");
  const play = playPick && playOptions.some((item) => item.id === playPick) ? playPick : "";
  // The run's offer drives the search. Only usable offers (active, approved) can be named: the one picked, else the play's, else the only one.
  const offers = useVentureOffers(targetVenture, refreshKey);
  const usable = sortOffers((offers ?? []).filter(offerIsUsable));
  const playOffer = playOptions.find((item) => item.id === play)?.offerId;
  const offerId = usable.some((item) => item.id === offerPick) ? offerPick : playOffer && usable.some((item) => item.id === playOffer) ? playOffer : usable.length === 1 ? usable[0]!.id : "";
  const chosenOffer = usable.find((item) => item.id === offerId);

  async function submit(queue: boolean) {
    const count = Number(limit);
    if (request.trim().length < 3) { setError("Describe who you want to find, in a sentence."); return; }
    if (!targetVenture) { setError("Choose which venture this search is for."); return; }
    if (usable.length > 1 && !offerId) { setError("Choose which offer this search is for."); return; }
    if (!Number.isInteger(count) || count < 1 || count > 500) { setError("The limit is a whole number from 1 to 500."); return; }
    setBusy(queue ? "queue" : "save"); setError("");
    try {
      const run = await createFindRun({ ventureId: targetVenture, ...(play ? { playId: play } : {}), ...(offerId ? { offerId } : {}), request: request.trim(), plan: { places, categories, searches, limit: count } }, { queue });
      toast({ title: queue ? "Queued for the lead finder" : "Plan saved", body: queue ? "The built-in finder picks it up shortly; results show under Runs." : "Queue it when you are happy with it." });
      setRequest(""); setPlaces([]); setCategories([]); setSearches([]); setMore(false);
      onCreated(run); refresh();
    } catch (cause) { setError(describeError(cause, "Could not save the search. Try again.")); }
    finally { setBusy(""); }
  }

  return <Panel className="h-full p-4 sm:p-5">
    <h2 className="text-[15px] font-extrabold tracking-[-.01em] text-neutral-900">Find new leads</h2>
    <p className="mt-1 text-xs leading-5 text-neutral-500">Describe the buyer. The lead finder searches the public web, reads each company&apos;s own site, adds the new ones, and Claude judges each one.</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit(true); }} className="mt-4 space-y-4">
      <div>
        <label htmlFor="find-request" className={clsx(kickerClass, "mb-2 block")}>Who do you want to find?</label>
        <textarea id="find-request" value={request} onChange={(event) => setRequest(event.target.value)} maxLength={2000} rows={3} placeholder="Pipe, pump and irrigation distributors in Chhattisgarh and Madhya Pradesh that sell through dealers. Skip national brands." className={clsx(inputClass, "py-3 leading-6")} />
        <p className="mt-1.5 text-xs leading-5 text-neutral-500">Say who, where, and what to skip. Claude can also plan it for you in a chat.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {ventureId
          ? <div aria-label="Search destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Venture · fixed to the one you picked</span><span className="mt-1 block text-sm font-bold text-neutral-800">{ventureName(ventureId)}</span></div>
          : <Field label="Venture"><Select className={inputClass} value={venturePick || (ventures.length === 1 ? ventures[0]!.id : "")} onChange={(event) => { setVenturePick(event.target.value); setPlayPick(""); setOfferPick(""); }}><option value="">Choose a venture</option>{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}
        {targetVenture && offers !== null && (usable.length > 1
          ? <div><Field label="For which offer?"><Select required className={inputClass} value={offerId} onChange={(event) => setOfferPick(event.target.value)}><option value="">Choose an offer</option>{usable.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
            <p className="mt-1.5 text-xs leading-5 text-neutral-500">{chosenOffer ? "The finder searches with its industries, places, search words and signals." : "The venture sells more than one offer: pick the one to find leads for."}</p></div>
          : chosenOffer
            ? <div aria-label="Offer" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Offer · the venture&apos;s only active one</span><span className="mt-1 block text-sm font-bold text-neutral-800 [overflow-wrap:anywhere]">{chosenOffer.name}</span></div>
            : <div className="rounded-xl border border-dashed border-neutral-200 p-3 text-xs leading-5 text-neutral-500">No approved offer yet, so the finder searches with your description and plan only. <WorkspaceLink href={offerHref(targetVenture)} className="font-semibold text-primary-700 hover:underline">Set one up in Offers</WorkspaceLink></div>)}
        <Field label="For which play? (optional)"><Select className={inputClass} value={play} onChange={(event) => setPlayPick(event.target.value)}><option value="">Not for a play yet</option>{playOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
      </div>

      <div>
        <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1 text-sm font-semibold text-primary-700 transition-colors duration-150 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Plus size={14} className={clsx("transition-transform duration-150", more && "rotate-45")} />{more ? "Hide the search details" : "Add places, categories or exact searches"}</button>
        <div data-open={more} className="vso-collapse"><div><div className="space-y-4 pt-3">
          <ChipsField label="Places" hint="cities or states" placeholder="Raipur, Indore, Madhya Pradesh" items={places} onChange={setPlaces} max={30} maxLength={120} />
          <ChipsField label="Categories" hint="kinds of company" placeholder="Pump dealer, pipe distributor" items={categories} onChange={setCategories} max={30} maxLength={120} />
          <ChipsField label="Searches" hint="exact phrases to look for" placeholder="become a dealer pump Raipur" items={searches} onChange={setSearches} max={50} maxLength={300} />
        </div></div></div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36"><Field label="Up to how many?"><input type="number" inputMode="numeric" min={1} max={500} value={limit} onChange={(event) => setLimit(event.target.value)} className={inputClass} /></Field></div>
        <p className="min-w-0 flex-1 pb-2.5 text-xs leading-5 text-neutral-500">Companies already in Dealflow, and anyone on the do-not-contact list, are skipped.</p>
      </div>

      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy !== ""} className={primaryClass}><ActionLabel busy={busy === "queue"} busyText="Queuing…" idle="Queue for the lead finder" /></button>
        <button type="button" disabled={busy !== ""} onClick={() => void submit(false)} className={secondaryClass}><ActionLabel busy={busy === "save"} idle="Save plan" /></button>
      </div>
      <p className="text-xs leading-5 text-neutral-500">Save keeps it as a plan to come back to. Queue hands it to the lead finder.</p>
    </form>
  </Panel>;
}
