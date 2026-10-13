import assert from "node:assert/strict";
import test from "node:test";
import { salesSearchKeysSchema, salesSearchKeyTestSchema, successEnvelope } from "@venture-studio/contracts";
import { forgetSearchKeys, resolveSearchKeys, sealSearchKey } from "../src/sales/search-keys.js";
import { withSalesApp } from "./mcp-sales-harness.js";

// The company-search keys an admin saves in Sales setup (sales/search-keys.ts, routes/sales-search-keys.ts): encrypted at rest, never
// returned, admins only, the server's key as the fallback, and search_companies and the test route using whatever key is in use.
// Fake keys only, and no real network: TinyFish and Exa are answered by a stand-in fetch.

const skip = !process.env.TEST_MONGODB_URI;
const APP_TINYFISH = "tf_test_1234567890";
const APP_EXA = "exa_test_abcdefghij";
const ENV_TINYFISH = "tf_env_key_0000000000";

type Seen = { engine: "tinyfish" | "exa"; url: URL; headers: Record<string, string>; body?: any };
/** Answers TinyFish and Exa with `answers`, passes calls to this test's own servers through, and refuses any other host. */
function standInSearch() {
  const seen: Seen[] = [];
  const answers: Record<"tinyfish" | "exa", () => Response> = { tinyfish: () => Response.json({ results: [] }), exa: () => Response.json({ results: [] }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    if (url.hostname === "api.search.tinyfish.ai") { seen.push({ engine: "tinyfish", url, headers }); return answers.tinyfish(); }
    if (url.hostname === "api.exa.ai") { seen.push({ engine: "exa", url, headers, body: JSON.parse(String(init?.body ?? "{}")) }); return answers.exa(); }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`no real network in tests (${url.hostname})`);
    return realFetch(input, init);
  }) as typeof fetch;
  return { seen, answers, restore: () => { globalThis.fetch = realFetch; } };
}
const read = async (response: Response) => { const text = await response.text(); return { status: response.status, text, body: JSON.parse(text || "null") as any }; };
const status = (body: unknown) => successEnvelope(salesSearchKeysSchema).parse(body).data;
const tested = (body: unknown) => successEnvelope(salesSearchKeyTestSchema).parse(body).data;

test("sealing a key: a fresh IV every time, the key nowhere in the result", () => {
  const first = sealSearchKey("test-secret-that-is-at-least-32-characters", "workspace-a", "tinyfish", APP_TINYFISH);
  const second = sealSearchKey("test-secret-that-is-at-least-32-characters", "workspace-a", "tinyfish", APP_TINYFISH);
  assert.equal(first.v, 1);
  assert.equal(Buffer.from(first.iv, "base64").length, 12);
  assert.equal(Buffer.from(first.tag, "base64").length, 16);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
  assert.ok(!JSON.stringify(first).includes(APP_TINYFISH) && !Buffer.from(first.data, "base64").toString("latin1").includes(APP_TINYFISH));
});

