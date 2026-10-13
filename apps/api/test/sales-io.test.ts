import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after } from "node:test";
import express from "express";
import { BULK_MAX, bulkResultSchema, importPreviewSchema, importResultSchema, leadListSchema, savedViewSchema, successEnvelope } from "@venture-studio/contracts";
import { loadConfig } from "../src/config.js";
import { connectDatabase, type Database } from "../src/db.js";
import { createErrorHandler } from "../src/errors.js";
import { ensureIndexes } from "../src/indexes.js";
import { actorFor } from "../src/middleware.js";
import { salesIoRoutes } from "../src/routes/sales-io.js";
import { salesRoutes } from "../src/routes/sales.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { LocalObjectStore } from "../src/storage.js";
import { CSV_BOM, csvCell, csvRow, detectDelimiter, parseCsv } from "../src/sales/csv.js";
import { cleanCell, guessMapping, readEmailCell, readPhoneCell } from "../src/sales/io.js";

// ---------------------------------------------------------------------------------------------------------------------
// CSV reading and writing (no database)
// ---------------------------------------------------------------------------------------------------------------------

test("CSV cells are quoted and defused, and files are read the way spreadsheets write them", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell("cr\rhere"), '"cr\rhere"'); // a line break inside quotes (the apostrophe is for cells that START like a formula)
  assert.equal(csvCell("\rstart"), "\"'\rstart\"");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell("मोहन ट्रेडर्स"), "मोहन ट्रेडर्स");
  // A spreadsheet runs cells that start like a formula: they get an apostrophe, a plain phone number with a plus does not.
  for (const risky of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd"]) assert.ok(csvCell(risky).startsWith("'") || csvCell(risky).startsWith('"\''), risky);
  // A number with a plus would be worked out as a sum ("+1-202-555-0143"): it gets the apostrophe too, and the import takes it off again.
  assert.equal(csvCell("+91 98765 43210"), "'+91 98765 43210");
  // Leading spaces, no-break and zero-width spaces and the full-width signs hide a formula from a quick look: defused as well.
  for (const hidden of [" =1+1", "\u00a0=1+1", "\u200b=1+1", "\uff1d1+1", "\uff0b1", "\ufeff@x", "-5"]) assert.equal(csvCell(hidden), `'${hidden}`, JSON.stringify(hidden));
  assert.equal(csvRow(["a", "b,c", 'd"e']), 'a,"b,c","d""e"');

  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("﻿name,city\nAcme,Raipur"), [["name", "city"], ["Acme", "Raipur"]]);
  assert.deepEqual(parseCsv('n,t\n"Sharma, Sons","say ""hi"""\n"two\nlines",x\n'), [["n", "t"], ["Sharma, Sons", 'say "hi"'], ["two\nlines", "x"]]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,b\n\n,\n1,\n"), [["a", "b"], ["1", ""]]); // blank rows are dropped
  assert.deepEqual(parseCsv('a,b\n5" pipe,x'), [["a", "b"], ['5" pipe', "x"]]); // a quote inside an unquoted cell is just text
  assert.deepEqual(parseCsv('a,b\n"",x'), [["a", "b"], ["", "x"]]);
  assert.throws(() => parseCsv('a,b\n"never closed,x'), /quote that never closes/);
  assert.equal(detectDelimiter('"a,b,c";d;e'), ";");
  assert.equal(detectDelimiter("a,b,c"), ",");
  assert.equal(detectDelimiter("plain"), ",");
  assert.ok(CSV_BOM.startsWith("\ufeff"));
  // What the exporter writes, the importer reads back unchanged.
  const cells = ['Sharma "Best" Traders, Raipur', "line1\nline2", "=1+1", "+91 98765 43210", "मोहन"];
  assert.deepEqual(parseCsv(csvRow(cells))[0], [cells[0], cells[1], "'=1+1", `'${cells[3]}`, cells[4]]);
});

test("import columns are guessed from the header names, each column once", () => {
  const mapping = guessMapping(["Business Name", "Contact Person", "Website URL", "Industry", "City", "State", "Mobile", "E-mail", "Notes"]);
  assert.deepEqual([mapping.company, mapping.contactName, mapping.website, mapping.category, mapping.city, mapping.region, mapping.phone, mapping.email, mapping.country, mapping.tags], [0, 1, 2, 3, 4, 5, 6, 7, null, null]);
  // "Name" alone is the company unless a better column exists; a "Contact name" column is the person.
  const plain = guessMapping(["Name", "Contact name", "Phone"]);
  assert.deepEqual([plain.company, plain.contactName, plain.phone], [0, 1, 2]);
  assert.equal(guessMapping(["Foo", "Bar"]).company, null);
  // A yes/no "Contacted?" column is not the contact person; "Contact person name" and "Contact" are.
  const yesNo = guessMapping(["Name", "Contact Number", "Email", "Website", "Company Size", "Contacted?", "Business Type"]);
  assert.deepEqual([yesNo.company, yesNo.phone, yesNo.contactName, yesNo.category], [0, 1, null, 6]);
  assert.equal(guessMapping(["Company", "Primary contact person name"]).contactName, 1);
  assert.equal(guessMapping(["Company", "Contact"]).contactName, 1);
  // An "Offer" column names the venture's offer by name; without one, no column is taken for it.
  assert.deepEqual([guessMapping(["Company", "Offer"]).offer, guessMapping(["Company", "Offer name", "City"]).offer, guessMapping(["Company", "City"]).offer], [1, 1, null]);
});

test("import cells: numbers split on / and are kept only in full, a mailto cell keeps one address, safety apostrophes and invisible characters come off", () => {
  // The four cells from the audit: "/" separates numbers; a second number written as its last digits is left out with a note.
  const first = readPhoneCell("0771-2345678 / 79");
  assert.deepEqual([first.phones, first.problems], [["+917712345678"], []]);
  assert.match(first.notes[0]!, /Second number incomplete: .79./);
  assert.deepEqual(readPhoneCell("0771 2345678/79").phones, ["+917712345678"]);
  assert.equal(readPhoneCell("0771 2345678/79").notes.length, 1);
  assert.deepEqual(readPhoneCell("98270 12345 / 98270 12346"), { phones: ["+919827012345", "+919827012346"], problems: [], notes: [] });
  const plus = readPhoneCell("+91 98270 12345 / 46");
  assert.deepEqual([plus.phones, plus.problems, plus.notes.length], [["+919827012345"], [], 1]);
  // Never "+0..." (a trunk 0 read as a country code), never outside 8 to 15 digits.
  assert.deepEqual(readPhoneCell("0771 2345678 79").phones, []);
  assert.match(readPhoneCell("0771 2345678 79").problems[0]!, /not recognised/);
  assert.deepEqual(readPhoneCell("1234567").phones, []);
  assert.deepEqual(readPhoneCell("+1-202-555-0143").phones, ["+12025550143"]);
  assert.deepEqual(readPhoneCell("98765 43210 ext 23"), { phones: ["+919876543210"], problems: [], notes: [] });
  // A mailto-style cell keeps the address before "?" and only the first one; a plain list keeps up to three.
  assert.deepEqual(readEmailCell("a@x.in?cc=evil@z.com"), ["a@x.in"]);
  assert.deepEqual(readEmailCell("mailto:a@x.in,b@y.in?bcc=c@z.in"), ["a@x.in"]);
  assert.deepEqual(readEmailCell("a@x.in; b@y.in"), ["a@x.in", "b@y.in"]);
  // What our export (or a spreadsheet) put in front of a formula-looking cell comes off; other apostrophes stay.
  assert.equal(cleanCell("'=1+1"), "=1+1");
  assert.equal(cleanCell("'+91 98765 43210"), "+91 98765 43210");
  assert.equal(cleanCell("'@handle"), "@handle");
  assert.equal(cleanCell("'-5"), "-5");
  assert.equal(cleanCell("'hello"), "'hello");
  assert.equal(cleanCell("\u200b\ufeff Acme "), "Acme");
  assert.equal(cleanCell(csvCell("+91 98765 43210")), "+91 98765 43210");
});

