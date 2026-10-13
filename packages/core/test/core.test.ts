import assert from "node:assert/strict";
import test from "node:test";
import type { Membership } from "@venture-studio/contracts";
import { can, createPat, dmKey, eventReminderId, eventReminderStillDue, eventReminderText, findOccurrence, hasDeadlineRisk, isTrustedPushEndpoint, isTimeZone, matchesPat, occurrences, occurrenceStartsAt, parseCommand, planReminders, previewCommand, recurrenceProblem, seriesEndsAt, snoozeReminder, validateMembershipSubset, type CalendarTiming, type ReminderEvent } from "../src/index.js";

test("push endpoints are limited to HTTPS browser push providers", () => {
  for (const endpoint of ["https://fcm.googleapis.com/fcm/send/token", "https://updates.push.services.mozilla.com/wpush/v2/token", "https://web.push.apple.com/abc", "https://db3.notify.windows.com/?token=abc"]) assert.equal(isTrustedPushEndpoint(endpoint), true);
  for (const endpoint of ["http://fcm.googleapis.com/fcm/send/token", "https://fcm.googleapis.com:8443/fcm/send/token", "https://fcm.googleapis.com/fcm/send/token#alternate-owner", "https://127.0.0.1/", "https://fcm.googleapis.com.evil.test/", "https://private.test/", "file:///etc/passwd", "javascript:alert(1)"]) assert.equal(isTrustedPushEndpoint(endpoint), false);
});

const ids = {
  membership: "10000000-0000-4000-8000-000000000001",
  workspace: "10000000-0000-4000-8000-000000000002",
  user: "10000000-0000-4000-8000-000000000003",
  venture: "10000000-0000-4000-8000-000000000004",
  group: "10000000-0000-4000-8000-000000000005",
};
const membership: Membership = { id: ids.membership, workspaceId: ids.workspace, userId: ids.user, role: "contributor", ventureIds: [ids.venture], groupIds: [ids.group], createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };

test("permissions require role and scope, while DMs remain workspace-wide", () => {
  assert.equal(can(membership, "task:update", { ventureId: ids.venture, groupId: ids.group }), true);
  assert.equal(can(membership, "task:review", { ventureId: ids.venture }), false);
  assert.equal(can(membership, "venture:read", { ventureId: "20000000-0000-4000-8000-000000000004" }), false);
  assert.equal(validateMembershipSubset(membership, [{ id: ids.group, ventureId: ids.venture }]), true);
  assert.equal(dmKey("b", "a"), "a:b");
});

test("commands parse into typed, expiring previews with deadline warnings", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const command = parseCommand('/notify @alex "Review this" at=2026-09-23T11:00:00Z timezone=Asia/Kolkata', now);
  assert.equal(command.kind, "notify");
  assert.deepEqual(parseCommand('/notify @alex 1h "Review a=b"', now), { kind: "notify", recipient: "alex", message: "Review a=b", scheduledAt: "2026-09-23T11:00:00.000Z", timezone: "UTC" });
  assert.equal(parseCommand('/notify @alex 10m "Review"', now).kind, "notify");
  assert.deepEqual(parseCommand('/assign @alex "Ship API" "90m" 2026-09-23T12:00:00Z', now), { kind: "assign", assignee: "alex", title: "Ship API", dueAt: "2026-09-23T12:00:00.000Z", estimatedMinutes: 90, timezone: "UTC" });
  assert.equal((parseCommand('/assign @alex "Ship API" 1h 2026-09-23T12:00:00Z', now) as any).estimatedMinutes, 60);
  const preview = previewCommand('/assign @alex "Ship API" due=2026-09-23T10:30:00Z estimate=60 timezone=UTC', now);
  assert.equal(preview.warnings.length, 1);
  for (const input of ['/notify @alex 0h "Review"', '/notify @alex 1.5h "Review"', '/notify @alex 1d "Review"', '/notify @alex 1h"Review"', '/notify @alex 1h "Review" at=2026-09-23T11:00:00Z', '/assign @alex "Ship" 1h 2026-09-23T09:00:00Z', '/assign @alex "Ship" 1h tomorrow', '/assign @alex "Ship" 1h 2026-09-23T12:00:00Z due=2026-09-23T12:00:00Z']) {
    assert.throws(() => previewCommand(input, now));
  }
});

