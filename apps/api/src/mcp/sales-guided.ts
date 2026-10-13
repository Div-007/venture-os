// The guided conversation of the Dealflow Sales connector. Every result carries `say` (one or two plain sentences for the person) and `next`
// (up to three options to offer as a numbered list, the first being the suggestion), so the chat stays steady without the person having to know
// the tools. Instructions to Claude itself, which the older results carried as `next` text, travel as `then`.

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The most one suggestion takes on at once. A list of 1,522 leads is worked 25 at a time, so no option ever says "research 1,522". */
export const BATCH = 25;
/** "4 drafts", or "the first 25 of 300 drafts" when there are more than one go. */
export const batchOf = (count: number, one: string, many = `${one}s`) => (count > BATCH ? `the first ${BATCH} of ${count} ${many}` : plural(count, one, many));
/** The same with a leading "the": "the 4 drafts" or "the first 25 of 300 drafts". */
export const theBatch = (count: number, one: string, many = `${one}s`) => (count > BATCH ? batchOf(count, one, many) : `the ${plural(count, one, many)}`);

export type Guided = { say: string; next: string[] };

/**
 * How a result should be shown (owner: data as visuals, never walls of text). `card`: the chat app draws the card (set when it announced MCP
 * Apps). `artifact_or_table`: this connection can't tell which chat app it is: the instructions decide (an artifact on claude.ai, a compact text
 * table in a terminal). `artifact_or_text`: the same for one record, where a short text block is fine. `rows` is how many rows the list holds.
 */
export function viewHint(title: string, rows?: number, one = false): { present: "artifact_or_table" | "artifact_or_text"; title: string; rows?: number } {
  return { present: one ? "artifact_or_text" : "artifact_or_table", title: title.slice(0, 100), ...(rows !== undefined ? { rows } : {}) };
}

/** "Good morning, Divyansh." in the sales time zone (Asia/Kolkata unless told otherwise). */
export function greeting(fullName: string | undefined, timeZone: string, now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? `Good ${part}, ${first}.` : `Good ${part}.`;
}

/** What is waiting, in one line: "2 replies waiting, 10 drafts to review and 1 call due." */
export function waitingLine(counts: Record<string, number>): string {
  const parts = [
    counts.replies ? `${plural(counts.replies, "reply", "replies")} waiting` : "",
    counts.callsDue ? `${plural(counts.callsDue, "call")} due` : "",
    counts.toReview ? `${plural(counts.toReview, "draft")} to review` : "",
    counts.followUpsDue ? `${plural(counts.followUpsDue, "follow-up")} due` : "",
    counts.needsYou ? `${plural(counts.needsYou, "verdict")} for you to decide` : "",
    counts.wonToHandOver ? `${plural(counts.wonToHandOver, "won deal")} to hand over` : "",
  ].filter(Boolean);
  if (!parts.length) return "Nothing urgent is waiting.";
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`.replace(/^./, (letter) => letter.toUpperCase());
}

/** A city and how many of the new leads are there. The counts come from the facets route over the whole set, never from one page of leads. */
export type CityCount = { city: string; count: number };

const orList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? ""));

// Control characters, bidi overrides and zero-width characters.
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
/**
 * A place (or other stored label) as it may appear in a `next` option, which a card turns into a button's request: one line, no hidden
 * characters, at most 40 characters. Cities come from the facets of our own leads, but people and imports typed them.
 */
export function optionLabel(value: string, max = 40): string {
  const text = value.replace(/\s+/g, " ").replace(HIDDEN, "").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The research suggestion, by batch and never by total. `cities` is the busiest cities of all the new leads, biggest first.
 * Up to one batch: "Research the 4 new Raipur leads". More: "Research the newest leads: Indore (101), Raipur (94) or Nagpur (74). Say a city and I'll take the first 25".
 */
export function researchOption(total: number, cities: CityCount[] = []): string {
  const top = cities.map((row) => ({ ...row, city: optionLabel(row.city) })).filter((row) => row.city && row.count > 0).slice(0, 3);
  if (total <= BATCH) {
    if (top.length === 1 && top[0]!.count >= total) return `Research the ${plural(total, `new ${top[0]!.city} lead`)}`;
    if (top.length > 1) return `Research the ${plural(total, "new lead")} (${top.map((row) => `${row.city} ${row.count}`).join(", ")})`;
    return `Research the ${plural(total, "new lead")}`;
  }
  if (top.length > 1) return `Research the newest leads: ${orList(top.map((row) => `${row.city} (${row.count})`))}. Say a city and I'll take the first ${BATCH}`;
  if (top.length === 1 && top[0]!.count >= total) return `Research ${batchOf(total, `new ${top[0]!.city} lead`)}`;
  return `Research ${batchOf(total, "new lead")}`;
}

/** `noOffer`: the person's ventures have no offer set up yet (docs/sales-offers.md), so setting one up is offered once nothing more urgent waits. */
type StartInput = { mode: "work" | "review"; counts: Record<string, number>; stageCounts?: Record<string, number>; cities?: CityCount[]; newLeads?: number; noOffer?: boolean };

