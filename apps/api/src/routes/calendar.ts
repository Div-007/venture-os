import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import type { ClientSession } from "mongodb";
import { z } from "zod";
import { ALL_DAY_REMINDER_OPTIONS, calendarQuerySchema, CALENDAR_LAYERS, createEventSchema, eventRemindersSchema, idSchema, respondToEventSchema, TIMED_REMINDER_OPTIONS, updateEventSchema } from "@venture-studio/contracts";
import { can, eventReminderDocs, eventReminderIdFor, eventReminderStillDue, findOccurrence, localDate, occurrences, recurrenceProblem, reminderPeople, seriesEndsAt, type CalendarTiming, type ReminderEvent } from "@venture-studio/core";
import type { AppDb, AppDocument, Database } from "../db.js";
import { atomic } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { inArchivedVenture } from "../archive-scope.js";
import { listedInOrAdmin } from "../assignable.js";

type Actor = NonNullable<Express.Request["actor"]>;
type Input = z.infer<typeof createEventSchema>;
/** Reminders are planned this far ahead; the worker keeps extending repeating events (see apps/worker). */
export const REMINDER_HORIZON_MS = 3 * 86_400_000;
const MAX_RANGE_MS = 100 * 86_400_000;
const MAX_OCCURRENCES = 2_000;
const MAX_EVENTS = 2_000;
/** Upcoming events one person may organise, so one account can't make the calendar slow for everyone. */
const MAX_LIVE_EVENTS = 1_000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const OPEN_TASK = { $nin: ["done", "cancelled"] };

export const timingOf = (event: AppDocument): CalendarTiming => ({ allDay: Boolean(event.allDay), startAt: new Date(event.startAt), endAt: new Date(event.endAt), ...(event.startDate ? { startDate: String(event.startDate), endDate: String(event.endDate) } : {}), timezone: String(event.timezone), recurrence: event.recurrence ?? null, exdates: (event.exdates ?? []) as string[] });

/** Who sees an event: private ones only the organiser and invitees; shared ones everyone who can open that venture or group. */
export function canSeeEvent(actor: Actor, event: AppDocument): boolean {
  const membership = actor.membership;
  if (event.workspaceId !== membership.workspaceId || event.deletedAt) return false;
  if (event.ventureId && inArchivedVenture(membership, event.ventureId)) return false;
  if (event.visibility === "private") return event.organizerId === actor.id || (event.attendees as { userId: string }[]).some((item) => item.userId === actor.id);
  if (membership.role === "admin") return true;
  if (!membership.ventureIds.includes(String(event.ventureId))) return false;
  return event.visibility === "venture" || membership.groupIds.includes(String(event.groupId));
}

/** The organiser edits their event; on shared calendars an admin or that venture's head may too. */
function canEditEvent(actor: Actor, event: AppDocument): boolean {
  if (!canSeeEvent(actor, event)) return false;
  if (event.organizerId === actor.id) return true;
  return event.visibility !== "private" && (actor.membership.role === "admin" || (actor.membership.role === "venture_head" && actor.membership.ventureIds.includes(String(event.ventureId))));
}

const responseOf = (actor: Actor, event: AppDocument) => event.organizerId === actor.id ? "organizer" : ((event.attendees as { userId: string; response: string }[]).find((item) => item.userId === actor.id)?.response ?? "none");

function eventJson(actor: Actor, event: AppDocument) {
  const myResponse = responseOf(actor, event);
  const reminded = myResponse === "organizer" || (myResponse !== "none" && myResponse !== "declined");
  const myReminders = reminded ? (((event.reminderPrefs ?? []) as { userId: string; minutes: number[] }[]).find((item) => item.userId === actor.id)?.minutes ?? event.defaultReminders) : [];
  return jsonValue({
    id: event._id, workspaceId: event.workspaceId, title: event.title, description: event.description ?? "", location: event.location ?? "", ...(event.meetingUrl ? { meetingUrl: event.meetingUrl } : {}),
    visibility: event.visibility, ...(event.ventureId ? { ventureId: event.ventureId } : {}), ...(event.groupId ? { groupId: event.groupId } : {}), organizerId: event.organizerId,
    allDay: Boolean(event.allDay), startAt: event.startAt, endAt: event.endAt, ...(event.startDate ? { startDate: event.startDate, endDate: event.endDate } : {}), timezone: event.timezone,
    recurrence: event.recurrence ?? null, exdates: event.exdates ?? [], ...(event.seriesId ? { seriesId: event.seriesId } : {}), attendees: event.attendees, color: event.color, version: event.version,
    createdAt: event.createdAt, updatedAt: event.updatedAt, myResponse, myReminders, canEdit: canEditEvent(actor, event), ...(event.via ? { via: event.via } : {}),
  });
}

