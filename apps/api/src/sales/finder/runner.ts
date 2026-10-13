// The lead finder built into the API: it works queued find-leads and enrich runs itself, one at a time across workspaces, the way the
// office PC engine does over the bridge (routes/sales-engine.ts), so Venture OS no longer needs that engine (it can still work runs too).
// A run is claimed atomically (queued, or running with a heartbeat older than 15 minutes, as the bridge allows), worked as the person who
// planned it, and every lead goes through ingestEngineLead / enrichEngineLead: the same duplicate and do-not-contact checks as any lead.
// A workspace with no company-search key keeps its runs queued, with a note for the admin. One JSON log line per run; never a key or page text.
// A run searches for its offer (sales-offers.ts): the approved packet, read once per run, gives the searches' defaults, the negatives
// that rule search results out, the phrases quoted from each site and the categories; a find run whose offer can't be used fails.
import { hostname } from "node:os";
import { FINDER_SYSTEM, type OfferPacket } from "@venture-studio/contracts";
import { audit } from "../../audit.js";
import type { AppDb, AppDocument, Database } from "../../db.js";
import { actorFor } from "../../middleware.js";
import type { SalesCtx } from "../ctx.js";
import { STALE_CLAIM_MS, canWorkRun, enrichEngineLead, enrichTargets, firstActivePipeline, ingestEngineLead, type EngineSkip } from "../engine.js";
import { suppressedBy } from "../leads.js";
import { OFFERS, approvedOffer } from "../offers.js";
import { guessCompany, hostOf } from "../search-engines.js";
import { resolveSearchKeys, type SearchKeyEnv } from "../search-keys.js";
import { isSharedDomain, normalizeCompany, normalizeDomain, suppressionKey } from "../suppression.js";
import { createReader, type FetchImpl, type LookupImpl, type ReadFailure, type Reader } from "./fetch.js";
import { isNotCompanyHost, offerSignals, pickPages, siteFacts, type SiteFacts } from "./extract.js";
import { parseHtml, type ParsedPage } from "./html.js";
import { buildQueries, countryOf, liveSearch, negativesOf, searchSites, searchStats, type Candidate, type SearchFn, type SearchStats } from "./plan.js";

/** `claimedBy` on the runs the built-in finder holds (the bridge stores the engine token's id there). */
export const FINDER_WORKER = "builtin-finder";
export const NO_KEY_NOTE = "Company search has no key: an admin adds one in Sales setup";
const RESTART_NOTE = "The server restarted: the lead finder starts this run again";
export const RUN_BUDGET_MS = 20 * 60_000;
export const SITE_BUDGET_MS = 90_000;
export const POLL_MS = 30_000;
export const HEARTBEAT_MS = 60_000;
/** Sites read side by side: the reader keeps it to 3 hosts in flight anyway. */
const SITES_AT_ONCE = 3;

/** The finder runs in the API process when SALES_FINDER is on, never under the test runner. */
export const finderEnabled = (config: { SALES_FINDER: "on" | "off"; NODE_ENV: string }) => config.SALES_FINDER === "on" && config.NODE_ENV !== "test";

export type FinderOptions = {
  database: Database;
  /** The app's whole config: search keys saved in the app need BETTER_AUTH_SECRET to be read, and APP_ORIGIN goes in the user agent. */
  env: SearchKeyEnv & { APP_ORIGIN: string };
  search?: SearchFn; fetchImpl?: FetchImpl; lookupImpl?: LookupImpl; hostGapMs?: number;
  runBudgetMs?: number; siteBudgetMs?: number; heartbeatMs?: number; pollMs?: number; workerId?: string;
  log?: (line: Record<string, unknown>) => void;
};
export type RunSummary = { runId: string; kind: "find" | "enrich"; status: "done" | "failed" | "cancelled" | "released"; found: number; added: number; skipped: number; note: string };
export type Finder = { runOnce: () => Promise<RunSummary | null>; start: () => void; stop: () => Promise<void>; workerId: string };

