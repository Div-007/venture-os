import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ClientSession } from "mongodb";
import { z } from "zod";
import type { AppDb, Database } from "../db.js";
import { atomic } from "../db.js";
import type { AppConfig } from "../config.js";
import { sendInvitationEmail } from "../auth.js";
import { appRoleSchema, createChannelSchema, idSchema, updateMembershipSchema, updateVentureSchema } from "@venture-studio/contracts";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue, slug } from "../json.js";
import { inArchivedVenture } from "../archive-scope.js";

// allGroupVentureIds: invited ventures where they get every group, including ones created later (see allGroupsIn).
const inviteSchema = z.object({ email: z.email(), role: appRoleSchema, ventureIds: z.array(idSchema), groupIds: z.array(idSchema), allGroupVentureIds: z.array(idSchema).max(100).default([]) });
const ventureSchema = z.object({ name: z.string().trim().min(1).max(120), ownerId: idSchema, goal30Day: z.string().trim().max(500).default("") });
const groupSchema = z.object({ ventureId: idSchema, name: z.string().trim().min(1).max(120) });
// Unique indexes compare names exactly; reject case-only duplicates ("Alpha" vs "alpha") explicitly.
const caseInsensitive = { locale: "en", strength: 2 } as const;
const allGroupsScopeValid = (ventureIds: string[], allGroupVentureIds: string[]) => new Set(allGroupVentureIds).size === allGroupVentureIds.length && allGroupVentureIds.every((id) => ventureIds.includes(id));

/**
 * Every group now in the given ventures, for a member who gets all of them. Call it inside the transaction that saves the
 * membership: it bumps each venture's groupsRevision first, as group creation does, so a group created at the same moment
 * either shows up here or forces one of the two transactions to retry. The member can never miss a new group.
 */
async function allGroupsIn(db: AppDb, workspaceId: string, ventureIds: string[], session?: ClientSession): Promise<{ id: string; ventureId: string }[]> {
  if (!ventureIds.length) return [];
  const bumped = await db.collection("ventures").updateMany({ _id: { $in: ventureIds }, workspaceId }, { $inc: { groupsRevision: 1 } }, { session });
  if (bumped.matchedCount !== ventureIds.length) throw new AppError(409, "CONFLICT", "A venture changed while access was being saved; please try again");
  const groups = await db.collection("groups").find({ workspaceId, ventureId: { $in: ventureIds } }, { projection: { ventureId: 1 }, session }).toArray();
  return groups.map((group) => ({ id: String(group._id), ventureId: String(group.ventureId) }));
}