// ---------------------------------------------------------------------------------------------------------------------
// API tests on a real MongoDB (set TEST_MONGODB_URI); a throwaway database that is dropped at the end
// ---------------------------------------------------------------------------------------------------------------------

type Who = "admin" | "head" | "contrib" | "contrib2" | "learner" | "outsider";
type Reply = { status: number; body: any; data: any; text: string; headers: Headers };
type Harness = { database: Database; call: (who: Who, method: string, path: string, body?: unknown, options?: { via?: "claude" }) => Promise<Reply>; server: Server };

const mongoUrl = process.env.TEST_MONGODB_URI;
const skip = { skip: !mongoUrl };
const suffix = randomUUID().slice(0, 6);
const dbName = `vso_test_salesio_${suffix}`;
let harness: Promise<Harness> | undefined;
let counter = 0;

async function setup(): Promise<Harness> {
  assert.match(dbName, /^vso_test_salesio_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  const db = database.db;
  await ensureIndexes(db);
  const now = new Date();
  await db.collection("workspaces").insertOne({ _id: "workspace-a", name: "A", slug: "a", createdAt: now });
  await db.collection("ventures").insertMany([
    { _id: "venture-a", workspaceId: "workspace-a", name: "Alpha", status: "active", createdAt: now }, { _id: "venture-b", workspaceId: "workspace-a", name: "Beta", status: "active", createdAt: now },
    { _id: "venture-n", workspaceId: "workspace-a", name: "No pipeline", status: "active", createdAt: now },
  ]);
  await db.collection("pipelines").insertMany([
    { _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha leads", offerName: "Offer", status: "active", createdAt: now, updatedAt: now },
    { _id: "pipeline-b", workspaceId: "workspace-a", ventureId: "venture-b", name: "Beta leads", offerName: "Offer", status: "active", createdAt: now, updatedAt: now },
  ]);
  await db.collection("sales_plays").insertMany([
    { _id: "play-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha play", status: "approved", createdAt: now, updatedAt: now },
    { _id: "play-b", workspaceId: "workspace-a", ventureId: "venture-b", name: "Beta play", status: "approved", createdAt: now, updatedAt: now },
  ]);
  const people: [Who, string, string[]][] = [
    ["admin", "admin", []], ["head", "venture_head", ["venture-a", "venture-n"]], ["contrib", "contributor", ["venture-a", "venture-n"]], ["contrib2", "contributor", ["venture-a"]], ["learner", "learner", ["venture-a"]], ["outsider", "contributor", ["venture-b"]],
  ];
  await db.collection("users").insertMany(people.map(([handle]) => ({ _id: `user-${handle}`, workspaceId: "workspace-a", email: `${handle}@example.invalid`, name: handle === "contrib" ? "Casey Contrib" : handle, handle, status: "active", createdAt: now, updatedAt: now })));
  await db.collection("memberships").insertMany(people.map(([handle, role, ventureIds]) => ({ _id: `membership-${handle}`, workspaceId: "workspace-a", userId: `user-${handle}`, role, ventureIds, groupIds: [], status: "active", createdAt: now, updatedAt: now })));

  // The Sales routes behind a small stand-in for sign-in, mounted the way app.ts mounts them (the IO routes first).
  const app = express();
  app.use(express.json({ limit: "12mb" }));
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
  app.use(createErrorHandler(db));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const call: Harness["call"] = async (who, method, path, body, options = {}) => {
    const response = await fetch(`${origin}/v1${path}`, { method, headers: { "content-type": "application/json", "x-test-user": `user-${who}`, ...(options.via === "claude" ? { "x-test-via": "claude" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Keep a byte order mark in the text (response.text() drops it).
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* a CSV */ }
    return { status: response.status, body: json, data: json?.data, text, headers: response.headers };
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

const expectStatus = (reply: Reply, status: number) => { assert.equal(reply.status, status, reply.text.slice(0, 600)); return reply; };
const parse = <T>(schema: { parse: (value: unknown) => T }, value: unknown): T => schema.parse(value);

async function newLead(h: Harness, who: Who, extra: Record<string, unknown> = {}) {
  const n = ++counter;
  const reply = expectStatus(await h.call(who, "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Bulko${n}x ${suffix}`, ownerId: `user-${who}`, ...extra }), 201);
  return reply.data as { id: string; companyName: string; stage: string; tags: string[]; ownerId: string; playId?: string };
}
const leadDoc = async (h: Harness, id: string) => (await h.database.db.collection("opportunities").findOne({ _id: id }))!;
const bulk = async (h: Harness, who: Who, body: Record<string, unknown>) => h.call(who, "POST", "/sales/leads/bulk", body);
const result = (reply: Reply) => parse(successEnvelope(bulkResultSchema), reply.body).data;

// ---------------------------------------------------------------------------------------------------------------------
// Bulk edits
// ---------------------------------------------------------------------------------------------------------------------

test("bulk edits check every lead like a single edit and report the ones they skip", skip, async () => {
  const h = await getHarness();
  const mine = [await newLead(h, "contrib"), await newLead(h, "contrib"), await newLead(h, "contrib")];
  const theirs = await newLead(h, "contrib2");
  const ids = [...mine.map((lead) => lead.id), theirs.id];

  // Tagging: an owner tags their own leads and is refused (per lead, not for the whole call) on someone else's.
  const tagged = result(expectStatus(await bulk(h, "contrib", { ids, action: "tag", tag: "Raipur-batch" }), 200));
  assert.deepEqual([tagged.matched, tagged.changed, tagged.unchanged, tagged.skippedCount], [4, 3, 0, 1]);
  assert.equal(tagged.skipped[0]!.id, theirs.id);
  assert.match(tagged.skipped[0]!.reason, /owner or a venture head/);
  assert.deepEqual((await leadDoc(h, mine[0]!.id)).tags, ["Raipur-batch"]);
  assert.deepEqual((await leadDoc(h, theirs.id)).tags ?? [], []);
  // Again: nothing to do (case does not matter), and it is not an error.
  const again = result(expectStatus(await bulk(h, "contrib", { ids: mine.map((lead) => lead.id), action: "tag", tag: "raipur-BATCH" }), 200));
  assert.deepEqual([again.changed, again.unchanged, again.skippedCount], [0, 3, 0]);
  const untagged = result(expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id, mine[1]!.id], action: "untag", tag: "raipur-batch" }), 200));
  assert.deepEqual([untagged.changed, untagged.unchanged], [2, 0]);
  assert.deepEqual((await leadDoc(h, mine[0]!.id)).tags, []);
  assert.equal(result(expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id], action: "untag", tag: "never-there" }), 200)).unchanged, 1);
  // A head tags anyone's; a lead keeps at most 20 tags.
  assert.equal(result(expectStatus(await bulk(h, "head", { ids: [theirs.id], action: "tag", tag: "head-tag" }), 200)).changed, 1);
  const full = await newLead(h, "contrib", { tags: Array.from({ length: 20 }, (_, index) => `t${index}`) });
  const over = result(expectStatus(await bulk(h, "contrib", { ids: [full.id], action: "tag", tag: "one-more" }), 200));
  assert.deepEqual([over.changed, over.skippedCount], [0, 1]);
  assert.match(over.skipped[0]!.reason, /20 tags/);

  // Assigning is a head's job, to a member of the venture.
  const assign = result(expectStatus(await bulk(h, "contrib", { ids: [mine[2]!.id], action: "assign", ownerId: "user-contrib2" }), 200));
  assert.deepEqual([assign.changed, assign.skippedCount], [0, 1]);
  assert.match(assign.skipped[0]!.reason, /venture head/);
  const assigned = result(expectStatus(await bulk(h, "head", { ids: [mine[2]!.id, theirs.id], action: "assign", ownerId: "user-contrib2" }), 200));
  assert.deepEqual([assigned.changed, assigned.unchanged], [1, 1]); // theirs is already contrib2's
  assert.equal((await leadDoc(h, mine[2]!.id)).ownerId, "user-contrib2");
  const outsiderOwner = result(expectStatus(await bulk(h, "head", { ids: [mine[1]!.id], action: "assign", ownerId: "user-outsider" }), 200));
  assert.equal(outsiderOwner.skippedCount, 1); // not a member of the venture
  assert.equal((await leadDoc(h, mine[1]!.id)).ownerId, "user-contrib");

  // Stages: the rules of a single move apply (a lost lead needs both reasons), and a lead already there is unchanged.
  expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id], action: "stage", stage: "lost" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id], action: "stage", stage: "lost", exitReason: "No budget" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id], action: "stage", stage: "researched", lostReason: "price" }), 400);
  const moved = result(expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id, mine[1]!.id], action: "stage", stage: "researched" }), 200));
  assert.deepEqual([moved.changed, moved.unchanged], [2, 0]);
  assert.equal((await leadDoc(h, mine[0]!.id)).stage, "researched");
  assert.equal(result(expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id], action: "stage", stage: "researched" }), 200)).unchanged, 1);
  const lost = result(expectStatus(await bulk(h, "contrib", { ids: [mine[0]!.id], action: "stage", stage: "lost", exitReason: "Chose another vendor", lostReason: "chose_competitor" }), 200));
  assert.equal(lost.changed, 1);
  const lostDoc = await leadDoc(h, mine[0]!.id);
  assert.deepEqual([lostDoc.stage, lostDoc.lostReason, lostDoc.exitReason], ["lost", "chose_competitor", "Chose another vendor"]);

  // Plays must belong to the lead's venture.
  assert.equal(result(expectStatus(await bulk(h, "contrib", { ids: [mine[1]!.id], action: "play", playId: "play-a" }), 200)).changed, 1);
  assert.equal((await leadDoc(h, mine[1]!.id)).playId, "play-a");
  const wrongPlay = result(expectStatus(await bulk(h, "contrib", { ids: [mine[1]!.id], action: "play", playId: "play-b" }), 200));
  assert.deepEqual([wrongPlay.changed, wrongPlay.skippedCount], [0, 1]);

  // Every lead edited is audited, and so is the call.
  const audits = await h.database.db.collection("audit_events").find({ action: "sales.lead.bulk" }).toArray();
  assert.ok(audits.length >= 5);
  assert.ok(await h.database.db.collection("audit_events").findOne({ action: "sales.lead.update", objectId: mine[0]!.id }));
});

