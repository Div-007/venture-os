"use client";
import { useState } from "react";
import clsx from "clsx";
import { salesSearchKeyInputSchema } from "@venture-studio/contracts";
import { ArrowUpRight, Check, CircleAlert, Search } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, inputClass, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { getSearchKeys, removeSearchKey, saveSearchKey, testSearchKey, type SalesSearchEngine, type SalesSearchKeys, type SalesSearchKeyStatus, type SalesSearchKeyTest } from "@/lib/sales-api";
import { useSalesLoad } from "./draft-shared";
import { absoluteDate, type Tone } from "./sales-ui";

// The company-search keys (TinyFish, Exa) behind Claude's search_companies and the lead finder, for the whole workspace. Admins only: the
// setup screen renders this for them, and the API refuses everyone else. A key is typed once and never shown again.

const ENGINES: { engine: SalesSearchEngine; name: string; purpose: string; site: string; host: string }[] = [
  { engine: "tinyfish", name: "TinyFish Search", purpose: "Free: 1,500 searches a day.", site: "https://tinyfish.ai", host: "tinyfish.ai" },
  { engine: "exa", name: "Exa", purpose: "About 1,200 searches a month on its free credit.", site: "https://exa.ai", host: "exa.ai" },
];

const chipOf = (status: SalesSearchKeyStatus): { tone: Tone; text: string } =>
  status.source === "app" ? { tone: "green", text: `Saved in the app ••••${status.last4 ?? ""}` }
    : status.unreadable ? { tone: "red", text: "Unreadable, enter it again" }
      : status.source === "server" ? { tone: "blue", text: "Set on the server" } : { tone: "neutral", text: "Not set" };

/** When and by whom a key was saved, and what search uses meanwhile. */
function detailOf(status: SalesSearchKeyStatus): string {
  const saved = status.setAt ? `Saved ${absoluteDate(status.setAt)}${status.setByName ? ` by ${status.setByName}` : ""}` : "";
  if (status.source === "app") return `${saved}. It wins over a key set on the server.`;
  if (status.unreadable) return `${saved ? `${saved}, but` : "A saved key"} can't be read any more (the server's secret changed). Paste it again${status.source === "server" ? "; the server's key is used meanwhile" : ""}.`;
  if (status.source === "server") return "Set in the server's settings. A key saved here takes its place.";
  return "Search with this engine is off until a key is added.";
}

