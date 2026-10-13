import { Router } from "express";
import type { AppDb } from "../db.js";
import { jsonValue } from "../json.js";
import { dashboardReadModelSchema, idSchema, memberDirectoryQuerySchema } from "@venture-studio/contracts";
import { notArchived } from "../archive-scope.js";
import { AppError } from "../errors.js";
import { listVisibleNotifications } from "../notification-visibility.js";

export function hierarchyRoutes(db: AppDb): Router {
  const router = Router();
  router.get("/members", async (req, res) => {
    const actor = req.actor!;
    const query = memberDirectoryQuerySchema.parse(req.query);
    if (query.handle && (query.cursor || query.q)) throw new AppError(400, "BAD_REQUEST", "Exact handle lookup cannot be combined with search or a cursor");
    const workspaceId = actor.membership.workspaceId;
    let ventureId = query.ventureId;
    if (query.groupId) {
      const group = await db.collection("groups").findOne({ _id: query.groupId, workspaceId });
      if (!group || (actor.membership.role !== "admin" && (!actor.membership.groupIds.includes(query.groupId) || !actor.membership.ventureIds.includes(String(group.ventureId))))) throw new AppError(404, "NOT_FOUND", "Group not found");
      if (ventureId && ventureId !== group.ventureId) throw new AppError(400, "BAD_REQUEST", "Group does not belong to the selected venture");
      ventureId = String(group.ventureId);
    }
    if (ventureId && actor.membership.role !== "admin" && !actor.membership.ventureIds.includes(ventureId)) throw new AppError(404, "NOT_FOUND", "Venture not found");
    if (ventureId && !await db.collection("ventures").findOne({ _id: ventureId, workspaceId, status: { $ne: "archived" } })) throw new AppError(404, "NOT_FOUND", "Venture not found");
    const scope = query.groupId
      ? { $or: [{ ventureIds: ventureId, groupIds: query.groupId }, { role: "admin" }] }
      : ventureId ? { $or: [{ ventureIds: ventureId }, { role: "admin" }] } : {};
    const memberships = await db.collection("memberships").find({ workspaceId, status: "active", ...scope }).project({ userId: 1, role: 1 }).toArray();
    const byUser = new Map(memberships.map((item) => [String(item.userId), item]));
    const escaped = query.q?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactHandle = query.handle?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await db.collection("users").find({ workspaceId, status: "active", _id: { $in: [...byUser.keys()], ...(!query.handle && query.cursor ? { $gt: idSchema.parse(query.cursor) } : {}) }, ...(exactHandle ? { handle: { $regex: `^${exactHandle}$`, $options: "i" } } : {}), ...(escaped ? { $or: [{ name: { $regex: escaped, $options: "i" } }, { handle: { $regex: escaped, $options: "i" } }] } : {}) }).sort({ _id: 1 }).limit(query.handle ? 2 : query.limit + 1).toArray();
    if (query.handle && users.length > 1) throw new AppError(409, "CONFLICT", "Member handle is ambiguous in this scope");
    const items = users.slice(0, query.limit).map((user) => ({ id: user._id, name: user.name, ...(user.handle ? { handle: user.handle } : {}), role: byUser.get(String(user._id))!.role }));
    res.json({ ok: true, data: { items: jsonValue(items), nextCursor: users.length > query.limit ? String(users[query.limit - 1]?._id) : undefined } });
  });
  router.get("/session/bootstrap", async (req, res) => {
    const actor = req.actor!;
    const hierarchy = await loadHierarchy(db, actor.membership.workspaceId, actor.membership.role === "admin" ? undefined : actor.membership.ventureIds, actor.membership.role === "admin" ? undefined : actor.membership.groupIds);
    // The per-request archive fields stay on the server; they would tell members which hidden ventures exist.
    const { archivedVentureIds: _ventures, archivedGroupIds: _groups, ...membership } = actor.membership;
    res.json({ ok: true, data: { user: { id: actor.id, name: actor.name, email: actor.email }, membership, hierarchy } });
  });
  router.get("/hierarchy", async (req, res) => {
    const actor = req.actor!;
    res.json({ ok: true, data: await loadHierarchy(db, actor.membership.workspaceId, actor.membership.role === "admin" ? undefined : actor.membership.ventureIds, actor.membership.role === "admin" ? undefined : actor.membership.groupIds) });
  });
  router.get("/dashboard", async (req, res) => {
    const actor = req.actor!;
    const workspaceId = actor.membership.workspaceId;
    const ventureFilter = actor.membership.role === "admin" ? notArchived(actor.membership) : { ventureId: { $in: actor.membership.ventureIds } };
    const classFilter = actor.membership.role === "admin" ? notArchived(actor.membership) : { $or: [{ ventureId: { $exists: false } }, ventureFilter] };
    const taskFilter = actor.membership.role === "admin" ? notArchived(actor.membership) : { ...ventureFilter, groupId: { $in: actor.membership.groupIds } };
    const [tasks, reviews, blockers, classes, outcomes, mentions] = await Promise.all([
      db.collection("tasks").find({ workspaceId, ...taskFilter, assigneeId: actor.id, status: { $nin: ["done", "cancelled"] } }).sort({ dueAt: 1 }).limit(10).toArray(),
      db.collection("tasks").find({ workspaceId, ...taskFilter, reviewerId: actor.id, status: "review" }).sort({ reviewAt: 1 }).limit(10).toArray(),
      db.collection("tasks").find({ workspaceId, ...taskFilter, blocker: { $exists: true, $ne: "" }, status: { $ne: "done" } }).sort({ dueAt: 1 }).limit(10).toArray(),
      db.collection("classes").find({ workspaceId, ...classFilter, participantIds: actor.id, scheduledAt: { $gte: new Date() } }).sort({ scheduledAt: 1 }).limit(3).toArray(),
      db.collection("outcomes").find({ workspaceId, ...ventureFilter, status: { $in: ["approved", "active", "at_risk"] } }).sort({ reviewAt: 1 }).limit(10).toArray(),
      listVisibleNotifications(db, actor, { type: "mention", readAt: { $exists: false } }, 10),
    ]);
    const data = dashboardReadModelSchema.parse(jsonValue({ tasks, reviews, blockers, classes, outcomes, mentions, asOf: new Date() }));
    res.json({ ok: true, data });
  });
  return router;
}

async function loadHierarchy(db: AppDb, workspaceId: string, ventureIds?: string[], groupIds?: string[]): Promise<unknown> {
  const workspace = await db.collection("workspaces").findOne({ _id: workspaceId });
  // Archived ventures (and so their groups and channels) leave the navigation for everyone until restored.
  const ventures = await db.collection("ventures").find({ workspaceId, status: { $ne: "archived" }, ...(ventureIds ? { _id: { $in: ventureIds } } : {}) }).sort({ name: 1 }).toArray();
  const ventureIdList = ventures.map((venture) => String(venture._id));
  const [groups, channels] = await Promise.all([
    db.collection("groups").find({ ventureId: { $in: ventureIdList }, ...(groupIds ? { _id: { $in: groupIds } } : {}) }).sort({ name: 1 }).toArray(),
    db.collection("channels").find({ ventureId: { $in: ventureIdList }, ...(groupIds ? { groupId: { $in: groupIds } } : {}) }).sort({ name: 1 }).toArray(),
  ]);
  return jsonValue({ workspace, ventures: ventures.map((venture) => ({ ...venture, groups: groups.filter((group) => group.ventureId === venture._id).map((group) => ({ ...group, channels: channels.filter((channel) => channel.groupId === group._id) })) })) });
}
