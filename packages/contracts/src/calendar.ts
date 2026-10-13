import { z } from "zod";
import { idSchema, isoDateSchema, timezoneSchema } from "./common.js";

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
/** private: the organiser and the people they invite. venture / group: everyone who can open that venture or group. */
export const calendarVisibilitySchema = z.enum(["private", "venture", "group"]);
export const eventResponseSchema = z.enum(["pending", "going", "maybe", "declined"]);
export const eventColorSchema = z.enum(["green", "blue", "amber", "violet", "teal", "red", "neutral"]);
export const recurrenceSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly"]), interval: z.number().int().min(1).max(30).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), until: calendarDateSchema.optional(), count: z.number().int().min(1).max(500).optional(),
});
/** Minutes before the start: timed 0–1440; all-day 900 (9:00 the day before) or -540 (9:00 on the day). */
export const TIMED_REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440] as const;
export const ALL_DAY_REMINDER_OPTIONS = [900, -540] as const;
export const reminderMinutesSchema = z.array(z.number().int().min(-540).max(1440)).max(5);

const DAY_MS = 86_400_000;
const eventFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).default(""),
  location: z.string().trim().max(300).default(""),
  meetingUrl: z.url({ protocol: /^https?$/, error: "The meeting link must be an http or https address" }).max(2_000).optional(),
  visibility: calendarVisibilitySchema.default("private"),
  ventureId: idSchema.optional(), groupId: idSchema.optional(),
  allDay: z.boolean().default(false),
  startAt: isoDateSchema.optional(), endAt: isoDateSchema.optional(),
  startDate: calendarDateSchema.optional(), endDate: calendarDateSchema.optional(),
  timezone: timezoneSchema,
  recurrence: recurrenceSchema.nullable().optional(),
  attendeeIds: z.array(idSchema).max(50).default([]),
  reminders: reminderMinutesSchema.optional(),
  color: eventColorSchema.default("green"),
};

type EventShape = { visibility: "private" | "venture" | "group"; ventureId?: string | undefined; groupId?: string | undefined; allDay: boolean; startAt?: string | undefined; endAt?: string | undefined; startDate?: string | undefined; endDate?: string | undefined; reminders?: number[] | undefined; attendeeIds: string[] };
function checkEvent(value: EventShape, context: z.core.$RefinementCtx<unknown>) {
  const issue = (message: string, path: string) => context.addIssue({ code: "custom", message, path: [path] });
  if (value.visibility === "private" && (value.ventureId || value.groupId)) issue("A private event belongs to no venture or group", "visibility");
  if (value.visibility === "venture" && (!value.ventureId || value.groupId)) issue("Choose the venture, and no group, for a venture event", "ventureId");
  if (value.visibility === "group" && (!value.ventureId || !value.groupId)) issue("Choose the venture and the group for a group event", "groupId");
  if (new Set(value.attendeeIds).size !== value.attendeeIds.length) issue("Invite each person once", "attendeeIds");
  if (value.allDay) {
    if (!value.startDate || !value.endDate) return issue("An all-day event needs a start and end date", "startDate");
    const days = (Date.parse(value.endDate) - Date.parse(value.startDate)) / DAY_MS;
    if (!(days >= 1 && days <= 31)) issue("An all-day event lasts 1 to 31 days (the end date is the day after the last day)", "endDate");
    if (value.reminders?.some((minutes) => !(ALL_DAY_REMINDER_OPTIONS as readonly number[]).includes(minutes))) issue("All-day reminders are 9:00 the day before or 9:00 on the day", "reminders");
  } else {
    if (!value.startAt || !value.endAt) return issue("A timed event needs a start and end time", "startAt");
    const minutes = (Date.parse(value.endAt) - Date.parse(value.startAt)) / 60_000;
    if (!(minutes >= 5 && minutes <= 14 * 24 * 60)) issue("An event lasts between 5 minutes and 14 days", "endAt");
    if (value.reminders?.some((item) => !(TIMED_REMINDER_OPTIONS as readonly number[]).includes(item))) issue("Choose reminders from the listed times", "reminders");
  }
}

