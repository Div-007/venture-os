"use client";
import clsx from "clsx";
import type { OfferGate, OfferPacket } from "@venture-studio/contracts";
import { Badge } from "@/components/studio/primitives";
import { BrainMarkdown } from "./brain-markdown";
import { kickerClass } from "./draft-shared";
import { changedSections, SECTION_LABEL, SECTIONS, sectionIsEmpty, softBreaks, type SectionKey } from "./offer-model";

// The packet as calm, readable sections: label-value rows like a knowledge item, chips for short lists, a compact table for the gates.
// In a comparison each side marks what only it has: added on the proposal's side, removed on the approved side.

type Mark = "added" | "removed";
/** The packet on the other side of a comparison, and how this side marks what the other lacks. */
export type PacketDiff = { other: OfferPacket; mark: Mark } | undefined;

const row = "grid gap-x-4 gap-y-1 border-b border-neutral-100 py-2.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[9.5rem_minmax(0,1fr)]";
const labelClass = "text-[12.5px] font-semibold leading-6 text-neutral-500";
const sectionLabel = "text-[11px] font-bold uppercase tracking-[.08em] text-neutral-500";
const MARK_CLASS: Record<Mark, string> = { added: "bg-success-surface text-success-text", removed: "bg-danger-surface text-danger-text line-through decoration-1" };
const NotSet = () => <p className="text-sm text-neutral-400">Not set.</p>;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const lacks = (others: readonly string[] | undefined, item: string) => !!others && !others.some((other) => same(other, item));

/** Words and short phrases as chips; sentences (`list`) as a bulleted list. With a comparison, items the other side lacks are marked. */
function Items({ items, others, mark, list = false }: { items: readonly string[]; others?: readonly string[] | undefined; mark?: Mark | undefined; list?: boolean }) {
  if (!items.length) return <span className="text-sm text-neutral-400">None</span>;
  if (!list) return <ul className="flex flex-wrap gap-1.5">{items.map((item) => <li key={item} className={clsx("inline-flex max-w-full rounded-lg px-2.5 py-1 text-[13px] font-medium leading-5 [overflow-wrap:anywhere]", mark && lacks(others, item) ? MARK_CLASS[mark] : "bg-neutral-100 text-neutral-700")}>{item}</li>)}</ul>;
  return <ul className="list-disc space-y-1 pl-5 text-[14px] leading-6 text-neutral-700 marker:text-neutral-300">{items.map((item) => <li key={item} className="[overflow-wrap:anywhere]"><span className={clsx(mark && lacks(others, item) && clsx("rounded px-1", MARK_CLASS[mark]))}>{item}</span></li>)}</ul>;
}

/** Label-value rows; rows whose value is empty are left out, and a section with none says "Not set". */
function Rows({ rows }: { rows: { label: string; show: boolean; changed?: boolean; value: React.ReactNode }[] }) {
  const shown = rows.filter((entry) => entry.show);
  if (!shown.length) return <NotSet />;
  return <div>{shown.map((entry) => <div key={entry.label} className={row}>
    <div className={labelClass}>{entry.label}{entry.changed && <span className="ml-1.5 align-middle"><Badge tone="amber">Changed</Badge></span>}</div>
    <div className="min-w-0 text-[14px] leading-6 text-neutral-800 [overflow-wrap:anywhere]">{entry.value}</div>
  </div>)}</div>;
}

const Text = ({ text }: { text: string }) => <BrainMarkdown markdown={softBreaks(text)} />;
const gateKey = (gate: OfferGate) => JSON.stringify([gate.code.trim().toLowerCase(), gate.rule.trim(), gate.ifFails, gate.note.trim()]);

export function FailChip({ ifFails }: { ifFails: OfferGate["ifFails"] }) {
  return <Badge tone={ifFails === "reject" ? "red" : "amber"}>{ifFails === "reject" ? "Reject" : "Hold"}</Badge>;
}

