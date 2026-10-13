"use client";

import { useEffect, useState } from "react";
import { listLiveMembers } from "@/lib/studio-api";

/** Each member's @handle (lowercase) and their name. */
export type MentionNames = ReadonlyMap<string, string>;

const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9._-]*)/gi;

/** Loads the people I can see once, so mentions in chat read as names instead of handles. */
export function useMentionNames(): MentionNames {
  const [names, setNames] = useState<MentionNames>(() => new Map());
  useEffect(() => {
    let active = true;
    void (async () => {
      const found = new Map<string, string>();
      try {
        let cursor: string | undefined;
        do {
          const page = await listLiveMembers({ limit: 100, ...(cursor ? { cursor } : {}) });
          for (const item of page.items) if (item.handle) found.set(item.handle.toLowerCase(), item.name);
          cursor = page.nextCursor;
        } while (cursor && active);
      } catch { /* Mentions stay as typed. */ }
      if (active) setNames(found);
    })();
    return () => { active = false; };
  }, []);
  return names;
}

/**
 * The name behind an @handle, and any trailing punctuation that isn't part of the handle
 * ("@ann-lee." at the end of a sentence is Ann Lee plus a full stop).
 */
export function mentionName(handle: string, names: MentionNames): { name: string; rest: string } | null {
  const exact = names.get(handle.toLowerCase());
  if (exact) return { name: exact, rest: "" };
  const trimmed = handle.replace(/[._-]+$/, "");
  const name = trimmed !== handle ? names.get(trimmed.toLowerCase()) : undefined;
  return name ? { name, rest: handle.slice(trimmed.length) } : null;
}

/** Text with each known @handle written as @Name, for one-line previews and copying. */
export function withMentionNames(text: string, names: MentionNames): string {
  return text.replace(MENTION, (all, before: string, handle: string) => {
    const found = mentionName(handle, names);
    return found ? `${before}@${found.name}${found.rest}` : all;
  });
}

/** The known mentions in a text, as [name, handle] pairs. */
export function mentionsIn(text: string, names: MentionNames): Array<[string, string]> {
  return [...text.matchAll(MENTION)].flatMap((match) => {
    const found = mentionName(match[2]!, names);
    return found ? [[found.name, match[2]!.slice(0, match[2]!.length - found.rest.length)] as [string, string]] : [];
  });
}

/** Turns "@Name" mentions picked in the composer back into "@handle" for sending. */
export function withMentionHandles(text: string, chosen: ReadonlyMap<string, string>): string {
  if (!chosen.size) return text;
  // One pass, longest names first (so "@Ann Lee" wins over "@Ann"); an @ inside a word, like an email address, is left alone.
  const names = [...chosen.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`(^|[^\\w@])@(${names.join("|")})(?![\\w])`, "g"), (_all, before: string, name: string) => `${before}@${chosen.get(name)}`);
}
