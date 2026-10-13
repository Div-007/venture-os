"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { PAT_DIRECT_MESSAGE_SCOPES, PAT_ENGINE_SCOPES, PAT_READ_SCOPES, PAT_WRITE_SCOPES } from "@venture-studio/contracts";
import { BookOpenText, Check, Clock3, Copy, KeyRound, LockKeyhole, Plus, ShieldCheck, Sparkles, X } from "@/components/ui/icons";
import { Dither } from "@/components/ui/dither";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, PageFrame, PageTitle, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createLivePat, listLivePats, revokeLivePat } from "@/lib/studio-api";
import { useExitTransition } from "@/lib/motion";

type Pat = Awaited<ReturnType<typeof listLivePats>>[number];
type Access = "update" | "read";
/** The two Claude connectors, and the third key preset: the office PC engine, which is a worker and not a Claude connection. */
type ClaudeConnector = "studio" | "sales";
type Connector = ClaudeConnector | "engine";
const isSalesScope = (scope: string) => scope.startsWith("sales:");
// One key model, two connectors. A Venture Studio key carries no sales scopes (sales has its own connector); a Dealflow Sales key is the sales set plus the venture lookup.
const READ = PAT_READ_SCOPES.filter((scope) => !isSalesScope(scope)); const UPDATE = [...READ, ...PAT_WRITE_SCOPES.filter((scope) => !isSalesScope(scope))];
const SALES_SCOPES = ["sales:read", "sales:write", "ventures:read"];
const ENGINE_SCOPES = [...PAT_ENGINE_SCOPES];
const CONNECTORS = {
  studio: { title: "Venture Studio", path: "/mcp", server: "venture-studio", keyName: "My laptop", blurb: "Tasks, reviews, knowledge, decisions, channels, calendar and reminders." },
  sales: { title: "Dealflow Sales", path: "/mcp/sales", server: "dealflow-sales", keyName: "Dealflow Sales", blurb: "Leads, verdicts, drafts, replies, plays and the sales brain. Claude never sends or approves anything." },
  engine: { title: "Office PC engine", path: "", server: "", keyName: "Office PC engine", blurb: "The lead-finding worker on the office PC. It isn't a Claude connection: Claude can't use this key." },
} as const;
const connectorOf = (pat: { scopes: string[] }): Connector => pat.scopes.includes("sales:engine") ? "engine" : pat.scopes.some(isSalesScope) && !pat.scopes.includes("tasks:read") ? "sales" : "studio";
// Direct messages are opt-in per key: reading only with Read only, reading and sending with Read and update.
const directScopes = (access: Access) => access === "update" ? [...PAT_DIRECT_MESSAGE_SCOPES] : [PAT_DIRECT_MESSAGE_SCOPES[0]];
const DAY = 86_400_000;
const accessOf = (pat: Pat): Access => pat.scopes.some((scope) => scope.endsWith(":write")) ? "update" : "read";
const accessLabel = { update: "Read and update", read: "Read only" } as const;
const shortDate = (value: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(new Date(value));
const tileOf = (id: string) => `vso-key-tile-${[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5}`;
const mcpCommand = (connector: ClaudeConnector, origin: string, token: string) => `claude mcp add --transport http ${CONNECTORS[connector].server} ${origin}${CONNECTORS[connector].path} --header "Authorization: Bearer ${token}"`;
const LOOP_PROMPT = "/loop 1h Use the venture-studio whats_new tool with the cursor from last time. Tell me only if something changed.";

function ago(value: string, now: number) {
  const minutes = Math.round((now - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 1440) return format.format(-Math.round(minutes / 60), "hour");
  return format.format(-Math.round(minutes / 1440), "day");
}

function expiry(value: string | undefined, now: number) {
  if (!value) return { text: "Never", soon: false };
  const days = Math.ceil((new Date(value).getTime() - now) / DAY);
  return { text: days <= 1 ? "Tomorrow" : `In ${days} days`, soon: days <= 7 };
}

/** The older copy path, for browsers or frames that block the async clipboard API. */
function copyWithSelection(text: string) {
  const area = document.createElement("textarea");
  area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
  document.body.append(area); area.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { area.remove(); }
}

/** Copies text and briefly shows a check; used for the key, commands, and prompts. */
function useCopy() {
  const [copied, setCopied] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const done = (id: string) => { setCopied(id); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setCopied(""), 1600); };
  const copy = async (id: string, text: string, source?: HTMLElement | null) => {
    try { await navigator.clipboard.writeText(text); done(id); return; } catch { /* fall through */ }
    if (copyWithSelection(text)) { done(id); return; }
    // Last resort: select the text on screen so Ctrl+C works.
    if (source) { const range = document.createRange(); range.selectNodeContents(source); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); }
    toast({ tone: "error", title: "Couldn't copy automatically", body: "The text is selected: press Ctrl+C (or Cmd+C) to copy it." });
  };
  return { copied, copy };
}

