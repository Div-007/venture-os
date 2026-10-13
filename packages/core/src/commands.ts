import { randomUUID } from "node:crypto";
import { commandPreviewSchema, isoDateSchema, type CommandPreview, type ParsedCommand } from "@venture-studio/contracts";
import { hasDeadlineRisk } from "./reminders.js";

export class CommandSyntaxError extends Error {}

function tokens(input: string): Array<{ text: string; quoted: boolean }> {
  const values: Array<{ text: string; quoted: boolean }> = [];
  let end = 0;
  for (const match of input.matchAll(/"([^"]*)"|([^\s"]+)/g)) {
    const gap = input.slice(end, match.index);
    if (values.length ? !/^\s+$/.test(gap) : Boolean(gap.trim())) throw new CommandSyntaxError("Separate command parts with spaces and use matching quotes");
    values.push({ text: match[1] ?? match[2]!, quoted: match[1] !== undefined });
    end = match.index + match[0].length;
  }
  if (input.slice(end).trim()) throw new CommandSyntaxError("Use matching quotes around task details");
  return values;
}

function fields(parts: Array<{ text: string; quoted: boolean }>, allowed: string[]) {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (const part of parts) {
    const index = part.quoted ? -1 : part.text.indexOf("=");
    if (index < 0) { positional.push(part.text); continue; }
    const key = part.text.slice(0, index);
    if (!allowed.includes(key) || options.has(key) || !part.text.slice(index + 1)) throw new CommandSyntaxError(`Invalid or duplicate ${key || "named"} option`);
    options.set(key, part.text.slice(index + 1));
  }
  return { positional, options };
}

function user(value: string | undefined): string {
  if (!value?.startsWith("@") || value.length < 2) throw new CommandSyntaxError("A recipient like @name is required");
  return value.slice(1);
}

function iso(value: string | undefined, field: string, now: Date): string {
  if (!value || !isoDateSchema.safeParse(value).success) throw new CommandSyntaxError(`${field} must be an ISO 8601 date with a timezone offset`);
  const date = new Date(value);
  if (date.getTime() <= now.getTime()) throw new CommandSyntaxError(`${field} must be in the future`);
  return date.toISOString();
}

function minutes(value: string | undefined, field: string, allowBare = false): number {
  const match = value?.match(/^([1-9]\d*)([mh]?)$/);
  const amount = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : NaN;
  if (!match || (!allowBare && !match[2]) || !Number.isSafeInteger(amount) || amount > 100_800) throw new CommandSyntaxError(`${field} must be 1m–100800m (or 1h–1680h)${allowBare ? "; bare numbers mean minutes" : ""}`);
  return amount;
}

export function parseCommand(input: string, now = new Date()): ParsedCommand {
  const parts = tokens(input.trim());
  const recipient = user(parts[1]?.text);
  if (parts[0]?.text === "/assign") {
    const { positional, options } = fields(parts.slice(2), ["due", "estimate", "timezone"]);
    const named = options.has("due") || options.has("estimate");
    if ((named && (positional.length !== 1 || !options.has("due") || !options.has("estimate"))) || (!named && positional.length !== 3) || !positional[0]) throw new CommandSyntaxError("Use /assign @user \"task\" <90m|1h> <ISO deadline> or due=<ISO> estimate=<minutes>");
    const timezone = options.get("timezone") ?? "UTC";
    return { kind: "assign", assignee: recipient, title: positional[0], dueAt: iso(named ? options.get("due") : positional[2], "deadline", now), estimatedMinutes: minutes(named ? options.get("estimate") : positional[1], "estimate", named), timezone };
  }
  if (parts[0]?.text === "/notify") {
    const { positional, options } = fields(parts.slice(2), ["at", "timezone"]);
    const named = options.has("at");
    if ((named && positional.length !== 1) || (!named && positional.length !== 2) || !positional.at(-1)) throw new CommandSyntaxError("Use /notify @user <10m|1h> \"message\" or \"message\" at=<ISO>");
    const timezone = options.get("timezone") ?? "UTC";
    const scheduledAt = named ? iso(options.get("at"), "at", now) : new Date(now.getTime() + minutes(positional[0], "delay") * 60_000).toISOString();
    return { kind: "notify", recipient, message: positional.at(-1)!, scheduledAt, timezone };
  }
  throw new CommandSyntaxError("Supported commands are /assign and /notify");
}

export function previewCommand(input: string, now = new Date()): CommandPreview {
  const command = parseCommand(input, now);
  const warnings: string[] = [];
  if (command.kind === "assign" && hasDeadlineRisk(command.dueAt, command.estimatedMinutes, now)) {
    warnings.push("Estimated effort exceeds the time remaining before the deadline.");
  }
  return commandPreviewSchema.parse({
    previewId: randomUUID(),
    normalizedInput: input.trim().replace(/\s+/g, " "),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    command,
    warnings,
  });
}