/** Checks scope, timing, and invitees, and returns the stored fields. `existing` is the event being edited. */
async function prepare(db: AppDb, actor: Actor, input: Input, existing?: AppDocument) {
  const membership = actor.membership;
  if (input.visibility !== "private") {
    const ventureId = input.ventureId!;
    const venture = await db.collection("ventures").findOne({ _id: ventureId, workspaceId: membership.workspaceId, status: { $ne: "archived" } });
    if (!venture || inArchivedVenture(membership, ventureId)) throw new AppError(404, "NOT_FOUND", "Venture not found");
    if (input.groupId && !(await db.collection("groups").findOne({ _id: input.groupId, workspaceId: membership.workspaceId, ventureId }))) throw new AppError(400, "BAD_REQUEST", "That group is not in this venture");
    // Anyone who can post in the venture or group may add to its calendar (learners only read).
    if (!can(membership, "message:write", { ventureId, ...(input.groupId ? { groupId: input.groupId } : {}) })) throw new AppError(403, "FORBIDDEN", `You can't add events to this ${input.groupId ? "group" : "venture"}'s calendar`);
  }
  const startAt = input.allDay ? new Date(`${input.startDate}T00:00:00Z`) : new Date(input.startAt!);
  const endAt = input.allDay ? new Date(`${input.endDate}T00:00:00Z`) : new Date(input.endAt!);
  if (input.recurrence) {
    const problem = recurrenceProblem(input.recurrence, input.allDay ? input.startDate! : localDate(startAt, input.timezone));
    if (problem) throw new AppError(400, "BAD_REQUEST", problem);
  }
  const organizerId = String(existing?.organizerId ?? actor.id);
  const invited = input.attendeeIds.filter((id) => id !== organizerId);
  const previous = new Map(((existing?.attendees ?? []) as { userId: string; response: string; respondedAt?: Date }[]).map((item) => [item.userId, item]));
  // New invitees must be able to open the event. People already invited stay listed if they have since left the venture,
  // so the event can still be edited; reminders and notices skip them (see eventAudience).
  const checked = existing && existing.visibility === input.visibility && existing.ventureId === input.ventureId && existing.groupId === input.groupId ? invited.filter((id) => !previous.has(id)) : invited;
  if (checked.length) {
    const scope = input.visibility === "private" ? {} : listedInOrAdmin(input.ventureId!, input.groupId);
    const found = await db.collection("memberships").countDocuments({ workspaceId: membership.workspaceId, userId: { $in: checked }, status: "active", ...scope });
    if (found !== checked.length) throw new AppError(400, "BAD_REQUEST", input.visibility === "private" ? "Everyone invited must be an active member of the workspace" : `Everyone invited must be able to open this ${input.groupId ? "group" : "venture"}`);
  }
  const allowed: readonly number[] = input.allDay ? ALL_DAY_REMINDER_OPTIONS : TIMED_REMINDER_OPTIONS;
  const keep = (minutes: number[] | undefined) => minutes?.filter((item) => allowed.includes(item));
  const kept = keep(existing?.defaultReminders as number[] | undefined);
  const defaultReminders = input.reminders ?? (kept?.length ? kept : input.allDay ? [900] : [10]);
  // Switching between timed and all-day drops personal reminder choices that no longer fit.
  const reminderPrefs = ((existing?.reminderPrefs ?? []) as { userId: string; minutes: number[] }[]).map((item) => ({ userId: item.userId, minutes: keep(item.minutes) ?? [] })).filter((item) => item.minutes.length || !existing || existing.allDay === input.allDay);
  const fields = {
    title: input.title, description: input.description, location: input.location, ...(input.meetingUrl ? { meetingUrl: input.meetingUrl } : {}),
    visibility: input.visibility, ...(input.visibility !== "private" ? { ventureId: input.ventureId } : {}), ...(input.visibility === "group" ? { groupId: input.groupId } : {}),
    allDay: input.allDay, startAt, endAt, ...(input.allDay ? { startDate: input.startDate, endDate: input.endDate } : {}), timezone: input.timezone,
    recurrence: input.recurrence ?? null, color: input.color, defaultReminders, reminderPrefs,
  };
  const attendees = invited.map((userId) => previous.get(userId) ?? { userId, response: "pending" });
  return { fields, attendees, invitedNow: invited.filter((userId) => !previous.has(userId)) };
}

const exclusions = (fields: { allDay: boolean; startAt: Date; recurrence: unknown; timezone: string }, existing: AppDocument) =>
  // Skipped dates are keyed by start time; they only stay meaningful while the series keeps its timing.
  existing.allDay === fields.allDay && new Date(existing.startAt).getTime() === fields.startAt.getTime() && existing.timezone === fields.timezone && JSON.stringify(existing.recurrence ?? null) === JSON.stringify(fields.recurrence ?? null) ? ((existing.exdates ?? []) as string[]) : [];

