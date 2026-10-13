import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PAT_READ_SCOPES, PAT_WRITE_SCOPES } from "@venture-studio/contracts";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { connectDatabase } from "../src/db.js";
import { ensureIndexes } from "../src/indexes.js";
import { LocalObjectStore } from "../src/storage.js";

// Shared by the Dealflow Sales connector tests (mcp-sales.test.ts, mcp-sales-guided.test.ts): a throwaway app, tokens, and MCP calls.

export const READ_TOOLS = ["start_sales", "sales_overview", "inbox", "list_drafts", "find_leads", "get_lead", "list_plays", "list_find_runs", "get_brain", "list_offers", "get_offer", "search_companies", "weekly_report", "daybreak"];
export const WRITE_TOOLS = ["save_verdict", "save_verdicts", "save_draft", "save_drafts", "review_draft", "revise_draft", "log_reply", "log_call", "update_lead", "add_leads", "enrich_lead", "propose_play", "plan_find_run", "propose_brain_change", "propose_offer"];
export const FULL = [...PAT_READ_SCOPES, ...PAT_WRITE_SCOPES];
/** The two connectors: Venture Studio at /mcp and Dealflow Sales at /mcp/sales (this file's tools live on the second). */
export const STUDIO = "/mcp";
export const SALES = "/mcp/sales";
export const SHARED_TOOLS = ["find_person", "list_ventures"];
export const RETIRED_DEAL_TOOLS = ["list_deals", "add_deal", "update_deal"];

export async function mcpCall(origin: string, token: string | undefined, method: string, params: unknown = {}, path = SALES) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
export async function mcpTool(origin: string, token: string, name: string, args: Record<string, unknown> = {}, path = SALES) {
  const response = await mcpCall(origin, token, "tools/call", { name, arguments: args }, path);
  const text: string | undefined = response.body?.result?.content?.[0]?.text;
  const isError = response.body?.result?.isError === true || Boolean(response.body?.error);
  return { ...response, isError, text: text ?? response.body?.error?.message, data: text && !isError ? JSON.parse(text) : undefined };
}

/** A fresh app on its own throwaway database, with a venture head, two contributors, a learner, an outsider and an admin. */
export async function withSalesApp(run: (env: Awaited<ReturnType<typeof setup>>) => Promise<void>, suffix: string, env: Record<string, string> = {}) {
  const app = await setup(suffix, env);
  try { await run(app); } finally {
    app.server.close();
    await once(app.server, "close");
    await app.database.native.dropDatabase();
    await app.database.client.close();
  }
}

export async function setup(suffix: string, extra: Record<string, string> = {}) {
  const dbName = `venture_studio_test_${process.pid}_${Date.now()}_${suffix}`;
  assert.match(dbName, /^venture_studio_test_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters", ...extra,
  });
  const database = await connectDatabase(config);
  const db = database.db;
  await ensureIndexes(db);
  const now = new Date();
  await db.collection("workspaces").insertOne({ _id: "workspace-a", name: "A", slug: "a", createdAt: now });
  const people = [["lead", "venture_head", ["venture-a"], ["group-a"]], ["member", "contributor", ["venture-a"], ["group-a"]], ["member2", "contributor", ["venture-a"], ["group-a"]], ["learner", "learner", ["venture-a"], ["group-a"]], ["outsider", "contributor", ["venture-b"], ["group-b"]], ["boss", "admin", [], []]] as const;
  await db.collection("users").insertMany(people.map(([handle]) => ({ _id: `user-${handle}`, workspaceId: "workspace-a", email: `${handle}@example.invalid`, name: `Person ${handle}`, handle, status: "active", createdAt: now, updatedAt: now })));
  await db.collection("memberships").insertMany(people.map(([handle, role, ventureIds, groupIds]) => ({ _id: `membership-${handle}`, workspaceId: "workspace-a", userId: `user-${handle}`, role, ventureIds: [...ventureIds], groupIds: [...groupIds], status: "active", createdAt: now, updatedAt: now })));
  for (const key of ["a", "b"]) {
    await db.collection("ventures").insertOne({ _id: `venture-${key}`, workspaceId: "workspace-a", name: key === "a" ? "Alpha" : "Beta", status: "active", goal30Day: "", createdAt: now });
    await db.collection("groups").insertOne({ _id: `group-${key}`, workspaceId: "workspace-a", ventureId: `venture-${key}`, name: "Core", createdAt: now });
    await db.collection("channels").insertOne({ _id: `channel-${key}`, workspaceId: "workspace-a", ventureId: `venture-${key}`, groupId: `group-${key}`, name: "general", createdAt: now });
  }
  await db.collection("pipelines").insertOne({ _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Agencies", offerName: "Dealer ordering app", status: "active", createdAt: now, updatedAt: now });
  const { app } = createApp(database, config, createAuth(database.native, config), new LocalObjectStore(config));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const api = (method: string, path: string, handle: string, body?: unknown) => fetch(`${origin}/v1${path}`, { method, headers: { "content-type": "application/json", "x-dev-user-id": `user-${handle}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  /** One key per call: each key has its own write allowance, like separate connections. */
  const tokenFor = async (handle: string, scopes: readonly string[] = FULL) => {
    const response = await api("POST", "/pats", handle, { name: `${handle} key`, scopes, expiresInDays: 30 });
    assert.equal(response.status, 201, await response.clone().text());
    return ((await response.json()) as any).data.token as string;
  };
  const ok = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const result = await mcpTool(origin, token, name, args);
    assert.equal(result.isError, false, `${name}: ${result.text}`);
    // Every sales result guides the chat: one plain sentence, and up to three options.
    if (!SHARED_TOOLS.includes(name) && result.data && typeof result.data === "object") {
      assert.equal(typeof result.data.say, "string", `${name} says something`);
      assert.ok(result.data.say.length > 3 && result.data.say.length < 700, `${name} says it briefly`);
      assert.ok(Array.isArray(result.data.next) && result.data.next.length >= 1 && result.data.next.length <= 3, `${name} offers up to three next steps`);
    }
    return result.data;
  };
  const refused = async (token: string, name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const result = await mcpTool(origin, token, name, args);
    assert.equal(result.isError, true, `${name} should be refused: ${result.text}`);
    assert.match(String(result.text), pattern, name);
  };
  const names = async (token: string, path = SALES) => ((await mcpCall(origin, token, "tools/list", {}, path)).body?.result?.tools ?? []).map((item: any) => item.name as string);
  return { config, database, db, server, origin, api, tokenFor, ok, refused, names };
}
