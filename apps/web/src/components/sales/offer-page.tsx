"use client";
import { useState } from "react";
import clsx from "clsx";
import type { Offer, OfferVersion } from "@venture-studio/contracts";
import { Archive, ArrowRight, Check, ChevronDown, Edit, Pause, Play, Plus, Sparkles } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, Notice, Panel, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { approveOfferVersion, discardOfferVersion, setOfferState, type OfferDetail } from "@/lib/sales-api";
import { Trash } from "./draft-icons";
import { canHead, canWriteIn, kickerClass } from "./draft-shared";
import type { OfferEditorTarget } from "./offer-editor";
import { newestFirst, offerChip, SECTIONS, sectionSummary } from "./offer-model";
import { OfferCompare, OfferPacketView, sectionAnchor } from "./offer-packet";
import { useSalesShell } from "./sales-context";
import { number, plural } from "./sales-ui";

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const day = (value?: string) => value ? dayFormat.format(new Date(value)) : "";
const chipButton = "inline-flex min-h-9 items-center gap-1 rounded-lg bg-[var(--color-neutral-0)] px-2.5 text-xs font-semibold text-neutral-800 transition-[filter] duration-150 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";
const dangerButton = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger active:scale-[0.97] disabled:opacity-50";

type Viewing = { version: OfferVersion; kind: "approved" | "proposal" | "history" } | null;

/** Which version the page shows: the one in the link if it still exists, else the approved one, else the newest proposal. */
export function viewingOf(offer: Offer, history: readonly OfferVersion[], versionId: string): Viewing {
  if (versionId) {
    if (offer.approved?.id === versionId) return { version: offer.approved, kind: "approved" };
    const proposal = offer.proposals.find((item) => item.id === versionId);
    if (proposal) return { version: proposal, kind: "proposal" };
    const old = history.find((item) => item.id === versionId);
    if (old) return { version: old, kind: "history" };
  }
  if (offer.approved) return { version: offer.approved, kind: "approved" };
  const newest = newestFirst(offer.proposals)[0];
  return newest ? { version: newest, kind: "proposal" } : null;
}

/**
 * One offer: its name, state and approved version, the proposals waiting, and the packet as readable sections. A proposal opens on the
 * same page (`?version=`), where a venture head approves it as a whole, after comparing it with the approved packet if they like.
 */