test("bulk deletes follow the single delete rules; names the person cannot open are not found; learners, outsiders and Claude cannot", skip, async () => {
  const h = await getHarness();
  const fresh = await newLead(h, "contrib");
  const touched = await newLead(h, "contrib");
  await h.database.db.collection("opportunities").updateOne({ _id: touched.id }, { $set: { lastTouchAt: new Date(), stage: "contacted" } });
  const others = await newLead(h, "contrib2");
  const deleted = result(expectStatus(await bulk(h, "contrib", { ids: [fresh.id, touched.id, others.id, randomUUID()], action: "delete" }), 200));
  assert.deepEqual([deleted.matched, deleted.changed, deleted.skippedCount], [3, 1, 3]);
  assert.deepEqual(deleted.skipped.map((item) => item.reason).sort(), ["Lead not found", "Only a venture head or admin can delete a lead (its owner can until the first contact)", "Only a venture head or admin can delete a lead (its owner can until the first contact)"]);
  assert.ok((await leadDoc(h, fresh.id)).deletedAt);
  assert.ok(!(await leadDoc(h, touched.id)).deletedAt);
  const byHead = result(expectStatus(await bulk(h, "head", { ids: [touched.id, others.id], action: "delete" }), 200));
  assert.equal(byHead.changed, 2);
  // Deleted leads are gone for everyone, including a second delete.
  assert.equal(result(expectStatus(await bulk(h, "head", { ids: [touched.id], action: "delete" }), 200)).skippedCount, 1);

  const target = await newLead(h, "contrib");
  assert.equal(result(expectStatus(await bulk(h, "learner", { ids: [target.id], action: "tag", tag: "x" }), 200)).changed, 0);
  assert.match(result(await bulk(h, "learner", { ids: [target.id], action: "tag", tag: "x" })).skipped[0]!.reason, /read-only|owner or a venture head/);
  assert.deepEqual([result(await bulk(h, "outsider", { ids: [target.id], action: "tag", tag: "x" })).matched, result(await bulk(h, "outsider", { ids: [target.id], action: "delete" })).skipped[0]!.reason], [0, "Lead not found"]);
  assert.deepEqual((await leadDoc(h, target.id)).tags ?? [], []);
  expectStatus(await h.call("contrib", "POST", "/sales/leads/bulk", { ids: [target.id], action: "tag", tag: "x" }, { via: "claude" }), 403);
  expectStatus(await h.call("contrib", "POST", "/sales/leads/bulk", { ids: [target.id], action: "stage", stage: "researched" }, { via: "claude" }), 403);
});

test("bulk calls take ids or a filter, never both, never more than 500, and a filter that matches more is cut at 500", skip, async () => {
  const h = await getHarness();
  expectStatus(await bulk(h, "contrib", { action: "tag", tag: "x" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: [], action: "tag", tag: "x" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: [randomUUID()], filter: { q: "x" }, action: "tag", tag: "x" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: Array.from({ length: BULK_MAX + 1 }, () => randomUUID()), action: "tag", tag: "x" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: [randomUUID()], action: "explode" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: [randomUUID()], action: "tag", tag: "" }), 400);
  expectStatus(await bulk(h, "contrib", { ids: [randomUUID()], action: "tag", tag: "x".repeat(41) }), 400);

  // A filter: every lead the Leads list would show for it.
  const tag = `cohort-${suffix}`;
  const a = await newLead(h, "contrib", { city: `Filterville ${suffix}` });
  const b = await newLead(h, "contrib", { city: `Filterville ${suffix}` });
  await newLead(h, "contrib", { city: "Elsewhere" });
  const byFilter = result(expectStatus(await bulk(h, "contrib", { filter: { city: `Filterville ${suffix}` }, action: "tag", tag }), 200));
  assert.deepEqual([byFilter.matched, byFilter.changed, byFilter.truncated], [2, 2, false]);
  assert.deepEqual([(await leadDoc(h, a.id)).tags, (await leadDoc(h, b.id)).tags], [[tag], [tag]]);
  // The filter sees what the person sees: another venture's leads are not matched.
  assert.equal(result(expectStatus(await bulk(h, "outsider", { filter: { city: `Filterville ${suffix}` }, action: "tag", tag }), 200)).matched, 0);
  assert.equal(result(expectStatus(await bulk(h, "contrib", { filter: { ventureId: "venture-b", city: `Filterville ${suffix}` }, action: "tag", tag }), 200)).matched, 0);

  // More than 500 match: the first 500 are used and the answer says so.
  const now = new Date();
  const city = `Bigtown ${suffix}`;
  await h.database.db.collection("opportunities").insertMany(Array.from({ length: BULK_MAX + 5 }, (_, index) => ({
    _id: randomUUID(), workspaceId: "workspace-a", ventureId: "venture-a", pipelineId: "pipeline-a", companyName: `Mass ${index} ${suffix}`, contactName: "", source: "", observedSignal: "", fitReason: "", evidenceConfidence: "low", stage: "identified",
    ownerId: "user-contrib", nextAction: "", contactRoutes: [], tags: [], city, deletedAt: null, createdAt: now, updatedAt: now,
  })));
  const big = result(expectStatus(await bulk(h, "head", { filter: { city }, action: "tag", tag: "mass" }), 200));
  assert.deepEqual([big.matched, big.changed, big.unchanged, big.truncated, big.remaining], [BULK_MAX, BULK_MAX, 0, true, 5]);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ city, tags: "mass" }), BULK_MAX);
  // The same change again reaches the rest: leads already tagged are counted, not taken again (the tag in any case).
  const rest = result(expectStatus(await bulk(h, "head", { filter: { city }, action: "tag", tag: "mass" }), 200));
  assert.deepEqual([rest.matched, rest.changed, rest.unchanged, rest.truncated, rest.remaining], [5, 5, BULK_MAX, false, undefined]);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ city, tags: "mass" }), BULK_MAX + 5);
  const done = result(expectStatus(await bulk(h, "head", { filter: { city }, action: "tag", tag: "MASS" }), 200));
  assert.deepEqual([done.matched, done.changed, done.unchanged], [0, 0, BULK_MAX + 5]);
  // Moves, owners and plays work the same way: a lead already there is not taken again.
  const moved = result(expectStatus(await bulk(h, "head", { filter: { city }, action: "stage", stage: "researched" }), 200));
  assert.deepEqual([moved.changed, moved.truncated, moved.remaining], [BULK_MAX, true, 5]);
  const movedRest = result(expectStatus(await bulk(h, "head", { filter: { city }, action: "stage", stage: "researched" }), 200));
  assert.deepEqual([movedRest.changed, movedRest.unchanged, movedRest.truncated], [5, BULK_MAX, false]);
  const untag = result(expectStatus(await bulk(h, "head", { filter: { city }, action: "untag", tag: "mass" }), 200));
  assert.deepEqual([untag.changed, untag.truncated, untag.remaining], [BULK_MAX, true, 5]);
});

