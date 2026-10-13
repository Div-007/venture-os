// Where the company-search keys (TinyFish, Exa) come from for a workspace: a key an admin saved in the app (Sales setup) wins, then the API's
// environment (TINYFISH_API_KEY, EXA_API_KEY). Saved keys sit in sales_search_keys, one document per workspace, encrypted with AES-256-GCM under
// a data key derived from BETTER_AUTH_SECRET (HKDF-SHA256); a fresh IV per save, the auth tag kept, the workspace and engine bound in as
// associated data. A key that no longer decrypts (the secret changed, the record was damaged) reads as unreadable and the environment's key is
// used. Keys are never logged or returned: people see whether one is set, where from, and a saved key's last four characters.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { SalesSearchEngine, SalesSearchKeyStatus, SalesSearchKeys } from "@venture-studio/contracts";
import type { AppDb } from "../db.js";
import type { SearchKeys } from "./search-engines.js";

/** The API's config (or the part of it this needs). Pass the whole config: without BETTER_AUTH_SECRET the keys saved in the app can't be read and only the environment's are used. */
export type SearchKeyEnv = { TINYFISH_API_KEY?: string | undefined; EXA_API_KEY?: string | undefined; BETTER_AUTH_SECRET?: string | undefined };
/** One saved key: the ciphertext, its IV and GCM tag (base64), the format version, and what people may see about it. */
export type StoredSearchKey = { v: number; iv: string; tag: string; data: string; last4: string; setBy: string; setAt: Date };
type StoredKeys = { _id: string; tinyfish?: StoredSearchKey; exa?: StoredSearchKey; updatedAt?: Date };

const COLLECTION = "sales_search_keys";
const VERSION = 1;
const SALT = "vso-sales-search-keys-v1";
const CACHE_MS = 60_000;
const ENGINES: readonly SalesSearchEngine[] = ["tinyfish", "exa"];
const ENV_NAME = { tinyfish: "TINYFISH_API_KEY", exa: "EXA_API_KEY" } as const;

const dataKey = (secret: string) => Buffer.from(hkdfSync("sha256", secret, SALT, "sales search keys: aes-256-gcm", 32));
// The workspace and engine are bound into each ciphertext, so a saved key can't be copied into another workspace's or engine's slot.
const boundTo = (workspaceId: string, engine: SalesSearchEngine) => Buffer.from(`${workspaceId}:${engine}`);
const envKey = (env: SearchKeyEnv, engine: SalesSearchEngine) => env[ENV_NAME[engine]]?.trim() || undefined;

/** Encrypts one key for its workspace and engine, with a fresh 12-byte IV. */
export function sealSearchKey(secret: string, workspaceId: string, engine: SalesSearchEngine, key: string): Pick<StoredSearchKey, "v" | "iv" | "tag" | "data"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(secret), iv);
  cipher.setAAD(boundTo(workspaceId, engine));
  const data = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return { v: VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** The saved key in plain text, or undefined when it can't be read (no secret, another secret, a damaged record, an unknown version). */
function openSearchKey(secret: string | undefined, workspaceId: string, engine: SalesSearchEngine, stored: StoredSearchKey | undefined): string | undefined {
  if (!secret || !stored || stored.v !== VERSION) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey(secret), Buffer.from(stored.iv, "base64"), { authTagLength: 16 });
    decipher.setAAD(boundTo(workspaceId, engine));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8") || undefined;
  } catch { return undefined; }
}

// ---- The 60-second cache of each workspace's saved keys (per database, so separate apps in one process never share it) -------------------

type Slot = { at: number; doc?: StoredKeys | null };
const cache = new WeakMap<AppDb, Map<string, Slot>>();

