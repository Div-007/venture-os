import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after } from "node:test";
import { engineLeadsResultSchema, findRunSchema, patCreateSchema, successEnvelope } from "@venture-studio/contracts";
import { createPat } from "@venture-studio/core";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { connectDatabase, type Database } from "../src/db.js";
import { ensureIndexes, ensureLeadReferenceIndex } from "../src/indexes.js";
import { internalHeaders } from "../src/internal-auth.js";
import { isMcpRoute } from "../src/mcp/http.js";
import { overLimit } from "../src/middleware.js";
import { LocalObjectStore } from "../src/storage.js";
import { STALE_CLAIM_MS } from "../src/sales/engine.js";

// The office PC engine bridge (docs/sales-dealflow.md section 10) through the real app, on a throwaway database:
// Bearer-token-only auth, venture scoping, claim races and takeover, lead ingest (dedupe, do-not-contact, validation) and audit.

const mongoUrl = process.env.TEST_MONGODB_URI;
const skip = { skip: !mongoUrl };
const suffix = randomUUID().slice(0, 6);

type Reply = { status: number; body: any; data: any; headers: Headers };
type Env = {
  database: Database; origin: string; server: Server;
  /** A token for one of the seeded people with the given scopes (inserted the way POST /v1/pats stores it). */
  token: (who: string, scopes?: string[], extra?: Record<string, unknown>) => Promise<{ token: string; id: string }>;
  engine: (token: string | undefined, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;
  app: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
  run: (extra?: Record<string, unknown>) => Promise<string>;
};

let env: Promise<Env> | undefined;
let counter = 0;

async function setup(): Promise<Env> {
  const dbName = `vso_test_engine_${suffix}`;
  assert.match(dbName, /^vso_test_engine_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  const db = database.db;
  await ensureIndexes(db);
  const now = new Date();
  await db.collection("workspaces").insertMany([{ _id: "workspace-a", name: "A", slug: "a", createdAt: now }, { _id: "workspace-b", name: "B", slug: "b", createdAt: now }]);
  await db.collection("ventures").insertMany([
    { _id: "venture-a", workspaceId: "workspace-a", name: "Alpha", status: "active", createdAt: now }, { _id: "venture-b", workspaceId: "workspace-a", name: "Beta", status: "active", createdAt: now },
    { _id: "venture-c", workspaceId: "workspace-a", name: "Gamma", status: "active", createdAt: now },
  ]);
  await db.collection("pipelines").insertMany([
    { _id: "pipeline-a-old", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha paused", offerName: "O", status: "paused", createdAt: new Date(now.getTime() - 20_000), updatedAt: now },
    { _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha leads", offerName: "O", status: "active", createdAt: new Date(now.getTime() - 10_000), updatedAt: now },
    { _id: "pipeline-a-2", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha second", offerName: "O", status: "active", createdAt: now, updatedAt: now },
    { _id: "pipeline-b", workspaceId: "workspace-a", ventureId: "venture-b", name: "Beta leads", offerName: "O", status: "active", createdAt: now, updatedAt: now },
  ]);
  await db.collection("sales_plays").insertOne({ _id: "play-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Dealers", motion: "high_touch", audience: "", offerName: "", hypothesis: "", metric: "", stopRule: "", batchSize: 10, steps: [], status: "approved", createdBy: "user-head", createdVia: "app", firstBatchReviewed: false, createdAt: now, updatedAt: now });
  const people: [string, string, string, string[]][] = [
    ["admin", "workspace-a", "admin", []], ["head", "workspace-a", "venture_head", ["venture-a"]], ["contrib", "workspace-a", "contributor", ["venture-a"]], ["contrib2", "workspace-a", "contributor", ["venture-a"]],
    ["learner", "workspace-a", "learner", ["venture-a"]], ["outsider", "workspace-a", "contributor", ["venture-b"]], ["head-b", "workspace-a", "venture_head", ["venture-b"]], ["other-admin", "workspace-b", "admin", []],
  ];
  await db.collection("users").insertMany(people.map(([handle, workspaceId]) => ({ _id: `user-${handle}`, workspaceId, email: `${handle}@example.invalid`, name: handle, handle, status: "active", createdAt: now, updatedAt: now })));
  await db.collection("memberships").insertMany(people.map(([handle, workspaceId, role, ventureIds]) => ({ _id: `membership-${handle}`, workspaceId, userId: `user-${handle}`, role, ventureIds, groupIds: [], status: "active", createdAt: now, updatedAt: now })));
  const { app } = createApp(database, config, createAuth(database.native, config), new LocalObjectStore(config));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const reply = async (response: Response): Promise<Reply> => { const body = await response.json().catch(() => null) as any; return { status: response.status, body, data: body?.data, headers: response.headers }; };
  return {
    database, origin, server,
    token: async (who, scopes = ["sales:read", "sales:engine"], extra = {}) => {
      const generated = createPat();
      const id = randomUUID();
      await db.collection("pats").insertOne({ _id: id, workspaceId: who === "other-admin" ? "workspace-b" : "workspace-a", userId: `user-${who}`, membershipId: `membership-${who}`, name: `${who} engine`, prefix: generated.prefix, tokenHash: generated.hash, scopes, createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86_400_000), ...extra });
      return { token: generated.token, id };
    },
    engine: async (token, method, path, body, headers = {}) => reply(await fetch(`${origin}/v1/sales/engine${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })),
    app: async (who, method, path, body) => reply(await fetch(`${origin}/v1${path}`, { method, headers: { "content-type": "application/json", "x-dev-user-id": `user-${who}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })),
    run: async (extra = {}) => {
      const id = `run-${++counter}-${suffix}`;
      const when = new Date(Date.now() - 60_000 + counter);
      await db.collection("sales_find_runs").insertOne({ _id: id, workspaceId: "workspace-a", ventureId: "venture-a", playId: "play-a", request: "Pump dealers in Chhattisgarh", plan: { places: ["Raipur"], categories: ["pumps"], searches: ["pump dealer raipur"], limit: 50 }, status: "queued", createdBy: "user-contrib", createdVia: "app", createdAt: when, updatedAt: when, ...extra });
      return id;
    },
  };
}
const getEnv = () => (env ??= setup());
after(async () => {
  if (!env) return;
  const { server, database } = await env;
  server.close();
  await once(server, "close");
  await database.native.dropDatabase();
  await database.client.close();
});

const expectStatus = (reply: Reply, status: number) => { assert.equal(reply.status, status, JSON.stringify(reply.body)); return reply; };
const connected = (site: string, extra: Record<string, unknown> = {}) => ({
  companyName: `${site} Pumps`, website: `https://www.${site}.example/`, city: "Raipur", region: "Chhattisgarh", country: "India", category: "pumps", source: `https://directory.example/${site}`, observedSignal: "Wholesale dealer of submersible pumps",
  contactRoutes: [{ kind: "email", value: `sales@${site}.example`, sourceUrl: `https://www.${site}.example/contact` }, { kind: "phone", value: "+91 98765 43210", sourceUrl: `https://www.${site}.example/contact`, label: "Shop" }],
  evidence: [{ claim: "Sells to contractors", quote: "Special rates for bulk and contractor orders", url: `https://www.${site}.example/about` }], relevance: 70, tags: ["pumps"], externalRef: { system: "dealflow-engine", id: `eng-${site}-${suffix}` }, ...extra,
});
let sites = 0;
const site = () => `site${++sites}x${suffix}`;

test("engine routes take a personal access token with the sales:engine scope, and nothing else", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const good = await e.token("head");
  // No token, a malformed one, an unknown one, a revoked one and an expired one: 401 with a Bearer challenge.
  const none = expectStatus(await e.engine(undefined, "GET", "/runs"), 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
  expectStatus(await e.engine("not-a-token", "GET", "/runs"), 401);
  expectStatus(await e.engine(`vso_${"a".repeat(40)}`, "GET", "/runs"), 401);
  const revoked = await e.token("head", undefined, { revokedAt: new Date() });
  expectStatus(await e.engine(revoked.token, "GET", "/runs"), 401);
  const expired = await e.token("head", undefined, { expiresAt: new Date(Date.now() - 1000) });
  expectStatus(await e.engine(expired.token, "GET", "/runs"), 401);
  const unbound = await e.token("head");
  await db.collection("pats").updateOne({ _id: unbound.id }, { $unset: { membershipId: "" } });
  expectStatus(await e.engine(unbound.token, "GET", "/runs"), 401);
  // A token whose owner left, or was deactivated, stops working.
  const leaver = await e.token("contrib2");
  expectStatus(await e.engine(leaver.token, "GET", "/runs"), 200);
  await db.collection("memberships").updateOne({ _id: "membership-contrib2" }, { $set: { status: "removed" } });
  expectStatus(await e.engine(leaver.token, "GET", "/runs"), 401);
  await db.collection("memberships").updateOne({ _id: "membership-contrib2" }, { $set: { status: "active" } });
  await db.collection("users").updateOne({ _id: "user-contrib2" }, { $set: { status: "disabled" } });
  expectStatus(await e.engine(leaver.token, "GET", "/runs"), 401);
  await db.collection("users").updateOne({ _id: "user-contrib2" }, { $set: { status: "active" } });
  // The right person but the wrong scopes (Claude's own presets, read only, engine without read): 403, audited as denied on the engine channel.
  for (const scopes of [["sales:read", "sales:write"], ["sales:read"], ["sales:engine"], ["tasks:read", "tasks:write", "sales:write"]]) {
    const wrong = await e.token("head", scopes);
    expectStatus(await e.engine(wrong.token, "GET", "/runs"), 403);
    expectStatus(await e.engine(wrong.token, "POST", "/runs/whatever/claim", { workerId: "pc" }), 403);
  }
  const denied = await db.collection("audit_events").findOne({ channel: "engine", result: "denied", actorId: "user-head" });
  assert.ok(denied);
  // A session cookie or the local dev header alone never reaches the engine routes, in any mode; with a token, the token's owner is the actor.
  const withHeader = await fetch(`${e.origin}/v1/sales/engine/runs`, { headers: { "x-dev-user-id": "user-head" } });
  assert.equal(withHeader.status, 401);
  assert.equal((await fetch(`${e.origin}/v1/sales/engine/runs`, { headers: { cookie: "better-auth.session_token=forged" } })).status, 401);
  assert.equal((await fetch(`${e.origin}/v1/sales/engine/runs`, { headers: { ...internalHeaders("user-head") } })).status, 403); // the MCP loopback is refused by the allowlist before it gets here
  const mixed = await fetch(`${e.origin}/v1/sales/engine/runs`, { headers: { authorization: `Bearer ${good.token}`, "x-dev-user-id": "user-admin" } });
  assert.equal(mixed.status, 200);
  assert.equal(await db.collection("audit_events").countDocuments({ channel: "engine", actorId: "user-admin" }), 0);
  // Nothing in the Claude allowlist reaches the engine, and the token's other uses are unchanged: no session access to the rest of the API as a Bearer.
  for (const [method, path] of [["GET", "/v1/sales/engine/runs"], ["POST", "/v1/sales/engine/runs/x/claim"], ["POST", "/v1/sales/engine/runs/x/leads"], ["POST", "/v1/sales/engine/runs/x/finish"]] as const) assert.equal(isMcpRoute(method, path), false, path);
  assert.equal((await fetch(`${e.origin}/v1/sales/overview`, { headers: { authorization: `Bearer ${good.token}` } })).status, 401);
  // The same token on the normal routes is not a session: only the dedicated routes read it.
  // Creating the token: sales:engine needs sales:read, and the preset is accepted.
  assert.equal(patCreateSchema.safeParse({ name: "Office PC", scopes: ["sales:engine"], expiresInDays: 90 }).success, false);
  assert.equal(patCreateSchema.safeParse({ name: "Office PC", scopes: ["sales:read", "sales:engine"], expiresInDays: 90 }).success, true);
  const created = await e.app("head", "POST", "/pats", { name: "Office PC engine", scopes: ["sales:read", "sales:engine"], expiresInDays: 90 });
  expectStatus(created, 201);
  expectStatus(await e.engine(created.data.token, "GET", "/runs"), 200);
  expectStatus(await e.app("head", "POST", "/pats", { name: "Engine only", scopes: ["sales:engine"], expiresInDays: 90 }), 400);
  // Requests are limited per token.
  const busy = await e.token("head");
  await overLimit(db, `engine:${busy.id}`, 240, 60_000, 240);
  const limited = expectStatus(await e.engine(busy.token, "GET", "/runs"), 429);
  assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
  expectStatus(await e.engine(good.token, "GET", "/runs"), 200); // other tokens are unaffected
});

test("runs: only queued (or running) runs in ventures the token's owner can work, oldest first", skip, async () => {
  const e = await getEnv();
  const first = await e.run();
  const second = await e.run();
  const inBeta = await e.run({ ventureId: "venture-b", playId: undefined, createdBy: "user-outsider" });
  const byHead = await e.run({ createdBy: "user-head" });
  const planned = await e.run({ status: "planned" });
  const running = await e.run({ status: "running", workerId: "pc-x", claimedBy: "someone", claimedAt: new Date(), heartbeatAt: new Date() });
  const ids = async (who: string, query = "") => ((await e.engine((await e.token(who)).token, "GET", `/runs${query}`)).data as { id: string }[]).map((item) => item.id);
  const adminSees = await ids("admin");
  for (const id of [first, second, inBeta, byHead]) assert.ok(adminSees.includes(id), id);
  assert.ok(!adminSees.includes(planned) && !adminSees.includes(running));
  assert.ok(adminSees.indexOf(first) < adminSees.indexOf(second), "oldest first");
  const headSees = await ids("head");
  assert.ok([first, second, byHead].every((id) => headSees.includes(id)) && !headSees.includes(inBeta));
  assert.deepEqual((await ids("contrib")).filter((id) => [first, second, byHead, inBeta].includes(id)), [first, second]); // the runs they planned
  assert.deepEqual((await ids("contrib2")).filter((id) => [first, second, byHead, inBeta].includes(id)), []);
  assert.deepEqual(await ids("learner"), []);
  assert.deepEqual((await ids("outsider")).filter((id) => [first, inBeta].includes(id)), [inBeta]);
  assert.ok((await ids("head", "?status=running")).includes(running));
  expectStatus(await e.engine((await e.token("head")).token, "GET", "/runs?status=done"), 400);
  expectStatus(await e.engine((await e.token("head")).token, "GET", "/runs?limit=0"), 400);
  const shape = (await e.engine((await e.token("head")).token, "GET", "/runs?limit=1")).data[0];
  assert.equal(Object.keys(shape).sort().includes("request"), true);
  for (const field of ["id", "ventureId", "playId", "request", "plan", "createdBy", "createdAt", "status"]) assert.ok(field in shape, field);
  assert.deepEqual(Object.keys(shape.plan).sort(), ["categories", "limit", "places", "searches"]);
  assert.ok(!("claimedBy" in shape), "the token id is internal");
  // Archived ventures are frozen: their runs are not offered.
  await e.database.db.collection("ventures").updateOne({ _id: "venture-c" }, { $set: { status: "archived" } });
  const archived = await e.run({ ventureId: "venture-c" });
  assert.ok(!(await ids("admin")).includes(archived));
});

test("claim: atomic, held runs are 409, a claim with no heartbeat for 15 minutes can be taken over", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const head = await e.token("head");
  const head2 = await e.token("head");
  const id = await e.run();
  const claim = (token: string, workerId: string, runId = id) => e.engine(token, "POST", `/runs/${runId}/claim`, { workerId });
  expectStatus(await e.engine(head.token, "POST", `/runs/${id}/claim`, {}), 400);
  expectStatus(await e.engine(head.token, "POST", `/runs/${id}/claim`, { workerId: "" }), 400);
  expectStatus(await claim(head.token, "pc", "no-such-run"), 404);
  // Five workers at once: one wins.
  const race = await Promise.all(["w1", "w2", "w3", "w4", "w5"].map((workerId, index) => claim(index % 2 ? head.token : head2.token, workerId)));
  assert.deepEqual(race.map((reply) => reply.status).sort(), [200, 409, 409, 409, 409]);
  const winner = race.find((reply) => reply.status === 200)!;
  assert.equal(winner.data.status, "running");
  assert.ok(winner.data.claimedAt && winner.data.heartbeatAt && winner.data.workerId);
  const stored = (await db.collection("sales_find_runs").findOne({ _id: id }))!;
  assert.deepEqual([stored.status, stored.workerId], ["running", winner.data.workerId]);
  assert.ok(!("claimedBy" in winner.data));
  // The holder claiming again is fine (a restart); anybody else is refused, and says who holds it.
  const holderToken = stored.claimedBy === head.id ? head : head2;
  const otherToken = holderToken === head ? head2 : head;
  expectStatus(await claim(holderToken.token, winner.data.workerId), 200);
  const refused = expectStatus(await claim(otherToken.token, "w-late"), 409);
  assert.match(refused.body.error.message, new RegExp(winner.data.workerId));
  expectStatus(await claim(holderToken.token, "w-other-name"), 409); // another worker on the same token while it is alive
  // Not queued: finished and cancelled runs are 409; planned runs are not claimable either.
  for (const status of ["done", "failed", "cancelled", "planned"]) expectStatus(await claim(head.token, "pc", await e.run({ status })), 409);
  // Venture scoping: a run in a venture the owner cannot open does not exist for them; a contributor works only runs they planned.
  const beta = await e.run({ ventureId: "venture-b", playId: undefined });
  expectStatus(await claim(head.token, "pc", beta), 404);
  const contrib = await e.token("contrib");
  expectStatus(await claim(contrib.token, "pc", await e.run({ createdBy: "user-head" })), 403);
  expectStatus(await claim((await e.token("learner")).token, "pc", await e.run()), 403);
  expectStatus(await claim(contrib.token, "pc", await e.run()), 200);
  // Takeover after 15 minutes without a heartbeat (the claim's own time counts when there was none).
  const takeoverId = await e.run();
  expectStatus(await claim(head.token, "pc-old", takeoverId), 200);
  expectStatus(await claim(head2.token, "pc-new", takeoverId), 409);
  await db.collection("sales_find_runs").updateOne({ _id: takeoverId }, { $set: { heartbeatAt: new Date(Date.now() - STALE_CLAIM_MS + 60_000) } });
  expectStatus(await claim(head2.token, "pc-new", takeoverId), 409); // 14 minutes: still held
  await db.collection("sales_find_runs").updateOne({ _id: takeoverId }, { $set: { heartbeatAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000) } });
  const taken = expectStatus(await claim(head2.token, "pc-new", takeoverId), 200);
  assert.equal(taken.data.workerId, "pc-new");
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.engine.claim", objectId: takeoverId, "metadata.takeover": true, "metadata.previousWorker": "pc-old" }));
  // The old worker is out: its heartbeat, leads and finish are refused (by token, or by workerId on the same token).
  expectStatus(await e.engine(head.token, "POST", `/runs/${takeoverId}/heartbeat`, { progress: { found: 1, crawled: 1, added: 0 } }), 409);
  expectStatus(await e.engine(head.token, "POST", `/runs/${takeoverId}/leads`, { leads: [connected(site())] }), 409);
  expectStatus(await e.engine(head.token, "POST", `/runs/${takeoverId}/finish`, { status: "done", results: { found: 1, added: 0, skipped: 0 } }), 409);
  expectStatus(await e.engine(head2.token, "POST", `/runs/${takeoverId}/heartbeat`, { workerId: "pc-old", progress: { found: 1, crawled: 1, added: 0 } }), 409); // same token, other worker name
  expectStatus(await e.engine(head2.token, "POST", `/runs/${takeoverId}/heartbeat`, { workerId: "pc-new", progress: { found: 1, crawled: 1, added: 0 } }), 200);
  // A person cancelling the run tells the worker on its next call.
  expectStatus(await e.app("head", "POST", `/sales/find-runs/${takeoverId}/cancel`, {}), 200);
  const cancelled = expectStatus(await e.engine(head2.token, "POST", `/runs/${takeoverId}/heartbeat`, { progress: { found: 2, crawled: 2, added: 0 } }), 409);
  assert.match(cancelled.body.error.message, /cancelled/);
  expectStatus(await e.engine(head2.token, "POST", `/runs/${takeoverId}/finish`, { status: "done", results: { found: 2, added: 0, skipped: 0 } }), 409);
});

test("heartbeat stores progress and a note, and the run shows in the find-leads list", skip, async () => {
  const e = await getEnv();
  const token = await e.token("head");
  const id = await e.run();
  const path = `/runs/${id}/heartbeat`;
  expectStatus(await e.engine(token.token, "POST", path, { progress: { found: 1, crawled: 1, added: 0 } }), 409); // not claimed yet
  expectStatus(await e.engine(token.token, "POST", `/runs/${id}/claim`, { workerId: "office-pc" }), 200);
  const beat = expectStatus(await e.engine(token.token, "POST", path, { progress: { found: 12, crawled: 30, added: 4 }, note: "Crawling Raipur listings" }), 200);
  assert.deepEqual([beat.data.id, beat.data.status], [id, "running"]);
  assert.ok(beat.data.heartbeatAt);
  expectStatus(await e.engine(token.token, "POST", path, { progress: { found: -1, crawled: 0, added: 0 } }), 400);
  expectStatus(await e.engine(token.token, "POST", path, { progress: { found: 1, crawled: 1 } }), 400);
  expectStatus(await e.engine(token.token, "POST", path, { progress: { found: 1, crawled: 1, added: 0 }, note: "x".repeat(501) }), 400);
  expectStatus(await e.engine(token.token, "POST", path, {}), 400);
  // A heartbeat without a note keeps the last one.
  expectStatus(await e.engine(token.token, "POST", path, { progress: { found: 15, crawled: 40, added: 5 } }), 200);
  const listed = expectStatus(await e.app("head", "GET", "/sales/find-runs?ventureId=venture-a"), 200);
  const shown = successEnvelope(findRunSchema.array()).parse(listed.body).data.find((run) => run.id === id)!;
  assert.deepEqual([shown.status, shown.workerId, shown.progress, shown.note], ["running", "office-pc", { found: 15, crawled: 40, added: 5 }, "Crawling Raipur listings"]);
  assert.ok(shown.claimedAt && shown.heartbeatAt);
  assert.ok(!("claimedBy" in listed.data.find((run: any) => run.id === id)));
  // Another person's token cannot beat for this run.
  expectStatus(await e.engine((await e.token("admin")).token, "POST", path, { progress: { found: 1, crawled: 1, added: 0 } }), 409);
  expectStatus(await e.engine((await e.token("outsider")).token, "POST", path, { progress: { found: 1, crawled: 1, added: 0 } }), 404);
});

test("leads: validated one by one, owned by the run's creator, deduplicated, and do-not-contact companies are skipped", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const head = await e.token("head");
  const id = await e.run();
  const post = (leads: unknown[], token = head.token, extra: Record<string, unknown> = {}, runId = id) => e.engine(token, "POST", `/runs/${runId}/leads`, { leads, ...extra });
  expectStatus(await post([connected(site())]), 409); // not claimed
  expectStatus(await e.engine(head.token, "POST", `/runs/${id}/claim`, { workerId: "office-pc" }), 200);
  expectStatus(await post([]), 400);
  expectStatus(await post(Array.from({ length: 51 }, () => connected(site()))), 400);
  expectStatus(await e.engine(head.token, "POST", `/runs/${id}/leads`, {}), 400);
  // A good batch: leads belong to the run's creator, venture, first active pipeline and play; stage identified.
  const a = connected(site());
  const b = connected(site(), { contactRoutes: [{ kind: "whatsapp", value: "+91 98765 11111", sourceUrl: "https://example.com/c" }, { kind: "website_form", value: "https://forms.example.com/contact", sourceUrl: "https://forms.example.com/" }] });
  const result = expectStatus(await post([a, b]), 200);
  const parsed = engineLeadsResultSchema.parse(result.data);
  assert.deepEqual(parsed.added.map((item) => item.companyName), [a.companyName, b.companyName]);
  assert.deepEqual(parsed.skipped, []);
  const stored = (await db.collection("opportunities").findOne({ _id: parsed.added[0]!.id }))!;
  assert.deepEqual([stored.ownerId, stored.ventureId, stored.pipelineId, stored.playId, stored.stage, stored.externalRef], ["user-contrib", "venture-a", "pipeline-a", "play-a", "identified", a.externalRef]);
  assert.deepEqual([stored.source, stored.city, stored.category, stored.relevance, stored.website], [a.source, "Raipur", "pumps", 70, a.website]);
  assert.ok(stored.tags.includes("engine") && stored.tags.includes("pumps"));
  assert.equal(stored.contactRoutes.length, 2);
  assert.ok(stored.suppressKeys.some((key: string) => key.startsWith("domain:")));
  const note = await db.collection("sales_activities").findOne({ leadId: stored._id, kind: "note" });
  assert.equal(note?.via, "import");
  assert.match(note?.body, /office PC engine/);
  assert.match(note?.body, /Special rates for bulk/);
  // The leads show up in Sales like any other lead, in the creator's list.
  const listed = expectStatus(await e.app("contrib", "GET", `/sales/leads?q=${encodeURIComponent(a.companyName)}&owner=me`), 200);
  assert.equal(listed.data.total, 1);
  // Re-posting the same engine id is a skipped duplicate (the same lead), never a second lead.
  const again = expectStatus(await post([a]), 200);
  assert.deepEqual(again.data.added, []);
  assert.deepEqual(again.data.skipped, [{ companyName: a.companyName, reason: "duplicate", id: parsed.added[0]!.id }]);
  assert.equal(await db.collection("opportunities").countDocuments({ "externalRef.id": a.externalRef.id }), 1);
  // Same website domain (other name, other spelling of the address) or same normalised name in the venture: duplicate.
  const sameSite = connected(site(), { website: a.website.replace("https://www.", "http://").replace(/\/$/, "/contact") });
  const sameName = connected(site(), { companyName: a.companyName.toUpperCase().replace(" PUMPS", " PUMPS PVT. LTD.") });
  const sameBoth = await post([sameSite, sameName]);
  assert.deepEqual(sameBoth.data.skipped.map((item: any) => [item.reason, item.id]), [["duplicate", parsed.added[0]!.id], ["duplicate", parsed.added[0]!.id]]);
  assert.deepEqual(sameBoth.data.added, []);
  // Twice in one batch: the second is a duplicate of the first.
  const twin = connected(site());
  const twinTwo = connected(site(), { companyName: twin.companyName, website: undefined });
  const twins = await post([twin, twinTwo]);
  assert.deepEqual([twins.data.added.length, twins.data.skipped.map((item: any) => item.reason)], [1, ["duplicate"]]);
  // Another venture's leads do not count as duplicates (and a deleted lead's company is not found again).
  const elsewhere = connected(site());
  await db.collection("opportunities").insertOne({ _id: `elsewhere-${suffix}`, workspaceId: "workspace-a", ventureId: "venture-b", pipelineId: "pipeline-b", companyName: elsewhere.companyName, website: elsewhere.website, ownerId: "user-outsider", stage: "identified", suppressKeys: [`company:${elsewhere.companyName.toLowerCase().replace(" pumps", " pumps")}`, `domain:${new URL(elsewhere.website!).hostname.replace(/^www\./, "")}`], createdAt: new Date(), updatedAt: new Date() });
  assert.equal((await post([elsewhere])).data.added.length, 1);
  const removed = connected(site());
  const removedLead = (await post([removed])).data.added[0];
  expectStatus(await e.app("head", "DELETE", `/sales/leads/${removedLead.id}`), 200);
  const refound = connected(site(), { companyName: removed.companyName });
  assert.equal((await post([refound])).data.skipped[0].reason, "duplicate");
  // The same name in another city is another company; the same city written another way ("raipur (C.G.)") is the same one.
  const otherCity = connected(site(), { companyName: a.companyName, website: undefined, city: "Indore" });
  assert.equal((await post([otherCity])).data.added.length, 1);
  const sameCitySpelled = connected(site(), { companyName: a.companyName, website: undefined, city: "raipur (C.G.)" });
  assert.deepEqual((await post([sameCitySpelled])).data.skipped.map((item: any) => [item.reason, item.id]), [["duplicate", parsed.added[0]!.id]]);
  // An engine id another venture already holds is no duplicate here: references are unique per venture.
  const sharedRef = connected(site());
  await db.collection("opportunities").insertOne({ _id: `ref-elsewhere-${suffix}`, workspaceId: "workspace-a", ventureId: "venture-b", pipelineId: "pipeline-b", companyName: "Somebody Else", ownerId: "user-outsider", stage: "identified", externalRef: sharedRef.externalRef, suppressKeys: [], createdAt: new Date(), updatedAt: new Date() });
  assert.equal((await post([sharedRef])).data.added.length, 1);
  assert.equal(await db.collection("opportunities").countDocuments({ "externalRef.id": sharedRef.externalRef.id }), 2);
  // Do-not-contact: a company, an email or a number on the list is skipped, not added.
  const dnc = site();
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "company", value: `${dnc} Pumps Pvt Ltd`, reason: "Asked not to be contacted" }), 201);
  const mailDnc = site(); const phoneDnc = site(); const domainDnc = site();
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "email", value: `Sales+x@${mailDnc}.example` }), 201);
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "phone", value: "098000 55555" }), 201);
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "domain", value: `www.${domainDnc}.example` }), 201);
  const blocked = await post([
    connected(dnc), connected(site(), { companyName: `${mailDnc} trading`, website: undefined, contactRoutes: [{ kind: "email", value: `sales@${mailDnc}.example`, sourceUrl: "https://example.com/c" }] }),
    connected(site(), { website: undefined, contactRoutes: [{ kind: "phone", value: "+91 98000 55555", sourceUrl: "https://example.com/c" }] }), connected(domainDnc), connected(site()),
  ]);
  assert.deepEqual(blocked.data.skipped.map((item: any) => item.reason), ["do_not_contact", "do_not_contact", "do_not_contact", "do_not_contact"]);
  assert.equal(blocked.data.added.length, 1);
  // Invalid leads are skipped with a reason and the rest of the batch still goes in.
  const bad: [string, unknown][] = [
    ["no source", { ...connected(site()), source: undefined }], ["a made-up system", { ...connected(site()), externalRef: { system: "somewhere", id: "x" } }], ["no external id", { ...connected(site()), externalRef: { system: "dealflow-engine" } }],
    ["no company", { ...connected(site()), companyName: "" }], ["a route without its page", { ...connected(site()), contactRoutes: [{ kind: "email", value: "a@b.example" }] }],
    ["an email with extras", { ...connected(site()), contactRoutes: [{ kind: "email", value: "a@b.example,c@d.example", sourceUrl: "https://example.com" }] }], ["a mailto parameter", { ...connected(site()), contactRoutes: [{ kind: "email", value: "a@b.example?bcc=x@y.example", sourceUrl: "https://example.com" }] }],
    ["a phone with letters", { ...connected(site()), contactRoutes: [{ kind: "phone", value: "call me", sourceUrl: "https://example.com" }] }], ["a linkedin route", { ...connected(site()), contactRoutes: [{ kind: "linkedin", value: "https://linkedin.com/company/x", sourceUrl: "https://example.com" }] }],
    ["a javascript source link", { ...connected(site()), contactRoutes: [{ kind: "email", value: "a@b.example", sourceUrl: "javascript:alert(1)" }] }], ["a javascript website", { ...connected(site()), website: "javascript:alert(1)" }],
    ["a route not published by the company", { ...connected(site()), contactRoutes: [{ kind: "email", value: "a@b.example", sourceUrl: "https://example.com", publishedByCompany: false }] }], ["a form that is not a link", { ...connected(site()), contactRoutes: [{ kind: "website_form", value: "ftp://x", sourceUrl: "https://example.com" }] }],
    ["relevance too high", { ...connected(site()), relevance: 101 }], ["a non-object", "just a name"], ["evidence without a link", { ...connected(site()), evidence: [{ claim: "c", quote: "q", url: "not a url" }] }],
  ];
  const mixed = await post([...bad.map(([, lead]) => lead), connected(site())]);
  assert.equal(mixed.data.added.length, 1);
  assert.equal(mixed.data.skipped.length, bad.length);
  for (const [index, skipped] of mixed.data.skipped.entries()) { assert.equal(skipped.reason, "invalid", bad[index]![0]); assert.ok(skipped.detail, bad[index]![0]); }
  assert.equal(mixed.data.skipped.find((item: any) => item.companyName === "")?.reason, "invalid");
  // The run's creator owns the leads even when the token belongs to someone else; the venture needs an active pipeline.
  assert.ok((await db.collection("opportunities").find({ "externalRef.id": { $in: [a.externalRef.id, b.externalRef.id] } }).toArray()).every((lead) => lead.ownerId === "user-contrib"));
  await db.collection("pipelines").updateMany({ ventureId: "venture-a" }, { $set: { status: "paused" } });
  expectStatus(await post([connected(site())]), 409);
  await db.collection("pipelines").updateOne({ _id: "pipeline-a-2" }, { $set: { status: "active" } });
  assert.equal((await post([connected(site())])).data.added.length, 1);
  assert.equal((await db.collection("opportunities").findOne({ "externalRef.id": { $regex: `^eng-site` }, pipelineId: "pipeline-a-2" }))?.pipelineId, "pipeline-a-2"); // the first active pipeline now
  await db.collection("pipelines").updateOne({ _id: "pipeline-a" }, { $set: { status: "active" } });
  // Leads are written under the engine channel, and a batch leaves one summary event.
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.lead.create", channel: "engine", objectId: parsed.added[0]!.id, actorId: "user-head" }));
  const summary = await db.collection("audit_events").findOne({ action: "sales.engine.leads", objectId: id, "metadata.added": 2 });
  assert.equal(summary?.channel, "engine");
  assert.deepEqual([summary?.metadata.received, summary?.metadata.duplicates], [2, 0]);
  // A contributor's token can post to the runs they planned (the leads are theirs) but not to someone else's run.
  const contrib = await e.token("contrib");
  const mine = await e.run();
  expectStatus(await e.engine(contrib.token, "POST", `/runs/${mine}/claim`, { workerId: "contrib-pc" }), 200);
  assert.equal((await post([connected(site())], contrib.token, {}, mine)).data.added.length, 1);
  const notMine = await e.run({ createdBy: "user-head" });
  expectStatus(await e.engine(contrib.token, "POST", `/runs/${notMine}/leads`, { leads: [connected(site())] }), 403);
});

