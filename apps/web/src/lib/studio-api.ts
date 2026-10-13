import { localDevUserId } from "@/lib/dev-identity";
import { validationSummary } from "@/lib/errors";
import {
  createSkillSchema,
  createVentureContextSchema,
  sharedAttachmentPageSchema,
  skillListSchema,
  skillSchema,
  updateSkillSchema,
  updateVentureContextSchema,
  ventureContextListSchema,
  ventureContextSchema,
  type AttachmentKind,
  calendarEventSchema,
  calendarFeedSchema,
  calendarRangeSchema,
  createEventSchema,
  updateEventSchema,
  createTaskSchema,
  createOutcomeSchema,
  createDocumentSchema,
  channelSchema,
  createChannelMessageSchema,
  createDirectMessageSchema,
  createChannelSchema,
  groupSchema,
  ventureSchema,
  commandExecuteSchema,
  commandPreviewRequestSchema,
  commandPreviewSchema,
  dashboardResponseSchema,
  evidenceItemSchema,
  markNotificationsReadSchema,
  fileSchema,
  groupFileSchema,
  uploadIntentSchema,
  uploadCompleteSchema,
  searchQuerySchema,
  errorEnvelopeSchema,
  eventEnvelopeSchema,
  focusSessionSchema,
  classApplicationSchema,
  reviewClassApplicationSchema,
  informationRequestSchema,
  knowledgeSearchResponseSchema,
  knowledgeSearchSchema,
  messageSchema,
  memberDirectoryItemSchema,
  memberDirectoryQuerySchema,
  membershipSchema,
  opportunityInputSchema,
  opportunitySchema,
  pipelineInputSchema,
  pipelineSchema,
  pinUpdateSchema,
  reactionUpdateSchema,
  saveUpdateSchema,
  notificationSchema,
  notificationPreferencesSchema,
  channelNotificationLevelSchema,
  type ChannelNotificationLevel,
  outcomeSchema,
  leaderboardPersonSchema,
  leaderboardSchema,
  leaderboardWeeklySchema,
  leaderboardWeeklyStatusSchema,
  type LeaderboardPeriod,
  celebrationFeedSchema,
  celebrationPauseResultSchema,
  pagedDataSchema,
  pagedSuccessEnvelope,
  reminderSchema,
  documentListQuerySchema,
  snoozeSchema,
  startFocusSchema,
  classSchema,
  decisionSchema,
  documentSchema,
  documentSuggestionSchema,
  documentUpdateResultSchema,
  knowledgeReviewQueueSchema,
  documentVersionSchema,
  updateDocumentSchema,
  sessionBootstrapResponseSchema,
  successEnvelope,
  patListItemSchema,
  patCreatedSchema,
  taskListCountsSchema,
  taskListQuerySchema,
  type taskSortSchema,
  type taskViewSchema,
  taskSchema,
  taskUpdateSchema,
  updateTaskSchema,
  updateInformationRequestSchema,
  updateClassSchema,
  updateDecisionSchema,
  updateMembershipSchema,
  updateVentureSchema,
  archivedVentureSchema,
  deletedVentureSchema,
  updateOpportunitySchema,
  updateOutcomeSchema,
  updatePipelineSchema,
  type Task,
} from "@venture-studio/contracts";
import type { AppRole } from "@venture-studio/contracts";

export class StudioApiError extends Error {
  constructor(message: string, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "StudioApiError";
  }
}

/** Shared JSON request helper (dev identity, error envelopes). Also used by lib/sales-api.ts. */
export async function request(path: string, init?: RequestInit, options: { devAuth?: boolean } = {}): Promise<unknown> {
  const devUserId = options.devAuth !== false ? localDevUserId() : null;
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(devUserId ? { "x-dev-user-id": devUserId } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorEnvelopeSchema.safeParse(body);
    if (error.success) throw new StudioApiError(error.data.error.issues?.length ? validationSummary(error.data.error.issues) : error.data.error.message, error.data.error.code, error.data.error.requestId);
    throw new StudioApiError(`The API returned HTTP ${response.status}.`);
  }
  return body;
}

export async function loadLiveDashboard() {
  const [bootstrap, dashboard] = await Promise.all([
    request("/v1/session/bootstrap"),
    request("/v1/dashboard"),
  ]);
  return {
    bootstrap: sessionBootstrapResponseSchema.parse(bootstrap).data,
    dashboard: dashboardResponseSchema.parse(dashboard).data,
  };
}