test("bulk calls refuse won stages, skip do-not-contact leads for contact stages, and check permission before saying nothing changed", skip, async () => {
  const h = await getHarness();
  const city = `Rulesville ${suffix}`;
  const lead = await newLead(h, "contrib", { city });
  const blocked = await newLead(h, "contrib", { city });
  await h.database.db.collection("opportunities").updateOne({ _id: blocked.id }, { $set: { doNotContact: true } });
  // Winning is one deal at a time.
  for (const stage of ["invoice_contract", "cash_collected", "delivery", "retained_referred"]) {
    const refused = expectStatus(await bulk(h, "head", { ids: [lead.id], action: "stage", stage }), 400);
    assert.match(refused.body.error.message, /won one at a time/i);
  }
  assert.equal((await leadDoc(h, lead.id)).stage, "identified");
  // A do-not-contact lead is never moved into a contact stage, by id or by filter; closing it is fine.
  const byIds = result(expectStatus(await bulk(h, "contrib", { ids: [lead.id, blocked.id], action: "stage", stage: "approved_for_contact" }), 200));
  assert.deepEqual([byIds.changed, byIds.skippedCount, byIds.skipped[0]?.id], [1, 1, blocked.id]);
  assert.match(byIds.skipped[0]!.reason, /^Do not contact/);
  const byFilter = result(expectStatus(await bulk(h, "contrib", { filter: { city }, action: "stage", stage: "contacted" }), 200));
  assert.deepEqual([byFilter.changed, byFilter.skippedCount, byFilter.skipped[0]?.id], [1, 1, blocked.id]);
  assert.match(byFilter.skipped[0]!.reason, /^Do not contact/);
  assert.equal((await leadDoc(h, blocked.id)).stage, "identified");
  const closed = result(expectStatus(await bulk(h, "contrib", { ids: [blocked.id], action: "stage", stage: "disqualified", exitReason: "Asked us to stop" }), 200));
  assert.equal(closed.changed, 1);

  // Permission first: a learner hears "read-only" even when the lead already has the tag; a contributor reassigning hears "venture head".
  await bulk(h, "contrib", { ids: [lead.id], action: "tag", tag: "vip" });
  const learner = result(expectStatus(await bulk(h, "learner", { ids: [lead.id], action: "tag", tag: "VIP" }), 200));
  assert.deepEqual([learner.unchanged, learner.skippedCount], [0, 1]);
  assert.match(learner.skipped[0]!.reason, /read-only/);
  const learnerStage = result(expectStatus(await bulk(h, "learner", { ids: [lead.id], action: "stage", stage: "contacted" }), 200));
  assert.deepEqual([learnerStage.unchanged, learnerStage.skippedCount], [0, 1]);
  const sameOwner = result(expectStatus(await bulk(h, "contrib", { ids: [lead.id], action: "assign", ownerId: "user-contrib" }), 200));
  assert.deepEqual([sameOwner.unchanged, sameOwner.skippedCount], [0, 1]);
  assert.match(sameOwner.skipped[0]!.reason, /venture head/);
});

// ---------------------------------------------------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------------------------------------------------

