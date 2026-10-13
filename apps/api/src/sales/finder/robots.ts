// robots.txt for the built-in lead finder (RFC 9309): fetched once per site and kept for 24 hours in memory, and checked before every page.
// The finder obeys the group that names it (VentureStudioLeadFinder), else the "*" group; Allow and Disallow take "*" and "$", and the
// longest matching rule wins (Allow on a tie). A 4xx answer means no rules; a 5xx, a timeout or no answer means the site is not read this run.

/** The finder's product token, as robots.txt files name it. */
export const FINDER_TOKEN = "VentureStudioLeadFinder";
const DAY_MS = 24 * 3_600_000;
/** RFC 9309 asks crawlers to read at least 500 KiB of a robots.txt file; the rest is ignored. */
export const MAX_ROBOTS_BYTES = 500_000;

type Rule = { allow: boolean; length: number; glob: string };
export type RobotsRules = { rules: Rule[]; crawlDelayMs?: number };
type Group = { agents: string[]; rules: Rule[]; delay?: number };

// Rules and paths are compared with the same percent-encoding: non-ASCII characters encoded as UTF-8, escapes in upper case.
const encodePath = (value: string) => value.replace(/[^\x21-\x7e]/g, (char) => encodeURIComponent(char)).replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());

function ruleOf(allow: boolean, pattern: string): Rule {
  const value = encodePath(pattern);
  const anchored = value.endsWith("$");
  // A rule matches the start of a path, so a rule without "$" ends in an implied "*". Repeated stars are one star.
  const glob = `${anchored ? value.slice(0, -1) : `${value}*`}`.replace(/\*{2,}/g, "*");
  return { allow, length: value.length, glob };
}

/** Does `glob` ("*" is any run of characters, nothing else is special) match the whole of `text`? Greedy with one backtrack point: never exponential. */
function globMatch(glob: string, text: string): boolean {
  let g = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] !== "*" && glob[g] === text[t]) { g++; t++; }
    else if (g < glob.length && glob[g] === "*") { star = g++; mark = t; }
    else if (star !== -1) { g = star + 1; t = ++mark; }
    else return false;
  }
  while (g < glob.length && glob[g] === "*") g++;
  return g === glob.length;
}

/** The rules for the finder in a robots.txt file: the groups that name it (merged), or else the "*" groups. */
export function parseRobots(text: string, token = FINDER_TOKEN): RobotsRules {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "user-agent") {
      // Consecutive user-agent lines share one group; a user-agent line after a rule starts a new group.
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.split("/")[0]!.trim().toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    // An empty Disallow allows everything, so it adds no rule.
    if ((key === "allow" || key === "disallow") && value) current.rules.push(ruleOf(key === "allow", value.slice(0, 2_000)));
    else if (key === "crawl-delay") { const seconds = Number(value); if (Number.isFinite(seconds) && seconds > 0) current.delay = Math.max(current.delay ?? 0, seconds); }
  }
  const named = groups.filter((group) => group.agents.includes(token.toLowerCase()));
  const chosen = named.length ? named : groups.filter((group) => group.agents.includes("*"));
  const delay = Math.max(0, ...chosen.map((group) => group.delay ?? 0));
  return { rules: chosen.flatMap((group) => group.rules), ...(delay ? { crawlDelayMs: Math.round(delay * 1000) } : {}) };
}

/** May the finder fetch this path (with its query)? The longest matching rule decides; Allow wins a tie; no matching rule allows. */
export function robotsAllows(robots: RobotsRules, pathAndQuery: string): boolean {
  const path = encodePath(pathAndQuery || "/");
  if (path === "/robots.txt") return true;
  let best: Rule | undefined;
  for (const rule of robots.rules) {
    if (best && (rule.length < best.length || (rule.length === best.length && (best.allow || !rule.allow)))) continue;
    if (globMatch(rule.glob, path)) best = rule;
  }
  return best ? best.allow : true;
}

/** How a robots.txt request went: an HTTP answer (with the text when it was 2xx), or no answer at all (unsafe host, timeout, network error). */
export type RobotsAnswer = { status: number; text: string } | { failed: string };
export type RobotsFetch = (url: string, signal: AbortSignal) => Promise<RobotsAnswer>;
export type RobotsVerdict = { allowed: true; crawlDelayMs?: number } | { allowed: false; reason: string };
type Entry = { at: number; rules?: RobotsRules; down?: string; pending?: Promise<void> };

/** One robots.txt per site (scheme, host and port), fetched once and kept 24 hours; a site that did not answer stays closed until newRun(). */
export class RobotsCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly fetchRobots: RobotsFetch, private readonly now: () => number = Date.now, private readonly ttlMs = DAY_MS) {}

  async check(url: URL, signal: AbortSignal): Promise<RobotsVerdict> {
    const origin = url.origin;
    let entry = this.entries.get(origin);
    if (entry && !entry.pending && !entry.down && this.now() - entry.at > this.ttlMs) { this.entries.delete(origin); entry = undefined; }
    if (!entry) {
      const fresh: Entry = { at: this.now() };
      fresh.pending = this.load(origin, fresh, signal).finally(() => { delete fresh.pending; });
      this.entries.set(origin, fresh);
      entry = fresh;
    }
    if (entry.pending) await entry.pending;
    if (entry.down) return { allowed: false, reason: entry.down };
    if (!entry.rules) return { allowed: false, reason: "its robots.txt could not be read" };
    if (!robotsAllows(entry.rules, `${url.pathname}${url.search}`)) return { allowed: false, reason: "robots.txt asks crawlers not to read this page" };
    return { allowed: true, ...(entry.rules.crawlDelayMs ? { crawlDelayMs: entry.rules.crawlDelayMs } : {}) };
  }

  private async load(origin: string, entry: Entry, signal: AbortSignal): Promise<void> {
    let answer: RobotsAnswer;
    try { answer = await this.fetchRobots(`${origin}/robots.txt`, signal); }
    catch (error) {
      // The run was stopped while robots.txt was loading: forget the entry so the next run asks again.
      this.entries.delete(origin);
      throw error;
    }
    entry.at = this.now();
    if ("failed" in answer) entry.down = `its robots.txt did not answer (${answer.failed})`;
    else if (answer.status >= 200 && answer.status < 300) entry.rules = parseRobots(answer.text);
    // 429 asks us to slow down, so it closes the site like a server error; every other 4xx means there are no rules.
    else if (answer.status >= 400 && answer.status < 500 && answer.status !== 429) entry.rules = { rules: [] };
    else entry.down = `its robots.txt answered HTTP ${answer.status}`;
  }

  /** A new run: sites that did not answer robots.txt last time are asked again; rules that were read stay for their 24 hours. */
  newRun(): void {
    for (const [origin, entry] of this.entries) if (entry.down || (!entry.pending && this.now() - entry.at > this.ttlMs)) this.entries.delete(origin);
  }
}
