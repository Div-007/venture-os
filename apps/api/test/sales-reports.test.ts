import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after } from "node:test";
import express from "express";
import { daybreakSchema, opportunitySchema, salesReportSchema, successEnvelope } from "@venture-studio/contracts";
import { loadConfig } from "../src/config.js";
import { connectDatabase, type Database } from "../src/db.js";
import { createErrorHandler } from "../src/errors.js";
import { ensureIndexes } from "../src/indexes.js";
import { actorFor } from "../src/middleware.js";
import { salesRoutes } from "../src/routes/sales.js";
import { salesReportsRoutes } from "../src/routes/sales-reports.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { LocalObjectStore } from "../src/storage.js";
import { bucketExitReason, rateOf, reportRange, signalKeywords, statOf, workingHoursBetween } from "../src/sales/reports.js";
import { isWorkingDay, localDay, shiftDate, startOfLocalDay } from "../src/sales/workdays.js";

// Reports and Daybreak (docs/sales-reports-and-daybreak.md): pure helpers first, then the two routes on a throwaway database.

const ist = (day: string, hour = 10, minute = 0) => new Date(Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`));
const HOUR = 3_600_000;
const DAY = 86_400_000;

test("honest numbers: no share, median or average below 5 cases, and small samples are marked below 30", () => {
  assert.deepEqual(rateOf(2, 4), { count: 2, n: 4, value: null, small: true });
  assert.deepEqual(rateOf(3, 5), { count: 3, n: 5, value: 0.6, small: true });
  assert.deepEqual(rateOf(10, 30), { count: 10, n: 30, value: 0.333, small: false });
  assert.deepEqual(rateOf(0, 0), { count: 0, n: 0, value: null, small: true });
  assert.deepEqual(statOf([1, 2, 3, 4], "median"), { value: null, n: 4, small: true });
  assert.deepEqual(statOf([5, 1, 3, 2, 4], "median"), { value: 3, n: 5, small: true });
  assert.equal(statOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "p90").value, 9.1);
  assert.equal(statOf([2, 4, 6, 8, 10], "mean").value, 6);
});

test("working hours between two moments skip nights, Sundays and the festival blackout", () => {
  // Saturday 18:00 to Monday 10:30 IST: one hour on Saturday, half an hour on Monday.
  assert.equal(workingHoursBetween(ist("2026-10-10", 18), ist("2026-10-12", 10, 30)), 1.5);
  assert.equal(workingHoursBetween(ist("2026-10-12", 12), ist("2026-10-12", 15)), 3);
  assert.equal(workingHoursBetween(ist("2026-10-12", 20), ist("2026-10-13", 9)), 0);
  // Monday 19 Oct 18:00 to Wednesday 21 Oct 11:00: Tuesday 20 Oct is a blackout day.
  assert.equal(workingHoursBetween(ist("2026-10-19", 18), ist("2026-10-21", 11)), 2);
  assert.equal(workingHoursBetween(ist("2026-10-12", 15), ist("2026-10-12", 12)), 0);
});

test("the report period: whole days in the time zone, the last 30 days by default, at most a year", () => {
  const now = new Date("2026-10-09T08:00:00Z");
  const fallback = reportRange({}, "Asia/Kolkata", now);
  assert.deepEqual([fallback.from.toISOString(), fallback.to.toISOString()], ["2026-09-09T08:00:00.000Z", now.toISOString()]);
  const days = reportRange({ from: "2026-10-01", to: "2026-10-07" }, "Asia/Kolkata", now);
  assert.deepEqual([days.from.toISOString(), days.to.toISOString()], [ist("2026-10-01", 0).toISOString(), ist("2026-10-08", 0).toISOString()]);
  assert.equal(reportRange({ from: "2026-10-01", to: "2026-10-01" }, "UTC", now).to.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(reportRange({ from: "2026-10-01T00:00:00Z", to: "2026-10-02T12:00:00+05:30" }, "UTC", now).to.toISOString(), "2026-10-02T06:30:00.000Z");
  assert.throws(() => reportRange({ from: "2026-10-08", to: "2026-10-01" }, "UTC", now), /before/);
  assert.throws(() => reportRange({ from: "2025-01-01", to: "2026-10-01" }, "UTC", now), /one year/);
  assert.doesNotThrow(() => reportRange({ from: "2025-10-02", to: "2026-10-01" }, "UTC", now));
  assert.throws(() => reportRange({ from: "2026-02-30" }, "UTC", now), /real date/);
  assert.throws(() => reportRange({ to: "yesterday" }, "UTC", now), /YYYY-MM-DD/);
});

test("exit reasons fall into the lost-reason buckets and signals into keywords", () => {
  assert.equal(bucketExitReason("Too expensive for them"), "price");
  assert.equal(bucketExitReason("No budget this year"), "no_budget");
  assert.equal(bucketExitReason("Not interested on call"), "no_need");
  assert.equal(bucketExitReason("Went with another vendor"), "chose_competitor");
  assert.equal(bucketExitReason("Stopped answering after the demo"), "no_response");
  assert.equal(bucketExitReason("Moved away"), "other");
  assert.deepEqual(signalKeywords("Hiring sales staff for the new Raipur branch (2026)"), ["hiring", "sales", "staff", "raipur", "branch"]);
  assert.deepEqual(signalKeywords(""), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// API tests on a real MongoDB (set TEST_MONGODB_URI); a throwaway database that is dropped at the end
// ---------------------------------------------------------------------------------------------------------------------

type Who = "admin" | "head" | "contrib" | "contrib2" | "learner" | "outsider";
type Reply = { status: number; body: any; data: any };
type Harness = { database: Database; call: (who: Who, method: string, path: string, body?: unknown, options?: { via?: "claude" }) => Promise<Reply>; server: Server };

const mongoUrl = process.env.TEST_MONGODB_URI;
const suffix = randomUUID().slice(0, 6);
let harness: Promise<Harness> | undefined;
let counter = 0;
const VENTURES = ["venture-r1", "venture-r2", "venture-r3", "venture-r4"];

async function setup(): Promise<Harness> {
  const dbName = `vso_test_reports_${suffix}`;
  assert.match(dbName, /^vso_test_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  const db = database.db;
  await ensureIndexes(db);
  const now = new Date();
  await db.collection("workspaces").insertOne({ _id: "workspace-a", name: "A", slug: "a", createdAt: now });
  await db.collection("ventures").insertMany([...VENTURES, "venture-o"].map((id) => ({ _id: id, workspaceId: "workspace-a", name: id.replace("venture-", "Venture "), status: "active", createdAt: now })));
  await db.collection("pipelines").insertMany([...VENTURES, "venture-o"].map((id) => ({ _id: id.replace("venture", "pipeline"), workspaceId: "workspace-a", ventureId: id, name: "Leads", offerName: "Offer", status: "active", createdAt: now, updatedAt: now })));
  const people: [Who, string, string[]][] = [
    ["admin", "admin", []], ["head", "venture_head", VENTURES], ["contrib", "contributor", VENTURES], ["contrib2", "contributor", ["venture-r1"]], ["learner", "learner", ["venture-r1", "venture-r4"]], ["outsider", "contributor", ["venture-o"]],
  ];
  await db.collection("users").insertMany(people.map(([handle]) => ({ _id: `user-${handle}`, workspaceId: "workspace-a", email: `${handle}@example.invalid`, name: handle, handle, status: "active", createdAt: now, updatedAt: now })));
  await db.collection("memberships").insertMany(people.map(([handle, role, ventureIds]) => ({ _id: `membership-${handle}`, workspaceId: "workspace-a", userId: `user-${handle}`, role, ventureIds, groupIds: [], status: "active", createdAt: now, updatedAt: now })));

  // The Sales routes and the reports behind a small stand-in for sign-in: `x-test-user` is the person, `x-test-via: claude` is the connector.
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    try {
      req.id = randomUUID();
      req.interfaceChannel = req.headers["x-test-via"] === "claude" ? "mcp" : "api";
      const user = await db.collection("users").findOne({ _id: String(req.headers["x-test-user"]) });
      if (user) req.actor = await actorFor(db, { id: String(user._id), email: String(user.email), name: String(user.name) });
      next();
    } catch (error) { next(error); }
  });
  app.use("/v1", salesRoutes(database));
  app.use("/v1/sales", salesReportsRoutes(database));
  app.use(createErrorHandler(db));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const call: Harness["call"] = async (who, method, path, body, options = {}) => {
    const response = await fetch(`${origin}/v1${path}`, { method, headers: { "content-type": "application/json", "x-test-user": `user-${who}`, ...(options.via === "claude" ? { "x-test-via": "claude" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json().catch(() => null) as any;
    return { status: response.status, body: json, data: json?.data };
  };
  return { database, call, server };
}

const getHarness = () => (harness ??= setup());
after(async () => {
  if (!harness) return;
  const { server, database } = await harness;
  server.close();
  await once(server, "close");
  await database.native.dropDatabase();
  await database.client.close();
});

const skip = { skip: !mongoUrl };
const expectStatus = (reply: Reply, status: number) => { assert.equal(reply.status, status, JSON.stringify(reply.body)); return reply; };
const report = async (h: Harness, who: Who, query: string) => salesReportSchema.parse(expectStatus(await h.call(who, "GET", `/sales/reports?${query}`), 200).data);
const daybreak = async (h: Harness, who: Who, query: string) => daybreakSchema.parse(expectStatus(await h.call(who, "GET", `/sales/daybreak?${query}`), 200).data);

async function newLead(h: Harness, ventureId: string, extra: Record<string, unknown> = {}, options?: { via?: "claude" }) {
  const n = ++counter;
  const reply = expectStatus(await h.call("contrib", "POST", "/sales/leads", {
    pipelineId: ventureId.replace("venture", "pipeline"), companyName: `Kestrel${n}q Traders ${suffix}`, ownerId: "user-contrib",
    contactRoutes: [{ kind: "email", value: `owner${n}@kestrel${n}q.example` }, { kind: "phone", value: `98760${String(10000 + n)}` }], ...extra,
  }, options), 201);
  return opportunitySchema.parse(reply.data);
}
const log = async (h: Harness, leadId: string, body: Record<string, unknown>, who: Who = "contrib") => expectStatus(await h.call(who, "POST", `/sales/leads/${leadId}/activities`, { body: "", ...body }), 201).data;
const verdictBody = (decision: "recommend" | "hold" | "reject", confidence: "low" | "medium" | "high", extra: Record<string, unknown> = {}) => ({
  decision, confidence, offer: "Dealer ordering app", offerFit: "Sells through a dealer network", evidence: [{ claim: "Dealers", quote: "We supply dealers across the region", url: "https://example.com/about" }],
  against: "They may already use a portal", summary: `${decision}, ${confidence}`, ...extra,
});
const claudeVerdict = async (h: Harness, leadId: string, decision: "recommend" | "hold" | "reject", confidence: "low" | "medium" | "high", extra: Record<string, unknown> = {}) =>
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${leadId}/verdicts`, verdictBody(decision, confidence, extra), { via: "claude" }), 201).data.verdict;
const iso = (date: Date) => date.toISOString();