/** Whether the browser holds a Better Auth session, independent of workspace membership. */
export async function hasLiveAuthSession(): Promise<boolean> {
  const response = await fetch("/api/auth/get-session", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return false;
  const session = await response.json().catch(() => null) as { user?: { id?: unknown } } | null;
  return typeof session?.user?.id === "string";
}

/** The signed-in account's email and name, or null when the browser has no Better Auth session. */
export async function liveAuthIdentity(): Promise<{ email: string; name: string } | null> {
  const response = await fetch("/api/auth/get-session", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return null;
  const session = await response.json().catch(() => null) as { user?: { email?: unknown; name?: unknown } } | null;
  return typeof session?.user?.email === "string" ? { email: session.user.email, name: typeof session.user.name === "string" ? session.user.name : "" } : null;
}

/**
 * Ends the Better Auth session, then reloads on the sign-in page so no workspace state survives in memory.
 * Throws when the session could not be ended: going to sign-in anyway would just bounce a still-signed-in user back.
 */
export async function signOutLive(next?: string) {
  const response = await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
  if (!response.ok) throw new Error(`Could not sign out (HTTP ${response.status}). Try again.`);
  window.location.replace(next ? `/sign-in/live?next=${encodeURIComponent(next)}` : "/sign-in/live");
}

export async function loadLiveSession() {
  return sessionBootstrapResponseSchema.parse(await request("/v1/session/bootstrap")).data;
}

export async function listLiveMembers(input: { ventureId?: string; groupId?: string; q?: string; handle?: string; cursor?: string; limit?: number } = {}) {
  const query = memberDirectoryQuerySchema.parse(input);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return pagedSuccessEnvelope(memberDirectoryItemSchema).parse(await request(`/v1/members?${params}`)).data;
}

/** `allGroups` puts back "all groups" in the venture too: Undo after a removal that ended it (see removeLiveGroupMember). */
export async function addLiveGroupMember(groupId: string, ventureId: string, userId: string, options: { allGroups?: boolean } = {}) {
  const membership = successEnvelope(membershipSchema).parse(await request(`/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: "PUT", ...(options.allGroups ? { body: JSON.stringify({ allGroups: true }) } : {}) })).data;
  if (membership.userId !== userId || !membership.groupIds.includes(groupId) || !membership.ventureIds.includes(ventureId)) throw new StudioApiError("The group membership response did not match the selected person and group.");
  return membership;
}

/** `endedAllGroups`: they had every group in this venture; after this, new groups there are no longer added for them. */
export async function removeLiveGroupMember(groupId: string, userId: string) {
  const body = await request(`/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  const membership = successEnvelope(membershipSchema).parse(body).data;
  if (membership.userId !== userId || membership.groupIds.includes(groupId)) throw new StudioApiError("The group membership response did not confirm removal from this group.");
  const meta = body && typeof body === "object" && "meta" in body ? body.meta : null;
  const endedAllGroups = Boolean(meta && typeof meta === "object" && "endedAllGroups" in meta && meta.endedAllGroups === true);
  return { membership, endedAllGroups };
}

export async function createLiveGroupInvitation(input: { email: string; role: "venture_head" | "contributor" | "reviewer" | "learner"; ventureId: string; groupId: string }) {
  return createLiveInvitation({ email: input.email, role: input.role, ventureIds: [input.ventureId], groupIds: [input.groupId] });
}

/** Invites someone by email with a role and venture/group access; returns a manual link when email delivery is off. */
export async function createLiveInvitation(input: { email: string; role: AppRole; ventureIds: string[]; groupIds: string[]; allGroupVentureIds?: string[] }) {
  const allGroupVentureIds = input.allGroupVentureIds ?? [];
  const body = await request("/v1/admin/invitations", { method: "POST", body: JSON.stringify({ ...input, allGroupVentureIds }) });
  if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true || !("data" in body) || !body.data || typeof body.data !== "object") throw new StudioApiError("The invitation response was invalid.");
  const invitation = "invitation" in body.data ? body.data.invitation : null;
  const sameIds = (value: unknown, expected: string[]) => Array.isArray(value) && value.length === expected.length && expected.every((id) => value.includes(id));
  if (!invitation || typeof invitation !== "object" || !("ventureIds" in invitation) || !sameIds(invitation.ventureIds, input.ventureIds) || !("groupIds" in invitation) || !sameIds(invitation.groupIds, input.groupIds) || !("allGroupVentureIds" in invitation) || !sameIds(invitation.allGroupVentureIds, allGroupVentureIds)) throw new StudioApiError("The invitation response did not match the selected access.");
  if ("token" in body.data && typeof body.data.token === "string" && body.data.token) return { kind: "manual" as const, token: body.data.token };
  const delivery = "delivery" in body.data ? body.data.delivery : null;
  if (delivery && typeof delivery === "object" && "mode" in delivery && delivery.mode === "email" && "status" in delivery && delivery.status === "sent") return { kind: "email" as const };
  throw new StudioApiError("The invitation was created, but the API did not confirm email delivery or provide a manual link.");
}

export type TaskView = ReturnType<typeof taskViewSchema.parse>;
export type TaskSort = ReturnType<typeof taskSortSchema.parse>;
export type TaskListCounts = ReturnType<typeof taskListCountsSchema.parse>;
type TaskFilters = Partial<Pick<Task, "ventureId" | "groupId" | "assigneeId" | "status" | "priority">> & { tag?: string; view?: TaskView; sort?: TaskSort; q?: string; dueFrom?: string; dueTo?: string; counts?: boolean };

export async function listLiveTasks(cursor?: string, { counts, ...filters }: TaskFilters = {}) {
  const query = taskListQuerySchema.parse({ limit: 100, cursor, ...filters, ...(counts ? { counts: "true" } : {}) });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return successEnvelope(pagedDataSchema(taskSchema).extend({ counts: taskListCountsSchema.optional() })).parse(await request(`/v1/tasks?${params}`)).data;
}

/** The leaderboard: everyone's fair score for a period (see contracts/leaderboard.ts for how it's worked out). */
export async function getLeaderboard(options: { period: LeaderboardPeriod; ventureId?: string; learners?: boolean }) {
  const params = new URLSearchParams({ period: options.period, ...(options.ventureId ? { ventureId: options.ventureId } : {}), ...(options.learners ? { learners: "true" } : {}) });
  return successEnvelope(leaderboardSchema).parse(await request(`/v1/leaderboard?${params}`)).data;
}
export async function getLeaderboardPerson(userId: string, options: { period: LeaderboardPeriod; ventureId?: string; learners?: boolean; week?: string }) {
  const params = new URLSearchParams({ period: options.period, ...(options.ventureId ? { ventureId: options.ventureId } : {}), ...(options.learners ? { learners: "true" } : {}), ...(options.week ? { week: options.week } : {}) });
  return successEnvelope(leaderboardPersonSchema).parse(await request(`/v1/leaderboard/people/${encodeURIComponent(userId)}?${params}`)).data;
}
/** Last week's edition, made on Saturday; `seen` says whether this person has opened it. */
export async function getWeeklyLeaderboard(learners = false) {
  return successEnvelope(leaderboardWeeklySchema).parse(await request(`/v1/leaderboard/weekly${learners ? "?learners=true" : ""}`)).data;
}
export async function getWeeklyLeaderboardStatus() {
  return successEnvelope(leaderboardWeeklyStatusSchema).parse(await request("/v1/leaderboard/weekly/status")).data;
}
export async function markWeeklyLeaderboardSeen(week: string) {
  await request(`/v1/leaderboard/weekly/${encodeURIComponent(week)}/seen`, { method: "POST", body: "{}" });
}

/** My finished tasks waiting to be celebrated (none while I've paused celebrations), with what the film shows. */
export async function getCelebrations() {
  return successEnvelope(celebrationFeedSchema).parse(await request("/v1/celebrations")).data;
}
export async function markCelebrationsSeen(ids: string[]) {
  await request("/v1/celebrations/seen", { method: "POST", body: JSON.stringify({ ids }) });
}
/** Pause celebrations for 1, 3, or 24 hours (0 resumes them). */
export async function pauseCelebrations(hours: 0 | 1 | 3 | 24) {
  return successEnvelope(celebrationPauseResultSchema).parse(await request("/v1/celebrations/pause", { method: "PUT", body: JSON.stringify({ hours }) })).data;
}

export async function getLiveTask(id: string) {
  const data = successEnvelope(taskSchema.passthrough()).parse(await request(`/v1/tasks/${encodeURIComponent(id)}`)).data;
  return {
    task: taskSchema.parse(data),
    updates: taskUpdateSchema.array().parse(data.updates),
    evidence: evidenceItemSchema.array().parse(data.evidence),
    attachments: fileSchema.array().parse(data.attachments),
  };
}

type UploadScope = { ventureId: string; groupId?: string; taskId?: string } | { recipientId: string };
const fileTypes = new Map<string, string>([
  ["pdf", "application/pdf"], ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["md", "text/markdown"], ["txt", "text/plain"],
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["webp", "image/webp"], ["gif", "image/gif"], ["mp4", "video/mp4"], ["mov", "video/quicktime"], ["webm", "video/webm"],
  ["mp3", "audio/mpeg"], ["m4a", "audio/mp4"], ["ogg", "audio/ogg"], ["wav", "audio/wav"],
]);

export async function listLiveGroupFiles(groupId: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  const page = pagedSuccessEnvelope(groupFileSchema).parse(await request(`/v1/groups/${encodeURIComponent(groupId)}/files?${params}`)).data;
  if (page.items.some((file) => file.groupId !== groupId || file.status !== "ready")) throw new StudioApiError("The group file response included an item outside this group.");
  return page;
}

export async function listLiveFiles(cursor?: string, ventureId?: string) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  if (ventureId) params.set("ventureId", ventureId);
  const page = pagedSuccessEnvelope(groupFileSchema).parse(await request(`/v1/files?${params}`)).data;
  if (page.items.some((file) => file.status !== "ready" || Boolean(file.recipientId) || (ventureId && file.ventureId !== ventureId))) throw new StudioApiError("The file library returned an item outside its scope.");
  return page;
}

function signedObjectTarget(raw: string) {
  const url = new URL(raw);
  if (url.pathname.startsWith("/v1/local-objects/") && ["localhost", "127.0.0.1"].includes(url.hostname)) return `${url.pathname}${url.search}`;
  if (url.protocol !== "https:") throw new StudioApiError("The signed object URL must use HTTPS.");
  return url.href;
}

/** `image` carries a picture's pixel size and whether it is the HD original (see prepareUpload). */
export async function uploadLiveFile(file: File, scope: UploadScope, onProgress?: (percent: number, phase: "uploading" | "finalizing") => void, image: { width?: number; height?: number; hd?: true } = {}) {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const contentType = file.type || fileTypes.get(extension) || "";
  const intent = uploadIntentSchema.parse({ ...scope, name: file.name, contentType, size: file.size, ...(contentType.startsWith("image/") ? image : {}) });
  const body = await request("/v1/uploads", { method: "POST", body: JSON.stringify(intent) });
  if (!body || typeof body !== "object" || !("data" in body) || !body.data || typeof body.data !== "object" || !("file" in body.data) || !("uploadUrl" in body.data) || typeof body.data.uploadUrl !== "string") throw new StudioApiError("The upload intent response was invalid.");
  const pending = fileSchema.parse(body.data.file);
  const target = signedObjectTarget(body.data.uploadUrl);
  let etag: string;
  if (onProgress) {
    onProgress(0, "uploading");
    etag = await new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", target);
      xhr.setRequestHeader("content-type", intent.contentType);
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(95, Math.round(event.loaded / event.total * 95)), "uploading"); };
      xhr.onerror = () => reject(new StudioApiError("The signed upload could not reach storage."));
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.getResponseHeader("etag") ?? (target.startsWith("/v1/local-objects/") ? "local" : ""))
        : reject(new StudioApiError(`The signed upload returned HTTP ${xhr.status}.`));
      xhr.send(file);
    });
    onProgress(95, "finalizing");
  } else {
    const response = await fetch(target, { method: "PUT", body: file, headers: { "content-type": intent.contentType } });
    if (!response.ok) throw new StudioApiError(`The signed upload returned HTTP ${response.status}.`);
    etag = response.headers.get("etag") ?? (target.startsWith("/v1/local-objects/") ? "local" : "");
  }
  if (!etag) throw new StudioApiError("The upload completed without an ETag; check object-store CORS exposure before retrying.");
  const complete = uploadCompleteSchema.parse({ etag });
  const uploaded = successEnvelope(fileSchema).parse(await request(`/v1/uploads/${encodeURIComponent(pending.id)}/complete`, { method: "POST", body: JSON.stringify(complete) })).data;
  onProgress?.(100, "finalizing");
  return uploaded;
}

