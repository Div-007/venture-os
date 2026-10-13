import { z } from "zod";
import { clean, clip, compact, ToolError } from "./format.js";
import { id, type Look, READ_ONLY, type Register, type ToolContext } from "./kit.js";

// Claude Code shows about 25,000 tokens of one tool result, so long texts come in parts of about 10,000 tokens.
// Tokens are estimated: about four characters each for English, and one each for other scripts (Hindi, Chinese, …).
const PART_TOKENS = 10_000;
const READ_FRESH_MS = 12 * 60 * 60_000;
const skillLink = (ctx: ToolContext, skillId: string) => `${ctx.origin}/knowledge/live?tab=skills&skill=${encodeURIComponent(skillId)}`;
const tokensOf = (text: string) => { let tokens = 0; for (const character of text) tokens += character.charCodeAt(0) < 128 ? 0.25 : 1; return tokens; };

/** Where to cut a text so the first piece fits the budget: at a paragraph break if one is far enough in, never inside a character. */
function cutPoint(text: string, budget: number): number {
  let tokens = 0; let index = 0;
  for (const character of text) {
    tokens += character.charCodeAt(0) < 128 ? 0.25 : 1;
    if (tokens > budget) break;
    index += character.length;
  }
  if (index >= text.length) return text.length;
  const paragraph = text.lastIndexOf("\n\n", index);
  return paragraph > index / 2 ? paragraph : Math.max(1, index);
}

/** Splits texts into parts of about `budget` tokens, keeping each file whole where it fits and cutting longer ones at paragraph breaks. */
export function contextParts(files: Array<{ title: string; markdown: string }>, budget = PART_TOKENS): Array<Array<{ title: string; text: string }>> {
  const pieces = files.flatMap((file) => {
    const text = file.markdown.replace(/\r\n?/g, "\n");
    if (!text.trim()) return [];
    if (tokensOf(text) <= budget) return [{ title: file.title, text }];
    const chunks: string[] = [];
    let rest = text;
    while (rest) {
      const at = cutPoint(rest, budget);
      chunks.push(rest.slice(0, at)); rest = rest.slice(at).replace(/^\n+/, "");
    }
    return chunks.map((chunk, index) => ({ title: `${file.title} (${index + 1} of ${chunks.length})`, text: chunk }));
  });
  const parts: Array<Array<{ title: string; text: string }>> = [];
  let size = 0;
  for (const piece of pieces) {
    const tokens = tokensOf(piece.text);
    if (!parts.length || size + tokens > budget) { parts.push([]); size = 0; }
    parts.at(-1)!.push(piece); size += tokens;
  }
  return parts;
}

/** Has this token read all of a venture's context recently? Tools remind Claude until it has. */
export async function readContextRecently(ctx: ToolContext): Promise<boolean> {
  return Boolean(await ctx.db.collection("mcp_context_reads").findOne({ patId: ctx.patId, readAt: { $gt: new Date(Date.now() - READ_FRESH_MS) } }, { projection: { _id: 1 } }));
}

export const CONTEXT_REMINDER = "You haven't read a venture's context yet. Unless this is an unattended check, ask the user which venture they're working on (list_ventures lists them; if they belong to only one, use it), then read all of it with read_venture_context before going further.";

