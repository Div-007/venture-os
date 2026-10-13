import { Router, type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hashPat } from "@venture-studio/core";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db.js";
import { overLimit, rateLimitAddress } from "../middleware.js";
import { resolveSearchKeys } from "../sales/search-keys.js";
import { apiClient, ToolError } from "./format.js";
import type { ToolContext } from "./kit.js";
import { registerPrompts, registerTools, SERVER_INSTRUCTIONS } from "./tools.js";
import { registerSalesPrompts, registerSalesServer, SALES_SERVER_INSTRUCTIONS, SALES_SERVER_NAME, SALES_SERVER_TITLE } from "./sales-server.js";

// Per-token budgets on top of the API's own per-person limits. Hourly polling uses a tiny fraction of these.
const REQUESTS_PER_MINUTE = 120;
const WRITES_PER_MINUTE = 30;
const PERSON_REQUESTS_PER_MINUTE = 240;
const UNAUTHENTICATED_PER_MINUTE = 30;
const LAST_USED_EVERY_MS = 5 * 60_000;
// Bytes a person may upload through Claude in a day (the app's own uploads are not counted).
const UPLOAD_BYTES_PER_DAY = 250 * 1024 * 1024;

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).json({ jsonrpc: "2.0", error: { code: status === 401 ? -32001 : status === 429 ? -32029 : -32000, message }, id: null });
}

type Grant = { patId: string; userId: string; workspaceId: string; scopes: Set<string> };

/** The token's grant, or undefined when it is unknown, revoked, expired, or its membership or person is no longer active. */
async function authenticate(db: AppDb, header: string | undefined): Promise<Grant | undefined> {
  // The scheme is case-insensitive (RFC 9110); the token itself must match exactly.
  const match = /^bearer\s+(vso_[A-Za-z0-9_-]{20,200})$/i.exec(header ?? "");
  if (!match) return undefined;
  const now = new Date();
  // Older local-only tokens have no membership binding; hosted MCP refuses them.
  const pat = await db.collection("pats").findOne({ tokenHash: hashPat(match[1]!), revokedAt: { $exists: false }, expiresAt: { $gt: now }, membershipId: { $exists: true } });
  if (!pat) return undefined;
  const membership = await db.collection("memberships").findOne({ _id: pat.membershipId, workspaceId: pat.workspaceId, userId: pat.userId, status: "active" }, { projection: { _id: 1 } });
  const user = membership ? await db.collection("users").findOne({ _id: pat.userId, status: "active" }, { projection: { _id: 1 } }) : null;
  if (!membership || !user) return undefined;
  if (!pat.lastUsedAt || now.getTime() - new Date(pat.lastUsedAt).getTime() > LAST_USED_EVERY_MS) await db.collection("pats").updateOne({ _id: pat._id }, { $set: { lastUsedAt: now } });
  return { patId: String(pat._id), userId: String(pat.userId), workspaceId: String(pat.workspaceId), scopes: new Set(pat.scopes as string[]) };
}

/** The two Claude connectors: Venture Studio (tasks, communication, knowledge) at /mcp and Dealflow Sales at /mcp/sales. */
type Connector = "studio" | "sales";

/**
 * Hosted MCP over Streamable HTTP: stateless (a fresh server per request), JSON responses, no sessions or SSE. Both endpoints use the same
 * personal access tokens, rate limits and loopback allowlist; a token's scopes decide which of the connector's tools it sees.
 */
