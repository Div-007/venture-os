import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after } from "node:test";
import express from "express";
import { MongoClient } from "mongodb";
import { bulkResultSchema, findRunSchema, leadFacetsSchema, leadListSchema, offerDetailSchema, offerPacketSchema, offerSchema, offerVersionSchema, opportunitySchema, playSchema, successEnvelope, verdictSchema } from "@venture-studio/contracts";
import { loadConfig } from "../src/config.js";
import { AppDb, connectDatabase, type Database } from "../src/db.js";
import { createErrorHandler } from "../src/errors.js";
import { ensureIndexes } from "../src/indexes.js";
import { actorFor } from "../src/middleware.js";
import { salesIoRoutes } from "../src/routes/sales-io.js";
import { salesRoutes } from "../src/routes/sales.js";
import { ventureLifecycleRoutes } from "../src/routes/venture-lifecycle.js";
import { parseCsv } from "../src/sales/csv.js";
import { defaultOfferId, offersJson, usableOffers } from "../src/sales/offers.js";
import { describe as describeMigration, migrateOffers, parseBody, v1Packet, withoutDraftStatus } from "../scripts/migrate-offers.js";

// Offers (docs/sales-offers.md): one packet per offer, proposed as draft versions and approved as a whole by a venture head in the app;
// every lead, verdict, play and find run names its offer; the brain keeps shared notes only; and the migration from the old brain kinds.

type Who = "admin" | "head" | "contrib" | "contrib2" | "learner" | "outsider";
type Reply = { status: number; body: any; data: any; text: string; headers: Headers };
type Harness = { database: Database; server: Server; call: (who: Who, method: string, path: string, body?: unknown, options?: { via?: "claude" }) => Promise<Reply> };

const mongoUrl = process.env.TEST_MONGODB_URI;
const suffix = randomUUID().slice(0, 6);
let harness: Promise<Harness> | undefined;
let counter = 0;