test("the export is a CSV of the filtered leads: business fields only, escaped, with a byte order mark", skip, async () => {
  const h = await getHarness();
  const city = `Exportville ${suffix}`;
  const nasty = await newLead(h, "contrib", {
    city, companyName: `Sharma "Best", Sons\nTraders ${suffix}`, contactName: "=HYPERLINK(\"http://evil.example\")", website: "https://sharma.example", category: "Pipes, fittings", valueEstimateMinor: 1_250_000, currency: "INR", source: "justdial",
    tags: ["a", "b"], contactRoutes: [{ kind: "phone", value: "+91 98765 43210" }, { kind: "email", value: "sharma@sharma.example" }], observedSignal: "SECRET internal note", nextAction: "Call back",
  });
  const blocked = await newLead(h, "contrib", { city, companyName: `Blocked Co ${suffix}`, contactRoutes: [{ kind: "phone", value: "98765 99999" }, { kind: "email", value: "x@blocked.example" }] });
  await h.database.db.collection("opportunities").updateOne({ _id: blocked.id }, { $set: { doNotContact: true } });
  await newLead(h, "contrib", { city: "Elsewhere" });

  const reply = expectStatus(await h.call("contrib", "GET", `/sales/leads/export.csv?city=${encodeURIComponent(city)}&sort=name`), 200);
  assert.match(reply.headers.get("content-type") ?? "", /^text\/csv; charset=utf-8/);
  assert.match(reply.headers.get("content-disposition") ?? "", /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.deepEqual([reply.headers.get("x-exported-rows"), reply.headers.get("x-matching-rows")], ["2", "2"]);
  assert.ok(reply.text.startsWith(CSV_BOM));
  const rows = parseCsv(reply.text);
  assert.deepEqual(rows[0], ["Company", "Contact person", "Website", "Industry", "City", "State", "Country", "Phone", "Email", "Stage", "Offer", "Owner", "Next action", "Next action date", "Deal value", "Currency", "Expected close", "Chance (%)", "Source", "Tags", "Do not contact", "Added"]);
  assert.equal(rows.length, 3);
  const [first, second] = [rows[1]!, rows[2]!];
  // Sorted by name: "Blocked Co" before "Sharma".
  assert.equal(first[0], `Blocked Co ${suffix}`);
  assert.deepEqual([first[7], first[8], first[20]], ["", "", "Yes"]); // a do-not-contact lead is exported without its phone and email
  assert.equal(second[0], `Sharma "Best", Sons\nTraders ${suffix}`);
  assert.equal(second[1], "'=HYPERLINK(\"http://evil.example\")");
  // The Offer column is empty for a venture without offers (sales-offers.test.ts covers it with offers).
  assert.deepEqual([second[2], second[3], second[4], second[7], second[8], second[9], second[10], second[11], second[12], second[14], second[15], second[17], second[18], second[19], second[20]], ["https://sharma.example", "Pipes, fittings", city, "'+91 98765 43210", "sharma@sharma.example", "Identified", "", "Casey Contrib", "Call back", "12500", "INR", "2", "justdial", "a; b", ""]);
  assert.match(String(second[21]), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!reply.text.includes("SECRET internal note")); // no research notes, verdicts or activity
  assert.ok(reply.text.includes("\r\n"));
  assert.equal(nasty.stage, "identified");

  // The filters are the list's filters; no match is just the header.
  const stage = await h.call("contrib", "GET", `/sales/leads/export.csv?city=${encodeURIComponent(city)}&stage=lost`);
  assert.equal(parseCsv(expectStatus(stage, 200).text).length, 1);
  assert.deepEqual([stage.headers.get("x-exported-rows"), stage.headers.get("x-matching-rows")], ["0", "0"]);
  // Who may export: writers of the venture. Learners, other ventures' people and Claude may not.
  expectStatus(await h.call("learner", "GET", "/sales/leads/export.csv"), 403);
  expectStatus(await h.call("learner", "GET", "/sales/leads/export.csv?ventureId=venture-a"), 403);
  expectStatus(await h.call("outsider", "GET", "/sales/leads/export.csv?ventureId=venture-a"), 404);
  expectStatus(await h.call("contrib", "GET", "/sales/leads/export.csv?ventureId=venture-a", undefined, { via: "claude" }), 403);
  expectStatus(await h.call("contrib", "GET", "/sales/leads/export.csv?stage=nonsense"), 400);
  // Without a venture an outsider exports only what they can open: nothing of venture A.
  assert.ok(!(await h.call("outsider", "GET", `/sales/leads/export.csv?city=${encodeURIComponent(city)}`)).text.includes(suffix));
  assert.ok(await h.database.db.collection("audit_events").findOne({ action: "sales.lead.export" }));
});

// ---------------------------------------------------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------------------------------------------------

const preview = async (h: Harness, who: Who, body: Record<string, unknown>) => h.call(who, "POST", "/sales/leads/import/preview", { ventureId: "venture-a", ...body });
const commit = async (h: Harness, who: Who, body: Record<string, unknown>) => h.call(who, "POST", "/sales/leads/import/commit", { ventureId: "venture-a", ...body });

test("an import preview guesses the columns and flags invalid rows, duplicates of the venture's leads, repeats in the file and do-not-contact rows", skip, async () => {
  const h = await getHarness();
  const tag = suffix.toUpperCase();
  // Already in the venture: by website, by email, by company name (in Raipur), and one with a different city.
  await newLead(h, "contrib", { companyName: `Alpha Pipes Pvt Ltd ${tag}`, website: `https://www.alphapipes${suffix}.example`, city: "Raipur" });
  await newLead(h, "contrib", { companyName: `Email Owner ${tag}`, contactRoutes: [{ kind: "email", value: `sales@emailowner${suffix}.example` }] });
  await newLead(h, "contrib", { companyName: `Sharma Traders ${tag}`, city: "Raipur" });
  // A suppressed company (workspace-wide do-not-contact list).
  expectStatus(await h.call("admin", "POST", "/sales/suppression", { kind: "domain", value: `blocked${suffix}.example`, reason: "Asked not to be contacted" }), 201);
  const csv = [
    "Business Name,Website,City,Phone,Email,Tags,Value,Notes",
    `Alpha Pipes ${tag},alphapipes${suffix}.example,Bilaspur,91234 56789,,pipes; b2b,"12,50,000",first`, // same website
    `Other Name ${tag},,Durg,,SALES@EmailOwner${suffix}.EXAMPLE,,,second`, // same email, other spelling
    `Sharma Traders ${tag},,Raipur,,,,,third`, // same name, same city
    `Sharma Traders ${tag},,Nagpur,,,,,fourth`, // same name, other city: a different business
    `Fresh One ${tag},fresh${suffix}.example,Raipur,+91 99999 11111,fresh@fresh${suffix}.example,,,`,
    `Fresh One ${tag},fresh${suffix}.example,Raipur,,,,,`, // repeats the row above
    `,,Raipur,,,,,`, // no company
    `Bad Phone ${tag},,Raipur,call me maybe,,,,`,
    `Bad Mail ${tag},,Raipur,,not-an-email,,,`,
    `Bad Site ${tag},ftp://files.example,Raipur,,,,,`,
    `Bad Value ${tag},,Raipur,,,,lots,`,
    `Blocked Co ${tag},www.blocked${suffix}.example,Raipur,,,,,`,
    `"Quoted, Name ""Ltd"" ${tag}",,Raipur,"98765 00000 / 98765 00001",,,,"multi ` + "\n" + `line"`,
  ].join("\r\n");
  const reply = expectStatus(await preview(h, "contrib", { csv }), 200);
  const data = parse(successEnvelope(importPreviewSchema), reply.body).data;
  assert.equal(data.delimiter, ",");
  assert.equal(data.guessed, true);
  assert.deepEqual([data.mapping.company, data.mapping.website, data.mapping.city, data.mapping.phone, data.mapping.email, data.mapping.tags, data.mapping.value, data.mapping.contactName], [0, 1, 2, 3, 4, 5, 6, null]);
  assert.deepEqual(data.missing, []);
  assert.equal(data.total, 13);
  assert.deepEqual(data.counts, { ok: 3, duplicate: 4, invalid: 5, doNotContact: 1 }); // ok: rows 5, 6, 14; duplicate: 2, 3, 4, 7; invalid: 8-12; do not contact: 13
  const byRow = new Map([...data.sample, ...data.issues].map((row) => [row.row, row]));
  // Spreadsheet rows: the header is row 1.
  assert.equal(byRow.get(2)!.status, "duplicate");
  assert.match(byRow.get(2)!.problems[0]!, /Already in this venture as Alpha Pipes Pvt Ltd .* \(the same website\)/);
  assert.equal(byRow.get(3)!.status, "duplicate");
  assert.match(byRow.get(3)!.problems[0]!, /the same email/);
  assert.equal(byRow.get(4)!.status, "duplicate");
  assert.match(byRow.get(4)!.problems[0]!, /the same company name/);
  assert.equal(byRow.get(5)!.status, "ok"); // same name in another city
  assert.equal(byRow.get(6)!.status, "ok");
  assert.equal(byRow.get(7)!.status, "duplicate");
  assert.deepEqual([byRow.get(7)!.duplicateOf!.row, byRow.get(7)!.duplicateOf!.leadId], [6, undefined]);
  assert.match(byRow.get(8)!.problems.join(), /Company name is missing/);
  assert.match(byRow.get(9)!.problems.join(), /Phone number not recognised/);
  assert.match(byRow.get(10)!.problems.join(), /Email address not recognised/);
  assert.match(byRow.get(11)!.problems.join(), /Website must be a web address/);
  assert.match(byRow.get(12)!.problems.join(), /Value is not an amount/);
  assert.equal(byRow.get(13)!.status, "do_not_contact");
  assert.ok(!byRow.has(14)); // an ok row past the first ten (the sample) is only counted: the quoted name and two phone numbers read fine
  assert.deepEqual(data.issues.map((row) => row.row), [2, 3, 4, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(data.issuesTruncated, false);
  // Previewing creates nothing.
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ companyName: new RegExp(`Fresh One ${tag}`) }), 0);

  // The person picks the columns themselves: the same file, the company in another column, a header-less file.
  const picked = parse(successEnvelope(importPreviewSchema), (await preview(h, "contrib", { csv: "x,y\nAcme Co,Raipur", mapping: { company: 0, city: 1 } })).body).data;
  assert.deepEqual([picked.guessed, picked.counts.ok], [false, 1]);
  const noHeader = parse(successEnvelope(importPreviewSchema), (await preview(h, "contrib", { csv: `Acme Co ${tag},Raipur`, hasHeader: false, mapping: { company: 0, city: 1 } })).body).data;
  assert.deepEqual([noHeader.columns, noHeader.sample[0]!.row, noHeader.counts.ok], [["Column 1", "Column 2"], 1, 1]);
  // No company column: every row says so, and the preview names what is missing.
  const noCompany = parse(successEnvelope(importPreviewSchema), (await preview(h, "contrib", { csv: "foo,bar\n1,2" })).body).data;
  assert.deepEqual([noCompany.missing, noCompany.counts.invalid], [["company"], 1]);
});