test("Reports: the funnel counts the leads that moved and how far each got, by source, play, owner and city; activity, aging and wins follow", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const play = expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-r1", name: "Raipur dealers" }), 201).data;
  const l1 = await newLead(h, "venture-r1", { city: "Raipur" });
  const l2 = await newLead(h, "venture-r1", { city: "raipur " });
  const l3 = await newLead(h, "venture-r1", { city: "Bhopal" }, { via: "claude" });
  const l4 = await newLead(h, "venture-r1", { city: "Indore", externalRef: { system: "dealflow-engine", id: `engine-${suffix}` } });
  const l5 = await newLead(h, "venture-r1", { playId: play.id, externalRef: { system: "dealflow-sqlite", id: `import-${suffix}` } });
  await log(h, l1.id, { kind: "email", direction: "out", body: "Hello" });
  await log(h, l1.id, { kind: "email", direction: "in", replyType: "interested", body: "Tell me more" });
  await log(h, l1.id, { kind: "call", callOutcome: "interested_book" });
  await log(h, l2.id, { kind: "call", callOutcome: "no_answer" });
  await log(h, l3.id, { kind: "call", callOutcome: "not_interested" });
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${l5.id}`, { stage: "proposal" }), 200);
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${l5.id}`, { stage: "invoice_contract", valueEstimateMinor: 5_000_000, currency: "INR" }), 200);

  const counts = async () => Object.fromEntries(await Promise.all(["opportunities", "sales_activities", "sales_drafts", "sales_verdicts", "audit_events"].map(async (name) => [name, await db.collection(name).countDocuments()] as const)));
  const before = await counts();
  const r = await report(h, "head", "ventureId=venture-r1");
  assert.deepEqual(await counts(), before, "a report writes nothing");
  assert.equal(r.funnel.active, 5);
  assert.deepEqual(r.funnel.stages.map((stage) => [stage.key, stage.leads, stage.entered]), [["new", 5, 5], ["contacted", 4, 4], ["talking", 2, 2], ["meeting", 2, 2], ["proposal", 1, 1], ["won", 1, 1]]);
  assert.equal(r.funnel.stages[0]!.conversion, null);
  assert.deepEqual(r.funnel.stages[1]!.conversion, { count: 4, n: 5, value: 0.8, small: true });
  assert.deepEqual(r.funnel.stages[2]!.conversion, { count: 2, n: 4, value: null, small: true }, "fewer than 5 cases: no percentage");
  assert.deepEqual(r.funnel.closed, { lost: 1, disqualified: 0 });
  const rows = (list: typeof r.funnel.by.source) => Object.fromEntries(list.map((row) => [row.key, [row.label, row.leads, row.contacted, row.replied, row.won, row.lostOrDisqualified]]));
  assert.deepEqual(rows(r.funnel.by.source), { manual: ["Added in the app", 2, 2, 1, 0, 0], claude: ["Claude", 1, 1, 0, 0, 1], engine: ["Lead finder", 1, 0, 0, 0, 0], import: ["Imported", 1, 1, 1, 1, 0] });
  assert.deepEqual(rows(r.funnel.by.play), { none: ["No play", 4, 3, 1, 0, 1], [play.id]: ["Raipur dealers", 1, 1, 1, 1, 0] });
  assert.deepEqual(rows(r.funnel.by.owner), { "user-contrib": ["contrib", 5, 4, 2, 1, 1] });
  assert.deepEqual(rows(r.funnel.by.city), { raipur: ["Raipur", 2, 2, 1, 0, 0], bhopal: ["Bhopal", 1, 1, 0, 0, 1], indore: ["Indore", 1, 0, 0, 0, 0], none: ["Not set", 1, 1, 1, 1, 0] });
  assert.equal(r.funnel.by.city[0]!.key, "raipur", "most leads first");
  // Activity: calls, messages and replies per day; outcome and reply-type histograms.
  assert.deepEqual(r.activity.totals, { calls: 3, messages: 1, replies: 1 });
  const today = r.activity.days.find((day) => day.day === localDay(new Date(), { workingDays: new Set([1, 2, 3, 4, 5, 6]), blackout: new Set(), timeZone: "Asia/Kolkata" }))!;
  assert.deepEqual([today.call, today.email, today.whatsapp, today.replies], [3, 1, 0, 1]);
  assert.equal(r.activity.days.length, 31);
  const histogram = (list: { key: string; count: number }[]) => Object.fromEntries(list.filter((row) => row.count > 0).map((row) => [row.key, row.count]));
  assert.deepEqual(histogram(r.activity.callOutcomes), { interested_book: 1, no_answer: 1, not_interested: 1 });
  assert.deepEqual(histogram(r.activity.replyTypes), { interested: 1 });
  assert.ok(r.activity.callOutcomes.some((row) => row.key === "busy" && row.count === 0), "every outcome is listed, even at zero");
  // Stage aging: open leads by step; the oldest list leaves out leads not contacted yet.
  assert.deepEqual(r.stageAging.groups.map((group) => [group.key, group.open]), [["new", 1], ["contacted", 1], ["talking", 0], ["meeting", 1], ["proposal", 0]]);
  assert.equal(r.stageAging.groups[0]!.medianDays.value, null);
  assert.deepEqual(r.stageAging.oldest.map((row) => row.leadId).sort(), [l1.id, l2.id].sort());
  // Wins and losses.
  assert.deepEqual([r.winsLosses.won.count, r.winsLosses.won.value, r.winsLosses.won.withoutValue, r.winsLosses.won.daysToWin.n, r.winsLosses.won.daysToWin.value], [1, [{ currency: "INR", minor: 5_000_000 }], 0, 1, null]);
  assert.equal(r.winsLosses.lost.count, 1);
  assert.equal(r.winsLosses.lost.reasons.reduce((sum, row) => sum + row.count, 0), 1);
  assert.equal(r.winsLosses.disqualified.count, 0);
  assert.deepEqual([r.range.owner, r.range.tz, r.range.ventureId, r.thresholds], ["all", "Asia/Kolkata", "venture-r1", { minN: 5, smallN: 30 }]);

  // Who sees what: members (learners too) read; "mine" is the person's own leads; outsiders get nothing.
  assert.equal((await report(h, "learner", "ventureId=venture-r1")).funnel.active, 5);
  assert.equal((await report(h, "contrib2", "ventureId=venture-r1&owner=me")).funnel.active, 0);
  assert.equal((await report(h, "contrib", "ventureId=venture-r1&owner=me")).funnel.active, 5);
  expectStatus(await h.call("outsider", "GET", "/sales/reports?ventureId=venture-r1"), 404);
  assert.equal((await report(h, "outsider", "")).funnel.active, 0);
  assert.ok((await report(h, "admin", "")).funnel.active >= 5, "without a venture: every venture the person can open");
  // An earlier period, before any of this happened: nothing moved.
  const old = await report(h, "head", `ventureId=venture-r1&from=${shiftDate(localDay(new Date()), -90)}&to=${shiftDate(localDay(new Date()), -60)}`);
  assert.deepEqual([old.funnel.active, old.activity.totals.calls, old.activity.days.length, old.winsLosses.won.count], [0, 0, 31, 0]);
  // Bad periods.
  for (const query of ["from=2026-10-08&to=2026-10-01", "from=2024-01-01&to=2026-10-01", "from=2026-02-30", "to=yesterday", "owner=everyone"]) expectStatus(await h.call("head", "GET", `/sales/reports?ventureId=venture-r1&${query}`), 400);
});

