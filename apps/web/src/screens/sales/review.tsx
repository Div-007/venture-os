"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Check, Inbox, Info, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/studio/primitives";
import { getDraft, listPlays, listReviewDrafts, type ReviewDraft } from "@/lib/sales-api";
import { DraftReader, type DraftChange } from "@/components/sales/draft-reader";
import { ago, approvalOf, ChannelTile, kbdClass, PURPOSE_LABEL, Segmented, typingTarget, useIsDesktop, useQueryParam, useSalesLoad, useVentureSettings } from "@/components/sales/draft-shared";
import { useSalesShell } from "@/components/sales/sales-context";

const OPEN_STATUSES = "draft,in_review,ready,needs_changes";
const preview = (draft: ReviewDraft) => (draft.subject || draft.body).replace(/\s+/g, " ").trim();

/** Review: a mail-style split view. Drafts on the left, the open draft and Claude's review of it on the right. */
export function ReviewScreen() {
  const { session, ventureId, ventureName } = useSalesShell();
  const desktop = useIsDesktop();
  const [filter, setFilter] = useState<"open" | "sent">("open");
  const [mine, setMine] = useState(false);
  const [selectedId, setSelectedId] = useQueryParam("draft");
  const [editNonce, setEditNonce] = useState(0);

  const status = filter === "open" ? OPEN_STATUSES : "sent";
  const drafts = useSalesLoad(`${ventureId}|${status}|${mine}`, () => listReviewDrafts({ ...(ventureId ? { ventureId } : {}), status, ...(mine ? { owner: "me" as const } : {}), limit: 100 }));
  const loaded = drafts.data !== null;

  // A link (?draft=) to a draft that is not in this list: another venture than the one picked, sent or closed, or past the first 100.
  // It is fetched on its own and opened. A draft that was in the list and left it (someone else sent it) just lets go.
  const [linkedDraft, setLinkedDraft] = useState<ReviewDraft | null>(null);
  const linked = linkedDraft && linkedDraft.id === selectedId ? linkedDraft : null;
  const plays = useSalesLoad(`plays|${ventureId}`, () => listPlays(ventureId ? { ventureId } : {}));
  const outsideVenture = linked && ventureId && linked.ventureId !== ventureId ? linked.ventureId : "";
  const linkedPlays = useSalesLoad(`plays-linked|${outsideVenture}`, () => outsideVenture ? listPlays({ ventureId: outsideVenture }) : Promise.resolve([]));
  const playById = useMemo(() => new Map([...(plays.data ?? []), ...(linkedPlays.data ?? [])].map((play) => [play.id, play])), [plays.data, linkedPlays.data]);
  // The venture's approval mode, only needed while the API does not say per draft whether a person must approve it.
  const settingsById = useVentureSettings([...(drafts.data ?? []), ...(linked ? [linked] : [])].filter((draft) => draft.status === "ready" && draft.needsPersonApproval === undefined).map((draft) => draft.ventureId));
  const approvalFor = useCallback((draft: ReviewDraft) => approvalOf(draft, draft.playId ? playById.get(draft.playId) : undefined, settingsById[draft.ventureId]), [playById, settingsById]);

  const groups = useMemo(() => {
    const items = drafts.data ?? [];
    const oldestFirst = (a: ReviewDraft, b: ReviewDraft) => a.createdAt.localeCompare(b.createdAt);
    if (filter === "sent") return [{ key: "sent", title: "Sent", items: [...items].sort((a, b) => (b.sentAt ?? b.updatedAt).localeCompare(a.sentAt ?? a.updatedAt)) }];
    const ready = items.filter((draft) => draft.status === "ready");
    return [
      { key: "review", title: "To review", items: items.filter((draft) => draft.status === "in_review" || draft.status === "draft").sort(oldestFirst) },
      // Passed Claude's review, but a person approves it before it goes out (a play's first batch, or a venture that approves every message).
      { key: "approve", title: "To approve", items: ready.filter((draft) => approvalFor(draft).needed).sort(oldestFirst) },
      { key: "ready", title: "Ready to send", items: ready.filter((draft) => !approvalFor(draft).needed).sort(oldestFirst) },
      { key: "changes", title: "Needs changes", items: items.filter((draft) => draft.status === "needs_changes").sort(oldestFirst) },
    ].filter((group) => group.items.length > 0);
  }, [drafts.data, filter, approvalFor]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selected = flat.find((draft) => draft.id === selectedId) ?? linked ?? (desktop && !selectedId ? flat[0] : undefined);

  const removed = useRef("");
  const seen = useRef(new Set<string>());
  useEffect(() => { for (const draft of flat) seen.current.add(draft.id); }, [flat]);
  const wanted = useRef(selectedId);
  useEffect(() => { wanted.current = selectedId; }, [selectedId]);
  const lookedUp = useRef("");
  useEffect(() => {
    if (!loaded || !selectedId || linked || flat.some((draft) => draft.id === selectedId)) return;
    if (selectedId === removed.current || seen.current.has(selectedId)) { queueMicrotask(() => { if (wanted.current === selectedId) setSelectedId("", { replace: true }); }); return; }
    if (lookedUp.current === selectedId) return;
    lookedUp.current = selectedId;
    const id = selectedId;
    getDraft(id).then((found) => {
      if (wanted.current !== id) return;
      if (found) setLinkedDraft(found); else setSelectedId("", { replace: true });
    }).catch(() => { if (wanted.current === id) { lookedUp.current = ""; setSelectedId("", { replace: true }); } });
  }, [loaded, selectedId, linked, flat, setSelectedId]);
  // On a laptop the first draft is open by default; remember it in the link so a new draft arriving above it does not switch the one you are reading.
  useEffect(() => {
    const first = flat[0];
    if (desktop && !selectedId && first) queueMicrotask(() => setSelectedId(first.id, { replace: true }));
  }, [desktop, selectedId, flat, setSelectedId]);

  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-draft-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return;
      const index = flat.findIndex((draft) => draft.id === selected?.id);
      if (event.key === "j" || event.key === "k") {
        const next = flat[Math.min(flat.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
        if (next) { event.preventDefault(); setSelectedId(next.id, { replace: true }); }
      } else if (event.key === "e" && selected) { event.preventDefault(); setEditNonce((value) => value + 1); }
      else if (event.key === "Escape" && selectedId && !desktop) setSelectedId("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selected, selectedId, desktop, setSelectedId]);

  // On a phone the list and the reader take turns: open the reader at its top.
  const reader = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!desktop && selectedId) reader.current?.scrollIntoView({ block: "start" }); }, [desktop, selectedId]);

  function changed(change: DraftChange) {
    // The answer to an edit or an approval is a plain draft: the row's approval fields no longer hold (the reload brings fresh ones).
    const merge = (draft: ReviewDraft): ReviewDraft => ({ ...draft, ...change.draft, needsPersonApproval: false, approvalReason: null });
    if (change.kind === "edited" || change.kind === "approved") {
      drafts.mutate((list) => list.map((draft) => draft.id === change.draft.id ? merge(draft) : draft));
      setLinkedDraft((draft) => draft && draft.id === change.draft.id ? merge(draft) : draft);
      return;
    }
    if (linked && linked.id === change.draft.id) { removed.current = change.draft.id; setLinkedDraft(null); setSelectedId(desktop && flat[0] ? flat[0].id : "", { replace: true }); return; }
    // Sent, vetoed or discarded: it leaves this list. On a laptop the next draft opens; on a phone you go back to the list.
    const index = flat.findIndex((draft) => draft.id === change.draft.id);
    const next = flat[index + 1] ?? flat[index - 1];
    removed.current = change.draft.id;
    drafts.mutate((list) => list.filter((draft) => draft.id !== change.draft.id));
    setSelectedId(next && desktop ? next.id : "", { replace: true });
  }
  function pickFilter(next: "open" | "sent") { setFilter(next); if (selectedId) setSelectedId("", { replace: true }); }

  const toolbar = <div className="mb-4 flex flex-wrap items-center gap-2">
    <Segmented label="Which drafts" value={filter} onChange={pickFilter} options={[{ value: "open", label: "To do" }, { value: "sent", label: "Sent" }]} />
    {session && <Segmented label="Whose drafts" value={mine ? "mine" : "all"} onChange={(value) => setMine(value === "mine")} options={[{ value: "all", label: "Everyone" }, { value: "mine", label: "Mine" }]} />}
    <span className="ml-auto flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-[11px] text-neutral-400 max-lg:hidden"><kbd className={kbdClass}>j</kbd><kbd className={kbdClass}>k</kbd>move{session?.membership.role !== "learner" && <><kbd className={kbdClass}>e</kbd>edit</>}</span>
    </span>
  </div>;

  if (drafts.error && !loaded) return <>{toolbar}<Panel><EmptyState variant="error" title="Could not load the drafts" body={drafts.error} action={{ label: drafts.busy ? "Trying again…" : "Try again", onClick: drafts.reload, disabled: drafts.busy }} /></Panel></>;
  if (!loaded) return <>{toolbar}<div role="status" aria-label="Loading drafts" className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]"><Panel className="space-y-3 p-4">{[0, 1, 2, 3, 4].map((index) => <div key={index} className="flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-xl" /><span className="grid min-w-0 flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${74 - (index % 3) * 12}%` }} /><span className="vso-skeleton h-2.5 w-2/3" /></span></div>)}</Panel><Panel className="space-y-4 p-5 max-lg:hidden"><span className="vso-skeleton block h-5 w-1/3" /><span className="vso-skeleton block h-40 rounded-2xl" /><span className="vso-skeleton block h-10 w-1/2" /></Panel></div></>;
  if (flat.length === 0 && !selected) return <>{toolbar}<Panel>{filter === "open"
    ? <EmptyState variant="card" tone="green" icon={Check} title={mine ? "Nothing of yours to review" : "Nothing waiting for review"} body={mine ? "None of the drafts on your leads need you right now." : "When Claude writes messages for your leads they land here. In Claude, say \"draft first messages for my approved leads\"."} action={mine ? { label: "Show everyone's drafts", onClick: () => setMine(false) } : undefined} />
    : <EmptyState variant="card" tone="blue" icon={Inbox} title="Nothing sent yet" body="Messages you mark as sent show up here, so you can see what went out." />}</Panel></>;

  return <>
    {!(selected && !desktop) && toolbar}
    {drafts.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{drafts.error}</p>}
    <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Panel className={clsx("thin-scroll overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto", selected && !desktop && "hidden")}>
        {groups.map((group) => <div key={group.key}>
          <h2 className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white px-4 py-2.5 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500"><span>{group.title}</span><span className="tnum rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{group.items.length}</span></h2>
          <ul>{group.items.map((draft) => {
            const active = selected?.id === draft.id;
            const approveFirst = group.key === "approve";
            return <li key={draft.id}><button type="button" data-draft-id={draft.id} aria-current={active ? "true" : undefined} onClick={() => setSelectedId(draft.id, { replace: desktop })} className={clsx("flex min-h-[68px] w-full items-center gap-3 border-b border-neutral-50 px-4 py-3 text-left transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:scale-[0.995]", active ? "bg-primary-50" : "hover:bg-neutral-50")}>
              <ChannelTile channel={draft.channel} size={36} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2"><span className="truncate text-[13px] font-bold text-neutral-900">{draft.lead.companyName}</span><time dateTime={draft.createdAt} className="tnum shrink-0 text-[11px] text-neutral-400">{ago(draft.createdAt)}</time></span>
                <span className="mt-0.5 block truncate text-xs text-neutral-500">{PURPOSE_LABEL[draft.purpose]} · {preview(draft)}</span>
                {(approveFirst || !ventureId) && <span className="mt-1 flex items-center gap-2 text-[11px] font-semibold">{approveFirst && <span className="text-primary-700">Approve first</span>}{!ventureId && <span className="truncate text-neutral-400">{ventureName(draft.ventureId)}</span>}</span>}
              </span>
            </button></li>;
          })}</ul>
        </div>)}
      </Panel>
      <div ref={reader} className={clsx("min-w-0 scroll-mt-4", !selected && !desktop && "hidden")}><Panel className="overflow-hidden">
        {selected && selected === linked && ventureId && selected.ventureId !== ventureId && <p className="flex items-center gap-2 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold text-neutral-600 sm:px-5"><Info size={14} className="shrink-0 text-neutral-400" aria-hidden="true" />From {ventureName(selected.ventureId)}</p>}
        {selected ? <DraftReader key={selected.id} draft={selected} {...(selected.playId && playById.get(selected.playId) ? { play: playById.get(selected.playId)! } : {})} {...(settingsById[selected.ventureId] ? { settings: settingsById[selected.ventureId]! } : {})} editNonce={editNonce} onBack={() => setSelectedId("")} onChanged={changed} />
          : <EmptyState variant="select" icon={Sparkles} title="Pick a draft to read" body="Claude's review of it, and what to do next, show up here." />}
      </Panel></div>
    </div>
  </>;
}