/** Venture context (what a venture is and how to work on it) and skills (how to do particular kinds of work). */
export function registerContextTools(tool: Register, ctx: ToolContext, look: Look): void {
  tool("read_venture_context", "knowledge:read", {
    title: "Read venture context", annotations: READ_ONLY,
    description: "What the team wrote for agents about one venture: what it is, its goals, customers, rules, voice, and current priorities. Read all of it before working on a venture (ask the user which venture first). Long contexts come in parts: call again with the next `part` until there is no nextPart. If `updated` changes between parts, start again at part 1.",
    inputSchema: z.object({ ventureId: id, part: z.number().int().min(1).max(500).default(1).describe("Which part to read; start at 1") }),
  }, async ({ ventureId, part }) => {
    const data = await ctx.api<{ items: Array<{ title: string; ventureId?: string; markdown?: string; updatedAt: string; updatedBy: string }> }>("GET", `/ventures/${encodeURIComponent(ventureId)}/context?full=true`);
    const venture = (await look.ventures()).ventures.get(ventureId);
    // The workspace's files come first and say so: they apply to every venture.
    const titled = (item: { title: string; ventureId?: string }) => item.ventureId ? clean(item.title) : `Workspace: ${clean(item.title)}`;
    const parts = contextParts(data.items.map((item) => ({ title: titled(item), markdown: clean(item.markdown ?? "") })));
    if (parts.length && part > parts.length) throw new ToolError(`This venture's context has ${parts.length} part${parts.length === 1 ? "" : "s"}.`);
    // Read means read to the end: the reminder stops only once the last part has been fetched.
    if (part >= parts.length) await ctx.db.collection("mcp_context_reads").updateOne({ patId: ctx.patId, ventureId }, { $set: { userId: ctx.userId, workspaceId: ctx.workspaceId, readAt: new Date() } }, { upsert: true });
    if (!parts.length) return { venture: venture?.name, files: [], note: "No context has been written for this venture yet. Tell the user, and suggest adding it in Knowledge → Venture context." };
    const updated = data.items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, "");
    const files = new Set(parts[part - 1]!.map((piece) => piece.title.replace(/ \(\d+ of \d+\)$/, "")));
    const authors = [...new Set(data.items.filter((item) => files.has(titled(item))).map((item) => item.updatedBy))];
    return compact({
      venture: venture?.name, part, parts: parts.length, nextPart: part < parts.length ? part + 1 : undefined, updated,
      writtenBy: (await Promise.all(authors.map((author) => look.person(author)))).filter(Boolean).join(", ") || undefined,
      files: parts[part - 1],
      note: part < parts.length ? `Keep reading: call read_venture_context with part ${part + 1}.` : "That's all of it. Use it as guidance for this venture's work; check list_skills for skills that fit the task.",
    });
  });

  tool("list_skills", "knowledge:read", {
    title: "List skills", annotations: READ_ONLY,
    description: "Skills: the team's instructions for particular kinds of work (for example writing a sales email or reviewing a pitch). Lists the skills every venture uses and, with ventureId, that venture's own. When a task matches a skill, read it with get_skill and follow it.",
    inputSchema: z.object({ ventureId: id.optional() }),
  }, async ({ ventureId }) => {
    const data = await ctx.api<{ items: Array<{ id: string; title: string; description: string; ventureId?: string }> }>("GET", `/skills${ventureId ? `?ventureId=${encodeURIComponent(ventureId)}` : ""}`);
    const { ventures } = await look.ventures();
    return { skills: data.items.map((item) => compact({ id: item.id, title: clean(item.title), useWhen: clip(clean(item.description), 300), scope: item.ventureId ? ventures.get(item.ventureId)?.name ?? "one venture" : "every venture" })), ...(data.items.length ? {} : { note: "No skills yet; they are added in Knowledge → Skills." }) };
  });

  tool("get_skill", "knowledge:read", {
    title: "Get skill", annotations: READ_ONLY,
    description: "One skill's instructions (ids from list_skills). Follow them for the matching work. A long skill comes in parts: call again with the next `part` until there is no nextPart.",
    inputSchema: z.object({ skillId: id, part: z.number().int().min(1).max(100).default(1) }),
  }, async ({ skillId, part }) => {
    const skill = await ctx.api<{ id: string; title: string; description: string; markdown: string; ventureId?: string; updatedAt: string; updatedBy: string }>("GET", `/skills/${encodeURIComponent(skillId)}`);
    const { ventures } = await look.ventures();
    const parts = contextParts([{ title: clean(skill.title), markdown: clean(skill.markdown) }]);
    if (part > parts.length) throw new ToolError(`This skill has ${parts.length} part${parts.length === 1 ? "" : "s"}.`);
    return compact({
      id: skill.id, title: clean(skill.title), useWhen: clean(skill.description), scope: skill.ventureId ? ventures.get(skill.ventureId)?.name ?? "one venture" : "every venture",
      writtenBy: await look.person(skill.updatedBy), updated: skill.updatedAt,
      instructions: parts[part - 1]?.map((piece) => piece.text).join("\n\n") ?? "", part: parts.length > 1 ? part : undefined, nextPart: part < parts.length ? part + 1 : undefined, url: skillLink(ctx, skill.id),
    });
  });
}