test("finish: only the worker that holds the run, done or failed, with the results kept on the run", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const head = await e.token("head");
  const other = await e.token("head");
  const id = await e.run();
  const finish = (token: string, body: unknown, runId = id) => e.engine(token, "POST", `/runs/${runId}/finish`, body);
  const results = { found: 40, added: 12, skipped: 28, note: "Two sites blocked crawling (robots.txt)" };
  expectStatus(await finish(head.token, { status: "done", results }), 409); // not claimed
  expectStatus(await e.engine(head.token, "POST", `/runs/${id}/claim`, { workerId: "office-pc" }), 200);
  expectStatus(await finish(other.token, { status: "done", results }), 409); // someone else's token
  expectStatus(await finish(head.token, { status: "done", results }, "no-such-run"), 404);
  expectStatus(await finish(head.token, { status: "queued", results }), 400);
  expectStatus(await finish(head.token, { status: "done" }), 400);
  expectStatus(await finish(head.token, { status: "done", results: { found: -1, added: 0, skipped: 0 } }), 400);
  expectStatus(await finish(head.token, { status: "done", results: { ...results, note: "x".repeat(2001) } }), 400);
  expectStatus(await finish(head.token, { status: "done", results, workerId: "another-pc" }), 409);
  const done = expectStatus(await finish(head.token, { status: "done", results, workerId: "office-pc" }), 200);
  assert.deepEqual([done.data.status, done.data.results, Boolean(done.data.finishedAt)], ["done", results, true]);
  assert.ok(!("claimedBy" in done.data));
  const shown = successEnvelope(findRunSchema.array()).parse((await e.app("head", "GET", "/sales/find-runs?ventureId=venture-a")).body).data.find((run) => run.id === id)!;
  assert.deepEqual([shown.status, shown.results, Boolean(shown.finishedAt)], ["done", results, true]);
  // Finishing again with the same status repeats the answer; another status, or other work on a finished run, is refused.
  expectStatus(await finish(head.token, { status: "done", results }), 200);
  expectStatus(await finish(head.token, { status: "failed", results }), 409);
  expectStatus(await e.engine(head.token, "POST", `/runs/${id}/heartbeat`, { progress: { found: 1, crawled: 1, added: 0 } }), 409);
  expectStatus(await e.engine(head.token, "POST", `/runs/${id}/leads`, { leads: [connected(site())] }), 409);
  expectStatus(await finish(other.token, { status: "done", results }), 409);
  expectStatus(await e.engine(other.token, "POST", `/runs/${id}/claim`, { workerId: "x" }), 409); // finished runs are not claimable again
  // A failed run keeps its note.
  const failedId = await e.run();
  expectStatus(await e.engine(head.token, "POST", `/runs/${failedId}/claim`, { workerId: "office-pc" }), 200);
  const failed = expectStatus(await finish(head.token, { status: "failed", results: { found: 0, added: 0, skipped: 0, note: "SearXNG was not running" } }, failedId), 200);
  assert.deepEqual([failed.data.status, failed.data.results.note], ["failed", "SearXNG was not running"]);
  // Everything the worker did is in the audit log on the engine channel, as the token's owner.
  const events = await db.collection("audit_events").find({ objectId: { $in: [id, failedId] }, action: /^sales\.engine\./ }).toArray();
  assert.ok(events.length >= 4);
  assert.ok(events.every((event) => event.channel === "engine" && event.actorId === "user-head" && event.result === "success"));
  assert.deepEqual([...new Set(events.map((event) => event.action))].sort(), ["sales.engine.claim", "sales.engine.finish"]);
  assert.equal((await db.collection("audit_events").findOne({ action: "sales.engine.finish", objectId: id }))?.metadata.added, 12);
});