/** One panel under the setup checklist: a row per engine with its status, a key field, and Test and Remove. */
export function SetupSearchKeys() {
  const keys = useSalesLoad<SalesSearchKeys>("sales-search-keys", getSearchKeys);
  return <Panel className="mt-4 p-4 sm:p-5">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-50 text-primary-700"><Search size={15} /></span>
      <div className="min-w-0">
        <h2 className="text-sm font-bold text-neutral-900">Company search keys</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-neutral-500">Claude&apos;s company search and the lead finder look companies up on the web with these, for every venture. A key saved here is stored encrypted and never shown again. Only admins see this.</p>
      </div>
    </div>
    {keys.error && !keys.data && <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text"><span className="min-w-0 flex-1">Could not read the search keys: {keys.error}</span><button type="button" onClick={keys.reload} disabled={keys.busy} className={secondaryClass}>{keys.busy ? "Trying again…" : "Try again"}</button></div>}
    {!keys.data && !keys.error && <div role="status" aria-label="Reading the search keys" className="mt-4 grid gap-3 lg:grid-cols-2">{ENGINES.map((info) => <span key={info.engine} className="vso-skeleton block h-40 rounded-2xl" />)}</div>}
    {keys.data && <ul className="mt-4 grid gap-3 lg:grid-cols-2">{ENGINES.map((info) => <EngineRow key={info.engine} {...info} status={keys.data![info.engine]} onChange={(next) => keys.mutate(() => next)} />)}</ul>}
  </Panel>;
}

function EngineRow({ engine, name, purpose, site, host, status, onChange }: (typeof ENGINES)[number] & { status: SalesSearchKeyStatus; onChange: (next: SalesSearchKeys) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SalesSearchKeyTest | null>(null);
  const [error, setError] = useState("");
  const chip = chipOf(status);
  const saved = status.source === "app" || status.unreadable === true;
  const inputId = `search-key-${engine}`;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const valid = salesSearchKeyInputSchema.safeParse({ key: draft });
    if (!valid.success) { setError(valid.error.issues[0]?.message ?? "That doesn't look like a key."); return; }
    setBusy("save"); setError(""); setResult(null); setConfirming(false);
    try { onChange(await saveSearchKey(engine, valid.data.key)); setDraft(""); toast({ title: `${name} key saved`, body: "Search uses it from now on. Test it to check it works." }); }
    catch (cause) { setError(describeError(cause, "Could not save the key. Try again.")); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy("test"); setError(""); setResult(null);
    try { setResult(await testSearchKey(engine)); }
    catch (cause) { setError(describeError(cause, "Could not run the test. Try again.")); }
    finally { setBusy(null); }
  }
  async function remove() {
    if (!confirming) { setConfirming(true); return; }
    setBusy("remove"); setError(""); setResult(null);
    try { const next = await removeSearchKey(engine); onChange(next); setConfirming(false); toast({ title: `${name} key removed`, body: next[engine].source === "server" ? "The key set on the server is used again." : `Search with ${name} is off until a key is added.` }); }
    catch (cause) { setError(describeError(cause, "Could not remove the key. Try again.")); }
    finally { setBusy(null); }
  }

  return <li className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="text-sm font-bold text-neutral-900">{name}</h3><p className="mt-0.5 text-xs leading-5 text-neutral-500">{purpose}</p></div>
      <Badge tone={chip.tone}>{chip.text}</Badge>
    </div>
    <p className="mt-2 text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">{detailOf(status)}</p>
    <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold text-neutral-600">{saved ? `Replace the ${name} key` : `Paste a ${name} key`}</label>
        <input id={inputId} name={inputId} type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" maxLength={400} value={draft} onChange={(event) => { setDraft(event.target.value); if (error) setError(""); }} placeholder={status.source === "app" ? `••••${status.last4 ?? ""}` : "Key"} className={inputClass} />
      </div>
      <button disabled={busy !== null || !draft.trim()} className={clsx(primaryClass, "!min-h-11")}><ActionLabel busy={busy === "save"} idle="Save" /></button>
    </form>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={test} disabled={busy !== null || !status.set} className={secondaryClass}><ActionLabel busy={busy === "test"} busyText="Testing…" idle="Test" /></button>
      {saved && <button type="button" onClick={remove} disabled={busy !== null} className={clsx(secondaryClass, confirming && "!border-danger-text !text-danger-text")}><ActionLabel busy={busy === "remove"} busyText="Removing…" idle={confirming ? "Yes, remove it" : "Remove"} /></button>}
      {saved && confirming && busy === null && <button type="button" onClick={() => setConfirming(false)} className={secondaryClass}>Keep it</button>}
      <a href={site} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-lg px-1 text-xs font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Get a key at {host}<ArrowUpRight size={13} aria-hidden="true" /></a>
    </div>
    <div role="status" aria-live="polite">
      {result && <p className={clsx("mt-3 flex items-start gap-2 rounded-xl p-3 text-xs font-semibold leading-5", result.ok ? "bg-success-surface text-success-text" : "bg-danger-surface text-danger-text")}>{result.ok ? <Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> : <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />}<span className="min-w-0 [overflow-wrap:anywhere]">{result.ok ? `It works: ${name} answered a test search.` : result.message ?? "The test search failed."}</span></p>}
    </div>
    <Notice tone="error" message={error} onDismiss={() => setError("")} className="mt-3" />
  </li>;
}
