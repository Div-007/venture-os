// The built-in lead finder's searches: the queries a run's plan asks for (with its offer packet's industries, places and search words
// where the plan names none), and the company sites TinyFish and Exa return for them. Every search call is counted against the
// workspace's allowance first (reserveSearch); hits are merged by domain, directories are dropped, and hits that name one of the
// offer's negatives are ruled out before any page is read.
import type { OfferPacket } from "@venture-studio/contracts";
import type { AppDb } from "../../db.js";
import { reserveSearch, searchExa, searchTinyfish, hostOf, type SearchEngine, type SearchHit, type SearchKeys } from "../search-engines.js";
import { anyPhrase, isNotCompanyHost } from "./extract.js";

export const MAX_QUERIES = 40;
/** Business words joined to each category and place, most specific first: a dealer enquiry says the most about who sells through dealers. */
export const BUSINESS_WORDS = ["dealer enquiry", "manufacturer", "distributor"] as const;
/** How many of the packet's industries and places stand in for a plan that names none: 5 x 5 pairs, so every pair's first word fits in the 40. */
export const PACKET_DEFAULTS = 5;
/** After this many failed calls in a run an engine is left alone for the rest of the run (a key that was refused stops it at once). */
const ENGINE_FAILURES = 3;

type PlanLike = { places?: readonly string[]; categories?: readonly string[]; searches?: readonly string[]; limit?: number };
/** What the planner reads from a run's offer packet (sales-offers.ts). */
export type PacketLike = { whoFor: Pick<OfferPacket["whoFor"], "industries" | "places">; signals: Pick<OfferPacket["signals"], "searchWords"> };
const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
const tidyAll = (values: readonly string[] | undefined) => (values ?? []).map(tidy).filter(Boolean);
/** What the person typed in the plan, else the packet's first few. */
const typedOr = (typed: readonly string[] | undefined, packet: readonly string[] | undefined) => { const own = tidyAll(typed); return own.length ? own : tidyAll(packet).slice(0, PACKET_DEFAULTS); };
const placesOf = (run: { plan?: PlanLike | null }, packet?: PacketLike | null) => typedOr(run.plan?.places, packet?.whoFor.places);

/**
 * The run's searches. The plan's own searches as given; else every category with every place and each business word (all pairs' first
 * word before any pair's second, so the cap keeps the most specific), 40 in all; with no plan, the request itself. With the run's offer
 * packet, a plan with no categories or places takes the packet's first industries and places, and the business words are the packet's
 * search words (the built-in ones when it has none). What the person typed always wins. Pure: the caller loads the packet.
 */
export function buildQueries(run: { request: string; plan?: PlanLike | null }, packet?: PacketLike | null): string[] {
  const plan = run.plan ?? {};
  const unique = (queries: string[]) => { const seen = new Set<string>(); return queries.map((query) => tidy(query).slice(0, 300)).filter((query) => query && !seen.has(query.toLowerCase()) && seen.add(query.toLowerCase())); };
  if (plan.searches?.length) return unique([...plan.searches]).slice(0, 50);
  const categories = typedOr(plan.categories, packet?.whoFor.industries);
  const places = placesOf(run, packet);
  if (!categories.length && !places.length) return unique([run.request]);
  const ownWords = tidyAll(packet?.signals.searchWords);
  const words = ownWords.length ? ownWords : BUSINESS_WORDS;
  // Places with no categories: what the request asks for, in each place.
  const kinds = categories.length ? categories : [tidy(run.request).split(/(?<=[.!?])\s/)[0]!.slice(0, 120)];
  const queries: string[] = [];
  for (const word of categories.length ? words : [""]) for (const kind of kinds) for (const place of places.length ? places : [""]) queries.push(`${kind} ${word} ${place}`);
  return unique(queries).slice(0, MAX_QUERIES);
}

const COUNTRY_HINTS: [string, RegExp][] = [["US", /\b(usa|u\.s\.a?\.?|united states|america|new york|california|texas|florida)\b/i], ["GB", /\b(uk|u\.k\.|united kingdom|england|london|scotland|manchester)\b/i], ["CA", /\b(canada|toronto|vancouver)\b/i], ["AU", /\b(australia|sydney|melbourne)\b/i]];
/** The country to favour: India unless the run's places (the plan's, else its offer packet's; without places, the request) clearly name another. */
export function countryOf(run: { request: string; plan?: PlanLike | null }, packet?: PacketLike | null): string {
  const places = placesOf(run, packet);
  const text = places.length ? places.join(" ") : run.request;
  return COUNTRY_HINTS.find(([, pattern]) => pattern.test(text))?.[0] ?? "IN";
}