test("an import commit creates the clean rows for the importer, skips the rest, and running it again creates nothing", skip, async () => {
  const h = await getHarness();
  const tag = `C${suffix.toUpperCase()}`;
  const csv = [
    "Company;Website;City;Phone;E-mail;Tags;Value;Source",
    `Rani Pipes ${tag};ranipipes${suffix}.example;Raipur;98765 12345;info@ranipipes${suffix}.example;pipes, b2b;"2,50,000";Trade list 2026`,
    `Sita Steel ${tag};;Bhilai;;;;;`,
    `;;;;;;;`,
    `Bad Mail ${tag};;;;nope;;;`,
  ].join("\n");
  const created = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv, mapping: { company: 0, website: 1, city: 2, phone: 3, email: 4, tags: 5, value: 6, source: 7 } }), 201).body).data;
  assert.deepEqual([created.total, created.created, created.duplicates, created.doNotContact, created.invalid], [3, 2, 0, 0, 1]);
  const rani = await h.database.db.collection("opportunities").findOne({ companyName: `Rani Pipes ${tag}` });
  assert.ok(rani);
  assert.deepEqual([rani.ownerId, rani.stage, rani.ventureId, rani.pipelineId, rani.city, rani.website, rani.source, rani.valueEstimateMinor, rani.currency, rani.importBatchId], ["user-contrib", "identified", "venture-a", "pipeline-a", "Raipur", `ranipipes${suffix}.example`, "Trade list 2026", 25_000_000, "INR", created.batchId]);
  assert.deepEqual(rani.tags, ["pipes", "b2b"]);
  assert.deepEqual(rani.contactRoutes.map((route: any) => [route.kind, route.value]), [["phone", "+919876512345"], ["email", `info@ranipipes${suffix}.example`]]);
  assert.ok(rani.suppressKeys.includes(`domain:ranipipes${suffix}.example`));
  const sita = await h.database.db.collection("opportunities").findOne({ companyName: `Sita Steel ${tag}` });
  assert.equal(sita!.source, "CSV import");
  assert.ok(await h.database.db.collection("audit_events").findOne({ action: "sales.lead.import", objectId: created.batchId }));
  // They show up in the Leads list like any lead.
  const list = parse(successEnvelope(leadListSchema), (await h.call("contrib", "GET", `/sales/leads?q=${encodeURIComponent(tag)}`)).body).data;
  assert.equal(list.total, 2);

  // The same file again (other line ends too): it was imported before, so nothing is created and the answer says when. Even with the
  // duplicate switch: re-importing a whole file would copy every lead it created.
  const mapping = { company: 0, website: 1, city: 2, phone: 3, email: 4, tags: 5, value: 6, source: 7 };
  const again = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv: csv.replace(/\n/g, "\r\n"), mapping }), 200).body).data;
  assert.deepEqual([again.created, again.duplicates, again.invalid, again.alreadyImported?.batchId, again.alreadyImported?.created], [0, 2, 1, created.batchId, 2]);
  const forcedSame = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv, importDuplicates: true, mapping }), 200).body).data;
  assert.deepEqual([forcedSame.created, !!forcedSame.alreadyImported], [0, true]);
  // Another file whose rows match leads already here: skipped as duplicates, and the duplicate switch brings them in anyway.
  const raniOnly = csv.split("\n").slice(0, 2).join("\n");
  const skippedDup = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv: raniOnly, mapping }), 201).body).data;
  assert.deepEqual([skippedDup.created, skippedDup.duplicates, skippedDup.alreadyImported], [0, 1, undefined]);
  const forced = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv: raniOnly, importDuplicates: true, mapping }), 201).body).data;
  assert.deepEqual([forced.created, forced.duplicates], [1, 0]);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ companyName: `Rani Pipes ${tag}` }), 2);
  // A commit that died after making its leads but before recording the file: committing it again (duplicate switch on) adds nothing twice.
  assert.equal((await h.database.db.collection("sales_imports").deleteOne({ batchId: forced.batchId })).deletedCount, 1);
  const retried = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv: raniOnly, importDuplicates: true, mapping }), 201).body).data;
  assert.equal(retried.created, 0);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ companyName: `Rani Pipes ${tag}` }), 2);

  // A head and an admin import for themselves too; the importer owns what they import, whoever they are.
  const byHead = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "head", { csv: `Name\nHead Import ${tag}`, mapping: { company: 0 } }), 201).body).data;
  assert.equal(byHead.created, 1);
  assert.equal((await h.database.db.collection("opportunities").findOne({ companyName: `Head Import ${tag}` }))!.ownerId, "user-head");
  // Mistakes in the request: no company column, a pipeline of another venture, a venture without a pipeline, an empty file, a broken quote, too many rows.
  expectStatus(await commit(h, "contrib", { csv, mapping: { city: 2 } }), 400);
  expectStatus(await commit(h, "contrib", { csv, mapping: { company: 0 }, pipelineId: "pipeline-b" }), 400);
  expectStatus(await commit(h, "contrib", { ventureId: "venture-n", csv, mapping: { company: 0 } }), 400);
  expectStatus(await commit(h, "contrib", { csv: "   ", mapping: { company: 0 } }), 400);
  expectStatus(await commit(h, "contrib", { csv: 'a\n"broken', mapping: { company: 0 } }), 400);
  expectStatus(await commit(h, "contrib", { csv: `Company\n${Array.from({ length: 5001 }, (_, index) => `Row ${index}`).join("\n")}`, mapping: { company: 0 } }), 400);
});

test("an import is for people who can add leads: learners, other ventures' people and Claude cannot, and a file over 5 MB is refused", skip, async () => {
  const h = await getHarness();
  const csv = `Company\nNever Created ${suffix}`;
  for (const path of ["preview", "commit"] as const) {
    const body = { ventureId: "venture-a", csv, mapping: { company: 0 } };
    expectStatus(await h.call("learner", "POST", `/sales/leads/import/${path}`, body), 403);
    expectStatus(await h.call("outsider", "POST", `/sales/leads/import/${path}`, body), 404);
    expectStatus(await h.call("contrib", "POST", `/sales/leads/import/${path}`, body, { via: "claude" }), 403);
    expectStatus(await h.call("contrib", "POST", `/sales/leads/import/${path}`, { csv, mapping: { company: 0 } }), 400); // a venture is required
  }
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ companyName: `Never Created ${suffix}` }), 0);
  const huge = `Company\n${"x".repeat(5_100_000)}`;
  expectStatus(await preview(h, "contrib", { csv: huge }), 400);
});

test("an import refuses long cells before reading them (no freeze), refuses binary files, cuts echoed values and strips invisible characters", skip, async () => {
  const h = await getHarness();
  expectStatus(await preview(h, "contrib", { csv: "Company\nWarm Up" }), 200);
  // One 60,000-character email cell used to take seconds of address hunting; now it is refused unread.
  const started = performance.now();
  const slow = parse(successEnvelope(importPreviewSchema), expectStatus(await preview(h, "contrib", { csv: `Company,Email\nAcme Long,${"a".repeat(60_000)}` }), 200).body).data;
  const took = performance.now() - started;
  assert.ok(took < 200, `preview took ${Math.round(took)} ms`);
  assert.deepEqual([slow.sample[0]!.status, slow.sample[0]!.problems], ["invalid", ["Email is too long (over 320 characters)"]]);
  assert.ok(slow.sample[0]!.values.email!.length <= 200);
  const longPhone = parse(successEnvelope(importPreviewSchema), (await preview(h, "contrib", { csv: `Company,Phone\nAcme,${"9".repeat(400)}` })).body).data;
  assert.match(longPhone.sample[0]!.problems[0]!, /Phone is too long/);
  const longCompany = parse(successEnvelope(importPreviewSchema), (await preview(h, "contrib", { csv: `Company,City\n${"C".repeat(3_000)},Raipur` })).body).data;
  assert.deepEqual([longCompany.sample[0]!.status, longCompany.sample[0]!.problems], ["invalid", ["Company is too long (over 2,000 characters)"]]);
  assert.ok(longCompany.sample[0]!.values.company!.length <= 200);
  // A value between 200 and 2,000 characters is read, and echoed cut to 200.
  const echoed = parse(successEnvelope(importPreviewSchema), (await preview(h, "contrib", { csv: `Company,City\nEcho Co,${"R".repeat(500)}` })).body).data;
  assert.equal(echoed.sample[0]!.values.city!.length, 200);
  // NUL characters: a binary file (or UTF-16 read as UTF-8).
  const binary = expectStatus(await preview(h, "contrib", { csv: "Company\nAc\u0000me" }), 400);
  assert.match(binary.body.error.message, /not a text file/);
  // Zero-width characters and stray byte order marks at the start of a header or cell are dropped; a safety apostrophe comes off.
  const invisible = parse(successEnvelope(importPreviewSchema), (await preview(h, "contrib", { csv: `\u200bCompany,\ufeffPhone\n\ufeff\u200bClean Co ${suffix},'+91 98765 43299` })).body).data;
  assert.deepEqual([invisible.columns, invisible.mapping.company, invisible.mapping.phone], [["Company", "Phone"], 0, 1]);
  assert.deepEqual([invisible.sample[0]!.status, invisible.sample[0]!.values.company, invisible.sample[0]!.values.phone], ["ok", `Clean Co ${suffix}`, "+91 98765 43299"]);
});

