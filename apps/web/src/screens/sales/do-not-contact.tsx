"use client";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, Info, LinkIcon, Mail, Plus, Search, ShieldCheck, Users, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Field, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { listSuppression, removeSuppression, type Suppression } from "@/lib/sales-api";
import { Phone, Trash } from "@/components/sales/draft-icons";
import { stamp, useSalesLoad } from "@/components/sales/draft-shared";
import { useSalesShell } from "@/components/sales/sales-context";
import { FilterChip } from "@/components/sales/sales-ui";
import { DNC_KIND_LABEL, DNC_KINDS, DoNotContactAdd, type DncKind } from "./do-not-contact-add";

const PAGE = 50;
const KIND_ICON = { email: Mail, phone: Phone, domain: LinkIcon, company: Users } as const;

/** Do not contact (route /sales/live/do-not-contact): one list for every venture. Opt-outs and hostile replies land here by themselves. */
export function DoNotContactScreen() {
  const { session, openLead, personName, refresh } = useSalesShell();
  const list = useSalesLoad("suppression", () => listSuppression());
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | DncKind>("all");
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const role = session?.membership.role;
  const isAdmin = role === "admin";
  const canAdd = isAdmin || role === "venture_head";
  const loaded = list.data !== null;
  const entries = useMemo(() => list.data ?? [], [list.data]);

  const counts = useMemo(() => Object.fromEntries(DNC_KINDS.map((item) => [item, entries.filter((entry) => entry.kind === item).length])) as Record<DncKind, number>, [entries]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return entries.filter((entry) => (kind === "all" || entry.kind === kind) && (!term || `${entry.value} ${entry.reason} ${DNC_KIND_LABEL[entry.kind]} ${personName(entry.createdBy)}`.toLowerCase().includes(term)));
  }, [entries, kind, q, personName]);

  function openRemove(id: string) { setRemoving(removing === id ? "" : id); setReason(""); setError(""); }
  async function remove(entry: Suppression) {
    if (reason.trim().length < 3) { setError("Say why in a few words. It is kept in the audit log."); return; }
    setBusy(true); setError("");
    try {
      await removeSuppression(entry.id, reason.trim());
      list.mutate((rows) => rows.filter((row) => row.id !== entry.id));
      toast({ title: "Removed from the list", body: entry.value });
      setRemoving(""); refresh();
    } catch (cause) { setError(describeError(cause, "Could not remove it. Try again.")); }
    finally { setBusy(false); }
  }
  function added(entry: Suppression) { list.mutate((rows) => [entry, ...rows.filter((row) => row.id !== entry.id)]); refresh(); }

  const toolbar = <div className="mb-4 space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-0 flex-1 sm:max-w-md"><span className="sr-only">Search the list</span><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" /><input value={q} onChange={(event) => { setQ(event.target.value); setLimit(PAGE); }} placeholder="Search the list" className={clsx(inputClass, "pl-10")} /></label>
      {canAdd && <button type="button" onClick={() => setAdding(true)} className={clsx(primaryClass, "max-sm:w-full")}><Plus size={15} />Add entry</button>}
    </div>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Kind">
      <FilterChip active={kind === "all"} onClick={() => { setKind("all"); setLimit(PAGE); }}>All · {entries.length}</FilterChip>
      {DNC_KINDS.map((item) => <FilterChip key={item} active={kind === item} onClick={() => { setKind(item); setLimit(PAGE); }}>{DNC_KIND_LABEL[item]} · {counts[item]}</FilterChip>)}
    </div>
  </div>;

  if (list.error && !loaded) return <Panel><EmptyState variant="error" title="Could not load the list" body={list.error} action={{ label: list.busy ? "Trying again…" : "Try again", onClick: list.reload, disabled: list.busy }} /></Panel>;
  if (!loaded) return <div role="status" aria-label="Loading the list"><Panel className="space-y-4 p-5">{[0, 1, 2, 3].map((index) => <div key={index} className="flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-xl" /><span className="grid min-w-0 flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${62 - (index % 3) * 10}%` }} /><span className="vso-skeleton h-2.5 w-1/3" /></span></div>)}</Panel></div>;

  return <>
    {entries.length > 0 && toolbar}
    {list.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{list.error}</p>}
    {entries.length === 0
      ? <Panel><EmptyState variant="card" tone="green" icon={ShieldCheck} title="Nobody has asked us to stop yet" body="Opt-out and hostile replies land here automatically." action={canAdd ? { label: "Add entry", icon: Plus, onClick: () => setAdding(true) } : undefined} /></Panel>
      : shown.length === 0
        ? <Panel><EmptyState variant="filtered" title="Nothing matches" body="Try another word, or another kind." action={{ label: "Clear search", onClick: () => { setQ(""); setKind("all"); } }} /></Panel>
        : <Panel>
          <ul className="divide-y divide-neutral-100">{shown.slice(0, limit).map((entry) => {
            const KindIcon = KIND_ICON[entry.kind];
            const open = removing === entry.id;
            return <li key={entry.id} className="space-y-3 px-4 py-3.5 sm:px-5">
              <div className="flex flex-col gap-x-6 gap-y-2 md:flex-row md:items-start">
                <div className="flex min-w-0 items-start gap-3 md:w-[34%] md:shrink-0">
                  <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-neutral-100 text-neutral-500"><KindIcon size={16} /></span>
                  <div className="min-w-0"><p className="text-sm font-bold text-neutral-900 [overflow-wrap:anywhere]">{entry.value}</p><p className="text-xs text-neutral-500">{DNC_KIND_LABEL[entry.kind]}</p></div>
                </div>
                <p className="min-w-0 flex-1 text-[13px] leading-5 text-neutral-700 [overflow-wrap:anywhere]">{entry.reason || <span className="text-neutral-400">No reason given</span>}</p>
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 md:w-60 md:flex-col md:items-end">
                  <p className="text-xs text-neutral-500 md:text-right"><span className="block">Added by {personName(entry.createdBy)}</span><span className="block whitespace-nowrap text-neutral-400">{stamp(entry.createdAt)}</span></p>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {entry.leadId && <button type="button" onClick={() => openLead(entry.leadId!)} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Open lead<ArrowUpRight size={12} aria-hidden="true" /></button>}
                    {isAdmin && <button type="button" aria-expanded={open} onClick={() => openRemove(entry.id)} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-danger-text transition-colors duration-150 hover:bg-danger-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><Trash size={13} aria-hidden="true" />Remove</button>}
                  </span>
                </div>
              </div>
              {open && <form onSubmit={(event) => { event.preventDefault(); void remove(entry); }} role="alertdialog" aria-label={`Remove ${entry.value}`} className="vso-fade-enter space-y-3 rounded-2xl border border-danger-surface bg-danger-surface p-4">
                <div className="flex items-start gap-2.5 text-danger-text"><Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><p className="text-xs leading-5"><b className="text-[13px]">Take {entry.value} off the list?</b><br />Anyone in any venture can contact it again, and leads flagged only because of this entry are cleared.</p></div>
                <Field label="Why is it safe to remove? (kept in the audit log)"><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} rows={2} autoFocus className={clsx(inputClass, "py-3")} /></Field>
                <Notice tone="error" message={error} onDismiss={() => setError("")} />
                <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50"><ActionLabel busy={busy} busyText="Removing…" idle="Remove from the list" /></button><button type="button" onClick={() => setRemoving("")} className={secondaryClass}><X size={14} />Keep it</button></div>
              </form>}
            </li>;
          })}</ul>
          {shown.length > limit && <div className="border-t border-neutral-100 p-3 text-center"><button type="button" onClick={() => setLimit(limit + PAGE)} className={secondaryClass}>Show {Math.min(PAGE, shown.length - limit)} more · {shown.length - limit} left</button></div>}
        </Panel>}
    {entries.length > 0 && <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-neutral-500"><Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{role === "learner" ? "You can read this list. A venture head or admin adds to it, and only an admin takes an entry off." : isAdmin ? "Opt-out and hostile replies land here by themselves. You can add entries and, with a reason, remove them." : canAdd ? "Opt-out and hostile replies land here by themselves. You can add entries; only an admin takes one off." : "Opt-out and hostile replies land here by themselves. A venture head or admin adds entries; only an admin takes one off."}</p>}
    {adding && <DoNotContactAdd onClose={() => setAdding(false)} onAdded={added} />}
  </>;
}