async function setup(): Promise<Harness> {
  const dbName = `vso_test_offers_${suffix}`;
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
  const ventures: [string, string][] = [["venture-a", "Alpha"], ["venture-b", "Beta"], ["venture-c", "Gamma"], ["venture-d", "Delta"]];
  await db.collection("ventures").insertMany(ventures.map(([id, name]) => ({ _id: id, workspaceId: "workspace-a", name, status: "active", createdAt: now })));
  await db.collection("pipelines").insertMany(ventures.map(([id]) => ({ _id: id.replace("venture", "pipeline"), workspaceId: "workspace-a", ventureId: id, name: "Leads", offerName: "", status: "active", createdAt: now, updatedAt: now })));
  const people: [Who, string, string[]][] = [
    ["admin", "admin", []], ["head", "venture_head", ["venture-a", "venture-b", "venture-d"]], ["contrib", "contributor", ["venture-a", "venture-b", "venture-d"]],
    ["contrib2", "contributor", ["venture-a"]], ["learner", "learner", ["venture-a"]], ["outsider", "contributor", ["venture-c"]],
  ];
  await db.collection("users").insertMany(people.map(([handle]) => ({ _id: `user-${handle}`, workspaceId: "workspace-a", email: `${handle}@example.invalid`, name: handle, handle, status: "active", createdAt: now, updatedAt: now })));
  await db.collection("memberships").insertMany(people.map(([handle, role, ventureIds]) => ({ _id: `membership-${handle}`, workspaceId: "workspace-a", userId: `user-${handle}`, role, ventureIds, groupIds: [], status: "active", createdAt: now, updatedAt: now })));

  // The Sales routes behind a small stand-in for sign-in: `x-test-user` is the person, `x-test-via: claude` is the hosted connector.
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use(async (req, _res, next) => {
    try {
      req.id = randomUUID();
      req.interfaceChannel = req.headers["x-test-via"] === "claude" ? "mcp" : "api";
      const user = await db.collection("users").findOne({ _id: String(req.headers["x-test-user"]) });
      if (user) req.actor = await actorFor(db, { id: String(user._id), email: String(user.email), name: String(user.name) });
      next();
    } catch (error) { next(error); }
  });
  app.use("/v1/sales", salesIoRoutes(database));
  app.use("/v1", salesRoutes(database));
  app.use("/v1", ventureLifecycleRoutes(database));
  app.use(createErrorHandler(db));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const call: Harness["call"] = async (who, method, path, body, options = {}) => {
    const response = await fetch(`${origin}/v1${path}`, { method, headers: { "content-type": "application/json", "x-test-user": `user-${who}`, ...(options.via === "claude" ? { "x-test-via": "claude" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* the CSV export */ }
    return { status: response.status, body: json, data: json?.data, text, headers: response.headers };
  };
  return { database, server, call };
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
const message = (reply: Reply) => String(reply.body?.error?.message ?? "");

/** A small, valid packet (the lists left out default to empty). */
const packet = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary, whoFor: { description: "Owner-led suppliers that sell through dealers", industries: ["pumps", "pipes"], places: ["Raipur", "Indore"] },
  gates: [{ code: "G1", rule: "Office in Chhattisgarh", ifFails: "reject" }, { code: "G4", rule: "No dealer portal yet", ifFails: "hold", note: "Unclear is a question" }],
  signals: { lookFor: [{ phrase: "dealer enquiry", meaning: "They take dealer enquiries" }], searchWords: ["dealer enquiry"], negatives: ["pesticide"] },
  say: { valueProposition: "One place for dealer orders", proofWords: "a dealer-network supplier in Chhattisgarh", claimsToAvoid: ["Guaranteed revenue"] }, messages: "Email first, under 100 words.", price: "No price in the first message.", ...extra,
});
const propose = (h: Harness, who: Who, body: Record<string, unknown>, options?: { via?: "claude" }) => h.call(who, "POST", "/sales/offers", body, options);
/** A new offer with an approved v1 (proposed by the contributor, approved by the head); returns its id and the version's. */
async function liveOffer(h: Harness, ventureId: string, name: string) {
  const version = offerVersionSchema.parse(expectStatus(await propose(h, "contrib", { ventureId, name, packet: packet(`${name}: what we sell`), change: "First version" }), 201).data);
  expectStatus(await h.call("head", "POST", `/sales/offers/versions/${version.id}/approve`, {}), 200);
  return { offerId: version.offerId, versionId: version.id };
}
async function newLead(h: Harness, who: Who, ventureId: string, extra: Record<string, unknown> = {}) {
  const n = ++counter;
  const reply = await h.call(who, "POST", "/sales/leads", { pipelineId: ventureId.replace("venture", "pipeline"), companyName: `Offerco${n}z ${suffix}`, ownerId: `user-${who}`, ...extra });
  return reply;
}
const lead = async (h: Harness, ventureId: string, extra: Record<string, unknown> = {}) => opportunitySchema.parse(expectStatus(await newLead(h, "contrib", ventureId, extra), 201).data);
const verdict = (extra: Record<string, unknown> = {}) => ({
  decision: "recommend", confidence: "high", offer: "Dealer ordering", offerFit: "Dealers order by phone", evidence: [{ claim: "Dealers", quote: "We welcome dealer enquiries", url: "https://example.com/dealers" }],
  against: "May be too small", signal: "We welcome dealer enquiries", summary: "Dealers by phone", ...extra,
});

// ---------------------------------------------------------------------------------------------------------------------
// Offers and their versions
// ---------------------------------------------------------------------------------------------------------------------

test("a new offer is a draft v1 that a venture head approves in the app; Claude and contributors can propose but never approve", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  // Proposing: a writer (here through Claude) makes the offer and its draft v1; nothing is in force yet.
  const first = offerVersionSchema.parse(expectStatus(await propose(h, "contrib", { ventureId: "venture-a", name: "Dealer Commerce", packet: packet("Catalog-to-order systems for dealer-led suppliers"), change: "The owner's offer" }, { via: "claude" }), 201).data);
  assert.deepEqual([first.version, first.status, first.via, first.proposedBy, first.name, first.packet.signals.lookFor[0]?.phrase, first.packet.exclusions], [1, "draft", "claude", "user-contrib", "Dealer Commerce", "dealer enquiry", []]);
  const listed = successEnvelope(offerSchema.array()).parse((await h.call("learner", "GET", "/sales/offers?ventureId=venture-a")).body).data;
  const draftOffer = listed.find((offer) => offer.id === first.offerId)!;
  assert.deepEqual([draftOffer.name, draftOffer.state, draftOffer.approved, draftOffer.proposals.map((item) => item.id), draftOffer.counts], ["Dealer Commerce", "active", null, [first.id], { leads: 0, open: 0, plays: 0 }]);
  assert.equal(await defaultOfferId(db, "workspace-a", "venture-a"), undefined, "a draft offer is not usable");

  // Who may propose: writers of the venture (and Claude); not a learner, not another venture's people. Names are one per venture, any case.
  expectStatus(await propose(h, "learner", { ventureId: "venture-a", name: "Learner offer", packet: packet("No") }), 403);
  expectStatus(await propose(h, "outsider", { ventureId: "venture-a", name: "Outsider offer", packet: packet("No") }), 404);
  assert.match(message(expectStatus(await propose(h, "contrib2", { ventureId: "venture-a", name: "  dealer COMMERCE ", packet: packet("Twice") }), 409)), /Another offer of this venture is called "Dealer Commerce"/);
  expectStatus(await propose(h, "contrib", { ventureId: "venture-a", name: "Bad", packet: { ...packet("x"), gates: [{ code: "not a code!", rule: "x", ifFails: "reject" }] } }), 400);
  expectStatus(await h.call("outsider", "GET", `/sales/offers/${first.offerId}`), 404);
  assert.deepEqual((await h.call("outsider", "GET", "/sales/offers?ventureId=venture-a")).data, []);

  // Editing a draft: its proposer or a venture head; another contributor can't.
  expectStatus(await h.call("contrib2", "PATCH", `/sales/offers/versions/${first.id}`, { change: "Not mine" }), 403);
  assert.equal(expectStatus(await h.call("contrib", "PATCH", `/sales/offers/versions/${first.id}`, { change: "The owner's offer, edited" }), 200).data.change, "The owner's offer, edited");
  assert.equal(expectStatus(await h.call("head", "PATCH", `/sales/offers/versions/${first.id}`, { packet: packet("Catalog-to-order systems for dealer-led suppliers, edited") }), 200).data.packet.summary, "Catalog-to-order systems for dealer-led suppliers, edited");

  // Approving is a person's decision in the app: never Claude (whoever it acts for), never a contributor.
  expectStatus(await h.call("head", "POST", `/sales/offers/versions/${first.id}/approve`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("admin", "POST", `/sales/offers/versions/${first.id}/approve`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("contrib", "POST", `/sales/offers/versions/${first.id}/approve`, {}), 403);
  expectStatus(await h.call("learner", "POST", `/sales/offers/versions/${first.id}/approve`, {}), 403);
  const approved = offerSchema.parse(expectStatus(await h.call("head", "POST", `/sales/offers/versions/${first.id}/approve`, {}), 200).data);
  assert.deepEqual([approved.approved?.id, approved.approved?.status, approved.approved?.approvedBy, approved.proposals], [first.id, "approved", "user-head", []]);
  expectStatus(await h.call("head", "POST", `/sales/offers/versions/${first.id}/approve`, {}), 409);
  expectStatus(await h.call("contrib", "PATCH", `/sales/offers/versions/${first.id}`, { change: "After approval" }), 409);
  assert.equal(await defaultOfferId(db, "workspace-a", "venture-a"), first.offerId, "the venture's only usable offer");
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.offer.propose", objectId: first.id, channel: "mcp" }));
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.offer.approve", objectId: first.id, actorId: "user-head" }));
});

test("a new version is a draft until approved; approving archives the version before and renames the offer; drafts can be discarded", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const { offerId, versionId: v1 } = await liveOffer(h, "venture-b", "Startup Partner");
  // The next version, from Claude: the approved one stays in force meanwhile.
  const v2 = offerVersionSchema.parse(expectStatus(await propose(h, "contrib", { ventureId: "venture-b", offerId, name: "Startup Tech Partner", packet: packet("A tech partner for early startups"), change: "Renamed" }, { via: "claude" }), 201).data);
  const v3 = offerVersionSchema.parse(expectStatus(await propose(h, "contrib", { ventureId: "venture-b", offerId, name: "Startup Partner", packet: packet("Another idea"), change: "Alternative" }), 201).data);
  assert.deepEqual([v2.version, v3.version, v2.status], [2, 3, "draft"]);
  expectStatus(await propose(h, "contrib", { ventureId: "venture-a", offerId, name: "Elsewhere", packet: packet("x") }), 400);
  const waiting = offerSchema.parse(expectStatus(await h.call("contrib", "GET", `/sales/offers/${offerId}`), 200).data);
  assert.deepEqual([waiting.approved?.id, waiting.proposals.map((item) => item.version)], [v1, [3, 2]]);

  // Approving v2 archives v1 (by whom, when, replaced by v2) and gives the offer v2's name.
  const after = offerSchema.parse(expectStatus(await h.call("head", "POST", `/sales/offers/versions/${v2.id}/approve`, {}), 200).data);
  assert.deepEqual([after.name, after.approved?.id, after.proposals.map((item) => item.id)], ["Startup Tech Partner", v2.id, [v3.id]]);
  const old = await db.collection("sales_offer_versions").findOne({ _id: v1 });
  assert.deepEqual([old?.status, old?.replacedBy, old?.archivedBy, old?.archivedAt instanceof Date], ["archived", v2.id, "user-head", true]);
  const detail = successEnvelope(offerDetailSchema).parse((await h.call("contrib", "GET", `/sales/offers/${offerId}`)).body).data;
  assert.deepEqual([detail.history.map((item) => [item.version, item.status]), detail.history[0]?.archivedBy], [[[1, "archived"]], "user-head"]);
  expectStatus(await h.call("head", "POST", `/sales/offers/versions/${v1}/approve`, {}), 409);
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.offer.approve", objectId: v2.id, "metadata.replaced": 1 }));

  // Discarding a draft: its proposer or a venture head; the approved version stays in force.
  expectStatus(await h.call("contrib2", "POST", `/sales/offers/versions/${v3.id}/discard`, {}), 404); // contrib2 can't open venture-b
  const discarded = offerVersionSchema.parse(expectStatus(await h.call("contrib", "POST", `/sales/offers/versions/${v3.id}/discard`, {}), 200).data);
  assert.deepEqual([discarded.status, discarded.archivedBy], ["archived", "user-contrib"]);
  expectStatus(await h.call("contrib", "POST", `/sales/offers/versions/${v3.id}/discard`, {}), 409);
  expectStatus(await h.call("head", "POST", `/sales/offers/versions/${v3.id}/approve`, {}), 409);
  assert.equal(offerSchema.parse((await h.call("contrib", "GET", `/sales/offers/${offerId}`)).data).approved?.id, v2.id);
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.offer.discard", objectId: v3.id }));
  // A head discards anyone's draft.
  const v4 = expectStatus(await propose(h, "contrib", { ventureId: "venture-b", offerId, name: "Startup Tech Partner", packet: packet("v4") }), 201).data;
  assert.equal(expectStatus(await h.call("head", "POST", `/sales/offers/versions/${v4.id}/discard`, {}), 200).data.status, "archived");
});

test("pausing, activating and archiving an offer is a venture head's decision in the app; only active offers with an approved packet are usable", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const { offerId } = await liveOffer(h, "venture-d", "Delta Main");
  const state = (who: Who, value: string, options?: { via?: "claude" }) => h.call(who, "POST", `/sales/offers/${offerId}/state`, { state: value }, options);
  expectStatus(await state("contrib", "paused"), 403);
  expectStatus(await state("head", "paused", { via: "claude" }), 403);
  expectStatus(await state("head", "sleeping"), 400);
  assert.equal(offerSchema.parse(expectStatus(await state("head", "paused"), 200).data).state, "paused");
  assert.deepEqual(await usableOffers(db, "workspace-a", "venture-d"), []);
  // A paused offer gets no find runs and is no lead's default; a lead may still name it.
  assert.match(message(expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-d", offerId, request: "Pump dealers" }), 409)), /paused/);
  assert.equal((await lead(h, "venture-d")).offerId, undefined);
  assert.equal((await lead(h, "venture-d", { offerId })).offerId, offerId);
  // Archived: no lead, play or new version may name it.
  assert.equal(offerSchema.parse(expectStatus(await state("admin", "archived"), 200).data).state, "archived");
  assert.match(message(expectStatus(await newLead(h, "contrib", "venture-d", { offerId }), 400)), /archived/);
  expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-d", name: "Archived play", offerId }), 400);
  expectStatus(await propose(h, "contrib", { ventureId: "venture-d", offerId, name: "Delta Main", packet: packet("Again") }), 409);
  assert.equal(offerSchema.parse(expectStatus(await state("head", "active"), 200).data).state, "active");
  assert.equal(await defaultOfferId(db, "workspace-a", "venture-d"), offerId);
  assert.equal(await db.collection("audit_events").countDocuments({ action: "sales.offer.state", objectId: offerId }), 3);
  // The same state again changes nothing and logs nothing.
  expectStatus(await state("head", "active"), 200);
  assert.equal(await db.collection("audit_events").countDocuments({ action: "sales.offer.state", objectId: offerId }), 3);
});

// ---------------------------------------------------------------------------------------------------------------------
// Leads, verdicts, plays, find runs, bulk, CSV
// ---------------------------------------------------------------------------------------------------------------------

test("leads: the venture's only usable offer is the default; an offer must be the lead's venture's and not archived; list filter and facets", skip, async () => {
  const h = await getHarness();
  const venture = "venture-c";
  // venture-c belongs to the outsider (a contributor there); the head is added for this test.
  await h.database.db.collection("memberships").updateOne({ _id: "membership-head" }, { $push: { ventureIds: venture } } as never);
  const call = (method: string, path: string, body?: unknown) => h.call("head", method, path, body);
  const make = async (extra: Record<string, unknown> = {}) => opportunitySchema.parse(expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-c", companyName: `Gammaco${++counter} ${suffix}`, ownerId: "user-head", ...extra }), 201).data);
  // No offer yet: leads have none.
  const before = await make();
  assert.equal(before.offerId, undefined);
  const proposed = offerVersionSchema.parse(expectStatus(await h.call("outsider", "POST", "/sales/offers", { ventureId: venture, name: "Gamma One", packet: packet("Gamma one") }), 201).data);
  expectStatus(await call("POST", `/sales/offers/versions/${proposed.id}/approve`, {}), 200);
  const one = proposed.offerId;
  // One usable offer: the default for new leads.
  const defaulted = await make();
  assert.equal(defaulted.offerId, one);
  // Another venture's offer, or one that doesn't exist, is refused.
  const elsewhere = (await h.database.db.collection("sales_offers").findOne({ ventureId: "venture-a" }))!;
  assert.match(message(expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-c", companyName: "Wrong offer", ownerId: "user-head", offerId: String(elsewhere._id) }), 400)), /does not belong to this venture/);
  expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-c", companyName: "No such offer", ownerId: "user-head", offerId: "offer-nope" }), 400);
  // A second usable offer: no default any more; a lead names one.
  const proposedTwo = offerVersionSchema.parse(expectStatus(await call("POST", "/sales/offers", { ventureId: venture, name: "Gamma Two", packet: packet("Gamma two") }), 201).data);
  expectStatus(await call("POST", `/sales/offers/versions/${proposedTwo.id}/approve`, {}), 200);
  const two = proposedTwo.offerId;
  assert.equal((await make()).offerId, undefined);
  const named = await make({ offerId: two });
  assert.equal(named.offerId, two);
  // Changing a lead's offer: within its venture.
  assert.equal(expectStatus(await call("PATCH", `/sales/leads/${before.id}`, { offerId: two }), 200).data.offerId, two);
  expectStatus(await call("PATCH", `/sales/leads/${before.id}`, { offerId: String(elsewhere._id) }), 400);
  assert.ok(await h.database.db.collection("audit_events").findOne({ action: "sales.lead.update", objectId: before.id, "metadata.fields": "offerId" }));

  // The list filter (an id, or none) and the facets: leads per offer by name, and how many have none.
  const list = async (query: string) => leadListSchema.parse(expectStatus(await call("GET", `/sales/leads?ventureId=${venture}&${query}`), 200).data);
  assert.deepEqual((await list(`offerId=${one}`)).items.map((item) => item.id), [defaulted.id]);
  assert.equal((await list(`offerId=${two}`)).total, 2);
  assert.equal((await list("offerId=none")).total, 1);
  expectStatus(await call("GET", `/sales/leads?ventureId=${venture}&offerId=bad%20id!`), 400);
  const facets = leadFacetsSchema.parse(expectStatus(await call("GET", `/sales/leads/facets?ventureId=${venture}`), 200).data);
  assert.deepEqual([facets.total, facets.offers, facets.notSet.offers], [4, [{ value: two, name: "Gamma Two", count: 2 }, { value: one, name: "Gamma One", count: 1 }], 1]);
  // Each group is counted with the other filters but not its own: choosing an offer still shows the others.
  const narrowed = leadFacetsSchema.parse(expectStatus(await call("GET", `/sales/leads/facets?ventureId=${venture}&offerId=${one}`), 200).data);
  assert.deepEqual([narrowed.total, narrowed.offers.length, narrowed.notSet.offers], [1, 2, 1]);
  const anotherCity = leadFacetsSchema.parse(expectStatus(await call("GET", `/sales/leads/facets?ventureId=${venture}&offerId=none&city=Nowhere`), 200).data);
  assert.deepEqual([anotherCity.total, anotherCity.offers], [0, []]);
  // The offers' counts follow their leads.
  const counted = successEnvelope(offerSchema.array()).parse((await call("GET", `/sales/offers?ventureId=${venture}`)).body).data;
  assert.deepEqual(counted.map((offer) => [offer.name, offer.counts.leads, offer.counts.open]), [["Gamma One", 1, 1], ["Gamma Two", 2, 2]]);
});

test("verdicts: judged against the lead's offer; a lead with none takes the verdict's; naming another offer is refused", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const { offerId: alpha } = await liveOffer(h, "venture-a", "Alpha Second");
  const dealer = (await db.collection("sales_offers").findOne({ ventureId: "venture-a", name: "Dealer Commerce" }))!._id as string;
  // Two usable offers in venture-a now: a new lead has none until a verdict or a person names one.
  const fresh = await lead(h, "venture-a");
  assert.equal(fresh.offerId, undefined);
  const save = (leadId: string, body: Record<string, unknown>, options: { via?: "claude" } = { via: "claude" }) => h.call("contrib", "POST", `/sales/leads/${leadId}/verdicts`, verdict(body), options);
  // Neither the lead nor the verdict names one: saved as before, with its free-text offer only.
  const plain = expectStatus(await save(fresh.id, { decision: "hold", confidence: "low" }), 201).data;
  assert.equal(verdictSchema.parse(plain.verdict).offerId, undefined);
  // A verdict naming an offer gives the lead that offer.
  const other = await lead(h, "venture-a");
  const judged = expectStatus(await save(other.id, { offerId: dealer, offer: "Dealer Commerce" }), 201).data;
  assert.deepEqual([verdictSchema.parse(judged.verdict).offerId, judged.lead.offerId], [dealer, dealer]);
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.verdict.save", objectId: judged.verdict.id, "metadata.offerId": dealer }));
  // Without one named, it is the lead's.
  const again = expectStatus(await save(other.id, { decision: "reject", confidence: "high" }, {}), 201).data;
  assert.equal(again.verdict.offerId, dealer);
  // Naming another offer than the lead's is refused: the lead's offer changes first.
  const third = await lead(h, "venture-a", { offerId: dealer });
  assert.match(message(expectStatus(await save(third.id, { offerId: alpha }), 409)), /pursued for "Dealer Commerce", not "Alpha Second": change the lead's offer first/);
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${third.id}`, { offerId: alpha }), 200);
  assert.equal(expectStatus(await save(third.id, { offerId: alpha }), 201).data.verdict.offerId, alpha);
  // An offer of another venture, or one without an approved packet, can't be judged against.
  const beta = (await db.collection("sales_offers").findOne({ ventureId: "venture-b" }))!._id as string;
  expectStatus(await save((await lead(h, "venture-a")).id, { offerId: beta }), 400);
  const draftOnly = offerVersionSchema.parse(expectStatus(await propose(h, "contrib", { ventureId: "venture-a", name: "Not Yet", packet: packet("Waiting") }), 201).data);
  const fourth = await lead(h, "venture-a");
  assert.match(message(expectStatus(await save(fourth.id, { offerId: draftOnly.offerId }), 409)), /has no approved packet yet/);
  assert.equal((await db.collection("opportunities").findOne({ _id: fourth.id }))?.offerId, undefined, "nothing changed on the refused lead");
});

test("plays take their offer's name; find runs search for a usable offer, by default the venture's only one", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const beta = (await db.collection("sales_offers").findOne({ ventureId: "venture-b" }))!;
  const play = playSchema.parse(expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-b", name: `Startups ${suffix}`, offerId: String(beta._id), offerName: "typed by hand" }), 201).data);
  assert.deepEqual([play.offerId, play.offerName], [String(beta._id), String(beta.name)]);
  const dealer = String((await db.collection("sales_offers").findOne({ ventureId: "venture-a", name: "Dealer Commerce" }))!._id);
  expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-b", name: "Wrong", offerId: dealer }), 400);
  expectStatus(await h.call("contrib", "PATCH", `/sales/plays/${play.id}`, { offerId: dealer }), 400);
  const counts = successEnvelope(offerSchema.array()).parse((await h.call("contrib", "GET", "/sales/offers?ventureId=venture-b")).body).data;
  assert.equal(counts.find((offer) => offer.id === String(beta._id))?.counts.plays, 1);
  // venture-b sells one usable offer: a run without one named searches for it.
  const run = findRunSchema.parse(expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-b", request: "Startups in Pune" }), 201).data);
  assert.equal(run.offerId, String(beta._id));
  expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-b", request: "Wrong offer", offerId: dealer }), 400);
  // venture-a sells several: a run without one named has none (the finder's own default rules apply).
  assert.equal(findRunSchema.parse(expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Pump dealers" }), 201).data).offerId, undefined);
  assert.equal(findRunSchema.parse(expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Pump dealers", offerId: dealer }), 201).data).offerId, dealer);
  const notYet = String((await db.collection("sales_offers").findOne({ ventureId: "venture-a", name: "Not Yet" }))!._id);
  assert.match(message(expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Waiting", offerId: notYet }), 409)), /no approved packet/);
});

test("bulk: move leads to an offer, each checked like a single edit; CSV export names the offer and the import maps an Offer column by name", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const dealer = String((await db.collection("sales_offers").findOne({ ventureId: "venture-a", name: "Dealer Commerce" }))!._id);
  const second = String((await db.collection("sales_offers").findOne({ ventureId: "venture-a", name: "Alpha Second" }))!._id);
  const city = `Bulkpur ${suffix}`;
  const [a, b, c] = [await lead(h, "venture-a", { city, offerId: dealer }), await lead(h, "venture-a", { city }), await lead(h, "venture-a", { city, offerId: second })];
  const theirs = opportunitySchema.parse(expectStatus(await newLead(h, "contrib2", "venture-a", { city }), 201).data);
  const inBeta = await lead(h, "venture-b", { city });
  const bulk = (who: Who, body: Record<string, unknown>, options?: { via?: "claude" }) => h.call(who, "POST", "/sales/leads/bulk", body, options);
  const moved = successEnvelope(bulkResultSchema).parse(expectStatus(await bulk("contrib", { ids: [a.id, b.id, c.id, theirs.id, inBeta.id], action: "offer", offerId: second }), 200).body).data;
  assert.deepEqual([moved.changed, moved.unchanged, moved.skippedCount], [1 + 1, 1, 2]);
  assert.deepEqual(moved.skipped.map((item) => [item.id, /owner or a venture head|does not belong/.test(item.reason)]), [[theirs.id, true], [inBeta.id, true]]);
  assert.deepEqual(await Promise.all([a, b, c, theirs].map(async (item) => (await db.collection("opportunities").findOne({ _id: item.id }))?.offerId)), [second, second, second, undefined]);
  // By filter, as a head: every lead of the city that isn't on the offer yet.
  const byFilter = successEnvelope(bulkResultSchema).parse(expectStatus(await bulk("head", { filter: { ventureId: "venture-a", city }, action: "offer", offerId: dealer }), 200).body).data;
  assert.deepEqual([byFilter.changed, byFilter.unchanged], [4, 0]);
  expectStatus(await bulk("contrib", { ids: [a.id], action: "offer", offerId: "offer-nope" }), 400);
  expectStatus(await bulk("contrib", { ids: [a.id], action: "offer", offerId: dealer }, { via: "claude" }), 403);
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.lead.bulk", "metadata.action": "offer" }));

  // The CSV export has an Offer column with the offer's name.
  const csv = parseCsv(expectStatus(await h.call("contrib", "GET", `/sales/leads/export.csv?ventureId=venture-a&city=${encodeURIComponent(city)}&sort=name`), 200).text);
  const column = csv[0]!.indexOf("Offer");
  assert.equal(csv[0]![column - 1], "Stage");
  assert.deepEqual(csv.slice(1).map((row) => row[column]), ["Dealer Commerce", "Dealer Commerce", "Dealer Commerce", "Dealer Commerce"]);

  // The import maps an "Offer" column by name (any case); an unknown or archived offer keeps the row out; an empty cell takes the
  // venture's only usable offer (venture-b has one), or none when there are several (venture-a).
  const beta = String((await db.collection("sales_offers").findOne({ ventureId: "venture-b" }))!._id);
  const file = ["Company,City,Offer", `Imp One ${suffix},Pune,startup tech PARTNER`, `Imp Two ${suffix},Pune,`, `Imp Three ${suffix},Pune,Nothing Like It`].join("\n");
  const preview = expectStatus(await h.call("contrib", "POST", "/sales/leads/import/preview", { ventureId: "venture-b", csv: file }), 200).data;
  assert.deepEqual([preview.mapping.offer, preview.counts.ok, preview.counts.invalid], [2, 2, 1]);
  assert.match(preview.issues.find((row: any) => row.status === "invalid").problems[0], /Offer not found: Nothing Like It \(this venture's offers: Startup Tech Partner\)/);
  const committed = expectStatus(await h.call("contrib", "POST", "/sales/leads/import/commit", { ventureId: "venture-b", csv: file, mapping: preview.mapping }), 201).data;
  assert.equal(committed.created, 2);
  const imported = await db.collection("opportunities").find({ importBatchId: committed.batchId }).sort({ companyName: 1 }).toArray();
  assert.deepEqual(imported.map((row) => [row.companyName, row.offerId]), [[`Imp One ${suffix}`, beta], [`Imp Two ${suffix}`, beta]]);
  const severalFile = ["Company,Offer", `Imp Four ${suffix},`, `Imp Five ${suffix},alpha second`].join("\n");
  const several = expectStatus(await h.call("contrib", "POST", "/sales/leads/import/commit", { ventureId: "venture-a", csv: severalFile, mapping: { company: 0, offer: 1 } }), 201).data;
  assert.deepEqual((await db.collection("opportunities").find({ importBatchId: several.batchId }).sort({ companyName: 1 }).toArray()).map((row) => [row.companyName, row.offerId ?? null]), [[`Imp Five ${suffix}`, second], [`Imp Four ${suffix}`, null]]);
});

test("the brain keeps shared notes: offer, target profile and message rules proposals are refused, and so is approving an old draft of one", skip, async () => {
  const h = await getHarness();
  for (const kind of ["offer", "target_profile", "message_rules"]) {
    for (const options of [undefined, { via: "claude" as const }]) {
      const refused = expectStatus(await h.call("contrib", "POST", "/sales/brain", { ventureId: "venture-a", kind, title: `Old ${kind}`, body: "Old style" }, options), 400);
      assert.match(message(refused), /now live in offers, one packet per offer: propose a new offer or a new version of one/);
    }
  }
  for (const kind of ["notes", "venture_settings"]) expectStatus(await h.call("contrib", "POST", "/sales/brain", { ventureId: "venture-a", kind, title: `Shared ${kind} ${suffix}`, body: "Background" }), 201);
  const legacyDraft = `legacy-${suffix}`;
  await h.database.db.collection("sales_brain_items").insertOne({ _id: legacyDraft, workspaceId: "workspace-a", ventureId: "venture-a", kind: "message_rules", title: "Old rules", body: "Rules", status: "draft", version: 1, proposedBy: "user-contrib", via: "claude", createdAt: new Date(), updatedAt: new Date() });
  assert.match(message(expectStatus(await h.call("head", "POST", `/sales/brain/${legacyDraft}/approve`, {}), 400)), /message rules, which can no longer be approved here/);
  assert.equal((await h.database.db.collection("sales_brain_items").findOne({ _id: legacyDraft }))?.status, "draft");
});

test("deleting a venture permanently removes its offers and their versions, its sales settings and its import records", skip, async (t) => {
  const h = await getHarness();
  const db = h.database.db;
  // The permanent delete needs a MongoDB replica set (transactions); a standalone server refuses it (409) and the test says it skipped.
  if (!h.database.transactions) {
    expectStatus(await h.call("admin", "DELETE", "/ventures/venture-d", { confirmName: "Delta" }), 409);
    t.skip("the permanent delete needs a MongoDB replica set");
    return;
  }
  const offer = (await db.collection("sales_offers").findOne({ ventureId: "venture-d" }))!;
  assert.ok(await db.collection("sales_offer_versions").countDocuments({ offerId: offer._id }) > 0);
  const now = new Date();
  await db.collection("sales_settings").insertOne({ _id: "venture-d" as never, workspaceId: offer.workspaceId, timezone: "Asia/Kolkata", updatedAt: now });
  await db.collection("sales_imports").insertOne({ _id: `${String(offer.workspaceId)}:venture-d:hash` as never, workspaceId: offer.workspaceId, ventureId: "venture-d", hash: "hash", created: 1, createdAt: now });
  expectStatus(await h.call("admin", "POST", "/ventures/venture-d/archive", {}), 200);
  const deleted = expectStatus(await h.call("admin", "DELETE", "/ventures/venture-d", { confirmName: "Delta" }), 200).data;
  assert.ok(deleted.counts.sales_offers >= 1 && deleted.counts.sales_offer_versions >= 1, JSON.stringify(deleted.counts));
  assert.deepEqual([deleted.counts.sales_settings, deleted.counts.sales_imports], [1, 1]);
  assert.equal(await db.collection("sales_offers").countDocuments({ ventureId: "venture-d" }), 0);
  assert.equal(await db.collection("sales_offer_versions").countDocuments({ ventureId: "venture-d" }), 0);
  assert.equal(await db.collection("sales_settings").countDocuments({ _id: "venture-d" as never }), 0);
  assert.ok(await db.collection("deleted_records").findOne({ collection: "sales_offers", ventureId: "venture-d" }), "kept as a recovery copy");
});

// ---------------------------------------------------------------------------------------------------------------------
// The migration (scripts/migrate-offers.ts), on a throwaway database
// ---------------------------------------------------------------------------------------------------------------------

const OFFER_BODY = `Internal test offer for Buildory. Map and implement a catalog-to-order workflow for dealer-led suppliers. Each engagement needs discovery.

## Value proposition
Give staff and dealers one traceable path from price to order.

## Exclusions
- No dealer or B2B order workflow.

## Approved claims
- No quantitative claims are approved.

## Proof
- Internal reference only.

## Pitch angles
- Ask how dealer prices and orders move today.

## Claims to avoid
- Guaranteed revenue or ROI.

## Price boundary
No standard price approved.

## Owner
Buildory HQ`;
const PROFILE_BODY = `RESEARCH DRAFT dated 2026-10-01 from the founders' sales training. Not approved. WHO: owner-led suppliers in Chhattisgarh that sell through dealers.

## Target industries
- pumps
- irrigation products

## Target customer types
- manufacturer

## Positive signals
- dealer enquiry
- rate list

## Exclusions
- pesticide formulations
- Address outside Chhattisgarh (G1).
- Already has a dealer portal (G4); an unclear case is Hold with a question.
- Agri business in Raipur city (G9; buckets B and C are allowed in Raipur).
- FMCG distributor: weak fit.

## Price boundary
No price in first outreach.

## Buyer roles
- Owner

## Company sizes
- Owner-led

## Locations
- Chhattisgarh

## Notes
Roll-out: Chhattisgarh first.`;
const RUBRIC_BODY = `RESEARCH DRAFT dated 2026-10-01, from the founders' training. Not approved.

MODEL: SEE IT, LINK IT, GATE IT.

GATES (every one must pass): G1 address in Chhattisgarh (start with Raipur). G4 no dealer portal (unclear = Hold). G9 (bucket A only): an agri business in Raipur city is rejected as 'G9 Raipur'.

SCORE (only after every gate): 1 to 3 per criterion.

## Claims to avoid
- Stating that the business has a problem.

## Notes
Open points: size floor.`;

test("the migration moves a venture's brain into one offer: v1 approved from the items, v2 drafted from its packet file, the items retired and every link set; a dry run writes nothing and a second run changes nothing", skip, async () => {
  const client = new MongoClient(mongoUrl!);
  await client.connect();
  const db = client.db(`vso_test_offers_migrate_${suffix}`);
  try {
    const at = (day: string) => new Date(`${day}T10:00:00Z`);
    const item = (id: string, kind: string, title: string, body: string, status = "approved", extra: Record<string, unknown> = {}) => ({
      _id: id, workspaceId: "workspace-m", ventureId: "venture-buildory", kind, title, body, status, version: 1, proposedBy: "user-owner", via: status === "draft" ? "claude" : "import",
      ...(status === "approved" ? { approvedBy: "user-owner", approvedAt: at("2026-10-10") } : {}), createdAt: at("2026-10-01"), updatedAt: at("2026-10-01"), ...extra,
    });
    await db.collection<any>("sales_brain_items").insertMany([
      item("offer-item", "offer", "Dealer Commerce Implementation — Agricultural Equipment & Irrigation", OFFER_BODY, "approved", { approvedAt: at("2026-09-25") }),
      item("profile-1", "target_profile", "Research draft — Founders' batch-1 target profile (Buildory buckets A, B, C)", PROFILE_BODY),
      item("profile-2", "target_profile", "Research draft — Tier B: regional distributors", "RESEARCH DRAFT dated 2026-09-29. Not approved. Distributors that supply sub-dealers.\n\n## Target industries\n- pipes\n\n## Owner\nX"),
      item("rules-1", "message_rules", "Research draft — Message rules for first contact (Buildory)", "RESEARCH DRAFT dated 2026-10-01 from Class C. Email first.\n\n## Pitch angles\n- One CTA.\n\n## Source date\n2026-10-01\n\n## Owner\nX"),
      item("rubric-1", "notes", "Research draft — Qualification rubric (from founders' sales training)", RUBRIC_BODY),
      item("notes-1", "notes", "Buildory — business and delivery knowledge", "How we deliver."),
      item("draft-offer", "offer", "Dealer Commerce — catalog-to-order", "Draft", "draft"),
      item("draft-profile", "target_profile", "Buildory target profile", "Draft", "draft"),
      item("draft-rubric", "notes", "Buildory qualification rubric — gates G1 to G9 and scoring", "Draft", "draft"),
      item("draft-note", "notes", "Timing and triggers 2026-27", "Draft", "draft"),
      { ...item("other-draft", "message_rules", "Another venture's rules", "Draft", "draft"), ventureId: "venture-other" },
    ]);
    const now = new Date();
    await db.collection<any>("opportunities").insertMany([
      { _id: "m-lead-1", workspaceId: "workspace-m", ventureId: "venture-buildory", companyName: "Live Co", stage: "identified", deletedAt: null, createdAt: now },
      { _id: "m-lead-2", workspaceId: "workspace-m", ventureId: "venture-buildory", companyName: "Deleted Co", stage: "identified", deletedAt: now, createdAt: now },
      { _id: "m-lead-3", workspaceId: "workspace-m", ventureId: "venture-other", companyName: "Other Co", stage: "identified", deletedAt: null, createdAt: now },
    ]);
    await db.collection<any>("sales_verdicts").insertOne({ _id: "m-verdict", workspaceId: "workspace-m", ventureId: "venture-buildory", leadId: "m-lead-1", offer: "Dealer app", createdAt: now });
    await db.collection<any>("sales_plays").insertOne({ _id: "m-play", workspaceId: "workspace-m", ventureId: "venture-buildory", name: "Play", createdAt: now });
    await db.collection<any>("sales_find_runs").insertOne({ _id: "m-run", workspaceId: "workspace-m", ventureId: "venture-buildory", request: "Pumps", createdAt: now });
    const snapshot = async () => JSON.stringify(await Promise.all(["sales_brain_items", "opportunities", "sales_verdicts", "sales_plays", "sales_find_runs", "sales_offers", "sales_offer_versions"].map((name) => db.collection(name).find({}).sort({ _id: 1 }).toArray())));

    // A dry run says what it would do and writes nothing.
    const before = await snapshot();
    const dry = await migrateOffers(db, { dryRun: true, actor: "user-owner" });
    assert.equal(await snapshot(), before);
    assert.deepEqual(dry.map((report) => [report.ventureId, report.offerName, report.offer, report.v2, report.archived.length, report.discarded.length, report.linked]), [
      ["venture-buildory", "Dealer Commerce", "created", "created", 5, 3, { opportunities: 2, deletedLeads: 1, sales_verdicts: 1, sales_plays: 1, sales_find_runs: 1 }],
    ]);
    assert.match(describeMigration(dry, true), /venture-buildory: offer "Dealer Commerce" would be created[\s\S]*v1, approved, would be mapped from 5 items: 3 gates, 2 look-for signals, 1 negatives, 2 exclusions, 2 industries, 1 places[\s\S]*to link to the offer: 2 leads \(1 of them deleted\), 1 verdicts, 1 plays, 1 find runs/);

    // The real run.
    const [done] = await migrateOffers(db, { dryRun: false, actor: "user-owner", now });
    const offer = (await db.collection<any>("sales_offers").findOne({ ventureId: "venture-buildory" }))!;
    assert.deepEqual([offer._id, offer.name, offer.state, offer.workspaceId, offer.migratedFrom], [done!.offerId, "Dealer Commerce", "active", "workspace-m", "brain"]);
    const versions = await db.collection<any>("sales_offer_versions").find({ offerId: offer._id }).sort({ version: 1 }).toArray();
    assert.deepEqual(versions.map((version) => [version.version, version.status, version.via]), [[1, "approved", "import"], [2, "draft", "claude"]]);
    const [v1, v2] = versions;
    assert.equal(offer.approvedVersionId, v1._id);
    // v1 keeps the items' approval, and maps them field by field.
    assert.deepEqual([v1.approvedBy, v1.approvedAt.toISOString(), v1.proposedBy, v1.name], ["user-owner", at("2026-10-10").toISOString(), "user-owner", "Dealer Commerce"]);
    const p = offerPacketSchema.parse(v1.packet);
    assert.equal(p.summary, "Internal test offer for Buildory. Map and implement a catalog-to-order workflow for dealer-led suppliers. Each engagement needs discovery.");
    assert.equal(p.whoFor.description, "WHO: owner-led suppliers in Chhattisgarh that sell through dealers.");
    assert.deepEqual([p.whoFor.industries, p.whoFor.customerTypes, p.whoFor.places, p.whoFor.buyerRoles, p.whoFor.companySizes], [["pumps", "irrigation products"], ["manufacturer"], ["Chhattisgarh"], ["Owner"], ["Owner-led"]]);
    assert.deepEqual(p.gates, [
      { code: "G1", rule: "Address in Chhattisgarh (start with Raipur).", ifFails: "reject", note: "Fails when: Address outside Chhattisgarh." },
      { code: "G4", rule: "No dealer portal (unclear = Hold).", ifFails: "reject", note: "Fails when: Already has a dealer portal; an unclear case is Hold with a question." },
      { code: "G9", rule: "(bucket A only): an agri business in Raipur city is rejected as 'G9 Raipur'.", ifFails: "reject", note: "Fails when: Agri business in Raipur city (buckets B and C are allowed in Raipur)." },
    ]);
    assert.deepEqual([p.signals.lookFor.map((signal) => signal.phrase), p.signals.negatives, p.signals.searchWords], [["dealer enquiry", "rate list"], ["pesticide formulations"], []]);
    assert.deepEqual(p.exclusions, ["FMCG distributor: weak fit.", "No dealer or B2B order workflow."]);
    assert.deepEqual([p.say.valueProposition, p.say.pitchAngles, p.say.proofWords, p.say.approvedClaims, p.say.claimsToAvoid], ["Give staff and dealers one traceable path from price to order.", ["Ask how dealer prices and orders move today."], "Internal reference only.", ["No quantitative claims are approved."], ["Guaranteed revenue or ROI."]]);
    assert.equal(p.price, "No standard price approved.\n\nNo price in first outreach.");
    assert.equal(p.messages, "Email first.\n\n## Pitch angles\n- One CTA.");
    assert.equal(p.scoring, "MODEL: SEE IT, LINK IT, GATE IT.\n\nSCORE (only after every gate): 1 to 3 per criterion.\n\nClaims to avoid in research: Stating that the business has a problem.");
    assert.match(p.notes, /^From the target profile "Research draft — Founders' batch-1 target profile \(Buildory buckets A, B, C\)": Roll-out: Chhattisgarh first\.\n\nFrom the rubric "[^"]+": Open points: size floor\.\n\n### Research draft — Tier B: regional distributors\nDistributors that supply sub-dealers\.\nTarget industries: pipes$/);
    // v2 is the packet file's draft, by Claude, for the owner to approve.
    const file = JSON.parse((await import("node:fs")).readFileSync(new URL("../scripts/offer-packets/buildory-dealer-commerce-v2.json", import.meta.url), "utf8"));
    assert.deepEqual([v2.name, v2.change, v2.proposedBy, v2.packet], [file.name, file.change, "user-owner", offerPacketSchema.parse(file.packet)]);
    // The API reads the migrated offer as the contract says.
    const shown = offerSchema.parse((await offersJson({ db: new AppDb(db), workspaceId: "workspace-m" }, [offer]))[0]);
    assert.deepEqual([shown.approved?.version, shown.proposals.map((version) => version.version), shown.counts], [1, [2], { leads: 1, open: 1, plays: 1 }]);

    // The old items: approved legacy ones and the rubric retire into v1; the legacy drafts and the rubric draft are discarded; the rest stay.
    const items = new Map((await db.collection<any>("sales_brain_items").find({}).toArray()).map((row) => [row._id, row]));
    for (const id of ["offer-item", "profile-1", "profile-2", "rules-1", "rubric-1"]) assert.deepEqual([items.get(id).status, items.get(id).replacedBy, items.get(id).archivedBy], ["archived", v1._id, "user-owner"], id);
    for (const id of ["draft-offer", "draft-profile", "draft-rubric"]) assert.deepEqual([items.get(id).status, items.get(id).replacedBy, /version 2 of the offer "Dealer Commerce"/.test(items.get(id).archivedReason)], ["archived", undefined, true], id);
    assert.deepEqual(["notes-1", "draft-note", "other-draft"].map((id) => items.get(id).status), ["approved", "draft", "draft"]);
    // Every link of the venture, deleted leads included; nothing of another venture.
    const offerOf = async (name: string, id: string) => (await db.collection<any>(name).findOne({ _id: id }))?.offerId;
    assert.deepEqual(await Promise.all([offerOf("opportunities", "m-lead-1"), offerOf("opportunities", "m-lead-2"), offerOf("opportunities", "m-lead-3"), offerOf("sales_verdicts", "m-verdict"), offerOf("sales_plays", "m-play"), offerOf("sales_find_runs", "m-run")]), [offer._id, offer._id, undefined, offer._id, offer._id, offer._id]);
    assert.ok(await db.collection("audit_events").findOne({ action: "sales.offer.migrate", objectId: offer._id }));

    // A second run finds everything done.
    const after = await snapshot();
    const [second] = await migrateOffers(db, { dryRun: false, actor: "user-owner" });
    assert.deepEqual([second!.offer, second!.v2, second!.archived, second!.discarded, second!.linked], ["exists", "exists", [], [], { opportunities: 0, deletedLeads: 0, sales_verdicts: 0, sales_plays: 0, sales_find_runs: 0 }]);
    assert.equal(await snapshot(), after);
    assert.equal(await db.collection("sales_offers").countDocuments({}), 1);

    // An offer of that name made in the app first is never overwritten: that venture is skipped.
    await db.collection<any>("sales_brain_items").insertOne(item("clash-offer", "offer", "Clash Offer — anything", "Text", "approved", { ventureId: "venture-clash" }));
    await db.collection<any>("sales_offers").insertOne({ _id: "made-in-app", workspaceId: "workspace-m", ventureId: "venture-clash", name: "clash offer", state: "active", createdAt: now, updatedAt: now });
    const clash = (await migrateOffers(db, { dryRun: false, actor: "user-owner", ventureId: "venture-clash" }))[0]!;
    assert.match(String(clash.skipped), /already exists in this venture/);
    assert.equal((await db.collection<any>("sales_brain_items").findOne({ _id: "clash-offer" }))?.status, "approved");
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});

test("the migration's text helpers: sections, draft status lines", () => {
  const parsed = parseBody("Intro line\n\n## Value proposition\nOne path\n\n## Pitch angles\n- a\n- b");
  assert.deepEqual([parsed.intro, parsed.sections.get("value proposition"), parsed.sections.get("pitch angles")], ["Intro line", "One path", "- a\n- b"]);
  assert.equal(withoutDraftStatus("RESEARCH DRAFT dated 2026-10-01 from notes. Not approved. WHO: owners. Not approved into the brain: a person approves wording."), "WHO: owners. Not approved into the brain: a person approves wording.");
  assert.throws(() => v1Packet({ otherProfiles: [], messageRules: [] }), /summary|Too small|>=1/i, "no item to name the offer: not a valid packet");
});
