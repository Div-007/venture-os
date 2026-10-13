import type { CelebrationFeed } from "@venture-studio/contracts";

/**
 * The words of the celebration film: hype words for the montage's quick cuts, facts turned into punches ("2 DAYS EARLY"),
 * a library of encouraging lines for the moment that matters, and a sign-off. Lines are chosen for what actually
 * happened (early, late, right first time, a streak, a milestone, the time of day), with a mix of general ones, and
 * the ones seen recently in this browser are left out so the film doesn't repeat itself.
 */

export type CelebrationFacts = {
  /** The person's first name. */
  first: string;
  /** Tasks in this celebration. */
  count: number;
  /** Minutes handed in ahead of the due date (negative when late), for the first task. */
  early?: number;
  firstTime: boolean;
  /** First name of whoever approved it. */
  reviewer?: string;
  streak: number;
  finished: number;
  thisWeek: number;
  /** A big task: four hours or more, or high or urgent priority. */
  big: boolean;
  hour: number;
  weekday: number;
};

/** What happened, from a celebration feed: the newest task is the headline. */
export function celebrationFacts(feed: CelebrationFeed, now: Date): CelebrationFacts {
  const lead = feed.items[feed.items.length - 1];
  return {
    first: feed.name.split(/\s+/)[0] ?? "", count: feed.items.length, early: lead?.minutesEarly, firstTime: Boolean(lead?.firstTimeRight),
    reviewer: lead?.approvedBy?.name.split(/\s+/)[0], streak: feed.stats.onTimeStreak, finished: feed.stats.finished, thisWeek: feed.stats.thisWeek,
    big: (lead?.estimatedMinutes ?? 0) >= 240 || lead?.priority === "high" || lead?.priority === "urgent",
    hour: now.getHours(), weekday: now.getDay(),
  };
}

type Line = { text: string; when?: (facts: CelebrationFacts) => boolean };

const MILESTONES = new Set([5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000]);
const isEarly = (facts: CelebrationFacts) => (facts.early ?? 0) >= 60;
const isOnTime = (facts: CelebrationFacts) => facts.early !== undefined && facts.early > -60 && facts.early < 60;
const isLate = (facts: CelebrationFacts) => (facts.early ?? 0) <= -60;
const night = (facts: CelebrationFacts) => facts.hour >= 21 || facts.hour < 5;

