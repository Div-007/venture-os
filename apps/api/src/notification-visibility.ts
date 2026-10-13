import type { AppDb } from "./db.js";
import { authorizedDocumentFilter } from "./document-access.js";

type Actor = NonNullable<Express.Request["actor"]>;

/** Read only notices whose current channel scope remains visible to this member. */
export async function listVisibleNotifications(db: AppDb, actor: Actor, filter: Record<string, unknown> = {}, limit = 100) {
  const visible: Record<string, any>[] = [];
  let before: { createdAt: Date; _id: string } | null = null;
  const archived = actor.membership.archivedVentureIds ?? [];
  // Admins see every channel except those in archived ventures; members only their own channels (archived ones already dropped).
  const scopedChannels = actor.membership.role === "admin" ? (archived.length ? await db.collection("channels").find({ workspaceId: actor.membership.workspaceId, ventureId: { $nin: archived } }).project({ _id: 1 }).toArray() : null) : await db.collection("channels").find({ workspaceId: actor.membership.workspaceId, ventureId: { $in: actor.membership.ventureIds }, groupId: { $in: actor.membership.groupIds } }).project({ _id: 1 }).toArray();
  const modernScope = scopedChannels ? { $or: [{ chatKind: { $ne: "channel" } }, { chatKind: "channel", chatId: { $in: scopedChannels.map((channel) => String(channel._id)) } }] } : null;
  while (visible.length < limit) {
    const page = await db.collection("notifications").find({ workspaceId: actor.membership.workspaceId, userId: actor.id, ...filter, ...((modernScope || before) ? { $and: [...(modernScope ? [modernScope] : []), ...(before ? [{ $or: [{ createdAt: { $lt: before.createdAt } }, { createdAt: before.createdAt, _id: { $lt: before._id } }] }] : [])] } : {}) }).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    if (!page.length) break;
    before = { createdAt: page[page.length - 1]!.createdAt, _id: String(page[page.length - 1]!._id) };
    const legacyIds = page.filter((item) => !item.chatKind && item.resourceType === "message").map((item) => String(item.resourceId));
    const legacyMessages = legacyIds.length ? await db.collection("messages").find({ _id: { $in: legacyIds }, workspaceId: actor.membership.workspaceId }).project({ _id: 1, channelId: 1 }).toArray() : [];
    const messageById = new Map(legacyMessages.map((message) => [String(message._id), message]));
    const channelIds = [...new Set(page.map((item) => item.chatKind === "channel" ? String(item.chatId) : messageById.get(String(item.resourceId))?.channelId).filter((id): id is string => typeof id === "string"))];
    const channels = channelIds.length ? await db.collection("channels").find({ _id: { $in: channelIds }, workspaceId: actor.membership.workspaceId }).project({ _id: 1, ventureId: 1, groupId: 1 }).toArray() : [];
    const accessible = new Set(channels.filter((channel) => !archived.includes(String(channel.ventureId)) && (actor.membership.role === "admin" || (actor.membership.ventureIds.includes(String(channel.ventureId)) && actor.membership.groupIds.includes(String(channel.groupId))))).map((channel) => String(channel._id)));
    // Task notices for tasks in archived ventures stay hidden until the venture is restored.
    const taskIds = archived.length ? [...new Set(page.filter((item) => item.resourceType === "task").map((item) => String(item.resourceId)))] : [];
    const archivedTaskIds = new Set(taskIds.length ? (await db.collection("tasks").find({ _id: { $in: taskIds }, workspaceId: actor.membership.workspaceId, ventureId: { $in: archived } }).project({ _id: 1 }).toArray()).map((task) => String(task._id)) : []);
    // So are calendar notices for events on archived ventures' calendars.
    const eventIds = archived.length ? [...new Set(page.filter((item) => item.resourceType === "event").map((item) => String(item.resourceId)))] : [];
    const archivedEventIds = new Set(eventIds.length ? (await db.collection("calendar_events").find({ _id: { $in: eventIds }, workspaceId: actor.membership.workspaceId, ventureId: { $in: archived } }).project({ _id: 1 }).toArray()).map((event) => String(event._id)) : []);
    // Knowledge notices only while the document is still readable: a withdrawn request, or one no longer theirs to approve, drops out.
    const documentIds = [...new Set(page.filter((item) => item.resourceType === "document").map((item) => String(item.resourceId)))];
    const readableDocumentIds = new Set(documentIds.length ? (await db.collection("documents").find({ $and: [authorizedDocumentFilter(actor), { _id: { $in: documentIds } }] }).project({ _id: 1 }).toArray()).map((document) => String(document._id)) : []);
    // Sales notices (a deal was won) only while the lead still exists and its venture is open to this member.
    const opportunityIds = [...new Set(page.filter((item) => item.resourceType === "opportunity").map((item) => String(item.resourceId)))];
    const openOpportunityIds = new Set(opportunityIds.length ? (await db.collection("opportunities").find({ _id: { $in: opportunityIds }, workspaceId: actor.membership.workspaceId, deletedAt: null }).project({ _id: 1, ventureId: 1 }).toArray()).filter((lead) => !archived.includes(String(lead.ventureId)) && (actor.membership.role === "admin" || actor.membership.ventureIds.includes(String(lead.ventureId)))).map((lead) => String(lead._id)) : []);
    // "Approve a message" notices only while the draft still waits for approval and its lead is open to this member.
    const draftIds = [...new Set(page.filter((item) => item.resourceType === "sales_draft").map((item) => String(item.resourceId)))];
    const waitingDrafts = draftIds.length ? await db.collection("sales_drafts").find({ _id: { $in: draftIds }, workspaceId: actor.membership.workspaceId, status: "ready", personApproval: null }).project({ _id: 1, leadId: 1 }).toArray() : [];
    const draftLeads = waitingDrafts.length ? await db.collection("opportunities").find({ _id: { $in: [...new Set(waitingDrafts.map((draft) => String(draft.leadId)))] }, workspaceId: actor.membership.workspaceId, deletedAt: null }).project({ _id: 1, ventureId: 1 }).toArray() : [];
    const openLeadIds = new Set(draftLeads.filter((lead) => !archived.includes(String(lead.ventureId)) && (actor.membership.role === "admin" || actor.membership.ventureIds.includes(String(lead.ventureId)))).map((lead) => String(lead._id)));
    const waitingDraftIds = new Set(waitingDrafts.filter((draft) => openLeadIds.has(String(draft.leadId))).map((draft) => String(draft._id)));
    for (const item of page) {
      const legacy = !item.chatKind && item.resourceType === "message" ? messageById.get(String(item.resourceId)) : undefined;
      if (!item.chatKind && item.resourceType === "message" && !legacy) continue;
      const channelId = item.chatKind === "channel" ? String(item.chatId) : legacy?.channelId;
      if (channelId && !accessible.has(String(channelId))) continue;
      if (item.resourceType === "task" && archivedTaskIds.has(String(item.resourceId))) continue;
      if (item.resourceType === "event" && archivedEventIds.has(String(item.resourceId))) continue;
      if (item.resourceType === "document" && !readableDocumentIds.has(String(item.resourceId))) continue;
      if (item.resourceType === "opportunity" && !openOpportunityIds.has(String(item.resourceId))) continue;
      if (item.resourceType === "sales_draft" && !waitingDraftIds.has(String(item.resourceId))) continue;
      visible.push(item);
      if (visible.length === limit) break;
    }
    if (page.length < 100) break;
  }
  return visible;
}
