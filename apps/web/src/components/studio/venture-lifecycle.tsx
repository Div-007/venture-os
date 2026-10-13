"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Archive, RotateCcw } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionLabel, DetailDrawer, inputClass, primaryClass, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { archiveLiveVenture, deleteLiveVenture, listArchivedLiveVentures, restoreLiveVenture } from "@/lib/studio-api";

type Archived = Awaited<ReturnType<typeof listArchivedLiveVentures>>[number];
const dangerClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#b42318] px-4 text-sm font-semibold text-white transition-[background-color,transform,opacity] duration-150 hover:bg-[#912018] active:scale-[0.98] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b42318] focus-visible:ring-offset-2";

/** Confirms archiving one venture: it disappears for everyone but keeps all its data until restored. */
export function ArchiveVentureDrawer({ venture, onClose, onArchived }: { venture: { id: string; name: string }; onClose: () => void; onArchived: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function archive() {
    setBusy(true); setError("");
    try { await archiveLiveVenture(venture.id); onArchived(); }
    catch (cause) { setError(describeError(cause, "Could not archive the venture.")); setBusy(false); }
  }
  return createPortal(<DetailDrawer title={`Archive ${venture.name}?`} subtitle="You can restore it at any time" onClose={onClose}>
    <div className="space-y-4 text-sm leading-6 text-neutral-600">
      <p>Archiving hides this venture from everyone: the sidebar, the venture switcher, boards, task lists, search, and the dashboard. Reminders for its tasks pause.</p>
      <p>Nothing is deleted. Its groups, channels, tasks, knowledge, and files stay exactly as they are, and restoring it brings everything back.</p>
      {error && <p role="alert" className="rounded-xl bg-danger-surface p-3 font-semibold text-danger-text">{error}</p>}
      <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button><button type="button" disabled={busy} onClick={archive} className={primaryClass}><ActionLabel busy={busy} busyText="Archiving…" idle="Archive venture" /></button></div>
    </div>
  </DetailDrawer>, document.body);
}

/** Lists archived ventures with Restore, and for admins a permanent delete that needs the exact name typed. */
export function ArchivedVenturesDrawer({ isAdmin, onClose, onChanged }: { isAdmin: boolean; onClose: () => void; onChanged: (message: { title: string; body: string }) => void }) {
  const [items, setItems] = useState<Archived[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [deleting, setDeleting] = useState<Archived | null>(null);
  const [typed, setTyped] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    listArchivedLiveVentures().then((value) => { if (active) { setItems(value); setError(""); } }, (cause: unknown) => { if (active) setError(describeError(cause, "Could not load archived ventures.")); });
    return () => { active = false; };
  }, [revision]);

  async function restore(item: Archived) {
    setBusyId(item.id); setError("");
    try { await restoreLiveVenture(item.id); onChanged({ title: `${item.name} restored`, body: "It is back in the sidebar with all its work." }); setRevision((value) => value + 1); }
    catch (cause) { setError(describeError(cause, "Could not restore the venture.")); }
    finally { setBusyId(""); }
  }

  async function remove(item: Archived) {
    if (typed !== item.name) return;
    setBusyId(item.id); setError("");
    try {
      const result = await deleteLiveVenture(item.id, typed);
      const until = new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(result.recoverableUntil));
      onChanged({ title: `${item.name} deleted`, body: `A recovery copy is kept until ${until}.` });
      setDeleting(null); setTyped(""); setRevision((value) => value + 1);
    } catch (cause) { setError(describeError(cause, "Could not delete the venture.")); }
    finally { setBusyId(""); }
  }

  return createPortal(<DetailDrawer title="Archived ventures" subtitle={isAdmin ? "Restore a venture, or delete it permanently" : "Restore a venture you lead"} onClose={onClose}>
    <div className="space-y-3">
      {error && <p role="alert" className="rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
      {!items ? !error && <SkeletonRows rows={2} label="Loading archived ventures" />
        : !items.length ? <EmptyState variant="card" icon={Archive} tone="teal" title="No archived ventures" body="Archived ventures appear here, ready to restore." />
        : items.map((item) => <article key={item.id} className="rounded-xl border border-neutral-100 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="truncate text-sm font-semibold text-neutral-800">{item.name}</p><p className="mt-0.5 text-xs text-neutral-500">{item.archivedAt ? `Archived ${new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(item.archivedAt))}` : "Archived"}</p></div>
            <div className="flex shrink-0 gap-2">
              <button type="button" disabled={busyId === item.id} onClick={() => restore(item)} className={secondaryClass}><RotateCcw size={14} />Restore</button>
              {isAdmin && deleting?.id !== item.id && <button type="button" onClick={() => { setDeleting(item); setTyped(""); }} className="min-h-10 rounded-xl px-3 text-sm font-semibold text-[#b42318] transition-colors duration-150 hover:bg-[#fef3f2]">Delete…</button>}
            </div>
          </div>
          {deleting?.id === item.id && <form onSubmit={(event) => { event.preventDefault(); void remove(item); }} className="vso-fade-enter mt-4 space-y-3 rounded-xl border border-[#fecdca] bg-[#fef3f2] p-3">
            <p className="flex gap-2 text-sm leading-6 text-[#7a271a]"><AlertTriangle size={16} className="mt-1 shrink-0" />This permanently deletes {item.name} and everything in it: groups, channels and messages, tasks, knowledge, decisions, files, and sales records. People lose access to it. An operator can recover it for 30 days; after that it is gone.</p>
            <label className="block text-xs font-semibold text-[#7a271a]">Type <span className="font-mono">{item.name}</span> to confirm<input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" className={`${inputClass} mt-1.5`} /></label>
            <div className="flex justify-end gap-2"><button type="button" onClick={() => { setDeleting(null); setTyped(""); }} className={secondaryClass}>Cancel</button><button type="submit" disabled={typed !== item.name || busyId === item.id} className={dangerClass}><ActionLabel busy={busyId === item.id} busyText="Deleting…" idle="Delete permanently" /></button></div>
          </form>}
        </article>)}
    </div>
  </DetailDrawer>, document.body);
}