/** The offer's negatives as one pattern a search result's title or snippet is checked against (offerPacket.signals.negatives). */
export const negativesOf = (packet?: { signals: Pick<OfferPacket["signals"], "negatives"> } | null) => anyPhrase(packet?.signals.negatives ?? []);

/** One search call: injectable, so tests never reach the network. */
export type SearchFn = (engine: SearchEngine, key: string, query: string, country: string) => Promise<SearchHit[]>;
export const liveSearch: SearchFn = (engine, key, query, country) => engine === "tinyfish" ? searchTinyfish(key, query, country, 1) : searchExa(key, query, country, 10);

/** A company site to read: its domain, the page the search found and what the search said about it. */
export type Candidate = { domain: string; url: string; title: string; snippet: string; engines: SearchEngine[] };
export type SearchStats = { calls: number; answered: number; capped: Set<SearchEngine>; failures: Map<SearchEngine, number>; errors: Map<SearchEngine, string> };
export const searchStats = (): SearchStats => ({ calls: 0, answered: 0, capped: new Set(), failures: new Map(), errors: new Map() });

/**
 * The queries in order, each with the company sites it found that the run has not seen yet. TinyFish (free) goes first; Exa (paid, a
 * monthly allowance) is asked only when there is no TinyFish key, TinyFish failed or is used up, or TinyFish found nothing new to read.
 * A site whose search result (title or snippet) names one of the offer's `negatives` is ruled out for the run before any page is read,
 * and handed back in `ruledOut` so the run can count it. It ends early when every engine is used up or failing; `stats` says why.
 */
export async function* searchSites(input: { db: AppDb; workspaceId: string; keys: SearchKeys; queries: readonly string[]; country: string; search: SearchFn; signal: AbortSignal; seen: Set<string>; stats: SearchStats; negatives?: RegExp | undefined }): AsyncGenerator<{ query: string; index: number; sites: Candidate[]; ruledOut: Candidate[] }> {
  const { stats } = input;
  const engines = ([["tinyfish", input.keys.tinyfishKey], ["exa", input.keys.exaKey]] as const).filter((entry): entry is readonly [SearchEngine, string] => Boolean(entry[1]));
  const usable = (engine: SearchEngine) => !stats.capped.has(engine) && (stats.failures.get(engine) ?? 0) < ENGINE_FAILURES;
  for (const [index, query] of input.queries.entries()) {
    if (input.signal.aborted || !engines.some(([engine]) => usable(engine))) return;
    const sites: Candidate[] = [];
    const ruledOut: Candidate[] = [];
    for (const [engine, key] of engines) {
      if (!usable(engine) || input.signal.aborted) continue;
      if (!(await reserveSearch(input.db, input.workspaceId, engine))) { stats.capped.add(engine); continue; }
      stats.calls++;
      let hits: SearchHit[];
      try { hits = await input.search(engine, key, query, input.country); stats.answered++; stats.failures.set(engine, 0); }
      catch (error) {
        // Messages from the search helpers never carry a key, a URL or a response body.
        const message = error instanceof Error ? error.message : "search failed";
        stats.errors.set(engine, message);
        stats.failures.set(engine, /refused/i.test(message) ? ENGINE_FAILURES : (stats.failures.get(engine) ?? 0) + 1);
        continue;
      }
      for (const hit of hits) {
        const domain = hostOf(hit.url);
        if (!domain || !/^https?:\/\//i.test(hit.url) || isNotCompanyHost(domain)) continue;
        const negative = Boolean(input.negatives?.test(`${hit.title}\n${hit.snippet}`));
        const known = sites.find((site) => site.domain === domain);
        // A second result for a site already found this search that names a negative rules the site out too.
        if (known && negative) { sites.splice(sites.indexOf(known), 1); ruledOut.push(known); continue; }
        if (known) { if (!known.engines.includes(engine)) known.engines.push(engine); if (!known.title && hit.title) known.title = hit.title; continue; }
        if (input.seen.has(domain)) continue;
        input.seen.add(domain);
        (negative ? ruledOut : sites).push({ domain, url: hit.url.slice(0, 2_000), title: hit.title.slice(0, 300), snippet: hit.snippet.slice(0, 400), engines: [engine] });
      }
      if (sites.length) break;
    }
    yield { query, index, sites, ruledOut };
  }
}
