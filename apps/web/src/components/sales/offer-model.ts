import { useEffect, useMemo, useState } from "react";
import { offerIsUsable, type Offer, type OfferPacket, type OfferVersion } from "@venture-studio/contracts";
import { getCachedOffers } from "@/lib/sales-api";

// Pure helpers for offers (docs/sales-offers.md): the state chip, the packet's sections, what a proposal changes, and the venture's
// offers for lists that only need names.

export { offerIsUsable };
type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";

/** Active, Paused, Archived, or Draft while no version is approved yet. */
export function offerChip(offer: Pick<Offer, "state" | "approved">): { label: string; tone: Tone } {
  if (offer.state === "archived") return { label: "Archived", tone: "neutral" };
  if (!offer.approved) return { label: "Draft", tone: "amber" };
  if (offer.state === "paused") return { label: "Paused", tone: "neutral" };
  return { label: "Active", tone: "green" };
}

/** Active first, then drafts, paused and archived; by name within each. */
const ORDER = { Active: 0, Draft: 1, Paused: 2, Archived: 3 } as const;
export const sortOffers = (offers: readonly Offer[]) => [...offers].sort((a, b) => ORDER[offerChip(a).label as keyof typeof ORDER] - ORDER[offerChip(b).label as keyof typeof ORDER] || a.name.localeCompare(b.name));
/** Offers a lead, a play or a bulk move may name: not archived. */
export const openOffers = (offers: readonly Offer[]) => sortOffers(offers.filter((offer) => offer.state !== "archived"));

export const EMPTY_PACKET: OfferPacket = {
  summary: "",
  whoFor: { description: "", industries: [], customerTypes: [], places: [], companySizes: [], buyerRoles: [] },
  gates: [], signals: { lookFor: [], searchWords: [], negatives: [] }, exclusions: [],
  say: { valueProposition: "", pitchAngles: [], proofWords: "", approvedClaims: [], claimsToAvoid: [] },
  messages: "", price: "", scoring: "", notes: "",
};

export const SECTIONS = [
  { key: "whoFor", label: "Who it's for" },
  { key: "gates", label: "Gates" },
  { key: "signals", label: "Signals" },
  { key: "say", label: "What we say" },
  { key: "messages", label: "Messages" },
  { key: "price", label: "Price" },
  { key: "scoring", label: "Scoring" },
  { key: "notes", label: "Notes" },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];
export const SECTION_LABEL = Object.fromEntries(SECTIONS.map((section) => [section.key, section.label])) as Record<SectionKey, string>;

/** What one section holds (the exclusions read with the gates). */
export function sectionValue(packet: OfferPacket, key: SectionKey): unknown {
  if (key === "gates") return { gates: packet.gates, exclusions: packet.exclusions };
  return packet[key];
}
const filled = (value: unknown): boolean => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object" && Object.values(value).some(filled);
export const sectionIsEmpty = (packet: OfferPacket, key: SectionKey) => !filled(sectionValue(packet, key));