test("an import notes an incomplete second number, reports leads deleted earlier, and only takes an active pipeline of the venture", skip, async () => {
  const h = await getHarness();
  const tag = `N${suffix.toUpperCase()}`;
  const gone = await newLead(h, "head", { companyName: `Gone Co ${tag}`, website: `https://gone${suffix}.example` });
  expectStatus(await bulk(h, "head", { ids: [gone.id], action: "delete" }), 200);
  const csv = [
    "Company,Phone,Website",
    `Note Co ${tag},0771-2345678 / 79,`,
    `Gone Again ${tag},,gone${suffix}.example`,
    `Two Numbers ${tag},98270 12345 / 98270 12346,`,
  ].join("\n");
  const mapping = { company: 0, phone: 1, website: 2 };
  const data = parse(successEnvelope(importPreviewSchema), expectStatus(await preview(h, "contrib", { csv, mapping }), 200).body).data;
  assert.deepEqual(data.counts, { ok: 2, duplicate: 1, invalid: 0, doNotContact: 0 });
  const byRow = new Map(data.sample.map((row) => [row.row, row]));
  // A ready row with a note is still ready, and is listed with the rows to look at.
  assert.equal(byRow.get(2)!.status, "ok");
  assert.match(byRow.get(2)!.problems.join(), /Second number incomplete/);
  assert.equal(byRow.get(3)!.status, "duplicate");
  assert.match(byRow.get(3)!.problems[0]!, /Deleted earlier from this venture: Gone Co/);
  assert.equal(byRow.get(3)!.duplicateOf!.leadId, undefined); // never pointed at (or brought back)
  assert.deepEqual(data.issues.map((row) => row.row), [2, 3]);
  const created = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv, mapping }), 201).body).data;
  assert.deepEqual([created.created, created.duplicates], [2, 1]);
  const note = await h.database.db.collection("opportunities").findOne({ companyName: `Note Co ${tag}` });
  assert.deepEqual(note!.contactRoutes.map((route: any) => route.value), ["+917712345678"]);
  const two = await h.database.db.collection("opportunities").findOne({ companyName: `Two Numbers ${tag}` });
  assert.deepEqual(two!.contactRoutes.map((route: any) => route.value), ["+919827012345", "+919827012346"]);
  assert.ok((await leadDoc(h, gone.id)).deletedAt); // still deleted

  // A pipeline named outright must be an active one of the venture.
  const now = new Date();
  await h.database.db.collection("pipelines").insertOne({ _id: `pipeline-a-old-${suffix}`, workspaceId: "workspace-a", ventureId: "venture-a", name: "Old", offerName: "O", status: "archived", createdAt: now, updatedAt: now });
  const archived = expectStatus(await commit(h, "contrib", { csv: `Company\nArchived Pipe ${tag}`, mapping: { company: 0 }, pipelineId: `pipeline-a-old-${suffix}` }), 400);
  assert.match(archived.body.error.message, /not an active pipeline/);
  expectStatus(await preview(h, "contrib", { csv: `Company\nArchived Pipe ${tag}`, pipelineId: `pipeline-a-old-${suffix}` }), 400);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ companyName: `Archived Pipe ${tag}` }), 0);
});

test("one import runs at a time per venture, and the same file committed twice at once creates its leads once", skip, async () => {
  const h = await getHarness();
  const tag = `L${suffix.toUpperCase()}`;
  const locks = h.database.db.collection("sales_import_locks");
  const csv = `Company,City\nLocked One ${tag},Raipur\nLocked Two ${tag},Durg`;
  // Another import of this venture is running: 409, nothing created; previews still work.
  await locks.insertOne({ _id: "workspace-a:venture-a", workspaceId: "workspace-a", ventureId: "venture-a", token: "someone-else", expiresAt: new Date(Date.now() + 60_000) });
  const busy = expectStatus(await commit(h, "contrib", { csv, mapping: { company: 0, city: 1 } }), 409);
  assert.match(busy.body.error.message, /an import is already running for this venture/i);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ companyName: new RegExp(`^Locked .* ${tag}$`) }), 0);
  expectStatus(await preview(h, "contrib", { csv }), 200);
  // Another venture is not held up.
  expectStatus(await h.call("admin", "POST", "/sales/leads/import/commit", { ventureId: "venture-b", csv: `Company\nOther Venture ${tag}`, mapping: { company: 0 } }), 201);
  // A lock left by an import that died expires.
  await locks.updateOne({ _id: "workspace-a:venture-a" }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
  const done = parse(successEnvelope(importResultSchema), expectStatus(await commit(h, "contrib", { csv, mapping: { company: 0, city: 1 } }), 201).body).data;
  assert.equal(done.created, 2);
  assert.equal(await locks.countDocuments({ _id: "workspace-a:venture-a" }), 0); // released
  assert.ok(await h.database.db.collection("sales_imports").findOne({ batchId: done.batchId, ventureId: "venture-a", created: 2 }));

  // Three commits of the same new file at once: one creates the leads; the others are told it is running or was imported.
  const twins = `Company,Website\nTwin One ${tag},twin1${suffix}.example\nTwin Two ${tag},twin2${suffix}.example\nTwin Three ${tag},twin3${suffix}.example`;
  const replies = await Promise.all([1, 2, 3].map(() => commit(h, "contrib", { csv: twins, mapping: { company: 0, website: 1 } })));
  const statuses = replies.map((reply) => reply.status).sort();
  assert.equal(statuses.filter((status) => status === 201).length, 1, JSON.stringify(replies.map((reply) => reply.body)));
  assert.ok(statuses.every((status) => status === 201 || status === 200 || status === 409), statuses.join());
  for (const reply of replies.filter((item) => item.status === 200)) assert.equal(reply.data.alreadyImported.created, 3);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ companyName: new RegExp(`^Twin .* ${tag}$`) }), 3);
  assert.equal(await locks.countDocuments({}), 0);
});