/** "Fri 16 Oct, 16:00 (Asia/Kolkata)" for the next occurrence, as invitations and change notices say it. */
function whenText(event: AppDocument, now = new Date()): string {
  const next = occurrences(timingOf(event), now, new Date(8.64e15), 1)[0] ?? occurrences(timingOf(event), new Date(0), new Date(8.64e15), 1)[0];
  if (!next) return "";
  const repeat = event.recurrence ? ` · repeats ${event.recurrence.freq === "daily" ? "daily" : event.recurrence.freq === "weekly" ? "weekly" : "monthly"}` : "";
  if (event.allDay) return `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(next.startAt)} (all day)${repeat}`;
  return `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: String(event.timezone) }).format(next.startAt)} (${event.timezone})${repeat}`;
}

/**
 * Of these people, the ones who can still open the event: active members of the workspace who are its organiser or invited
 * (private events), or listed in its venture (and group) or admins (shared events). The worker has the same rule.
 */
export async function eventAudience(db: AppDb, event: AppDocument, userIds: string[], session?: ClientSession): Promise<Set<string>> {
  const invited = new Set([String(event.organizerId), ...((event.attendees ?? []) as { userId: string }[]).map((item) => item.userId)]);
  const candidates = [...new Set(userIds)].filter((userId) => event.visibility !== "private" || invited.has(userId));
  if (!candidates.length) return new Set();
  const scope = event.visibility === "private" ? {} : listedInOrAdmin(String(event.ventureId), event.visibility === "group" ? String(event.groupId) : undefined);
  const rows = await db.collection("memberships").find({ workspaceId: event.workspaceId, userId: { $in: candidates }, status: "active", ...scope }, { projection: { userId: 1 }, ...(session ? { session } : {}) }).toArray();
  return new Set(rows.map((row) => String(row.userId)));
}

async function notify(db: AppDb, event: AppDocument, all: { userId: string; type: "event_invite" | "event_update" | "event_response"; title: string; body: string; key: string }[], session?: ClientSession) {
  // Someone removed from the venture (or the workspace) since being invited hears nothing more about it.
  const audience = await eventAudience(db, event, all.map((row) => row.userId), session);
  const rows = all.filter((row) => audience.has(row.userId));
  if (!rows.length) return;
  const now = new Date();
  await db.collection("notification_outbox").bulkWrite(rows.map((row) => ({ updateOne: { filter: { idempotencyKey: row.key }, update: { $setOnInsert: { _id: randomUUID(), workspaceId: event.workspaceId, userId: row.userId, type: row.type, title: row.title.slice(0, 200), body: row.body.slice(0, 500), resourceType: "event", resourceId: event._id, ...(event.ventureId ? { ventureId: event.ventureId } : {}), idempotencyKey: row.key, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now } }, upsert: true } })), { session });
}

const nameOf = async (db: AppDb, userId: string) => String((await db.collection("users").findOne({ _id: userId }, { projection: { name: 1 } }))?.name ?? "Someone").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);

/**
 * Re-plans an event's reminders for the next few days, for `users` (everyone when left out) who can still open it.
 * Ids are stable per occurrence, person, and offset across edits: one already delivered is never sent again. A scheduled
 * one (snoozed, perhaps) stays while it still fits the event, by the same test the worker applies before sending.
 */
export async function syncEventReminders(db: AppDb, event: AppDocument, now: Date, session?: ClientSession, users?: string[]): Promise<void> {
  const options = session ? { session } : {};
  const scope = { workspaceId: event.workspaceId, eventId: event._id, ...(users ? { userId: { $in: users } } : {}) };
  const scheduled = await db.collection("reminders").find({ ...scope, state: "scheduled" }, { projection: { userId: 1, occurrenceKey: 1, occurrenceStart: 1, minutes: 1 }, ...options }).toArray();
  const people = event.deletedAt ? [] : reminderPeople(event as unknown as ReminderEvent).map((person) => person.userId).filter((userId) => !users || users.includes(userId));
  const audience = await eventAudience(db, event, [...people, ...scheduled.map((row) => String(row.userId))], session);
  const fits = (row: AppDocument) => !event.deletedAt && audience.has(String(row.userId)) && row._id === eventReminderIdFor(event as unknown as ReminderEvent, row as never, sha) && eventReminderStillDue(event as unknown as ReminderEvent, row as never);
  const stale = scheduled.filter((row) => !fits(row)).map((row) => String(row._id));
  if (stale.length) await db.collection("reminders").deleteMany({ _id: { $in: stale }, state: "scheduled" }, options);
  // Reminder rows follow the event's venture, so deleting a venture it has left doesn't take them along.
  await db.collection("reminders").updateMany({ eventId: event._id, workspaceId: event.workspaceId, ventureId: { $ne: event.ventureId ?? null } }, event.ventureId ? { $set: { ventureId: event.ventureId } } : { $unset: { ventureId: "" } }, options);
  const allowed = people.filter((userId) => audience.has(userId));
  const docs = allowed.length ? eventReminderDocs(event as unknown as ReminderEvent, now, REMINDER_HORIZON_MS, sha, allowed) : [];
  if (!docs.length) return;
  // A reminder the worker dropped because it no longer fitted may fit again (an answer changed back, access restored).
  await db.collection("reminders").deleteMany({ _id: { $in: docs.map((doc) => String(doc._id)) }, state: "cancelled", cancelReason: { $in: ["event_changed", "no_access"] } }, options);
  await db.collection("reminders").bulkWrite(docs.map((doc) => ({ updateOne: { filter: { _id: doc._id as string }, update: { $setOnInsert: doc }, upsert: true } })), options);
}

