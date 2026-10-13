"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { listLiveMembers } from "@/lib/studio-api";
import { filterControlClass, inputClass } from "@/components/studio/primitives";
import { Check, ChevronDown, RefreshCw, Search } from "@/components/ui/icons";
import { prefersReducedMotion } from "@/lib/motion";

type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
type Choice = { id: string; member?: Member };
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";

function Avatar({ name, muted = false }: { name: string; muted?: boolean }) {
  return <span aria-hidden="true" className={clsx("grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold", muted ? "bg-neutral-100 text-neutral-400" : "bg-primary-100 text-primary-700")}>{initials(name)}</span>;
}

/**
 * Type-ahead member picker scoped to a venture/group: results update as you type (after two characters),
 * arrow keys move through them, Enter picks. Opening and closing with the pointer animate; keyboard stays instant.
 */
/** `compact` renders a label-less pill for filter bars; `emptyLabel` names the "no one chosen" state there (e.g. "All assignees"). */
export function LiveMemberPicker({ label, value, onChange, ventureId, groupId, excludeIds = [], optional = false, compact = false, emptyLabel }: {
  label: string;
  value: string;
  onChange: (id: string, member?: Member) => void;
  ventureId?: string;
  groupId?: string;
  excludeIds?: string[];
  optional?: boolean;
  compact?: boolean;
  emptyLabel?: string;
}) {
  const baseId = useId().replaceAll(":", "");
  const [open, setOpen] = useState(false);
  const [motion, setMotion] = useState<"none" | "open" | "closing">("none");
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [known, setKnown] = useState<Record<string, Member>>({});
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 280, maxHeight: 320, above: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const closeTimer = useRef(0);

  // Search after a short pause; one character is too broad to send.
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(query.trim().length >= 2 ? query.trim() : ""), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      // An empty venture means the form has not chosen one yet; there is nobody to list until it does.
      if (ventureId === "") { setMembers([]); setCursor(undefined); setError(""); setBusy(false); return; }
      setBusy(true);
      listLiveMembers({ ventureId, groupId: groupId || undefined, ...(term ? { q: term } : {}), limit: 50 }).then((page) => {
        if (!active) return;
        setMembers(page.items); setCursor(page.nextCursor); setError(""); setBusy(false); setHighlighted(0);
        setKnown((current) => ({ ...current, ...Object.fromEntries(page.items.map((member) => [member.id, member])) }));
      }).catch((cause: unknown) => { if (active) { setError(describeError(cause, "Could not load members.")); setBusy(false); } });
    });
    return () => { active = false; };
  }, [ventureId, groupId, term]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const choices: Choice[] = [...(optional ? [{ id: "" }] : []), ...members.filter((member) => !excludeIds.includes(member.id)).map((member) => ({ id: member.id, member }))];
  const selected = value ? known[value] : undefined;

  function show(fromKeyboard = false) {
    if (!trigger.current) return;
    window.clearTimeout(closeTimer.current);
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width, 260));
    const below = window.innerHeight - rect.bottom - 12;
    const aboveSpace = rect.top - 12;
    const above = below < 240 && aboveSpace > below;
    const maxHeight = Math.max(180, Math.min(360, above ? aboveSpace : below));
    setPosition({ top: above ? rect.top - maxHeight - 4 : rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, maxHeight, above });
    setMotion(fromKeyboard ? "none" : "open");
    setOpen(true);
    setHighlighted(Math.max(0, choices.findIndex((choice) => choice.id === value)));
    requestAnimationFrame(() => searchInput.current?.focus());
  }

  function hide(animate: boolean, returnFocus = true) {
    window.clearTimeout(closeTimer.current);
    const finish = () => { setOpen(false); setQuery(""); };
    if (!animate || prefersReducedMotion()) finish();
    else { setMotion("closing"); closeTimer.current = window.setTimeout(finish, 100); }
    if (returnFocus) trigger.current?.focus();
  }

  function choose(choice: Choice, fromKeyboard: boolean) {
    onChange(choice.id, choice.member);
    hide(!fromKeyboard);
  }

  async function more() {
    if (!cursor) return;
    setBusy(true); setError("");
    try {
      const page = await listLiveMembers({ ventureId: ventureId || undefined, groupId: groupId || undefined, ...(term ? { q: term } : {}), cursor, limit: 50 });
      setMembers((items) => [...items, ...page.items]); setCursor(page.nextCursor);
      setKnown((current) => ({ ...current, ...Object.fromEntries(page.items.map((member) => [member.id, member])) }));
    } catch (cause) { setError(describeError(cause, "Could not load more members.")); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (trigger.current?.contains(event.target) || panel.current?.contains(event.target))) return;
      hide(true, false);
    };
    const onScroll = (event: Event) => { if (event.target instanceof Node && panel.current?.contains(event.target)) return; hide(false, false); };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("pointerdown", onPointerDown, true); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); };
  });

  useEffect(() => {
    if (!open) return;
    const item = panel.current?.querySelector<HTMLElement>(`[data-choice-index="${highlighted}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(false); return; }
    // Focus goes back to the field first, so Tab carries on to the next control (and stays inside a drawer).
    if (event.key === "Tab") { hide(false, true); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!choices.length) return;
      setHighlighted((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // While a search is pending the list still shows the previous results; never pick from it.
      if (query.trim().length >= 2 && (busy || term !== query.trim())) return;
      const choice = choices[highlighted];
      if (choice) choose(choice, true);
    }
  }

  const listId = `${baseId}-list`;
  const searching = query.trim().length >= 2 && (busy || term !== query.trim());
  return <div className={compact ? "min-w-0 shrink-0" : "min-w-0"}>
    <span id={`${baseId}-label`} className={compact ? "sr-only" : "mb-1.5 block text-xs font-semibold text-neutral-600"}>{label}</span>
    <span className={compact ? "relative inline-flex" : "relative block"}>
      <button ref={trigger} type="button" aria-labelledby={`${baseId}-label ${baseId}-value`} aria-haspopup="listbox" aria-expanded={open && motion !== "closing"}
        onClick={() => open && motion !== "closing" ? hide(true) : show()}
        onKeyDown={(event) => { if (["ArrowDown", "Enter", " "].includes(event.key) && !open) { event.preventDefault(); show(true); } }}
        className={clsx(compact ? filterControlClass : inputClass, "flex items-center gap-2.5 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600")}>
        {value && !compact ? <Avatar name={selected?.name ?? "?"} muted={!selected} /> : null}
        <span id={`${baseId}-value`} className={clsx("min-w-0 flex-1 truncate", !value && "text-neutral-400")}>{value ? selected ? <>{selected.name}{selected.handle && <span className="ml-1.5 text-neutral-400">@{selected.handle}</span>}</> : "Selected member" : optional ? emptyLabel ?? "None" : "Choose a member"}</span>
        <ChevronDown size={15} aria-hidden="true" className={clsx("pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 transition-transform duration-150", open && motion !== "closing" && "rotate-180")} />
      </button>
      <input tabIndex={-1} aria-hidden="true" required={!optional} value={value} onChange={() => {}} onInvalid={(event) => { event.preventDefault(); show(); }} className="pointer-events-none absolute bottom-0 left-4 h-px w-px opacity-0" />
    </span>
    {error && !open && <p role="alert" className="vso-fade-enter mt-1 text-xs text-danger-text">{error}</p>}
    {open && createPortal(<div ref={panel} data-side={position.above ? "top" : "bottom"} data-align="left" data-state={motion === "closing" ? "closing" : undefined}
      className={clsx("fixed z-[120] flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-800 shadow-e4", motion !== "none" && "vso-enter-popover")}
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}>
      <label className="relative flex shrink-0 items-center border-b border-neutral-100">
        <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 text-neutral-400" />
        <input ref={searchInput} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={choices[highlighted] ? `${listId}-${highlighted}` : undefined} aria-label={`Search ${label.toLowerCase()}`} value={query} onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }} onKeyDown={onSearchKey} placeholder="Type a name or @handle" className="h-11 w-full bg-transparent pl-9 pr-9 text-sm font-medium outline-none placeholder:text-neutral-400" />
        {searching && <RefreshCw size={14} aria-hidden="true" className="vso-spin absolute right-3 text-neutral-400" />}
      </label>
      <div id={listId} role="listbox" aria-label={label} aria-busy={busy || undefined} className={clsx("thin-scroll min-h-0 flex-1 overflow-y-auto p-1 transition-opacity duration-150", searching && "opacity-60")}>
        {choices.map((choice, index) => <div key={choice.id || "none"} id={`${listId}-${index}`} data-choice-index={index} role="option" aria-selected={choice.id === value}
          onMouseEnter={() => setHighlighted(index)} onClick={() => choose(choice, false)}
          className={clsx("flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm", index === highlighted ? "bg-primary-50 text-primary-900" : "hover:bg-neutral-50")}>
          {choice.member ? <Avatar name={choice.member.name} /> : <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-dashed border-neutral-300" />}
          <span className="min-w-0 flex-1 truncate font-medium">{choice.member ? choice.member.name : "None"}{choice.member?.handle && <span className="ml-1.5 text-xs text-neutral-400">@{choice.member.handle}</span>}</span>
          {choice.id === value && <Check size={14} aria-hidden="true" className="shrink-0 text-primary-700" />}
        </div>)}
        {!choices.length && !busy && <p className="vso-fade-enter px-3 py-6 text-center text-sm text-neutral-500">{ventureId === "" ? "Choose a venture first." : term ? `No one matches “${term}”.` : "No eligible members in this scope."}</p>}
        {!choices.length && busy && <div className="grid gap-2 p-2">{[0, 1, 2].map((index) => <span key={index} className="vso-skeleton h-8" />)}</div>}
        {cursor && <button type="button" disabled={busy} onClick={() => void more()} className="mt-1 w-full rounded-lg px-3 py-2 text-left text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 disabled:opacity-50">{busy ? "Loading…" : "Load more people"}</button>}
        {error && <p role="alert" className="px-3 py-2 text-xs text-danger-text">{error}</p>}
      </div>
    </div>, document.body)}
  </div>;
}