/** Why a run stopped early: the server is stopping (the run goes back to the queue), the run is no longer ours (cancelled or taken over), or time ran out. */
class Halt extends Error { constructor(readonly why: "stop" | "gone" | "budget") { super(why); } }
const haltOf = (signal: AbortSignal) => signal.reason instanceof Halt ? signal.reason.why : undefined;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

type Reason = EngineSkip["reason"] | "negative" | "not_company" | "robots" | "challenge" | "blocked" | "unreachable" | "no_website" | "nothing_new";
const REASON_TEXT: Record<Reason, string> = {
  duplicate: "already in Dealflow", do_not_contact: "on the do-not-contact list", invalid: "refused by the lead rules", negative: "ruled out by the offer's negative words", not_company: "not a company's own site", robots: "closed to crawlers by robots.txt",
  challenge: "behind a CAPTCHA or bot check", blocked: "refused the finder (HTTP 403 or 429)", unreachable: "could not be read", no_website: "without a website", nothing_new: "with nothing new on their site",
};
const reasonOf = (failure: ReadFailure): Reason => failure.failed === "robots" ? "robots" : failure.failed === "challenge" ? "challenge" : failure.failed === "blocked" ? "blocked" : "unreachable";
/** `offer` is the run's offer name, for its notes. */
type RunState = { found: number; crawled: number; added: number; note: string; offer?: string; reasons: Map<Reason, number>; stats: SearchStats };

/** A run's offer, read once per run: its name, its approved packet (none without an approved version), and whether a find run may use it (active). */
type RunOffer = { name?: string; packet?: OfferPacket; usable: boolean };
async function runOffer(db: AppDb, run: AppDocument): Promise<RunOffer | undefined> {
  if (typeof run.offerId !== "string") return undefined;
  const approved = await approvedOffer(db, String(run.workspaceId), run.offerId);
  const offer = approved?.offer ?? await db.collection(OFFERS).findOne({ _id: run.offerId, workspaceId: run.workspaceId }, { projection: { name: 1, ventureId: 1, state: 1 } });
  // An offer of another venture is never searched with, nor named.
  if (!offer || offer.ventureId !== run.ventureId) return { usable: false };
  const name = String(offer.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return { ...(name ? { name } : {}), ...(approved ? { packet: approved.packet } : {}), usable: Boolean(approved) && offer.state === "active" };
}
const unusableNote = (offer: RunOffer) => `The offer ${offer.name ?? "this run was planned for"} is paused or has no approved version: plan the run again`;
/** The run's categories for the category guess: the plan's, then the offer's industries. */
const categoriesOf = (run: AppDocument, packet?: OfferPacket) => [...new Set([...(Array.isArray(run.plan?.categories) ? (run.plan.categories as string[]) : []), ...(packet?.whoFor.industries ?? [])])];

/** Runs `work` over `items`, `size` at a time. */
async function eachAtMost<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) await work(items[next++]!); }));
}

