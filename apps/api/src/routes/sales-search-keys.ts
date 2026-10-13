import { Router } from "express";
import { salesSearchEngineSchema, salesSearchKeyInputSchema, type SalesSearchEngine, type SalesSearchKeyTest } from "@venture-studio/contracts";
import type { AppConfig } from "../config.js";
import { atomic, type Database } from "../db.js";
import { AppError } from "../errors.js";
import { overLimit } from "../middleware.js";
import { forbidClaude, forbidden } from "../sales/access.js";
import { auditSales, salesCtx, type SalesCtx } from "../sales/ctx.js";
import { SEARCH_CAPS, reserveSearch, searchExa, searchTinyfish } from "../sales/search-engines.js";
import { forgetSearchKeys, removeSearchKey, resolveSearchKeys, saveSearchKey, searchKeyStatus } from "../sales/search-keys.js";

const ok = (data: unknown) => ({ ok: true, data });
const LABEL: Record<SalesSearchEngine, string> = { tinyfish: "TinyFish", exa: "Exa" };
// One small search per test: a few results, so a test costs one call against the workspace's allowance.
const TEST_QUERY = "software companies in Bengaluru";
const TESTS_PER_MINUTE = 5;

/**
 * The company-search keys (TinyFish, Exa) behind search_companies and the lead finder, for the whole workspace. Admins only, in the app:
 * they see the status, save or remove a key (encrypted, see sales/search-keys.ts) and run one small test search. No route ever returns a
 * key or any part of it beyond its last four characters, and the audit log records only which engine changed.
 */
export function salesSearchKeyRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();
  const admin = (ctx: SalesCtx, what: string) => { if (ctx.actor.membership.role !== "admin") throw forbidden(`Only an admin can ${what}`); };

  router.get("/search-keys", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "see the company-search keys");
    res.json(ok(await searchKeyStatus(db, ctx.workspaceId, config)));
  });

  // Saves or replaces one engine's key. It wins over the server's key at once (the cache in this process is cleared).
  router.put("/search-keys/:engine", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "change the company-search keys");
    forbidClaude(ctx.via, "Changing the company-search keys");
    const engine = salesSearchEngineSchema.parse(req.params.engine);
    const { key } = salesSearchKeyInputSchema.parse(req.body ?? {});
    await atomic(database, async (session) => {
      await saveSearchKey(db, ctx.workspaceId, engine, key, config.BETTER_AUTH_SECRET, ctx.actor.id, session);
      await auditSales(ctx, "sales.search_key.set", "sales_search_keys", ctx.workspaceId, undefined, { engine }, session);
    });
    forgetSearchKeys(db, ctx.workspaceId);
    res.json(ok(await searchKeyStatus(db, ctx.workspaceId, config)));
  });

  // Removes the key saved in the app; the server's key (if there is one) is used again. Removing a key that isn't saved changes nothing.
  router.delete("/search-keys/:engine", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "change the company-search keys");
    forbidClaude(ctx.via, "Changing the company-search keys");
    const engine = salesSearchEngineSchema.parse(req.params.engine);
    await atomic(database, async (session) => {
      if (await removeSearchKey(db, ctx.workspaceId, engine, session)) await auditSales(ctx, "sales.search_key.remove", "sales_search_keys", ctx.workspaceId, undefined, { engine }, session);
    });
    forgetSearchKeys(db, ctx.workspaceId);
    res.json(ok(await searchKeyStatus(db, ctx.workspaceId, config)));
  });

  // One small search with the key search would use (saved in the app, else the server's), counted against the workspace's allowance.
  // Answers { ok } or { ok: false, message } with the engines' short messages, which carry no URL, header, response body or key.
  router.post("/search-keys/:engine/test", async (req, res) => {
    const ctx = salesCtx(database, req);
    admin(ctx, "test the company-search keys");
    forbidClaude(ctx.via, "Testing the company-search keys");
    const engine = salesSearchEngineSchema.parse(req.params.engine);
    const wait = await overLimit(db, `sales-search-key-test:${ctx.actor.id}`, TESTS_PER_MINUTE);
    if (wait) { res.setHeader("retry-after", String(wait)); throw new AppError(429, "RATE_LIMITED", `Too many key tests in a minute; try again in ${wait} s`); }
    const keys = await resolveSearchKeys(db, ctx.workspaceId, config);
    const key = engine === "tinyfish" ? keys.tinyfishKey : keys.exaKey;
    let result: SalesSearchKeyTest;
    if (!key) result = { ok: false, message: `No ${LABEL[engine]} key is set: save one first` };
    else if (!(await reserveSearch(db, ctx.workspaceId, engine))) result = { ok: false, message: `${LABEL[engine]} has reached this workspace's ${SEARCH_CAPS[engine].period === "day" ? "daily" : "monthly"} allowance` };
    else {
      try { await (engine === "tinyfish" ? searchTinyfish(key, TEST_QUERY, "IN", 1) : searchExa(key, TEST_QUERY, "IN", 1)); result = { ok: true }; }
      catch (error) { result = { ok: false, message: error instanceof Error ? error.message : "The test search failed" }; }
    }
    await auditSales(ctx, "sales.search_key.test", "sales_search_keys", ctx.workspaceId, undefined, { engine });
    res.json(ok(result));
  });

  return router;
}