test("the run's venture decides: other ventures' runs are invisible, and a contributor cannot take over a head's run", skip, async () => {
  const e = await getEnv();
  const betaRun = await e.run({ ventureId: "venture-b", playId: undefined, createdBy: "user-outsider" });
  const alpha = await e.run();
  const headA = await e.token("head");
  const headB = await e.token("head-b");
  for (const path of [`/runs/${betaRun}/claim`, `/runs/${betaRun}/heartbeat`, `/runs/${betaRun}/leads`, `/runs/${betaRun}/finish`]) {
    const body = path.endsWith("claim") ? { workerId: "pc" } : path.endsWith("heartbeat") ? { progress: { found: 0, crawled: 0, added: 0 } } : path.endsWith("leads") ? { leads: [connected(site())] } : { status: "done", results: { found: 0, added: 0, skipped: 0 } };
    expectStatus(await e.engine(headA.token, "POST", path, body), 404);
  }
  expectStatus(await e.engine(headB.token, "POST", `/runs/${alpha}/claim`, { workerId: "pc" }), 404);
  expectStatus(await e.engine(headB.token, "POST", `/runs/${betaRun}/claim`, { workerId: "pc-b" }), 200);
  const posted = expectStatus(await e.engine(headB.token, "POST", `/runs/${betaRun}/leads`, { leads: [connected(site())] }), 200);
  const lead = (await e.database.db.collection("opportunities").findOne({ _id: posted.data.added[0].id }))!;
  assert.deepEqual([lead.ventureId, lead.pipelineId, lead.ownerId, lead.playId], ["venture-b", "pipeline-b", "user-outsider", undefined]);
  // A token from another workspace sees nothing of this one.
  const foreign = await e.token("other-admin");
  assert.deepEqual((await e.engine(foreign.token, "GET", "/runs")).data, []);
  expectStatus(await e.engine(foreign.token, "POST", `/runs/${alpha}/claim`, { workerId: "pc" }), 404);
  // Plain Sales routes still answer to sessions only.
  expectStatus(await e.app("head", "GET", "/sales/overview?ventureId=venture-a"), 200);
});