test("reminders and PATs use deterministic boundary rules", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  assert.equal(hasDeadlineRisk("2026-09-23T10:30:00.000Z", 60, now), true);
  assert.equal(hasDeadlineRisk("2026-09-23T11:00:00.000Z", 60, now), true);
  assert.equal(hasDeadlineRisk("2026-09-23T11:00:00.001Z", 60, now), false);
  assert.equal(snoozeReminder(new Date("2026-11-01T05:55:00.000Z"), 10)?.toISOString(), "2026-11-01T06:05:00.000Z");
  assert.equal(snoozeReminder(now, 20)?.toISOString(), "2026-09-23T10:20:00.000Z");
  assert.equal(snoozeReminder(now, "never"), null);
  // Snoozing a reminder that is still weeks away postpones it from its own time instead of pulling it earlier.
  assert.equal(snoozeReminder(now, 30, "2026-10-25T10:30:00.000Z")?.toISOString(), "2026-10-25T11:00:00.000Z");
  assert.equal(snoozeReminder(now, 30, new Date("2026-09-01T00:00:00.000Z"))?.toISOString(), "2026-09-23T10:30:00.000Z");
  const pat = createPat();
  assert.equal(matchesPat(pat.token, pat.hash), true);
  assert.equal(matchesPat(`${pat.token}x`, pat.hash), false);
});