export async function prepareLiveFileDownload(id: string, contentType?: string) {
  const body = await request(`/v1/files/${encodeURIComponent(id)}/download`);
  if (!body || typeof body !== "object" || !("data" in body) || !body.data || typeof body.data !== "object" || !("downloadUrl" in body.data) || typeof body.data.downloadUrl !== "string") throw new StudioApiError("The authorized download response was invalid.");
  const response = await fetch(signedObjectTarget(body.data.downloadUrl));
  if (!response.ok) throw new StudioApiError(`The signed download returned HTTP ${response.status}.`);
  const blob = await response.blob();
  return URL.createObjectURL(contentType ? new Blob([blob], { type: contentType }) : blob);
}

export async function loadLiveImageThumbnail(id: string, signal?: AbortSignal) {
  const devUserId = localDevUserId();
  const response = await fetch(`/v1/files/${encodeURIComponent(id)}/thumbnail`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: devUserId ? { "x-dev-user-id": devUserId } : undefined,
  });
  if (!response.ok) throw new StudioApiError(`The image thumbnail returned HTTP ${response.status}.`, `HTTP_${response.status}`);
  return response.blob();
}

export type LiveFileSearchHit = { type: "file"; id: string; title: string; excerpt: string; ventureId: string; sourceRef: string };
export async function searchLiveFiles(q: string, ventureId?: string): Promise<LiveFileSearchHit[]> {
  const query = searchQuerySchema.parse({ q, ventureId, types: ["file"], limit: 50 });
  const params = new URLSearchParams({ q: query.q, types: "file", limit: String(query.limit) });
  if (query.ventureId) params.set("ventureId", query.ventureId);
  const body = await request(`/v1/search?${params}`);
  if (!body || typeof body !== "object" || !("data" in body) || !body.data || typeof body.data !== "object" || !("items" in body.data) || !Array.isArray(body.data.items)) throw new StudioApiError("The file search response was invalid.");
  return body.data.items.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("type" in item) || item.type !== "file" || !("id" in item) || typeof item.id !== "string" || !("title" in item) || typeof item.title !== "string" || !("excerpt" in item) || typeof item.excerpt !== "string" || !("ventureId" in item) || typeof item.ventureId !== "string" || !("sourceRef" in item) || typeof item.sourceRef !== "string") throw new StudioApiError("The file search item was invalid.");
    return item as LiveFileSearchHit;
  });
}