test("an admin saves and removes a key: the status shows set, app and the last four, never the key; others are refused", { skip }, async () => {
  await withSalesApp(async ({ api, db }) => {
    const empty = await read(await api("GET", "/sales/search-keys", "boss"));
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(status(empty.body), { tinyfish: { set: false, source: null }, exa: { set: false, source: null } });

    // Admins only: a venture head, a contributor and a learner get 403 on every route, and nothing is stored or spent.
    for (const handle of ["lead", "member", "learner"]) {
      assert.equal((await api("GET", "/sales/search-keys", handle)).status, 403, `${handle} reads`);
      assert.equal((await api("PUT", "/sales/search-keys/tinyfish", handle, { key: APP_TINYFISH })).status, 403, `${handle} saves`);
      assert.equal((await api("DELETE", "/sales/search-keys/tinyfish", handle)).status, 403, `${handle} removes`);
      assert.equal((await api("POST", "/sales/search-keys/tinyfish/test", handle, {})).status, 403, `${handle} tests`);
    }
    assert.equal(await db.collection("sales_search_keys").countDocuments({}), 0);
    assert.equal(await db.collection("mcp_search_usage").countDocuments({}), 0);

    const saved = await read(await api("PUT", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH }));
    assert.equal(saved.status, 200, saved.text);
    const view = status(saved.body);
    assert.deepEqual({ ...view.tinyfish, setAt: undefined }, { set: true, source: "app", last4: "7890", setAt: undefined, setBy: "user-boss", setByName: "Person boss" });
    assert.ok(Date.now() - Date.parse(view.tinyfish.setAt!) < 60_000);
    assert.deepEqual(view.exa, { set: false, source: null });
    assert.ok(!saved.text.includes(APP_TINYFISH.slice(0, -4)), "no part of the key beyond its last four characters comes back");
    const again = await read(await api("GET", "/sales/search-keys", "boss"));
    assert.deepEqual(status(again.body).tinyfish.source, "app");
    assert.ok(!again.text.includes(APP_TINYFISH.slice(0, -4)));

    // At rest: ciphertext, its IV and tag and the version; no plaintext key anywhere in the document.
    const stored = await db.collection("sales_search_keys").findOne({ _id: "workspace-a" });
    assert.ok(stored?.tinyfish && !stored.exa);
    assert.deepEqual(Object.keys(stored.tinyfish).sort(), ["data", "iv", "last4", "setAt", "setBy", "tag", "v"]);
    assert.equal(stored.tinyfish.v, 1);
    assert.equal(Buffer.from(stored.tinyfish.iv, "base64").length, 12);
    assert.equal(Buffer.from(stored.tinyfish.tag, "base64").length, 16);
    assert.ok(!JSON.stringify(stored).includes(APP_TINYFISH) && !JSON.stringify(stored).includes(APP_TINYFISH.slice(0, -4)), "the stored document holds no plaintext key");
    assert.ok(!Buffer.from(stored.tinyfish.data, "base64").toString("latin1").includes(APP_TINYFISH));
    // Saving again (the same key) uses a fresh IV.
    await api("PUT", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH });
    assert.notEqual((await db.collection("sales_search_keys").findOne({ _id: "workspace-a" }))!.tinyfish.iv, stored.tinyfish.iv);

    // A key is trimmed, 10 to 300 characters, with no whitespace inside; a refusal never repeats it. Only the two engines exist.
    for (const key of ["short", "has a space 1234567", `tf_${"x".repeat(300)}`, "line\nbreak_12345678"]) {
      const refused = await read(await api("PUT", "/sales/search-keys/exa", "boss", { key }));
      assert.equal(refused.status, 400, key);
      assert.ok(!refused.text.includes(key), "a refusal doesn't echo the key");
    }
    assert.equal((await api("PUT", "/sales/search-keys/google", "boss", { key: APP_EXA })).status, 400);
    const padded = status((await read(await api("PUT", "/sales/search-keys/exa", "boss", { key: `  ${APP_EXA}  ` }))).body);
    assert.deepEqual([padded.exa.source, padded.exa.last4], ["app", "ghij"]);
    assert.equal((await resolveSearchKeys(db, "workspace-a", { BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters" })).exaKey, APP_EXA, "stored trimmed");

    // The audit log names the engine only, never any part of the key.
    const audits = await db.collection("audit_events").find({ action: /^sales\.search_key\./ }).toArray();
    assert.deepEqual(audits.map((event) => JSON.stringify([event.action, event.metadata, event.actorId, event.objectType])).sort(), [
      ["sales.search_key.set", { engine: "exa" }, "user-boss", "sales_search_keys"], ["sales.search_key.set", { engine: "tinyfish" }, "user-boss", "sales_search_keys"], ["sales.search_key.set", { engine: "tinyfish" }, "user-boss", "sales_search_keys"],
    ].map((row) => JSON.stringify(row)).sort());
    const everything = JSON.stringify(await db.collection("audit_events").find({}).toArray());
    assert.ok(!everything.includes(APP_TINYFISH.slice(0, -4)) && !everything.includes(APP_EXA.slice(0, -4)));

    // Removing: back to not set, once; removing again changes nothing and isn't audited.
    const removed = await read(await api("DELETE", "/sales/search-keys/tinyfish", "boss"));
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(status(removed.body).tinyfish, { set: false, source: null });
    assert.equal(status(removed.body).exa.source, "app");
    assert.equal((await api("DELETE", "/sales/search-keys/tinyfish", "boss")).status, 200);
    assert.equal(await db.collection("audit_events").countDocuments({ action: "sales.search_key.remove", "metadata.engine": "tinyfish" }), 1);
    assert.equal((await db.collection("sales_search_keys").findOne({ _id: "workspace-a" }))!.tinyfish, undefined);
  }, "search_keys_admin");
});

test("the server's key is the fallback, a key saved in the app wins, and a key that can't be decrypted reads as unreadable and falls back", { skip }, async () => {
  await withSalesApp(async ({ api, db, config }) => {
    const server = status((await read(await api("GET", "/sales/search-keys", "boss"))).body);
    assert.deepEqual(server, { tinyfish: { set: true, source: "server" }, exa: { set: false, source: null } }, "a server key shows no last four");
    assert.deepEqual(await resolveSearchKeys(db, "workspace-a", config), { tinyfishKey: ENV_TINYFISH, exaKey: undefined });

    await api("PUT", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH });
    assert.equal(status((await read(await api("GET", "/sales/search-keys", "boss"))).body).tinyfish.source, "app");
    assert.equal((await resolveSearchKeys(db, "workspace-a", config)).tinyfishKey, APP_TINYFISH, "saving cleared the cache: the app key wins at once");
    // Without the secret, or under another one, the saved key can't be read: the server's is used.
    assert.equal((await resolveSearchKeys(db, "workspace-a", { TINYFISH_API_KEY: ENV_TINYFISH })).tinyfishKey, ENV_TINYFISH);
    assert.equal((await resolveSearchKeys(db, "workspace-a", { ...config, BETTER_AUTH_SECRET: "another-secret-that-is-at-least-32-chars" })).tinyfishKey, ENV_TINYFISH);

    // The saved keys are cached for a minute in this process: a change made behind the app's back shows only once the cache is cleared.
    const stored = (await db.collection("sales_search_keys").findOne({ _id: "workspace-a" }))!;
    const data = Buffer.from(stored.tinyfish.data, "base64"); data[0] = data[0]! ^ 0xff;
    await db.collection("sales_search_keys").updateOne({ _id: "workspace-a" }, { $set: { "tinyfish.data": data.toString("base64") } });
    assert.equal((await resolveSearchKeys(db, "workspace-a", config)).tinyfishKey, APP_TINYFISH, "still cached");
    forgetSearchKeys(db, "workspace-a");
    assert.equal((await resolveSearchKeys(db, "workspace-a", config)).tinyfishKey, ENV_TINYFISH, "a damaged ciphertext falls back to the server's key");
    const damaged = status((await read(await api("GET", "/sales/search-keys", "boss"))).body);
    assert.deepEqual({ ...damaged.tinyfish, setAt: undefined }, { set: true, source: "server", unreadable: true, setAt: undefined, setBy: "user-boss", setByName: "Person boss" });

    // An engine with no server key and an unreadable saved one (a damaged tag) is not set, and says why.
    await api("PUT", "/sales/search-keys/exa", "boss", { key: APP_EXA });
    await db.collection("sales_search_keys").updateOne({ _id: "workspace-a" }, { $set: { "exa.tag": Buffer.alloc(16).toString("base64") } });
    forgetSearchKeys(db, "workspace-a");
    const unreadable = status((await read(await api("GET", "/sales/search-keys", "boss"))).body);
    assert.deepEqual([unreadable.exa.set, unreadable.exa.source, unreadable.exa.unreadable, unreadable.exa.last4], [false, null, true, undefined]);
    assert.equal((await resolveSearchKeys(db, "workspace-a", config)).exaKey, undefined);

    // Entering it again fixes it; removing the saved key brings the server's back.
    assert.equal(status((await read(await api("PUT", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH }))).body).tinyfish.unreadable, undefined);
    assert.equal((await resolveSearchKeys(db, "workspace-a", config)).tinyfishKey, APP_TINYFISH);
    assert.deepEqual(status((await read(await api("DELETE", "/sales/search-keys/tinyfish", "boss"))).body).tinyfish, { set: true, source: "server" });
    assert.equal((await resolveSearchKeys(db, "workspace-a", config)).tinyfishKey, ENV_TINYFISH);
  }, "search_keys_fallback", { TINYFISH_API_KEY: ENV_TINYFISH });
});

