import { z } from "zod";
import { clip, compact, localTime, ToolError, UNTRUSTED_NOTE, validTimeZone } from "./format.js";
import { id, isoField, type Look, once, READ_ONLY, type Register, requestIdField, timezoneField, type ToolContext, writes } from "./kit.js";

const eventLink = (ctx: ToolContext, eventId: string) => `${ctx.origin}/calendar/live?event=${encodeURIComponent(eventId)}`;
const DAY_MS = 86_400_000;
const KIND: Record<string, string> = { task_due: "task due", review: "review due", class: "class", request_due: "information request due", deal_followup: "deal follow-up", outcome_review: "outcome review" };

/** Calendar: what's coming up, scheduling, and answering invitations. */
export function registerCalendarTools(tool: Register, ctx: ToolContext, look: Look): void {
  tool("list_events", "calendar:read", {
    title: "List calendar events", annotations: READ_ONLY,
    description: "Calendar events between two times (default: the next 7 days): my events and invitations, a venture's shared calendar, or both. includeWork adds my task deadlines, reviews, classes, requests, and deal follow-ups.",
    inputSchema: z.object({
      from: isoField("Start of the range, ISO 8601 with offset (default now)").optional(), to: isoField("End of the range (default 7 days after from; at most 100 days)").optional(),
      scope: z.union([z.enum(["mine", "all"]), id]).default("mine").describe('"mine", "all", or a venture id for that venture\'s shared calendar'),
      includeWork: z.boolean().default(false), timezone: timezoneField,
    }),
  }, async ({ from, to, scope, includeWork, timezone }) => {
    const timeZone = validTimeZone(timezone);
    const start = from ? new Date(from) : new Date(); const end = to ? new Date(to) : new Date(start.getTime() + 7 * DAY_MS);
    const params = new URLSearchParams({ from: start.toISOString(), to: end.toISOString(), scope, layers: includeWork ? "events,tasks,reviews,classes,requests,deals,outcomes" : "events" });
    const data = await ctx.api<{ events: any[]; items: any[]; truncated?: boolean }>("GET", `/calendar?${params}`);
    const { ventures } = await look.ventures();
    const when = (item: any) => item.allDay ? `${item.startDate} (all day${item.endDate && item.endDate !== nextDay(item.startDate) ? ` until ${previousDay(item.endDate)}` : ""})` : `${localTime(item.startAt, timeZone)} – ${localTime(item.endAt, timeZone)?.slice(11)}`;
    return compact({
      timezone: timeZone,
      events: data.events.slice(0, 100).map((item) => compact({ eventId: item.eventId, title: clip(item.title, 160), when: when(item), venture: item.ventureId ? ventures.get(item.ventureId)?.name : undefined, visibility: item.visibility, me: item.myResponse === "none" ? undefined : item.myResponse, repeats: item.recurring || undefined, where: clip(item.location, 120), meeting: item.hasMeeting || undefined, occurrence: item.recurring ? item.occurrenceKey : undefined, url: eventLink(ctx, item.eventId) })),
      work: data.items.slice(0, 100).map((item) => compact({ kind: KIND[item.kind] ?? item.kind, title: clip(item.title, 160), at: localTime(item.at, timeZone), venture: item.ventureId ? ventures.get(item.ventureId)?.name : undefined, url: `${ctx.origin}${item.href}` })),
      truncated: data.truncated || data.events.length > 100 || undefined, note: data.events.length || data.items.length ? UNTRUSTED_NOTE : undefined,
      hint: data.events.length || data.items.length ? undefined : "Nothing on the calendar in this range.",
    });
  });

  tool("create_event", "calendar:write", {
    title: "Create calendar event", annotations: writes(false),
    description: "Schedule an event. Without ventureId it is private (only me and the people invited); with ventureId it goes on that venture's shared calendar (add groupId for one group only). Invited people (ids from find_person) are notified and can answer Going, Maybe, or No. For all-day events give date (and optionally endDate, the last day). repeat makes it repeat daily, weekly (on weekdays 0 = Sunday … 6 = Saturday), or monthly.",
    inputSchema: z.object({
      title: z.string().trim().min(1).max(200),
      start: isoField("Start time, ISO 8601 with offset, e.g. 2026-10-16T16:00:00+05:30").optional(), durationMinutes: z.number().int().min(5).max(14 * 24 * 60).default(30),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("For an all-day event: its day (YYYY-MM-DD)"), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day of a multi-day all-day event"),
      ventureId: id.optional(), groupId: id.optional(), invite: z.array(id).max(50).optional(),
      location: z.string().trim().max(300).optional(), meetingUrl: z.url({ protocol: /^https?$/ }).max(2000).optional(), description: z.string().trim().max(5000).optional(),
      repeat: z.object({ freq: z.enum(["daily", "weekly", "monthly"]), interval: z.number().int().min(1).max(30).default(1), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), count: z.number().int().min(1).max(500).optional() }).optional(),
      reminders: z.array(z.number().int()).max(5).optional().describe("Minutes before: 0, 5, 10, 15, 30, 60, 120, or 1440 (all-day: 900 = 9:00 the day before, -540 = 9:00 on the day)"),
      timezone: z.string().max(60).describe("My IANA time zone, e.g. Asia/Kolkata: repeats keep this local time").default("UTC"), requestId: requestIdField,
    }),
  }, async (input) => {
    // Each event can invite up to 50 people, so creation is paced like messages.
    await ctx.toolBudget("create_event", 10);
    const timeZone = validTimeZone(input.timezone);
    if (!input.start === !input.date) throw new ToolError("Give either start (a timed event) or date (an all-day event).");
    if (input.groupId && !input.ventureId) throw new ToolError("A group event needs its ventureId too.");
    const body = {
      title: input.title, description: input.description ?? "", location: input.location ?? "", ...(input.meetingUrl ? { meetingUrl: input.meetingUrl } : {}),
      visibility: input.groupId ? "group" : input.ventureId ? "venture" : "private", ...(input.ventureId ? { ventureId: input.ventureId } : {}), ...(input.groupId ? { groupId: input.groupId } : {}),
      allDay: Boolean(input.date), ...(input.date ? { startDate: input.date, endDate: nextDay(input.endDate ?? input.date) } : { startAt: new Date(input.start!).toISOString(), endAt: new Date(new Date(input.start!).getTime() + input.durationMinutes * 60_000).toISOString() }),
      timezone: timeZone, recurrence: input.repeat ?? null, attendeeIds: input.invite ?? [], ...(input.reminders ? { reminders: input.reminders } : {}),
    };
    return once(ctx, "create_event", input.requestId, body, async () => {
      const event = await ctx.api<any>("POST", "/calendar/events", body);
      return compact({ eventId: event.id, title: event.title, when: event.allDay ? `${event.startDate} (all day)` : localTime(event.startAt, timeZone), visibility: event.visibility, invited: event.attendees.length || undefined, repeats: event.recurrence ? event.recurrence.freq : undefined, url: eventLink(ctx, event.id) });
    });
  });

  tool("respond_to_event", "calendar:write", {
    title: "Answer invitation", annotations: writes(true),
    description: "Say whether I'm coming to an event (Going, Maybe, or No). On a venture's shared calendar this also joins an event I wasn't invited to; No stops its reminders.",
    inputSchema: z.object({ eventId: id, response: z.enum(["going", "maybe", "declined"]) }),
  }, async ({ eventId, response }) => {
    const event = await ctx.api<any>("POST", `/calendar/events/${encodeURIComponent(eventId)}/respond`, { response });
    return { eventId, title: event.title, response: event.myResponse, url: eventLink(ctx, eventId) };
  });
}

const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const previousDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
