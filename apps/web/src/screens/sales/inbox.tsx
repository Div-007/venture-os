"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { Check, Inbox, MessageSquareText } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/studio/primitives";
import { listInbox, type InboxItem } from "@/lib/sales-api";
import { InboxReader } from "@/components/sales/inbox-reader";
import { isWarm, SlaChip, slaOf, useNow, useSlaCalendars } from "@/components/sales/inbox-sla";
import { ago, ChannelTile, kbdClass, ReplyTypeChip, Segmented, typingTarget, useIsDesktop, useQueryParam, useSalesLoad } from "@/components/sales/draft-shared";
import { useSalesShell } from "@/components/sales/sales-context";

const preview = (item: InboxItem) => item.activity.body.replace(/\s+/g, " ").trim() || "(no text)";

/** Inbox: replies from people we contacted, unhandled first. Split view like Review. */
export function InboxScreen() {
  const { session, ventureId, ventureName } = useSalesShell();
  const desktop = useIsDesktop();
  const [mine, setMine] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
  const [replyParam, setSelectedId] = useQueryParam("reply");
  // Links name a reply as ?reply=<activity id>; older links (the Today queue, notifications) say ?activity=. Both open it, and the
  // older one is rewritten to ?reply= so the rest of the screen works with one name.
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const legacyId = params.get("activity") ?? "";
  const selectedId = replyParam || legacyId;
  useEffect(() => {
    if (!legacyId) return;
    const query = new URLSearchParams(params.toString());
    query.delete("activity");
    if (!query.get("reply")) query.set("reply", legacyId);
    router.replace(`${pathname}?${query}`, { scroll: false });
  }, [legacyId, params, router, pathname]);
  const scope = { ...(ventureId ? { ventureId } : {}), ...(mine ? { owner: "me" as const } : {}) };

  const open = useSalesLoad(`inbox|${ventureId}|${mine}`, () => listInbox({ ...scope, handled: "false", limit: 100 }));
  const done = useSalesLoad(`inbox-done|${ventureId}|${mine}|${showHandled}`, () => showHandled ? listInbox({ ...scope, handled: "true", limit: 50 }) : Promise.resolve([] as InboxItem[]));

  const now = useNow();
  // Each reply runs on its venture's clock (reply time, working days, blackout days, time zone).
  const calendarOf = useSlaCalendars([...(open.data ?? []), ...(done.data ?? [])].map((item) => item.lead.ventureId));
  const groups = useMemo(() => {
    const newestFirst = (a: InboxItem, b: InboxItem) => b.activity.at.localeCompare(a.activity.at);
    // Waiting replies: the warm ones (interested, wants details, asks the price) first, then the rest; each oldest first, because the oldest has waited longest.
    const oldestFirst = (a: InboxItem, b: InboxItem) => a.activity.at.localeCompare(b.activity.at);
    const warm = (item: InboxItem) => isWarm(item.activity.replyType);
    const open_ = [...(open.data ?? [])].filter((item) => !item.activity.handledAt);
    const waiting = [...open_.filter(warm).sort(oldestFirst), ...open_.filter((item) => !warm(item)).sort(oldestFirst)];
    const handled = showHandled ? [...(done.data ?? [])].filter((item) => item.activity.handledAt).sort(newestFirst) : [];
    return [{ key: "waiting", title: "Needs a reply", items: waiting }, { key: "handled", title: "Handled", items: handled }].filter((group) => group.items.length > 0);
  }, [open.data, done.data, showHandled]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selected = flat.find((item) => item.activity.id === selectedId) ?? (desktop && !selectedId ? flat[0] : undefined);
  const loaded = open.data !== null;

  // A link to a reply that is already handled: show handled ones once. After that, a reply that left the list just lets go.
  const linked = useRef(selectedId);
  const removed = useRef("");
  useEffect(() => {
    if (!loaded || !selectedId) return;
    if (flat.some((item) => item.activity.id === selectedId)) { linked.current = ""; return; }
    if (selectedId === removed.current) return;
    queueMicrotask(() => {
      if (!showHandled && selectedId === linked.current) setShowHandled(true);
      else if (showHandled && done.data === null) return;
      else setSelectedId("", { replace: true });
    });
  }, [loaded, selectedId, flat, showHandled, done.data, setSelectedId]);
  // On a laptop the first reply is open by default; remember it in the link so a new reply arriving above it does not switch the one you are reading.
  useEffect(() => {
    const first = flat[0];
    if (desktop && !selectedId && first) queueMicrotask(() => setSelectedId(first.activity.id, { replace: true }));
  }, [desktop, selectedId, flat, setSelectedId]);

  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-reply-id="${CSS.escape(selected.activity.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return;
      const index = flat.findIndex((item) => item.activity.id === selected?.activity.id);
      if (event.key === "j" || event.key === "k") {
        const next = flat[Math.min(flat.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)))];
        if (next) { event.preventDefault(); setSelectedId(next.activity.id, { replace: true }); }
      } else if (event.key === "Escape" && selectedId && !desktop) setSelectedId("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selected, selectedId, desktop, setSelectedId]);

  // On a phone the list and the reader take turns: open the reader at its top.
  const reader = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!desktop && selectedId) reader.current?.scrollIntoView({ block: "start" }); }, [desktop, selectedId]);

  function changed(change: { kind: "handled" | "typed"; activity: InboxItem["activity"] }) {
    if (change.kind === "typed") { open.mutate((list) => list.map((item) => item.activity.id === change.activity.id ? { ...item, activity: change.activity } : item)); return; }
    const index = flat.findIndex((item) => item.activity.id === change.activity.id);
    const next = flat[index + 1] ?? flat[index - 1];
    removed.current = change.activity.id;
    open.mutate((list) => list.filter((item) => item.activity.id !== change.activity.id));
    setSelectedId(next && desktop && next.activity.id !== change.activity.id ? next.activity.id : "", { replace: true });
  }

  // Warm replies past their venture's reply time; the label names the hours when every late one has the same reply time.
  const late = (open.data ?? []).filter((item) => slaOf(item.activity, now, calendarOf(item.lead.ventureId))?.over);
  const overdue = late.length;
  const lateHours = [...new Set(late.map((item) => calendarOf(item.lead.ventureId).hours))];
  const overdueLabel = lateHours.length === 1 ? `${overdue} over ${lateHours[0]}h` : `${overdue} late`;
  const waitingCount = (open.data ?? []).filter((item) => !item.activity.handledAt).length;
  const toolbar = <div className="mb-4 flex flex-wrap items-center gap-2">
    <Segmented label="Which replies" value={showHandled ? "all" : "waiting"} onChange={(value) => { setShowHandled(value === "all"); if (selectedId) setSelectedId("", { replace: true }); }} options={[{ value: "waiting", label: loaded ? `Needs a reply · ${waitingCount}` : "Needs a reply" }, { value: "all", label: "Include handled" }]} />
    {session && <Segmented label="Whose replies" value={mine ? "mine" : "all"} onChange={(value) => setMine(value === "mine")} options={[{ value: "all", label: "Everyone" }, { value: "mine", label: "Mine" }]} />}
    <span className="ml-auto flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-[11px] text-neutral-400 max-lg:hidden"><kbd className={kbdClass}>j</kbd><kbd className={kbdClass}>k</kbd>move</span>
    </span>
  </div>;

  if (open.error && !loaded) return <>{toolbar}<Panel><EmptyState variant="error" title="Could not load the replies" body={open.error} action={{ label: open.busy ? "Trying again…" : "Try again", onClick: open.reload, disabled: open.busy }} /></Panel></>;
  if (!loaded) return <>{toolbar}<div role="status" aria-label="Loading replies" className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]"><Panel className="space-y-3 p-4">{[0, 1, 2, 3].map((index) => <div key={index} className="flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-xl" /><span className="grid min-w-0 flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${70 - (index % 3) * 12}%` }} /><span className="vso-skeleton h-2.5 w-3/4" /></span></div>)}</Panel><Panel className="space-y-4 p-5 max-lg:hidden"><span className="vso-skeleton block h-5 w-1/3" /><span className="vso-skeleton block h-32 rounded-2xl" /></Panel></div></>;
  if (flat.length === 0) return <>{toolbar}<Panel><EmptyState variant="card" tone="green" icon={mine ? Check : Inbox} title={showHandled ? "No replies yet" : mine ? "None of your leads are waiting on you" : "No replies waiting"} body={showHandled ? "When someone answers a message or a call-back request, it lands here." : "Every reply has been handled. New ones from email, WhatsApp and LinkedIn show up here, sorted by what they mean."} action={mine ? { label: "Show everyone's replies", onClick: () => setMine(false) } : !showHandled ? { label: "Show handled replies", onClick: () => setShowHandled(true) } : undefined} /></Panel></>;

  return <>
    {!(selected && !desktop) && toolbar}
    {open.error && <p role="alert" className="mb-3 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{open.error}</p>}
    <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className={clsx("thin-scroll overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto", selected && !desktop && "hidden")}>
        {groups.map((group) => <div key={group.key}>
          <h2 className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white px-4 py-2.5 text-[11px] font-bold uppercase tracking-[.06em] text-neutral-500"><span>{group.title}</span><span className="flex items-center gap-1.5">{group.key === "waiting" && overdue > 0 && <span className="tnum rounded-md bg-danger-surface px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-danger-text">{overdueLabel}</span>}<span className="tnum rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{group.items.length}</span></span></h2>
          <ul>{group.items.map((item) => {
            const active = selected?.activity.id === item.activity.id;
            const waiting = !item.activity.handledAt;
            return <li key={item.activity.id}><button type="button" data-reply-id={item.activity.id} aria-current={active ? "true" : undefined} onClick={() => setSelectedId(item.activity.id, { replace: desktop })} className={clsx("flex min-h-[76px] w-full items-start gap-3 border-b border-neutral-50 px-4 py-3 text-left transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 active:scale-[0.995]", active ? "bg-primary-50" : "hover:bg-neutral-50")}>
              <ChannelTile channel={item.activity.kind} size={36} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2"><span className={clsx("truncate text-[13px] text-neutral-900", waiting ? "font-extrabold" : "font-semibold")}>{item.lead.companyName}</span><span className="flex shrink-0 items-center gap-1.5"><time dateTime={item.activity.at} className="tnum text-[11px] text-neutral-400">{ago(item.activity.at)}</time>{waiting && <span role="img" aria-label="Needs a reply" className="h-2 w-2 rounded-full bg-primary-600" />}</span></span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-neutral-500 [overflow-wrap:anywhere]">{preview(item)}</span>
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5"><ReplyTypeChip {...(item.activity.replyType ? { type: item.activity.replyType } : {})} /><SlaChip activity={item.activity} now={now} calendar={calendarOf(item.lead.ventureId)} />{!ventureId && <span className="truncate text-[11px] text-neutral-400">{ventureName(item.lead.ventureId)}</span>}</span>
              </span>
            </button></li>;
          })}</ul>
        </div>)}
      </Panel>
      <div ref={reader} className={clsx("min-w-0 scroll-mt-4", !selected && !desktop && "hidden")}><Panel className="overflow-hidden">
        {selected ? <InboxReader key={selected.activity.id} item={selected} onBack={() => setSelectedId("")} onChanged={changed} />
          : <EmptyState variant="select" icon={MessageSquareText} title="Pick a reply to read" body="The conversation, what the reply means and a draft of your answer show up here." />}
      </Panel></div>
    </div>
  </>;
}