/** A site's home page and then its contact, about, dealer and products pages (at most 5 in all), within the site's time budget. */
async function readSite(reader: Reader, homes: readonly string[], signal: AbortSignal): Promise<{ pages: ParsedPage[]; failure?: ReadFailure }> {
  const pages: ParsedPage[] = [];
  try {
    let first: Awaited<ReturnType<Reader["read"]>> | undefined;
    for (const home of homes) {
      first = await reader.read(home, signal, { home: true });
      // Only a site that did not answer at all is tried again over http; a refusal, a challenge or robots.txt is final.
      if (!("failed" in first) || first.failed !== "network") break;
    }
    if (!first || "failed" in first) return { pages, ...(first ? { failure: first } : {}) };
    const home = parseHtml(first.page.html, first.page.finalUrl);
    pages.push(home);
    for (const url of pickPages(home, 4)) {
      const next = await reader.read(url, signal);
      if ("failed" in next) {
        // A bot check ends the visit and nothing from the site is used; a "slow down" ends it with what was read. A missing page is skipped.
        if (next.failed === "challenge") return { pages: [], failure: next };
        if (next.failed === "blocked") return { pages, failure: next };
        continue;
      }
      pages.push(parseHtml(next.page.html, next.page.finalUrl));
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    // Out of time for this site (or the run stopped): what was read so far is used.
  }
  return { pages };
}

/** The home page addresses to try for a website as found or typed ("acme.in" is tried over https, then http). */
function homesOf(website: string): string[] {
  const value = website.trim();
  try {
    if (/^https?:\/\//i.test(value)) { const url = new URL(value); return [`${url.protocol}//${url.host}/`]; }
    const url = new URL(`https://${value}`);
    return [`https://${url.host}/`, `http://${url.host}/`];
  } catch { return []; }
}

/** The evidence and signal the finder hands over for one site: word-for-word quotes with their pages, dated today. */
function evidenceOf(facts: SiteFacts, seenAt: string) {
  const evidence = facts.signals.map((signal) => ({ claim: signal.claim, quote: signal.quote, url: signal.url, seenAt }));
  if (facts.dealerPortal) evidence.push({ claim: "Shows a dealer login or dealer portal (it may already have the dealers it needs)", quote: facts.dealerPortal.quote, url: facts.dealerPortal.url, seenAt });
  const best = facts.signals[0];
  return { evidence: evidence.slice(0, 10), ...(best ? { observedSignal: `"${best.quote}" (${best.url})`.slice(0, 2_000) } : {}) };
}
const routesOf = (facts: SiteFacts) => facts.routes.map((route) => ({ ...route, publishedByCompany: true }));
const placeOf = (facts: SiteFacts) => ({ ...(facts.city ? { city: facts.city } : {}), ...(facts.region ? { region: facts.region } : {}), ...(facts.country ? { country: facts.country } : {}), ...(facts.category ? { category: facts.category } : {}) });

export function createFinder(options: FinderOptions): Finder {
  const database = options.database;
  const db = database.db;
  const runs = db.collection("sales_find_runs");
  const workerId = (options.workerId ?? `${hostname()}-${process.pid}`).slice(0, 100);
  const search = options.search ?? liveSearch;
  const log = options.log ?? ((line: Record<string, unknown>) => console.info(JSON.stringify(line)));
  const reader = createReader({ origin: options.env.APP_ORIGIN, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.lookupImpl ? { lookupImpl: options.lookupImpl } : {}), ...(options.hostGapMs !== undefined ? { hostGapMs: options.hostGapMs } : {}) });
  const runBudgetMs = options.runBudgetMs ?? RUN_BUDGET_MS;
  const siteBudgetMs = options.siteBudgetMs ?? SITE_BUDGET_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const ours = { status: "running", claimedBy: FINDER_WORKER, workerId };
  let current: { controller: AbortController; done: Promise<RunSummary> } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let ticking = false;

  const record = (action: string, run: AppDocument, metadata: Record<string, string | number | boolean | null>) => audit(db, { workspaceId: String(run.workspaceId), actorId: typeof run.createdBy === "string" ? run.createdBy : null, channel: "engine", action, objectType: "find_run", objectId: String(run._id), ventureId: String(run.ventureId), result: "success", metadata });

  /** Workspaces with a find run to take whose company search has a key. The others' queued find runs wait, with a note saying why. */
  async function readyWorkspaces(open: Record<string, unknown>): Promise<string[]> {
    const ready: string[] = [];
    for (const workspaceId of (await runs.distinct("workspaceId", { ...open, kind: { $ne: "enrich" } })) as string[]) {
      const keys = await resolveSearchKeys(db, workspaceId, options.env);
      if (keys.tinyfishKey || keys.exaKey) { ready.push(workspaceId); continue; }
      await runs.updateMany({ workspaceId, status: "queued", kind: { $ne: "enrich" }, note: { $ne: NO_KEY_NOTE } }, { $set: { note: NO_KEY_NOTE, updatedAt: new Date() } });
    }
    return ready;
  }

  /** Takes the oldest run that is queued (or whose worker stopped sending heartbeats), in one conditional update, as the bridge's claim does. */
  async function claim(): Promise<{ run: AppDocument; takeover: boolean; previousWorker?: string } | null> {
    const now = new Date();
    const stale = new Date(now.getTime() - STALE_CLAIM_MS);
    const open = { $or: [{ status: "queued" }, { status: "running", heartbeatAt: { $lt: stale } }, { status: "running", heartbeatAt: null }] };
    // An enrich run only reads the leads' own websites, so it needs no search key; a find run waits for one.
    const ready = await readyWorkspaces(open);
    const set = { status: "running", workerId, claimedBy: FINDER_WORKER, claimedAt: now, heartbeatAt: now, updatedAt: now, note: "Starting", progress: { found: 0, crawled: 0, added: 0 } };
    const before = await runs.findOneAndUpdate({ $and: [open, { $or: [{ kind: "enrich" }, { workspaceId: { $in: ready } }] }] }, { $set: set }, { sort: { createdAt: 1, _id: 1 }, returnDocument: "before" });
    if (!before) return null;
    const takeover = before.status === "running";
    return { run: { ...before, ...set }, takeover, ...(takeover ? { previousWorker: String(before.workerId ?? "") } : {}) };
  }

  /** Claims and works one run; null when there was nothing to take. */
  async function runOnce(): Promise<RunSummary | null> {
    if (current || stopped) return null;
    const claimed = await claim();
    if (!claimed) return null;
    const controller = new AbortController();
    const done = work(claimed.run, claimed.takeover, claimed.previousWorker, controller);
    current = { controller, done };
    try { return await done; } finally { current = undefined; }
  }

  /** The person who planned the run, as the actor that works it (their membership and rights), or why they can't. */
  async function actAs(run: AppDocument): Promise<SalesCtx | string> {
    const user = await db.collection("users").findOne({ _id: run.createdBy, status: "active" }, { projection: { email: 1, name: 1 } });
    const actor = user ? await actorFor(db, { id: String(user._id), email: String(user.email ?? ""), name: String(user.name ?? "") }) : undefined;
    if (!actor || actor.membership.workspaceId !== run.workspaceId) return "The person who planned this run is no longer an active member, so the lead finder can't work it. Plan it again.";
    const ctx: SalesCtx = { database, db, actor, via: "app", channel: "engine", workspaceId: String(run.workspaceId), settings: new Map() };
    return canWorkRun(ctx, run) ? ctx : "The person who planned this run can no longer work it in this venture (their role changed). A venture head plans it again.";
  }

  async function work(run: AppDocument, takeover: boolean, previousWorker: string | undefined, controller: AbortController): Promise<RunSummary> {
    const started = Date.now();
    const kind: "find" | "enrich" = run.kind === "enrich" ? "enrich" : "find";
    const state: RunState = { found: 0, crawled: 0, added: 0, note: "Starting", reasons: new Map(), stats: searchStats() };
    const signal = controller.signal;
    const summary = (status: RunSummary["status"], note: string): RunSummary => ({ runId: String(run._id), kind, status, found: state.found, added: state.added, skipped: Math.max(0, state.found - state.added), note });
    const progress = () => ({ found: state.found, crawled: state.crawled, added: state.added });
    /** Ends the run with its totals, the way the bridge's finish route does; a run that was cancelled meanwhile is left as it is. */
    const finish = async (status: "done" | "failed", text: string): Promise<RunSummary> => {
      const result = summary(status, text.slice(0, 2_000));
      const at = new Date();
      const changed = await runs.updateOne({ _id: run._id, ...ours }, { $set: { status, results: { found: result.found, added: result.added, skipped: result.skipped, note: result.note }, note: result.note, progress: progress(), finishedAt: at, heartbeatAt: at, updatedAt: at } });
      if (!changed.matchedCount) return summary("cancelled", "The run was cancelled or taken over before it finished");
      await record("sales.finder.finish", run, { status, found: result.found, added: result.added, skipped: result.skipped });
      return result;
    };
    /** Progress and a note; also what keeps the claim alive. A run that is no longer ours stops at once. */
    const beat = async () => {
      const at = new Date();
      const changed = await runs.updateOne({ _id: run._id, ...ours }, { $set: { progress: progress(), note: state.note.slice(0, 500), heartbeatAt: at, updatedAt: at } });
      if (!changed.matchedCount) controller.abort(new Halt("gone"));
    };

    let heartbeat: NodeJS.Timeout | undefined;
    let budget: NodeJS.Timeout | undefined;
    let outcome: RunSummary;
    try {
      await record("sales.finder.claim", run, { workerId, kind, takeover, ...(previousWorker ? { previousWorker } : {}) });
      const ctx = await actAs(run);
      if (typeof ctx === "string") outcome = await finish("failed", ctx);
      else {
        budget = setTimeout(() => controller.abort(new Halt("budget")), runBudgetMs);
        budget.unref();
        heartbeat = setInterval(() => void beat().catch(() => undefined), heartbeatMs);
        heartbeat.unref();
        reader.newRun();
        const offer = await runOffer(db, run);
        if (offer?.name) state.offer = offer.name;
        const failed = kind === "find" ? await findLeads(ctx, run, state, controller, beat, offer) : await enrichLeads(ctx, run, state, controller, offer);
        const why = haltOf(signal);
        if (why === "stop") outcome = await release(run, state);
        else if (why === "gone") outcome = summary("cancelled", "The run was cancelled or taken over: it stopped, and what it added stays");
        else if (failed) outcome = await finish("failed", state.found ? resultNote(kind, state, failed) : failed);
        else outcome = await finish("done", resultNote(kind, state, why === "budget" ? `Stopped at the ${Math.round(runBudgetMs / 60_000)}-minute time limit.` : state.note));
      }
    } catch (error) {
      const why = haltOf(signal);
      if (why === "stop") outcome = await release(run, state);
      else if (why === "gone") outcome = summary("cancelled", "The run was cancelled or taken over");
      else {
        // Logged without page text; the run says it in plain words.
        log({ level: "warn", event: "sales.finder.error", runId: String(run._id), message: messageOf(error) });
        const text = `The lead finder hit an error and stopped: ${messageOf(error).slice(0, 200)}`;
        outcome = await finish("failed", state.found ? resultNote(kind, state, text) : text).catch(() => summary("failed", text));
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(budget);
    }
    log({ level: "info", event: "sales.finder.run", runId: outcome.runId, workspaceId: String(run.workspaceId), ventureId: String(run.ventureId), ...(typeof run.offerId === "string" ? { offerId: run.offerId } : {}), kind, status: outcome.status, found: outcome.found, added: outcome.added, skipped: outcome.skipped, searches: state.stats.calls, crawled: state.crawled, ms: Date.now() - started, ...(takeover ? { takeover: true } : {}) });
    return outcome;
  }

  /** Re-reads the run: false (and the run stops) once it was cancelled, finished or taken over. */
  async function stillOurs(run: AppDocument, controller: AbortController): Promise<boolean> {
    if (controller.signal.aborted) return false;
    if (!(await runs.findOne({ _id: run._id, ...ours }, { projection: { _id: 1 } }))) controller.abort(new Halt("gone"));
    return !controller.signal.aborted;
  }

  /** One site at a time per worker: an unexpected error on one site is logged and the site skipped, never the run. */
  const guarded = (run: AppDocument, state: RunState, signal: AbortSignal, task: () => Promise<void>) => task().catch((error: unknown) => {
    if (signal.aborted) return;
    state.reasons.set("unreachable", (state.reasons.get("unreachable") ?? 0) + 1);
    log({ level: "warn", event: "sales.finder.site_failed", runId: String(run._id), message: messageOf(error) });
  });

  /**
   * A find run: search, read each new company site, and add the companies as leads. With an offer, its packet shapes the searches, rules
   * results out and is quoted from each site, and the leads get the offer (ingestEngineLead reads it from the run). Returns why it failed, if it did.
   */
  async function findLeads(ctx: SalesCtx, run: AppDocument, state: RunState, controller: AbortController, beat: () => Promise<void>, offer?: RunOffer): Promise<string | undefined> {
    const signal = controller.signal;
    const skip = (reason: Reason, count = 1) => state.reasons.set(reason, (state.reasons.get(reason) ?? 0) + count);
    if (offer && !offer.usable) return unusableNote(offer);
    const pipeline = await firstActivePipeline(ctx, String(run.ventureId));
    if (!pipeline) return "This venture has no active pipeline for the leads: a venture head creates one first";
    const keys = await resolveSearchKeys(db, ctx.workspaceId, options.env);
    const plan = { request: String(run.request ?? ""), plan: run.plan ?? null };
    const packet = offer?.packet;
    const queries = buildQueries(plan, packet);
    const limit = Number(run.plan?.limit ?? 50);
    const categories = categoriesOf(run, packet);
    const lookFor = offerSignals(packet?.signals.lookFor ?? []);
    /** "Searching for Dealer Commerce" when the run has an offer. */
    const searching = state.offer ? `Searching for ${state.offer}` : "Searching";
    let chain: Promise<unknown> = Promise.resolve();
    /** Leads go in one at a time, so sites read side by side never pass the limit. */
    const serially = <T>(task: () => Promise<T>): Promise<T> => { const next = chain.then(task); chain = next.catch(() => undefined); return next; };

    const workSite = (site: Candidate) => guarded(run, state, signal, async () => {
      if (state.added >= limit || !(await stillOurs(run, controller))) return;
      state.found++;
      state.note = `${searching}: reading ${site.domain} (${plural(state.crawled, "site")} read, ${plural(state.added, "lead")} added)`;
      const known = await knownSite(ctx, String(run.ventureId), site);
      if (known) { skip(known); return; }
      const read = await readSite(reader, homesOf(site.url), AbortSignal.any([signal, AbortSignal.timeout(siteBudgetMs)]));
      if (signal.aborted) return;
      state.crawled++;
      if (!read.pages.length) { skip(read.failure ? reasonOf(read.failure) : "unreachable"); return; }
      const facts = siteFacts({ pages: read.pages, hit: { url: site.url, title: site.title }, categories, signals: lookFor });
      if (facts.notCompany) { skip("not_company"); return; }
      const lead = {
        companyName: facts.companyName, website: facts.website, ...placeOf(facts), source: site.url.slice(0, 500), ...evidenceOf(facts, new Date().toISOString()), contactRoutes: routesOf(facts),
        tags: ["finder", ...(facts.dealerPortal ? ["dealer-login-seen"] : [])], externalRef: { system: FINDER_SYSTEM, id: facts.domain },
      };
      // Checked again right before the lead goes in: a run cancelled while the site was read adds nothing more.
      const result = await serially(async () => state.added >= limit || !(await stillOurs(run, controller)) ? null : ingestEngineLead(ctx, run, String(pipeline._id), lead, "finder"));
      if (!result) return;
      if ("added" in result) state.added++; else skip(result.skipped.reason);
    });

    let ending = "";
    for await (const batch of searchSites({ db, workspaceId: ctx.workspaceId, keys, queries, country: countryOf(plan, packet), search, signal, seen: new Set(), stats: state.stats, negatives: negativesOf(packet) })) {
      // Sites whose search result names one of the offer's negatives: looked at, never read.
      if (batch.ruledOut.length) { state.found += batch.ruledOut.length; skip("negative", batch.ruledOut.length); }
      state.note = `${searching}: ${batch.query.slice(0, 120)} (${batch.index + 1} of ${queries.length}), ${plural(state.crawled, "site")} read`;
      await beat().catch(() => undefined);
      await eachAtMost(batch.sites, SITES_AT_ONCE, workSite);
      if (state.added >= limit) { ending = `Reached the limit of ${plural(limit, "lead")}.`; break; }
      if (!(await stillOurs(run, controller))) break;
    }
    await chain;
    const { stats } = state;
    if (stats.calls === 0 && stats.capped.size) return `${capNote(stats)} Queue the run again later.`;
    if (stats.calls > 0 && stats.answered === 0) return `Company search didn't answer: ${[...stats.errors.values()].join("; ") || "no engine replied"}.`;
    state.note = ending || searchEnd(stats, queries.length);
    return undefined;
  }

  /**
   * An enrich run: read each lead's own website and fill in the routes, place and signals it publishes. It only fills in contacts, so it
   * works whatever state its offer is in: the offer's approved packet, when there is one, is quoted and guesses the category. Returns why it failed, if it did.
   */
  async function enrichLeads(ctx: SalesCtx, run: AppDocument, state: RunState, controller: AbortController, offer?: RunOffer): Promise<string | undefined> {
    const signal = controller.signal;
    const skip = (reason: Reason) => state.reasons.set(reason, (state.reasons.get(reason) ?? 0) + 1);
    const targets = await enrichTargets(ctx, run);
    const categories = categoriesOf(run, offer?.packet);
    const lookFor = offerSignals(offer?.packet?.signals.lookFor ?? []);
    await eachAtMost(targets, SITES_AT_ONCE, (target) => guarded(run, state, signal, async () => {
      if (!(await stillOurs(run, controller))) return;
      state.found++;
      const homes = homesOf(typeof target.website === "string" ? target.website : "");
      const host = homes[0] ? hostOf(homes[0]) : undefined;
      state.note = `${state.offer ? `Looking up leads for ${state.offer}: reading` : "Reading"} ${host ?? "a lead's website"} (${state.found} of ${targets.length})`;
      if (!host) { skip("no_website"); return; }
      if (isNotCompanyHost(host)) { skip("not_company"); return; }
      const read = await readSite(reader, homes, AbortSignal.any([signal, AbortSignal.timeout(siteBudgetMs)]));
      if (signal.aborted) return;
      state.crawled++;
      if (!read.pages.length) { skip(read.failure ? reasonOf(read.failure) : "unreachable"); return; }
      const facts = siteFacts({ pages: read.pages, categories: typeof target.category === "string" ? [] : categories, signals: lookFor });
      if (facts.notCompany) { skip("not_company"); return; }
      const { evidence, observedSignal } = evidenceOf(facts, new Date().toISOString());
      // enrichEngineLead merges routes by value and fills only the fields that are empty: nothing people typed is overwritten.
      const result = await enrichEngineLead(ctx, run, { leadId: target.leadId, contactRoutes: routesOf(facts), ...(evidence.length ? { evidence } : {}), ...(observedSignal ? { observedSignal } : {}), ...placeOf(facts) }, "finder");
      if ("skipped" in result) skip(result.skipped.reason);
      else if (result.updated.routesAdded || result.updated.fieldsFilled.length || result.updated.evidenceAdded) state.added++;
      else skip("nothing_new");
    }));
    state.note = targets.length ? "" : "None of the run's leads can be looked up any more (deleted or on the do-not-contact list).";
    return undefined;
  }

  /** The server is stopping: the run goes back to the queue, to be started again by whichever worker takes it next. */
  async function release(run: AppDocument, state: RunState): Promise<RunSummary> {
    const at = new Date();
    const changed = await runs.updateOne({ _id: run._id, ...ours }, { $set: { status: "queued", note: RESTART_NOTE, updatedAt: at }, $unset: { claimedBy: "", workerId: "", claimedAt: "", heartbeatAt: "", progress: "" } }).catch(() => ({ matchedCount: 0 }));
    if (changed.matchedCount) await record("sales.finder.release", run, { found: state.found, added: state.added }).catch(() => undefined);
    return { runId: String(run._id), kind: run.kind === "enrich" ? "enrich" : "find", status: "released", found: state.found, added: state.added, skipped: Math.max(0, state.found - state.added), note: RESTART_NOTE };
  }

  /** The loop: every 30 seconds, take runs one after another until none is left. */
  function start(): void {
    if (timer || stopped) return;
    const tick = async () => {
      if (ticking || stopped) return;
      ticking = true;
      try { while (!stopped && await runOnce()) { /* the next run straight away */ } }
      catch (error) { log({ level: "warn", event: "sales.finder.loop_failed", message: messageOf(error) }); }
      finally { ticking = false; }
    };
    timer = setInterval(() => void tick(), options.pollMs ?? POLL_MS);
    timer.unref();
    log({ level: "info", event: "sales.finder.started", workerId });
    void tick();
  }

  /** Stops the loop; a run in progress goes back to the queue (waiting up to 10 seconds for it to let go). */
  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearInterval(timer);
    const running = current;
    if (!running) return;
    running.controller.abort(new Halt("stop"));
    await Promise.race([running.done.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
  }

  return { runOnce, start, stop, workerId };
}

/** A site the run should not read at all: one the finder added to this venture before, a company domain the venture already has, or one on the do-not-contact list. */
async function knownSite(ctx: SalesCtx, ventureId: string, site: Candidate): Promise<"duplicate" | "do_not_contact" | null> {
  const leads = ctx.db.collection("opportunities");
  if (await leads.findOne({ workspaceId: ctx.workspaceId, ventureId, "externalRef.system": FINDER_SYSTEM, "externalRef.id": site.domain }, { projection: { _id: 1 } })) return "duplicate";
  const domain = normalizeDomain(site.domain);
  const domainKey = domain && !isSharedDomain(domain) ? suppressionKey("domain", domain) : null;
  const company = normalizeCompany(guessCompany(site.title, site.domain));
  if (await suppressedBy(ctx, [domainKey, company ? suppressionKey("company", company) : null].filter((key): key is string => Boolean(key)))) return "do_not_contact";
  if (domainKey && await leads.findOne({ workspaceId: ctx.workspaceId, ventureId, suppressKeys: domainKey }, { projection: { _id: 1 } })) return "duplicate";
  return null;
}

const capNote = (stats: SearchStats) => [...stats.capped].map((engine) => `${engine === "exa" ? "Exa" : "TinyFish"} has used this workspace's ${engine === "exa" ? "monthly" : "daily"} allowance.`).join(" ");
/** Why the searches ended before the limit was reached. */
function searchEnd(stats: SearchStats, queries: number): string {
  if (stats.capped.size) return capNote(stats);
  if (stats.errors.size && [...stats.failures.values()].every((count) => count >= 3)) return `Company search stopped answering: ${[...stats.errors.values()].join("; ")}.`;
  return `Every search was used (${plural(queries, "search", "searches")}).`;
}

/** The run's result in one paragraph: the offer it worked for, what was read and added, why the rest was skipped, and why it ended. */
function resultNote(kind: "find" | "enrich", state: RunState, ending: string): string {
  const skipped = [...state.reasons].filter(([, count]) => count > 0).map(([reason, count]) => `${count} ${REASON_TEXT[reason]}`);
  const offer = state.offer ? (kind === "find" ? `Searched for ${state.offer}.` : `Looked up leads for ${state.offer}.`) : "";
  const head = kind === "find"
    ? `Looked at ${plural(state.found, "company site")} and read ${state.crawled}: added ${plural(state.added, "lead")}.`
    : `Looked at ${plural(state.found, "lead")} and read ${plural(state.crawled, "website")}: filled in ${state.added}.`;
  return [offer, head, skipped.length ? `Skipped: ${skipped.join(", ")}.` : "", ending].filter(Boolean).join(" ");
}