/** A Saturday at least 9 days ago whose Thursday, Friday and Monday are working days too. */
function pastSaturday(): string {
  let day = shiftDate(localDay(new Date()), -9);
  for (let guard = 0; guard < 120; guard++, day = shiftDate(day, -1)) {
    if (new Date(`${day}T00:00:00Z`).getUTCDay() !== 6) continue;
    if ([shiftDate(day, -2), shiftDate(day, -1), day, shiftDate(day, 2)].every((item) => isWorkingDay(item))) return day;
  }
  throw new Error("no Saturday found");
}

test("Reports: reply speed in working hours and the 2-hour promise on warm replies, with the 5-case rule", skip, async () => {
  const h = await getHarness();
  const sat = pastSaturday();
  const thu = shiftDate(sat, -2), fri = shiftDate(sat, -1), mon = shiftDate(sat, 2);
  const lead = () => newLead(h, "venture-r2");
  const pair = async (inAt: Date, replyType: string, outAt?: Date) => {
    const target = await lead();
    await log(h, target.id, { kind: "email", direction: "in", replyType, at: iso(inAt), body: "Their reply" });
    if (outAt) await log(h, target.id, { kind: "email", direction: "out", at: iso(outAt), body: "Our answer" });
  };
  await pair(ist(sat, 18), "interested", ist(mon, 10, 30)); // 40.5 h on the clock, 1.5 working hours: within
  await pair(ist(fri, 12), "send_details", ist(fri, 13, 30)); // within
  await pair(ist(thu, 11), "price_first", ist(thu, 12)); // within
  await pair(ist(fri, 12), "interested", ist(fri, 15)); // 3 working hours: late
  await pair(ist(thu, 11), "interested"); // never answered: missed
  await pair(ist(thu, 11), "not_now", ist(thu, 14)); // not warm: no promise, but its answer time counts
  const fresh = await lead();
  await log(h, fresh.id, { kind: "whatsapp", direction: "in", replyType: "interested", body: "Call me" }); // just now: still inside the promise

  const r = await report(h, "head", `ventureId=venture-r2&from=${shiftDate(thu, -1)}&to=${localDay(new Date())}`);
  assert.deepEqual(r.activity.sla, { hours: 2, rate: { count: 3, n: 5, value: 0.6, small: true }, pending: 1, late: 1, missed: 1 });
  assert.deepEqual(r.activity.firstResponse, { medianHours: { value: 3, n: 5, small: true }, medianWorkingHours: { value: 1.5, n: 5, small: true }, unanswered: 2 });
  const day = (name: string) => r.activity.days.find((row) => row.day === name)!;
  assert.deepEqual([day(thu).replies, day(thu).email, day(fri).replies, day(fri).email, day(sat).replies, day(mon).email], [3, 2, 2, 2, 1, 1]);
  assert.deepEqual(Object.fromEntries(r.activity.replyTypes.filter((row) => row.count).map((row) => [row.key, row.count])), { interested: 4, send_details: 1, price_first: 1, not_now: 1 });
  // A venture with a 4-hour promise: the 3-hour answer is now on time.
  expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-r2", { replySlaHours: 4 }), 200);
  try {
    const slower = await report(h, "head", `ventureId=venture-r2&from=${shiftDate(thu, -1)}&to=${localDay(new Date())}`);
    assert.deepEqual([slower.activity.sla.hours, slower.activity.sla.rate.count, slower.activity.sla.late], [4, 4, 0]);
  } finally { await h.database.db.collection("sales_settings").deleteMany({}); }
  // Only the period counts: a range of just Friday sees Friday's two warm replies (n below 5: no percentage).
  const friday = await report(h, "head", `ventureId=venture-r2&from=${fri}&to=${fri}`);
  assert.deepEqual(friday.activity.sla.rate, { count: 1, n: 2, value: null, small: true });
  assert.equal(friday.activity.firstResponse.medianHours.value, null);
});