/** The occurrence of a repeating event a key names (its start instant, or its date for all-day events), or a 404. */
function occurrenceOf(event: AppDocument, key: string) {
  const found = event.recurrence ? findOccurrence(timingOf(event), key) : undefined;
  if (!found) throw new AppError(404, "NOT_FOUND", "That date is not part of this event");
  return found;
}

async function loadEvent(db: AppDb, actor: Actor, id: string): Promise<AppDocument> {
  const event = await db.collection("calendar_events").findOne({ _id: id, workspaceId: actor.membership.workspaceId });
  if (!event || !canSeeEvent(actor, event)) throw new AppError(404, "NOT_FOUND", "Event not found");
  return event;
}

export function calendarRoutes(database: Database): Router {
  const db = database.db;
  const router = Router();

  router.get("/calendar", async (req, res) => {
    const actor = req.actor!; const membership = actor.membership;
    const query = calendarQuerySchema.parse(req.query);
    const from = new Date(query.from); const to = new Date(query.to);
    if (!(to > from) || to.getTime() - from.getTime() > MAX_RANGE_MS) throw new AppError(400, "BAD_REQUEST", "Ask for a range of up to 100 days");
    const layers = new Set(query.layers ? query.layers.split(",").filter((item) => (CALENDAR_LAYERS as readonly string[]).includes(item)) : ["events"]);
    const ventureId = query.scope === "mine" || query.scope === "all" ? undefined : query.scope;
    if (ventureId && (inArchivedVenture(membership, ventureId) || (membership.role !== "admin" && !membership.ventureIds.includes(ventureId)) || !(await db.collection("ventures").findOne({ _id: ventureId, workspaceId: membership.workspaceId })))) throw new AppError(404, "NOT_FOUND", "Venture not found");
    const mine = [{ organizerId: actor.id }, { "attendees.userId": actor.id }];
    const shared = membership.role === "admin" ? [{ visibility: { $in: ["venture", "group"] } }] : [{ visibility: "venture", ventureId: { $in: membership.ventureIds } }, { visibility: "group", groupId: { $in: membership.groupIds } }];
    const ventureEvents = membership.role === "admin" ? { visibility: { $in: ["venture", "group"] } } : { $or: [{ visibility: "venture" }, { visibility: "group", groupId: { $in: membership.groupIds } }] };
    const scope = ventureId ? { ventureId, ...ventureEvents } : { $or: query.scope === "all" ? [...mine, ...shared] : mine };
    const events: Record<string, unknown>[] = []; let truncated = false;
    if (layers.has("events")) {
      const found = await db.collection("calendar_events").find({ workspaceId: membership.workspaceId, deletedAt: { $exists: false }, startAt: { $lt: to }, $and: [{ $or: [{ seriesEndAt: null }, { seriesEndAt: { $gt: from } }] }, scope] }).sort({ startAt: 1, _id: 1 }).limit(MAX_EVENTS).toArray();
      truncated = found.length >= MAX_EVENTS;
      expand: for (const event of found) {
        if (!canSeeEvent(actor, event)) continue;
        for (const item of occurrences(timingOf(event), from, to, Math.min(400, MAX_OCCURRENCES - events.length + 1))) {
          if (events.length >= MAX_OCCURRENCES) { truncated = true; break expand; }
          events.push({ eventId: event._id, occurrenceKey: item.key, title: event.title, allDay: Boolean(event.allDay), startAt: item.startAt.toISOString(), endAt: item.endAt.toISOString(), ...(item.startDate ? { startDate: item.startDate, endDate: item.endDate } : {}), visibility: event.visibility, ...(event.ventureId ? { ventureId: event.ventureId } : {}), ...(event.groupId ? { groupId: event.groupId } : {}), color: event.color, organizerId: event.organizerId, ...(event.location ? { location: event.location } : {}), hasMeeting: Boolean(event.meetingUrl), myResponse: responseOf(actor, event), recurring: Boolean(event.recurrence), attendeeCount: (event.attendees as unknown[]).length });
        }
      }
      events.sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
    }
    res.json({ ok: true, data: { events, items: await layerItems(db, actor, layers, from, to, ventureId), ...(truncated ? { truncated } : {}) } });
  });

  router.get("/calendar/events/:id", async (req, res) => {
    const actor = req.actor!;
    res.json({ ok: true, data: eventJson(actor, await loadEvent(db, actor, idSchema.parse(req.params.id))) });
  });

  router.post("/calendar/events", async (req, res) => {
    const actor = req.actor!;
    const input = createEventSchema.parse(req.body);
    const { fields, attendees } = await prepare(db, actor, input);
    const now = new Date();
    const live = await db.collection("calendar_events").countDocuments({ workspaceId: actor.membership.workspaceId, organizerId: actor.id, deletedAt: { $exists: false }, $or: [{ seriesEndAt: null }, { seriesEndAt: { $gt: now } }] });
    if (live >= MAX_LIVE_EVENTS) throw new AppError(409, "CONFLICT", `You have ${MAX_LIVE_EVENTS.toLocaleString("en")} upcoming events; cancel some before adding more`);
    const event: AppDocument = { _id: randomUUID(), workspaceId: actor.membership.workspaceId, ...fields, organizerId: actor.id, attendees, exdates: [], seriesEndAt: seriesEndsAt(timingOf({ _id: "", ...fields } as AppDocument)), version: 1, ...(req.interfaceChannel === "mcp" ? { via: "claude" } : {}), createdAt: now, updatedAt: now };
    const organizer = await nameOf(db, actor.id);
    await atomic(database, async (session) => {
      await db.collection("calendar_events").insertOne(event, { session });
      await notify(db, event, attendees.map((item) => ({ userId: item.userId, type: "event_invite", title: `Invitation: ${event.title}`, body: `${organizer} invited you · ${whenText(event, now)}`, key: `event:${event._id}:invite:${item.userId}` })), session);
      await syncEventReminders(db, event, now, session);
      await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "calendar.event.create", objectType: "calendar_event", objectId: String(event._id), ...(event.ventureId ? { ventureId: String(event.ventureId) } : {}), result: "success" }, session);
    });
    res.status(201).json({ ok: true, data: eventJson(actor, event) });
  });

  router.patch("/calendar/events/:id", async (req, res) => {
    const actor = req.actor!;
    const existing = await loadEvent(db, actor, idSchema.parse(req.params.id));
    if (!canEditEvent(actor, existing)) throw new AppError(403, "FORBIDDEN", "Only the organiser (or a lead, on a shared calendar) can change this event");
    const input = updateEventSchema.parse(req.body);
    if (input.baseVersion !== existing.version) throw new AppError(409, "CONFLICT", "This event was changed by someone else; reload it before saving");
    const { fields, attendees, invitedNow } = await prepare(db, actor, input, existing);
    const now = new Date();
    const actorName = await nameOf(db, actor.id);
    let result: AppDocument;
    if (input.scope === "occurrence") {
      // One date of a repeating event becomes its own event; the series skips that date.
      if (!existing.recurrence || !input.occurrenceKey) throw new AppError(400, "BAD_REQUEST", "Only one date of a repeating event can be changed on its own");
      occurrenceOf(existing, input.occurrenceKey);
      const single: AppDocument = { _id: randomUUID(), workspaceId: existing.workspaceId, ...fields, recurrence: null, organizerId: existing.organizerId, attendees, exdates: [], seriesId: existing._id, version: 1, createdAt: now, updatedAt: now };
      single.seriesEndAt = seriesEndsAt(timingOf(single));
      await atomic(database, async (session) => {
        const moved = await db.collection("calendar_events").updateOne({ _id: existing._id, version: existing.version }, { $addToSet: { exdates: input.occurrenceKey! }, $set: { updatedAt: now }, $inc: { version: 1 } }, { session });
        if (!moved.matchedCount) throw new AppError(409, "CONFLICT", "This event was changed by someone else; reload it before saving");
        await db.collection("calendar_events").insertOne(single, { session });
        await syncEventReminders(db, { ...existing, exdates: [...(existing.exdates ?? []), input.occurrenceKey!], version: Number(existing.version) + 1 }, now, session);
        await syncEventReminders(db, single, now, session);
        await notify(db, single, attendees.filter((item) => item.userId !== actor.id && item.response !== "declined").map((item) => ({ userId: item.userId, type: "event_update", title: `Updated: ${single.title}`, body: `${actorName} changed one date · now ${whenText(single, now)}`, key: `event:${single._id}:v1:update:${item.userId}` })), session);
        await audit(db, { workspaceId: existing.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "calendar.event.update_occurrence", objectType: "calendar_event", objectId: String(existing._id), ...(existing.ventureId ? { ventureId: String(existing.ventureId) } : {}), result: "success" }, session);
      });
      result = single;
    } else {
      const version = Number(existing.version) + 1;
      const updated: AppDocument = { ...existing, ...fields, attendees, exdates: exclusions(fields, existing), version, updatedAt: now };
      if (existing.visibility !== "private" && fields.visibility === "private") delete updated.ventureId;
      if (fields.visibility !== "group") delete updated.groupId;
      if (!fields.meetingUrl) delete updated.meetingUrl;
      if (!fields.startDate) { delete updated.startDate; delete updated.endDate; }
      updated.seriesEndAt = seriesEndsAt(timingOf(updated));
      const timingChanged = JSON.stringify(timingOf(existing)) !== JSON.stringify(timingOf(updated)) || existing.location !== updated.location || existing.meetingUrl !== updated.meetingUrl || existing.title !== updated.title;
      await atomic(database, async (session) => {
        const { _id: _ignored, ...rest } = updated;
        // updatedAt too: an answer or reminder choice saved since this request read the event must not be overwritten.
        const replaced = await db.collection("calendar_events").replaceOne({ _id: existing._id, version: existing.version, updatedAt: existing.updatedAt }, rest, { session });
        if (!replaced.matchedCount) throw new AppError(409, "CONFLICT", "This event was changed by someone else; reload it before saving");
        await syncEventReminders(db, updated, now, session);
        await notify(db, updated, [
          ...invitedNow.map((userId) => ({ userId, type: "event_invite" as const, title: `Invitation: ${updated.title}`, body: `${actorName} invited you · ${whenText(updated, now)}`, key: `event:${updated._id}:v${version}:invite:${userId}` })),
          ...(timingChanged ? attendees.filter((item) => !invitedNow.includes(item.userId) && item.userId !== actor.id && item.response !== "declined").map((item) => ({ userId: item.userId, type: "event_update" as const, title: `Updated: ${updated.title}`, body: `${actorName} changed it · ${whenText(updated, now)}`, key: `event:${updated._id}:v${version}:update:${item.userId}` })) : []),
          ...(timingChanged && existing.organizerId !== actor.id ? [{ userId: String(existing.organizerId), type: "event_update" as const, title: `Updated: ${updated.title}`, body: `${actorName} changed your event · ${whenText(updated, now)}`, key: `event:${updated._id}:v${version}:update:${existing.organizerId}` }] : []),
        ], session);
        await audit(db, { workspaceId: existing.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: "calendar.event.update", objectType: "calendar_event", objectId: String(existing._id), ...(updated.ventureId ? { ventureId: String(updated.ventureId) } : {}), result: "success" }, session);
      });
      result = updated;
    }
    res.json({ ok: true, data: eventJson(actor, result) });
  });

  router.delete("/calendar/events/:id", async (req, res) => {
    const actor = req.actor!;
    const existing = await loadEvent(db, actor, idSchema.parse(req.params.id));
    if (!canEditEvent(actor, existing)) throw new AppError(403, "FORBIDDEN", "Only the organiser (or a lead, on a shared calendar) can cancel this event");
    const { occurrence } = z.object({ occurrence: z.string().max(40).optional() }).parse(req.query);
    const now = new Date(); const version = Number(existing.version) + 1;
    const actorName = await nameOf(db, actor.id);
    const people = [...(existing.attendees as { userId: string; response: string }[]).filter((item) => item.response !== "declined").map((item) => item.userId), String(existing.organizerId)].filter((userId) => userId !== actor.id);
    await atomic(database, async (session) => {
      let changed;
      if (occurrence) {
        occurrenceOf(existing, occurrence);
        changed = await db.collection("calendar_events").updateOne({ _id: existing._id, version: existing.version }, { $addToSet: { exdates: occurrence }, $set: { updatedAt: now, version } }, { session });
      } else changed = await db.collection("calendar_events").updateOne({ _id: existing._id, version: existing.version }, { $set: { deletedAt: now, deletedBy: actor.id, updatedAt: now, version } }, { session });
      if (!changed.matchedCount) throw new AppError(409, "CONFLICT", "This event was changed by someone else; reload it first");
      const after = occurrence ? { ...existing, exdates: [...(existing.exdates ?? []), occurrence], version } : { ...existing, deletedAt: now, version };
      await syncEventReminders(db, after, now, session);
      const date = occurrence ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: occurrence.length === 10 ? "UTC" : String(existing.timezone) }).format(new Date(occurrence.length === 10 ? `${occurrence}T00:00:00Z` : occurrence)) : "";
      await notify(db, existing, [...new Set(people)].map((userId) => ({ userId, type: "event_update", title: `Cancelled: ${existing.title}`, body: occurrence ? `${actorName} cancelled the ${date} date` : `${actorName} cancelled this event`, key: `event:${existing._id}:v${version}:cancel:${userId}` })), session);
      await audit(db, { workspaceId: existing.workspaceId, actorId: actor.id, channel: req.interfaceChannel, action: occurrence ? "calendar.event.cancel_occurrence" : "calendar.event.cancel", objectType: "calendar_event", objectId: String(existing._id), ...(existing.ventureId ? { ventureId: String(existing.ventureId) } : {}), result: "success" }, session);
    });
    res.json({ ok: true, data: { cancelled: true, ...(occurrence ? { occurrence } : {}) } });
  });

  router.post("/calendar/events/:id/respond", async (req, res) => {
    const actor = req.actor!;
    const event = await loadEvent(db, actor, idSchema.parse(req.params.id));
    const { response } = respondToEventSchema.parse(req.body);
    if (event.organizerId === actor.id) throw new AppError(400, "BAD_REQUEST", "You're organising this event");
    const invited = (event.attendees as { userId: string }[]).some((item) => item.userId === actor.id);
    // Anyone who can see a shared event may say whether they're coming; private ones only take answers from invitees.
    if (!invited && event.visibility === "private") throw new AppError(404, "NOT_FOUND", "Event not found");
    const now = new Date();
    const name = await nameOf(db, actor.id);
    const updated = await atomic(database, async (session) => {
      const change = invited
        ? await db.collection("calendar_events").findOneAndUpdate({ _id: event._id, deletedAt: { $exists: false }, "attendees.userId": actor.id }, { $set: { "attendees.$.response": response, "attendees.$.respondedAt": now, updatedAt: now } }, { returnDocument: "after", session })
        : await db.collection("calendar_events").findOneAndUpdate({ _id: event._id, deletedAt: { $exists: false }, "attendees.userId": { $ne: actor.id }, "attendees.49": { $exists: false } }, { $push: { attendees: { userId: actor.id, response, respondedAt: now } }, $set: { updatedAt: now } } as never, { returnDocument: "after", session });
      if (!change) throw new AppError(409, "CONFLICT", "This event changed (or is full); reload it");
      await syncEventReminders(db, change, now, session, [actor.id]);
      const label = { going: "is going to", maybe: "might go to", declined: "can't make" }[response];
      await notify(db, change, [{ userId: String(change.organizerId), type: "event_response", title: `${name} ${label} ${change.title}`, body: whenText(change, now), key: `event:${change._id}:response:${actor.id}:${now.getTime()}` }], session);
      return change;
    });
    res.json({ ok: true, data: eventJson(actor, updated) });
  });

  router.put("/calendar/events/:id/reminders", async (req, res) => {
    const actor = req.actor!;
    const event = await loadEvent(db, actor, idSchema.parse(req.params.id));
    const { minutes } = eventRemindersSchema.parse(req.body);
    const response = responseOf(actor, event);
    if (response === "none" || response === "declined") throw new AppError(400, "BAD_REQUEST", "Answer Going or Maybe to get reminders for this event");
    const allowed: readonly number[] = event.allDay ? ALL_DAY_REMINDER_OPTIONS : TIMED_REMINDER_OPTIONS;
    if (minutes.some((item) => !allowed.includes(item))) throw new AppError(400, "BAD_REQUEST", event.allDay ? "All-day reminders are 9:00 the day before or 9:00 on the day" : "Choose reminders from the listed times");
    const now = new Date();
    const updated = await atomic(database, async (session) => {
      await db.collection("calendar_events").updateOne({ _id: event._id }, { $pull: { reminderPrefs: { userId: actor.id } } } as never, { session });
      const change = await db.collection("calendar_events").findOneAndUpdate({ _id: event._id, deletedAt: { $exists: false } }, { $push: { reminderPrefs: { userId: actor.id, minutes: [...new Set(minutes)] } }, $set: { updatedAt: now } } as never, { returnDocument: "after", session });
      if (!change) throw new AppError(404, "NOT_FOUND", "Event not found");
      await syncEventReminders(db, change, now, session, [actor.id]);
      return change;
    });
    res.json({ ok: true, data: eventJson(actor, updated) });
  });

  return router;
}