/** Text in a dark well with a copy button. Fixed colors, so it reads the same in light and dark themes. */
function CodeWell({ label, text, id, copy, copied, emphasis = false }: { label: string; text: string; id: string; copy: (id: string, text: string, source?: HTMLElement | null) => void; copied: string; emphasis?: boolean }) {
  const done = copied === id;
  const code = useRef<HTMLElement>(null);
  return <div className={clsx("vso-code-well flex items-start gap-2 rounded-xl p-3", emphasis && "vso-code-well-key")}>
    <code ref={code} className={clsx("min-w-0 flex-1 select-all whitespace-pre-wrap break-all font-mono leading-5", emphasis ? "text-[13px] font-semibold" : "text-[12px]")}>{text}</code>
    <button type="button" aria-label={done ? `${label} copied` : `Copy ${label}`} onClick={() => copy(id, text, code.current)} className="vso-code-well-button inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition-[background-color,transform] duration-150 active:scale-[0.96]">
      {done ? <Check size={14} /> : <Copy size={14} />}<span>{done ? "Copied" : "Copy"}</span>
    </button>
  </div>;
}

/** A small gradient tile with a key, tinted per key so a list of keys is easy to scan. */
function KeyTile({ seed, size = 44 }: { seed?: string; size?: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size }} className={clsx("vso-key-tile relative grid shrink-0 place-items-center overflow-hidden rounded-xl text-white", seed ? tileOf(seed) : "vso-key-tile-0")}>
    <Dither colors={["#ffffff"]} origin={[0.15, 0.1]} reach={0.9} pixel={2} className="opacity-25 mix-blend-overlay" />
    <KeyRound size={Math.round(size * 0.42)} className="relative drop-shadow-sm" />
  </span>;
}

/** The two connectors: each with its address to copy and a key preset for it. */
function Connectors({ origin, onCreate }: { origin: string; onCreate: (connector: Connector) => void }) {
  const { copied, copy } = useCopy();
  return <section aria-labelledby="connectors-heading" className="mb-6">
    <h2 id="connectors-heading" className="mb-3 text-sm font-bold text-neutral-900">Connectors</h2>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {(Object.keys(CONNECTORS) as Connector[]).map((key) => {
        const item = CONNECTORS[key];
        return <article key={key} className="vso-fade-enter flex min-w-0 flex-col rounded-2xl border border-neutral-100 bg-white p-4 shadow-card">
          <h3 className="text-sm font-bold text-neutral-900">{item.title}</h3>
          <p className="mt-1 text-xs leading-5 text-neutral-500">{item.blurb}</p>
          {item.path && <div className="mt-3"><CodeWell label={`${item.title} address`} id={`address-${key}`} text={`${origin}${item.path}`} copy={copy} copied={copied} /></div>}
          <button type="button" onClick={() => onCreate(key)} className={clsx(secondaryClass, "mt-3 self-start")}><KeyRound size={15} />New key for {item.title}</button>
        </article>;
      })}
    </div>
  </section>;
}