async function storedKeys(db: AppDb, workspaceId: string): Promise<StoredKeys | null> {
  let slots = cache.get(db);
  if (!slots) { slots = new Map(); cache.set(db, slots); }
  const hit = slots.get(workspaceId);
  if (hit?.doc !== undefined && Date.now() - hit.at < CACHE_MS) return hit.doc;
  const slot: Slot = { at: Date.now() };
  slots.set(workspaceId, slot);
  const doc = await db.collection(COLLECTION).findOne({ _id: workspaceId }) as StoredKeys | null;
  // A save or delete while this read was out dropped the slot: what was read before it is not kept.
  if (slots.get(workspaceId) === slot) slot.doc = doc;
  return doc;
}

/** Drops the cached keys of a workspace in this process: call it after a save or delete has committed. */
export function forgetSearchKeys(db: AppDb, workspaceId: string): void { cache.get(db)?.delete(workspaceId); }

/** The keys search uses for this workspace: a key saved in the app wins, then the environment's. A saved key that can't be read is skipped. */
export async function resolveSearchKeys(db: AppDb, workspaceId: string, env: SearchKeyEnv): Promise<SearchKeys> {
  const stored = await storedKeys(db, workspaceId);
  const pick = (engine: SalesSearchEngine) => openSearchKey(env.BETTER_AUTH_SECRET, workspaceId, engine, stored?.[engine]) ?? envKey(env, engine);
  return { tinyfishKey: pick("tinyfish"), exaKey: pick("exa") };
}

// ---- Saving, removing and the status admins see ---------------------------------------------------------------------------------------

/** Saves (or replaces) one engine's key, encrypted. The caller clears the cache with forgetSearchKeys once the write has committed. */
export async function saveSearchKey(db: AppDb, workspaceId: string, engine: SalesSearchEngine, key: string, secret: string, userId: string, session?: ClientSession): Promise<void> {
  const now = new Date();
  const entry: StoredSearchKey = { ...sealSearchKey(secret, workspaceId, engine, key), last4: key.slice(-4), setBy: userId, setAt: now };
  await db.collection(COLLECTION).updateOne({ _id: workspaceId }, { $set: { [engine]: entry, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true, session });
}

/** Removes one engine's saved key; false when none was saved. The environment's key (if any) is used again. */
export async function removeSearchKey(db: AppDb, workspaceId: string, engine: SalesSearchEngine, session?: ClientSession): Promise<boolean> {
  const result = await db.collection(COLLECTION).updateOne({ _id: workspaceId, [engine]: { $exists: true } }, { $unset: { [engine]: "" }, $set: { updatedAt: new Date() } }, { session });
  return result.modifiedCount > 0;
}

/** Per engine: set or not, where from, and for a saved key its last four characters, when and by whom (read fresh, not cached). Never a key. */
export async function searchKeyStatus(db: AppDb, workspaceId: string, env: SearchKeyEnv): Promise<SalesSearchKeys> {
  const stored = await db.collection(COLLECTION).findOne({ _id: workspaceId }) as StoredKeys | null;
  const setters = [...new Set(ENGINES.flatMap((engine) => typeof stored?.[engine]?.setBy === "string" ? [stored[engine].setBy] : []))];
  const names = new Map(setters.length ? (await db.collection("users").find({ _id: { $in: setters } }, { projection: { name: 1 } }).toArray()).map((user) => [String(user._id), String(user.name ?? "")]) : []);
  const one = (engine: SalesSearchEngine): SalesSearchKeyStatus => {
    const saved = stored?.[engine];
    const who = saved ? { ...(saved.setAt instanceof Date ? { setAt: saved.setAt.toISOString() } : {}), ...(typeof saved.setBy === "string" ? { setBy: saved.setBy, ...(names.get(saved.setBy) ? { setByName: names.get(saved.setBy)! } : {}) } : {}) } : {};
    if (saved && openSearchKey(env.BETTER_AUTH_SECRET, workspaceId, engine, saved) !== undefined) return { set: true, source: "app", last4: String(saved.last4 ?? "").slice(-4), ...who };
    const server = Boolean(envKey(env, engine));
    return { set: server, source: server ? "server" : null, ...(saved ? { unreadable: true, ...who } : {}) };
  };
  return { tinyfish: one("tinyfish"), exa: one("exa") };
}
