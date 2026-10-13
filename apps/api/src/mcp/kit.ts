import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema } from "@venture-studio/contracts";
import type { AppDb } from "../db.js";
import type { SearchKeys } from "../sales/search-engines.js";
import { type Api, clip, compact, localTime, ToolError } from "./format.js";

export type ToolContext = {
  api: Api; db: AppDb; userId: string; workspaceId: string; patId: string; scopes: Set<string>;
  writesEnabled: boolean; origin: string;
  /** Throws when this token has used up its write budget. */
  writeBudget: () => Promise<void>;
  /** Throws when this token calls `tool` more than `perMinute` times in a minute (for tools that notify people). */
  toolBudget: (tool: string, perMinute: number) => Promise<void>;
  /** Counts bytes uploaded through Claude against the person's daily allowance; throws once it is used up. */
  uploadBudget: (bytes: number) => Promise<void>;
  /** Keys for the company search of the Dealflow Sales connector, read per call: saved in the app by an admin, else the API's environment. A missing key switches that engine off; never logged or returned. */
  searchKeys?: () => Promise<SearchKeys>;
};

export const OPEN = (status: unknown) => status !== "done" && status !== "cancelled";

/** Name lookups shared by the tools in one request: ventures, groups, channels (from the session) and people. */
export function lookups(ctx: ToolContext) {
  let session: Promise<any> | undefined; let people: Promise<Map<string, string>> | undefined;
  const loadSession = () => (session ??= ctx.api("GET", "/session/bootstrap"));
  return {
    session: loadSession,
    async ventures() {
      const data = await loadSession();
      const ventures = new Map<string, any>(); const groups = new Map<string, any>(); const channels = new Map<string, any>();
      for (const venture of data.hierarchy.ventures) {
        ventures.set(venture.id, venture);
        for (const group of venture.groups) { groups.set(group.id, { ...group, ventureId: venture.id }); for (const channel of group.channels) channels.set(channel.id, { ...channel, ventureId: venture.id, groupName: group.name }); }
      }
      return { ventures, groups, channels, role: data.membership.role as string, me: data.user as { id: string; name: string } };
    },
    async person(id: unknown): Promise<string | undefined> {
      if (typeof id !== "string") return undefined;
      people ??= ctx.api<{ items: { id: string; name: string }[] }>("GET", "/members?limit=100").then((page) => new Map(page.items.map((item) => [item.id, item.name])), () => new Map());
      return (await people).get(id) ?? (id === ctx.userId ? "you" : undefined);
    },
  };
}

export const taskLink = (ctx: ToolContext, id: string) => `${ctx.origin}/tasks/live?task=${encodeURIComponent(id)}`;

export async function taskRow(ctx: ToolContext, look: ReturnType<typeof lookups>, task: any, timeZone: string, extra: Record<string, unknown> = {}) {
  const { ventures } = await look.ventures();
  return compact({ id: task.id, title: clip(task.title, 140), status: task.status, priority: task.priority, due: localTime(task.dueAt, timeZone), venture: ventures.get(task.ventureId)?.name, blocker: clip(task.blocker, 160), ...extra, url: taskLink(ctx, task.id) });
}

/**
 * Runs a non-idempotent write once per requestId. The claim is stored before the write, so concurrent retries can't both
 * write; a retry returns the first result, and reusing the id for different arguments is refused.
 */
export async function once(ctx: ToolContext, tool: string, requestId: string, args: unknown, run: () => Promise<unknown>) {
  const executions = ctx.db.collection("mcp_executions");
  const key = createHash("sha256").update(`${ctx.workspaceId}:${ctx.userId}:${tool}:${requestId}`).digest("hex");
  const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  try {
    await executions.insertOne({ _id: key as never, workspaceId: ctx.workspaceId, userId: ctx.userId, tool, argsHash, state: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000) });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const previous = await executions.findOne({ _id: key as never });
    if (previous?.argsHash !== argsHash) throw new ToolError("This requestId was already used for a different change; use a new requestId.", 409);
    if (previous.state === "done") return { ...(previous.result as object), replayed: true };
    const recent = previous.state === "pending" && Date.now() - new Date(previous.createdAt).getTime() < 60_000;
    throw new ToolError(recent ? "This change is still being made; check again in a moment before retrying." : "An earlier attempt with this requestId may or may not have gone through; check before trying again with a new requestId.", 409);
  }
  try {
    const value = await run();
    await executions.updateOne({ _id: key as never }, { $set: { state: "done", result: value } });
    return value;
  } catch (error) {
    // The app refusing means nothing changed, so the same requestId stays usable; a timeout or crash leaves the outcome unknown.
    const refused = error instanceof ToolError && error.status >= 400 && error.status < 500 && error.status !== 408;
    await (refused ? executions.deleteOne({ _id: key as never }) : executions.updateOne({ _id: key as never }, { $set: { state: "unknown" } })).catch(() => undefined);
    throw error;
  }
}

export const requestIdField = z.string().trim().min(8).max(100).describe("Any unique string for this change (e.g. a UUID); reuse it when retrying so the change happens only once");
export const id = idSchema;
export const timezoneField = z.string().max(60).optional().describe("IANA time zone for times, e.g. Asia/Kolkata (default UTC)");

export type Look = ReturnType<typeof lookups>;
export type ToolConfig = { title: string; description: string; inputSchema: z.ZodObject<any>; annotations: Record<string, boolean> };
/** Registers one tool when the token holds its scopes (see registerTools). */
export type Register = (name: string, scope: string | string[], config: ToolConfig, handler: (input: any) => Promise<unknown>) => void;
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const writes = (idempotent: boolean) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });
/** An ISO 8601 time with its offset, the form the app stores. */
export const isoField = (description: string) => z.iso.datetime({ offset: true }).describe(description);