/** Existing work shown on the calendar, read-only: deadlines, reviews, classes, requests, deal follow-ups, outcome reviews. */
export async function layerItems(db: AppDb, actor: Actor, layers: Set<string>, from: Date, to: Date, ventureId?: string) {
  const membership = actor.membership; const workspaceId = membership.workspaceId;
  const range = { $gte: from, $lt: to };
  const notArchived = membership.archivedVentureIds?.length ? { ventureId: { $nin: membership.archivedVentureIds } } : {};
  // As on the task list: outside admins, only ventures (and groups) the person is still listed in.
  const listed = membership.role === "admin" ? notArchived : { ventureId: { $in: membership.ventureIds.filter((id) => !inArchivedVenture(membership, id)) } };
  const venture = ventureId ? { ventureId } : listed;
  const groupScope = membership.role === "admin" ? {} : { groupId: { $in: membership.groupIds } };
  const items: { id: string; kind: string; title: string; at: string; ventureId?: string; href: string; detail?: string }[] = [];
  const push = (kind: string, rows: AppDocument[], at: (row: AppDocument) => unknown, href: (row: AppDocument) => string, detail?: (row: AppDocument) => string | undefined) => {
    for (const row of rows) { const when = at(row); if (!when) continue; items.push({ id: `${kind}:${row._id}`, kind, title: String(row.title ?? row.companyName ?? ""), at: new Date(when as string).toISOString(), ...(row.ventureId ? { ventureId: String(row.ventureId) } : {}), href: href(row), ...(detail?.(row) ? { detail: detail(row) } : {}) }); }
  };
  const tasks = (id: unknown) => `/tasks/live?task=${encodeURIComponent(String(id))}`;
  const jobs: Promise<void>[] = [];
  if (layers.has("tasks")) jobs.push(db.collection("tasks").find({ workspaceId, ...venture, ...groupScope, ...(ventureId ? {} : { assigneeId: actor.id }), status: OPEN_TASK, dueAt: range }).limit(500).toArray().then((rows) => push("task_due", rows, (row) => row.dueAt, (row) => tasks(row._id), (row) => String(row.status))));
  // A review is due at the task's review time, or its due time when it has none.
  if (layers.has("reviews")) jobs.push(db.collection("tasks").find({ workspaceId, ...venture, ...groupScope, reviewerId: actor.id, status: "review", $or: [{ reviewAt: range }, { reviewAt: { $exists: false }, dueAt: range }] }).limit(200).toArray().then((rows) => push("review", rows, (row) => row.reviewAt ?? row.dueAt, (row) => tasks(row._id))));
  // As on the Classes page: leads see every class of their venture, everyone else the ones they take part in.
  const lead = membership.role === "admin" || (membership.role === "venture_head" && Boolean(ventureId) && membership.ventureIds.includes(ventureId!));
  if (layers.has("classes")) jobs.push(db.collection("classes").find({ workspaceId, ...venture, ...(lead ? {} : { $or: [{ participantIds: actor.id }, { facilitatorId: actor.id }] }), status: { $ne: "cancelled" }, scheduledAt: range }).limit(200).toArray().then((rows) => push("class", rows, (row) => row.scheduledAt, () => "/classes/live", (row) => `${row.durationMinutes} min`)));
  if (layers.has("requests")) jobs.push(db.collection("information_requests").find({ workspaceId, ...venture, $or: [{ respondentId: actor.id }, { requesterId: actor.id }], status: { $in: ["open", "answered"] }, dueAt: range }).limit(200).toArray().then((rows) => push("request_due", rows.map((row) => ({ ...row, title: row.question })), (row) => row.dueAt, () => "/requests/live", (row) => row.respondentId === actor.id ? "Asked of you" : "You asked")));
  if (layers.has("deals")) jobs.push((async () => {
    const pipelines = await db.collection("pipelines").find({ workspaceId, ...(ventureId ? { ventureId } : membership.role === "admin" ? notArchived : { ventureId: { $in: membership.ventureIds } }) }).project({ _id: 1 }).toArray();
    const rows = await db.collection("opportunities").find({ pipelineId: { $in: pipelines.map((row) => row._id) }, ...(ventureId ? {} : { ownerId: actor.id }), stage: { $nin: ["lost", "disqualified", "won", "invoice_contract", "cash_collected", "delivery", "retained_referred"] }, deletedAt: null, nextActionAt: range }).limit(200).toArray();
    push("deal_followup", rows, (row) => row.nextActionAt, () => "/sales/live", (row) => String(row.nextAction ?? "") || undefined);
  })());
  if (layers.has("outcomes") && ventureId) jobs.push(db.collection("outcomes").find({ workspaceId, ventureId, status: { $in: ["approved", "active", "at_risk"] }, reviewAt: range }).limit(100).toArray().then((rows) => push("outcome_review", rows, (row) => row.reviewAt, () => "/planning/live")));
  await Promise.all(jobs);
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