export function adminRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();
  router.post("/admin/invitations", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may invite members");
    const input = inviteSchema.parse(req.body);
    const ventureDocs = await db.collection("ventures").find({ _id: { $in: input.ventureIds }, workspaceId: actor.membership.workspaceId, status: { $ne: "archived" } }, { projection: { name: 1 } }).toArray();
    if (ventureDocs.length !== input.ventureIds.length) throw new AppError(400, "BAD_REQUEST", "Every invited venture must exist in this workspace and not be archived");
    const groups = await db.collection("groups").find({ _id: { $in: input.groupIds }, workspaceId: actor.membership.workspaceId }).toArray();
    if (groups.length !== input.groupIds.length || groups.some((group) => !input.ventureIds.includes(String(group.ventureId)))) throw new AppError(400, "BAD_REQUEST", "Every invited group must belong to an invited venture");
    if (!allGroupsScopeValid(input.ventureIds, input.allGroupVentureIds)) throw new AppError(400, "BAD_REQUEST", "All-groups access must name each invited venture at most once");
    const email = input.email.toLowerCase();
    const currentUser = await db.collection("users").findOne({ workspaceId: actor.membership.workspaceId, email, status: "active" });
    if (currentUser && await db.collection("memberships").findOne({ workspaceId: actor.membership.workspaceId, userId: currentUser._id, status: "active" })) throw new AppError(409, "CONFLICT", "This person is already a workspace member; use membership management instead");
    // Looked up before the invitation is saved, so a failure here leaves nothing half-sent.
    const workspace = await db.collection("workspaces").findOne({ _id: actor.membership.workspaceId }, { projection: { name: 1 } });
    const token = randomBytes(32).toString("base64url");
    const manual = !config.RESEND_API_KEY;
    const invite = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...input, email, tokenHash: createHash("sha256").update(token).digest("hex"), status: "pending", delivery: { mode: manual ? "manual" : "email", status: manual ? "not_sent" : "sending" }, invitedBy: actor.id, expiresAt: new Date(Date.now() + 7 * 86_400_000), createdAt: new Date() };
    const safeInvite = { id: invite._id, workspaceId: invite.workspaceId, email, role: invite.role, ventureIds: invite.ventureIds, groupIds: invite.groupIds, allGroupVentureIds: invite.allGroupVentureIds, expiresAt: invite.expiresAt, status: "pending" };
    if (manual) {
      await atomic(database, async (session) => {
        await db.collection("invitations").insertOne(invite, { session });
        await audit(db, { workspaceId: invite.workspaceId, actorId: actor.id, channel: "api", action: "invitation.create", objectType: "invitation", objectId: invite._id, result: "success" }, session);
      });
      res.status(201).json({ ok: true, data: { invitation: jsonValue(safeInvite), token, delivery: { mode: "manual", status: "not_sent" } } });
      return;
    }
    await db.collection("invitations").insertOne(invite);
    const link = new URL("/invite/live", config.APP_ORIGIN);
    link.searchParams.set("token", token);
    let providerId: string;
    // The email names who invited them and exactly what they get, in the order the admin picked.
    const ventureName = (id: unknown) => String(ventureDocs.find((venture) => venture._id === id)?.name ?? "Venture");
    const groupLines = input.ventureIds.flatMap((id) => input.allGroupVentureIds.includes(id) ? [`All groups in ${ventureName(id)}`] : groups.filter((group) => group.ventureId === id).map((group) => `${ventureName(id)} · ${String(group.name)}`));
    const details = { inviterName: actor.name || actor.email, workspaceName: String(workspace?.name ?? "Venture Studio"), role: input.role, ventures: input.ventureIds.map(ventureName), groups: groupLines, url: link.toString(), expiresAt: invite.expiresAt };
    try { providerId = await sendInvitationEmail(config, email, invite._id, details); }
    catch {
      // A timeout is ambiguous: Resend may have delivered the message. Keep its link usable.
      await db.collection("invitations").updateOne({ _id: invite._id, status: "pending" }, { $set: { "delivery.status": "unconfirmed", updatedAt: new Date() } });
      await audit(db, { workspaceId: invite.workspaceId, actorId: actor.id, channel: "api", action: "invitation.deliver", objectType: "invitation", objectId: invite._id, result: "failure" });
      throw new AppError(503, "INTEGRATION_UNAVAILABLE", "Invitation email was not confirmed; please retry");
    }
    await atomic(database, async (session) => {
      const sent = await db.collection("invitations").updateOne({ _id: invite._id, status: "pending" }, { $set: { "delivery.status": "sent", "delivery.providerId": providerId, "delivery.sentAt": new Date(), updatedAt: new Date() } }, { session });
      if (!sent.matchedCount) throw new AppError(409, "CONFLICT", "Invitation state changed before delivery confirmation");
      // Concurrently delivered links remain valid until one is accepted.
      await audit(db, { workspaceId: invite.workspaceId, actorId: actor.id, channel: "api", action: "invitation.deliver", objectType: "invitation", objectId: invite._id, result: "success" }, session);
    });
    res.status(201).json({ ok: true, data: { invitation: jsonValue(safeInvite), delivery: { mode: "email", status: "sent" } } });
  });
  router.post("/admin/ventures", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may create ventures");
    const input = ventureSchema.parse(req.body); const now = new Date(); const id = randomUUID();
    if (await db.collection("ventures").findOne({ workspaceId: actor.membership.workspaceId, name: input.name }, { collation: caseInsensitive })) throw new AppError(409, "CONFLICT", "A venture with this name already exists");
    const venture = { _id: id, workspaceId: actor.membership.workspaceId, ...input, slug: slug(input.name), status: "active", createdAt: now, updatedAt: now };
    await db.collection("ventures").insertOne(venture);
    res.status(201).json({ ok: true, data: jsonValue(venture) });
  });
  // The 30-day goal changes as a venture moves on, so an admin or that venture's own head can rewrite it.
  router.patch("/ventures/:ventureId", async (req, res) => {
    const actor = req.actor!;
    const ventureId = idSchema.parse(req.params.ventureId);
    const { workspaceId, role, ventureIds } = actor.membership;
    if (role !== "admin" && !(role === "venture_head" && ventureIds.includes(ventureId))) throw new AppError(403, "FORBIDDEN", "Only an admin or this venture's head may edit its goal");
    const input = updateVentureSchema.parse(req.body);
    const venture = await atomic(database, async (session) => {
      const updated = await db.collection("ventures").findOneAndUpdate({ _id: ventureId, workspaceId, status: { $ne: "archived" } }, { $set: { goal30Day: input.goal30Day, updatedAt: new Date() } }, { returnDocument: "after", session });
      if (!updated) throw new AppError(404, "NOT_FOUND", "Venture not found");
      await audit(db, { workspaceId, ventureId, actorId: actor.id, channel: "api", action: "venture.goal.update", objectType: "venture", objectId: ventureId, result: "success", metadata: { cleared: input.goal30Day === "" } }, session);
      return updated;
    });
    res.json({ ok: true, data: jsonValue(venture) });
  });
  router.post("/admin/groups", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may create groups");
    const input = groupSchema.parse(req.body); const venture = await db.collection("ventures").findOne({ _id: input.ventureId, workspaceId: actor.membership.workspaceId, status: { $ne: "archived" } });
    if (!venture) throw new AppError(404, "NOT_FOUND", "Venture not found");
    if (await db.collection("groups").findOne({ workspaceId: actor.membership.workspaceId, ventureId: input.ventureId, name: input.name }, { collation: caseInsensitive })) throw new AppError(409, "CONFLICT", "A group with this name already exists in this venture");
    const now = new Date(); const groupId = randomUUID(); const channelId = randomUUID();
    const group = { _id: groupId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId, name: input.name, createdAt: now };
    const channel = { _id: channelId, workspaceId: actor.membership.workspaceId, ventureId: input.ventureId, groupId, name: "general", createdAt: now };
    try { await atomic(database, async (session) => {
      // Bumped first so this conflicts with a membership being saved with all of this venture's groups (see allGroupsIn).
      // It also re-checks the venture, which may have been archived or deleted since the lookup above.
      const bumped = await db.collection("ventures").updateOne({ _id: input.ventureId, workspaceId: actor.membership.workspaceId, status: { $ne: "archived" } }, { $inc: { groupsRevision: 1 } }, { session });
      if (!bumped.matchedCount) throw new AppError(404, "NOT_FOUND", "Venture not found");
      await db.collection("groups").insertOne(group, { session });
      await db.collection("channels").insertOne(channel, { session });
      // Members who have every group in this venture get the new one straight away.
      const added = await db.collection("memberships").updateMany({ workspaceId: actor.membership.workspaceId, allGroupVentureIds: input.ventureId }, { $addToSet: { groupIds: groupId }, $set: { updatedAt: now } }, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "group.create", objectType: "group", objectId: groupId, ventureId: input.ventureId, result: "success", metadata: { membersAdded: added.modifiedCount } }, session);
    }); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new AppError(409, "CONFLICT", "A group with this name already exists in this venture"); throw error; }
    res.status(201).json({ ok: true, data: jsonValue({ ...group, channels: [channel] }) });
  });
  router.post("/admin/channels", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may create channels");
    const input = createChannelSchema.parse(req.body);
    const group = await db.collection("groups").findOne({ _id: input.groupId, workspaceId: actor.membership.workspaceId });
    if (!group || inArchivedVenture(actor.membership, group.ventureId)) throw new AppError(404, "NOT_FOUND", "Group not found");
    const name = slug(input.name);
    if (!name || name.length > 80) throw new AppError(400, "BAD_REQUEST", "Channel name must produce a valid slug of at most 80 characters");
    const channel = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ventureId: group.ventureId, groupId: input.groupId, name, createdAt: new Date() };
    try { await atomic(database, async (session) => {
      await db.collection("channels").insertOne(channel, { session });
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "channel.create", objectType: "channel", objectId: channel._id, ventureId: String(group.ventureId), result: "success" }, session);
    }); }
    catch (error) { if ((error as { code?: number }).code === 11000) throw new AppError(409, "CONFLICT", "Channel name already exists in this group"); throw error; }
    res.status(201).json({ ok: true, data: jsonValue(channel) });
  });
  router.get("/admin/memberships", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may list memberships");
    res.json({ ok: true, data: jsonValue(await db.collection("memberships").find({ workspaceId: actor.membership.workspaceId }).toArray()) });
  });
  router.put("/admin/memberships/:id", async (req, res) => {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only admins may change memberships");
    const id = idSchema.parse(req.params.id);
    const input = updateMembershipSchema.parse(req.body);
    const current = await db.collection("memberships").findOne({ _id: id, workspaceId: actor.membership.workspaceId, status: "active" });
    if (!current) throw new AppError(404, "NOT_FOUND", "Active membership not found");
    if (current.userId === actor.id) throw new AppError(403, "FORBIDDEN", "Admins cannot change their own membership");
    if (new Set(input.ventureIds).size !== input.ventureIds.length || new Set(input.groupIds).size !== input.groupIds.length) throw new AppError(400, "BAD_REQUEST", "Membership scopes must not contain duplicates");
    const ventures = await db.collection("ventures").countDocuments({ _id: { $in: input.ventureIds }, workspaceId: actor.membership.workspaceId });
    const groups = await db.collection("groups").find({ _id: { $in: input.groupIds }, workspaceId: actor.membership.workspaceId }).toArray();
    if (ventures !== input.ventureIds.length || groups.length !== input.groupIds.length || groups.some((group) => !input.ventureIds.includes(String(group.ventureId)))) throw new AppError(400, "BAD_REQUEST", "Membership scopes must be valid groups within assigned ventures");
    if (!allGroupsScopeValid(input.ventureIds, input.allGroupVentureIds)) throw new AppError(400, "BAD_REQUEST", "All-groups access must name each assigned venture at most once");
    const updatedAt = new Date();
    // Only venture heads and contributors hold the knowledge-sharing permission; any other role clears it, so a later promotion doesn't quietly revive it.
    const shareKnowledge = (input.role === "venture_head" || input.role === "contributor") && (input.canShareKnowledge ?? current.canShareKnowledge === true);
    await atomic(database, async (session) => {
      // Picked groups plus every group in the all-groups ventures, read in this transaction so none created meanwhile is missed.
      const everyGroup = await allGroupsIn(db, actor.membership.workspaceId, input.allGroupVentureIds, session);
      const groupIds = [...new Set([...input.groupIds, ...everyGroup.map((group) => group.id)])];
      // The editor submits inherited ventures as ordinary checked boxes; keep them inherited while a group still grants them,
      // so removing the last group later still revokes that access instead of leaving an accidental explicit grant.
      const groupVentures = new Set([...groups, ...everyGroup].map((group) => String(group.ventureId)));
      const inheritedVentureIds = ((current.inheritedVentureIds ?? []) as string[]).filter((ventureId) => input.ventureIds.includes(ventureId) && groupVentures.has(ventureId));
      const result = await db.collection("memberships").updateOne({ _id: id, workspaceId: actor.membership.workspaceId, status: "active", updatedAt: current.updatedAt }, { $set: { role: input.role, ventureIds: input.ventureIds, groupIds, allGroupVentureIds: input.allGroupVentureIds, canShareKnowledge: shareKnowledge, inheritedVentureIds, updatedAt } }, { session });
      if (!result.matchedCount) throw new AppError(409, "CONFLICT", "Membership changed during update");
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "membership.update", objectType: "membership", objectId: id, result: "success", ...(shareKnowledge !== (current.canShareKnowledge === true) ? { metadata: { canShareKnowledge: shareKnowledge } } : {}) }, session);
    });
    res.json({ ok: true, data: jsonValue(await db.collection("memberships").findOne({ _id: id, workspaceId: actor.membership.workspaceId })) });
  });
  async function changeGroupMember(req: Request, res: Response, add: boolean) {
    const actor = req.actor!;
    if (actor.membership.role !== "admin") throw new AppError(403, "FORBIDDEN", "Only workspace admins may manage group members");
    if (!database.transactions) throw new AppError(503, "INTEGRATION_UNAVAILABLE", "Group membership changes require a MongoDB replica set");
    const groupId = idSchema.parse(req.params.groupId);
    const userId = idSchema.parse(req.params.userId);
    const workspaceId = actor.membership.workspaceId;
    const group = await db.collection("groups").findOne({ _id: groupId, workspaceId });
    if (!group || inArchivedVenture(actor.membership, group.ventureId)) throw new AppError(404, "NOT_FOUND", "Group not found");
    // Undoing a removal that ended "all groups" puts that back too (the removal response says so; see below).
    const restoreAllGroups = add && z.object({ allGroups: z.boolean().optional() }).parse(req.body ?? {}).allGroups === true;
    const ventureId = String(group.ventureId);
    let endedAllGroups = false;
    const updated = await atomic(database, async (session) => {
      endedAllGroups = false; // set again on each transaction retry

      const membership = await db.collection("memberships").findOne({ workspaceId, userId, status: "active" }, { session });
      const user = await db.collection("users").findOne({ _id: userId, workspaceId, status: "active" }, { session });
      if (!membership || !user) throw new AppError(404, "NOT_FOUND", "Active workspace member not found");
      if (userId === actor.id) throw new AppError(403, "FORBIDDEN", "Admins cannot change their own group membership");
      if (!add && membership.role === "admin") throw new AppError(403, "FORBIDDEN", "Workspace admins retain access to every group");
      const allGroups = ((membership.allGroupVentureIds ?? []) as string[]).includes(ventureId);
      const changed = add ? !membership.groupIds.includes(groupId) || !membership.ventureIds.includes(group.ventureId) || (restoreAllGroups && !allGroups) : membership.groupIds.includes(groupId);
      if (!changed) return membership;
      endedAllGroups = !add && allGroups;
      const everyGroup = restoreAllGroups ? (await allGroupsIn(db, workspaceId, [ventureId], session)).map((item) => item.id) : [];
      const inherited = add && !membership.ventureIds.includes(group.ventureId);
      const remainingGroupIds = add ? [] : membership.groupIds.filter((id: string) => id !== groupId);
      const otherGroupInVenture = !add && await db.collection("groups").findOne({ _id: { $in: remainingGroupIds }, workspaceId, ventureId: group.ventureId }, { session });
      const revokeInherited = !add && !otherGroupInVenture && (membership.inheritedVentureIds ?? []).includes(group.ventureId);
      const result = add
        ? await db.collection("memberships").updateOne({ _id: membership._id, workspaceId, status: "active" }, { $addToSet: { ventureIds: group.ventureId, groupIds: { $each: [groupId, ...everyGroup] }, ...(restoreAllGroups ? { allGroupVentureIds: ventureId } : {}), ...(inherited ? { inheritedVentureIds: group.ventureId } : {}) }, $set: { updatedAt: new Date() } }, { session })
        // Taking someone out of one group ends "all groups" for that venture: they keep the rest, and new groups are no longer added.
        : await database.native.collection<{ _id: string; workspaceId: string; status: string; groupIds: string[]; ventureIds: string[]; inheritedVentureIds: string[]; allGroupVentureIds: string[]; updatedAt: Date }>("memberships").updateOne({ _id: String(membership._id), workspaceId, status: "active" }, { $pull: { groupIds: groupId, allGroupVentureIds: group.ventureId, ...(revokeInherited ? { ventureIds: group.ventureId, inheritedVentureIds: group.ventureId } : {}) }, $set: { updatedAt: new Date() } }, { session });
      if (!result.matchedCount) throw new AppError(409, "CONFLICT", "Membership changed during update");
      await audit(db, { workspaceId, actorId: actor.id, channel: "api", action: add ? "group.member.add" : "group.member.remove", objectType: "membership", objectId: String(membership._id), ventureId: String(group.ventureId), result: "success", metadata: { ...(endedAllGroups ? { endedAllGroups } : {}), ...(restoreAllGroups ? { restoredAllGroups: true } : {}) } }, session);
      return db.collection("memberships").findOne({ _id: membership._id, workspaceId }, { session });
    });
    res.json({ ok: true, data: jsonValue(updated), ...(add ? {} : { meta: { endedAllGroups } }) });
  }
  router.put("/groups/:groupId/members/:userId", (req, res) => changeGroupMember(req, res, true));
  router.delete("/groups/:groupId/members/:userId", (req, res) => changeGroupMember(req, res, false));
  return router;
}