test("the export follows the list's order, next action included", skip, async () => {
  const h = await getHarness();
  const city = `Ordertown ${suffix}`;
  const later = await newLead(h, "contrib", { city, companyName: `Later ${suffix}` });
  const sooner = await newLead(h, "contrib", { city, companyName: `Sooner ${suffix}` });
  const undated = await newLead(h, "contrib", { city, companyName: `Undated ${suffix}` });
  const day = 86_400_000;
  await h.database.db.collection("opportunities").updateOne({ _id: later.id }, { $set: { nextActionAt: new Date(Date.now() + 3 * day), nextAction: "Call" } });
  await h.database.db.collection("opportunities").updateOne({ _id: sooner.id }, { $set: { nextActionAt: new Date(Date.now() + day), nextAction: "Call" } });
  await h.database.db.collection("opportunities").updateOne({ _id: undated.id }, { $set: { updatedAt: new Date(Date.now() + day) } }); // the most recently updated
  const names = (text: string) => parseCsv(text).slice(1).map((row) => row[0]);
  const next = expectStatus(await h.call("contrib", "GET", `/sales/leads/export.csv?city=${encodeURIComponent(city)}&sort=next`), 200);
  assert.deepEqual(names(next.text), [`Sooner ${suffix}`, `Later ${suffix}`, `Undated ${suffix}`]);
  const list = parse(successEnvelope(leadListSchema), (await h.call("contrib", "GET", `/sales/leads?city=${encodeURIComponent(city)}&sort=next`)).body).data;
  assert.deepEqual(list.items.map((lead) => lead.companyName), names(next.text));
  const updated = expectStatus(await h.call("contrib", "GET", `/sales/leads/export.csv?city=${encodeURIComponent(city)}`), 200);
  assert.equal(names(updated.text)[0], `Undated ${suffix}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------------------------------------------------

test("saved views belong to one person: at most 20, the same name replaces, only the owner lists or deletes", skip, async () => {
  const h = await getHarness();
  const filters = { group: "talking", needsYou: "true", sort: "next" };
  const created = parse(successEnvelope(savedViewSchema), expectStatus(await h.call("contrib", "POST", "/sales/views", { name: "Waiting on me", filters }), 201).body).data;
  assert.deepEqual([created.name, created.page, created.filters], ["Waiting on me", "leads", filters]);
  const listed = (await h.call("contrib", "GET", "/sales/views")).data as { id: string; name: string }[];
  assert.deepEqual(listed.map((view) => view.name), ["Waiting on me"]);
  assert.deepEqual((await h.call("contrib2", "GET", "/sales/views")).data, []);
  // The same name, in another case, replaces the earlier view instead of adding one.
  const replaced = expectStatus(await h.call("contrib", "POST", "/sales/views", { name: "WAITING ON ME", filters: { group: "meeting" } }), 200).data;
  assert.deepEqual([replaced.id, replaced.name, replaced.filters], [created.id, "WAITING ON ME", { group: "meeting" }]);
  assert.equal(((await h.call("contrib", "GET", "/sales/views")).data as unknown[]).length, 1);
  // Others cannot delete it; the owner can; deleting twice is a 404.
  expectStatus(await h.call("contrib2", "DELETE", `/sales/views/${created.id}`), 404);
  expectStatus(await h.call("contrib", "DELETE", `/sales/views/${created.id}`), 200);
  expectStatus(await h.call("contrib", "DELETE", `/sales/views/${created.id}`), 404);
  // Twenty at most.
  for (let index = 0; index < 20; index++) expectStatus(await h.call("learner", "POST", "/sales/views", { name: `View ${index}`, filters: { q: String(index) } }), 201);
  expectStatus(await h.call("learner", "POST", "/sales/views", { name: "One too many", filters: {} }), 409);
  expectStatus(await h.call("learner", "POST", "/sales/views", { name: "view 3", filters: { q: "changed" } }), 200); // replacing is allowed at the limit
  assert.equal(((await h.call("learner", "GET", "/sales/views")).data as unknown[]).length, 20);
  // Bad input.
  expectStatus(await h.call("contrib", "POST", "/sales/views", { name: "", filters: {} }), 400);
  expectStatus(await h.call("contrib", "POST", "/sales/views", { name: "x".repeat(61), filters: {} }), 400);
  expectStatus(await h.call("contrib", "POST", "/sales/views", { name: "Bad keys", filters: { "no spaces": "x" } }), 400);
  expectStatus(await h.call("contrib", "POST", "/sales/views", { name: "Long value", filters: { q: "x".repeat(201) } }), 400);
  expectStatus(await h.call("contrib", "POST", "/sales/views", { name: "Claude", filters: {} }, { via: "claude" }), 403);
});

test("a view name is unique per person and page (any case), also when two saves race", skip, async () => {
  const h = await getHarness();
  const views = h.database.db.collection("sales_views");
  const name = `Race ${suffix}`;
  const replies = await Promise.all([name, name.toUpperCase(), name.toLowerCase(), name, name].map((label) => h.call("contrib2", "POST", "/sales/views", { name: label, filters: { q: label } })));
  const statuses = replies.map((reply) => reply.status);
  assert.ok(statuses.includes(201), statuses.join());
  assert.ok(statuses.every((status) => status === 200 || status === 201 || status === 409), statuses.join());
  for (const reply of replies.filter((item) => item.status === 409)) assert.match(reply.body.error.message, /a view with that name exists/i);
  assert.equal(await views.countDocuments({ userId: "user-contrib2", name }, { collation: { locale: "en", strength: 2 } }), 1);
  // The index itself refuses a second one.
  await assert.rejects(views.insertOne({ _id: randomUUID(), workspaceId: "workspace-a", userId: "user-contrib2", page: "leads", name: name.toUpperCase(), filters: {}, createdAt: new Date() }), (error: any) => error?.code === 11000);
  // The same name on another page, or for another person, is fine.
  expectStatus(await h.call("contrib2", "POST", "/sales/views", { name, page: "pipeline", filters: {} }), 201);
  expectStatus(await h.call("head", "POST", "/sales/views", { name, filters: {} }), 201);
});

// ---------------------------------------------------------------------------------------------------------------------
// The whole app: route order and the larger body of an import
// ---------------------------------------------------------------------------------------------------------------------

test("in the full app, export.csv and bulk are not read as lead ids, and an import may carry a file larger than the 2 MB JSON limit", skip, async () => {
  const name = `vso_test_salesio_app_${suffix}`;
  assert.match(name, /^vso_test_salesio_app_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: name, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  try {
    await ensureIndexes(database.db);
    const now = new Date();
    await database.db.collection("workspaces").insertOne({ _id: "workspace-a", name: "A", slug: "a", createdAt: now });
    await database.db.collection("ventures").insertOne({ _id: "venture-a", workspaceId: "workspace-a", name: "Alpha", status: "active", createdAt: now });
    await database.db.collection("pipelines").insertOne({ _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "P", offerName: "O", status: "active", createdAt: now, updatedAt: now });
    await database.db.collection("users").insertOne({ _id: "user-head", workspaceId: "workspace-a", email: "head@example.invalid", name: "head", handle: "head", status: "active", createdAt: now, updatedAt: now });
    await database.db.collection("memberships").insertOne({ _id: "membership-head", workspaceId: "workspace-a", userId: "user-head", role: "venture_head", ventureIds: ["venture-a"], groupIds: [], status: "active", createdAt: now, updatedAt: now });
    const { app } = createApp(database, config, createAuth(database.native, config), new LocalObjectStore(config));
    const server = createServer(app).listen(0);
    await once(server, "listening");
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const headers = { "content-type": "application/json", "x-dev-user-id": "user-head" };
    try {
      const exported = await fetch(`${origin}/v1/sales/leads/export.csv?ventureId=venture-a`, { headers });
      assert.equal(exported.status, 200, await exported.clone().text());
      assert.match(exported.headers.get("content-type") ?? "", /text\/csv/);
      assert.equal((await fetch(`${origin}/v1/sales/leads/export.csv`)).status, 401);
      const bulked = await fetch(`${origin}/v1/sales/leads/bulk`, { method: "POST", headers, body: JSON.stringify({ ids: [randomUUID()], action: "tag", tag: "x" }) });
      assert.equal(bulked.status, 200, await bulked.clone().text());
      // About 3 MB of CSV: over the global 2 MB limit, under the import's own.
      const rows = Array.from({ length: 30_000 }, (_, index) => `Big Import Co ${index} ${"y".repeat(60)}`);
      const big = await fetch(`${origin}/v1/sales/leads/import/preview`, { method: "POST", headers, body: JSON.stringify({ ventureId: "venture-a", csv: `Company\n${rows.slice(0, 4_999).join("\n")}`, hasHeader: true }) });
      assert.equal(big.status, 200, (await big.text()).slice(0, 400));
      const bigBody = JSON.stringify({ ventureId: "venture-a", csv: `Company\n${rows.join("\n")}` });
      assert.ok(bigBody.length > 2_000_000);
      const tooMany = await fetch(`${origin}/v1/sales/leads/import/preview`, { method: "POST", headers, body: bigBody });
      assert.equal(tooMany.status, 400); // read in full (not cut off by the 2 MB limit), then refused for its 30,000 rows
      assert.match(JSON.stringify(await tooMany.json()), /up to 5000 at a time/);
      // Other routes keep the 2 MB limit.
      const oversized = await fetch(`${origin}/v1/sales/views`, { method: "POST", headers, body: JSON.stringify({ name: "x", filters: {}, padding: "z".repeat(2_200_000) }) });
      assert.equal(oversized.status, 413);
      // Without signing in, nothing is read.
      assert.equal((await fetch(`${origin}/v1/sales/leads/import/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: bigBody })).status, 401);
    } finally { server.close(); await once(server, "close"); }
  } finally {
    await database.native.dropDatabase();
    await database.client.close();
  }
});