test("enrich runs: a person queues leads for the engine, which fills in contact details without creating or overwriting anything", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const lead = async (who: string, extra: Record<string, unknown> = {}) => {
    const name = site();
    const reply = await e.app(who, "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `${name} Traders`, ownerId: `user-${who}`, contactRoutes: [{ kind: "email", value: `Info@${name}.example`, sourceUrl: "https://example.com/c" }], ...extra });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return { ...(reply.data as { id: string; companyName: string }), slug: name };
  };
  const mine = await lead("contrib", { website: "https://mine.example" });
  const mine2 = await lead("contrib", { city: "Bilaspur" });
  const heads = await lead("head");
  const enrich = (who: string, id: string) => e.app(who, "POST", `/sales/leads/${id}/enrich`, {});
  // Queueing: the first request makes the run (201), the next ones from the same person join it (200); each person has their own.
  const first = expectStatus(await enrich("contrib", mine.id), 201).data;
  assert.deepEqual([first.kind, first.status, first.leadIds, first.createdBy, first.ventureId], ["enrich", "queued", [mine.id], "user-contrib", "venture-a"]);
  const second = expectStatus(await enrich("contrib", mine2.id), 200).data;
  assert.deepEqual([second.id, [...second.leadIds].sort(), second.request], [first.id, [mine.id, mine2.id].sort(), "Find contact details for 2 leads"]);
  assert.equal(expectStatus(await enrich("contrib", mine2.id), 200).data.leadIds.length, 2);
  const headRun = expectStatus(await enrich("head", heads.id), 201).data;
  assert.notEqual(headRun.id, first.id);
  assert.equal(successEnvelope(findRunSchema).parse({ ok: true, data: first }).data.kind, "enrich");
  // Rights: the lead's owner, a head or an admin; not another contributor, a learner or someone outside; never a do-not-contact lead.
  expectStatus(await enrich("contrib2", mine.id), 403);
  expectStatus(await enrich("learner", mine.id), 403);
  expectStatus(await enrich("outsider", mine.id), 404);
  expectStatus(await enrich("outsider", "no-such-lead"), 404);
  const joined = expectStatus(await enrich("head", mine.id), 200).data; // a head's own queue is its own run
  assert.deepEqual([joined.id, joined.leadIds.length], [headRun.id, 2]);
  const blocked = await lead("contrib");
  await db.collection("opportunities").updateOne({ _id: blocked.id }, { $set: { doNotContact: true } });
  expectStatus(await enrich("contrib", blocked.id), 409);
  // The list shows kind, leadIds and the targets to look up (do-not-contact and deleted leads are not handed out).
  const doomed = await lead("contrib");
  expectStatus(await enrich("contrib", doomed.id), 200);
  expectStatus(await e.app("head", "DELETE", `/sales/leads/${doomed.id}`), 200);
  await db.collection("opportunities").updateOne({ _id: mine2.id }, { $set: { doNotContact: true } });
  const headToken = await e.token("head");
  const listed = (await e.engine(headToken.token, "GET", "/runs")).data.find((run: any) => run.id === first.id);
  assert.equal(listed.kind, "enrich");
  assert.deepEqual(listed.targets.map((target: any) => target.leadId), [mine.id]);
  assert.equal(listed.targets[0].companyName, mine.companyName);
  assert.equal(listed.targets[0].website, "https://mine.example");
  assert.deepEqual(listed.targets[0].contactRoutes, [{ kind: "email", value: `Info@${mine.slug}.example` }]);
  await db.collection("opportunities").updateOne({ _id: mine2.id }, { $unset: { doNotContact: "" } });
  // A contributor's token works the run they planned.
  const contrib = await e.token("contrib");
  const claimed = expectStatus(await e.engine(contrib.token, "POST", `/runs/${first.id}/claim`, { workerId: "pc" }), 200).data;
  assert.equal(claimed.kind, "enrich");
  assert.deepEqual(claimed.targets.map((target: any) => target.leadId).sort(), [mine.id, mine2.id].sort());
  expectStatus(await e.engine(contrib.token, "POST", `/runs/${headRun.id}/claim`, { workerId: "pc" }), 403);
  // The worker posts what it found per lead: routes merged by value, empty fields filled, evidence kept; nothing is created.
  const before = await db.collection("opportunities").countDocuments({});
  const posted = expectStatus(await e.engine(contrib.token, "POST", `/runs/${first.id}/leads`, { leads: [
    { leadId: mine.id, website: "https://other-site.example", city: "Raipur", region: "Chhattisgarh", category: "pumps", observedSignal: "Hiring a dispatch clerk",
      contactRoutes: [{ kind: "email", value: `info@${mine.slug}.example`, sourceUrl: "https://x.example/c" }, { kind: "phone", value: "+91 98765 00000", sourceUrl: "https://x.example/c" }, { kind: "whatsapp", value: "098765 00000", sourceUrl: "https://x.example/c" }, { kind: "website_form", value: "https://x.example/contact-us", sourceUrl: "https://x.example/" }],
      evidence: [{ claim: "Has a dispatch team", quote: "Join our dispatch desk", url: "https://x.example/careers" }] },
    { leadId: mine2.id, city: "Elsewhere", contactRoutes: [] },
    { leadId: heads.id, city: "Not in this run" }, { leadId: "no-such-lead", city: "x" }, { city: "no lead id" }, { leadId: doomed.id, city: "Deleted" },
  ] }), 200).data;
  assert.equal(await db.collection("opportunities").countDocuments({}), before);
  assert.deepEqual(posted.added, []);
  assert.deepEqual(posted.updated.map((item: any) => [item.id, item.routesAdded, [...item.fieldsFilled].sort(), item.evidenceAdded]), [[mine.id, 2, ["category", "city", "observedSignal", "region"], true], [mine2.id, 0, [], false]]);
  assert.deepEqual(posted.skipped.map((item: any) => item.reason), ["invalid", "invalid", "invalid", "invalid"]);
  assert.match(posted.skipped[0].detail, /not part of this run/);
  const stored = (await db.collection("opportunities").findOne({ _id: mine.id }))!;
  assert.equal(stored.website, "https://mine.example"); // already filled: kept
  assert.deepEqual([stored.city, stored.region, stored.category, stored.observedSignal], ["Raipur", "Chhattisgarh", "pumps", "Hiring a dispatch clerk"]);
  // The email is the one it had (another spelling), and the WhatsApp number is the phone just added: two new routes, three in all.
  assert.deepEqual(stored.contactRoutes.map((route: any) => route.kind), ["email", "phone", "website_form"]);
  assert.ok(stored.suppressKeys.includes("phone:+919876500000"));
  assert.equal((await db.collection("opportunities").findOne({ _id: mine2.id }))?.city, "Bilaspur"); // typed by a person: kept
  const note = await db.collection("sales_activities").findOne({ leadId: mine.id, kind: "note", body: /Enriched by the office PC engine/ });
  assert.equal(note?.via, "import");
  assert.match(note?.body, /Join our dispatch desk/);
  assert.match(note?.body, /Added 2 contact routes/);
  // Posting the same thing again adds nothing (idempotent), and a route the do-not-contact list matches flags the lead.
  const again = (await e.engine(contrib.token, "POST", `/runs/${first.id}/leads`, { leads: [{ leadId: mine.id, contactRoutes: [{ kind: "phone", value: "98765 00000", sourceUrl: "https://x.example/c" }] }] })).data;
  assert.deepEqual(again.updated.map((item: any) => item.routesAdded), [0]);
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "email", value: "stop@blocked-by-list.example" }), 201);
  const flagged = (await e.engine(contrib.token, "POST", `/runs/${first.id}/leads`, { leads: [{ leadId: mine.id, contactRoutes: [{ kind: "email", value: "Stop+x@Blocked-By-List.example", sourceUrl: "https://x.example/c" }] }] })).data;
  assert.equal(flagged.updated[0].routesAdded, 1);
  assert.equal((await db.collection("opportunities").findOne({ _id: mine.id }))?.doNotContact, true);
  assert.deepEqual((await e.engine(contrib.token, "POST", `/runs/${first.id}/leads`, { leads: [{ leadId: mine.id, city: "Again" }] })).data.skipped.map((item: any) => item.reason), ["do_not_contact"]);
  // The summary and the end of the run; a find run is planned as before, and an enrich run cannot be planned as a search.
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.engine.enrich", objectId: first.id, channel: "engine" }));
  expectStatus(await e.engine(contrib.token, "POST", `/runs/${first.id}/finish`, { status: "done", results: { found: 2, added: 0, skipped: 4 } }), 200);
  assert.equal(successEnvelope(findRunSchema.array()).parse((await e.app("contrib", "GET", "/sales/find-runs?ventureId=venture-a")).body).data.find((run) => run.id === first.id)?.status, "done");
  expectStatus(await e.app("contrib", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Look for leads", kind: "enrich", leadIds: [mine.id] }), 400);
  assert.equal(expectStatus(await e.app("contrib", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Look for pump dealers" }), 201).data.kind, "find");
  // A finished run is not reused: the next request starts a new one.
  assert.notEqual(expectStatus(await enrich("contrib", mine2.id), 201).data.id, first.id);
});

test("round 2: an enrich run that hits the do-not-contact list stops the lead's drafts and reminder, a rule about one lead skips only that lead, and parallel enrich requests keep every lead", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  // A lead with a next action (so a reminder) and an open draft; the office PC finds an address the list already has.
  const name = site();
  const flaggedLead = expectStatus(await e.app("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `${name} Works`, ownerId: "user-contrib", nextAction: "Call again", nextActionAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }), 201).data;
  const draft = expectStatus(await e.app("contrib", "POST", `/sales/leads/${flaggedLead.id}/drafts`, { channel: "call_opener", body: "Hello, about your dealers" }), 201).data;
  assert.equal(await db.collection("reminders").countDocuments({ leadId: flaggedLead.id, state: "scheduled" }), 1);
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "email", value: `owner@${name}.example`, reason: "Opted out elsewhere" }), 201);
  const queued = await e.app("contrib", "POST", `/sales/leads/${flaggedLead.id}/enrich`, {});
  assert.ok([200, 201].includes(queued.status), JSON.stringify(queued.body));
  const contrib = await e.token("contrib");
  expectStatus(await e.engine(contrib.token, "POST", `/runs/${queued.data.id}/claim`, { workerId: "pc-r2" }), 200);
  const posted = expectStatus(await e.engine(contrib.token, "POST", `/runs/${queued.data.id}/leads`, { leads: [{ leadId: flaggedLead.id, contactRoutes: [{ kind: "email", value: `Owner@${name}.example`, sourceUrl: `https://www.${name}.example/contact` }] }] }), 200).data;
  assert.equal(posted.updated[0].routesAdded, 1);
  assert.equal((await db.collection("opportunities").findOne({ _id: flaggedLead.id }))?.doNotContact, true);
  const discarded = await db.collection("sales_drafts").findOne({ _id: draft.id });
  assert.deepEqual([discarded?.status, discarded?.discardedReason], ["discarded", "The lead is on the do-not-contact list"]);
  assert.deepEqual((await db.collection("reminders").find({ leadId: flaggedLead.id }).toArray()).map((row) => [row.state, row.cancelReason]), [["cancelled", "do_not_contact"]]);

  // A run planned by someone who has since left the venture: its leads have no valid owner, so each is skipped as invalid; the batch answers 200.
  const runId = await e.run({ createdBy: "user-contrib2" });
  const head = await e.token("head");
  expectStatus(await e.engine(head.token, "POST", `/runs/${runId}/claim`, { workerId: "pc-r2" }), 200);
  await db.collection("memberships").updateOne({ _id: "membership-contrib2" }, { $set: { ventureIds: [] } });
  try {
    const orphans = [site(), site()];
    const batch = expectStatus(await e.engine(head.token, "POST", `/runs/${runId}/leads`, { leads: orphans.map((slug) => connected(slug)) }), 200).data;
    assert.deepEqual(batch.added, []);
    assert.deepEqual(batch.skipped.map((item: any) => item.reason), ["invalid", "invalid"]);
    assert.match(batch.skipped[0].detail, /owner must be an active member/);
    assert.equal(await db.collection("opportunities").countDocuments({ "externalRef.id": { $in: orphans.map((slug) => `eng-${slug}-${suffix}`) } }), 0);
  } finally {
    await db.collection("memberships").updateOne({ _id: "membership-contrib2" }, { $set: { ventureIds: ["venture-a"] } });
  }

  // Eight enrich requests at once from one person: every lead ends up in a queued run, none is lost to a parallel write.
  const many: string[] = [];
  for (let index = 0; index < 8; index++) many.push(expectStatus(await e.app("contrib2", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `${site()} Parallel`, ownerId: "user-contrib2" }), 201).data.id);
  const answers = await Promise.all(many.map((id) => e.app("contrib2", "POST", `/sales/leads/${id}/enrich`, {})));
  assert.ok(answers.every((reply) => reply.status === 200 || reply.status === 201), JSON.stringify(answers.map((reply) => reply.status)));
  const runs = await db.collection("sales_find_runs").find({ kind: "enrich", createdBy: "user-contrib2", status: "queued" }).toArray();
  const stored = runs.flatMap((run) => run.leadIds as string[]);
  assert.deepEqual([...stored].sort(), [...many].sort(), "each lead is in a run exactly once");
  for (const run of runs) assert.equal(run.request, `Find contact details for ${run.leadIds.length} lead${run.leadIds.length > 1 ? "s" : ""}`);
  // A full run (100 leads) is never joined: the next request starts a new one.
  const full = runs[0]!;
  await db.collection("sales_find_runs").updateOne({ _id: full._id }, { $set: { leadIds: Array.from({ length: 100 }, (_, index) => `filler-${index}`) } });
  const extra = expectStatus(await e.app("contrib2", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `${site()} Overflow`, ownerId: "user-contrib2" }), 201).data.id;
  const overflow = await e.app("contrib2", "POST", `/sales/leads/${extra}/enrich`, {});
  assert.notEqual(overflow.data.id, full._id);
  assert.equal(((await db.collection("sales_find_runs").findOne({ _id: full._id }))?.leadIds as string[]).length, 100);
});

test("the lead reference index: the workspace-wide one from before becomes one per venture, also when two servers start at once", skip, async () => {
  const e = await getEnv();
  const leads = e.database.db.collection(`reference_index_check_${suffix}`);
  await leads.createIndex({ workspaceId: 1, "externalRef.system": 1, "externalRef.id": 1 }, { unique: true, partialFilterExpression: { "externalRef.id": { $type: "string" } } });
  await Promise.all([ensureLeadReferenceIndex(leads), ensureLeadReferenceIndex(leads)]);
  const names = (await leads.indexes()).map((index) => index.name);
  assert.ok(!names.includes("workspaceId_1_externalRef.system_1_externalRef.id_1"), names.join(", "));
  assert.ok(names.includes("workspaceId_1_ventureId_1_externalRef.system_1_externalRef.id_1"), names.join(", "));
  await leads.drop();
});
