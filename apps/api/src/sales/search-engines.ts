// The two web search APIs Sales uses to find companies: TinyFish Search (free, 1,500 calls a day) and Exa (category "company", paid per call,
// kept inside its free monthly credit). Shared by the connector's search_companies tool and the built-in lead finder. Calls are counted per
// workspace and period (mcp_search_usage); failures become short messages that carry no URL, header or response body, so no key can leak.
import type { AppDb } from "../db.js";
import { clean } from "../mcp/format.js";

const TINYFISH_URL = "https://api.search.tinyfish.ai";
const EXA_URL = "https://api.exa.ai/search";
const TIMEOUT_MS = 15_000;
/** Hosts that are never a company's own website: directories, marketplaces and social networks (the old engine's blocklist). */
export const NOT_A_COMPANY_SITE = ["indiamart.com", "justdial.com", "tradeindia.com", "exportersindia.com", "indiantradebird.com", "sulekha.com", "amazon.in", "flipkart.com", "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "pinterest.com", "quora.com", "reddit.com", "wikipedia.org"];
/** What the workspace may spend: TinyFish is free at 1,500 calls a day; Exa is paid per call, kept inside the free monthly credit (about 1,200 fast searches). */
export const SEARCH_CAPS = { tinyfish: { limit: 1_500, period: "day" }, exa: { limit: 1_200, period: "month" } } as const;

export type SearchEngine = "tinyfish" | "exa";
export type SearchHit = { url: string; title: string; snippet: string; engine: SearchEngine };
export type SearchKeys = { tinyfishKey?: string | undefined; exaKey?: string | undefined };

export const hostOf = (url: string): string | undefined => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return undefined; } };
export const isDirectory = (host: string) => NOT_A_COMPANY_SITE.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));

/** A company name from a page title ("Sharma Foods | Namkeen makers in Jaipur" → "Sharma Foods"), or from the domain when the title says nothing. */
export function guessCompany(title: string, domain: string): string {
  const first = clean(title).replace(/\s+/g, " ").trim().split(/\s[|–—:·-]\s/)[0]?.replace(/^(home|welcome( to)?)\s*[:|-]?\s*/i, "").trim() ?? "";
  if (first && first.length <= 80 && !/^(home|index|welcome)$/i.test(first)) return first;
  const label = domain.split(".")[0] ?? domain;
  return label.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * What searches from a chat (search_companies) may use of each allowance: the rest stays for the lead finder, so a busy chat never leaves
 * queued find runs without searches. Both count on the same counter.
 */
export const CHAT_SEARCH_SHARE = { tinyfish: 1_000, exa: 1_000 } as const;

/**
 * One call against the engine's period counter for this workspace, while the counter is under `limit` (the workspace's cap unless a smaller
 * share is given); false once it is not. A refused call is not counted, so asking again after the share is used up never eats into the rest.
 */
export async function reserveSearch(db: AppDb, workspaceId: string, engine: SearchEngine, limit: number = SEARCH_CAPS[engine].limit): Promise<boolean> {
  const { period } = SEARCH_CAPS[engine];
  const now = new Date();
  const stamp = now.toISOString().slice(0, period === "day" ? 10 : 7);
  const usage = db.collection("mcp_search_usage");
  const _id = `${workspaceId}:${engine}:${stamp}` as never;
  // First the period's counter exists (two first calls at once both end up here: the server retries an upsert that matches on _id alone),
  // then one call is counted only while the counter is under the limit.
  try {
    await usage.updateOne({ _id }, { $setOnInsert: { calls: 0, workspaceId, engine, period: stamp, createdAt: now, expiresAt: new Date(now.getTime() + 62 * 86_400_000) } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  return (await usage.updateOne({ _id, calls: { $lt: limit } }, { $inc: { calls: 1 } })).matchedCount === 1;
}

/** One request to a search API. Failures become short messages that carry no URL, header or response body (so no key can leak). */
async function send(label: string, url: string, init: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Error(`could not reach ${label}`);
  }
  if (response.status === 401 || response.status === 403) throw new Error(`${label} refused the request: its key was rejected or its quota is used up`);
  if (response.status === 429) { const wait = Number(response.headers.get("retry-after")); throw new Error(`${label} is busy${Number.isFinite(wait) && wait > 0 ? `: try again in ${Math.min(Math.round(wait), 120)} s` : ": try again in a minute"}`); }
  if (!response.ok) throw new Error(`${label} answered with an error (HTTP ${response.status})`);
  try { return await response.json(); } catch { throw new Error(`${label} returned something that is not JSON`); }
}

export async function searchTinyfish(key: string, query: string, country: string, page: number): Promise<SearchHit[]> {
  const params = new URLSearchParams({ query, language: "en", domain_type: "web", page: String(Math.min(Math.max(page - 1, 0), 10)), location: country, exclude_domains: NOT_A_COMPANY_SITE.join(",") });
  const payload = await send("TinyFish Search", `${TINYFISH_URL}?${params}`, { method: "GET", headers: { "X-API-Key": key, accept: "application/json" } });
  return (Array.isArray(payload?.results) ? payload.results : []).flatMap((item: any) => item && typeof item.url === "string" ? [{ url: item.url.trim(), title: String(item.title ?? item.site_name ?? "").trim(), snippet: String(item.snippet ?? "").trim(), engine: "tinyfish" as const }] : []);
}

export async function searchExa(key: string, query: string, country: string, count: number): Promise<SearchHit[]> {
  const payload = await send("Exa", EXA_URL, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query, type: "fast", category: "company", numResults: count, excludeDomains: NOT_A_COMPANY_SITE, userLocation: country }) });
  return (Array.isArray(payload?.results) ? payload.results : []).flatMap((item: any) => {
    if (!item || typeof item.url !== "string") return [];
    const snippet = Array.isArray(item.highlights) ? item.highlights.slice(0, 2).join(" ") : String(item.text ?? item.summary ?? "");
    return [{ url: item.url.trim(), title: String(item.title ?? "").trim(), snippet: snippet.trim().slice(0, 400), engine: "exa" as const }];
  });
}