export function OfferPage({ ventureId, offer, detail, versionId, onVersion, onEditor, onChanged }: {
  ventureId: string; offer: Offer; detail: OfferDetail | null; versionId: string;
  onVersion: (versionId: string) => void; onEditor: (target: OfferEditorTarget) => void; onChanged: () => void;
}) {
  const { session, personName } = useSalesShell();
  const [compare, setCompare] = useState(false);
  const [confirm, setConfirm] = useState<"" | "discard" | "archive">("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const head = canHead(session, ventureId);
  const canWrite = canWriteIn(session, ventureId);
  const history = newestFirst(detail?.history ?? []);
  const viewing = viewingOf(offer, history, versionId);
  const version = viewing?.version;
  const chip = offerChip(offer);
  const approved = offer.approved;
  const proposals = newestFirst(offer.proposals);
  const manages = (item: OfferVersion) => head || (canWrite && !!session && item.proposedBy === session.user.id);
  const who = (item: OfferVersion) => item.via === "claude" ? `Claude, for ${personName(item.proposedBy)}` : personName(item.proposedBy);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setError("");
    try { await action(); setConfirm(""); onChanged(); }
    catch (cause) { setError(describeError(cause, "That did not work. Try again.")); }
    finally { setBusy(""); }
  }
  const approve = (item: OfferVersion) => run("approve", async () => {
    await approveOfferVersion(item.id);
    toast({ title: "Approved", body: `${item.name}, version ${item.version}. Claude uses it from now on${approved ? `; version ${approved.version} is kept in the history` : ""}.` });
    setCompare(false); onVersion("");
  });
  const discard = (item: OfferVersion) => run("discard", async () => {
    await discardOfferVersion(item.id);
    toast({ title: "Proposal discarded", body: `${item.name}, version ${item.version}` });
    setCompare(false); onVersion("");
  });
  const changeState = (state: Offer["state"]) => run(state, async () => {
    await setOfferState(offer.id, { state });
    const said = { active: ["Offer active", "New leads, verdicts and find runs can use it."], paused: ["Offer paused", "New leads and find runs can't use it until it is active again. Its leads keep it."], archived: ["Offer archived", "It is kept for its leads and history; nothing new can use it."] }[state];
    toast({ title: said[0]!, body: `${offer.name}. ${said[1]}` });
  });

  const meta = <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-neutral-500">
    <Badge tone={chip.tone}>{chip.label}</Badge>
    {approved
      ? <span>Version {approved.version}, approved{approved.approvedBy ? ` by ${personName(approved.approvedBy)}` : ""}{approved.approvedAt ? ` on ${day(approved.approvedAt)}` : ""}</span>
      : <span>No version approved yet, so Claude does not use it</span>}
    <span aria-hidden="true" className="text-neutral-300 max-sm:hidden">·</span>
    <span className="tnum">{plural(offer.counts.leads, "lead")}, {number(offer.counts.open)} open{offer.counts.plays ? ` · ${plural(offer.counts.plays, "play")}` : ""}</span>
  </div>;

  // The buttons that fit what is on screen: the approved packet (propose, state) or a proposal (approve, compare, edit, discard).
  let actions: React.ReactNode = null;
  if (viewing?.kind === "proposal" && version) {
    actions = <>
      {head && offer.state !== "archived" && <button type="button" onClick={() => void approve(version)} disabled={busy !== ""} className={primaryClass}><ActionLabel busy={busy === "approve"} busyText="Approving…" idle={<><Check size={16} />Approve version {version.version}</>} /></button>}
      {approved && <button type="button" aria-pressed={compare} onClick={() => setCompare(!compare)} className={secondaryClass}>{compare ? "Hide the comparison" : "Compare with approved"}</button>}
      {manages(version) && <button type="button" onClick={() => onEditor({ mode: "edit", offer, version })} className={secondaryClass}><Edit size={16} />Edit</button>}
      {manages(version) && <button type="button" aria-expanded={confirm === "discard"} onClick={() => setConfirm(confirm === "discard" ? "" : "discard")} className={clsx(secondaryClass, "!text-danger-text")}><Trash size={16} />Discard</button>}
      {!head && <span className="text-xs text-neutral-500">A venture head approves it.</span>}
      {head && offer.state === "archived" && <><button type="button" onClick={() => void changeState("active")} disabled={busy !== ""} className={secondaryClass}><ActionLabel busy={busy === "active"} busyText="Saving…" idle={<><Play size={16} />Activate</>} /></button><span className="text-xs text-neutral-500">The offer is archived: activate it before approving a version.</span></>}
    </>;
  } else if (viewing?.kind !== "history") {
    actions = <>
      {canWrite && approved && <button type="button" onClick={() => onEditor({ mode: "propose", offer, from: approved })} className={proposals.length ? secondaryClass : primaryClass}><Plus size={16} />Propose a change</button>}
      {head && approved && offer.state === "active" && <button type="button" onClick={() => void changeState("paused")} disabled={busy !== ""} className={secondaryClass}><ActionLabel busy={busy === "paused"} busyText="Pausing…" idle={<><Pause size={16} />Pause</>} /></button>}
      {head && offer.state !== "active" && <button type="button" onClick={() => void changeState("active")} disabled={busy !== ""} className={secondaryClass}><ActionLabel busy={busy === "active"} busyText="Saving…" idle={<><Play size={16} />Activate</>} /></button>}
      {head && offer.state !== "archived" && <button type="button" aria-expanded={confirm === "archive"} onClick={() => setConfirm(confirm === "archive" ? "" : "archive")} className={clsx(secondaryClass, "!text-danger-text")}><Archive size={16} />Archive</button>}
    </>;
  }

  return <article className="vso-fade-enter min-w-0 space-y-4">
    <Panel className="overflow-hidden">
      <header className="space-y-3 px-4 py-4 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <p className={kickerClass}>Offer</p>
          <h2 className="mt-0.5 text-[clamp(1.25rem,2.4vw,1.5rem)] font-extrabold leading-tight tracking-[-.02em] text-neutral-900 [overflow-wrap:anywhere]">{offer.name}</h2>
        </div>
        {meta}
        {version?.packet.summary && <p className="max-w-[72ch] text-[15px] leading-6 text-neutral-700 [overflow-wrap:anywhere]">{version.packet.summary}</p>}

        {viewing?.kind === "proposal" && version && <div className="space-y-1.5 rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs leading-5 text-warning-text">
          <p><b className="font-semibold">Version {version.version} is a proposal</b> by {who(version)}, {day(version.createdAt)}. {approved ? `Claude keeps using version ${approved.version} until it is approved.` : "Nothing is approved yet, so Claude does not use this offer."}</p>
          {version.change.trim() && <p className="[overflow-wrap:anywhere]"><b className="font-semibold">What changed:</b> {version.change}</p>}
          {approved && <button type="button" onClick={() => { setCompare(false); onVersion(""); }} className={clsx(chipButton, "mt-1")}>Back to version {approved.version}</button>}
        </div>}
        {viewing?.kind === "history" && version && <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-neutral-50 px-3.5 py-2.5 text-xs leading-5 text-neutral-600">
          <p className="min-w-0 flex-1">An earlier version, kept for the record. Version {version.version}{version.approvedBy ? `, approved by ${personName(version.approvedBy)}` : ""}{version.approvedAt ? ` on ${day(version.approvedAt)}` : ""}.</p>
          <button type="button" onClick={() => onVersion("")} className={chipButton}>Back to the current version</button>
        </div>}
        {viewing?.kind === "approved" && proposals.length > 0 && <div className="space-y-2 rounded-xl bg-warning-surface px-3.5 py-3 text-xs leading-5 text-warning-text">
          <p className="font-semibold">{proposals.length === 1 ? "1 change is waiting for approval" : `${proposals.length} changes are waiting for approval`}</p>
          <ul className="space-y-1.5">{proposals.map((item) => <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><b className="font-semibold">Version {item.version}</b> · {who(item)} · {day(item.createdAt)}{item.change.trim() ? <span className="opacity-90">: {item.change}</span> : null}</span>
            <button type="button" onClick={() => onVersion(item.id)} className={chipButton}>{head ? "Review" : "Read"}<ArrowRight size={12} aria-hidden="true" /></button>
          </li>)}</ul>
        </div>}

        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        {confirm === "discard" && version && <div role="alertdialog" aria-label="Confirm discard" className="vso-fade-enter space-y-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3.5">
          <p className="text-sm font-bold text-neutral-900">Discard version {version.version}?</p>
          <p className="text-xs leading-5 text-neutral-500">{approved ? `Version ${approved.version} stays as it is.` : "The offer stays a draft with nothing approved."} Claude or a teammate can propose it again.</p>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void discard(version)} disabled={busy !== ""} className={dangerButton}><ActionLabel busy={busy === "discard"} busyText="Discarding…" idle="Yes, discard it" /></button><button type="button" onClick={() => setConfirm("")} className={secondaryClass}>Keep it</button></div>
        </div>}
        {confirm === "archive" && <div role="alertdialog" aria-label="Confirm archive" className="vso-fade-enter space-y-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3.5">
          <p className="text-sm font-bold text-neutral-900">Archive {offer.name}?</p>
          <p className="text-xs leading-5 text-neutral-500">New leads, verdicts, plays and find runs can no longer use it. Its {plural(offer.counts.leads, "lead")} keep it, and you can activate it again later.</p>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void changeState("archived")} disabled={busy !== ""} className={dangerButton}><ActionLabel busy={busy === "archived"} busyText="Archiving…" idle="Yes, archive it" /></button><button type="button" onClick={() => setConfirm("")} className={secondaryClass}>Keep it</button></div>
        </div>}
      </header>
    </Panel>

    {!version
      ? <Panel className="p-6"><div className="mx-auto max-w-md space-y-3 text-center"><Sparkles size={20} className="mx-auto text-ai" aria-hidden="true" /><p className="text-sm font-bold text-neutral-900">No packet yet</p><p className="text-xs leading-5 text-neutral-500">Tell Claude about the offer and it proposes the packet, or write it yourself.</p>{canWrite && <button type="button" onClick={() => onEditor({ mode: "propose", offer })} className={clsx(secondaryClass, "mx-auto")}><Plus size={15} />Write the packet</button>}</div></Panel>
      : compare && viewing?.kind === "proposal" && approved
        ? <Panel className="p-4 sm:p-6"><OfferCompare approved={approved} proposal={version} /></Panel>
        : <div className="grid items-start gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
          <nav aria-label="Sections of the offer" className="hidden lg:sticky lg:top-4 lg:block">
            <ul className="space-y-0.5">{SECTIONS.map((section) => {
              const summary = sectionSummary(version.packet, section.key);
              return <li key={section.key}><button type="button" onClick={() => document.getElementById(sectionAnchor(section.key))?.scrollIntoView({ behavior: "smooth", block: "start" })} className="block w-full rounded-lg px-3 py-1.5 text-left transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                <span className="block text-[13px] font-semibold text-neutral-800">{section.label}</span>
                <span className={clsx("block truncate text-[11px]", summary === "Not set" ? "text-neutral-400" : "text-neutral-500")}>{summary}</span>
              </button></li>;
            })}</ul>
          </nav>
          <Panel className="min-w-0 p-4 sm:p-6"><OfferPacketView packet={version.packet} /></Panel>
        </div>}

    {history.length > 0 && <Panel className="overflow-hidden">
      <h3><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)} className="flex min-h-12 w-full items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 sm:px-6">
        <span className="min-w-0 flex-1 text-sm font-bold text-neutral-900">Earlier versions</span><span className="text-xs text-neutral-500 tnum">{history.length}</span>
        <ChevronDown size={16} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", historyOpen && "rotate-180")} />
      </button></h3>
      {historyOpen && <ul className="vso-fade-enter divide-y divide-neutral-100 border-t border-neutral-100">{history.map((item) => <li key={item.id}><button type="button" aria-current={version?.id === item.id ? "true" : undefined} onClick={() => onVersion(item.id)} className={clsx("block min-h-12 w-full px-4 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600 sm:px-6", version?.id === item.id ? "bg-primary-50" : "hover:bg-neutral-50")}>
        <span className="block text-[13px] font-semibold text-neutral-800">Version {item.version}{item.approvedAt ? `, approved ${day(item.approvedAt)}` : ", never approved"}</span>
        <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{item.change.trim() || `Proposed by ${who(item)}`}</span>
      </button></li>)}</ul>}
    </Panel>}
  </article>;
}
