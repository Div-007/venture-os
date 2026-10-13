import { z } from "zod";
import { idSchema, isoDateSchema } from "./common.js";

// The company-search keys (TinyFish, Exa) an admin saves in Sales setup. The API never returns a key: only whether one is set, where it
// comes from (saved in the app, or the server's environment) and, for a key saved in the app, its last four characters, when and by whom.

export const SALES_SEARCH_ENGINES = ["tinyfish", "exa"] as const;
export const salesSearchEngineSchema = z.enum(SALES_SEARCH_ENGINES);
export type SalesSearchEngine = z.infer<typeof salesSearchEngineSchema>;

/** A key as pasted: trimmed, 10 to 300 characters, with no spaces or line breaks inside. */
export const salesSearchKeyInputSchema = z.object({
  key: z.string().trim().min(10, "A key is at least 10 characters").max(300, "A key is at most 300 characters").regex(/^\S+$/, "A key has no spaces or line breaks in it"),
});
export type SalesSearchKeyInput = z.infer<typeof salesSearchKeyInputSchema>;

/** One engine: `source` "app" is a key saved here (it wins), "server" the API's environment. `unreadable` is a saved key that can't be decrypted any more (enter it again). */
export const salesSearchKeyStatusSchema = z.object({
  set: z.boolean(), source: z.enum(["app", "server"]).nullable(),
  last4: z.string().max(4).optional(), setAt: isoDateSchema.optional(), setBy: idSchema.optional(), setByName: z.string().max(200).optional(), unreadable: z.boolean().optional(),
});
export type SalesSearchKeyStatus = z.infer<typeof salesSearchKeyStatusSchema>;
export const salesSearchKeysSchema = z.object({ tinyfish: salesSearchKeyStatusSchema, exa: salesSearchKeyStatusSchema });
export type SalesSearchKeys = z.infer<typeof salesSearchKeysSchema>;

/** What one small test search with the key in use said: it worked, or a short message that carries no part of the key. */
export const salesSearchKeyTestSchema = z.object({ ok: z.boolean(), message: z.string().max(300).optional() });
export type SalesSearchKeyTest = z.infer<typeof salesSearchKeyTestSchema>;