export function invitationAcceptanceRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();
  router.post("/invitations/accept", async (req, res) => {
    const identity = req.identity!;
    const token = z.object({ token: z.string().min(20) }).parse(req.body).token;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = new Date();
    const auditCandidate = await db.collection("invitations").findOne({ tokenHash }, { projection: { workspaceId: 1 } });
    if (auditCandidate) req.auditWorkspaceId = String(auditCandidate.workspaceId);
    await atomic(database, async (session) => {
      const invite = await db.collection("invitations").findOneAndUpdate({ email: identity.email.toLowerCase(), tokenHash, status: "pending", expiresAt: { $gt: now } }, { $set: { status: "accepting", updatedAt: now } }, { returnDocument: "after", session });
      if (!invite) throw new AppError(404, "NOT_FOUND", "Invitation is invalid or expired");
      const [ventureCount, groups] = await Promise.all([
        db.collection("ventures").countDocuments({ _id: { $in: invite.ventureIds }, workspaceId: invite.workspaceId }, { session }),
        db.collection("groups").find({ _id: { $in: invite.groupIds }, workspaceId: invite.workspaceId }, { session }).toArray(),
      ]);
      // Invitations sent before all-groups access existed carry no list and keep exactly the groups they named.
      const allGroupVentureIds = (invite.allGroupVentureIds ?? []) as string[];
      if (ventureCount !== invite.ventureIds.length || groups.length !== invite.groupIds.length || groups.some((group) => !invite.ventureIds.includes(group.ventureId)) || !allGroupsScopeValid(invite.ventureIds, allGroupVentureIds)) throw new AppError(409, "CONFLICT", "Invitation scope is no longer valid");
      const activeMembership = await db.collection("memberships").findOne({ userId: identity.id, status: "active" }, { session });
      if (activeMembership && activeMembership.workspaceId !== invite.workspaceId) throw new AppError(409, "CONFLICT", "This account already has an active workspace membership");
      if (activeMembership) throw new AppError(409, "CONFLICT", "This account already has an active workspace membership");
      const handle = `${slug(identity.name).slice(0, 40) || "member"}-${createHash("sha256").update(identity.id).digest("hex").slice(0, 8)}`;
      const currentUser = await db.collection("users").findOne({ _id: identity.id }, { session });
      await db.collection("users").updateOne({ _id: identity.id }, { $set: { email: identity.email, name: identity.name, workspaceId: invite.workspaceId, status: "active", updatedAt: now, ...(!currentUser?.handle ? { handle } : {}) }, $setOnInsert: { createdAt: now } }, { upsert: true, session });
      // All-groups ventures grant every group that exists now; later ones are added when they are created.
      const everyGroup = await allGroupsIn(db, String(invite.workspaceId), allGroupVentureIds, session);
      const groupIds = [...new Set([...(invite.groupIds as string[]), ...everyGroup.map((group) => group.id)])];
      await db.collection("memberships").updateOne({ workspaceId: invite.workspaceId, userId: identity.id }, { $set: { role: invite.role, ventureIds: invite.ventureIds, groupIds, allGroupVentureIds, inheritedVentureIds: [], status: "active", updatedAt: now }, $setOnInsert: { _id: randomUUID(), createdAt: now } }, { upsert: true, session });
      // Joining (or re-joining) starts with no Claude tokens: any left from an earlier membership stop working.
      await db.collection("pats").updateMany({ workspaceId: invite.workspaceId, userId: identity.id, revokedAt: { $exists: false } }, { $set: { revokedAt: now, revokedReason: "membership_renewed" } }, { session });
      const accepted = await db.collection("invitations").updateOne({ _id: invite._id, status: "accepting" }, { $set: { status: "accepted", acceptedAt: now, acceptedBy: identity.id } }, { session });
      if (!accepted.matchedCount) throw new AppError(409, "CONFLICT", "Invitation was already claimed");
      await db.collection("invitations").updateMany({ workspaceId: invite.workspaceId, email: invite.email, status: "pending", _id: { $ne: invite._id } }, { $set: { status: "superseded", updatedAt: now } }, { session });
      // Let whoever sent the invitation know it was accepted (in-app, plus push or email per their preferences).
      if (invite.invitedBy && invite.invitedBy !== identity.id) {
        const joined = await db.collection("ventures").find({ _id: { $in: invite.ventureIds }, workspaceId: invite.workspaceId }, { projection: { name: 1 }, session }).toArray();
        const where = joined.map((venture) => String(venture.name)).join(", ");
        const role = String(invite.role).replaceAll("_", " ");
        // The name is chosen by the new member, so keep it short and free of control characters.
        const who = (identity.name || identity.email).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
        await db.collection("notification_outbox").insertOne({ _id: randomUUID(), workspaceId: invite.workspaceId, userId: invite.invitedBy, type: "member_joined", title: `${who} accepted your invitation`, body: where ? `They joined as a ${role} on ${where}.` : `They joined as a ${role}.`, resourceType: "member", resourceId: identity.id, idempotencyKey: `invitation:${invite._id}:accepted`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }, { session });
      }
      await audit(db, { workspaceId: String(invite.workspaceId), actorId: identity.id, channel: "api", action: "invitation.accept", objectType: "invitation", objectId: String(invite._id), result: "success" }, session);
    });
    res.json({ ok: true, data: { accepted: true } });
  });
  return router;
}