export type LiveChatSearchHit = {
  type: "message" | "file";
  id: string;
  title: string;
  excerpt: string;
  groupId: string;
  channelId?: string;
  contentType?: string;
};

export async function searchLiveGroupContent(q: string, groupId: string): Promise<LiveChatSearchHit[]> {
  const query = searchQuerySchema.parse({ q, groupId, types: ["message", "file"], limit: 50 });
  const params = new URLSearchParams({ q: query.q, groupId, types: "message,file", limit: String(query.limit) });
  const body = await request(`/v1/search?${params}`);
  if (!body || typeof body !== "object" || !("data" in body) || !body.data || typeof body.data !== "object" || !("items" in body.data) || !Array.isArray(body.data.items)) throw new StudioApiError("The group search response was invalid.");
  return body.data.items.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("type" in item) || (item.type !== "message" && item.type !== "file") || !("id" in item) || typeof item.id !== "string" || !("title" in item) || typeof item.title !== "string" || !("excerpt" in item) || typeof item.excerpt !== "string" || !("groupId" in item) || item.groupId !== groupId) throw new StudioApiError("The group search included an item outside this group.");
    if (item.type === "message" && (!("channelId" in item) || typeof item.channelId !== "string")) throw new StudioApiError("A channel search result lacked its destination.");
    if (item.type === "file" && (!("contentType" in item) || typeof item.contentType !== "string")) throw new StudioApiError("A file search result lacked its type.");
    return item as LiveChatSearchHit;
  });
}

export async function createLiveTask(input: unknown) {
  const valid = createTaskSchema.parse(input);
  return successEnvelope(taskSchema).parse(await request("/v1/tasks", { method: "POST", body: JSON.stringify(valid) })).data;
}

/** Deletes a task (with its comments, evidence, and files); the returned id undoes it with restoreLiveTask. */
export async function deleteLiveTask(id: string): Promise<{ deletionId: string }> {
  const body = await request(`/v1/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = body && typeof body === "object" && "data" in body ? (body as { data: unknown }).data : null;
  if (!data || typeof data !== "object" || !("deletionId" in data) || typeof data.deletionId !== "string") throw new StudioApiError("The delete response was invalid.");
  return { deletionId: data.deletionId };
}
export async function restoreLiveTask(deletionId: string) {
  return successEnvelope(taskSchema).parse(await request(`/v1/tasks/deletions/${encodeURIComponent(deletionId)}/restore`, { method: "POST" })).data;
}

export async function updateLiveTask(id: string, input: unknown) {
  const valid = updateTaskSchema.parse(input);
  return successEnvelope(taskSchema).parse(await request(`/v1/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function commentOnLiveTask(id: string, body: string) {
  return successEnvelope(taskUpdateSchema).parse(await request(`/v1/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify({ body }) })).data;
}

export async function submitLiveEvidence(id: string, input: { title: string; description: string; uri?: string }) {
  return successEnvelope(evidenceItemSchema).parse(await request(`/v1/tasks/${encodeURIComponent(id)}/evidence`, { method: "POST", body: JSON.stringify({ type: input.uri ? "link" : "note", ...input }) })).data;
}

export async function reviewLiveEvidence(id: string, status: "accepted" | "rejected" | "exception") {
  return successEnvelope(evidenceItemSchema).parse(await request(`/v1/evidence/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ status }) })).data;
}

export async function acceptLiveInvitation(token: string) {
  const result = await request("/v1/invitations/accept", { method: "POST", body: JSON.stringify({ token }) }, { devAuth: false });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result) || !result.data || typeof result.data !== "object" || !("accepted" in result.data) || result.data.accepted !== true) throw new StudioApiError("The invitation response was invalid.");
}

/** Newest page first, returned in chronological order; `nextCursor` loads the next older page. */
export async function listLiveChannelMessages(channelId: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "100", order: "latest" });
  if (cursor) params.set("cursor", cursor);
  return pagedSuccessEnvelope(messageSchema).parse(await request(`/v1/channels/${encodeURIComponent(channelId)}/messages?${params}`)).data;
}

export async function listLiveGroupSavedMessages(groupId: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("cursor", cursor);
  const page = pagedSuccessEnvelope(messageSchema).parse(await request(`/v1/groups/${encodeURIComponent(groupId)}/messages/saved?${params}`)).data;
  if (page.items.some((message) => message.groupId !== groupId || !message.channelId)) throw new StudioApiError("The saved message response included an item outside this group.");
  return page;
}

