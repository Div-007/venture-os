// The built-in lead finder's page reader: public company pages only, read slowly and safely. http and https on ports 80 and 443; every
// host (and every redirect hop, at most 3, followed by hand) is resolved first and refused when any of its addresses is loopback, private,
// link-local, CGNAT, multicast, reserved or unspecified (IPv4, IPv6 and IPv4 inside IPv6), and the connection goes to the address that was
// checked. 15 seconds and 1.5 MB per page, HTML only, no cookies, no JavaScript, no forms, no logins, and an honest user agent. At least
// 5 seconds between requests to one host, at most 3 hosts at once. robots.txt is checked before every page. A CAPTCHA or bot check, or a
// 403 or 429 on a home page, means the site is skipped: nothing is retried around it and no proxy is used.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { replaceTags, withoutElements } from "./html.js";
import { FINDER_TOKEN, MAX_ROBOTS_BYTES, RobotsCache, type RobotsAnswer } from "./robots.js";

export type LookupAddress = { address: string; family: number };
/** Every address a host name resolves to (like dns.lookup with `all: true`). */
export type LookupImpl = (hostname: string) => Promise<LookupAddress[]>;
/** One GET, connecting to `address` (already checked): redirects are not followed and no cookie is kept. */
export type FetchImpl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; address: LookupAddress }) => Promise<Response>;

export const PAGE_TIMEOUT_MS = 15_000;
export const MAX_PAGE_BYTES = 1_500_000;
export const MAX_REDIRECTS = 3;
export const HOST_GAP_MS = 5_000;
export const HOSTS_IN_FLIGHT = 3;
/** A robots.txt Crawl-delay above the 5-second gap is honoured, up to a minute. */
const MAX_CRAWL_DELAY_MS = 60_000;
const MAX_URL_LENGTH = 2_000;

export const finderUserAgent = (origin: string) => `${FINDER_TOKEN}/1.0 (+${origin})`;

// ---- Which addresses may be fetched ---------------------------------------------------------------------------------------------