/** The session's three options, tied to what is really waiting. The first is the suggestion. */
export function startNext({ mode, counts, cities, newLeads, noOffer }: StartInput): string[] {
  if (mode === "review") {
    if (counts.toReview) return [`Review ${theBatch(counts.toReview, "draft")} waiting`, "Look at the first draft before I review it", "See which of them are for the first batch of a play"];
    return ["Nothing is waiting for review yet: write some drafts in a work chat first", "See what is ready to send", "Go back to today's overview"];
  }
  const options: string[] = [];
  if (counts.replies) options.push(`Sort ${theBatch(counts.replies, "reply", "replies")} waiting (warm replies are due within 2 working hours)`);
  if (counts.callsDue) options.push(counts.callsDue > BATCH ? `Plan the first ${BATCH} of today's ${counts.callsDue} calls` : `Plan today's ${plural(counts.callsDue, "call")}`);
  if (counts.toReview) options.push(`Get ${theBatch(counts.toReview, "draft")} waiting reviewed (open a new chat and say “review drafts”)`);
  if (counts.followUpsDue) options.push(`Write the one follow-up for ${batchOf(counts.followUpsDue, "lead")} that went quiet`);
  if (newLeads) options.push(researchOption(newLeads, cities));
  if (counts.needsYou) options.push(`Go through ${theBatch(counts.needsYou, "verdict")} that need your decision`);
  if (counts.wonToHandOver) options.push(`Hand over ${batchOf(counts.wonToHandOver, "won deal")} to delivery`);
  if (noOffer) options.push("Set up the first offer: tell me what you sell and who buys it");
  for (const fallback of ["Find new leads: tell me the area and the kind of business", "Plan the next play", "Look at what is working this week"]) if (options.length < 3) options.push(fallback);
  return options.slice(0, 3);
}

/** "Dealer Commerce", "Dealer Commerce and Startup Partner", "A, B and C". */
const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/**
 * The welcome: greeting, then one line on what is waiting, and the offer being worked on (`offers`: the active, approved ones in scope;
 * "Working on Dealer Commerce." for one, "Offers: A and B, say which to work on." for several). In a review session it says what the chat is for.
 */
export function startSay(input: { name: string | undefined; timeZone: string; mode: "work" | "review"; counts: Record<string, number>; offers?: string[]; now?: Date }): string {
  const hello = greeting(input.name, input.timeZone, input.now);
  if (input.mode === "review") {
    return `${hello} This chat is for reviewing drafts only: I check each one and pass it or send it back with the exact fixes, and I never rewrite them. ${input.counts.toReview ? `${plural(input.counts.toReview, "draft")} ${input.counts.toReview === 1 ? "is" : "are"} waiting for review.` : "Nothing is waiting for review right now."}`;
  }
  const offers = (input.offers ?? []).map((name) => optionLabel(name, 60)).filter(Boolean);
  const working = offers.length === 1 ? ` Working on ${offers[0]}.` : offers.length > 1 ? ` Offers: ${andList(offers.slice(0, 4))}${offers.length > 4 ? " and more" : ""}; say which to work on.` : "";
  return `${hello} Welcome to Dealflow Sales: I research and judge leads and write drafts, and you send and approve everything. ${waitingLine(input.counts)}${working}`;
}

/**
 * What the person sees when the app refuses a write (403 or 409): one plain sentence on what only a person can do, and the app link to do it.
 * `why` keeps the app's own words for Claude.
 */
export function refusalGuide(origin: string, input: Record<string, unknown>, status: number, message: string): Record<string, unknown> {
  const clean = message.replace(/\s+/g, " ").trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const person = status === 403 || /\b(person|owner|head)\b/i.test(clean);
  const say = person && !/in the app/i.test(first) ? `${first} A person has to do this in the app.` : first;
  const id = (key: string) => (typeof input[key] === "string" ? encodeURIComponent(String(input[key])) : undefined);
  const url = id("leadId") ? `${origin}/sales/live/leads?lead=${id("leadId")}` : id("draftId") ? `${origin}/sales/live/review?draft=${id("draftId")}` : `${origin}/sales/live`;
  return { refused: true, say, next: ["Open it in the app", "Carry on with the next lead", "See what else is waiting"], why: clean, url };
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "Monday to Saturday", "Monday, Wednesday and Friday": ISO weekdays (1 = Monday) in words. */
export function weekdays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length > 2 && sorted.at(-1)! - sorted[0]! === sorted.length - 1) return `${DAY_NAMES[sorted[0]! - 1]} to ${DAY_NAMES[sorted.at(-1)! - 1]}`;
  const names = sorted.map((day) => DAY_NAMES[day - 1]).filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/** One venture's working rules in a sentence for Claude: days, blackout, timing, daily caps, channels and who approves messages. */
export function settingsLine(venture: string, settings: Record<string, any>): string {
  const caps = settings.dailyCaps ?? {};
  const channels = ((settings.allowedChannels as string[] | undefined) ?? []).join(", ");
  const blackout = Array.isArray(settings.blackoutDates) ? settings.blackoutDates.length : 0;
  return `${venture}: working days are ${weekdays(settings.workingDays ?? [])}${blackout ? ` (${blackout} blackout dates with no follow-ups)` : ""}; follow up after ${settings.followUpAfterWorkingDays} working days and answer warm replies within ${settings.replySlaHours} working hours; daily caps per person: ${caps.email ?? "?"} emails and ${caps.whatsapp ?? "?"} WhatsApp messages; allowed channels: ${channels}; ${settings.approvalMode === "person_approves_every_message" ? "a person reads every message before it goes out" : "Claude's review is enough once a play's first batch has been read"}. Draft only for these channels, and don't plan more than the caps.`;
}

/** Puts `say` and `next` first in a result and keeps everything else as it was. */
export function guided<T extends Record<string, unknown>>(say: string, next: string[], value: T): { say: string; next: string[] } & T {
  return { say, next: next.slice(0, 3), ...value };
}