export async function sendLiveChannelMessage(channelId: string, input: unknown) {
  const valid = createChannelMessageSchema.parse(input);
  const result = await request(`/v1/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", body: JSON.stringify(valid) });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result) || !result.data || typeof result.data !== "object" || !("message" in result.data) || !("event" in result.data)) throw new StudioApiError("The message response was invalid.");
  return { message: messageSchema.parse(result.data.message), event: eventEnvelopeSchema.parse(result.data.event) };
}

export async function listLiveDirectMessages(userId: string) {
  return successEnvelope(messageSchema.array()).parse(await request(`/v1/direct-messages/${encodeURIComponent(userId)}`)).data;
}

export async function listLiveEvents(after?: string) {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  return successEnvelope(eventEnvelopeSchema.array()).parse(await request(`/v1/events${params.toString() ? `?${params}` : ""}`)).data;
}

export async function sendLiveDirectMessage(input: unknown) {
  const valid = createDirectMessageSchema.parse(input);
  return successEnvelope(messageSchema).parse(await request("/v1/direct-messages", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveMessageReaction(id: string, emoji: string, active: boolean) {
  const valid = reactionUpdateSchema.parse({ emoji, active });
  return successEnvelope(messageSchema).parse(await request(`/v1/messages/${encodeURIComponent(id)}/reaction`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

export async function updateLiveMessageSave(id: string, saved: boolean) {
  const valid = saveUpdateSchema.parse({ saved });
  return successEnvelope(messageSchema).parse(await request(`/v1/messages/${encodeURIComponent(id)}/save`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

export async function updateLiveMessagePin(id: string, pinned: boolean) {
  const valid = pinUpdateSchema.parse({ pinned });
  return successEnvelope(messageSchema).parse(await request(`/v1/messages/${encodeURIComponent(id)}/pin`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

export async function previewLiveCommand(input: unknown) {
  const valid = commandPreviewRequestSchema.parse(input);
  return successEnvelope(commandPreviewSchema).parse(await request("/v1/commands/preview", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function executeLiveCommand(input: unknown, kind: "assign" | "notify") {
  const valid = commandExecuteSchema.parse(input);
  const result = await request("/v1/commands/execute", { method: "POST", body: JSON.stringify(valid) });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result) || !result.data || typeof result.data !== "object" || !("reminder" in result.data)) throw new StudioApiError("The command response was invalid.");
  const taskValue = "task" in result.data ? result.data.task : undefined;
  if (kind === "assign" && taskValue === undefined) throw new StudioApiError("The assignment response had no task.");
  return { reminder: reminderSchema.parse(result.data.reminder), task: kind === "assign" ? taskSchema.parse(taskValue) : undefined };
}

export async function listLiveNotifications() {
  return successEnvelope(notificationSchema.array()).parse(await request("/v1/notifications")).data;
}

export async function getLiveNotificationPreferences() {
  return successEnvelope(notificationPreferencesSchema).parse(await request("/v1/notification-preferences")).data;
}

export async function updateLiveNotificationPreferences(input: unknown) {
  const valid = notificationPreferencesSchema.parse(input);
  return successEnvelope(notificationPreferencesSchema).parse(await request("/v1/notification-preferences", { method: "PUT", body: JSON.stringify(valid) })).data;
}

/** How one channel notifies me: every message, @mentions only (the default), or nothing. */
export async function getLiveChannelNotificationLevel(channelId: string) {
  return successEnvelope(channelNotificationLevelSchema).parse(await request(`/v1/channels/${encodeURIComponent(channelId)}/notification-level`)).data.level;
}

export async function setLiveChannelNotificationLevel(channelId: string, level: ChannelNotificationLevel) {
  const valid = channelNotificationLevelSchema.parse({ level });
  return successEnvelope(channelNotificationLevelSchema).parse(await request(`/v1/channels/${encodeURIComponent(channelId)}/notification-level`, { method: "PUT", body: JSON.stringify(valid) })).data.level;
}

export async function getLivePushConfig(): Promise<{ available: boolean; publicKey?: string }> {
  let body: unknown;
  try { body = await request("/v1/push-config"); }
  catch (cause) {
    if (cause instanceof StudioApiError && cause.code === "NOT_FOUND") return { available: false };
    throw cause;
  }
  if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true || !("data" in body) || !body.data || typeof body.data !== "object") throw new StudioApiError("The Web Push configuration response was invalid.");
  const config = body.data as { available?: unknown; publicKey?: unknown };
  if (typeof config.available !== "boolean") throw new StudioApiError("The Web Push configuration response was invalid.");
  if (config.available && (typeof config.publicKey !== "string" || !config.publicKey)) throw new StudioApiError("Web Push is configured without a public key.");
  return { available: config.available, ...(config.available ? { publicKey: config.publicKey as string } : {}) };
}

export async function registerLivePushSubscription(subscription: PushSubscription) {
  const data = subscription.toJSON();
  if (!data.endpoint || !data.keys?.p256dh || !data.keys.auth) throw new StudioApiError("The browser did not provide complete push subscription details.");
  const response = await request("/v1/push-subscriptions", { method: "POST", body: JSON.stringify({ endpoint: data.endpoint, expirationTime: data.expirationTime ?? null, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth } }) });
  if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true || !("data" in response) || !response.data || typeof response.data !== "object" || !("subscribed" in response.data) || response.data.subscribed !== true) throw new StudioApiError("The server did not confirm the push subscription.");
}

export async function unregisterLivePushSubscription(endpoint: string) {
  const response = await request("/v1/push-subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) });
  if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true || !("data" in response) || !response.data || typeof response.data !== "object" || !("unsubscribed" in response.data) || response.data.unsubscribed !== true) throw new StudioApiError("The server did not confirm push subscription removal.");
}

export async function listLiveReminders(cursor?: string) {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  return pagedSuccessEnvelope(reminderSchema).parse(await request(`/v1/reminders?${params}`)).data;
}

export async function getLiveReminder(id: string) {
  return successEnvelope(reminderSchema).parse(await request(`/v1/reminders/${encodeURIComponent(id)}`)).data;
}

/** Mark the caller's unread notifications read: all of them, or one conversation's. Returns how many changed. */
export async function markLiveNotificationsRead(scope: { chatKind?: "direct" | "channel"; chatId?: string } = {}): Promise<number> {
  const valid = markNotificationsReadSchema.parse(scope);
  const result = await request("/v1/notifications/read", { method: "POST", body: JSON.stringify(valid) });
  const read = result && typeof result === "object" && "data" in result && result.data && typeof result.data === "object" && "read" in result.data ? result.data.read : undefined;
  if (typeof read !== "number") throw new StudioApiError("The notification response was invalid.");
  return read;
}

export async function readLiveNotification(id: string) {
  const result = await request(`/v1/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new StudioApiError("The notification response was invalid.");
}

export async function snoozeLiveReminder(id: string, minutes: 10 | 20 | 30 | "never") {
  const valid = snoozeSchema.parse({ minutes });
  return successEnvelope(reminderSchema).parse(await request(`/v1/reminders/${encodeURIComponent(id)}/snooze`, { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function getCurrentLiveFocus() {
  return successEnvelope(focusSessionSchema.nullable()).parse(await request("/v1/focus/current")).data;
}

export async function listLiveFocusHistory(cursor?: string) {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  return pagedSuccessEnvelope(focusSessionSchema).parse(await request(`/v1/focus/history?${params}`)).data;
}

export async function startLiveFocus(input: unknown) {
  const valid = startFocusSchema.parse(input);
  return successEnvelope(focusSessionSchema).parse(await request("/v1/focus", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function pauseLiveFocus(id: string) {
  return successEnvelope(focusSessionSchema).parse(await request(`/v1/focus/${encodeURIComponent(id)}/pause`, { method: "POST" })).data;
}

export async function resumeLiveFocus(id: string) {
  return successEnvelope(focusSessionSchema).parse(await request(`/v1/focus/${encodeURIComponent(id)}/resume`, { method: "POST" })).data;
}

export async function completeLiveFocus(id: string) {
  return successEnvelope(focusSessionSchema).parse(await request(`/v1/focus/${encodeURIComponent(id)}/complete`, { method: "POST" })).data;
}

export async function searchLiveKnowledge(q: string, ventureId?: string) {
  const query = knowledgeSearchSchema.parse({ q, ventureId, limit: 25 });
  const params = new URLSearchParams({ q: query.q, limit: String(query.limit) });
  if (query.ventureId) params.set("ventureId", query.ventureId);
  return knowledgeSearchResponseSchema.parse(await request(`/v1/knowledge/search?${params}`)).data;
}

export async function getLiveDocument(id: string) {
  const data = successEnvelope(documentSchema.passthrough()).parse(await request(`/v1/documents/${encodeURIComponent(id)}`)).data;
  const normalizeVersion = (value: unknown) => value && typeof value === "object" && "sourceUri" in value && value.sourceUri === null ? { ...value, sourceUri: undefined } : value;
  return { document: documentSchema.parse(data), version: documentVersionSchema.parse(normalizeVersion(data.currentVersion)), versions: documentVersionSchema.omit({ markdown: true }).array().parse(Array.isArray(data.versions) ? data.versions.map(normalizeVersion) : data.versions) , suggestions: documentSuggestionSchema.array().parse(Array.isArray(data.suggestions) ? data.suggestions : []) };
}

export async function listLiveDocuments(cursor?: string, filters: { ventureId?: string; status?: "draft" | "approved" | "stale" } = {}) {
  const query = documentListQuerySchema.parse({ limit: 50, cursor, ...filters });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return pagedSuccessEnvelope(documentSchema).parse(await request(`/v1/documents?${params}`)).data;
}

export async function createLiveDocument(input: unknown) {
  const valid = createDocumentSchema.parse(input);
  return successEnvelope(documentSchema).parse(await request("/v1/documents", { method: "POST", body: JSON.stringify(valid) })).data;
}

/** Saves a new version, or, for a workspace-wide document I may not publish to, sends it as a suggested change. */
export async function updateLiveDocument(id: string, input: unknown) {
  const valid = updateDocumentSchema.parse(input);
  return successEnvelope(documentUpdateResultSchema).parse(await request(`/v1/documents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

/** An approver's queue: new documents waiting to be shared with all ventures, and suggested changes to shared ones. */
export async function listLiveKnowledgeReviews() {
  return successEnvelope(knowledgeReviewQueueSchema).parse(await request("/v1/knowledge/reviews")).data;
}

/** Approve or decline a request to share a document with all ventures, or (its author) withdraw it. */
/** `versionId` is the version the reviewer read: approval fails if the author changed it since. */
export async function reviewLiveDocumentRequest(id: string, decision: "approve" | "decline" | "withdraw", note?: string, versionId?: string) {
  return successEnvelope(documentSchema).parse(await request(`/v1/documents/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ decision, ...(note ? { note } : {}), ...(versionId ? { versionId } : {}) }) })).data;
}

export async function reviewLiveSuggestion(id: string, suggestionId: string, decision: "approve" | "decline", note?: string) {
  return successEnvelope(documentSchema).parse(await request(`/v1/documents/${encodeURIComponent(id)}/suggestions/${encodeURIComponent(suggestionId)}/review`, { method: "POST", body: JSON.stringify({ decision, ...(note ? { note } : {}) }) })).data;
}

export async function updateLiveDocumentMetadata(id: string, input: { status: "draft" | "approved" | "stale" | "archived"; lastReviewedAt?: string }) {
  return successEnvelope(documentSchema).parse(await request(`/v1/documents/${encodeURIComponent(id)}/metadata`, { method: "PATCH", body: JSON.stringify(input) })).data;
}

export async function listLiveOutcomes() {
  return successEnvelope(outcomeSchema.array()).parse(await request("/v1/outcomes")).data;
}

export async function createLiveOutcome(input: unknown) {
  const valid = createOutcomeSchema.parse(input);
  return successEnvelope(outcomeSchema).parse(await request("/v1/outcomes", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveOutcome(id: string, input: unknown) {
  const valid = updateOutcomeSchema.parse(input);
  return successEnvelope(outcomeSchema).parse(await request(`/v1/outcomes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveDecisions() {
  return successEnvelope(decisionSchema.array()).parse(await request("/v1/decisions")).data;
}

export async function createLiveDecision(input: unknown) {
  const valid = decisionSchema.omit({ id: true, workspaceId: true, createdAt: true, updatedAt: true }).parse(input);
  return successEnvelope(decisionSchema).parse(await request("/v1/decisions", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveDecision(id: string, input: unknown) {
  const valid = updateDecisionSchema.parse(input);
  return successEnvelope(decisionSchema).parse(await request(`/v1/decisions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveClasses() {
  return successEnvelope(classSchema.array()).parse(await request("/v1/classes")).data;
}

export async function createLiveClass(input: unknown) {
  const valid = classSchema.omit({ id: true, workspaceId: true, createdAt: true, updatedAt: true }).parse(input);
  return successEnvelope(classSchema).parse(await request("/v1/classes", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveClass(id: string, input: unknown) {
  const valid = updateClassSchema.parse(input);
  return successEnvelope(classSchema).parse(await request(`/v1/classes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveClassApplications(classId: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  return pagedSuccessEnvelope(classApplicationSchema).parse(await request(`/v1/classes/${encodeURIComponent(classId)}/applications?${params}`)).data;
}

export async function createLiveClassApplication(classId: string, input: unknown) {
  const valid = classApplicationSchema.pick({ taskId: true, exercise: true, evidenceItemId: true, reviewerId: true }).parse(input);
  return successEnvelope(classApplicationSchema).parse(await request(`/v1/classes/${encodeURIComponent(classId)}/applications`, { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function reviewLiveClassApplication(classId: string, applicationId: string, input: unknown) {
  const valid = reviewClassApplicationSchema.parse(input);
  return successEnvelope(classApplicationSchema).parse(await request(`/v1/classes/${encodeURIComponent(classId)}/applications/${encodeURIComponent(applicationId)}/review`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveInformationRequests() {
  return successEnvelope(informationRequestSchema.array()).parse(await request("/v1/information-requests")).data;
}

export async function createLiveInformationRequest(input: unknown) {
  const valid = informationRequestSchema.omit({ id: true, workspaceId: true, requesterId: true, status: true, responseMarkdown: true, sourceRefs: true, reviewedBy: true, createdAt: true, updatedAt: true }).parse(input);
  return successEnvelope(informationRequestSchema).parse(await request("/v1/information-requests", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveInformationRequest(id: string, input: unknown) {
  const valid = updateInformationRequestSchema.parse(input);
  return successEnvelope(informationRequestSchema).parse(await request(`/v1/information-requests/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLivePipelines() {
  return successEnvelope(pipelineSchema.array()).parse(await request("/v1/pipelines")).data;
}

export async function createLivePipeline(input: unknown) {
  const valid = pipelineInputSchema.parse(input);
  return successEnvelope(pipelineSchema).parse(await request("/v1/pipelines", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLivePipeline(id: string, input: unknown) {
  const valid = updatePipelineSchema.parse(input);
  return successEnvelope(pipelineSchema).parse(await request(`/v1/pipelines/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveOpportunities() {
  return successEnvelope(opportunitySchema.array()).parse(await request("/v1/opportunities")).data;
}

export async function createLiveOpportunity(input: unknown) {
  const valid = opportunityInputSchema.parse(input);
  return successEnvelope(opportunitySchema).parse(await request("/v1/opportunities", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveOpportunity(id: string, input: unknown) {
  const valid = updateOpportunitySchema.parse(input);
  return successEnvelope(opportunitySchema).parse(await request(`/v1/opportunities/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function listLiveMemberships() {
  return successEnvelope(membershipSchema.array()).parse(await request("/v1/admin/memberships")).data;
}

export async function updateLiveMembership(id: string, input: unknown) {
  const valid = updateMembershipSchema.parse(input);
  return successEnvelope(membershipSchema).parse(await request(`/v1/admin/memberships/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(valid) })).data;
}

export async function createLiveChannel(input: unknown) {
  const valid = createChannelSchema.parse(input);
  return successEnvelope(channelSchema).parse(await request("/v1/admin/channels", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function createLiveVenture(input: { name: string; ownerId: string; goal30Day: string }) {
  return successEnvelope(ventureSchema).parse(await request("/v1/admin/ventures", { method: "POST", body: JSON.stringify(input) })).data;
}

/** This person's Claude (MCP) tokens, newest first; secrets are never returned after creation. */
export async function listLivePats() {
  return successEnvelope(patListItemSchema.array()).parse(await request("/v1/pats")).data;
}

/** Creates a token; the secret in `token` is shown once. */
export async function createLivePat(input: { name: string; scopes: string[]; expiresInDays: number }) {
  return successEnvelope(patCreatedSchema).parse(await request("/v1/pats", { method: "POST", body: JSON.stringify(input) })).data;
}

export async function revokeLivePat(id: string) {
  await request(`/v1/pats/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}

/** Archived ventures this person may restore (admins: all; venture heads: their own). */
export async function listArchivedLiveVentures() {
  return successEnvelope(archivedVentureSchema.array()).parse(await request("/v1/ventures/archived")).data;
}

export async function archiveLiveVenture(id: string) {
  await request(`/v1/ventures/${encodeURIComponent(id)}/archive`, { method: "POST" });
}

export async function restoreLiveVenture(id: string) {
  await request(`/v1/ventures/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

/** Permanently deletes an archived venture; `confirmName` must match its name exactly. Returns when recovery copies expire. */
export async function deleteLiveVenture(id: string, confirmName: string) {
  const body = await request(`/v1/ventures/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ confirmName }) });
  return successEnvelope(deletedVentureSchema).parse(body).data;
}

export async function updateLiveVentureGoal(id: string, goal30Day: string) {
  const valid = updateVentureSchema.parse({ goal30Day });
  return successEnvelope(ventureSchema).parse(await request(`/v1/ventures/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

export async function createLiveGroup(input: { ventureId: string; name: string }) {
  return successEnvelope(groupSchema.extend({ channels: channelSchema.array() })).parse(await request("/v1/admin/groups", { method: "POST", body: JSON.stringify(input) })).data;
}

// Calendar: a date range (events and work layers), one event, and the changes people make to events.
export async function loadLiveCalendar(input: { from: string; to: string; scope: string; layers: string[] }) {
  const params = new URLSearchParams({ from: input.from, to: input.to, scope: input.scope, layers: input.layers.join(",") });
  return successEnvelope(calendarRangeSchema).parse(await request(`/v1/calendar?${params}`)).data;
}

export async function getLiveEvent(id: string) {
  return successEnvelope(calendarEventSchema).parse(await request(`/v1/calendar/events/${encodeURIComponent(id)}`)).data;
}

export async function createLiveEvent(input: unknown) {
  const valid = createEventSchema.parse(input);
  return successEnvelope(calendarEventSchema).parse(await request("/v1/calendar/events", { method: "POST", body: JSON.stringify(valid) })).data;
}

export async function updateLiveEvent(id: string, input: unknown) {
  const valid = updateEventSchema.parse(input);
  return successEnvelope(calendarEventSchema).parse(await request(`/v1/calendar/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(valid) })).data;
}

/** Cancels the whole event, or one date of a repeating event (`occurrence` is that date's key). */
export async function cancelLiveEvent(id: string, occurrence?: string) {
  await request(`/v1/calendar/events/${encodeURIComponent(id)}${occurrence ? `?occurrence=${encodeURIComponent(occurrence)}` : ""}`, { method: "DELETE" });
}

export async function respondToLiveEvent(id: string, response: "going" | "maybe" | "declined") {
  return successEnvelope(calendarEventSchema).parse(await request(`/v1/calendar/events/${encodeURIComponent(id)}/respond`, { method: "POST", body: JSON.stringify({ response }) })).data;
}

export async function setLiveEventReminders(id: string, minutes: number[]) {
  return successEnvelope(calendarEventSchema).parse(await request(`/v1/calendar/events/${encodeURIComponent(id)}/reminders`, { method: "PUT", body: JSON.stringify({ minutes }) })).data;
}

export async function getLiveCalendarFeed() {
  return successEnvelope(calendarFeedSchema).parse(await request("/v1/calendar/feed")).data;
}

/** Makes a new private calendar link (any earlier link stops working); the address is shown only now. */
export async function createLiveCalendarFeed() {
  return successEnvelope(calendarFeedSchema).parse(await request("/v1/calendar/feed", { method: "POST", body: "{}" })).data;
}

export async function deleteLiveCalendarFeed() {
  await request("/v1/calendar/feed", { method: "DELETE" });
}

// Venture context: files an agent reads before working on a venture. Admins and the venture's head write them.
export async function listLiveVentureContext(ventureId: string) {
  return successEnvelope(ventureContextListSchema).parse(await request(`/v1/ventures/${encodeURIComponent(ventureId)}/context`)).data;
}
export async function getLiveVentureContext(id: string) {
  return successEnvelope(ventureContextSchema).parse(await request(`/v1/context/${encodeURIComponent(id)}`)).data;
}
export async function createLiveVentureContext(ventureId: string, input: unknown) {
  const valid = createVentureContextSchema.parse(input);
  return successEnvelope(ventureContextSchema).parse(await request(`/v1/ventures/${encodeURIComponent(ventureId)}/context`, { method: "POST", body: JSON.stringify(valid) })).data;
}
export async function updateLiveVentureContext(id: string, input: unknown) {
  const valid = updateVentureContextSchema.parse(input);
  return successEnvelope(ventureContextSchema).parse(await request(`/v1/context/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(valid) })).data;
}
export async function deleteLiveVentureContext(id: string) {
  await request(`/v1/context/${encodeURIComponent(id)}`, { method: "DELETE" });
}
/** The workspace's context: read first for every venture. Admins and people who share knowledge with every venture write it. */
export async function listLiveWorkspaceContext() {
  return successEnvelope(ventureContextListSchema).parse(await request("/v1/workspace/context")).data;
}
export async function createLiveWorkspaceContext(input: unknown) {
  const valid = createVentureContextSchema.parse(input);
  return successEnvelope(ventureContextSchema).parse(await request("/v1/workspace/context", { method: "POST", body: JSON.stringify(valid) })).data;
}

// Skills: the workspace's (every venture) and each venture's own.
export async function listLiveSkills(ventureId?: string) {
  return successEnvelope(skillListSchema).parse(await request(`/v1/skills${ventureId ? `?ventureId=${encodeURIComponent(ventureId)}` : ""}`)).data.items;
}
export async function getLiveSkill(id: string) {
  return successEnvelope(skillSchema).parse(await request(`/v1/skills/${encodeURIComponent(id)}`)).data;
}
export async function createLiveSkill(input: unknown) {
  const valid = createSkillSchema.parse(input);
  return successEnvelope(skillSchema).parse(await request("/v1/skills", { method: "POST", body: JSON.stringify(valid) })).data;
}
/** `ventureId: null` moves the skill to the whole workspace. */
export async function updateLiveSkill(id: string, input: unknown) {
  const valid = updateSkillSchema.parse(input);
  return successEnvelope(skillSchema).parse(await request(`/v1/skills/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(valid) })).data;
}
export async function deleteLiveSkill(id: string) {
  await request(`/v1/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Files shared in a group's chats, and files attached to tasks, newest first.
export async function listLiveGroupAttachments(groupId: string, filters: { channelId?: string; kind?: AttachmentKind; cursor?: string } = {}) {
  const params = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return successEnvelope(sharedAttachmentPageSchema).parse(await request(`/v1/groups/${encodeURIComponent(groupId)}/attachments${params.toString() ? `?${params}` : ""}`)).data;
}
export async function listLiveTaskAttachments(filters: { ventureId?: string; kind?: AttachmentKind; cursor?: string } = {}) {
  const params = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return successEnvelope(sharedAttachmentPageSchema).parse(await request(`/v1/attachments/tasks${params.toString() ? `?${params}` : ""}`)).data;
}
