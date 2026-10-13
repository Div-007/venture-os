import { randomUUID } from "node:crypto";
import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Database } from "../db.js";
import type { AppConfig } from "../config.js";
import type { Auth } from "../auth.js";
import { AppError } from "../errors.js";
import { audit } from "../audit.js";
import { availableHandle } from "../handles.js";

const claimId = "first-admin";

async function hasRealAdmin(database: Database): Promise<boolean> {
  const admins = await database.db.collection("memberships").find({ role: "admin", status: "active" }).project({ userId: 1 }).toArray();
  if (!admins.length) return false;
  const users = await database.db.collection("users").find({ _id: { $in: admins.map((item) => item.userId) } }).project({ email: 1 }).toArray();
  // The development seed contains only example.invalid identities, never login-capable accounts.
  return users.some((user) => typeof user.email === "string" && !user.email.toLowerCase().endsWith("@example.invalid"));
}

async function isAvailable(database: Database, config: AppConfig): Promise<boolean> {
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !database.transactions) return false;
  if (await database.db.collection("installation_setup").findOne({ _id: claimId })) return false;
  return !await hasRealAdmin(database);
}

export function firstAdminRoutes(database: Database, config: AppConfig, auth: Auth): Router {
  const router = Router();

  router.get("/setup/first-admin", async (_req, res) => {
    const complete = Boolean(await database.db.collection("installation_setup").findOne({ _id: claimId })) || await hasRealAdmin(database);
    res.json({ ok: true, data: { available: await isAvailable(database, config), complete, configured: Boolean(config.BOOTSTRAP_ADMIN_EMAIL && database.transactions), emailDeliveryReady: Boolean(config.RESEND_API_KEY) } });
  });

  router.post("/setup/first-admin", async (req, res) => {
    if (req.headers.origin !== new URL(config.APP_ORIGIN).origin) throw new AppError(403, "FORBIDDEN", "Invalid signup origin");
    if (!await isAvailable(database, config)) throw new AppError(409, "CONFLICT", "First-admin signup is unavailable");
    // Do not use the local x-dev-user-id fallback: only a real verified Better Auth session can claim setup.
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    const identity = session?.user;
    if (!identity) throw new AppError(401, "UNAUTHENTICATED", "Verify your email before completing signup");
    if (!identity.emailVerified || identity.email.toLowerCase() !== config.BOOTSTRAP_ADMIN_EMAIL!.toLowerCase()) throw new AppError(403, "FORBIDDEN", "This email is not authorized for first-admin signup");
    const now = new Date();
    let workspaceId = "";
    await database.client.withSession(async (mongoSession) => mongoSession.withTransaction(async () => {
      if (await database.db.collection("installation_setup").findOne({ _id: claimId }, { session: mongoSession })) throw new AppError(409, "CONFLICT", "First-admin signup has already been completed");
      // A real admin might have been provisioned through another process since the status check.
      if (await hasRealAdmin(database)) throw new AppError(409, "CONFLICT", "An admin already exists");
      const activeMembership = await database.db.collection("memberships").findOne({ userId: identity.id, status: "active" }, { session: mongoSession });
      if (activeMembership) throw new AppError(409, "CONFLICT", "This account already belongs to a workspace");
      const workspaces = await database.db.collection("workspaces").find({}, { session: mongoSession }).limit(2).toArray();
      if (workspaces.length > 1) throw new AppError(409, "CONFLICT", "Choose a workspace through an administrator");
      workspaceId = workspaces.length ? String(workspaces[0]!._id) : randomUUID();
      if (!workspaces.length) await database.db.collection("workspaces").insertOne({ _id: workspaceId, name: "Venture Studio", slug: "venture-studio", createdAt: now }, { session: mongoSession });
      const existingUsers = await database.db.collection("users").find({ workspaceId }, { projection: { handle: 1 }, session: mongoSession }).toArray();
      const usedHandles = new Set(existingUsers.map((user) => String(user.handle ?? "").toLowerCase()).filter(Boolean));
      const handle = availableHandle(identity.name || "admin", identity.id, usedHandles);
      await database.db.collection("users").updateOne({ _id: identity.id }, { $set: { workspaceId, email: identity.email, name: identity.name, handle, status: "active", updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true, session: mongoSession });
      await database.db.collection("memberships").insertOne({ _id: randomUUID(), workspaceId, userId: identity.id, role: "admin", ventureIds: [], groupIds: [], inheritedVentureIds: [], status: "active", createdAt: now, updatedAt: now }, { session: mongoSession });
      await database.db.collection("installation_setup").insertOne({ _id: claimId, workspaceId, userId: identity.id, claimedAt: now }, { session: mongoSession });
      await audit(database.db, { workspaceId, actorId: identity.id, channel: "api", action: "first_admin.claim", objectType: "workspace", objectId: workspaceId, result: "success" }, mongoSession);
    }));
    res.status(201).json({ ok: true, data: { created: true, workspaceId } });
  });

  return router;
}