test("Reports: Claude's calibration grid, overrides, precision after 10 working days and signal keywords", skip, async () => {
  const h = await getHarness();
  const now = Date.now();
  const leads = [];
  for (let index = 0; index < 6; index++) {
    const lead = await newLead(h, "venture-r3");
    await claudeVerdict(h, lead.id, "recommend", "medium", { signal: index < 3 ? "Hiring sales staff for the Raipur branch" : "New showroom opening on Ring Road" });
    leads.push(lead);
  }
  for (const [index, lead] of leads.entries()) {
    await log(h, lead.id, { kind: "email", direction: "out", body: "First note", at: iso(new Date(index === 5 ? now - HOUR : now - 25 * DAY)) });
    if (index < 3) await log(h, lead.id, { kind: "email", direction: "in", body: "Interested", at: iso(new Date(now - 22 * DAY)) });
    if (index === 2) await log(h, lead.id, { kind: "call", callOutcome: "interested_book", at: iso(new Date(now - 21 * DAY)) });
  }
  const untouched = await newLead(h, "venture-r3");
  await claudeVerdict(h, untouched.id, "recommend", "high", { signal: "Hiring drivers" });
  const held = await newLead(h, "venture-r3");
  const hold = await claudeVerdict(h, held.id, "hold", "high");
  expectStatus(await h.call("head", "POST", `/sales/verdicts/${hold.id}/override`, { decision: "recommend", reason: "Owner knows the buyer" }), 200);
  await log(h, held.id, { kind: "call", callOutcome: "interested_book" });
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${held.id}`, { stage: "invoice_contract" }), 200);
  const rejected = await newLead(h, "venture-r3");
  await claudeVerdict(h, rejected.id, "reject", "high");
  const person = await newLead(h, "venture-r3");
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${person.id}/verdicts`, verdictBody("recommend", "high")), 201); // a person's verdict: not Claude's to account for

  const r = await report(h, "head", "ventureId=venture-r3");
  const cal = r.calibration;
  assert.equal(cal.verdicts, 9);
  const cell = (decision: string, confidence: string) => cal.grid.find((row) => row.decision === decision && row.confidence === confidence)!;
  assert.equal(cal.grid.length, 9);
  const medium = cell("recommend", "medium");
  assert.deepEqual([medium.n, medium.contacted, medium.replied, medium.meeting, medium.won, medium.lost, medium.disqualified, medium.open, medium.small], [6, 6, 2, 1, 0, 0, 0, 3, true]);
  assert.deepEqual(medium.replyRate, { count: 3, n: 6, value: 0.5, small: true });
  assert.deepEqual([cell("recommend", "high").n, cell("recommend", "high").open, cell("recommend", "high").replyRate.value], [1, 1, null]);
  assert.deepEqual([cell("hold", "high").n, cell("hold", "high").won], [1, 1]);
  assert.deepEqual([cell("reject", "high").n, cell("reject", "high").disqualified], [1, 1]);
  assert.equal(cell("hold", "low").n, 0);
  assert.deepEqual([cal.overridden.n, cal.overridden.won, cal.overridden.contacted], [1, 1, 1]);
  assert.deepEqual([cal.overrides.count, cal.overrides.toRecommend, cal.overrides.fromRecommend], [1, 1, 0]);
  assert.deepEqual([cal.overrides.recent[0]!.reason, cal.overrides.recent[0]!.decision, cal.overrides.recent[0]!.to, cal.overrides.recent[0]!.by, cal.overrides.recent[0]!.leadId], ["Owner knows the buyer", "hold", "recommend", "user-head", held.id]);
  // Precision: five recommended leads were contacted 10+ working days ago and three replied or booked; one is too recent, one was never contacted.
  assert.deepEqual(cal.precision, { rate: { count: 3, n: 5, value: 0.6, small: true }, waitDays: 10, tooRecent: 1, notContacted: 1 });
  assert.equal(cal.signals[0]!.keyword, "hiring");
  assert.deepEqual([cal.signals[0]!.leads, cal.signals[0]!.contacted, cal.signals[0]!.replied, cal.signals[0]!.replyRate.value], [4, 3, 3, null]);
  const showroom = cal.signals.find((row) => row.keyword === "showroom")!;
  assert.deepEqual([showroom.leads, showroom.contacted, showroom.replied], [3, 3, 0]);
  for (const word of ["new", "the", "for", "on"]) assert.ok(!cal.signals.some((row) => row.keyword === word), word);
  assert.ok(cal.signals.length <= 10);
  // A period before the verdicts: nothing to account for.
  const earlier = await report(h, "head", `ventureId=venture-r3&from=${shiftDate(localDay(new Date()), -60)}&to=${shiftDate(localDay(new Date()), -40)}`);
  assert.deepEqual([earlier.calibration.verdicts, earlier.calibration.overrides.count, earlier.calibration.precision.rate.n], [0, 0, 0]);
});

