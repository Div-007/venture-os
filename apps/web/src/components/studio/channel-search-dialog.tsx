"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileText, MessageCircle, Search, SearchX, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { prepareLiveFileDownload, searchLiveGroupContent, type LiveChatSearchHit } from "@/lib/studio-api";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { useExitTransition } from "@/lib/motion";

/** Marks the searched words inside a result excerpt. */
function highlight(text: string, query: string) {
  const terms = query.split(/\s+/).filter((term) => term.length >= 2).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return text;
  return text.split(new RegExp(`(${terms.join("|")})`, "gi")).map((part, index) => index % 2 ? <mark key={index} className="rounded bg-[var(--color-warning-surface)] px-0.5 text-inherit">{part}</mark> : part);
}

type Filter = "all" | "message" | "file";

export function ChannelSearchDialog({ groupId, groupName, channels, onClose, onOpenChannel }: {
  groupId: string;
  groupName: string;
  channels: { id: string; name: string }[];
  onClose: () => void;
  onOpenChannel: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [result, setResult] = useState<{ query: string; items: LiveChatSearchHit[]; error: string }>({ query: "", items: [], error: "" });
  const [expanded, setExpanded] = useState("");
  const [downloading, setDownloading] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const term = query.trim();
  const { state, close } = useExitTransition(onClose, 130);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (term.length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      searchLiveGroupContent(term, groupId).then((items) => {
        if (active) setResult({ query: term, items, error: "" });
      }).catch((cause: unknown) => {
        if (active) setResult({ query: term, items: [], error: describeError(cause, "Search failed.") });
      });
    }, 220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [term, groupId]);

  async function download(file: LiveChatSearchHit) {
    setDownloading(file.id);
    try {
      const url = await prepareLiveFileDownload(file.id);
      const link = document.createElement("a");
      link.href = url; link.download = file.title; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setResult((current) => ({ ...current, error: describeError(cause, "Download failed.") }));
    } finally { setDownloading(""); }
  }

  const ready = result.query === term;
  const items = ready ? result.items.filter((item) => filter === "all" || item.type === filter) : [];
  const counts = { all: ready ? result.items.length : 0, message: ready ? result.items.filter((item) => item.type === "message").length : 0, file: ready ? result.items.filter((item) => item.type === "file").length : 0 };
  return createPortal(<div data-state={state} className="vso-backdrop fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/40 px-3 pt-[8vh] backdrop-blur-[2px] sm:px-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={`Search ${groupName} messages and files`} className="vso-enter-modal w-full max-w-[600px] overflow-hidden rounded-2xl border border-[var(--color-neutral-200)] bg-white shadow-e4" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      // Arrow keys move between the search box and the results.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const hits = [...(dialog.current?.querySelectorAll<HTMLElement>("[data-search-hit]") ?? [])];
        if (!hits.length) return;
        event.preventDefault();
        const index = hits.indexOf(document.activeElement as HTMLElement);
        if (event.key === "ArrowUp" && index <= 0) { input.current?.focus(); return; }
        hits[event.key === "ArrowDown" ? Math.min(hits.length - 1, index + 1) : index - 1]?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])');
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="flex h-14 items-center gap-3 px-4"><Search size={18} className="shrink-0 text-[var(--color-neutral-400)]" /><input ref={input} aria-label="Search messages and files" value={query} onChange={(event) => { setQuery(event.target.value); setExpanded(""); }} placeholder={`Search ${groupName} messages and files...`} className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-neutral-900)] outline-none placeholder:text-[var(--color-neutral-400)]" /><button type="button" aria-label="Close search" onClick={close} className="chat-icon !h-8 !w-8"><X size={16} /></button></div>
      <div className="border-y border-[var(--color-neutral-100)] px-3 py-2"><SlidingTabs fitContent label="Search result type" className="!p-0.5 shadow-none" active={filter} onChange={(key) => setFilter(key as Filter)} tabs={[{ key: "all", label: "All", ...(ready && term.length >= 2 ? { badge: counts.all } : {}) }, { key: "message", label: "Messages", ...(ready && term.length >= 2 ? { badge: counts.message } : {}) }, { key: "file", label: "Files", ...(ready && term.length >= 2 ? { badge: counts.file } : {}) }]} /></div>
      <div className="thin-scroll max-h-[min(62vh,520px)] min-h-40 overflow-y-auto p-2" aria-live="polite">
        {term.length < 2 ? <EmptyState variant="compact" icon={Search} title="Search this group" body="Type at least two characters to find messages and files." className="m-2" /> : !ready ? <div role="status" aria-label="Searching" className="grid gap-2 p-2">{[0, 1, 2].map((index) => <div key={index} className="flex items-center gap-3"><span className="vso-skeleton h-9 w-9 shrink-0 rounded-lg" /><span className="grid flex-1 gap-1.5"><span className="vso-skeleton h-3 w-1/3" /><span className="vso-skeleton h-2.5 w-3/4" /></span></div>)}</div> : result.error ? <p role="alert" className="px-4 py-6 text-center text-xs text-red-700">{result.error}</p> : items.length === 0 ? <EmptyState variant="compact" icon={SearchX} title={`No matching ${filter === "all" ? "messages or files" : filter === "message" ? "messages" : "files"}`} body={filter !== "all" && result.items.length ? undefined : "Try different words."} action={filter !== "all" && result.items.length ? { label: "Show all results", onClick: () => setFilter("all") } : undefined} className="m-2" /> : <div key={`${result.query}-${filter}`} className="vso-stagger-in">{items.map((item) => item.type === "file" ? <button key={item.id} data-search-hit type="button" disabled={downloading === item.id} onClick={() => void download(item)} className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150 hover:bg-[var(--color-primary-50)] focus-visible:bg-[var(--color-primary-50)] focus-visible:outline-none disabled:opacity-60"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-700)]"><FileText size={17} /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-[var(--color-neutral-800)]">{highlight(item.title, result.query)}</span><span className="block text-[10px] text-[var(--color-neutral-400)]">{downloading === item.id ? "Preparing download…" : item.contentType}</span></span><Download size={16} className="shrink-0 text-[var(--color-neutral-400)]" /></button> : <div key={item.id} className="rounded-xl px-3 py-2 transition-colors duration-150 hover:bg-[var(--color-primary-50)]"><button type="button" data-search-hit aria-expanded={expanded === item.id} onClick={() => setExpanded((value) => value === item.id ? "" : item.id)} className="flex w-full items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-700)]"><MessageCircle size={17} /></span><span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-[var(--color-neutral-800)]">#{channels.find((channel) => channel.id === item.channelId)?.name ?? 'channel'}</span><span className={`mt-1 block break-words text-[11px] leading-5 text-[var(--color-neutral-600)] ${expanded === item.id ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{highlight(item.excerpt, result.query)}</span></span></button><div data-open={expanded === item.id && Boolean(item.channelId)} className="vso-collapse"><div><button type="button" tabIndex={expanded === item.id ? 0 : -1} onClick={() => { if (item.channelId) onOpenChannel(item.channelId); close(); }} className="ml-12 mt-2 min-h-8 rounded-lg px-2 text-[11px] font-semibold text-[var(--color-primary-700)] transition-colors duration-150 hover:bg-[var(--color-primary-100)]">Open channel</button></div></div></div>)}</div>}
      </div>
    </section>
  </div>, document.body);
}
