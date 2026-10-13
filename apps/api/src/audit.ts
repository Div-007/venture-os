import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { AppDb } from "./db.js";

export type AuditInput = {
  workspaceId: string; actorId: string | null; channel: "api" | "web" | "socket" | "mcp" | "worker" | "engine";
  action: string; objectType: string; objectId?: string; ventureId?: string; result: "success" | "denied" | "validation_failure" | "failure";
  metadata?: Record<string, string | number | boolean | null>;
};

export async function audit(db: AppDb, input: AuditInput, session?: ClientSession): Promise<void> {
  await db.collection("audit_events").insertOne({
    _id: randomUUID(), ...input, metadata: input.metadata ?? {}, occurredAt: new Date(),
  }, { session });
}
