import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ToolError } from "./format.js";
import type { Look, ToolContext } from "./kit.js";

// What every Dealflow Sales tool file shares (tools-sales.ts, tools-offers.ts): the conversation's session (start_sales), and one /v1/sales
// call as the token's owner with plain refusals.

// ---- Sessions: the writer and the reviewer of a draft must be different Claude conversations --------------------------------

export type SessionMode = "work" | "review";
const SESSION_DAYS = 30;

export const sessionField = z.string().trim().min(8).max(128).describe("The sessionId from start_sales for this conversation (one conversation, one sessionId)");

export async function newSession(ctx: ToolContext, mode: SessionMode): Promise<string> {
  const sessions = ctx.db.collection("mcp_sales_sessions");
  const now = new Date();
  // Old sessions are cleared as new ones start (the collection is tiny: one row per sales conversation).
  await sessions.deleteMany({ expiresAt: { $lt: now } }).catch(() => undefined);
  const sessionId = `ses_${randomBytes(12).toString("base64url")}`;
  await sessions.insertOne({ _id: sessionId as never, workspaceId: ctx.workspaceId, userId: ctx.userId, patId: ctx.patId, mode, createdAt: now, expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000) });
  return sessionId;
}

/**
 * The sessionId must be one start_sales gave this person: it makes every sales conversation read the rules first, and stops made-up ids.
 * A conversation declares itself a work session (research, judge, draft) or a review session (only reviews drafts), so the writer and the
 * reviewer of a draft are different sessions by design. Nothing can stop one conversation from starting a second session on purpose:
 * that is self-approval, the tools say so, and a person still approves the first batch of every play.
 */
export async function requireSession(ctx: ToolContext, sessionId: string, mode?: SessionMode): Promise<void> {
  const found = await ctx.db.collection("mcp_sales_sessions").findOne({ _id: sessionId as never, workspaceId: ctx.workspaceId, userId: ctx.userId, expiresAt: { $gt: new Date() } }, { projection: { mode: 1 } });
  if (!found) throw new ToolError("That sessionId isn't one start_sales gave you. Call start_sales once at the start of this conversation and pass the sessionId it returns (one conversation, one sessionId).", 400);
  const has = (found.mode ?? "work") as SessionMode;
  if (mode && has !== mode) {
    throw new ToolError(mode === "review"
      ? "This conversation started as a work session, so it can't review drafts: reviews come from a different conversation. Open a new Claude conversation and call start_sales with mode review there."
      : "This conversation started as a review session, so it only reviews drafts: it can't write drafts, verdicts or proposals, log replies or calls, or change, add or enrich leads. Open a new Claude conversation and call start_sales (mode work) there.", 409);
  }
}

/** The mode a conversation declared with start_sales ("work" or "review"), when its sessionId is known. */
export async function sessionModeOf(ctx: ToolContext, sessionId: string | undefined): Promise<SessionMode | undefined> {
  if (!sessionId) return undefined;
  const found = await ctx.db.collection("mcp_sales_sessions").findOne({ _id: sessionId as never, workspaceId: ctx.workspaceId, userId: ctx.userId }, { projection: { mode: 1 } });
  return found ? ((found.mode ?? "work") as SessionMode) : undefined;
}

// ---- The API --------------------------------------------------------------------------------------------------------------

export type SalesApi = <T = any>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, doing?: string) => Promise<T>;
const roleLabel = (role: string) => role.replaceAll("_", " ");

/** One /v1/sales call as the token's owner. A refusal for role reasons says so plainly; the app's own 404 and 409 messages pass through. */
export function salesApi(ctx: ToolContext, look: Look): SalesApi {
  return async <T = any>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, doing = "do that on this lead"): Promise<T> => {
    try {
      return await ctx.api<T>(method, `/sales${path}`, body);
    } catch (error) {
      if (error instanceof ToolError && error.status === 403 && error.message !== "Not available to Claude connections") {
        const role = (await look.ventures().catch(() => undefined))?.role ?? "unknown";
        throw new ToolError(`You can't ${doing} (your role: ${roleLabel(role)}). ${error.message}`, 403);
      }
      throw error;
    }
  };
}