export const createEventSchema = z.object(eventFields).superRefine(checkEvent);
/** Edits replace the event's fields. `scope: "occurrence"` changes one date of a repeating event (it becomes its own event). */
export const updateEventSchema = z.object({ ...eventFields, scope: z.enum(["series", "occurrence"]).default("series"), occurrenceKey: z.string().max(40).optional(), baseVersion: z.number().int().min(1) }).superRefine(checkEvent);
export const respondToEventSchema = z.object({ response: z.enum(["going", "maybe", "declined"]) });
export const eventRemindersSchema = z.object({ minutes: reminderMinutesSchema });
export const calendarQuerySchema = z.object({
  from: isoDateSchema, to: isoDateSchema,
  // mine: my events and invitations; a venture id: that venture's shared calendar; all: both together.
  scope: z.union([z.enum(["mine", "all"]), idSchema]).default("mine"),
  layers: z.string().max(200).optional(),
});
export const CALENDAR_LAYERS = ["events", "tasks", "reviews", "classes", "requests", "deals", "outcomes"] as const;

export const eventAttendeeSchema = z.object({ userId: idSchema, response: eventResponseSchema, respondedAt: isoDateSchema.optional() });
export const calendarEventSchema = z.object({
  id: idSchema, workspaceId: idSchema, title: z.string(), description: z.string(), location: z.string(), meetingUrl: z.string().optional(),
  visibility: calendarVisibilitySchema, ventureId: idSchema.optional(), groupId: idSchema.optional(), organizerId: idSchema,
  allDay: z.boolean(), startAt: isoDateSchema, endAt: isoDateSchema, startDate: calendarDateSchema.optional(), endDate: calendarDateSchema.optional(),
  timezone: z.string(), recurrence: recurrenceSchema.nullable().optional(), exdates: z.array(z.string()).default([]), seriesId: idSchema.optional(),
  attendees: z.array(eventAttendeeSchema), color: eventColorSchema, version: z.number().int(), createdAt: isoDateSchema, updatedAt: isoDateSchema,
  myResponse: z.union([eventResponseSchema, z.literal("organizer"), z.literal("none")]), myReminders: z.array(z.number().int()), canEdit: z.boolean(),
  via: z.literal("claude").optional(),
});
export const calendarOccurrenceSchema = z.object({
  eventId: idSchema, occurrenceKey: z.string(), title: z.string(), allDay: z.boolean(), startAt: isoDateSchema, endAt: isoDateSchema,
  startDate: calendarDateSchema.optional(), endDate: calendarDateSchema.optional(), visibility: calendarVisibilitySchema,
  ventureId: idSchema.optional(), groupId: idSchema.optional(), color: eventColorSchema, organizerId: idSchema, location: z.string().optional(), hasMeeting: z.boolean(),
  myResponse: z.union([eventResponseSchema, z.literal("organizer"), z.literal("none")]), recurring: z.boolean(), attendeeCount: z.number().int(),
});
export const calendarLayerItemSchema = z.object({
  id: z.string(), kind: z.enum(["task_due", "review", "class", "request_due", "deal_followup", "outcome_review"]), title: z.string(), at: isoDateSchema,
  ventureId: idSchema.optional(), href: z.string(), detail: z.string().optional(),
});
export const calendarRangeSchema = z.object({ events: z.array(calendarOccurrenceSchema), items: z.array(calendarLayerItemSchema), truncated: z.boolean().optional() });
export const calendarFeedSchema = z.object({ enabled: z.boolean(), createdAt: isoDateSchema.optional(), url: z.string().optional() });

export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarOccurrence = z.infer<typeof calendarOccurrenceSchema>;
export type CalendarLayerItem = z.infer<typeof calendarLayerItemSchema>;