/** The sections a proposal changes compared with the approved packet, in reading order; `summary` and `name` count as the header. */
export function changedSections(before: { name: string; packet: OfferPacket }, after: { name: string; packet: OfferPacket }) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return {
    header: before.name !== after.name || before.packet.summary !== after.packet.summary,
    sections: SECTIONS.map((section) => section.key).filter((key) => !same(sectionValue(before.packet, key), sectionValue(after.packet, key))),
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** One short line per section for the editor's folded headers and the page's contents: "9 gates · 4 exclusions", "Not set". */
export function sectionSummary(packet: OfferPacket, key: SectionKey): string {
  const parts: string[] = [];
  if (key === "whoFor") {
    const who = packet.whoFor;
    if (who.industries.length) parts.push(plural(who.industries.length, "industry", "industries"));
    if (who.places.length) parts.push(plural(who.places.length, "place"));
    if (who.customerTypes.length) parts.push(plural(who.customerTypes.length, "customer type"));
    if (!parts.length && (who.description || who.companySizes.length || who.buyerRoles.length)) parts.push("Described");
  } else if (key === "gates") {
    if (packet.gates.length) parts.push(plural(packet.gates.length, "gate"));
    if (packet.exclusions.length) parts.push(plural(packet.exclusions.length, "exclusion"));
  } else if (key === "signals") {
    const signals = packet.signals;
    if (signals.lookFor.length) parts.push(plural(signals.lookFor.length, "phrase"));
    if (signals.searchWords.length) parts.push(plural(signals.searchWords.length, "search word"));
    if (signals.negatives.length) parts.push(plural(signals.negatives.length, "negative"));
  } else if (key === "say") {
    const say = packet.say;
    if (say.valueProposition) parts.push("Value proposition");
    if (say.pitchAngles.length) parts.push(plural(say.pitchAngles.length, "angle"));
    if (say.approvedClaims.length) parts.push(plural(say.approvedClaims.length, "claim"));
    if (!parts.length && (say.proofWords || say.claimsToAvoid.length)) parts.push("Set");
  } else {
    const text = packet[key].trim();
    if (text) parts.push(`${plural(text.split(/\s+/).length, "word")}`);
  }
  return parts.length ? parts.join(" · ") : "Not set";
}

/**
 * Plain text written with single line breaks keeps them when rendered as Markdown: a lone newline becomes a hard break, and a line that
 * starts with a "**Label:**" starts its own paragraph (the reader shows those as label rows). Blank lines, lists and headings are
 * untouched (a hard break at the end of a block is ignored).
 */
export const softBreaks = (text: string) => text
  .replace(/([^\n])\n(?=\*\*[^*\n]{1,56}?(?::\*\*|\*\*\s*:))/g, "$1\n\n")
  .replace(/([^\n])\n(?!\n)/g, "$1  \n");

/** The proposal people mean by "the newest": the last one changed. */
export const newestFirst = (versions: readonly OfferVersion[]) => [...versions].sort((a, b) => b.version - a.version || b.updatedAt.localeCompare(a.updatedAt));

/**
 * The venture's offers (null while loading or without a venture). They are read through the one-minute cache in lib/sales-api, and a
 * failure reads as no offers, so screens that only show names keep working on an API without offers.
 */
export function useVentureOffers(ventureId: string | undefined, refreshKey = 0): Offer[] | null {
  const key = ventureId ?? "";
  const [state, setState] = useState<{ key: string; offers: Offer[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let active = true;
    getCachedOffers(key).then((offers) => { if (active) setState({ key, offers }); }).catch(() => { if (active) setState({ key, offers: [] }); });
    return () => { active = false; };
  }, [key, refreshKey]);
  return key && state?.key === key ? state.offers : null;
}

/** Offers of several ventures by id (for lists that span ventures, such as find runs in All ventures). */
export function useOffersById(ventureIds: readonly string[], refreshKey = 0): Record<string, Offer> {
  const key = [...new Set(ventureIds.filter(Boolean))].sort().join(",");
  const [state, setState] = useState<{ key: string; byId: Record<string, Offer> }>({ key: "", byId: {} });
  useEffect(() => {
    if (!key) return;
    let active = true;
    void Promise.all(key.split(",").map((ventureId) => getCachedOffers(ventureId).catch(() => [] as Offer[]))).then((lists) => {
      if (active) setState({ key, byId: Object.fromEntries(lists.flat().map((offer) => [offer.id, offer])) });
    });
    return () => { active = false; };
  }, [key, refreshKey]);
  return useMemo(() => state.key === key ? state.byId : {}, [state, key]);
}

/** The offers page for one offer (or the list with `offerId` left out). */
export const offerHref = (ventureId: string, offerId?: string, versionId?: string) => {
  const params = new URLSearchParams({ venture: ventureId });
  if (offerId) params.set("offer", offerId);
  if (versionId) params.set("version", versionId);
  return `/sales/live/brain?${params}`;
};
