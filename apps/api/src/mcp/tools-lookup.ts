import { z } from "zod";
import { clip, compact, UNTRUSTED_NOTE } from "./format.js";
import { id, type Look, READ_ONLY, type Register, type ToolContext } from "./kit.js";

/**
 * The two lookups every connector needs: which ventures I can open and who is who. The Venture Studio connector and the Dealflow Sales
 * connector register the same tools (the sales one with a shorter venture listing and wording about leads), so ids are never guessed.
 */
export function registerLookupTools(tool: Register, ctx: ToolContext, look: Look, connector: "studio" | "sales"): void {
  const sales = connector === "sales";

  tool("list_ventures", "ventures:read", {
    title: "List ventures", annotations: READ_ONLY,
    description: sales
      ? "Ventures I can open, with their ids (for the venture filters and ventureId of the sales tools) and my role."
      : "Ventures I can open, with their 30-day goals, groups, and channel ids (for read_channel and filters), plus my role.",
    inputSchema: z.object({}),
  }, async () => {
    const { ventures, role } = await look.ventures();
    return { role, note: UNTRUSTED_NOTE, ventures: [...ventures.values()].map((venture) => compact({
      id: venture.id, name: venture.name, goal: sales ? undefined : clip(venture.goal30Day, 160),
      groups: sales ? undefined : venture.groups.map((group: any) => ({ id: group.id, name: group.name, channels: group.channels.map((channel: any) => ({ id: channel.id, name: channel.name })) })),
      url: sales ? `${ctx.origin}/sales/live/brain?venture=${encodeURIComponent(venture.id)}` : `${ctx.origin}/ventures/live?venture=${encodeURIComponent(venture.id)}`,
    })) };
  });

  tool("find_person", "ventures:read", {
    title: "Find person", annotations: READ_ONLY,
    description: sales
      ? "Look people up by name or @handle (optionally only those in a venture) to get the person id for find_leads' owner filter."
      : "Look people up by name or @handle (optionally only those in a venture or group) to get the person id that create_task, mentions, requests, and messages need.",
    inputSchema: z.object({ query: z.string().trim().min(2).max(80).optional().describe("Part of a name, or @handle for an exact handle"), ventureId: id.optional(), groupId: id.optional(), limit: z.number().int().min(1).max(25).default(10) }),
  }, async ({ query, ventureId, groupId, limit }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (query?.startsWith("@")) params.set("handle", query.slice(1)); else if (query) params.set("q", query);
    if (ventureId) params.set("ventureId", ventureId); if (groupId) params.set("groupId", groupId);
    const page = await ctx.api<{ items: any[] }>("GET", `/members?${params}`);
    return compact({ people: page.items.map((item) => compact({ id: item.id, name: clip(item.name, 120), handle: item.handle ? `@${item.handle}` : undefined, role: item.role, you: item.id === ctx.userId || undefined })), hint: page.items.length ? undefined : "Nobody matches; try part of the name." });
  });
}