/** The heart of the film: one of these, read out word by word. */
const LINES: Line[] = [
  // For anything.
  { text: "Momentum looks good on you, {first}." },
  { text: "One more brick in something big." },
  { text: "Small wins stack up. This was one." },
  { text: "That's how it's done." },
  { text: "You said you'd do it. You did it." },
  { text: "Quietly excellent work, {first}." },
  { text: "Another one off the list. Feels good, doesn't it?" },
  { text: "The team is better for this one." },
  { text: "Done is a beautiful word." },
  { text: "Keep this energy." },
  { text: "Future you says thank you." },
  { text: "That's a win. Take a second to enjoy it." },
  { text: "Work like this moves the needle." },
  { text: "Consistency is a superpower. You've got it." },
  { text: "Another promise kept." },
  { text: "This is what progress looks like." },
  { text: "Good work compounds. Keep stacking." },
  { text: "The best kind of tick in the box." },
  { text: "You make hard things look routine." },
  { text: "Ship it, celebrate it, do it again." },
  { text: "Your work speaks for itself." },
  { text: "One task closer to the big picture." },
  { text: "That's the standard. You set it." },
  { text: "Head down, job done. Respect." },
  { text: "Every finished task is a vote for who you're becoming." },
  { text: "You turned a plan into a result." },
  { text: "Ideas are cheap. Finished work isn't." },
  { text: "Somebody's day just got easier because of you." },
  { text: "Here's to doing what you said you'd do." },
  { text: "Clean finish, {first}." },
  { text: "Results over noise. Well played." },
  { text: "That one's in the books." },
  { text: "You're building a habit of winning." },
  { text: "Steady hands, solid work." },
  { text: "Take the win. You earned it." },
  { text: "Not luck. Craft." },
  { text: "Brick by brick, {first}." },
  { text: "Another chapter closed. On to the next." },
  { text: "This is how big things get built: one finished task at a time." },
  { text: "Discipline looks a lot like this." },
  { text: "Less talk, more done. Love to see it." },
  { text: "You showed up and delivered. That's everything." },
  { text: "The work is the reward. This is the bonus." },
  { text: "Proof that it gets done when you're on it." },
  { text: "What a finish, {first}." },
  // Early.
  { text: "{early} early. The deadline never stood a chance.", when: isEarly },
  { text: "Ahead of schedule and making it look easy.", when: isEarly },
  { text: "Early is the new on time. You're the proof.", when: isEarly },
  { text: "Done {early} ahead. That's a power move.", when: isEarly },
  { text: "When the deadline shows up, it'll find this already done.", when: isEarly },
  { text: "{early} to spare. Spend it well.", when: isEarly },
  { text: "You didn't just meet the deadline. You lapped it.", when: isEarly },
  { text: "Ahead of time, ahead of the game.", when: isEarly },
  // On time.
  { text: "Right on time. Reliable is a superpower.", when: isOnTime },
  { text: "Deadline met. Promise kept.", when: isOnTime },
  { text: "Clockwork, {first}.", when: isOnTime },
  { text: "Bang on schedule.", when: isOnTime },
  { text: "Exactly when it was needed. That's trust, earned.", when: isOnTime },
  { text: "The deadline and you: perfectly in sync.", when: isOnTime },
  // Late, and still worth celebrating.
  { text: "Late, but landed. That's what counts.", when: isLate },
  { text: "It's over the line. Next one, earlier. You've got this.", when: isLate },
  { text: "Done beats perfect. Onward.", when: isLate },
  { text: "Finished is finished. Proud of you for seeing it through.", when: isLate },
  { text: "Some tasks fight back. You won anyway.", when: isLate },
  { text: "Over the line. Catch your breath, then catch the next one early.", when: isLate },
  // Right first time.
  { text: "Approved first time. No notes.", when: (facts) => facts.firstTime },
  { text: "Right the first time. That's craft.", when: (facts) => facts.firstTime },
  { text: "Zero revisions. Chef's kiss.", when: (facts) => facts.firstTime },
  { text: "First try, nailed it.", when: (facts) => facts.firstTime },
  { text: "Nothing to fix. Not a thing.", when: (facts) => facts.firstTime },
  { text: "One and done. Clean.", when: (facts) => facts.firstTime },
  { text: "Flawless the first time round.", when: (facts) => facts.firstTime },
  // Approved by someone.
  { text: "{reviewer} gave it the nod. Big tick.", when: (facts) => Boolean(facts.reviewer) },
  { text: "Signed off by {reviewer}. Quality, confirmed.", when: (facts) => Boolean(facts.reviewer) },
  { text: "Passed {reviewer}'s review with flying colours.", when: (facts) => Boolean(facts.reviewer) },
  { text: "{reviewer} says yes. So do we.", when: (facts) => Boolean(facts.reviewer) },
  { text: "Even {reviewer} is impressed.", when: (facts) => Boolean(facts.reviewer) },
  // A streak.
  { text: "{streak} on time in a row. You're on a roll.", when: (facts) => facts.streak >= 3 },
  { text: "That's {streak} straight on time. Don't stop now.", when: (facts) => facts.streak >= 3 },
  { text: "Streak: {streak}. Who's counting? We are.", when: (facts) => facts.streak >= 3 },
  { text: "{streak} in a row, all on time. Unstoppable.", when: (facts) => facts.streak >= 3 },
  { text: "Your on-time streak just hit {streak}. Legendary.", when: (facts) => facts.streak >= 5 },
  // Milestones.
  { text: "Your first one! Welcome to the board, {first}.", when: (facts) => facts.finished === 1 },
  { text: "Task number one. Every legend starts somewhere.", when: (facts) => facts.finished === 1 },
  { text: "Task #{n}. Look how far you've come.", when: (facts) => MILESTONES.has(facts.finished) },
  { text: "That's {n} tasks done. Milestone unlocked.", when: (facts) => MILESTONES.has(facts.finished) },
  { text: "{n} finished. Go on, take a bow.", when: (facts) => MILESTONES.has(facts.finished) },
  { text: "Number {n}! The team is lucky to have you.", when: (facts) => MILESTONES.has(facts.finished) },
  // A big week.
  { text: "{week} done this week. What a week.", when: (facts) => facts.thisWeek >= 3 },
  { text: "That's {week} this week. Somebody's on fire.", when: (facts) => facts.thisWeek >= 3 },
  { text: "{week} tasks this week and counting.", when: (facts) => facts.thisWeek >= 3 },
  // Several at once.
  { text: "{count} done at once. Who does that? You do.", when: (facts) => facts.count >= 2 },
  { text: "{count} tasks, one celebration. Efficient.", when: (facts) => facts.count >= 2 },
  { text: "Look at that stack: {count} done.", when: (facts) => facts.count >= 2 },
  { text: "Double the wins.", when: (facts) => facts.count === 2 },
  // A big one.
  { text: "That was a big one. Respect.", when: (facts) => facts.big },
  { text: "Heavy lift, clean landing.", when: (facts) => facts.big },
  { text: "Tough task, tougher you.", when: (facts) => facts.big },
  { text: "High stakes, handled.", when: (facts) => facts.big },
  // The time of day and the week.
  { text: "Burning the midnight oil, and it shows. Now go rest.", when: night },
  { text: "Late-night finish. Sleep well, you earned it.", when: night },
  { text: "Night owl mode: successful.", when: night },
  { text: "Done before most people's first coffee.", when: (facts) => facts.hour >= 5 && facts.hour < 9 },
  { text: "Early bird gets the win.", when: (facts) => facts.hour >= 5 && facts.hour < 9 },
  { text: "Finishing the week strong.", when: (facts) => facts.weekday === 5 },
  { text: "A Friday finish. Enjoy the weekend, you've earned it.", when: (facts) => facts.weekday === 5 },
  { text: "A weekend win. Don't forget to rest too.", when: (facts) => facts.weekday === 0 || facts.weekday === 6 },
  { text: "What a way to start the week.", when: (facts) => facts.weekday === 1 },
  { text: "Monday, handled.", when: (facts) => facts.weekday === 1 },
];