function EmptyKeys({ onCreate, onGuide }: { onCreate: () => void; onGuide: () => void }) {
  return <section className="vso-fade-enter relative overflow-hidden rounded-3xl border border-neutral-100 bg-white shadow-card">
    <div className="relative h-56 overflow-hidden sm:h-64">
      <div aria-hidden="true" className="vso-connect-glow absolute inset-0" />
      <Dither colors={["var(--color-primary-100)", "var(--color-primary-200)", "var(--color-primary-300)", "var(--color-primary-400)"]} origin={[0.5, -0.2]} reach={0.95} pixel={4} className="opacity-70" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--color-neutral-0)] to-transparent" />
      {/* Three stacked key cards: the illustration for "no keys yet". */}
      <div aria-hidden="true" className="absolute left-1/2 top-1/2 h-32 w-64 -translate-x-1/2 -translate-y-[44%]">
        <div className="absolute inset-0 -rotate-[9deg] translate-x-[-28px] translate-y-[10px] rounded-2xl border border-neutral-200 bg-white opacity-60 shadow-sm" />
        <div className="absolute inset-0 rotate-[7deg] translate-x-[26px] translate-y-[4px] rounded-2xl border border-neutral-200 bg-white opacity-80 shadow-sm" />
        <div className="absolute inset-0 rounded-2xl border border-neutral-100 bg-white p-4 shadow-xl">
          <div className="flex items-center gap-3"><KeyTile size={38} /><div className="flex-1 space-y-1.5"><span className="block h-2.5 w-24 rounded-full bg-neutral-200" /><span className="block h-2 w-16 rounded-full bg-neutral-100" /></div></div>
          <p className="mt-4 font-mono text-[12px] tracking-wider text-neutral-400">vso_••••••••••••••</p>
          <span className="vso-role vso-role-head mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold">Read and update</span>
        </div>
      </div>
    </div>
    <div className="relative px-6 pb-8 text-center sm:px-10">
      <h2 className="text-xl font-extrabold tracking-[-.03em] text-neutral-900">No keys yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-neutral-500">Create a key to connect Claude Code on your computer. Claude sees exactly what you see here, and you can revoke the key at any time.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onCreate} className={primaryClass}><Plus size={16} />Create your first key</button>
        <button type="button" onClick={onGuide} className={secondaryClass}><BookOpenText size={16} />How it works</button>
      </div>
      <ul className="mx-auto mt-8 grid max-w-2xl gap-3 text-left sm:grid-cols-3">
        {([[ShieldCheck, "Your access only", "Claude can't see anything you can't."], [LockKeyhole, "Revoke anytime", "A revoked key stops working at once."], [Clock3, "Hourly check-ins", "Claude can tell you when work lands."]] as const).map(([Icon, title, body]) => <li key={title} className="flex gap-3 rounded-2xl bg-neutral-50 p-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-700"><Icon size={16} /></span>
          <span><span className="block text-xs font-bold text-neutral-800">{title}</span><span className="mt-0.5 block text-xs leading-5 text-neutral-500">{body}</span></span>
        </li>)}
      </ul>
    </div>
  </section>;
}