test("search_companies uses the key saved in the app over the server's, and points to Sales setup when search is off", { skip }, async () => {
  const search = standInSearch();
  try {
    await withSalesApp(async ({ api, ok, tokenFor }) => {
      const writer = await tokenFor("member");
      const off = await ok(writer, "search_companies", { query: "pump distributors in Indore", engine: "exa" });
      assert.equal(off.searchSetUp, false);
      assert.match(off.say, /an admin can add a search key in Sales setup/i);
      assert.match(off.then, /admin can add a TinyFish or Exa key in Sales setup/);
      assert.match(off.then, /plan_find_run/);
      assert.equal(off.next[0], "Plan a find-leads run");
      assert.equal(search.seen.length, 0);

      search.answers.tinyfish = () => Response.json({ results: [{ url: "https://sharmapumps.in/", title: "Sharma Pumps | Pump distributors in Indore", snippet: "Industrial pumps." }] });
      const viaServer = await ok(writer, "search_companies", { query: "pump distributors in Indore" });
      assert.deepEqual(viaServer.engines, ["tinyfish"]);
      assert.equal(search.seen.at(-1)!.headers["x-api-key"], ENV_TINYFISH);

      // Saved in the app: it wins at once, for TinyFish, and Exa turns on.
      await api("PUT", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH });
      await api("PUT", "/sales/search-keys/exa", "boss", { key: APP_EXA });
      search.seen.length = 0;
      const viaApp = await ok(writer, "search_companies", { query: "pump distributors in Indore" });
      assert.deepEqual([...viaApp.engines].sort(), ["exa", "tinyfish"]);
      assert.deepEqual(viaApp.companies.map((row: any) => row.domain), ["sharmapumps.in"]);
      assert.equal(search.seen.find((call) => call.engine === "tinyfish")!.headers["x-api-key"], APP_TINYFISH);
      assert.equal(search.seen.find((call) => call.engine === "exa")!.headers["x-api-key"], APP_EXA);
      for (const call of search.seen) assert.ok(!call.url.href.includes(APP_TINYFISH) && !call.url.href.includes(APP_EXA), "keys never travel in an address");
      assert.ok(!JSON.stringify(viaApp).includes(APP_TINYFISH) && !JSON.stringify(viaApp).includes(APP_EXA), "keys never come back to Claude");

      // Removed: the server's key again, and no Exa.
      await api("DELETE", "/sales/search-keys/tinyfish", "boss");
      await api("DELETE", "/sales/search-keys/exa", "boss");
      search.seen.length = 0;
      assert.deepEqual((await ok(writer, "search_companies", { query: "pump distributors in Indore" })).engines, ["tinyfish"]);
      assert.deepEqual(search.seen.map((call) => [call.engine, call.headers["x-api-key"]]), [["tinyfish", ENV_TINYFISH]]);
    }, "search_keys_connector", { TINYFISH_API_KEY: ENV_TINYFISH });
  } finally { search.restore(); }
});