/** Big single words for the montage's quick cuts. */
const HYPE = ["SHIPPED", "NAILED IT", "DONE", "BOOM", "CLEAN", "SHARP", "LOCKED IN", "CRUSHED IT", "SORTED", "ON POINT", "DELIVERED", "BANG ON", "BULLSEYE", "TEXTBOOK", "SMOOTH", "SOLID", "FLAWLESS", "NEXT LEVEL", "LEGEND", "UNSTOPPABLE", "LET'S GO", "BIG WIN", "WRAPPED", "HANDLED", "IN THE BAG", "STELLAR", "PRO MOVE", "ELITE", "ON FIRE", "MVP", "CRISP", "NO NOTES", "HUGE", "ICONIC", "BRAVO", "WELL DONE", "YES!", "THAT'S IT", "SEALED", "TOP TIER", "CLUTCH", "SLICK", "SPOT ON", "WINNING", "GAME ON", "MAGIC", "PURE CLASS", "LEVEL UP"];

/** The last word on screen. */
const SIGNOFFS: Line[] = [
  { text: "Onward." }, { text: "Keep going." }, { text: "On to the next." }, { text: "More of this." }, { text: "Stay sharp." },
  { text: "Keep shipping." }, { text: "Proud of this one." }, { text: "Keep it rolling." }, { text: "Well played." },
  { text: "Go get the next one." }, { text: "That's the way." }, { text: "Again tomorrow?" },
  { text: "Keep the streak alive.", when: (facts) => facts.streak >= 2 },
  { text: "Now rest.", when: night },
  { text: "Have a great weekend.", when: (facts) => facts.weekday === 5 },
];