function KeyCard({ pat, now, onRevoked }: { pat: Pat; now: number; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const access = accessOf(pat); const expires = expiry(pat.expiresAt, now);
  async function revoke() {
    setBusy(true);
    try { await revokeLivePat(pat.id); toast({ title: `${pat.name} revoked`, body: "Claude on that computer lost access immediately." }); onRevoked(); }
    catch (cause) { toast({ tone: "error", title: "Could not revoke", body: describeError(cause, "Try again.") }); }
    finally { setBusy(false); }
  }
  return <article className="vso-fade-enter min-w-0 rounded-2xl border border-neutral-100 bg-white p-4 shadow-card transition-shadow duration-200 hover:shadow-card-hover">
    <div className="flex items-start gap-3">
      <KeyTile seed={pat.id} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-bold text-neutral-900">{pat.name}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <code className="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600">{pat.prefix}…</code>
          <span className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600">{CONNECTORS[connectorOf(pat)].title}</span>
          <span className={clsx("vso-role inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", access === "update" ? "vso-role-head" : "vso-role-review")}>{accessLabel[access]}</span>
          {pat.scopes.includes("direct_messages:read") && <span className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600">+ direct messages</span>}
        </div>
      </div>
      {!confirming && <button type="button" onClick={() => setConfirming(true)} className="min-h-8 shrink-0 rounded-lg px-2.5 text-xs font-semibold text-danger-text transition-[background-color,transform] duration-150 hover:bg-danger-surface active:scale-[0.97]">Revoke</button>}
    </div>
    <dl className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-neutral-50 px-3 py-2.5">
      <div className="min-w-0"><dt className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-neutral-400">Created</dt><dd className="mt-0.5 truncate text-xs font-semibold text-neutral-700">{shortDate(pat.createdAt)}</dd></div>
      <div className="min-w-0"><dt className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-neutral-400">Last used</dt><dd className="mt-0.5 truncate text-xs font-semibold text-neutral-700">{pat.lastUsedAt ? ago(pat.lastUsedAt, now) : "Never"}</dd></div>
      <div className="min-w-0"><dt className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-neutral-400">Expires</dt><dd className={clsx("mt-0.5 truncate text-xs font-semibold", expires.soon ? "text-warning-text" : "text-neutral-700")}>{expires.text}</dd></div>
    </dl>
    <div data-open={confirming} className="vso-collapse"><div>
      <div className="mt-3 rounded-xl bg-danger-surface p-3">
        <p className="text-xs leading-5 text-danger-text"><strong className="font-semibold">Revoke this key?</strong> Claude on that computer loses access right away. This can&apos;t be undone.</p>
        <div className="mt-2.5 flex justify-end gap-2">
          <button type="button" tabIndex={confirming ? 0 : -1} disabled={busy} onClick={() => setConfirming(false)} className="min-h-8 rounded-lg px-3 text-xs font-semibold text-neutral-600 transition-colors duration-150 hover:bg-white/60">Keep it</button>
          <button type="button" tabIndex={confirming ? 0 : -1} disabled={busy} onClick={revoke} className="min-h-8 rounded-lg bg-[#b42318] px-3 text-xs font-semibold text-white transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.97] disabled:opacity-50">{busy ? "Revoking…" : "Revoke key"}</button>
        </div>
      </div>
    </div></div>
  </article>;
}

/** New key: a short form, then the key (shown once) with the ready-made command. */
function CreateKeyDialog({ origin, initial, onClose, onCreated }: { origin: string; initial: Connector; onClose: () => void; onCreated: () => void }) {
  const [connector, setConnector] = useState<Connector>(initial);
  const [name, setName] = useState<string>(CONNECTORS[initial].keyName);
  // Read only by default: text Claude reads (files, messages) is written by others, so changing data is opted into.
  const [access, setAccess] = useState<Access>("read");
  const [directMessages, setDirectMessages] = useState(false);
  const [days, setDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ token: string; name: string; connector: Connector } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const copyKeyButton = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();
  const exit = useExitTransition(onClose, 130);
  // Once the key is on screen, only the explicit button closes the dialog, so a stray click can't lose it.
  const dismissable = !created && !busy;

  useEffect(() => { firstField.current?.select(); }, []);
  // Picking the other connector renames the key, unless the name was changed by hand.
  const pick = (next: Connector) => { if (name === CONNECTORS[connector].keyName) setName(CONNECTORS[next].keyName); setConnector(next); };
  useEffect(() => { if (created) copyKeyButton.current?.querySelector("button")?.focus(); }, [created]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const scopes = connector === "engine" ? ENGINE_SCOPES : connector === "sales" ? SALES_SCOPES : [...(access === "update" ? UPDATE : READ), ...(directMessages ? directScopes(access) : [])];
      const result = await createLivePat({ name: name.trim() || "Claude", scopes, expiresInDays: Number(days) });
      setCreated({ token: result.token, name: result.pat.name, connector }); onCreated();
    } catch (cause) { setError(describeError(cause, "Could not create the key.")); }
    finally { setBusy(false); }
  }

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") { if (event.target instanceof HTMLElement && event.target.closest('[role="combobox"][aria-expanded="true"]')) return; event.stopPropagation(); if (dismissable) exit.close(); return; }
    if (event.key !== "Tab") return;
    const items = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]):not([aria-hidden="true"])');
    if (!items?.length) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return createPortal(<div data-state={exit.state} className="vso-backdrop fixed inset-0 z-50 grid place-items-center bg-neutral-900/30 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget && dismissable) exit.close(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={created ? "Your key is ready" : "New key"} onKeyDownCapture={onKey} className="vso-enter-modal thin-scroll max-h-[min(92dvh,760px)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white shadow-2xl">
      {created ? <div key="ready" className="vso-fade-enter">
        <div className="relative h-32 overflow-hidden rounded-t-3xl">
          <div aria-hidden="true" className="vso-connect-glow absolute inset-0" />
          <Dither colors={["var(--color-primary-100)", "var(--color-primary-200)", "var(--color-primary-300)"]} origin={[0.5, -0.1]} reach={1.2} pixel={3} className="opacity-90" />
          <div className="absolute inset-0 grid place-items-center"><span className="vso-key-tile vso-key-tile-0 grid h-14 w-14 place-items-center rounded-2xl text-white shadow-lg ring-4 ring-white"><Check size={26} /></span></div>
        </div>
        <div className="px-6 pb-6 pt-4">
          <h2 className="text-center text-lg font-extrabold tracking-[-.02em] text-neutral-900">{created.name} is ready</h2>
          <p className="mx-auto mt-1 max-w-sm text-center text-sm leading-6 text-neutral-500">Copy the key now. For your safety it&apos;s shown only once, and anyone with it can act as you through Claude.</p>
          <div ref={copyKeyButton} className="mt-5 space-y-1.5"><p className="text-xs font-semibold text-neutral-600">Your key</p><CodeWell label="key" id="key" text={created.token} copy={copy} copied={copied} emphasis /></div>
          {created.connector !== "engine" && <div className="mt-4 space-y-1.5"><p className="text-xs font-semibold text-neutral-600">Connect Claude Code: run this in a terminal</p><CodeWell label="command" id="command" text={mcpCommand(created.connector, origin, created.token)} copy={copy} copied={copied} /></div>}
          <p className="mt-4 flex gap-2 rounded-xl bg-primary-50 p-3 text-xs leading-5 text-primary-800"><Sparkles size={15} className="mt-0.5 shrink-0" />{created.connector === "engine"
            ? <span>Give this key to the engine on the office PC: it keeps it in Windows Credential Manager. Never paste it into a chat, and revoke it here if the PC is lost.</span>
            : created.connector === "sales"
            ? <span>Then ask Claude &ldquo;What needs me in sales today?&rdquo;, or run <code className="font-mono">/mcp__dealflow-sales__sales</code>. Claude researches leads and writes drafts; you send and approve.</span>
            : <span>Then ask Claude &ldquo;What&apos;s on my plate today?&rdquo;. The setup guide on this page has more prompts and an hourly check-in.</span>}</p>
          <button type="button" onClick={exit.close} className={clsx(primaryClass, "mt-5 w-full")}>I&apos;ve copied my key</button>
        </div>
      </div> : <form key="form" onSubmit={submit} className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3"><KeyTile size={40} /><div><h2 className="text-base font-bold text-neutral-900">New key</h2><p className="text-xs text-neutral-500">One key per computer is easiest to manage.</p></div></div>
          <button type="button" aria-label="Close" onClick={exit.close} className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-700 active:scale-[0.96]"><X size={16} /></button>
        </div>
        <div className="mt-5 space-y-4">
          <fieldset><legend className="mb-1.5 text-xs font-semibold text-neutral-600">Connector</legend><div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(CONNECTORS) as Connector[]).map((value) => <label key={value} className={clsx("cursor-pointer rounded-2xl border p-3 transition-[border-color,background-color,box-shadow] duration-150", connector === value ? "border-primary-400 bg-primary-50 shadow-[0_0_0_3px_var(--color-primary-100)]" : "border-neutral-200 hover:bg-neutral-50")}>
              <span className="flex items-center gap-2 text-sm font-semibold text-neutral-800"><input type="radio" name="connector" checked={connector === value} onChange={() => pick(value)} className="accent-[var(--color-primary-600)]" />{CONNECTORS[value].title}</span>
              <span className="mt-1 block font-mono text-[11px] text-neutral-500">{CONNECTORS[value].path || "Not for Claude"}</span>
            </label>)}
          </div></fieldset>
          <Field label="Name"><input ref={firstField} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} className={inputClass} placeholder="Work laptop" /></Field>
          {connector === "engine" ? <p className="rounded-2xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">For the lead-finding worker on the office PC: it reads Sales and posts the leads it finds. It isn&apos;t a Claude connection (Claude can&apos;t use it) and it can&apos;t change anything else.</p> : connector === "sales" ? <p className="rounded-2xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">Claude can research and judge leads, write drafts, review drafts in another conversation, and log replies and calls. It can&apos;t send anything, and approvals stay with you. Only sales and the venture list are shared.</p> : <>
          <fieldset><legend className="mb-1.5 text-xs font-semibold text-neutral-600">Access</legend><div className="grid gap-2 sm:grid-cols-2">
            {([["update", "Create and update tasks, review evidence, write draft documents, upload files, post in channels, schedule events, and record decisions, plus everything in read only."], ["read", "Check tasks, reviews, knowledge, files, calendars, decisions, requests, classes, and channels. Changes nothing."]] as const).map(([value, body]) => <label key={value} className={clsx("cursor-pointer rounded-2xl border p-3 transition-[border-color,background-color,box-shadow] duration-150", access === value ? "border-primary-400 bg-primary-50 shadow-[0_0_0_3px_var(--color-primary-100)]" : "border-neutral-200 hover:bg-neutral-50")}>
              <span className="flex items-center gap-2 text-sm font-semibold text-neutral-800"><input type="radio" name="access" checked={access === value} onChange={() => setAccess(value)} className="accent-[var(--color-primary-600)]" />{accessLabel[value]}</span>
              <span className="mt-1 block text-xs leading-5 text-neutral-500">{body}</span>
            </label>)}
          </div></fieldset>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-neutral-200 p-3 transition-colors duration-150 hover:bg-neutral-50 has-[:checked]:border-primary-300 has-[:checked]:bg-primary-50">
            <input type="checkbox" checked={directMessages} onChange={(event) => setDirectMessages(event.target.checked)} className="mt-0.5 accent-[var(--color-primary-600)]" />
            <span><span className="block text-sm font-semibold text-neutral-800">Include my direct messages</span><span className="mt-0.5 block text-xs leading-5 text-neutral-500">{access === "update" ? "Claude can read your private conversations and send messages as you, labelled “via Claude”." : "Claude can read your private conversations."} Off unless you tick it.</span></span>
          </label></>}
          <Field label="Expires after"><Select aria-label="Expires after" className={inputClass} value={days} onChange={(event) => setDays(event.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="366">1 year</option></Select></Field>
          <Notice tone="error" message={error} onDismiss={() => setError("")} />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={exit.close} className={secondaryClass}>Cancel</button>
          <button type="submit" disabled={busy} className={primaryClass}><KeyRound size={15} /><ActionLabel busy={busy} busyText="Creating…" idle="Create key" /></button>
        </div>
      </form>}
    </section>
  </div>, document.body);
}