const v4Number = (text: string): number | null => {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
};
/** IPv4 ranges that are never a public web server: this network, private, CGNAT, loopback, link-local, protocol and documentation nets, 6to4 relay, benchmarking, multicast and reserved. */
const V4_REFUSED = ([["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const)
  .map(([net, bits]) => ({ net: v4Number(net)!, bits }));
const publicV4 = (value: number) => !V4_REFUSED.some(({ net, bits }) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(net / 2 ** (32 - bits)));

/** The eight 16-bit groups of an IPv6 address (brackets, a zone and a dotted IPv4 tail allowed), or null when it is not one. */
function v6Groups(text: string): number[] | null {
  let rest = text.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest);
  if (dotted) {
    const v4 = v4Number(dotted[2]!);
    if (v4 === null) return null;
    rest = `${dotted[1]}${Math.floor(v4 / 65_536).toString(16)}:${(v4 % 65_536).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? 8 - head.length - tail.length : 0).fill("0"), ...tail];
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map((group) => parseInt(group, 16)) : null;
}

/** Only global unicast IPv6 (2000::/3) is public, minus protocol and documentation ranges; an IPv4 address inside one is judged as IPv4. */
function publicV6(groups: number[]): boolean {
  const [a = 0, b = 0, c = 0] = groups;
  const v4 = (high: number, low: number) => publicV4(high * 65_536 + low);
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && groups[5] === 0xffff) return v4(groups[6]!, groups[7]!); // ::ffff:a.b.c.d, IPv4-mapped
  if (zeros(0, 6)) return false; // ::, ::1 and the old IPv4-compatible form
  if (a === 0x64 && b === 0xff9b && zeros(2, 6)) return v4(groups[6]!, groups[7]!); // NAT64 (64:ff9b::/96)
  if (a === 0x2002) return v4(b, c); // 6to4
  if (a < 0x2000 || a > 0x3fff) return false; // unique local, link-local, site-local, multicast, discard, NAT64 local use...
  if (a === 0x2001 && (b < 0x200 || b === 0xdb8)) return false; // protocol assignments (Teredo, benchmarking, ORCHID) and documentation
  return !(a === 0x3fff && b < 0x1000); // documentation (3fff::/20)
}

/** A public internet address: the finder may connect to it. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const kind = isIP(bare.split("%")[0]!);
  if (kind === 4) { const value = v4Number(bare); return value !== null && publicV4(value); }
  if (kind === 6) { const groups = v6Groups(bare); return groups !== null && publicV6(groups); }
  return false;
}

/** The URL when the finder may ask for it (http or https, port 80 or 443, no login in it), or why not. */
export function checkUrl(raw: string): URL | string {
  if (raw.length > MAX_URL_LENGTH) return "the address is too long";
  let url: URL;
  try { url = new URL(raw); } catch { return "it is not a web address"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https pages are read";
  if (url.port && url.port !== "80" && url.port !== "443") return "only the standard web ports (80 and 443) are read";
  if (url.username || url.password) return "an address with a login in it is not read";
  url.hash = "";
  return url;
}

/** The address to connect to, when every address the host resolves to is public; otherwise why it is refused. */
export async function safeAddress(hostname: string, lookup: LookupImpl): Promise<LookupAddress | string> {
  const bare = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const literal = isIP(bare);
  if (literal) return isPublicAddress(bare) ? { address: bare, family: literal } : "it is a private or reserved address";
  if (!bare.includes(".") || /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa)$/.test(bare)) return "it is not a public host";
  let found: LookupAddress[];
  try { found = await lookup(bare); } catch { return "its name does not resolve"; }
  if (!found.length) return "its name does not resolve";
  if (found.some((entry) => !isPublicAddress(entry.address))) return "it resolves to a private or reserved address";
  return found.find((entry) => entry.family === 4) ?? found[0]!;
}

export const systemLookup: LookupImpl = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family }));

/** The real network: node's http(s) client, connected to the checked address (so a second DNS answer can't point it elsewhere), unzipping the body. */
export const nodeFetch: FetchImpl = (url, { headers, signal, address }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  // Pin the connection to the address that was checked; the host name still goes in the Host header and the TLS name check.
  const lookup = ((_host: string, options: { all?: boolean }, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as unknown as RequestOptions["lookup"];
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const request = send(target, { method: "GET", headers, signal, agent: false, lookup }, (incoming) => {
    const status = incoming.statusCode ?? 0;
    const head = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && name !== "set-cookie") for (const one of [value].flat()) head.append(name, one);
    const coding = String(incoming.headers["content-encoding"] ?? "").trim().toLowerCase();
    const unzip = coding === "gzip" || coding === "x-gzip" ? createGunzip() : coding === "deflate" ? createInflate() : coding === "br" ? createBrotliDecompress() : undefined;
    const body = unzip ? incoming.pipe(unzip) : incoming;
    if (unzip) incoming.on("error", (error) => unzip.destroy(error));
    const empty = status < 200 || status > 599 || status === 204 || status === 205 || status === 304;
    if (empty) incoming.resume();
    resolve(new Response(empty ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: status >= 200 && status <= 599 ? status : 502, headers: head }));
  });
  request.on("error", reject);
  request.end();
});

// ---- Reading -------------------------------------------------------------------------------------------------------------------

/** A page that was read: where it was asked for, where it ended up after redirects, and its HTML (cut at 1.5 MB). */
export type Page = { url: string; finalUrl: string; status: number; html: string; truncated: boolean };
export type ReadFailure = { failed: "unsafe" | "robots" | "challenge" | "blocked" | "not_html" | "http" | "network"; detail: string; status?: number };
export type ReadResult = { page: Page } | ReadFailure;
export type Reader = {
  /** One page, after robots.txt allows it. `home` marks a site's home page, where a 403 or 429 means the whole site is skipped. Throws only when `signal` aborts. */
  read: (url: string, signal: AbortSignal, options?: { home?: boolean }) => Promise<ReadResult>;
  /** A new run: sites whose robots.txt did not answer are asked again. */
  newRun: () => void;
  /** Requests sent since the reader was made (robots.txt included). */
  requests: () => number;
};
export type ReaderOptions = { origin: string; fetchImpl?: FetchImpl; lookupImpl?: LookupImpl; hostGapMs?: number; hostsInFlight?: number; timeoutMs?: number; maxBytes?: number; now?: () => number };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const failure = (failed: ReadFailure["failed"], detail: string, status?: number): ReadFailure => ({ failed, detail, ...(status !== undefined ? { status } : {}) });

/** Resolves with `promise`, or rejects with the signal's reason as soon as it aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/** A gate that lets `size` holders through at once; waiting can be aborted. */
function gate(size: number) {
  let used = 0;
  const queue: (() => void)[] = [];
  const release = () => { const next = queue.shift(); if (next) next(); else used--; };
  return async (signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    if (used < size) used++;
    else await new Promise<void>((resolve, reject) => {
      const go = () => { signal.removeEventListener("abort", onAbort); resolve(); };
      const onAbort = () => { const at = queue.indexOf(go); if (at >= 0) queue.splice(at, 1); reject(signal.reason); };
      queue.push(go);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let open = true;
    return () => { if (open) { open = false; release(); } };
  };
}

/** Up to `max` bytes of a response body; the rest is not downloaded. */
async function readCapped(response: Response, max: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (size + value.byteLength >= max) { chunks.push(value.subarray(0, max - size)); size = max; truncated = true; break; }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally { void reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

/** The page's text in its own character set (the Content-Type header, else a meta tag in its first bytes, else UTF-8). */
function decode(bytes: Uint8Array, contentType: string): string {
  const sniff = new TextDecoder("latin1").decode(bytes.subarray(0, 2_048));
  const label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(sniff)?.[1] ?? "utf-8";
  try { return new TextDecoder(label.toLowerCase()).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

/**
 * A CAPTCHA or bot-check page instead of the site: Cloudflare, DataDome, PerimeterX, Imperva, SiteGround and AWS WAF markers, a
 * challenge title, or a short page that is mostly a CAPTCHA. A contact page whose enquiry form has a reCAPTCHA is not a challenge.
 */
export function looksLikeChallenge(html: string, headers?: Headers): boolean {
  if (headers?.get("cf-mitigated")?.trim().toLowerCase() === "challenge") return true;
  const head = html.slice(0, 200_000);
  if (/cf-chl-|\/cdn-cgi\/challenge-platform\/|_cf_chl_opt|px-captcha|captcha-delivery\.com|_Incapsula_Resource|sgcaptcha|awswaf/i.test(head)) return true;
  // Bounded parts only: page text comes from any website, and an unbounded [^>]* rescans the page from every unclosed "<title".
  const title = /<title[^>]{0,500}>([\s\S]{0,300}?)<\/title/i.exec(head)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  if (/^(just a moment|attention required|access denied|are you (a )?(robot|human)|security check|human verification|verify(ing)? (that )?you are (a )?human|one more step|pardon our interruption|ddos protection|bot (check|verification))/i.test(title)) return true;
  if (!/captcha/i.test(head)) return false;
  const text = replaceTags(withoutElements(head, ["script", "style"]), /<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length < 1_500 && !/<textarea\b/i.test(head);
}

/** The reader the finder uses for a whole process: the robots.txt cache, the per-host pacing and the 3-hosts gate live as long as it does. */
export function createReader(options: ReaderOptions): Reader {
  const fetchImpl = options.fetchImpl ?? nodeFetch;
  const lookup = options.lookupImpl ?? systemLookup;
  const gap = options.hostGapMs ?? HOST_GAP_MS;
  const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  const now = options.now ?? Date.now;
  const headers = (accept: string) => ({ "user-agent": finderUserAgent(options.origin), accept, "accept-language": "en-IN,en;q=0.9", "accept-encoding": "gzip, deflate, br" });
  const inFlight = gate(options.hostsInFlight ?? HOSTS_IN_FLIGHT);
  const hosts = new Map<string, { tail: Promise<void>; last: number; gapMs: number; waiting: number }>();
  let sent = 0;

  /** Runs one request to `host` after the one before it has finished and the gap has passed, holding one of the in-flight places. */
  async function turn<T>(host: string, signal: AbortSignal, work: () => Promise<T>, gapMs = gap): Promise<T> {
    const key = host.replace(/^www\./, "");
    const state = hosts.get(key) ?? { tail: Promise.resolve(), last: 0, gapMs: gap, waiting: 0 };
    hosts.set(key, state);
    state.gapMs = Math.max(state.gapMs, gapMs);
    state.waiting++;
    const before = state.tail;
    let finished!: () => void;
    const mine = new Promise<void>((resolve) => { finished = resolve; });
    // The next request waits for this one and every one before it, even when this one gives up while waiting.
    state.tail = Promise.all([before, mine]).then(() => undefined);
    try {
      await abortable(before, signal);
      const wait = state.last + state.gapMs - now();
      if (wait > 0) await delay(wait, undefined, { signal });
      const release = await inFlight(signal);
      try { sent++; return await work(); } finally { release(); state.last = now(); }
    } finally { state.waiting--; finished(); }
  }

  /** One request without redirects, to the address that was checked; the body is read inside the host's turn. */
  async function once(url: URL, address: LookupAddress, kind: "page" | "robots", signal: AbortSignal): Promise<{ redirect: string } | { response: Response; body: string; truncated: boolean } | ReadFailure> {
    const timed = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try { response = await abortable(fetchImpl(url.href, { headers: headers(kind === "robots" ? "text/plain,*/*;q=0.5" : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"), signal: timed, address }), timed); }
    catch { if (signal.aborted) throw signal.reason; return failure("network", timed.aborted ? "it took longer than 15 seconds to answer" : "it could not be reached"); }
    const drop = () => void response.body?.cancel().catch(() => undefined);
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location");
      drop();
      if (!location) return failure("http", `it answered HTTP ${response.status} without saying where to`, response.status);
      try { return { redirect: new URL(location, url).href }; } catch { return failure("http", "it redirected to something that is not a web address", response.status); }
    }
    if (kind === "page") {
      if (response.status === 403 || response.status === 429) { drop(); return failure("blocked", `it answered HTTP ${response.status}`, response.status); }
      if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge") { drop(); return failure("challenge", "it showed a bot check", response.status); }
      if (!response.ok) { drop(); return failure("http", `it answered HTTP ${response.status}`, response.status); }
      const type = response.headers.get("content-type") ?? "";
      if (!/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type)) { drop(); return failure("not_html", "it is not a web page"); }
    } else if (!response.ok) { drop(); return { response, body: "", truncated: false }; }
    try {
      const { bytes, truncated } = await readCapped(response, kind === "robots" ? MAX_ROBOTS_BYTES : maxBytes, timed);
      return { response, body: decode(bytes, response.headers.get("content-type") ?? ""), truncated };
    } catch {
      if (signal.aborted) throw signal.reason;
      return failure("network", timed.aborted ? "it took longer than 15 seconds to send the page" : "the page stopped half way");
    }
  }

  /** A request with its redirects (at most 3): every hop's address is checked first (nothing is sent to a private one), then a page's robots.txt. */
  async function get(start: string, kind: "page" | "robots", signal: AbortSignal): Promise<ReadResult | RobotsAnswer> {
    let current = start;
    for (let hop = 0; ; hop++) {
      const url = checkUrl(current);
      if (typeof url === "string") return kind === "robots" ? { failed: url } : failure("unsafe", url);
      const address = await safeAddress(url.hostname, lookup);
      if (typeof address === "string") return kind === "robots" ? { failed: address } : failure("unsafe", address);
      let gapMs = gap;
      if (kind === "page") {
        const verdict = await robots.check(url, signal);
        if (!verdict.allowed) return failure("robots", verdict.reason);
        if (verdict.crawlDelayMs) gapMs = Math.min(Math.max(gap, verdict.crawlDelayMs), MAX_CRAWL_DELAY_MS);
      }
      const answer = await turn(url.hostname, signal, () => once(url, address, kind, signal), gapMs);
      if ("failed" in answer) return kind === "robots" ? { failed: answer.detail } : answer;
      if ("redirect" in answer) {
        if (hop >= MAX_REDIRECTS) return kind === "robots" ? { failed: "too many redirects" } : failure("http", "it redirected more than 3 times");
        current = answer.redirect;
        continue;
      }
      if (kind === "robots") return { status: answer.response.status, text: answer.body };
      if (looksLikeChallenge(answer.body, answer.response.headers)) return failure("challenge", "it showed a CAPTCHA or bot check");
      return { page: { url: start, finalUrl: url.href, status: answer.response.status, html: answer.body, truncated: answer.truncated } };
    }
  }

  const robots = new RobotsCache(async (url, signal) => await get(url, "robots", signal) as RobotsAnswer, now);

  return {
    read: async (url, signal, readOptions = {}) => {
      const result = await get(url, "page", signal) as ReadResult;
      // A home page that refuses us (403) or asks us to slow down (429) closes the whole site: the caller skips it.
      if ("failed" in result && result.failed === "blocked" && !readOptions.home) return { ...result, failed: result.status === 429 ? "blocked" : "http" };
      return result;
    },
    newRun: () => {
      robots.newRun();
      for (const [host, state] of hosts) if (!state.waiting && now() - state.last > 10 * 60_000) hosts.delete(host);
    },
    requests: () => sent,
  };
}
