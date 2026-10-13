import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { atomic } from "./db.js";
import { audit } from "./audit.js";
import { slug } from "./json.js";

export function availableHandle(name: string, id: string, used: Set<string>): string {
  const base = slug(name).slice(0, 40) || "member";
  if (!used.has(base)) { used.add(base); return base; }
  const digest = createHash("sha256").update(id).digest("hex");
  for (let length = 8; length <= 32; length += 4) {
    const candidate = `${base}-${digest.slice(0, length)}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  for (let suffix = 2; ; suffix++) {
    const tail = `${digest.slice(0, 32)}-${suffix}`;
    const candidate = `${base.slice(0, 79 - tail.length)}-${tail}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

export async function backfillMissingHandles(database: Database, preferred: Record<string, string> = {}): Promise<number> {
  const users = await database.db.collection("users").find({ workspaceId: { $type: "string" } }).project({ _id: 1, workspaceId: 1, name: 1, handle: 1 }).sort({ workspaceId: 1, _id: 1 }).toArray();
  const usedByWorkspace = new Map<string, Set<string>>();
  for (const user of users) {
    const used = usedByWorkspace.get(String(user.workspaceId)) ?? new Set<string>();
    usedByWorkspace.set(String(user.workspaceId), used);
    if (typeof user.handle === "string" && user.handle.trim()) used.add(user.handle.toLowerCase());
  }
  let changed = 0;
  for (const user of users) {
    if (typeof user.handle === "string" && user.handle.trim()) continue;
    const workspaceId = String(user.workspaceId);
    const handle = availableHandle(preferred[String(user._id)] ?? String(user.name ?? ""), String(user._id), usedByWorkspace.get(workspaceId)!);
    await atomic(database, async (session) => {
      const result = await database.db.collection("users").updateOne({ _id: user._id, workspaceId, handle: user.handle ?? null }, { $set: { handle, updatedAt: new Date() } }, { session });
      if (result.modifiedCount !== 1) throw new Error(`User handle changed concurrently: ${user._id}`);
      await audit(database.db, { workspaceId, actorId: null, channel: "worker", action: "user.handle.backfill", objectType: "user", objectId: String(user._id), result: "success", metadata: { handle } }, session);
    });
    changed++;
  }
  return changed;
}