test("Daybreak: the morning list fills itself from follow-ups, stale verdicts, missing contacts, calls, replies and approvals, and writes nothing", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const now = Date.now();
  const leads = db.collection("opportunities");
  // Follow-ups: one first touch through a sent draft, one through a logged call; one already has a follow-up draft waiting.
  const followed = await newLead(h, "venture-r4");
  await claudeVerdict(h, followed.id, "recommend", "medium", { signal: "Opening a second warehouse in Nagpur" });
  const first = expectStatus(await h.call("contrib", "POST", `/sales/leads/${followed.id}/drafts`, { channel: "email", subject: "Dealer orders", body: "First note about dealer ordering" }), 201).data;
  expectStatus(await h.call("head", "POST", `/sales/drafts/${first.id}/review`, { result: "pass" }), 200);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${first.id}/sent`, {}), 201);
  const called = await newLead(h, "venture-r4", { observedSignal: "Saw a hiring post" });
  await log(h, called.id, { kind: "call", body: "Called the owner" });
  const drafted = await newLead(h, "venture-r4");
  await log(h, drafted.id, { kind: "email", direction: "out", body: "First note" });
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${drafted.id}/drafts`, { channel: "email", purpose: "follow_up", subject: "Again", body: "A follow-up" }), 201);
  await leads.updateMany({ _id: { $in: [followed.id, called.id, drafted.id] } }, { $set: { followUpDueAt: new Date(now - HOUR) } });
  // Stale verdicts: one 40 days old, one whose signal was seen 70 days ago, one a person set long ago.
  const oldVerdict = await newLead(h, "venture-r4");
  await claudeVerdict(h, oldVerdict.id, "recommend", "medium");
  await leads.updateOne({ _id: oldVerdict.id }, { $set: { "verdict.at": new Date(now - 40 * DAY) } });
  const oldSignal = await newLead(h, "venture-r4");
  await claudeVerdict(h, oldSignal.id, "recommend", "high", { signal: "Tender for 200 dealers", signalSeenAt: iso(new Date(now - 70 * DAY)) });
  const personVerdict = await newLead(h, "venture-r4");
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${personVerdict.id}/verdicts`, verdictBody("recommend", "medium")), 201);
  await leads.updateOne({ _id: personVerdict.id }, { $set: { "verdict.at": new Date(now - 35 * DAY) } });
  // No contact routes: candidates for an enrich run (one already queued).
  const bare = await newLead(h, "venture-r4", { contactRoutes: [] });
  const bare2 = await newLead(h, "venture-r4", { contactRoutes: [{ kind: "website_form", value: "https://example.com/contact" }] });
  await db.collection("sales_find_runs").insertOne({ _id: `run-${suffix}`, workspaceId: "workspace-a", ventureId: "venture-r4", kind: "enrich", leadIds: [bare.id], request: "Find contacts", plan: { places: [], categories: [], searches: [], limit: 50 }, status: "queued", createdBy: "user-contrib", createdAt: new Date(), updatedAt: new Date() });
  // A call for today with its opener script.
  const caller = await newLead(h, "venture-r4");
  await claudeVerdict(h, caller.id, "recommend", "medium");
  const script = expectStatus(await h.call("contrib", "POST", `/sales/leads/${caller.id}/drafts`, { channel: "call_opener", body: "Hello, this is about dealer orders" }), 201).data;
  // A reply that has waited a week, after our first note.
  const replied = await newLead(h, "venture-r4");
  await log(h, replied.id, { kind: "email", direction: "out", body: "Our first note to them", at: iso(new Date(now - 8 * DAY)) });
  const reply = await log(h, replied.id, { kind: "email", direction: "in", replyType: "interested", body: "Sounds good", at: iso(new Date(now - 7 * DAY)) });
  // A first-batch draft that a person must approve, and a lead that needs a decision.
  const play = expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-r4", name: "Warehouse owners" }), 201).data;
  expectStatus(await h.call("head", "POST", `/sales/plays/${play.id}/approve`, {}), 200);
  const batched = await newLead(h, "venture-r4", { playId: play.id });
  const batchDraft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${batched.id}/drafts`, { channel: "email", subject: "Hi", body: "First batch message", playId: play.id }), 201).data;
  expectStatus(await h.call("head", "POST", `/sales/drafts/${batchDraft.id}/review`, { result: "pass" }), 200);
  const unsure = await newLead(h, "venture-r4");
  await claudeVerdict(h, unsure.id, "hold", "medium");

  const counts = async () => Object.fromEntries(await Promise.all(["opportunities", "sales_activities", "sales_drafts", "sales_verdicts", "sales_find_runs", "audit_events", "notification_outbox"].map(async (name) => [name, await db.collection(name).countDocuments()] as const)));
  const before = await counts();
  const d = await daybreak(h, "contrib", "ventureId=venture-r4");
  assert.deepEqual(await counts(), before, "Daybreak writes nothing");
  assert.deepEqual([d.owner, d.ventureId, d.tz], ["me", "venture-r4", "Asia/Kolkata"]);

  assert.deepEqual(d.followUpsDue.map((item) => item.id).sort(), [followed.id, called.id].sort(), "a lead with a follow-up draft waiting is left out");
  const viaDraft = d.followUpsDue.find((item) => item.id === followed.id)!;
  assert.deepEqual([viaDraft.channel, viaDraft.firstTouch?.draftId, viaDraft.firstTouch?.subject, viaDraft.firstTouch?.body, viaDraft.signal], ["email", first.id, "Dealer orders", "First note about dealer ordering", "Opening a second warehouse in Nagpur"]);
  const viaCall = d.followUpsDue.find((item) => item.id === called.id)!;
  assert.deepEqual([viaCall.channel, viaCall.firstTouch?.body, Boolean(viaCall.firstTouch?.activityId), viaCall.signal], ["call", "Called the owner", true, "Saw a hiring post"]);

  const stale = Object.fromEntries(d.staleVerdicts.map((item) => [item.id, item]));
  assert.deepEqual(Object.keys(stale).sort(), [oldVerdict.id, oldSignal.id, personVerdict.id].sort());
  assert.match(stale[oldVerdict.id]!.reasons.join(" "), /Verdict is 40 days old/);
  assert.match(stale[oldSignal.id]!.reasons.join(" "), /Signal was seen 70 days ago/);
  assert.equal(stale[oldSignal.id]!.verdict.signal, "Tender for 200 dealers");
  assert.deepEqual([stale[oldVerdict.id]!.verdict.setBy, stale[oldVerdict.id]!.claudeCanRejudge, stale[personVerdict.id]!.verdict.setBy, stale[personVerdict.id]!.claudeCanRejudge], ["claude", true, "person", false]);
  assert.ok(!stale[followed.id], "a contacted lead's verdict is not re-judged here");

  assert.deepEqual(d.needsContacts.map((item) => [item.id, item.enrichPending]), [[bare2.id, false], [bare.id, true]], "newest first, with the enrich runs already queued");
  const call = d.callsToday.find((item) => item.id === caller.id)!;
  assert.deepEqual([call.callOpenerDraftId, call.phones.map((phone) => phone.kind), call.why], [script.id, ["phone"], "Approved for contact: ready for a first call"]);

  assert.equal(d.repliesWaiting.length, 1);
  const waiting = d.repliesWaiting[0]!;
  assert.deepEqual([waiting.activityId, waiting.replyType, waiting.overSla, waiting.lead.id, waiting.lastOutbound?.body], [reply.activity.id, "interested", true, replied.id, "Our first note to them"]);
  assert.ok(waiting.waitingHours >= 7 * 24 - 1);

  assert.deepEqual(d.approvalsWaiting.drafts.map((item) => [item.draftId, item.leadId]), [[batchDraft.id, batched.id]]);
  assert.match(d.approvalsWaiting.drafts[0]!.why, /First batch of the play "Warehouse owners"/);
  assert.deepEqual(d.approvalsWaiting.needsYou.map((item) => [item.id, item.verdict?.decision]), [[unsure.id, "hold"]]);

  // Today's sends are the ones that happened today (`at`): the note logged now for eight days ago is not one of them.
  const sentToday = await db.collection("sales_activities").countDocuments({ ventureId: "venture-r4", actorId: "user-contrib", direction: "out", kind: "email", at: { $gte: startOfLocalDay(new Date(now), "Asia/Kolkata") } });
  assert.equal(sentToday, 2);
  const caps = d.caps.find((row) => row.ventureId === "venture-r4")!;
  const email = caps.channels.find((row) => row.channel === "email")!;
  assert.deepEqual([email.used, email.cap, email.left], [sentToday, 20, 20 - sentToday]);
  assert.deepEqual(caps.channels.find((row) => row.channel === "call"), { channel: "call", used: 1, cap: null, left: null });

  assert.deepEqual(d.counts, { followUpsDue: 2, staleVerdicts: 3, needsContacts: 2, callsToday: d.callsToday.length, repliesWaiting: 1, repliesOverSla: 1, draftsToApprove: 1, needsYou: 1 });
  assert.match(d.summary, /^1 reply waiting over 2h, \d+ calls today, 2 follow-ups to draft, 1 draft to approve, 1 lead needs a decision, 3 verdicts to re-judge, 2 leads without contacts$/);

  // Someone else's morning: a head with no leads of their own sees a clear morning; everyone's leads with owner=all.
  const headMorning = await daybreak(h, "head", "ventureId=venture-r4");
  assert.equal(headMorning.summary, "Nothing waiting: a clear morning.");
  assert.equal((await daybreak(h, "head", "ventureId=venture-r4&owner=all")).counts.followUpsDue, 2);
  assert.equal((await daybreak(h, "learner", "ventureId=venture-r4&owner=all")).counts.repliesWaiting, 1, "learners read it too");
  expectStatus(await h.call("outsider", "GET", "/sales/daybreak?ventureId=venture-r4"), 404);
  const everywhere = await daybreak(h, "contrib", "");
  assert.ok(everywhere.counts.followUpsDue >= 2);
  assert.deepEqual(everywhere.caps.map((row) => row.ventureId).sort(), VENTURES);
  expectStatus(await h.call("contrib", "GET", "/sales/daybreak?ventureId=venture-r4&owner=nobody"), 400);
  // A follow-up drafted since, or a reply marked handled, leaves the list.
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${called.id}/drafts`, { channel: "email", purpose: "follow_up", subject: "Following up", body: "Following up on my call" }), 201);
  expectStatus(await h.call("contrib", "POST", `/sales/activities/${reply.activity.id}/handled`, {}), 200);
  const later = await daybreak(h, "contrib", "ventureId=venture-r4");
  assert.deepEqual([later.counts.followUpsDue, later.counts.repliesWaiting], [1, 0]);
});

test("Reports and Daybreak are reachable through the whole app with the dev sign-in", skip, async () => {
  const dbName = `vso_test_reports_${suffix}_full`;
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  try {
    await ensureIndexes(database.db);
    const now = new Date();
    await database.db.collection("workspaces").insertOne({ _id: "workspace-a", name: "A", slug: "a", createdAt: now });
    await database.db.collection("ventures").insertOne({ _id: "venture-a", workspaceId: "workspace-a", name: "Alpha", status: "active", createdAt: now });
    await database.db.collection("users").insertOne({ _id: "user-head", workspaceId: "workspace-a", email: "head@example.invalid", name: "head", handle: "head", status: "active", createdAt: now, updatedAt: now });
    await database.db.collection("memberships").insertOne({ _id: "membership-head", workspaceId: "workspace-a", userId: "user-head", role: "venture_head", ventureIds: ["venture-a"], groupIds: [], status: "active", createdAt: now, updatedAt: now });
    const { app } = createApp(database, config, createAuth(database.native, config), new LocalObjectStore(config));
    const server = createServer(app).listen(0);
    await once(server, "listening");
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const headers = { "x-dev-user-id": "user-head" };
    try {
      const reportReply = await fetch(`${origin}/v1/sales/reports?ventureId=venture-a&from=2026-10-01&to=2026-10-07`, { headers });
      assert.equal(successEnvelope(salesReportSchema).parse(await reportReply.json()).data.activity.days.length, 7);
      const daybreakReply = await fetch(`${origin}/v1/sales/daybreak?ventureId=venture-a`, { headers });
      assert.equal(successEnvelope(daybreakSchema).parse(await daybreakReply.json()).data.summary, "Nothing waiting: a clear morning.");
      assert.equal((await fetch(`${origin}/v1/sales/reports`)).status, 401);
      assert.equal((await fetch(`${origin}/v1/sales/daybreak?ventureId=nope`, { headers })).status, 404);
    } finally { server.close(); await once(server, "close"); }
  } finally {
    await database.native.dropDatabase();
    await database.client.close();
  }
});

test("Daybreak and Reports measure the reply time with the venture's own rules, count only warm replies as over it, and show those rules", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const now = Date.now();
  await db.collection("ventures").insertOne({ _id: "venture-r6", workspaceId: "workspace-a", name: "Venture r6", status: "active", createdAt: new Date() });
  await db.collection("pipelines").insertOne({ _id: "pipeline-r6", workspaceId: "workspace-a", ventureId: "venture-r6", name: "Leads", offerName: "Offer", status: "active", createdAt: new Date(), updatedAt: new Date() });
  await db.collection("memberships").updateMany({ _id: { $in: ["membership-head", "membership-contrib"] } }, { $push: { ventureIds: "venture-r6" } } as never);
  // Every day a working day and no blackout, so "a day ago" is always many working hours ago, whatever the clock says (a PUT sets them all).
  const settings = (body: Record<string, unknown>) => h.call("head", "PUT", "/sales/settings?ventureId=venture-r6", { workingDays: [1, 2, 3, 4, 5, 6, 7], blackoutDates: [], ...body });
  try {
    expectStatus(await settings({ replySlaHours: 72 }), 200);
    const warm = await newLead(h, "venture-r6");
    await log(h, warm.id, { kind: "email", direction: "in", replyType: "interested", body: "Tell me more", at: new Date(now - 26 * HOUR).toISOString() });
    const unsorted = await newLead(h, "venture-r6");
    await log(h, unsorted.id, { kind: "email", direction: "in", body: "Who is this?", at: new Date(now - 3 * DAY).toISOString() });
    const later = await newLead(h, "venture-r6");
    await log(h, later.id, { kind: "email", direction: "in", replyType: "not_now", body: "Ask me in March", at: new Date(now - 3 * DAY).toISOString() });
    const overOf = (d: Awaited<ReturnType<typeof daybreak>>) => Object.fromEntries(d.repliesWaiting.map((item) => [item.lead.id, item.overSla]));

    // A 72-hour promise: the warm reply from a day ago is still inside it; the others are never "over" (only warm replies are).
    const slow = await daybreak(h, "contrib", "ventureId=venture-r6");
    assert.deepEqual(overOf(slow), { [warm.id]: false, [unsorted.id]: false, [later.id]: false });
    assert.equal(slow.counts.repliesOverSla, 0);
    assert.equal(slow.replySlaHours, 72);
    assert.deepEqual(slow.workRules, [{ ventureId: "venture-r6", replySlaHours: 72, workingDays: [1, 2, 3, 4, 5, 6, 7], blackoutDates: [], timezone: "Asia/Kolkata", workStartHour: 10, workEndHour: 19 }]);
    // A 2-hour promise: only the warm reply is over it.
    expectStatus(await settings({ replySlaHours: 2 }), 200);
    const fast = await daybreak(h, "contrib", "ventureId=venture-r6");
    assert.deepEqual(overOf(fast), { [warm.id]: true, [unsorted.id]: false, [later.id]: false });
    assert.equal(fast.counts.repliesOverSla, 1);
    assert.match(fast.summary, /^3 replies waiting \(1 over 2h\)/);
    // The report shows the same rules, and its promise is the venture's.
    const r = await report(h, "head", "ventureId=venture-r6");
    assert.equal(r.activity.sla.hours, 2);
    assert.deepEqual(r.workRules.map((row) => [row.ventureId, row.replySlaHours, row.workingDays.length, row.blackoutDates.length]), [["venture-r6", 2, 7, 0]]);
    // Across ventures: one row per venture; when the promises differ the summary names none.
    const all = await daybreak(h, "contrib", "");
    assert.deepEqual(all.workRules.map((row) => row.ventureId).sort(), [...VENTURES, "venture-r6"].sort());
    assert.equal(all.replySlaHours, 2, "every venture has 2 hours");
    expectStatus(await settings({ replySlaHours: 4 }), 200);
    const mixed = await daybreak(h, "contrib", "");
    assert.equal(mixed.replySlaHours, null);
    assert.match(mixed.summary, /over the reply time/);
    assert.equal((await report(h, "head", "")).workRules.find((row) => row.ventureId === "venture-r6")?.replySlaHours, 4);
  } finally {
    await db.collection("sales_settings").deleteMany({ _id: "venture-r6" });
    await db.collection("memberships").updateMany({ _id: { $in: ["membership-head", "membership-contrib"] } }, { $pull: { ventureIds: "venture-r6" } } as never);
    await db.collection("opportunities").updateMany({ ventureId: "venture-r6" }, { $set: { deletedAt: new Date() } });
    await db.collection("ventures").updateOne({ _id: "venture-r6" }, { $set: { status: "archived" } });
  }
});

test("Reports, Daybreak and the Overview narrow to one offer, or to the leads with none (docs/sales-offers.md)", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const now = new Date();
  await db.collection("ventures").insertOne({ _id: "venture-r7", workspaceId: "workspace-a", name: "Venture r7", status: "active", createdAt: now });
  await db.collection("pipelines").insertOne({ _id: "pipeline-r7", workspaceId: "workspace-a", ventureId: "venture-r7", name: "Leads", offerName: "Offer", status: "active", createdAt: now, updatedAt: now });
  await db.collection("memberships").updateMany({ _id: { $in: ["membership-head", "membership-contrib"] } }, { $push: { ventureIds: "venture-r7" } } as never);
  // Two usable offers, so a lead with none named keeps none.
  await db.collection("sales_offers").insertMany(["a", "b"].map((key) => ({ _id: `offer-r7-${key}`, workspaceId: "workspace-a", ventureId: "venture-r7", name: `Offer ${key.toUpperCase()}`, state: "active", approvedVersionId: `version-r7-${key}`, createdBy: "user-head", createdAt: now, updatedAt: now })));
  try {
    const a = await newLead(h, "venture-r7", { offerId: "offer-r7-a" });
    const b = await newLead(h, "venture-r7", { offerId: "offer-r7-b" });
    const none = await newLead(h, "venture-r7");
    assert.deepEqual([a.offerId, b.offerId, none.offerId], ["offer-r7-a", "offer-r7-b", undefined]);
    for (const lead of [a, b, none]) await log(h, lead.id, { kind: "email", direction: "in", body: "Tell me more", replyType: "interested" });
    await claudeVerdict(h, b.id, "hold", "low");

    const all = await report(h, "head", "ventureId=venture-r7");
    const onlyA = await report(h, "head", "ventureId=venture-r7&offerId=offer-r7-a");
    const withNone = await report(h, "head", "ventureId=venture-r7&offerId=none");
    assert.deepEqual([all.funnel.active, onlyA.funnel.active, withNone.funnel.active], [3, 1, 1]);
    assert.deepEqual([onlyA.range.offerId, all.range.offerId], ["offer-r7-a", undefined]);
    assert.deepEqual([all.activity.totals.replies, onlyA.activity.totals.replies], [3, 1]);
    assert.deepEqual([all.calibration.verdicts, onlyA.calibration.verdicts, (await report(h, "head", "ventureId=venture-r7&offerId=offer-r7-b")).calibration.verdicts], [1, 0, 1]);

    const morning = await daybreak(h, "contrib", "ventureId=venture-r7");
    const morningB = await daybreak(h, "contrib", "ventureId=venture-r7&offerId=offer-r7-b");
    assert.deepEqual([morning.counts.repliesWaiting, morningB.counts.repliesWaiting, morningB.counts.needsYou, morningB.offerId], [3, 1, 1, "offer-r7-b"]);
    assert.deepEqual(morningB.repliesWaiting.map((item) => [item.lead.id, item.lead.offerId]), [[b.id, "offer-r7-b"]]);
    assert.equal((await daybreak(h, "contrib", "ventureId=venture-r7&offerId=none")).counts.repliesWaiting, 1);

    const overview = (offer: string) => h.call("contrib", "GET", `/sales/overview?ventureId=venture-r7&owner=me${offer}`);
    const counts = async (offer: string) => expectStatus(await overview(offer), 200).data.counts;
    assert.deepEqual([(await counts("")).replies, (await counts("&offerId=offer-r7-a")).replies, (await counts("&offerId=none")).replies, (await counts("&offerId=offer-r7-b")).needsYou], [3, 1, 1, 1]);
    assert.equal((await counts("&offerId=offer-r7-a")).totalLeads, 1);
    expectStatus(await h.call("head", "GET", "/sales/reports?ventureId=venture-r7&offerId=not%20an%20id!"), 400);
  } finally {
    await db.collection("memberships").updateMany({ _id: { $in: ["membership-head", "membership-contrib"] } }, { $pull: { ventureIds: "venture-r7" } } as never);
    await db.collection("opportunities").updateMany({ ventureId: "venture-r7" }, { $set: { deletedAt: new Date() } });
    await db.collection("ventures").updateOne({ _id: "venture-r7" }, { $set: { status: "archived" } });
  }
});
