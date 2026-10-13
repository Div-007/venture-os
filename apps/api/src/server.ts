import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { ensureIndexes } from "./indexes.js";
import { createAuth } from "./auth.js";
import { createObjectStore } from "./storage.js";
import { createApp } from "./app.js";
import { backfillFileTexts } from "./file-text.js";
import { fileStoreFor } from "./routes/files.js";
import { attachRealtime, stopRealtime } from "./collaboration.js";
import { createFinder, finderEnabled } from "./sales/finder/runner.js";
import { migrateSalesLeads } from "./sales/migration.js";

const envFile = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find(existsSync);
if (envFile) process.loadEnvFile(envFile);
const config = loadConfig();
const database = await connectDatabase(config);
await ensureIndexes(database.db);
const auth = createAuth(database.native, config);
const store = createObjectStore(config);
const { app, resolveActor, localStore } = createApp(database, config, auth, store);
const server = createServer(app);
// The web proxy reuses idle keep-alive sockets; the default 5s server keep-alive can close one first, surfacing as ECONNRESET/HTTP 500.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
attachRealtime(server, database, resolveActor, config.APP_ORIGIN, config.APP_MODE === "local" && config.ALLOW_DEV_AUTH);
server.listen(config.PORT, () => console.info(JSON.stringify({ level: "info", event: "api.started", port: config.PORT, mode: config.APP_MODE, transactions: database.transactions, storage: store.kind })));
// Files uploaded before their text was read (or while reading was busy) are read once in the background after startup.
setTimeout(() => void backfillFileTexts(database.db, (file) => fileStoreFor(file, store, localStore)).then((read) => { if (read) console.info(JSON.stringify({ level: "info", event: "file_text.backfill", read })); }, (error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "file_text.backfill_failed", message: error instanceof Error ? error.message : String(error) }))), 5_000).unref();
// Older deal records (from before Sales) get the Sales names and do-not-contact match keys once, in the background: a deploy runs no
// migration step, and the run is safe to repeat (it changes nothing the second time). npm run migrate does the same by hand.
setTimeout(() => void migrateSalesLeads(database.db, { whenChanged: true }).then((result) => { if (Object.values(result).some(Boolean)) console.info(JSON.stringify({ level: "info", event: "sales.migration", ...result })); }, (error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "sales.migration_failed", message: error instanceof Error ? error.message : String(error) }))), 3_000).unref();
// The built-in lead finder works queued find-leads and enrich runs in the background (SALES_FINDER=on, never under tests); a workspace
// without a company-search key keeps its runs queued. On shutdown a run in progress goes back to the queue.
const finder = finderEnabled(config) ? createFinder({ database, env: config }) : undefined;
if (finder) setTimeout(() => finder.start(), 5_000).unref();
async function shutdown() { await finder?.stop(); stopRealtime(database); server.close(); await database.client.close(); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
