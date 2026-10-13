import express from "express";
import { toNodeHandler } from "better-auth/node";
import type { Database } from "./db.js";
import { trustProxySetting, type AppConfig } from "./config.js";
import type { Auth } from "./auth.js";
import type { ObjectStore } from "./storage.js";
import { LocalObjectStore } from "./storage.js";
import { clientAddressFromHeader, createActorResolver, createIdentityResolver, rateLimit, requestContext, requireActor, requireIdentity } from "./middleware.js";
import { AppError, createErrorHandler } from "./errors.js";
import { hierarchyRoutes } from "./routes/hierarchy.js";
import { workRoutes } from "./routes/work.js";
import { collaborationRoutes } from "./collaboration.js";
import { commandRoutes } from "./routes/commands.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { agentContextRoutes } from "./routes/agent-context.js";
import { fileRoutes, localObjectRoutes } from "./routes/files.js";
import { patRoutes } from "./routes/pats.js";
import { adminRoutes, invitationAcceptanceRoutes } from "./routes/admin.js";
import { notificationRoutes } from "./routes/notifications.js";
import { salesRoutes } from "./routes/sales.js";
import { salesEngineRoutes } from "./routes/sales-engine.js";
import { salesReportsRoutes } from "./routes/sales-reports.js";
import { salesFinderRoutes } from "./routes/sales-finder.js";
import { salesSearchKeyRoutes } from "./routes/sales-search-keys.js";
import { salesIoRoutes } from "./routes/sales-io.js";
import { leaderboardRoutes } from "./routes/leaderboard.js";
import { celebrationRoutes } from "./routes/celebrations.js";
import { searchRoutes } from "./routes/search.js";
import { firstAdminRoutes } from "./routes/first-admin.js";
import { ventureLifecycleRoutes } from "./routes/venture-lifecycle.js";
import { calendarRoutes } from "./routes/calendar.js";
import { calendarFeedRoutes, publicCalendarFeedRoutes } from "./routes/calendar-feed.js";
import { isMcpRoute, mcpBodyErrors, mcpRouter } from "./mcp/http.js";

export function createApp(database: Database, config: AppConfig, auth: Auth, store: ObjectStore) {
  const app = express();
  if (config.TRUST_PROXY) app.set("trust proxy", trustProxySetting(config.TRUST_PROXY));
  if (config.CLIENT_IP_HEADER) app.use(clientAddressFromHeader(config.CLIENT_IP_HEADER));
  const resolveIdentity = createIdentityResolver(auth, database.db, config);
  const resolveActor = createActorResolver(auth, database.db, config);
  app.use(requestContext);
  app.all("/api/auth/*splat", toNodeHandler(auth));
  const localStore = store instanceof LocalObjectStore ? store : new LocalObjectStore(config);
  app.use("/v1", localObjectRoutes(database.db, localStore));
  // MCP messages are small; parsed first so the 2 MB limit below never applies to /mcp.
  app.use("/mcp", express.json({ limit: "64kb" }), mcpBodyErrors);
  // A CSV import carries a file of up to 5 MB: those two routes read their larger body only after the person is signed in (below).
  const jsonBody = express.json({ limit: "2mb" });
  app.use((req, res, next) => (req.path.startsWith("/v1/sales/leads/import/") ? next() : jsonBody(req, res, next)));
  // Hosted MCP authenticates with personal access tokens, so it sits before the /v1 session gate.
  app.use(mcpRouter(database.db, config));
  // MCP tools act as the token owner, but only on the routes the tools use; everything else (tokens, admin, invitations,
  // deletes, push subscriptions, uploads...) is refused even if a future tool tried to reach it.
  app.use((req, _res, next) => next(req.interfaceChannel === "mcp" && !isMcpRoute(req.method, req.path) ? new AppError(403, "FORBIDDEN", "Not available to Claude connections") : undefined));
  // The office PC lead-finding worker: a Bearer token with the sales:engine scope, never a session, a dev header or the MCP loopback.
  app.use("/v1/sales/engine", salesEngineRoutes(database));
  app.get("/health", async (_req, res) => { await database.db.command({ ping: 1 }); res.json({ ok: true, mode: config.APP_MODE, transactions: database.transactions, storage: store.kind }); });
  app.use("/v1/setup/first-admin", rateLimit(database.db, 60, 60_000, "setup-ip"));
  app.use("/v1", firstAdminRoutes(database, config, auth));
  app.use("/v1/invitations/accept", rateLimit(database.db, 60, 60_000, "invite-ip"), requireIdentity(resolveIdentity), rateLimit(database.db, 30, 60_000, "invite-user"));
  app.use("/v1", invitationAcceptanceRoutes(database));
  // Calendar apps read the private calendar link without signing in: the secret in its address is the key.
  app.use("/v1/calendar/feed", rateLimit(database.db, 600, 60_000, "calendar-feed-ip"));
  app.use("/v1", publicCalendarFeedRoutes(database, config));
  const readLimit = rateLimit(database.db, 300, 60_000, "actor-read");
  const writeLimit = rateLimit(database.db, 120, 60_000, "actor-write");
  app.use("/v1", requireActor(resolveActor, rateLimit(database.db, 60, 60_000, "anonymous-ip")));
  app.use("/v1", (req, res, next) => (req.method === "GET" || req.method === "HEAD" ? readLimit : writeLimit)(req, res, next));
  app.use("/v1/sales/leads/import", express.json({ limit: "12mb" }));
  app.use("/v1", hierarchyRoutes(database.db));
  app.use("/v1", workRoutes(database));
  app.use("/v1", collaborationRoutes(database));
  app.use("/v1", commandRoutes(database));
  app.use("/v1", knowledgeRoutes(database));
  app.use("/v1", agentContextRoutes(database));
  app.use("/v1", fileRoutes(database.db, store, localStore));
  app.use("/v1", patRoutes(database.db, config));
  app.use("/v1", adminRoutes(database, config));
  app.use("/v1", ventureLifecycleRoutes(database));
  app.use("/v1", notificationRoutes(database.db, config.VAPID_PUBLIC_KEY));
  // Before the lead routes: "export.csv" and "bulk" are not lead ids.
  app.use("/v1/sales", salesIoRoutes(database));
  app.use("/v1", salesRoutes(database));
  app.use("/v1/sales", salesReportsRoutes(database));
  app.use("/v1/sales", salesFinderRoutes(database, config));
  app.use("/v1/sales", salesSearchKeyRoutes(database, config));
  app.use("/v1", leaderboardRoutes(database, config));
  app.use("/v1", celebrationRoutes(database, config));
  app.use("/v1", searchRoutes(database.db));
  app.use("/v1", calendarRoutes(database));
  app.use("/v1", calendarFeedRoutes(database, config));
  app.use((_req, res) => res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Route not found", requestId: res.getHeader("x-request-id") } }));
  app.use(createErrorHandler(database.db));
  return { app, resolveActor, localStore };
}