function GuideStep({ index, title, last = false, children }: { index: number; title: string; last?: boolean; children: React.ReactNode }) {
  return <li className={clsx("relative flex gap-4", !last && "pb-7")}>
    {!last && <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-9 w-px bg-neutral-200" />}
    <span className="vso-key-tile vso-key-tile-0 relative grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold text-white">{index}</span>
    <div className="min-w-0 flex-1 pt-1"><h3 className="text-sm font-bold text-neutral-900">{title}</h3><div className="mt-1.5 space-y-2.5 text-sm leading-6 text-neutral-600">{children}</div></div>
  </li>;
}

function SetupGuide({ origin, onClose, onCreate }: { origin: string; onClose: () => void; onCreate: (connector: Connector) => void }) {
  const { copied, copy } = useCopy();
  return <DetailDrawer title="Set up Claude Code" subtitle="About two minutes, once per computer" onClose={onClose}>
    <div className="relative -mx-5 -mt-5 mb-6 h-24 overflow-hidden">
      <div aria-hidden="true" className="vso-connect-glow absolute inset-0" />
      <Dither colors={["var(--color-primary-100)", "var(--color-primary-200)", "var(--color-primary-300)"]} shape="linear" angle={0} reach={1.3} pixel={3} className="opacity-80" />
    </div>
    <ol>
      <GuideStep index={1} title="Create a key">
        <p>Pick a connector. <strong className="font-semibold text-neutral-800">Venture Studio</strong> is for tasks and communication: choose Read and update so Claude can move tasks, comment, add evidence, and set reminders, or Read only if it should change nothing. <strong className="font-semibold text-neutral-800">Dealflow Sales</strong> is for the sales workflow and has one ready-made preset.</p>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => onCreate("studio")} className={secondaryClass}><Plus size={15} />Venture Studio key</button><button type="button" onClick={() => onCreate("sales")} className={secondaryClass}><Plus size={15} />Dealflow Sales key</button></div>
      </GuideStep>
      <GuideStep index={2} title="Add the connector to Claude Code">
        <p>Run the one you need in a terminal with your key in place of <code className="rounded bg-neutral-100 px-1 font-mono text-[12px]">YOUR_KEY</code>. The new-key screen gives you this command with the key already filled in.</p>
        <CodeWell label="Venture Studio command" id="command-studio" text={mcpCommand("studio", origin, "YOUR_KEY")} copy={copy} copied={copied} />
        <CodeWell label="Dealflow Sales command" id="command-sales" text={mcpCommand("sales", origin, "YOUR_KEY")} copy={copy} copied={copied} />
      </GuideStep>
      <GuideStep index={3} title="Ask Claude">
        <ul className="flex flex-wrap gap-1.5">{["What's on my plate today?", "Anything new since this morning?", "Draft my standup", "Remind me at 5pm to send the invoice", "Move the pricing task to review"].map((prompt) => <li key={prompt}><button type="button" onClick={() => copy(prompt, prompt)} className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 transition-[background-color,transform] duration-150 hover:bg-neutral-50 active:scale-[0.97]">{copied === prompt ? "Copied" : prompt}</button></li>)}</ul>
        <p>Or use the slash commands <code className="rounded bg-neutral-100 px-1 font-mono text-[12px]">/mcp__venture-studio__today</code>, <code className="rounded bg-neutral-100 px-1 font-mono text-[12px]">standup</code>, and <code className="rounded bg-neutral-100 px-1 font-mono text-[12px]">triage</code>. For sales: <code className="rounded bg-neutral-100 px-1 font-mono text-[12px]">/mcp__dealflow-sales__sales</code> and <code className="rounded bg-neutral-100 px-1 font-mono text-[12px]">review_drafts</code>.</p>
      </GuideStep>
      <GuideStep index={4} title="Optional: an hourly check-in" last>
        <p>Keep a Claude Code session open with this, and Claude speaks up only when something changed. In Claude Desktop, a scheduled task with the same prompt shows a desktop notification.</p>
        <CodeWell label="hourly prompt" id="loop" text={LOOP_PROMPT} copy={copy} copied={copied} />
      </GuideStep>
    </ol>
    <section className="mt-8 grid gap-3 sm:grid-cols-2">
      <div className="rounded-2xl bg-neutral-50 p-4"><h3 className="text-xs font-bold uppercase tracking-[.06em] text-neutral-500">Claude can read</h3><p className="mt-2 text-sm leading-6 text-neutral-700">Your plate and new items, tasks and reviews, ventures, knowledge, decisions, channels, and your reminders.</p></div>
      <div className="rounded-2xl bg-neutral-50 p-4"><h3 className="text-xs font-bold uppercase tracking-[.06em] text-neutral-500">With update access</h3><p className="mt-2 text-sm leading-6 text-neutral-700">Task status, comments, evidence, reminders and snoozes, and marking notifications read.</p></div>
    </section>
    <ul className="mt-4 space-y-2 text-xs leading-5 text-neutral-500">
      <li className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary-600" />Claude sees exactly what you see. It never deletes or archives, changes members, or reads direct messages.</li>
      <li className="flex gap-2"><LockKeyhole size={14} className="mt-0.5 shrink-0 text-primary-600" />Treat a key like a password: don&apos;t share or commit it. Revoke it here if a computer is lost.</li>
    </ul>
  </DetailDrawer>;
}

/** Each person connects Claude Code (or another MCP client) with their own key; it sees exactly what they see in the app. */
export function LiveConnectScreen() {
  const [items, setItems] = useState<Pat[] | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<Connector | null>(null);
  const [guide, setGuide] = useState(false);
  const [revision, setRevision] = useState(0);
  // The address is only known in the browser: empty on the server, then the page's own origin (no hydration mismatch).
  const origin = useSyncExternalStore(() => () => {}, () => window.location.origin, () => "");

  useEffect(() => {
    let active = true;
    // Revoked and expired keys no longer do anything, so only live ones are listed.
    listLivePats().then((value) => {
      const current = Date.now();
      if (active) { setNow(current); setItems(value.filter((pat) => !pat.revokedAt && (!pat.expiresAt || new Date(pat.expiresAt).getTime() > current))); setError(""); }
    }, (cause: unknown) => { if (active) setError(describeError(cause, "Could not load your keys.")); });
    return () => { active = false; };
  }, [revision]);

  const refresh = () => setRevision((value) => value + 1);
  const openCreate = (connector: Connector = "studio") => { setGuide(false); setCreating(connector); };

  return <PageFrame>
    <PageTitle title="Connect Claude" description="Two connectors for Claude: Venture Studio for tasks and communication, and Dealflow Sales for the sales workflow. Each uses your own key and sees only what you see." action={<div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => setGuide(true)} className={secondaryClass}><BookOpenText size={16} />Setup guide</button>
      <button type="button" onClick={() => openCreate()} className={primaryClass}><Plus size={16} />New key</button>
    </div>} />
    <Connectors origin={origin} onCreate={openCreate} />
    {items && <Notice tone="error" message={error} onDismiss={() => setError("")} className="pb-4" />}
    {!items && error ? <EmptyState variant="error" title="Couldn't load your keys" body={error} action={{ label: "Try again", onClick: refresh }} className="rounded-2xl border border-neutral-100 bg-white shadow-card" />
      : !items ? (<div role="status" aria-label="Loading keys" className="grid gap-3 md:grid-cols-2">{[0, 1].map((index) => <div key={index} className="rounded-2xl border border-neutral-100 bg-white p-4 shadow-card"><div className="flex gap-3"><span className="vso-skeleton h-11 w-11 rounded-xl" /><div className="flex-1 space-y-2 pt-1"><span className="vso-skeleton h-3 w-1/2" /><span className="vso-skeleton h-3 w-1/3" /></div></div><span className="vso-skeleton mt-4 h-12 w-full rounded-xl" /></div>)}</div>)
      : !items.length ? <EmptyKeys onCreate={() => openCreate()} onGuide={() => setGuide(true)} />
      : <section aria-labelledby="keys-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="keys-heading" className="text-sm font-bold text-neutral-900">Your keys <span className="font-semibold text-neutral-400">{items.length}</span></h2>
          <p className="text-xs text-neutral-500">One key per computer. Revoke any you no longer use.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((pat) => <KeyCard key={pat.id} pat={pat} now={now} onRevoked={refresh} />)}
          <button type="button" onClick={() => openCreate()} className="group flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-200 p-4 text-neutral-500 transition-[border-color,background-color,color,transform] duration-150 hover:border-primary-300 hover:bg-primary-50/50 hover:text-primary-700 active:scale-[0.99]">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-neutral-100 transition-colors duration-150 group-hover:bg-primary-100"><Plus size={18} /></span>
            <span className="text-sm font-semibold">Add another computer</span>
          </button>
        </div>
      </section>}
    {creating && <CreateKeyDialog origin={origin} initial={creating} onClose={() => setCreating(null)} onCreated={refresh} />}
    {guide && <SetupGuide origin={origin} onClose={() => setGuide(false)} onCreate={openCreate} />}
  </PageFrame>;
}