test("calendar: repeats keep their local time across zones and DST, honour weekdays, ends, counts, and skips", () => {
  const at = (iso: string) => new Date(iso);
  // Weekly on Mon/Wed/Fri at 10:00 in Kolkata, starting Monday 2026-10-12.
  const standup: CalendarTiming = { allDay: false, startAt: at("2026-10-12T04:30:00Z"), endAt: at("2026-10-12T04:45:00Z"), timezone: "Asia/Kolkata", recurrence: { freq: "weekly", interval: 1, weekdays: [1, 3, 5] } };
  const week = occurrences(standup, at("2026-10-12T00:00:00Z"), at("2026-10-19T00:00:00Z"));
  assert.deepEqual(week.map((item) => item.key), ["2026-10-12T04:30:00.000Z", "2026-10-14T04:30:00.000Z", "2026-10-16T04:30:00.000Z"]);
  assert.equal(week[0]!.endAt.toISOString(), "2026-10-12T04:45:00.000Z");
  // Endless series skip ahead: a range two years later still finds that week's three.
  assert.equal(occurrences(standup, at("2028-10-09T00:00:00Z"), at("2028-10-16T00:00:00Z")).length, 3);
  // 09:00 in New York stays 09:00 across the November DST change (UTC 13:00, then 14:00).
  const ny: CalendarTiming = { allDay: false, startAt: at("2026-10-29T13:00:00Z"), endAt: at("2026-10-29T14:00:00Z"), timezone: "America/New_York", recurrence: { freq: "daily", interval: 1 } };
  assert.deepEqual(occurrences(ny, at("2026-10-31T00:00:00Z"), at("2026-11-03T00:00:00Z")).map((item) => item.key), ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z"]);
  // until (inclusive), count (skipped occurrences still count), and exdates.
  const daily: CalendarTiming = { allDay: false, startAt: at("2026-10-12T04:30:00Z"), endAt: at("2026-10-12T05:00:00Z"), timezone: "Asia/Kolkata", recurrence: { freq: "daily", interval: 2, until: "2026-10-18" } };
  assert.deepEqual(occurrences(daily, at("2026-10-01T00:00:00Z"), at("2026-11-01T00:00:00Z")).map((item) => item.key.slice(0, 10)), ["2026-10-12", "2026-10-14", "2026-10-16", "2026-10-18"]);
  const counted = { ...daily, recurrence: { freq: "daily" as const, interval: 1, count: 3 }, exdates: ["2026-10-13T04:30:00.000Z"] };
  assert.deepEqual(occurrences(counted, at("2026-10-01T00:00:00Z"), at("2026-11-01T00:00:00Z")).map((item) => item.key.slice(0, 10)), ["2026-10-12", "2026-10-14"]);
  assert.equal(seriesEndsAt(counted)?.toISOString(), "2026-10-14T05:00:00.000Z");
  assert.equal(seriesEndsAt(standup), null);
  // An until-bounded series ends on its last day however long it runs (no 500-occurrence cut-off).
  const yearsLong = { ...daily, recurrence: { freq: "daily" as const, interval: 1, until: "2029-03-01" } };
  assert.equal(seriesEndsAt(yearsLong)?.toISOString(), "2029-03-01T19:00:00.000Z");
  assert.ok(seriesEndsAt(yearsLong)! >= occurrences(yearsLong, at("2029-02-28T00:00:00Z"), at("2029-03-05T00:00:00Z")).at(-1)!.endAt);
  // A one-off all-day date stays visible to a viewer west of UTC on its last evening.
  assert.equal(seriesEndsAt({ allDay: true, startAt: at("2026-10-15T00:00:00Z"), endAt: at("2026-10-16T00:00:00Z"), startDate: "2026-10-15", endDate: "2026-10-16", timezone: "UTC" })?.toISOString(), "2026-10-16T14:00:00.000Z");
  // A three-day event repeating daily overlaps itself; each date can still be found by its key.
  const overlapping: CalendarTiming = { ...daily, endAt: at("2026-10-15T04:30:00Z"), recurrence: { freq: "daily", interval: 1 } };
  assert.equal(findOccurrence(overlapping, "2026-10-20T04:30:00.000Z")?.endAt.toISOString(), "2026-10-23T04:30:00.000Z");
  assert.equal(findOccurrence(overlapping, "2026-10-20T05:30:00.000Z"), undefined);
  assert.equal(findOccurrence(overlapping, "not-a-date"), undefined);
  // Monthly on the 31st skips shorter months.
  const monthly: CalendarTiming = { allDay: false, startAt: at("2026-08-31T10:00:00Z"), endAt: at("2026-08-31T11:00:00Z"), timezone: "UTC", recurrence: { freq: "monthly", interval: 1 } };
  assert.deepEqual(occurrences(monthly, at("2026-08-01T00:00:00Z"), at("2027-01-01T00:00:00Z")).map((item) => item.key.slice(0, 10)), ["2026-08-31", "2026-10-31", "2026-12-31"]);
  // All-day: dates, end exclusive, repeating weekly, found from any zone's view of that day.
  const offsite: CalendarTiming = { allDay: true, startAt: at("2026-10-15T00:00:00Z"), endAt: at("2026-10-17T00:00:00Z"), startDate: "2026-10-15", endDate: "2026-10-17", timezone: "Asia/Kolkata", recurrence: { freq: "weekly", interval: 1 } };
  const days = occurrences(offsite, at("2026-10-14T18:30:00Z"), at("2026-10-28T18:30:00Z"));
  // The server answers with a margin (an all-day date starts 14 hours earlier in UTC+14); the screen keeps the days it shows.
  assert.deepEqual(days.slice(0, 2).map((item) => [item.startDate, item.endDate]), [["2026-10-15", "2026-10-17"], ["2026-10-22", "2026-10-24"]]);
  assert.ok(days.every((item) => item.startDate! <= "2026-10-29"));
  assert.equal(occurrenceStartsAt(offsite, days[0]!).toISOString(), "2026-10-14T18:30:00.000Z");
  assert.equal(recurrenceProblem({ freq: "daily", interval: 0 }, "2026-10-12"), "Repeat every 1 to 30 days, weeks, or months");
  assert.equal(recurrenceProblem({ freq: "daily", interval: 1, until: "2026-10-01" }, "2026-10-12"), "A repeat must end on or after the first day");
  assert.equal(recurrenceProblem({ freq: "weekly", interval: 1, weekdays: [1, 5] }, "2026-10-12"), undefined);
  assert.ok(isTimeZone("Asia/Kolkata") && !isTimeZone("Mars/Base"));
});

test("calendar: reminders fire before each upcoming occurrence, once per person and offset, never for started ones", () => {
  const now = new Date("2026-10-12T04:25:00Z");
  const timing: CalendarTiming = { allDay: false, startAt: new Date("2026-10-12T04:30:00Z"), endAt: new Date("2026-10-12T04:45:00Z"), timezone: "Asia/Kolkata", recurrence: { freq: "daily", interval: 1 } };
  const planned = planReminders(timing, [{ userId: "a", minutes: [10, 10, 60] }, { userId: "b", minutes: [0] }], now, 26 * 3_600_000);
  // Today's 10-minute reminder is 5 minutes late, so it fires now; today's 60-minute one is 55 minutes late, so it's dropped.
  assert.deepEqual(planned.filter((item) => item.userId === "a").map((item) => `${item.occurrenceKey.slice(0, 10)} ${item.minutes} ${item.remindAt.toISOString()}`), [
    "2026-10-12 10 2026-10-12T04:25:00.000Z",
    "2026-10-13 10 2026-10-13T04:20:00.000Z", "2026-10-13 60 2026-10-13T03:30:00.000Z",
  ]);
  assert.equal(planned.filter((item) => item.userId === "b").length, 2);
  // Once the occurrence has started, nothing is planned for it.
  assert.equal(planReminders({ ...timing, recurrence: null }, [{ userId: "a", minutes: [10] }], new Date("2026-10-12T04:31:00Z"), 3_600_000).length, 0);
  // All-day: 9:00 the day before, in the event's zone.
  const allDay: CalendarTiming = { allDay: true, startAt: new Date("2026-10-15T00:00:00Z"), endAt: new Date("2026-10-16T00:00:00Z"), startDate: "2026-10-15", endDate: "2026-10-16", timezone: "Asia/Kolkata" };
  assert.equal(planReminders(allDay, [{ userId: "a", minutes: [900] }], new Date("2026-10-13T00:00:00Z"), 3 * 86_400_000)[0]?.remindAt.toISOString(), "2026-10-14T03:30:00.000Z");
  // Made at 8:00 on the day, "9:00 on the day" is still ahead; at 10:00 it has passed.
  assert.equal(planReminders(allDay, [{ userId: "a", minutes: [-540] }], new Date("2026-10-15T02:30:00Z"), 3 * 86_400_000)[0]?.remindAt.toISOString(), "2026-10-15T03:30:00.000Z");
  assert.equal(planReminders(allDay, [{ userId: "a", minutes: [-540] }], new Date("2026-10-15T04:30:00Z"), 3 * 86_400_000).length, 0);
  assert.equal(eventReminderText("Offsite", new Date("2026-10-14T18:30:00Z"), true, 900, new Date("2026-10-14T03:30:00Z")), "Offsite is tomorrow");
  assert.equal(eventReminderText("Offsite", new Date("2026-10-14T18:30:00Z"), true, 900, new Date("2026-10-15T03:30:00Z")), "Offsite is today");
  assert.equal(eventReminderText("Sync", new Date("2026-10-15T04:30:00Z"), false, 10, new Date("2026-10-15T04:42:00Z")), "Sync started 12 minutes ago");
});

test("calendar: reminder ids survive edits, and a reminder is delivered only while it still fits the event", () => {
  const hash = (text: string) => text.padEnd(40, "0");
  assert.equal(eventReminderId("e1", "2026-10-12T04:30:00.000Z", "a", 10, hash), eventReminderId("e1", "2026-10-12T04:30:00.000Z", "a", 10, hash));
  const event: ReminderEvent = { _id: "e1", workspaceId: "w", organizerId: "a", title: "Sync", allDay: false, timezone: "Asia/Kolkata", version: 3, startAt: new Date("2026-10-12T04:30:00Z"), endAt: new Date("2026-10-12T05:00:00Z"), recurrence: { freq: "daily", interval: 1 }, exdates: [], attendees: [{ userId: "b", response: "going" }, { userId: "c", response: "declined" }], defaultReminders: [10], reminderPrefs: [{ userId: "b", minutes: [30] }] };
  const reminder = { userId: "a", occurrenceKey: "2026-10-14T04:30:00.000Z", occurrenceStart: new Date("2026-10-14T04:30:00Z"), minutes: 10 };
  assert.equal(eventReminderStillDue(event, reminder), true);
  assert.equal(eventReminderStillDue({ ...event, title: "Daily sync", version: 4 }, reminder), true);
  assert.equal(eventReminderStillDue({ ...event, exdates: ["2026-10-14T04:30:00.000Z"] }, reminder), false);
  assert.equal(eventReminderStillDue({ ...event, startAt: new Date("2026-10-12T05:30:00Z"), endAt: new Date("2026-10-12T06:00:00Z") }, reminder), false);
  assert.equal(eventReminderStillDue({ ...event, defaultReminders: [30] }, reminder), false);
  assert.equal(eventReminderStillDue(event, { ...reminder, userId: "b" }), false);
  assert.equal(eventReminderStillDue(event, { ...reminder, userId: "b", minutes: 30 }), true);
  assert.equal(eventReminderStillDue(event, { ...reminder, userId: "c" }), false);
});