/** The gates as a compact table on wider screens and as small cards on phones. */
function Gates({ gates, diff }: { gates: OfferGate[]; diff: PacketDiff }) {
  // In a comparison each side is half as wide, so the cards read better than the table there.
  const table = !diff;
  const otherKeys = diff ? new Set(diff.other.gates.map(gateKey)) : null;
  const markOf = (gate: OfferGate) => diff && otherKeys && !otherKeys.has(gateKey(gate)) ? diff.mark : undefined;
  const rowTone = (mark?: Mark) => mark === "added" ? "bg-success-surface/60" : mark === "removed" ? "bg-danger-surface/60" : "";
  return <>
    {table && <div className="hidden overflow-hidden rounded-xl border border-neutral-100 md:block">
      <table className="w-full table-fixed border-collapse text-left text-[13px]">
        <colgroup><col className="w-20" /><col /><col className="w-28" /><col className="w-[32%]" /></colgroup>
        <thead><tr className="bg-neutral-50 text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-500"><th scope="col" className="px-3 py-2 font-semibold">Code</th><th scope="col" className="px-3 py-2 font-semibold">Rule</th><th scope="col" className="px-3 py-2 font-semibold">If it fails</th><th scope="col" className="px-3 py-2 font-semibold">Note</th></tr></thead>
        <tbody>{gates.map((gate, index) => {
          const mark = markOf(gate);
          return <tr key={`${gate.code}-${index}`} className={clsx("border-t border-neutral-100 align-top", rowTone(mark))}>
            <td className="px-3 py-2.5 font-mono text-[12.5px] font-semibold text-neutral-800 [overflow-wrap:anywhere]">{gate.code}</td>
            <td className={clsx("px-3 py-2.5 leading-5 text-neutral-800 [overflow-wrap:anywhere]", mark === "removed" && "line-through decoration-1")}>{gate.rule}</td>
            <td className="px-3 py-2.5"><FailChip ifFails={gate.ifFails} /></td>
            <td className="px-3 py-2.5 leading-5 text-neutral-500 [overflow-wrap:anywhere]">{gate.note || "—"}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <ul className={clsx("grid gap-2", table && "md:hidden")}>{gates.map((gate, index) => {
      const mark = markOf(gate);
      return <li key={`${gate.code}-${index}`} className={clsx("rounded-xl border border-neutral-100 p-3", rowTone(mark))}>
        <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] font-bold text-neutral-800">{gate.code}</span><FailChip ifFails={gate.ifFails} />{mark && <span className="ml-auto text-[11px] font-semibold text-neutral-500">{mark === "added" ? "New" : "Removed"}</span>}</div>
        <p className={clsx("mt-1.5 text-[14px] leading-6 text-neutral-800 [overflow-wrap:anywhere]", mark === "removed" && "line-through decoration-1")}>{gate.rule}</p>
        {gate.note && <p className="mt-1 text-xs leading-5 text-neutral-500 [overflow-wrap:anywhere]">{gate.note}</p>}
      </li>;
    })}</ul>
  </>;
}

/** One section's content (no heading). */
export function PacketSection({ packet, section, diff }: { packet: OfferPacket; section: SectionKey; diff?: PacketDiff }) {
  const other = diff?.other;
  const mark = diff?.mark;
  const textChanged = (mine: string, theirs: string | undefined) => theirs !== undefined && mark === "added" && mine.trim() !== theirs.trim();
  if (sectionIsEmpty(packet, section)) return <NotSet />;
  switch (section) {
    case "whoFor": {
      const who = packet.whoFor;
      const them = other?.whoFor;
      const lists = [
          { label: "Industries", show: who.industries.length > 0, value: <Items items={who.industries} others={them?.industries} mark={mark} /> },
          { label: "Customer types", show: who.customerTypes.length > 0, value: <Items items={who.customerTypes} others={them?.customerTypes} mark={mark} /> },
          { label: "Places", show: who.places.length > 0, value: <Items items={who.places} others={them?.places} mark={mark} /> },
          { label: "Company sizes", show: who.companySizes.length > 0, value: <Items items={who.companySizes} others={them?.companySizes} mark={mark} /> },
          { label: "Buyer roles", show: who.buyerRoles.length > 0, value: <Items items={who.buyerRoles} others={them?.buyerRoles} mark={mark} /> },
      ];
      return <div className="space-y-4">
        {who.description && <div className={clsx(textChanged(who.description, them?.description) && "-mx-3 rounded-xl bg-warning-surface/40 px-3 py-2")}><Text text={who.description} /></div>}
        {lists.some((entry) => entry.show) && <Rows rows={lists} />}
      </div>;
    }
    case "gates":
      return <div className="space-y-4">
        {packet.gates.length > 0 ? <>{!diff && <p className="text-xs leading-5 text-neutral-500">A lead must pass every gate. A failed Reject gate rejects it; a failed Hold gate holds it with a question for a person.</p>}<Gates gates={packet.gates} diff={diff} /></> : <p className="text-sm text-neutral-400">No gates set.</p>}
        {packet.exclusions.length > 0 && <div><p className={clsx(labelClass, "mb-1")}>Also not a fit</p><Items list items={packet.exclusions} others={other?.exclusions} mark={mark} /></div>}
      </div>;
    case "signals": {
      const signals = packet.signals;
      const theirPhrases = other?.signals.lookFor.map((entry) => entry.phrase);
      return <Rows rows={[
        {
          label: "Look for", show: signals.lookFor.length > 0, value: <ul className="space-y-1.5">{signals.lookFor.map((entry) => <li key={entry.phrase} className={clsx("leading-6", mark && lacks(theirPhrases, entry.phrase) && clsx("-mx-1.5 rounded-lg px-1.5", MARK_CLASS[mark]))}>
            <span className="font-semibold text-neutral-900">&ldquo;{entry.phrase}&rdquo;</span><span className="text-neutral-400"> — </span><span className="text-neutral-600">{entry.meaning}</span>
          </li>)}</ul>,
        },
        { label: "Search words", show: signals.searchWords.length > 0, value: <Items items={signals.searchWords} others={other?.signals.searchWords} mark={mark} /> },
        { label: "Rule a result out", show: signals.negatives.length > 0, value: <Items items={signals.negatives} others={other?.signals.negatives} mark={mark} /> },
      ]} />;
    }
    case "say": {
      const say = packet.say;
      const them = other?.say;
      return <Rows rows={[
        { label: "Value proposition", show: !!say.valueProposition, changed: textChanged(say.valueProposition, them?.valueProposition), value: <Text text={say.valueProposition} /> },
        { label: "Pitch angles", show: say.pitchAngles.length > 0, value: <Items list items={say.pitchAngles} others={them?.pitchAngles} mark={mark} /> },
        { label: "Proof words", show: !!say.proofWords, changed: textChanged(say.proofWords, them?.proofWords), value: <Text text={say.proofWords} /> },
        { label: "Approved claims", show: say.approvedClaims.length > 0, value: <Items list items={say.approvedClaims} others={them?.approvedClaims} mark={mark} /> },
        { label: "Claims to avoid", show: say.claimsToAvoid.length > 0, value: <Items list items={say.claimsToAvoid} others={them?.claimsToAvoid} mark={mark} /> },
      ]} />;
    }
    default:
      return <Text text={packet[section]} />;
  }
}

export const sectionAnchor = (key: SectionKey) => `offer-section-${key}`;

/** The whole packet, section by section; each section is an anchor for the page's contents list. */
export function OfferPacketView({ packet }: { packet: OfferPacket }) {
  return <div className="space-y-0">{SECTIONS.map((section, index) => <section key={section.key} id={sectionAnchor(section.key)} aria-labelledby={`${sectionAnchor(section.key)}-title`} className={clsx("scroll-mt-4", index > 0 && "mt-6 border-t border-neutral-100 pt-5")}>
    <h3 id={`${sectionAnchor(section.key)}-title`} className={clsx(sectionLabel, "mb-3")}>{section.label}</h3>
    <div className="max-w-[80ch]"><PacketSection packet={packet} section={section.key} /></div>
  </section>)}</div>;
}

type Side = { version: number; name: string; packet: OfferPacket };

/** A proposal next to the approved packet: which sections changed, then only those, side by side (stacked on phones). */
export function OfferCompare({ approved, proposal }: { approved: Side; proposal: Side }) {
  const { header, sections } = changedSections(approved, proposal);
  const unchanged = SECTIONS.filter((section) => !sections.includes(section.key)).map((section) => section.label);
  const columns = (left: React.ReactNode, right: React.ReactNode) => <div className="grid gap-3 lg:grid-cols-2 lg:gap-5">
    <div className="min-w-0 space-y-2 rounded-2xl border border-neutral-100 p-4"><p className={kickerClass}>Approved now · version {approved.version}</p>{left}</div>
    <div className="min-w-0 space-y-2 rounded-2xl bg-warning-surface/40 p-4"><p className="text-[11px] font-bold uppercase tracking-[.06em] text-warning-text">Proposed · version {proposal.version}</p>{right}</div>
  </div>;
  return <div className="space-y-6">
    {header || sections.length
      ? <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500"><span className="font-semibold text-neutral-700">Changed:</span>{header && <Badge tone="amber">Name or summary</Badge>}{sections.map((key) => <Badge key={key} tone="amber">{SECTION_LABEL[key]}</Badge>)}</div>
      : <p className="text-sm text-neutral-500">This proposal is the same as the approved packet.</p>}
    {header && <section className="space-y-3"><h3 className={sectionLabel}>Name and summary</h3>{columns(
      <div className="space-y-1"><p className="text-[15px] font-bold text-neutral-900 [overflow-wrap:anywhere]">{approved.name}</p><p className="text-[14px] leading-6 text-neutral-700 [overflow-wrap:anywhere]">{approved.packet.summary}</p></div>,
      <div className="space-y-1"><p className="text-[15px] font-bold text-neutral-900 [overflow-wrap:anywhere]">{proposal.name}</p><p className="text-[14px] leading-6 text-neutral-700 [overflow-wrap:anywhere]">{proposal.packet.summary}</p></div>,
    )}</section>}
    {sections.map((key) => <section key={key} className="space-y-3"><h3 className={sectionLabel}>{SECTION_LABEL[key]}</h3>{columns(
      <PacketSection packet={approved.packet} section={key} diff={{ other: proposal.packet, mark: "removed" }} />,
      <PacketSection packet={proposal.packet} section={key} diff={{ other: approved.packet, mark: "added" }} />,
    )}</section>)}
    {unchanged.length > 0 && (header || sections.length > 0) && <p className="border-t border-neutral-100 pt-4 text-xs leading-5 text-neutral-500"><b className="font-semibold text-neutral-700">Unchanged:</b> {unchanged.join(", ")}.</p>}
  </div>;
}