/** "45 minutes", "5 hours", "2 days". */
export function spellDuration(minutes: number) {
  const value = Math.abs(minutes);
  if (value < 90) return `${Math.max(1, Math.round(value))} minute${Math.round(value) === 1 ? "" : "s"}`;
  if (value < 36 * 60) { const hours = Math.round(value / 60); return `${hours} hour${hours === 1 ? "" : "s"}`; }
  const days = Math.round(value / 1440);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function fill(text: string, facts: CelebrationFacts) {
  return text
    .replaceAll("{first}", facts.first || "you")
    .replaceAll("{early}", spellDuration(facts.early ?? 0))
    .replaceAll("{reviewer}", facts.reviewer ?? "Your reviewer")
    .replaceAll("{streak}", String(facts.streak))
    .replaceAll("{n}", String(facts.finished))
    .replaceAll("{week}", String(facts.thisWeek))
    .replaceAll("{count}", String(facts.count))
    // A sentence never starts with a lower-case name placeholder's fallback.
    .replace(/^you\b/, "You");
}

/** One item, at random, weighted toward the ones that fit what happened, leaving out recent ones when it can. */
function pick(lines: Line[], facts: CelebrationFacts, random: () => number, recent: Set<string>) {
  const fitting = lines.filter((line) => !line.when || line.when(facts));
  const fresh = fitting.filter((line) => !recent.has(line.text));
  const pool = fresh.length ? fresh : fitting;
  const weights = pool.map((line) => (line.when ? 3 : 1));
  let roll = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < pool.length; index++) { roll -= weights[index]!; if (roll <= 0) return pool[index]!; }
  return pool[pool.length - 1]!;
}

/** What happened, as punches for the montage: "2 DAYS EARLY", "FIRST TRY", "5 IN A ROW", "#25". */
function factPunches(facts: CelebrationFacts) {
  const punches: string[] = [];
  if (isEarly(facts)) punches.push(`${spellDuration(facts.early!)} EARLY`.toUpperCase());
  else if (isOnTime(facts)) punches.push("RIGHT ON TIME");
  if (facts.firstTime) punches.push("FIRST TRY");
  if (facts.streak >= 2) punches.push(`${facts.streak} IN A ROW`);
  if (MILESTONES.has(facts.finished) || facts.finished === 1) punches.push(facts.finished === 1 ? "YOUR FIRST" : `#${facts.finished}`);
  if (facts.count >= 2) punches.push(`${facts.count} DONE`);
  if (facts.thisWeek >= 3) punches.push(`${facts.thisWeek} THIS WEEK`);
  return punches;
}

/** The film's words: four montage cuts, the line, and the sign-off, plus what was used (to keep them fresh next time). */
export function writeCelebration(facts: CelebrationFacts, random: () => number, recent: Set<string>) {
  const line = pick(LINES, facts, random, recent);
  const signoff = pick(SIGNOFFS, facts, random, recent);
  const punches = factPunches(facts).sort(() => random() - 0.5).slice(0, 2);
  const hype = HYPE.filter((word) => !recent.has(word)).sort(() => random() - 0.5);
  const fallback = HYPE.filter((word) => !hype.includes(word)).sort(() => random() - 0.5);
  const words = [...hype, ...fallback].filter((word) => !punches.includes(word)).slice(0, 4 - punches.length);
  // Facts land on the second and fourth cuts, the hype words around them.
  const cuts = punches.length === 2 ? [words[0]!, punches[0]!, words[1]!, punches[1]!] : punches.length === 1 ? [words[0]!, words[1]!, punches[0]!, words[2]!] : words;
  return { cuts, line: fill(line.text, facts), signoff: fill(signoff.text, facts), used: [line.text, signoff.text, ...words] };
}

const RECENT_KEY = "vso-celebration-recent";
/** Lines and words this browser has seen lately (the newest sixty). A convenience: storage failures just mean repeats. */
export function recentCelebrationWords(): Set<string> {
  try { return new Set(JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as string[]); } catch { return new Set(); }
}
export function rememberCelebrationWords(used: string[]) {
  try {
    const previous = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([...used, ...previous.filter((item) => !used.includes(item))].slice(0, 60)));
  } catch { /* Repeats are fine. */ }
}