test("the test route runs one small search with the key in use, counts it, maps the engines' refusals and is rate-limited", { skip }, async () => {
  const search = standInSearch();
  try {
    await withSalesApp(async ({ api, db }) => {
      // A second admin, so each person's five tests a minute cover the checks below.
      const now = new Date();
      await db.collection("users").insertOne({ _id: "user-boss2", workspaceId: "workspace-a", email: "boss2@example.invalid", name: "Person boss2", handle: "boss2", status: "active", createdAt: now, updatedAt: now });
      await db.collection("memberships").insertOne({ _id: "membership-boss2", workspaceId: "workspace-a", userId: "user-boss2", role: "admin", ventureIds: [], groupIds: [], status: "active", createdAt: now, updatedAt: now });
      const run = async (engine: string, handle = "boss") => { const reply = await read(await api("POST", `/sales/search-keys/${engine}/test`, handle, {})); assert.equal(reply.status, 200, reply.text); return { ...tested(reply.body), text: reply.text }; };
      const usage = async (engine: string) => Number((await db.collection("mcp_search_usage").findOne({ engine }))?.calls ?? 0);

      assert.deepEqual(await run("tinyfish").then(({ text: _text, ...rest }) => rest), { ok: false, message: "No TinyFish key is set: save one first" });
      assert.equal(search.seen.length, 0);
      assert.equal(await usage("tinyfish"), 0, "nothing is spent without a key");

      await api("PUT", "/sales/search-keys/tinyfish", "boss", { key: APP_TINYFISH });
      const works = await run("tinyfish");
      assert.equal(works.ok, true);
      assert.equal(works.message, undefined);
      assert.equal(search.seen.length, 1);
      assert.equal(search.seen[0]!.headers["x-api-key"], APP_TINYFISH);
      assert.equal(search.seen[0]!.url.searchParams.get("query"), "software companies in Bengaluru");
      assert.equal(await usage("tinyfish"), 1, "a test counts against the allowance");

      search.answers.tinyfish = () => new Response("{}", { status: 401 });
      const refused = await run("tinyfish");
      assert.deepEqual([refused.ok, refused.message], [false, "TinyFish Search refused the request: its key was rejected or its quota is used up"]);
      assert.ok(!refused.text.includes(APP_TINYFISH.slice(0, -4)));

      // A used-up allowance is said plainly, and the engine isn't asked.
      const today = new Date().toISOString().slice(0, 10);
      await db.collection("mcp_search_usage").updateOne({ _id: `workspace-a:tinyfish:${today}` as never }, { $set: { calls: 1_500 } });
      search.seen.length = 0;
      assert.deepEqual([(await run("tinyfish")).message, search.seen.length], ["TinyFish has reached this workspace's daily allowance", 0]);

      // Exa: one result asked for, its refusal and a failure mapped to the same short messages; nothing carries the key.
      await api("PUT", "/sales/search-keys/exa", "boss2", { key: APP_EXA });
      search.answers.exa = () => new Response("upstream error mentioning exa_test_abcdefghij", { status: 403 });
      const exaRefused = await run("exa", "boss2");
      assert.deepEqual([exaRefused.ok, exaRefused.message], [false, "Exa refused the request: its key was rejected or its quota is used up"]);
      assert.equal(search.seen.at(-1)!.body.numResults, 1);
      assert.equal(search.seen.at(-1)!.headers["x-api-key"], APP_EXA);
      search.answers.exa = () => new Response("secret body exa_test_abcdefghij", { status: 500 });
      const failed = await run("exa", "boss2");
      assert.deepEqual([failed.ok, failed.message], [false, "Exa answered with an error (HTTP 500)"]);
      assert.ok(!failed.text.includes(APP_EXA.slice(0, -4)));

      // Audited with the engine only.
      const audits = await db.collection("audit_events").find({ action: "sales.search_key.test" }).toArray();
      assert.equal(audits.length, 6);
      assert.ok(audits.every((event) => JSON.stringify(event.metadata) === JSON.stringify({ engine: event.metadata.engine }) && ["tinyfish", "exa"].includes(event.metadata.engine)));

      // A few tests a minute per person: the next ones are refused with a wait (eleven tries always span a full window).
      search.answers.exa = () => Response.json({ results: [] });
      let limited: Awaited<ReturnType<typeof read>> | undefined;
      for (let index = 0; index < 11 && !limited; index++) {
        const reply = await read(await api("POST", "/sales/search-keys/exa/test", "boss2", {}));
        if (reply.status === 429) limited = reply; else assert.equal(reply.status, 200, reply.text);
      }
      assert.ok(limited, "the limit is reached");
      assert.match(limited.body.error.message, /Too many key tests in a minute; try again in \d+ s/);
      assert.equal((await api("POST", "/sales/search-keys/tinyfish/test", "boss", {})).status, 200, "another admin's tests are counted apart");
    }, "search_keys_test_route");
  } finally { search.restore(); }
});
