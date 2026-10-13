"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WorkspaceLink as Link, workspaceHref } from "./workspace-link";
import { usePathname, useRouter } from "next/navigation";
import { ensureFocusLoaded, getFocus, subscribeFocus } from "@/lib/focus-events";
import { Bell, Menu, PanelLeftClose, PanelLeftOpen, Plus, Search, Sparkles, TimerReset } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { LiveNotificationBell } from "./live-notification-pulse";
import { openNewTask } from "@/components/studio/new-task-dialog";
import { useAppMode } from "@/lib/app-mode";
import { listLeads } from "@/lib/sales-api";
import { STAGE_LABELS } from "@/components/sales/sales-ui";
import type { Lead } from "@venture-studio/contracts";

type Props = { collapsed: boolean; onToggleSidebar: () => void; onOpenMobileNav: () => void; focusOpen: boolean; onToggleFocus: () => void };
const iconButton = "relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

/** Connected focus link: an icon at rest, a live countdown pill while a session runs. */
function LiveFocusLink() {
  const focus = useSyncExternalStore(subscribeFocus, getFocus, () => undefined);
  const [now, setNow] = useState(() => Date.now());
  // The focus page shows the full timer, so the top bar stays an icon there.
  const onFocusPage = /^\/(?:demo\/)?focus(?:\/|$)/.test(usePathname());
  const endsAt = focus && !onFocusPage ? new Date(focus.endsAt).getTime() : 0;
  // A paused session's clock stands still at the moment it was paused.
  const pausedAt = focus?.pausedAt ? new Date(focus.pausedAt).getTime() : 0;
  useEffect(() => { ensureFocusLoaded(); }, []);
  useEffect(() => {
    if (!endsAt || pausedAt) return;
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    queueMicrotask(tick);
    return () => window.clearInterval(timer);
  }, [endsAt, pausedAt]);
  if (!endsAt) return <Link href="/focus" aria-label="Open focus sprint" className={clsx(iconButton, "text-primary-600 hover:bg-primary-50")}><TimerReset size={18} /></Link>;
  const seconds = Math.max(0, Math.ceil((endsAt - (pausedAt || now)) / 1000));
  const clock = `${pausedAt ? "Paused · " : ""}${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return <Link href="/focus" aria-label={pausedAt ? `Focus session paused, ${Math.ceil(seconds / 60)} minutes left` : seconds ? `Focus session running, ${Math.ceil(seconds / 60)} minutes left` : "Focus session finished, open it to complete"} className="vso-fade-enter flex h-10 shrink-0 items-center gap-2 rounded-xl bg-primary-50 px-3 text-xs font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"><span aria-hidden="true" className={clsx("h-2 w-2 rounded-full", pausedAt ? "bg-amber-500" : seconds ? "bg-primary-600" : "bg-success")} /><span className="tnum">{seconds ? clock : "Done"}</span></Link>;
}

// New task: an icon on phones, labelled from tablet up; the live app opens the task popup instead of navigating.
const newTaskClass = "flex h-10 w-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-primary-700 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 active:scale-[0.97] md:w-auto md:px-3.5";

export function Topbar({ collapsed, onToggleSidebar, onOpenMobileNav, focusOpen, onToggleFocus }: Props) {
  const path = usePathname();
  const { data, currentUserId, mode, workspaceName, role, activeVentureId } = useStudio();
  // In Sales mode the primary button adds a lead and the search box looks through leads.
  const { mode: appMode } = useAppMode();
  const salesMode = mode === "connected" && appMode === "sales";
  const user = data.people.find((person) => person.id === currentUserId) ?? data.people[0];
  const unread = data.notices.filter((notice) => !notice.read).length;
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  // The palette is a keyboard tool: it opens fresh and without animation every time.
  const openSearch = () => { setQuery(""); setActiveIndex(0); setSearchOpen(true); requestAnimationFrame(() => input.current?.focus()); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setQuery(""); setActiveIndex(0); setSearchOpen(true); requestAnimationFrame(() => input.current?.focus()); }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const trimmed = query.trim();
  const [leadHits, setLeadHits] = useState<{ key: string; leads: Lead[] } | null>(null);
  useEffect(() => {
    if (!salesMode || !searchOpen || trimmed.length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      listLeads({ q: trimmed, limit: 6, ...(activeVentureId ? { ventureId: activeVentureId } : {}) })
        .then((page) => { if (active) setLeadHits({ key: trimmed, leads: page.items }); })
        .catch(() => { if (active) setLeadHits({ key: trimmed, leads: [] }); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [salesMode, searchOpen, trimmed, activeVentureId]);
  const salesItems = trimmed ? [
    { title: `Search all leads for “${trimmed}”`, meta: "Leads", href: `/sales/live/leads?q=${encodeURIComponent(trimmed)}` },
    ...(leadHits?.key === trimmed ? leadHits.leads : []).map((lead) => ({ title: lead.companyName, meta: [lead.city, STAGE_LABELS[lead.stage]].filter(Boolean).join(" · "), href: `/sales/live/leads?lead=${encodeURIComponent(lead.id)}` })),
  ] : [];
  const studioItems = [
    ...data.tasks.map((task) => ({ title: task.title, meta: "Task", href: `/tasks?task=${task.id}` })),
    ...data.knowledge.map((doc) => ({ title: doc.title, meta: `${doc.evidenceClass} · Knowledge`, href: `/knowledge?doc=${doc.id}` })),
    ...data.ventures.map((venture) => ({ title: venture.name, meta: "Venture", href: `/ventures?venture=${venture.id}` })),
    ...data.people.map((person) => ({ title: person.name, meta: "Member", href: "/messages" })),
  ].filter((item) => `${item.title} ${item.meta}`.toLowerCase().includes(query.toLowerCase())).slice(0,8);
  const items = salesMode ? salesItems : studioItems;
  const active = Math.min(activeIndex, Math.max(0, items.length - 1));
  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!items.length) return;
      event.preventDefault();
      const next = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      setActiveIndex(next);
      results.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    }
    if (event.key === "Enter" && items[active] && !event.nativeEvent.isComposing) {
      event.preventDefault();
      setSearchOpen(false);
      router.push(workspaceHref(items[active].href, mode));
    }
  }
  // The /demo rewrite resolves to the same page as the unprefixed route during SSR.
  const section = path.replace(/^\/demo(?=\/|$)/, "").split("/").filter(Boolean)[0] ?? "Today";
  return <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 bg-white px-3 sm:px-4">
    <button type="button" onClick={onOpenMobileNav} className={clsx(iconButton,"lg:hidden")} aria-label="Open navigation"><Menu size={18}/></button>
    <button type="button" onClick={onToggleSidebar} className={clsx(iconButton,"hidden lg:grid")} aria-label={collapsed?"Expand navigation":"Collapse navigation"} title={collapsed ? "Expand navigation (Ctrl+B)" : "Collapse navigation (Ctrl+B)"}>{collapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}</button>
    <span className="hidden shrink-0 px-1 text-xs font-semibold capitalize text-neutral-800 lg:block">{section}</span>
    <div className="mx-auto min-w-0 max-w-[520px] flex-1 px-1 sm:px-3"><button type="button" onClick={openSearch} className="flex h-10 w-full items-center gap-2.5 rounded-xl bg-neutral-100 px-3.5 text-[13px] text-neutral-400 transition-[background-color,transform] duration-150 hover:bg-neutral-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]"><Search size={15}/><span className="min-w-0 flex-1 truncate text-left">{salesMode ? "Search leads, companies, cities…" : mode === "connected" ? "Search tasks, people, ventures…" : "Search tasks, knowledge, ventures…"}</span><kbd className="hidden rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold text-neutral-400 shadow-sm md:block">Ctrl K</kbd></button></div>
    {salesMode ? (role !== "learner" && <Link href="/sales/live/leads?new=1" aria-label="Add lead" className={newTaskClass}><Plus size={14}/><span className="max-md:sr-only">Add lead</span></Link>) : (mode === "demo" || ["admin", "venture_head", "contributor"].includes(role)) && (mode === "demo" ? <Link href="/tasks?new=1" aria-label="New task" className={newTaskClass}><Plus size={14}/><span className="max-md:sr-only">New task</span></Link> : <button type="button" onClick={openNewTask} aria-label="New task" aria-haspopup="dialog" className={newTaskClass}><Plus size={14}/><span className="max-md:sr-only">New task</span></button>)}
    {mode === "demo" ? <button type="button" onClick={onToggleFocus} aria-label="Toggle focus sprint" aria-pressed={focusOpen} className={clsx(iconButton,focusOpen?"bg-primary-100 text-primary-700":"text-primary-600 hover:bg-primary-50")}><TimerReset size={18}/></button> : <LiveFocusLink />}
    <ThemeToggle />
    {mode === "connected" ? <LiveNotificationBell /> : <Link href="/notifications" aria-label={`Notifications, ${unread} unread`} className={iconButton}><Bell size={18}/>{unread>0&&<span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-white"/>}</Link>}
    <Link href="/knowledge" aria-label="Open studio knowledge and context packets" className={clsx(iconButton,"hidden text-ai hover:bg-ai-surface sm:grid")}><Sparkles size={18}/></Link>
    <Link href={mode === "demo" ? "/settings" : "/admin"} aria-label="Open account and settings" className="hidden min-h-10 shrink-0 items-center gap-2 rounded-xl px-1.5 pr-2.5 hover:bg-neutral-100 2xl:flex"><span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-700 text-[10px] font-semibold text-white">{user.initials}</span><span className="text-left"><span className="block text-xs font-semibold text-neutral-800">{user.name}</span><span className="block text-[10px] font-semibold text-neutral-400">{role}</span></span></Link>
    {searchOpen&&<div className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/20 px-4 pt-[11vh] backdrop-blur-[2px]" onMouseDown={(event)=>event.target===event.currentTarget&&setSearchOpen(false)}><section role="dialog" aria-modal="true" aria-label={salesMode ? "Search leads" : "Search workspace"} className="w-full max-w-[560px] overflow-hidden rounded-2xl bg-white p-2 shadow-e4 ring-1 ring-neutral-900/5"><div className="flex items-center gap-3 px-3"><Search size={18} className="text-neutral-400"/><input ref={input} value={query} onChange={(event)=>{setQuery(event.target.value);setActiveIndex(0);}} onKeyDown={onSearchKey} role="combobox" aria-expanded="true" aria-controls="workspace-search-results" aria-activedescendant={items[active] ? `workspace-search-${active}` : undefined} aria-autocomplete="list" placeholder={salesMode ? "Search leads by company, contact or city" : `Search ${workspaceName}`} className="h-12 min-w-0 flex-1 bg-transparent text-sm font-semibold text-neutral-900 outline-none placeholder:text-neutral-400"/><kbd className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-[10px] font-semibold text-neutral-500">Esc</kbd></div><div ref={results} id="workspace-search-results" role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto border-t border-neutral-100 p-1.5">{items.map((item, index)=><Link key={`${item.meta}-${item.title}-${item.href}`} id={`workspace-search-${index}`} role="option" aria-selected={index === active} data-index={index} href={item.href} tabIndex={-1} onClick={()=>setSearchOpen(false)} onMouseMove={()=>{ if (index !== active) setActiveIndex(index); }} className={clsx("flex min-h-12 items-center gap-3 rounded-xl px-3", index === active && "bg-neutral-100")}><span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-50 text-primary-600"><Search size={14}/></span><span><span className="block text-xs font-semibold text-neutral-800">{item.title}</span><span className="block text-[11px] font-medium text-neutral-400">{item.meta}</span></span></Link>)}{items.length===0&&<p className="px-3 py-8 text-center text-sm text-neutral-400">{salesMode && !trimmed ? "Type a company, contact or city." : "No matching records."}</p>}</div></section></div>}
  </header>;
}
