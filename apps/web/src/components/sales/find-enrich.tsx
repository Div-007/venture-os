"use client";
import { useState } from "react";
import clsx from "clsx";
import { CircleCheck, Search } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { dismissToast, toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Field, inputClass, Notice, Panel, primaryClass } from "@/components/studio/primitives";
import { enrichLead, getLeadFacets, listLeads, type FindRun } from "@/lib/sales-api";
import { canHead, useSalesLoad, writableVentures } from "./draft-shared";
import { useSalesShell } from "./sales-context";

const MAX = 100;
const number = (value: number) => new Intl.NumberFormat("en-IN").format(value);
const CLOSED = ["lost", "disqualified"];

/** Fill in contacts: ask the lead finder to read each lead's own website for a phone number or email, for the newest leads that have none. */
export function FindEnrichCard({ runs, onQueued }: { runs: readonly FindRun[]; onQueued: () => void }) {
  const { session, ventureId, ventureName, refresh } = useSalesShell();
  const ventures = writableVentures(session);
  const [venturePick, setVenturePick] = useState("");
  const [limit, setLimit] = useState("50");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const target = ventureId || venturePick || (ventures.length === 1 ? ventures[0]!.id : "");
  const head = canHead(session, target);
  // Only a venture head or admin, or the lead's owner, can ask for a lead to be enriched.
  const ownerScope = head ? {} : { owner: "me" as const };
  const facets = useSalesLoad(`enrich-facets|${target}|${head}`, () => target ? getLeadFacets({ ventureId: target, ...ownerScope }) : Promise.resolve(null));
  const waiting = facets.data?.contact.none ?? 0;
  // Leads already in a queued or running fill-in run are not asked for again.
  const pending = new Set(runs.filter((run) => run.kind === "enrich" && (run.status === "queued" || run.status === "running") && run.ventureId === target).flatMap((run) => run.leadIds ?? []));

  async function queue() {
    const wanted = Number(limit);
    if (!target) { setError("Choose which venture to fill in."); return; }
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX) { setError(`The limit is a whole number from 1 to ${MAX}.`); return; }
    setBusy(true); setError(""); setResult("");
    const progress = "find-enrich-progress";
    toast({ id: progress, title: "Looking for leads without contacts…", sticky: true });
    try {
      // The newest leads first (most recently updated), skipping closed ones, do-not-contact ones and those already queued.
      const picked: string[] = [];
      for (let offset = 0; picked.length < wanted && offset < 500; offset += 100) {
        const page = await listLeads({ ventureId: target, contact: "none", sort: "updated", limit: 100, offset, ...ownerScope });
        for (const lead of page.items) if (picked.length < wanted && !lead.doNotContact && !CLOSED.includes(lead.stage) && !pending.has(lead.id)) picked.push(lead.id);
        if (page.items.length < 100) break;
      }
      if (!picked.length) { setResult(pending.size ? "Every lead without contacts is already queued." : "No lead without a contact route needs filling in."); return; }
      const runIds = new Set<string>();
      let skipped = 0;
      let firstProblem = "";
      for (const [index, leadId] of picked.entries()) {
        try { runIds.add((await enrichLead(leadId)).id); }
        catch (cause) { skipped += 1; firstProblem ||= describeError(cause, ""); }
        if (index % 5 === 0 || index === picked.length - 1) toast({ id: progress, title: `Queuing ${index + 1} of ${picked.length}…`, sticky: true });
      }
      const queued = picked.length - skipped;
      const where = runIds.size === 1 ? "in one run" : `in ${runIds.size} runs`;
      setResult(queued ? `Queued ${queued} ${queued === 1 ? "lead" : "leads"} ${where}.${skipped ? ` ${skipped} left out${firstProblem ? `: ${firstProblem}` : "."}` : ""} The lead finder picks them up shortly.` : "");
      if (!queued) setError(firstProblem || "None of the leads could be queued.");
      else toast({ title: `Queued ${queued} ${queued === 1 ? "lead" : "leads"} ${where}`, body: skipped ? `${skipped} left out.` : "The lead finder picks them up shortly." });
      onQueued(); facets.reload(); refresh();
    } catch (cause) { setError(describeError(cause, "Could not queue the leads. Try again.")); }
    finally { dismissToast(progress); setBusy(false); }
  }

  const name = target ? ventureName(target) : "";
  return <Panel className="flex h-full flex-col p-4 sm:p-5">
    <h2 className="text-[15px] font-extrabold tracking-[-.01em] text-neutral-900">Fill in contacts</h2>
    <p className="mt-1 text-xs leading-5 text-neutral-500">The lead finder reads each lead&apos;s own website for a phone number or an email, and adds what it finds. It never logs in anywhere.</p>
    <form onSubmit={(event) => { event.preventDefault(); void queue(); }} className="mt-4 flex flex-1 flex-col gap-4">
      {!ventureId && <Field label="Venture"><Select className={inputClass} value={venturePick || (ventures.length === 1 ? ventures[0]!.id : "")} onChange={(event) => { setVenturePick(event.target.value); setResult(""); }}><option value="">Choose a venture</option>{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}
      <div className="rounded-2xl bg-neutral-50 p-4">
        {!target ? <p className="text-[13px] text-neutral-500">Pick a venture to see how many leads have no way to reach them yet.</p>
          : facets.error && !facets.data ? <p className="text-[13px] text-danger-text">Could not count the leads. {facets.error}</p>
            : !facets.data ? <span role="status" aria-label="Counting leads" className="vso-skeleton block h-9 w-3/4" />
              : waiting === 0 ? <p className="flex items-center gap-2 text-[13px] font-semibold text-success-text"><CircleCheck size={16} aria-hidden="true" />Every lead in {name} has a contact route.</p>
                : <p className="text-[13px] leading-6 text-neutral-700"><b className="tnum text-2xl font-extrabold tracking-[-.02em] text-neutral-900">{number(waiting)}</b> <span>{head ? `leads in ${name}` : `of your leads in ${name}`} have no contact route yet.</span>{pending.size > 0 && <span className="mt-0.5 block text-xs text-neutral-500">{number(pending.size)} already queued.</span>}</p>}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-36"><Field label={`How many? (up to ${MAX})`}><input type="number" inputMode="numeric" min={1} max={MAX} value={limit} onChange={(event) => setLimit(event.target.value)} className={inputClass} /></Field></div>
        <p className="min-w-0 flex-1 pb-2.5 text-xs leading-5 text-neutral-500">The newest leads first. Do-not-contact and closed leads are left out.</p>
      </div>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <Notice tone="success" message={result} onDismiss={() => setResult("")} />
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <button type="submit" disabled={busy || !target || waiting === 0} className={clsx(primaryClass)}><ActionLabel busy={busy} busyText="Queuing…" idle={<><Search size={15} />Queue enrichment</>} /></button>
      </div>
    </form>
  </Panel>;
}