export function mcpRouter(db: AppDb, config: AppConfig): Router {
  const router = Router();
  const appOrigin = new URL(config.APP_ORIGIN).origin;
  const handler = (connector: Connector) => async (req: Request, res: Response) => {
    try {
      if (!config.MCP_ENABLED) return jsonRpcError(res, 503, "Claude connections are turned off for this workspace");
      if (req.method !== "POST") return jsonRpcError(res, 405, "Use POST: this server is stateless and does not stream", { allow: "POST" });
      // A browser page on another site must not drive the endpoint (DNS rebinding); command-line clients send no Origin.
      const origin = req.headers.origin;
      if (origin && origin !== appOrigin) return jsonRpcError(res, 403, "This origin may not call the MCP endpoint");
      // One HTTP request is one JSON-RPC message, so the per-token budget counts real work (no batches).
      if (Array.isArray(req.body)) return jsonRpcError(res, 400, "Send one JSON-RPC message per request; batches are not supported");
      const address = req.ip ? rateLimitAddress(req.ip) : "unknown";
      const grant = await authenticate(db, req.headers.authorization);
      if (!grant) {
        const wait = await overLimit(db, `mcp-anon:${address}`, UNAUTHENTICATED_PER_MINUTE);
        if (wait) return jsonRpcError(res, 429, "Too many requests", { "retry-after": String(wait) });
        return jsonRpcError(res, 401, "Missing, revoked, or expired token. Create one on the Connect Claude page.", { "www-authenticate": `Bearer realm="${connector === "sales" ? SALES_SERVER_NAME : "venture-studio"}", error="invalid_token"` });
      }
      // The office PC engine's token (sales:engine) belongs to a worker, never to Claude: it can't be used on either connector.
      if (grant.scopes.has("sales:engine")) return jsonRpcError(res, 403, "This token is for the office PC engine and can't be used as a Claude connection. Create a Claude key on the Connect Claude page.");
      // Per token, and per person across all their tokens (someone may hold several).
      const wait = await overLimit(db, `mcp:${grant.patId}`, REQUESTS_PER_MINUTE) || await overLimit(db, `mcp-user:${grant.userId}`, PERSON_REQUESTS_PER_MINUTE);
      if (wait) return jsonRpcError(res, 429, "Too many requests; slow down", { "retry-after": String(wait) });

      const server = connector === "sales"
        ? new McpServer({ name: SALES_SERVER_NAME, title: SALES_SERVER_TITLE, version: "1.0.0" }, { instructions: SALES_SERVER_INSTRUCTIONS })
        : new McpServer({ name: "venture-studio", title: "Venture Studio", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
      // Loopback to this same process: the tools use the product API as the token's owner.
      const base = `http://127.0.0.1:${req.socket.localPort}`;
      const toolContext: ToolContext = {
        api: apiClient(base, grant.userId), db, userId: grant.userId, workspaceId: grant.workspaceId, patId: grant.patId, scopes: grant.scopes,
        writesEnabled: config.MCP_WRITES_ENABLED, origin: appOrigin, searchKeys: () => resolveSearchKeys(db, grant.workspaceId, config),
        writeBudget: async () => { const seconds = await overLimit(db, `mcp-write:${grant.patId}`, WRITES_PER_MINUTE); if (seconds) throw new ToolError(`Too many changes in a minute from this token; retry in ${seconds} s.`, 429); },
        toolBudget: async (tool, perMinute) => { const seconds = await overLimit(db, `mcp-tool:${tool}:${grant.patId}`, perMinute); if (seconds) throw new ToolError(`Too many ${tool.replaceAll("_", " ")} calls in a minute; retry in ${seconds} s.`, 429); },
        uploadBudget: async (bytes) => { const seconds = await overLimit(db, `mcp-upload-bytes:${grant.userId}`, UPLOAD_BYTES_PER_DAY, 86_400_000, bytes); if (seconds) throw new ToolError("You've reached today's 250 MB upload allowance through Claude; upload larger files in the app.", 429); },
      };
      if (connector === "sales") { registerSalesServer(server, toolContext); registerSalesPrompts(server, grant.scopes); }
      else { registerTools(server, toolContext); registerPrompts(server, grant.scopes); }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", source: "mcp", message: error instanceof Error ? error.message : String(error) }));
      if (!res.headersSent) jsonRpcError(res, 500, "Internal error");
    }
  };
  router.all("/mcp", handler("studio"));
  router.all("/mcp/sales", handler("sales"));
  return router;
}

/** Mounted right after the /mcp body parser: unparseable or oversized bodies get a JSON-RPC error, not the REST envelope. */
export function mcpBodyErrors(error: { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction): void {
  // Only reading the body can fail here (bad JSON, size, charset, or a corrupt compressed stream), so every error is the client's.
  if (res.headersSent) return next(error);
  const parse = error.type === "entity.parse.failed" || !error.type;
  const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 400;
  const message = parse ? "Parse error: the body must be one JSON-RPC object" : error.type === "entity.too.large" ? "Request too large" : "Unreadable request body; send UTF-8 JSON";
  res.status(status).json({ jsonrpc: "2.0", error: { code: parse ? -32700 : -32600, message }, id: null });
}

// The only product API calls the tools make (method, path under /v1). Loopback calls outside this list are refused.
const MCP_ROUTES: [string, RegExp][] = [
  ["GET", /^\/v1\/session\/bootstrap$/], ["GET", /^\/v1\/members$/],
  ["GET", /^\/v1\/tasks$/], ["GET", /^\/v1\/tasks\/[A-Za-z0-9_-]+$/], ["PATCH", /^\/v1\/tasks\/[A-Za-z0-9_-]+$/],
  ["POST", /^\/v1\/tasks\/[A-Za-z0-9_-]+\/(comments|evidence)$/],
  ["GET", /^\/v1\/outcomes$/], ["GET", /^\/v1\/decisions$/], ["GET", /^\/v1\/knowledge\/search$/], ["GET", /^\/v1\/search$/],
  ["GET", /^\/v1\/documents\/[A-Za-z0-9_-]+$/], ["GET", /^\/v1\/channels\/[A-Za-z0-9_-]+\/messages$/],
  ["GET", /^\/v1\/reminders$/], ["POST", /^\/v1\/reminders$/], ["POST", /^\/v1\/reminders\/[A-Za-z0-9_-]+\/snooze$/],
  ["GET", /^\/v1\/notifications$/], ["POST", /^\/v1\/notifications\/read$/], ["POST", /^\/v1\/notifications\/[A-Za-z0-9_-]+\/read$/],
  // Knowledge documents and files (approving a document stays in the app).
  ["GET", /^\/v1\/documents$/], ["POST", /^\/v1\/documents$/], ["PUT", /^\/v1\/documents\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/v1\/files$/], ["GET", /^\/v1\/files\/[A-Za-z0-9_-]+\/text$/], ["POST", /^\/v1\/uploads$/], ["POST", /^\/v1\/uploads\/[A-Za-z0-9_-]+\/complete$/],
  // Tasks, reviews, and messages.
  ["POST", /^\/v1\/tasks$/], ["POST", /^\/v1\/evidence\/[A-Za-z0-9_-]+\/review$/], ["POST", /^\/v1\/channels\/[A-Za-z0-9_-]+\/messages$/],
  ["GET", /^\/v1\/direct-messages\/[A-Za-z0-9_-]+$/], ["POST", /^\/v1\/direct-messages$/],
  // Decisions, information requests, and classes.
  ["POST", /^\/v1\/decisions$/],
  ["GET", /^\/v1\/information-requests$/], ["POST", /^\/v1\/information-requests$/], ["PATCH", /^\/v1\/information-requests\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/v1\/pipelines$/],
  ["GET", /^\/v1\/classes$/], ["GET", /^\/v1\/classes\/[A-Za-z0-9_-]+\/applications$/], ["POST", /^\/v1\/classes\/[A-Za-z0-9_-]+\/applications$/],
  ["PATCH", /^\/v1\/classes\/[A-Za-z0-9_-]+\/applications\/[A-Za-z0-9_-]+\/review$/],
  // Sales (Dealflow Sales connector, /mcp/sales): what the sales tools read and write. The older /v1/opportunities and /v1/pipelines writes are not reachable. Approving plays, brain items and drafts, marking drafts sent or vetoed or discarded,
  // overriding verdicts, deleting leads, delivery work, handling the inbox and the do-not-contact list stay in the app: Claude never approves its own work.
  ["GET", /^\/v1\/sales\/(overview|inbox|drafts|plays|brain|offers|leads|suppression|find-runs|settings|reports|daybreak)$/], ["GET", /^\/v1\/sales\/(leads|offers)\/[A-Za-z0-9_-]+$/], // leads/:id, leads/facets and offers/:id
  // Offers: Claude proposes a new offer or a new draft version (POST /offers); editing, approving, discarding and the offer's state stay in the app.
  ["POST", /^\/v1\/sales\/(leads|plays|brain|offers|find-runs)$/], ["POST", /^\/v1\/sales\/leads\/[A-Za-z0-9_-]+\/(verdicts|drafts|activities|enrich)$/],
  ["PATCH", /^\/v1\/sales\/(leads|drafts)\/[A-Za-z0-9_-]+$/], ["POST", /^\/v1\/sales\/drafts\/[A-Za-z0-9_-]+\/review$/],
  // Calendar: reading, scheduling, and answering invitations (editing and cancelling stay in the app).
  // Venture context and skills, read-only (they are written in the app).
  ["GET", /^\/v1\/ventures\/[A-Za-z0-9_-]+\/context$/], ["GET", /^\/v1\/skills$/], ["GET", /^\/v1\/skills\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/v1\/calendar$/], ["POST", /^\/v1\/calendar\/events$/], ["POST", /^\/v1\/calendar\/events\/[A-Za-z0-9_-]+\/respond$/],
];
export const isMcpRoute = (method: string, path: string) => MCP_ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(path));
