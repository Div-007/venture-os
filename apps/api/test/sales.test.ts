import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after } from "node:test";
import express from "express";
import {
  activitySchema, brainItemSchema, draftSchema, draftWithLeadSchema, findRunSchema, inboxItemSchema, leadDetailSchema, leadFacetsSchema, leadListSchema, pipelineValueSchema, opportunitySchema, playSchema, salesOverviewSchema,
  salesSettingsSchema, salesSettingsViewSchema, successEnvelope, suppressionSchema, taskSchema, verdictSchema,
} from "@venture-studio/contracts";
import { loadConfig } from "../src/config.js";
import { connectDatabase, type Database } from "../src/db.js";
import { createErrorHandler } from "../src/errors.js";
import { ensureIndexes } from "../src/indexes.js";
import { actorFor } from "../src/middleware.js";
import { listVisibleNotifications } from "../src/notification-visibility.js";
import { salesRoutes } from "../src/routes/sales.js";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { LocalObjectStore } from "../src/storage.js";
import { migrateSalesLeads } from "../src/sales/migration.js";
import { assertClaudeMayMove, clampClaudeStage, forwardStage, normalizeStage, planActivity, planOverride, planStageChange, planVerdict, verdictStage } from "../src/sales/rules.js";
import { extractEmails, extractPhones, leadSuppressKeys, normalizeCompany, normalizeDomain, normalizeEmail, normalizePhone, optOutEntries } from "../src/sales/suppression.js";
import { addWorkingDays, addWorkingHours, endOfLocalDay, isWorkingDay, localDay, localMoment, nextWorkingDay, startOfLocalDay, workingDaysBetween, workingMomentAfterDays } from "../src/sales/workdays.js";
import { calendarOf } from "../src/sales/settings.js";
import { needsPersonApproval, sendBlocker } from "../src/sales/drafts.js";
import { flagImportedDoNotContact } from "../src/sales/leads.js";
import type { AppDocument } from "../src/db.js";

// ---------------------------------------------------------------------------------------------------------------------
// Pure rules (no database)
// ---------------------------------------------------------------------------------------------------------------------

const ist = (day: string, hour = 10, minute = 0) => new Date(Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`));

test("working days are Monday to Saturday in India and skip the festival blackout", () => {
  assert.equal(isWorkingDay("2026-10-10"), true); // Saturday
  assert.equal(isWorkingDay("2026-10-11"), false); // Sunday
  assert.equal(isWorkingDay("2026-10-20"), false); // blackout
  for (const day of ["2026-11-06", "2026-11-07", "2026-11-09", "2026-11-10", "2026-11-11"]) assert.equal(isWorkingDay(day), false, day);
  assert.equal(isWorkingDay("2026-11-12"), true);
  // Friday + 4 working days: Sat, Mon, Tue, Wed (Sunday skipped).
  assert.equal(addWorkingDays(ist("2026-10-09", 15), 4).toISOString(), ist("2026-10-14").toISOString());
  // From Friday 16 Oct: Sat 17, Mon 19, (Tue 20 is blackout) Wed 21, Thu 22.
  assert.equal(addWorkingDays(ist("2026-10-16", 15), 4).toISOString(), ist("2026-10-22").toISOString());
  // From Wednesday 4 Nov: Thu 5, then 6-11 are blackout (and Sunday 8), Thu 12, Fri 13, Sat 14.
  assert.equal(addWorkingDays(ist("2026-11-04", 15), 4).toISOString(), ist("2026-11-14").toISOString());
  // A touch just after midnight IST still counts as that IST day.
  assert.equal(addWorkingDays(new Date("2026-10-08T19:00:00Z"), 1).toISOString(), ist("2026-10-10").toISOString());
  assert.equal(nextWorkingDay(ist("2026-10-10", 12)).toISOString(), ist("2026-10-12").toISOString());
  assert.equal(workingDaysBetween(ist("2026-10-09"), ist("2026-10-14")), 4);
  // 30 days from 7 Oct is 6 Nov, a blackout day: the next working day is Thursday 12 Nov.
  assert.equal(workingMomentAfterDays(ist("2026-10-07", 12), 30).toISOString(), ist("2026-11-12").toISOString());
  // Working hours: 2 hours from Saturday 18:00 IST run into Monday morning; the middle of a day just adds.
  assert.equal(addWorkingHours(ist("2026-10-10", 18), 2).toISOString(), ist("2026-10-12", 11).toISOString());
  assert.equal(addWorkingHours(ist("2026-10-12", 12), 2).toISOString(), ist("2026-10-12", 14).toISOString());
  assert.equal(endOfLocalDay(ist("2026-10-09", 23, 30), "Asia/Kolkata").toISOString(), ist("2026-10-10", 0).toISOString());
  assert.equal(endOfLocalDay(new Date("2026-10-09T03:00:00Z"), "UTC").toISOString(), "2026-10-10T00:00:00.000Z");
});

test("work calendars: a venture's week, blackout dates and time zone decide the working days and the timing rules", () => {
  const settings = (extra: Record<string, unknown> = {}) => salesSettingsSchema.parse(extra);
  const calendar = (extra: Record<string, unknown> = {}) => calendarOf(settings(extra));
  // The defaults are what the rules always were: Monday to Saturday, the festival blackout, Asia/Kolkata, 4 days, 2 hours.
  assert.deepEqual([settings().workingDays, settings().followUpAfterWorkingDays, settings().replySlaHours, settings().timezone, settings().approvalMode], [[1, 2, 3, 4, 5, 6], 4, 2, "Asia/Kolkata", "claude_review_enough"]);
  assert.equal(isWorkingDay("2026-10-20", calendar()), false);
  // A Monday-Friday week, and a Sunday-Thursday one.
  const weekdays = calendar({ workingDays: [1, 2, 3, 4, 5] });
  assert.deepEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"].map((day) => isWorkingDay(day, weekdays)), [true, false, false, true]);
  const gulf = calendar({ workingDays: [7, 1, 2, 3, 4] });
  assert.deepEqual(["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"].map((day) => isWorkingDay(day, gulf)), [true, false, false, true]);
  // The blackout is the venture's own list: the default days are not special once it is replaced.
  assert.equal(isWorkingDay("2026-10-20", calendar({ blackoutDates: [] })), true);
  assert.equal(isWorkingDay("2026-10-20", calendar({ blackoutDates: ["2026-10-21"] })), true);
  assert.equal(isWorkingDay("2026-10-21", calendar({ blackoutDates: ["2026-10-21"] })), false);
  // Counting follows the calendar: Friday 4 Sep + 3 working days, Mon-Fri with 9 Sep blacked out: Mon 7, Tue 8, Thu 10.
  const custom = calendar({ workingDays: [1, 2, 3, 4, 5], blackoutDates: ["2026-09-09"] });
  assert.equal(addWorkingDays(ist("2026-09-04", 15), 3, 10, custom).toISOString(), ist("2026-09-10").toISOString());
  assert.equal(addWorkingDays(ist("2026-09-04", 15), 3).toISOString(), ist("2026-09-08").toISOString()); // default: Sat, Mon, Tue
  assert.equal(nextWorkingDay(ist("2026-09-04", 15), 10, custom).toISOString(), ist("2026-09-07").toISOString());
  assert.equal(workingDaysBetween(ist("2026-09-04"), ist("2026-09-11"), custom), 4); // 7, 8, 10, 11
  assert.equal(workingMomentAfterDays(ist("2026-08-10", 12), 30, 10, custom).toISOString(), ist("2026-09-10").toISOString()); // 9 Sep is a blackout day
  // Working hours: 10:00-19:00 on working days; Friday 18:00 + 2 hours runs into Monday on a Monday-Friday week.
  assert.equal(addWorkingHours(ist("2026-09-04", 18), 2, custom).toISOString(), ist("2026-09-07", 11).toISOString());
  assert.equal(addWorkingHours(ist("2026-09-04", 18), 2).toISOString(), ist("2026-09-05", 11).toISOString()); // default: Saturday morning
  // A calendar that rules out everything does not hang.
  const nothing = calendar({ blackoutDates: Array.from({ length: 400 }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)) });
  assert.match(addWorkingDays(ist("2026-01-01"), 2, 10, nothing).toISOString(), /^20/);
  // Time zones: days, midnights and 10:00 follow the venture's zone (New York is UTC-4 in September, UTC-5 in December).
  const newYork = calendar({ timezone: "America/New_York" });
  const lateEvening = new Date("2026-09-04T03:30:00.000Z"); // 23:30 on Thursday 3 Sep in New York, already Friday in India
  assert.deepEqual([localDay(lateEvening, newYork), localDay(lateEvening)], ["2026-09-03", "2026-09-04"]);
  assert.equal(localMoment("2026-09-04", 10, 0, newYork).toISOString(), "2026-09-04T14:00:00.000Z");
  assert.equal(localMoment("2026-12-01", 10, 0, newYork).toISOString(), "2026-12-01T15:00:00.000Z");
  assert.equal(startOfLocalDay(lateEvening, "America/New_York").toISOString(), "2026-09-03T04:00:00.000Z");
  assert.equal(endOfLocalDay(lateEvening, "America/New_York").toISOString(), "2026-09-04T04:00:00.000Z");
  assert.equal(addWorkingDays(lateEvening, 1, 10, newYork).toISOString(), "2026-09-04T14:00:00.000Z"); // Thursday evening there: Friday 10:00 local
  assert.equal(startOfLocalDay(ist("2026-10-09", 15), "Asia/Kolkata").toISOString(), ist("2026-10-09", 0).toISOString());
  // The rules use the settings: follow-up after 2 working days, a 5- or 8-hour reply window, the venture's own week.
  const now = ist("2026-10-09", 12);
  const lead = { _id: "l", stage: "identified", ownerId: "u", companyName: "Acme" };
  const withSettings = (extra: Record<string, unknown>, input: Record<string, unknown>) => planActivity(lead as never, { kind: "email", body: "", ...input } as never, { now, actorId: "u", settings: settings(extra) });
  const touch = { direction: "out", at: ist("2026-10-09", 11).toISOString() };
  assert.equal((withSettings({}, touch).set.followUpDueAt as Date).toISOString(), ist("2026-10-14").toISOString());
  assert.equal((withSettings({ followUpAfterWorkingDays: 2 }, touch).set.followUpDueAt as Date).toISOString(), ist("2026-10-12").toISOString());
  assert.equal((withSettings({ followUpAfterWorkingDays: 2, workingDays: [1, 2, 3, 4, 5] }, touch).set.followUpDueAt as Date).toISOString(), ist("2026-10-13").toISOString());
  assert.equal((withSettings({ followUpAfterWorkingDays: 1, blackoutDates: ["2026-10-10", "2026-10-12"] }, touch).set.followUpDueAt as Date).toISOString(), ist("2026-10-13").toISOString());
  const reply = { direction: "in", replyType: "interested" };
  assert.equal((withSettings({}, reply).set.nextActionAt as Date).toISOString(), ist("2026-10-09", 14).toISOString());
  assert.equal((withSettings({ replySlaHours: 5 }, reply).set.nextActionAt as Date).toISOString(), ist("2026-10-09", 17).toISOString());
  assert.equal((withSettings({ replySlaHours: 8 }, reply).set.nextActionAt as Date).toISOString(), ist("2026-10-10", 11).toISOString());
  assert.equal((withSettings({ workingDays: [1, 2, 3, 4, 5], replySlaHours: 8 }, reply).set.nextActionAt as Date).toISOString(), ist("2026-10-12", 11).toISOString());
  assert.equal((withSettings({ workingDays: [1, 2, 3, 4, 5] }, { kind: "call", direction: "out", callOutcome: "no_answer" }).set.nextActionAt as Date).toISOString(), ist("2026-10-12").toISOString()); // "Call again" next working day
  assert.equal((withSettings({}, { kind: "call", direction: "out", callOutcome: "no_answer" }).set.nextActionAt as Date).toISOString(), ist("2026-10-10").toISOString());
  const notNow = withSettings({ blackoutDates: ["2026-11-08"] }, { direction: "in", replyType: "not_now" }); // 30 days from 9 Oct is Sunday 8 Nov
  assert.equal((notNow.set.nextActionAt as Date).toISOString(), ist("2026-11-09").toISOString());
  // Approval and channels at the draft level.
  const ready = { status: "ready", channel: "email", playId: "p" };
  const play = { firstBatchReviewed: true };
  assert.equal(needsPersonApproval(ready as never, play as never), false);
  assert.equal(needsPersonApproval({ ...ready, playId: undefined } as never, null, { approvalMode: "person_approves_every_message" }), true);
  assert.equal(needsPersonApproval({ ...ready, channel: "call_opener" } as never, null, { approvalMode: "person_approves_every_message" }), false);
  assert.equal(needsPersonApproval({ ...ready, personApproval: { by: "u" } } as never, null, { approvalMode: "person_approves_every_message" }), false);
  assert.equal(needsPersonApproval({ ...ready, status: "in_review" } as never, null, { approvalMode: "person_approves_every_message" }), false);
  assert.equal(needsPersonApproval(ready as never, { firstBatchReviewed: false } as never, { approvalMode: "claude_review_enough" }), true);
  assert.match(String(sendBlocker(ready as never, lead as never, null, { approvalMode: "person_approves_every_message", allowedChannels: ["email"] })), /every message/);
  assert.match(String(sendBlocker(ready as never, lead as never, null, { approvalMode: "claude_review_enough", allowedChannels: ["call"] })), /does not use email/);
  assert.equal(sendBlocker(ready as never, lead as never, play as never, { approvalMode: "claude_review_enough", allowedChannels: ["email"] }), undefined);
});

test("emails, phones, domains and company names are normalised for do-not-contact matching", () => {
  assert.equal(normalizeEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  assert.equal(normalizeEmail("mailto:Sales@Firm.in?subject=Hi"), "sales@firm.in");
  assert.equal(normalizeEmail("Jane <jane@firm.in>"), "jane@firm.in");
  assert.equal(normalizeEmail("not an email"), null);
  for (const raw of ["98765 43210", "+91 98765 43210", "09876543210", "91-9876543210", "tel:+91-98765-43210", "https://wa.me/919876543210", "0091 98765 43210"]) assert.equal(normalizePhone(raw), "+919876543210", raw);
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizeDomain("https://www.Example.com/contact?x=1"), "example.com");
  assert.equal(normalizeDomain("jane@Sub.Example.co.in"), "sub.example.co.in");
  assert.equal(normalizeDomain("nodots"), null);
  assert.equal(normalizeCompany("Jain Sales & Marketing Pvt. Ltd."), "jain sales marketing");
  assert.equal(normalizeCompany("  JAIN sales and marketing  "), "jain sales marketing");
  assert.equal(normalizeCompany("ACME TRADERS (Jaipur)"), "acme traders");
  assert.equal(normalizeCompany("Acme Traders & Co"), "acme traders");
  assert.equal(normalizeCompany("Acme Traders LLP"), "acme traders");
  assert.notEqual(normalizeCompany("Acme Trading"), normalizeCompany("Acme Traders")); // trade words are not stripped
  assert.equal(normalizeEmail("Owner+Sales@Acme.IN."), "owner@acme.in");
  assert.equal(normalizeEmail("owner@acme.in."), "owner@acme.in");
  assert.deepEqual(extractEmails("Write to Boss <Owner+x@Acme.in>, or mailto:info@acme.in?subject=Hi"), ["owner@acme.in", "info@acme.in"]);
  assert.deepEqual(extractPhones("Call 98765 43210 / +91 98765 22222 ext 5 or https://wa.me/919876511111, not 2026-10-09").sort(), ["+919876511111", "+919876522222", "+919876543210"]);
  assert.deepEqual(extractPhones("९८७६५ ४३२१०").sort(), ["+919876543210"]);
  assert.equal(normalizePhone("98765 11111 ext 5"), "+919876511111");
  // Contact details of every route kind are matched, the company's own domains too; shared mail domains never.
  const loose = leadSuppressKeys({ companyName: "Acme Traders (Jaipur)", website: "https://www.acme.in/", contactRoutes: [{ kind: "other", value: "Call 098765 43210 or mail Info+x@Acme.in" }, { kind: "website_form", value: "https://forms.acme.co.in/contact" }, { kind: "email", value: "boss@gmail.com" }] }).sort();
  assert.deepEqual(loose, ["company:acme traders", "domain:acme.in", "domain:forms.acme.co.in", "email:boss@gmail.com", "email:info@acme.in", "phone:+919876543210"].sort());
  assert.deepEqual(optOutEntries({ companyName: "Acme Traders", website: "https://acme.in", contactRoutes: [{ kind: "email", value: "boss@gmail.com" }, { kind: "email", value: "sales@acme.in" }] }).map((entry) => `${entry.kind}:${entry.value}`).sort(), ["company:acme traders", "domain:acme.in", "email:boss@gmail.com", "email:sales@acme.in"]);
  assert.equal(normalizeCompany("The Paras Pipes Private Limited"), "paras pipes");
  const keys = leadSuppressKeys({ companyName: "Acme Traders Pvt Ltd", website: "https://www.acmetraders.in/", contactRoutes: [{ kind: "email", value: "Owner@AcmeTraders.in" }, { kind: "whatsapp", value: "98765 43210" }, { kind: "email", value: "acme@gmail.com" }] });
  assert.deepEqual(keys.sort(), ["company:acme traders", "domain:acmetraders.in", "email:acme@gmail.com", "email:owner@acmetraders.in", "phone:+919876543210"]);
  assert.ok(!keys.includes("domain:gmail.com"), "a shared mail domain is never a match key");
  assert.deepEqual(optOutEntries({ companyName: "Acme Traders Pvt Ltd", contactRoutes: [{ kind: "email", value: "Owner@AcmeTraders.in" }, { kind: "phone", value: "09876543210" }, { kind: "linkedin", value: "x" }] }).map((entry) => `${entry.kind}:${entry.value}`).sort(), ["company:acme traders", "domain:acmetraders.in", "email:owner@acmetraders.in", "phone:+919876543210"]);
});

test("rules engine: stage moves, verdict mapping and call outcomes (pure)", () => {
  const now = ist("2026-10-09", 12);
  const lead = (extra: Record<string, unknown> = {}) => ({ _id: "l", stage: "identified", ownerId: "u", companyName: "Acme", ...extra });
  const act = (extra: Record<string, unknown>, input: Record<string, unknown>) => planActivity(lead(extra) as never, { kind: "call", body: "", ...input } as never, { now, actorId: "u" });
  assert.equal(normalizeStage("conversation"), "replied");
  assert.equal(normalizeStage("won"), "invoice_contract");
  assert.equal(normalizeStage("nonsense"), "identified");
  assert.equal(forwardStage("contacted", "replied"), "replied");
  assert.equal(forwardStage("proposal", "replied"), "proposal");
  assert.equal(forwardStage("thinking", "replied"), "replied");
  assert.equal(forwardStage("delivery", "discovery_booked"), "delivery");
  assert.equal(verdictStage("recommend", "high"), "approved_for_contact");
  assert.equal(verdictStage("recommend", "medium"), "approved_for_contact");
  assert.equal(verdictStage("recommend", "low"), "researched");
  assert.equal(verdictStage("hold", "high"), "researched");
  assert.equal(verdictStage("reject", "high"), "disqualified");
  // An outbound touch on a new lead: contacted, last touch, follow-up in 4 working days.
  const first = act({}, { kind: "email", direction: "out", at: ist("2026-10-09", 11).toISOString() });
  assert.equal(first.stageTo, "contacted");
  assert.equal((first.set.followUpDueAt as Date).toISOString(), ist("2026-10-14").toISOString());
  // The call outcomes of the spec.
  assert.equal(act({}, { callOutcome: "interested_book" }).stageTo, "discovery_booked");
  assert.deepEqual([act({ stage: "contacted", lastTouchAt: now }, { callOutcome: "send_details" }).stageTo, act({}, { callOutcome: "send_details" }).set.nextAction], ["replied", "Send details"]);
  assert.equal(act({}, { callOutcome: "call_back", nextActionAt: "2026-10-12T05:00:00.000Z" }).set.nextAction, "Call back");
  assert.equal((act({}, { callOutcome: "call_back" }).set.nextActionAt as Date).toISOString(), ist("2026-10-10").toISOString());
  for (const outcome of ["no_answer", "busy"]) { const plan = act({}, { callOutcome: outcome }); assert.deepEqual([plan.stageTo, plan.set.nextAction], ["contacted", "Call again"]); assert.ok(plan.set.followUpDueAt); }
  const lost = act({}, { callOutcome: "not_interested" });
  assert.deepEqual([lost.stageTo, lost.set.exitReason, lost.discardDrafts], ["lost", "Not interested on call", "all"]);
  assert.equal(act({}, { callOutcome: "wrong_person" }).set.nextAction, "Find the right person");
  const wrongNumber = act({}, { callOutcome: "wrong_number" });
  assert.deepEqual([wrongNumber.stageTo, wrongNumber.set.lastTouchAt, wrongNumber.set.followUpDueAt], [undefined, undefined, undefined]);
  const yes = act({}, { callOutcome: "yes_whatsapp" });
  assert.deepEqual([yes.stageTo, (yes.set.whatsappOptIn as { how: string }).how, yes.set.nextAction], ["replied", "yes_on_call", "Send details on WhatsApp"]);
  // Replies.
  assert.equal(act({ stage: "contacted", followUpDueAt: now }, { kind: "email", direction: "in" }).stageTo, "replied");
  assert.equal(act({ stage: "proposal" }, { kind: "email", direction: "in" }).stageTo, undefined);
  const optOut = act({}, { kind: "email", direction: "in", replyType: "opt_out" });
  assert.deepEqual([optOut.stageTo, optOut.set.exitReason, optOut.set.doNotContact, optOut.suppress, optOut.discardDrafts], ["disqualified", "Asked not to be contacted", true, "Asked not to be contacted", "all"]);
  assert.equal(act({}, { kind: "email", direction: "in", replyType: "hostile" }).set.exitReason, "Hostile reply");
  const notNow = act({}, { kind: "email", direction: "in", replyType: "not_now" });
  assert.equal(notNow.stageTo, "thinking");
  assert.ok((notNow.set.nextActionAt as Date).getTime() - now.getTime() >= 29 * 86_400_000);
  assert.equal(act({}, { kind: "email", direction: "in", replyType: "price_first" }).set.nextAction, "Answer price with a range and ask for a call");
  assert.throws(() => act({}, { kind: "note", direction: "in", replyType: "interested" }), /inbound/);
  assert.throws(() => act({}, { kind: "email", direction: "in", replyType: "silence" }), /Silence is not a reply/);
  // Claude never grants the WhatsApp opt-in; a person's inbound WhatsApp does.
  const whatsapp = (via: string) => planActivity(lead() as never, { kind: "whatsapp", direction: "in", body: "" } as never, { now, actorId: "u", via });
  assert.equal(whatsapp("claude").set.whatsappOptIn, undefined);
  assert.equal(whatsapp("claude").stageTo, "replied");
  assert.equal((whatsapp("app").set.whatsappOptIn as { how: string }).how, "they_messaged");
  // Direct stage edits by Claude: one step at a time along a short whitelist; the rest is a person's call.
  assert.throws(() => assertClaudeMayMove("researched", "approved_for_contact"), /person/);
  assert.throws(() => assertClaudeMayMove("lost", "replied"), /Reopening/);
  assert.throws(() => assertClaudeMayMove("disqualified", "researched"), /Reopening/);
  for (const [from, to] of [["contacted", "researched"], ["researched", "identified"], ["qualified", "discovery_booked"], ["replied", "contacted"]] as const) assert.throws(() => assertClaudeMayMove(from, to), /earlier stage/, `${from} -> ${to}`);
  for (const [from, to] of [["identified", "contacted"], ["identified", "qualified"], ["contacted", "proposal"], ["replied", "qualified"], ["researched", "contacted"], ["thinking", "identified"]] as const) assert.throws(() => assertClaudeMayMove(from, to), /one step at a time/, `${from} -> ${to}`);
  for (const [from, to] of [["proposal", "invoice_contract"], ["contacted", "cash_collected"], ["delivery", "retained_referred"]] as const) assert.throws(() => assertClaudeMayMove(from, to), /won/i, `${from} -> ${to}`);
  assert.throws(() => assertClaudeMayMove("invoice_contract", "proposal"), /won deal/);
  for (const [from, to] of [["identified", "researched"], ["contacted", "replied"], ["replied", "discovery_booked"], ["discovery_booked", "qualified"], ["qualified", "proposal"], ["contacted", "thinking"], ["replied", "thinking"], ["thinking", "replied"], ["replied", "lost"], ["approved_for_contact", "approved_for_contact"], ["lost", "lost"], ["lost", "disqualified"], ["contacted", "disqualified"]] as const) assert.doesNotThrow(() => assertClaudeMayMove(from, to), `${from} -> ${to}`);
  // Claude's rule-driven moves (logging activity, sorting replies): a closed lead stays closed, nothing goes back, nothing is approved or won.
  assert.equal(clampClaudeStage("lost", "replied"), "lost");
  assert.equal(clampClaudeStage("lost", "disqualified"), "disqualified");
  assert.equal(clampClaudeStage("proposal", "replied"), "proposal");
  assert.equal(clampClaudeStage("researched", "approved_for_contact"), "researched");
  assert.equal(clampClaudeStage("proposal", "cash_collected"), "proposal");
  assert.equal(clampClaudeStage("contacted", "lost"), "lost");
  assert.equal(clampClaudeStage("thinking", "discovery_booked"), "discovery_booked");
  const claudeAct = (extra: Record<string, unknown>, input: Record<string, unknown>) => planActivity(lead(extra) as never, { kind: "call", body: "", ...input } as never, { now, actorId: "u", via: "claude" });
  const onClosed = claudeAct({ stage: "lost", exitReason: "No budget", nextAction: "Nothing" }, { callOutcome: "interested_book" });
  assert.deepEqual([onClosed.stageTo, onClosed.set.nextAction, onClosed.set.nextActionAt, Boolean(onClosed.set.lastTouchAt)], [undefined, undefined, undefined, true]);
  assert.equal(claudeAct({ stage: "disqualified", exitReason: "x" }, { kind: "email", direction: "in", replyType: "interested" }).set.nextAction, undefined);
  const closedOptOut = claudeAct({ stage: "lost", exitReason: "x" }, { kind: "email", direction: "in", replyType: "opt_out" });
  assert.deepEqual([closedOptOut.stageTo, closedOptOut.suppress, closedOptOut.set.doNotContact], ["disqualified", "Asked not to be contacted", true]);
  assert.equal(claudeAct({ stage: "discovery_booked" }, { kind: "email", direction: "in", replyType: "not_now" }).stageTo, undefined);
  assert.equal(act({ stage: "discovery_booked" }, { kind: "email", direction: "in", replyType: "not_now" }).stageTo, "thinking"); // a person decides for later stages
  assert.equal(claudeAct({ stage: "contacted" }, { kind: "email", direction: "in", replyType: "not_now" }).stageTo, "thinking");
  const claudeYes = claudeAct({}, { callOutcome: "yes_whatsapp" });
  assert.deepEqual([claudeYes.stageTo, claudeYes.set.whatsappOptIn], ["replied", undefined]);
  // Time and direction: nothing more than an hour ahead; a reply can be given in person (a meeting).
  assert.throws(() => act({}, { kind: "email", direction: "out", at: new Date(now.getTime() + 2 * 3_600_000).toISOString() }), /future/);
  assert.doesNotThrow(() => act({}, { kind: "email", direction: "out", at: new Date(now.getTime() + 30 * 60_000).toISOString() }));
  const inPerson = act({ stage: "contacted", lastTouchAt: now }, { kind: "meeting", direction: "in", replyType: "interested" });
  assert.deepEqual([inPerson.direction, inPerson.stageTo, inPerson.set.nextAction], ["in", "replied", "Book the discovery call"]);
  assert.equal(act({}, { kind: "meeting", direction: "in" }).direction, "in");
  assert.equal(act({}, { kind: "meeting", direction: "out" }).direction, undefined);
  assert.throws(() => act({}, { kind: "email", direction: "out", callOutcome: "busy" }), /outbound call/);
  assert.throws(() => act({ doNotContact: true }, { kind: "email", direction: "out" }), /do-not-contact/);
  // Stage changes and verdicts.
  assert.throws(() => planStageChange(lead() as never, "lost", undefined, now), /exit reason/);
  const won = planStageChange(lead({ stage: "proposal" }) as never, "cash_collected", undefined, now);
  assert.deepEqual([won.stageTo, won.enteredWon, (won.set.wonAt as Date).toISOString()], ["cash_collected", true, now.toISOString()]);
  assert.equal(planStageChange(lead({ stage: "invoice_contract", wonAt: now }) as never, "delivery", undefined, now).enteredWon, false);
  const verdict = (decision: "recommend" | "hold" | "reject", confidence: "low" | "medium" | "high", extra: Record<string, unknown> = {}, via: "app" | "claude" = "app") => planVerdict(lead(extra) as never, { decision, confidence, summary: "Short summary", signal: "", offerFit: "fit" } as never, "v1", now, { via, actorId: "u" });
  assert.deepEqual([verdict("recommend", "high").stageTo, verdict("recommend", "high").set.needsYou], ["approved_for_contact", false]);
  assert.deepEqual([verdict("recommend", "low").stageTo, verdict("recommend", "low").set.needsYou], ["researched", true]);
  assert.deepEqual([verdict("hold", "high").stageTo, verdict("hold", "high").set.needsYou], ["researched", true]);
  assert.deepEqual([verdict("reject", "high").stageTo, verdict("reject", "high").set.exitReason, verdict("reject", "medium").set.disqualifiedByVerdict], ["disqualified", "Not a fit: Short summary", true]);
  // Only a confident reject disqualifies: a low-confidence one asks a person.
  const lowReject = verdict("reject", "low");
  assert.deepEqual([lowReject.stageTo, lowReject.set.needsYou, lowReject.set.exitReason], ["researched", true, undefined]);
  // Who set the verdict is kept, and a person's approval is remembered.
  assert.deepEqual([(verdict("recommend", "high").set.verdict as { via: string; by: string }).via, (verdict("recommend", "high", {}, "claude").set.verdict as { via: string }).via], ["app", "claude"]);
  assert.equal(verdict("recommend", "high").set.approvedForContactBy, "u");
  assert.equal(verdict("recommend", "high", {}, "claude").set.approvedForContactBy, undefined);
  // Claude's verdict never pulls a lead back from approved_for_contact: it asks a person instead.
  for (const [decision, confidence] of [["hold", "high"], ["reject", "high"], ["reject", "medium"], ["recommend", "low"]] as const) {
    const held = verdict(decision, confidence, { stage: "approved_for_contact", approvedForContactBy: "p" }, "claude");
    assert.deepEqual([held.stageTo, held.set.needsYou, held.discardDrafts], [undefined, true, "none"], `${decision} ${confidence}`);
  }
  assert.equal(verdict("hold", "high", { stage: "approved_for_contact" }).stageTo, "researched"); // a person's verdict still moves it
  // A lead a verdict disqualified is reopened by a person only, and only because of the stored flag (not the wording of its reason).
  assert.equal(verdict("recommend", "high", { stage: "disqualified", exitReason: "Not a fit: x", disqualifiedByVerdict: true }, "claude").stageTo, undefined);
  assert.equal(verdict("recommend", "high", { stage: "disqualified", exitReason: "Not a fit: x", disqualifiedByVerdict: true }).stageTo, "approved_for_contact");
  assert.equal(verdict("recommend", "high", { stage: "disqualified", exitReason: "Not a fit: typed by a person" }).stageTo, undefined);
  assert.equal(verdict("recommend", "high", { stage: "contacted", lastTouchAt: now }).stageTo, undefined);
  const override = planOverride(lead({ stage: "researched", needsYou: true }) as never, { verdictId: "v1", decision: "hold", confidence: "low", summary: "s", at: now, overridden: false }, "recommend", "Talked to the owner", now, "u");
  assert.deepEqual([override.stageTo, override.set.needsYou, (override.set.verdict as { overridden: boolean }).overridden], ["approved_for_contact", false, true]);
  // A verdict-rejected lead that was never contacted can be reopened by an override.
  assert.equal(planOverride(lead({ stage: "disqualified", exitReason: "Not a fit: x", disqualifiedByVerdict: true }) as never, { verdictId: "v1" }, "recommend", "Reconsidered", now, "u").stageTo, "approved_for_contact");
});

// ---------------------------------------------------------------------------------------------------------------------
// API tests on a real MongoDB (set TEST_MONGODB_URI); a throwaway database that is dropped at the end
// ---------------------------------------------------------------------------------------------------------------------

type Who = "admin" | "head" | "contrib" | "contrib2" | "reviewer" | "learner" | "outsider" | "outside-admin";
type Reply = { status: number; body: any; data: any };
type Harness = { database: Database; origin: string; call: (who: Who, method: string, path: string, body?: unknown, options?: { via?: "claude" }) => Promise<Reply>; server: Server; dbName: string };

const mongoUrl = process.env.TEST_MONGODB_URI;
let harness: Promise<Harness> | undefined;
const suffix = randomUUID().slice(0, 6);
let counter = 0;

async function setup(): Promise<Harness> {
  const dbName = `vso_test_sales_${suffix}`;
  assert.match(dbName, /^vso_test_sales_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  const db = database.db;
  await ensureIndexes(db);
  const now = new Date();
  await db.collection("workspaces").insertMany([{ _id: "workspace-a", name: "A", slug: "a", createdAt: now }, { _id: "workspace-b", name: "B", slug: "b", createdAt: now }]);
  await db.collection("ventures").insertMany([
    { _id: "venture-a", workspaceId: "workspace-a", name: "Alpha", status: "active", createdAt: now }, { _id: "venture-b", workspaceId: "workspace-a", name: "Beta", status: "active", createdAt: now },
    { _id: "venture-c", workspaceId: "workspace-a", name: "Gamma", status: "active", createdAt: now }, { _id: "venture-x", workspaceId: "workspace-b", name: "Other", status: "active", createdAt: now },
  ]);
  await db.collection("groups").insertMany([{ _id: "group-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Core", createdAt: now }, { _id: "group-c", workspaceId: "workspace-a", ventureId: "venture-c", name: "Core", createdAt: now }]);
  await db.collection("channels").insertMany([{ _id: "channel-a", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a", name: "general", createdAt: now }]);
  await db.collection("pipelines").insertMany([
    { _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha leads", offerName: "Offer", status: "active", createdAt: now, updatedAt: now },
    { _id: "pipeline-a2", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha second", offerName: "Offer", status: "active", createdAt: now, updatedAt: now },
    { _id: "pipeline-b", workspaceId: "workspace-a", ventureId: "venture-b", name: "Beta leads", offerName: "Offer", status: "active", createdAt: now, updatedAt: now },
    { _id: "pipeline-c", workspaceId: "workspace-a", ventureId: "venture-c", name: "Gamma leads", offerName: "Offer", status: "active", createdAt: now, updatedAt: now },
  ]);
  const people: [Who, string, string, string[], string[]][] = [
    ["admin", "workspace-a", "admin", [], []], ["head", "workspace-a", "venture_head", ["venture-a", "venture-c"], ["group-a", "group-c"]], ["contrib", "workspace-a", "contributor", ["venture-a", "venture-c"], ["group-a", "group-c"]],
    ["contrib2", "workspace-a", "contributor", ["venture-a"], ["group-a"]], ["reviewer", "workspace-a", "reviewer", ["venture-a"], ["group-a"]], ["learner", "workspace-a", "learner", ["venture-a"], ["group-a"]],
    ["outsider", "workspace-a", "contributor", ["venture-b"], []], ["outside-admin", "workspace-b", "admin", [], []],
  ];
  await db.collection("users").insertMany(people.map(([handle, workspaceId]) => ({ _id: `user-${handle}`, workspaceId, email: `${handle}@example.invalid`, name: handle, handle, status: "active", createdAt: now, updatedAt: now })));
  await db.collection("memberships").insertMany(people.map(([handle, workspaceId, role, ventureIds, groupIds]) => ({ _id: `membership-${handle}`, workspaceId, userId: `user-${handle}`, role, ventureIds, groupIds, status: "active", createdAt: now, updatedAt: now })));

  // The Sales routes behind a small stand-in for sign-in: `x-test-user` is the person, `x-test-via: claude` is the hosted connector.
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    try {
      req.id = randomUUID();
      req.interfaceChannel = req.headers["x-test-via"] === "claude" ? "mcp" : "api";
      const user = await db.collection("users").findOne({ _id: String(req.headers["x-test-user"]) });
      if (user) req.actor = await actorFor(db, { id: String(user._id), email: String(user.email), name: String(user.name) });
      next();
    } catch (error) { next(error); }
  });
  app.use("/v1", salesRoutes(database));
  app.use(createErrorHandler(db));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const call: Harness["call"] = async (who, method, path, body, options = {}) => {
    const response = await fetch(`${origin}/v1${path}`, { method, headers: { "content-type": "application/json", "x-test-user": `user-${who}`, ...(options.via === "claude" ? { "x-test-via": "claude" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json().catch(() => null) as any;
    return { status: response.status, body: json, data: json?.data };
  };
  return { database, origin, call, server, dbName };
}

const getHarness = () => (harness ??= setup());
after(async () => {
  if (!harness) return;
  const { server, database } = await harness;
  server.close();
  await once(server, "close");
  await database.native.dropDatabase();
  await database.client.close();
});

const skip = { skip: !mongoUrl };
const expectStatus = (reply: Reply, status: number) => { assert.equal(reply.status, status, JSON.stringify(reply.body)); return reply; };
const parse = <T>(schema: { parse: (value: unknown) => T }, value: unknown): T => schema.parse(value);

async function newLead(h: Harness, who: Who, extra: Record<string, unknown> = {}) {
  const n = ++counter;
  const reply = expectStatus(await h.call(who, "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Zorbo${n}x Traders ${suffix}`, ownerId: `user-${who}`, contactRoutes: [{ kind: "email", value: `owner${n}@zorbo${n}x.example` }, { kind: "phone", value: `98765${String(10000 + n)}` }], ...extra }), 201);
  return parse(opportunitySchema, reply.data);
}
const leadDoc = async (h: Harness, id: string) => (await h.database.db.collection("opportunities").findOne({ _id: id }))!;
const log = async (h: Harness, who: Who, leadId: string, body: Record<string, unknown>, options?: { via?: "claude" }) => h.call(who, "POST", `/sales/leads/${leadId}/activities`, { body: "", ...body }, options);
const iso = (date: Date) => date.toISOString();

test("Sales permissions follow the venture role: learners read, contributors own their leads, heads run the venture, outsiders see nothing", skip, async () => {
  const h = await getHarness();
  const mine = await newLead(h, "contrib");
  assert.equal(mine.stage, "identified");
  assert.equal(mine.ventureId, "venture-a");
  // A learner reads but cannot write; an outsider's venture does not exist for them.
  expectStatus(await h.call("learner", "GET", `/sales/leads/${mine.id}`), 200);
  assert.ok((await h.call("learner", "GET", "/sales/leads?limit=100")).data.items.some((lead: any) => lead.id === mine.id));
  expectStatus(await h.call("learner", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: "Learner Co", ownerId: "user-learner" }), 403);
  expectStatus(await h.call("learner", "PATCH", `/sales/leads/${mine.id}`, { nextAction: "x" }), 403);
  expectStatus(await log(h, "learner", mine.id, { kind: "note", body: "hi" }), 403);
  expectStatus(await h.call("learner", "POST", "/sales/suppression", { kind: "email", value: "x@y.example" }), 403);
  expectStatus(await h.call("learner", "POST", "/sales/plays", { ventureId: "venture-a", name: "Play" }), 403);
  expectStatus(await h.call("learner", "POST", "/sales/brain", { ventureId: "venture-a", kind: "notes", title: "T", body: "B" }), 403);
  expectStatus(await h.call("outsider", "GET", `/sales/leads/${mine.id}`), 404);
  expectStatus(await h.call("outsider", "PATCH", `/sales/leads/${mine.id}`, { nextAction: "x" }), 404);
  expectStatus(await h.call("outsider", "DELETE", `/sales/leads/${mine.id}`), 404);
  expectStatus(await log(h, "outsider", mine.id, { kind: "note" }), 404);
  expectStatus(await h.call("outsider", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: "Nope", ownerId: "user-outsider" }), 404);
  assert.equal((await h.call("outsider", "GET", "/sales/leads?ventureId=venture-a")).data.total, 0);
  assert.ok(!(await h.call("outsider", "GET", "/sales/leads")).data.items.some((lead: any) => lead.id === mine.id));
  expectStatus(await h.call("outside-admin", "GET", `/sales/leads/${mine.id}`), 404);
  assert.equal((await h.call("outside-admin", "GET", "/sales/leads")).data.total, 0);
  // Contributors create leads for themselves, not for others; a head assigns.
  expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: "For Someone Else", ownerId: "user-contrib2" }), 403);
  expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: "Owner Outside", ownerId: "user-outsider" }), 400);
  const assigned = expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Assigned ${suffix}`, ownerId: "user-contrib2" }), 201);
  // A contributor edits only their own leads; the head and admin edit all; only a head reassigns.
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${mine.id}`, { nextAction: "Call them" }), 200);
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${assigned.data.id}`, { nextAction: "Mine now" }), 403);
  expectStatus(await log(h, "contrib", assigned.data.id, { kind: "note", body: "x" }), 403);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${mine.id}`, { nextAction: "Not mine" }), 403);
  expectStatus(await h.call("reviewer", "PATCH", `/sales/leads/${mine.id}`, { nextAction: "Not mine" }), 403);
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${mine.id}`, { ownerId: "user-contrib2" }), 403);
  expectStatus(await h.call("head", "PATCH", `/sales/leads/${assigned.data.id}`, { nextAction: "Head edit" }), 200);
  expectStatus(await h.call("admin", "PATCH", `/sales/leads/${assigned.data.id}`, { nextAction: "Admin edit" }), 200);
  expectStatus(await h.call("head", "PATCH", `/sales/leads/${mine.id}`, { ownerId: "user-outsider" }), 400);
  assert.equal((await h.call("head", "PATCH", `/sales/leads/${mine.id}`, { ownerId: "user-contrib2" })).data.ownerId, "user-contrib2");
  // A reviewer creates their own leads too, and can use the Review queue on others' drafts (see the drafts test).
  const reviewerLead = await newLead(h, "reviewer");
  assert.equal(reviewerLead.ownerId, "user-reviewer");
  // Owner filter.
  const own = (await h.call("contrib", "GET", "/sales/leads?owner=me&limit=100")).data.items;
  assert.ok(own.every((lead: any) => lead.ownerId === "user-contrib"));
  // Delete: a head any time, the owner only before first contact, nobody else.
  const early = await newLead(h, "contrib");
  expectStatus(await h.call("contrib2", "DELETE", `/sales/leads/${early.id}`), 403);
  expectStatus(await h.call("learner", "DELETE", `/sales/leads/${early.id}`), 403);
  const touched = await newLead(h, "contrib");
  expectStatus(await log(h, "contrib", touched.id, { kind: "email", direction: "out" }), 201);
  expectStatus(await h.call("contrib", "DELETE", `/sales/leads/${touched.id}`), 403);
  expectStatus(await h.call("head", "DELETE", `/sales/leads/${touched.id}`), 200);
  expectStatus(await h.call("contrib", "DELETE", `/sales/leads/${early.id}`), 200);
});

test("soft delete hides a lead from the list, detail, overview, inbox, drafts and the older opportunities route", skip, async () => {
  const h = await getHarness();
  const lead = await newLead(h, "head", { pipelineId: "pipeline-c" });
  const draft = expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", subject: "Hi", body: "Hello there" }), 201).data;
  expectStatus(await log(h, "head", lead.id, { kind: "email", direction: "in", body: "Interested, tell me more" }), 201);
  const before = (await h.call("head", "GET", "/sales/overview?ventureId=venture-c")).data.counts;
  const legacyBefore = await fetch(`${h.origin}/v1/opportunities`, { headers: { "x-test-user": "user-head" } });
  assert.ok((await legacyBefore.json() as any).data.some((item: any) => item.id === lead.id));
  const deleted = expectStatus(await h.call("head", "DELETE", `/sales/leads/${lead.id}`), 200);
  assert.ok(deleted.data.deletedAt);
  expectStatus(await h.call("head", "GET", `/sales/leads/${lead.id}`), 404);
  expectStatus(await h.call("head", "PATCH", `/sales/leads/${lead.id}`, { nextAction: "x" }), 404);
  expectStatus(await h.call("head", "DELETE", `/sales/leads/${lead.id}`), 404);
  expectStatus(await log(h, "head", lead.id, { kind: "note" }), 404);
  assert.ok(!(await h.call("head", "GET", "/sales/leads?limit=100&ventureId=venture-c")).data.items.some((item: any) => item.id === lead.id));
  assert.ok(!(await h.call("head", "GET", "/sales/inbox")).data.some((item: any) => item.lead.id === lead.id));
  assert.ok(!(await h.call("head", "GET", "/sales/drafts?limit=500")).data.some((item: any) => item.leadId === lead.id));
  const after = (await h.call("head", "GET", "/sales/overview?ventureId=venture-c")).data.counts;
  assert.equal(after.totalLeads, before.totalLeads - 1);
  assert.equal(after.replies, before.replies - 1);
  const legacy = await (await fetch(`${h.origin}/v1/opportunities`, { headers: { "x-test-user": "user-head" } })).json() as any;
  assert.ok(!legacy.data.some((item: any) => item.id === lead.id));
  expectStatus(await h.call("head", "PATCH", `/opportunities/${lead.id}`, { nextAction: "x" }), 404);
  // Its unsent drafts were discarded with it.
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: draft.id }))?.status, "discarded");
  assert.equal(Boolean((await leadDoc(h, lead.id)).deletedAt), true);
});

test("outbound, inbound and reply-type activities move the lead as the spec says", skip, async () => {
  const h = await getHarness();
  // Outbound on a new lead: contacted, last touch, follow-up 4 working days later (Friday 4 Sep + Sat, Mon, Tue, Wed: Sunday skipped).
  // (The festival blackout is covered by the working-day test above: an activity cannot be dated in the future.)
  const lead = await newLead(h, "contrib");
  const first = expectStatus(await log(h, "contrib", lead.id, { kind: "email", direction: "out", body: "Sent the intro", at: "2026-09-04T09:30:00.000Z" }), 201);
  assert.equal(parse(activitySchema, first.data.activity).stageTo, "contacted");
  const afterFirst = parse(opportunitySchema, first.data.lead);
  assert.equal(afterFirst.stage, "contacted");
  assert.equal(afterFirst.lastTouchAt, "2026-09-04T09:30:00.000Z");
  assert.equal(afterFirst.followUpDueAt, iso(ist("2026-09-09")));
  // A second touch before the follow-up date leaves the clock alone.
  const second = expectStatus(await log(h, "contrib", lead.id, { kind: "whatsapp", direction: "out", at: "2026-09-05T05:00:00.000Z" }), 201);
  assert.equal(second.data.lead.followUpDueAt, iso(ist("2026-09-09")));
  // The follow-up touch on the due date stops the sequence.
  const followUp = expectStatus(await log(h, "contrib", lead.id, { kind: "email", direction: "out", at: iso(ist("2026-09-09", 11)) }), 201);
  assert.equal(followUp.data.lead.followUpDueAt, undefined);
  assert.equal(Object.hasOwn(await leadDoc(h, lead.id), "followUpDueAt"), false);
  // Thursday + Fri, Sat, Mon, Tue.
  const thursday = await newLead(h, "contrib");
  assert.equal((await log(h, "contrib", thursday.id, { kind: "call", direction: "out", at: iso(ist("2026-09-03", 15)) })).data.lead.followUpDueAt, iso(ist("2026-09-08")));
  // Nothing is logged as having happened more than an hour from now.
  const tooLate = await log(h, "contrib", thursday.id, { kind: "email", direction: "out", at: new Date(Date.now() + 2 * 3_600_000).toISOString() });
  assert.equal(tooLate.status, 400);
  assert.match(tooLate.body.error.message, /future/);
  expectStatus(await log(h, "contrib", thursday.id, { kind: "note", at: new Date(Date.now() + 2 * 3_600_000).toISOString() }), 400);
  expectStatus(await log(h, "contrib", thursday.id, { kind: "email", direction: "out", at: new Date(Date.now() + 20 * 60_000).toISOString() }), 201);
  // A reply given in person: a meeting can be inbound; it waits in the Inbox like any reply.
  const metLead = await newLead(h, "contrib", { stage: "contacted" });
  const met = expectStatus(await log(h, "contrib", metLead.id, { kind: "meeting", direction: "in", replyType: "interested", body: "Met at the expo" }), 201);
  assert.deepEqual([met.data.activity.kind, met.data.activity.direction, met.data.activity.replyType, met.data.lead.stage, met.data.lead.nextAction], ["meeting", "in", "interested", "replied", "Book the discovery call"]);
  const metInbox = (await h.call("contrib", "GET", "/sales/inbox?handled=false&owner=me")).data.find((entry: any) => entry.activity.id === met.data.activity.id);
  assert.match(metInbox.lead.why, /^Met us/);
  expectStatus(await log(h, "contrib", metLead.id, { kind: "meeting", direction: "in", body: "Dropped by again" }), 201);
  assert.equal(expectStatus(await log(h, "contrib", metLead.id, { kind: "meeting", body: "A meeting we held" }), 201).data.activity.direction, undefined);
  expectStatus(await log(h, "contrib", metLead.id, { kind: "note", direction: "in", replyType: "interested" }), 400);
  // Inbound: replied, follow-up cleared, pending follow-up drafts discarded (stop on reply); other drafts stay.
  const talker = await newLead(h, "contrib");
  await log(h, "contrib", talker.id, { kind: "email", direction: "out", at: iso(ist("2026-10-09", 15)) });
  const followDraft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${talker.id}/drafts`, { channel: "email", purpose: "follow_up", body: "Following up" }), 201).data;
  const replyDraft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${talker.id}/drafts`, { channel: "email", purpose: "reply", body: "Answering" }), 201).data;
  const reply = expectStatus(await log(h, "contrib", talker.id, { kind: "whatsapp", direction: "in", body: "Yes please call me" }), 201);
  assert.equal(reply.data.lead.stage, "replied");
  assert.equal(reply.data.lead.followUpDueAt, undefined);
  assert.equal(reply.data.lead.whatsappOptIn.how, "they_messaged");
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: followDraft.id }))?.status, "discarded");
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: replyDraft.id }))?.status, "in_review");
  // The reply waits in the Inbox until handled.
  const inbox = parse(successEnvelope(inboxItemSchema.array()), (await h.call("contrib", "GET", "/sales/inbox?handled=false&owner=me")).body).data;
  const item = inbox.find((entry) => entry.activity.id === reply.data.activity.id);
  assert.ok(item);
  assert.match(item.lead.why, /^Replied on WhatsApp/);
  expectStatus(await h.call("contrib2", "POST", `/sales/activities/${reply.data.activity.id}/handled`, {}), 403);
  const handled = expectStatus(await h.call("contrib", "POST", `/sales/activities/${reply.data.activity.id}/handled`, {}), 200);
  assert.ok(handled.data.handledAt);
  assert.ok(!(await h.call("contrib", "GET", "/sales/inbox?handled=false&owner=me")).data.some((entry: any) => entry.activity.id === reply.data.activity.id));
  assert.ok((await h.call("contrib", "GET", "/sales/inbox?handled=true&owner=me")).data.some((entry: any) => entry.activity.id === reply.data.activity.id));
  expectStatus(await h.call("contrib", "POST", `/sales/activities/${first.data.activity.id}/handled`, {}), 400); // outbound items are not in the Inbox
  // Reply types.
  const types = async (replyType: string, extra: Record<string, unknown> = {}) => { const l = await newLead(h, "contrib", extra); const r = expectStatus(await log(h, "contrib", l.id, { kind: "email", direction: "in", replyType, body: "reply" }), 201); return { id: l.id, lead: r.data.lead }; };
  const interested = await types("interested");
  assert.deepEqual([interested.lead.stage, interested.lead.nextAction], ["replied", "Book the discovery call"]);
  const wait = new Date(interested.lead.nextActionAt).getTime() - Date.now();
  assert.ok(wait > 0 && wait < 4 * 86_400_000, `due ${interested.lead.nextActionAt}`);
  assert.equal((await types("send_details")).lead.nextAction, "Send details");
  assert.equal((await types("wrong_person")).lead.nextAction, "Find the right person");
  assert.equal((await types("price_first")).lead.nextAction, "Answer price with a range and ask for a call");
  const notNow = await types("not_now");
  assert.equal(notNow.lead.stage, "thinking");
  assert.ok(new Date(notNow.lead.nextActionAt).getTime() - Date.now() > 28 * 86_400_000);
  for (const quiet of ["has_system", "unclear"]) assert.equal((await types(quiet)).lead.stage, "replied");
  // Validation: a reply type needs an inbound message; a call outcome needs an outbound call.
  expectStatus(await log(h, "contrib", lead.id, { kind: "email", direction: "out", replyType: "interested" }), 400);
  expectStatus(await log(h, "contrib", lead.id, { kind: "email", direction: "out", callOutcome: "busy" }), 400);
});

test("opt-out and hostile replies disqualify, suppress every route and block all outbound actions", skip, async () => {
  const h = await getHarness();
  const n = ++counter;
  const email = `Boss${n}@Optout${n}.example`;
  const lead = await newLead(h, "contrib", { companyName: `Optout${n} Industries Pvt Ltd`, contactRoutes: [{ kind: "email", value: email }, { kind: "phone", value: "09123400000" }, { kind: "whatsapp", value: "+91 91234 00001" }], website: `https://www.optout${n}.example` });
  // The same company in another venture's pipeline, with the phone written differently, and an unrelated lead.
  const twin = expectStatus(await h.call("admin", "POST", "/sales/leads", { pipelineId: "pipeline-b", companyName: `Another name ${n}`, ownerId: "user-admin", contactRoutes: [{ kind: "phone", value: "+91-91234-00000" }] }), 201).data;
  const stranger = await newLead(h, "contrib");
  // Another mailbox of the company's own domain, with a draft waiting: it is flagged too and its draft is discarded.
  const sameDomain = await newLead(h, "contrib", { companyName: `Sister firm ${n}`, contactRoutes: [{ kind: "email", value: `sales@optout${n}.example` }] });
  const sisterDraft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${sameDomain.id}/drafts`, { channel: "email", body: "Hello sister" }), 201).data;
  const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", body: "Hello" }), 201).data;
  const reply = expectStatus(await log(h, "contrib", lead.id, { kind: "email", direction: "in", replyType: "opt_out", body: "Please stop contacting us" }), 201);
  const stored = parse(opportunitySchema, reply.data.lead);
  assert.deepEqual([stored.stage, stored.exitReason, stored.doNotContact], ["disqualified", "Asked not to be contacted", true]);
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: draft.id }))?.status, "discarded");
  const entries = (await h.database.db.collection("sales_suppression").find({ workspaceId: "workspace-a" }).toArray()).map((entry) => entry.key as string);
  for (const key of [`email:boss${n}@optout${n}.example`, "phone:+919123400000", "phone:+919123400001", `company:optout${n} industries`, `domain:optout${n}.example`]) assert.ok(entries.includes(key), key);
  assert.equal((await leadDoc(h, sameDomain.id)).doNotContact, true);
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: sisterDraft.id }))?.status, "discarded");
  // Spellings of the same mailbox, number, domain and company are all caught when they arrive later.
  const variants: [string, Record<string, unknown>][] = [
    ["plus address", { companyName: `V one ${n}`, contactRoutes: [{ kind: "email", value: `Boss+promo@Optout${n}.Example` }] }],
    ["trailing dot (in an other route)", { companyName: `V two ${n}`, contactRoutes: [{ kind: "other", value: `other@optout${n}.example.` }] }],
    ["same domain website", { companyName: `V three ${n}`, website: `https://optout${n}.example/contact`, contactRoutes: [] }],
    ["company in brackets", { companyName: `OPTOUT${n} Industries (Raipur)`, contactRoutes: [] }],
    ["company with &", { companyName: `Optout${n} Industries & Co`, contactRoutes: [] }],
    ["company LLP", { companyName: `Optout${n} Industries LLP`, contactRoutes: [] }],
    ["mailto in an other route", { companyName: `V four ${n}`, contactRoutes: [{ kind: "other", value: `mailto:Boss${n}@Optout${n}.Example?subject=Hi` }] }],
    ["number in a sentence", { companyName: `V five ${n}`, contactRoutes: [{ kind: "other", value: "Reach the shop on 91234 00000 (ext 5) or 91234 00001" }] }],
    ["wa.me link", { companyName: `V six ${n}`, contactRoutes: [{ kind: "website_form", value: "https://wa.me/919123400001" }] }],
    ["Devanagari digits", { companyName: `V seven ${n}`, contactRoutes: [{ kind: "other", value: "फोन ९१२३४ ००००० " }] }],
  ];
  for (const [label, extra] of variants) {
    const made = expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", ownerId: "user-contrib", ...extra }), 201);
    assert.equal(made.data.doNotContact, true, label);
  }
  // Mail providers are never a match: another person on gmail is not blocked by an opt-out from a gmail address.
  const gmailBoss = await newLead(h, "contrib", { companyName: `Gmail boss ${n}`, contactRoutes: [{ kind: "email", value: `boss${n}@gmail.com` }] });
  expectStatus(await log(h, "contrib", gmailBoss.id, { kind: "email", direction: "in", replyType: "opt_out", body: "Stop" }), 201);
  assert.ok(!(await h.database.db.collection("sales_suppression").findOne({ key: "domain:gmail.com" })));
  const otherGmail = expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", ownerId: "user-contrib", companyName: `Other gmail ${n}`, contactRoutes: [{ kind: "email", value: `someone${n}@gmail.com` }] }), 201);
  assert.notEqual(otherGmail.data.doNotContact, true);
  // Matching leads anywhere in the workspace are flagged; others are not.
  assert.equal((await leadDoc(h, twin.id)).doNotContact, true);
  assert.notEqual((await leadDoc(h, stranger.id)).doNotContact, true);
  // Every outbound action is refused.
  expectStatus(await log(h, "contrib", lead.id, { kind: "email", direction: "out" }), 409);
  expectStatus(await log(h, "contrib", lead.id, { kind: "call", direction: "out", callOutcome: "no_answer" }), 409);
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", body: "Hello again" }), 409);
  expectStatus(await log(h, "contrib", lead.id, { kind: "note", body: "A note is fine" }), 201);
  // Creating a new lead with a suppressed route is flagged on arrival.
  const again = expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Fresh name ${n}`, ownerId: "user-contrib", contactRoutes: [{ kind: "email", value: email.toLowerCase() }] }), 201);
  assert.equal(again.data.doNotContact, true);
  // Hostile replies work the same way.
  const hostile = await newLead(h, "contrib");
  const hostileReply = expectStatus(await log(h, "contrib", hostile.id, { kind: "email", direction: "in", replyType: "hostile", body: "Go away" }), 201);
  assert.deepEqual([hostileReply.data.lead.stage, hostileReply.data.lead.exitReason, hostileReply.data.lead.doNotContact], ["disqualified", "Hostile reply", true]);
});

test("call outcomes set the stage and the next action", skip, async () => {
  const h = await getHarness();
  const outcome = async (callOutcome: string, extra: Record<string, unknown> = {}, lead?: { id: string }) => {
    const target = lead ?? await newLead(h, "contrib");
    const reply = expectStatus(await log(h, "contrib", target.id, { kind: "call", direction: "out", callOutcome, body: "Call", ...extra }), 201);
    return { lead: reply.data.lead, activity: reply.data.activity, id: target.id };
  };
  const booked = await outcome("interested_book");
  assert.equal(booked.lead.stage, "discovery_booked");
  assert.equal(booked.lead.followUpDueAt, undefined);
  assert.equal(booked.activity.stageFrom, "identified");
  assert.deepEqual([(await outcome("send_details")).lead.stage, (await outcome("send_details")).lead.nextAction], ["replied", "Send details"]);
  const callBack = await outcome("call_back", { nextActionAt: "2026-10-15T08:30:00.000Z" });
  assert.deepEqual([callBack.lead.nextAction, callBack.lead.nextActionAt, callBack.lead.stage], ["Call back", "2026-10-15T08:30:00.000Z", "contacted"]);
  assert.ok((await outcome("call_back")).lead.nextActionAt);
  for (const noAnswer of ["no_answer", "busy"]) {
    const result = await outcome(noAnswer);
    assert.deepEqual([result.lead.stage, result.lead.nextAction], ["contacted", "Call again"]);
    assert.ok(result.lead.followUpDueAt, "the first try also counts as contacted and starts the follow-up clock");
    assert.ok(result.lead.lastTouchAt);
  }
  const lost = await outcome("not_interested");
  assert.deepEqual([lost.lead.stage, lost.lead.exitReason], ["lost", "Not interested on call"]);
  assert.equal((await outcome("wrong_person")).lead.nextAction, "Find the right person");
  const wrongNumber = await outcome("wrong_number");
  assert.equal(wrongNumber.lead.stage, "identified");
  assert.equal(wrongNumber.lead.lastTouchAt, undefined);
  assert.equal(wrongNumber.activity.callOutcome, "wrong_number");
  const yes = await outcome("yes_whatsapp");
  assert.deepEqual([yes.lead.stage, yes.lead.whatsappOptIn.how, yes.lead.nextAction], ["replied", "yes_on_call", "Send details on WhatsApp"]);
  // A call outcome further back in the pipeline never moves a lead backwards.
  const later = await newLead(h, "contrib", { stage: "proposal" });
  assert.equal((await outcome("send_details", {}, later)).lead.stage, "proposal");
  // What the person types wins over the automatic next step.
  const custom = await outcome("no_answer", { nextAction: "Try the shop on Saturday", nextActionAt: "2026-10-17T05:00:00.000Z" });
  assert.deepEqual([custom.lead.nextAction, custom.lead.nextActionAt], ["Try the shop on Saturday", "2026-10-17T05:00:00.000Z"]);
});

test("stage edits need an exit reason, accept the older stage names and record the won date", skip, async () => {
  const h = await getHarness();
  const lead = await newLead(h, "contrib");
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { stage: "lost" }), 400);
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { stage: "disqualified" }), 400);
  const lostReply = expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { stage: "lost", exitReason: "Chose a competitor", lostReason: "chose_competitor" }), 200);
  assert.deepEqual([lostReply.data.stage, lostReply.data.exitReason], ["lost", "Chose a competitor"]);
  // Reopening drops the exit reason.
  const reopened = expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { stage: "conversation" }), 200); // older name
  assert.equal(reopened.data.stage, "replied");
  assert.equal(reopened.data.exitReason, undefined);
  // Creating a lead directly as lost needs a reason too.
  expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Lost ${suffix}`, ownerId: "user-contrib", stage: "lost" }), 400);
  // The older "won" stage is accepted and becomes invoice_contract with a won date.
  const won = expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { stage: "won" }), 200);
  assert.equal(won.data.stage, "invoice_contract");
  assert.ok(won.data.wonAt);
  const wonAt = won.data.wonAt;
  // Moving within the won stages keeps the first won date.
  assert.equal((await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { stage: "cash_collected" })).data.wonAt, wonAt);
  // The older /opportunities routes share the rules and the records.
  const legacy = await fetch(`${h.origin}/v1/opportunities/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-user": "user-contrib" }, body: JSON.stringify({ stage: "lost" }) });
  assert.equal(legacy.status, 400);
  const legacyOk = await fetch(`${h.origin}/v1/opportunities/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-user": "user-contrib" }, body: JSON.stringify({ stage: "won" }) });
  assert.equal(legacyOk.status, 200);
  assert.equal(((await legacyOk.json()) as any).data.stage, "invoice_contract");
  const created = await fetch(`${h.origin}/v1/opportunities`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": "user-contrib" }, body: JSON.stringify({ pipelineId: "pipeline-a", companyName: `Legacy deal ${suffix}`, ownerId: "user-contrib", stage: "conversation" }) });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as any).data.stage, "replied");
  // Every manual stage change leaves a note on the timeline.
  const detail = parse(successEnvelope(leadDetailSchema), (await h.call("contrib", "GET", `/sales/leads/${lead.id}`)).body).data;
  assert.ok(detail.activities.some((activity) => activity.stageTo === "invoice_contract" && activity.stageFrom === "replied"));
});

test("a partial update changes only the fields sent: no schema default is re-applied to a lead or a play", skip, async () => {
  const h = await getHarness();
  const lead = await newLead(h, "contrib", {
    stage: "qualified", source: "Referral from Sharma", observedSignal: "Hiring a dispatch clerk", fitReason: "Runs orders by phone", evidenceConfidence: "high", contactName: "Mr Sharma", tags: ["pumps", "raipur"], valueEstimateMinor: 250_000, currency: "INR",
    city: "Raipur", category: "pumps", relevance: 72, fitBand: "A", contactRoutes: [{ kind: "email", value: "sharma@regress.example" }, { kind: "phone", value: "98765 00000", label: "Shop" }],
  });
  const keeps = (stored: any, contactName = "Mr Sharma") => {
    assert.equal(stored.stage, "qualified");
    assert.equal(stored.source, "Referral from Sharma");
    assert.equal(stored.observedSignal, "Hiring a dispatch clerk");
    assert.equal(stored.fitReason, "Runs orders by phone");
    assert.equal(stored.evidenceConfidence, "high");
    assert.equal(stored.contactName, contactName);
    assert.deepEqual(stored.tags, ["pumps", "raipur"]);
    assert.deepEqual(stored.contactRoutes.map((route: any) => route.value), ["sharma@regress.example", "98765 00000"]);
    assert.deepEqual([stored.valueEstimateMinor, stored.currency, stored.city, stored.category, stored.relevance, stored.fitBand], [250_000, "INR", "Raipur", "pumps", 72, "A"]);
  };
  // The new route and the older one, one field at a time.
  const patched = expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { nextAction: "Call them on Monday" }), 200).data;
  assert.equal(patched.nextAction, "Call them on Monday");
  keeps(patched);
  keeps((await leadDoc(h, lead.id)));
  const legacy = await fetch(`${h.origin}/v1/opportunities/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-user": "user-contrib" }, body: JSON.stringify({ contactName: "Mr Sharma (owner)" }) });
  assert.equal(legacy.status, 200);
  const legacyBody = ((await legacy.json()) as any).data;
  assert.equal(legacyBody.contactName, "Mr Sharma (owner)");
  assert.equal(legacyBody.nextAction, "Call them on Monday");
  assert.deepEqual([legacyBody.stage, legacyBody.source, legacyBody.tags], ["qualified", "Referral from Sharma", ["pumps", "raipur"]]);
  // A venture head editing, a stage-only edit and an owner-only edit leave the rest alone too.
  keeps((await h.call("head", "PATCH", `/sales/leads/${lead.id}`, { valueEstimateMinor: 250_000 })).data, "Mr Sharma (owner)");
  const staged = (await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { stage: "proposal" })).data;
  assert.deepEqual([staged.stage, staged.source, staged.tags, staged.nextAction, staged.contactRoutes.length], ["proposal", "Referral from Sharma", ["pumps", "raipur"], "Call them on Monday", 2]);
  // The only stored fields that changed are the ones sent (plus updatedAt, and the stage note's side effects).
  const before = await leadDoc(h, lead.id);
  await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { city: "Bilaspur" });
  const after = await leadDoc(h, lead.id);
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])).sort();
  assert.deepEqual(changed, ["city", "updatedAt"]);
  // Plays: a status change keeps steps, batch size and the rest of the plan.
  const play = expectStatus(await h.call("head", "POST", "/sales/plays", { ventureId: "venture-a", name: `Keep me ${suffix}`, motion: "volume", audience: "Dealers", offerName: "Order desk", hypothesis: "H", metric: "M", stopRule: "Stop on reply", batchSize: 25, steps: [{ day: 0, channel: "call", action: "Call" }, { day: 4, channel: "email", action: "Follow up" }] }), 201).data;
  expectStatus(await h.call("head", "POST", `/sales/plays/${play.id}/approve`, {}), 200);
  const running = expectStatus(await h.call("head", "PATCH", `/sales/plays/${play.id}`, { status: "paused" }), 200).data;
  assert.equal(running.status, "paused");
  assert.deepEqual([running.batchSize, running.motion, running.audience, running.offerName, running.hypothesis, running.metric, running.stopRule], [25, "volume", "Dealers", "Order desk", "H", "M", "Stop on reply"]);
  assert.deepEqual(running.steps.map((step: any) => step.action), ["Call", "Follow up"]);
  assert.equal(running.approvedBy, "user-head");
  assert.equal((await h.call("head", "PATCH", `/sales/plays/${play.id}`, { name: "Renamed" })).data.steps.length, 2);
  const stored = (await h.database.db.collection("sales_plays").findOne({ _id: play.id }))!;
  assert.deepEqual([stored.batchSize, stored.motion, stored.status, stored.name], [25, "volume", "paused", "Renamed"]);
  // Brain items and drafts: partial edits keep the other field.
  const brain = expectStatus(await h.call("contrib", "POST", "/sales/brain", { ventureId: "venture-a", kind: "notes", title: `Keep ${suffix}`, body: "Body stays" }), 201).data;
  const retitled = expectStatus(await h.call("contrib", "PATCH", `/sales/brain/${brain.id}`, { title: `Kept ${suffix}` }), 200).data;
  assert.deepEqual([retitled.title, retitled.body], [`Kept ${suffix}`, "Body stays"]);
  const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", subject: "Keep this subject", body: "Original body" }), 201).data;
  const edited = expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${draft.id}`, { body: "New body" }), 200).data;
  assert.deepEqual([edited.subject, edited.body], ["Keep this subject", "New body"]);
});

test("a reply can be sorted into a reply type afterwards, with the same rules as logging it with the type", skip, async () => {
  const h = await getHarness();
  const setType = (who: Who, activityId: string, replyType: string, options?: { via?: "claude" }) => h.call(who, "PATCH", `/sales/activities/${activityId}`, { replyType }, options);
  const reply = async (extra: Record<string, unknown> = {}) => {
    const lead = await newLead(h, "contrib", extra);
    const logged = expectStatus(await log(h, "contrib", lead.id, { kind: "email", direction: "in", body: "Please call me back" }), 201);
    assert.equal(logged.data.activity.replyType, undefined);
    return { lead, activity: logged.data.activity };
  };
  // interested -> next action "Book the discovery call"; the response parses with the contract.
  const first = await reply();
  const interested = expectStatus(await setType("contrib", first.activity.id, "interested"), 200);
  assert.equal(parse(activitySchema, interested.data.activity).replyType, "interested");
  assert.deepEqual([parse(opportunitySchema, interested.data.lead).stage, interested.data.lead.nextAction], ["replied", "Book the discovery call"]);
  assert.equal(interested.data.activity.handledAt, undefined);
  // Changing it applies the new type's rules: not_now -> thinking, check back in about 30 days, noted on the timeline.
  const notNow = expectStatus(await setType("contrib", first.activity.id, "not_now"), 200).data;
  assert.equal(notNow.activity.replyType, "not_now");
  assert.equal(notNow.lead.stage, "thinking");
  assert.ok(new Date(notNow.lead.nextActionAt).getTime() - Date.now() > 28 * 86_400_000);
  const timeline = parse(successEnvelope(leadDetailSchema), (await h.call("contrib", "GET", `/sales/leads/${first.lead.id}`)).body).data;
  assert.ok(timeline.activities.some((activity) => activity.via === "system" && activity.stageFrom === "replied" && activity.stageTo === "thinking"));
  // The same type again changes nothing.
  const same = expectStatus(await setType("contrib", first.activity.id, "not_now"), 200).data;
  assert.equal(same.lead.updatedAt, notNow.lead.updatedAt);
  // The other types.
  for (const [type, action] of [["send_details", "Send details"], ["wrong_person", "Find the right person"], ["price_first", "Answer price with a range and ask for a call"]] as const) {
    const item = await reply();
    assert.equal(expectStatus(await setType("contrib", item.activity.id, type), 200).data.lead.nextAction, action);
  }
  const quiet = await reply();
  assert.equal(expectStatus(await setType("contrib", quiet.activity.id, "has_system"), 200).data.lead.stage, "replied");
  // Opt-out: disqualified, do not contact, every route suppressed, unsent drafts discarded; and it cannot be changed again.
  const n = ++counter;
  const out = await reply({ companyName: `Reply Opt${n} Works`, contactRoutes: [{ kind: "email", value: `Stop${n}@replyopt${n}.example` }, { kind: "phone", value: "09222200000" }] });
  const pending = expectStatus(await h.call("contrib", "POST", `/sales/leads/${out.lead.id}/drafts`, { channel: "email", body: "Hello again" }), 201).data;
  const optOut = expectStatus(await setType("contrib", out.activity.id, "opt_out"), 200).data;
  assert.deepEqual([optOut.lead.stage, optOut.lead.exitReason, optOut.lead.doNotContact], ["disqualified", "Asked not to be contacted", true]);
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: pending.id }))?.status, "discarded");
  const keys = (await h.database.db.collection("sales_suppression").find({ leadId: out.lead.id }).toArray()).map((entry) => entry.key).sort();
  assert.deepEqual(keys, [`company:reply opt${n} works`, `domain:replyopt${n}.example`, `email:stop${n}@replyopt${n}.example`, "phone:+919222200000"]);
  expectStatus(await log(h, "contrib", out.lead.id, { kind: "email", direction: "out" }), 409);
  expectStatus(await setType("contrib", out.activity.id, "interested"), 409);
  expectStatus(await setType("head", out.activity.id, "not_now"), 409);
  assert.equal(expectStatus(await setType("contrib", out.activity.id, "opt_out"), 200).data.lead.stage, "disqualified");
  assert.equal((await leadDoc(h, out.lead.id)).doNotContact, true);
  // Hostile works the same way, as the token owner through Claude too.
  const hostile = await reply();
  const hostileDone = expectStatus(await setType("contrib", hostile.activity.id, "hostile", { via: "claude" }), 200).data.lead;
  assert.deepEqual([hostileDone.stage, hostileDone.exitReason, hostileDone.doNotContact], ["disqualified", "Hostile reply", true]);
  expectStatus(await setType("contrib", hostile.activity.id, "unclear"), 409);
  // Only inbound items, only people who may log activity on the lead, and only known types.
  const outbound = expectStatus(await log(h, "contrib", first.lead.id, { kind: "email", direction: "out" }), 201);
  expectStatus(await setType("contrib", outbound.data.activity.id, "interested"), 400);
  const other = await reply();
  expectStatus(await setType("contrib2", other.activity.id, "interested"), 403);
  expectStatus(await setType("learner", other.activity.id, "interested"), 403);
  expectStatus(await setType("outsider", other.activity.id, "interested"), 404);
  expectStatus(await setType("head", other.activity.id, "interested"), 200);
  expectStatus(await setType("contrib", other.activity.id, "maybe"), 400);
  expectStatus(await h.call("contrib", "PATCH", `/sales/activities/${other.activity.id}`, {}), 400);
  expectStatus(await setType("contrib", "no-such-activity", "interested"), 404);
  const audited = await h.database.db.collection("audit_events").find({ action: "sales.activity.reply_type", objectId: other.activity.id }).toArray();
  assert.equal(audited.length, 1);
  assert.equal(audited[0]!.metadata.replyType, "interested");
});

test("PATCH with nextActionAt null clears the date and leaves everything else", skip, async () => {
  const h = await getHarness();
  const lead = await newLead(h, "contrib", { stage: "researched", nextAction: "Call on Monday", nextActionAt: "2026-10-12T05:00:00.000Z", tags: ["keep"], source: "Referral" });
  assert.equal(lead.nextActionAt, "2026-10-12T05:00:00.000Z");
  const cleared = expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { nextActionAt: null }), 200).data;
  assert.equal(cleared.nextActionAt, undefined);
  assert.deepEqual([cleared.nextAction, cleared.stage, cleared.tags, cleared.source], ["Call on Monday", "researched", ["keep"], "Referral"]);
  parse(opportunitySchema, cleared);
  assert.equal(Object.hasOwn(await leadDoc(h, lead.id), "nextActionAt"), false);
  // Setting it again, and clearing it together with a new next action text, through either route.
  assert.equal((await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { nextActionAt: "2026-10-13T05:00:00.000Z" })).data.nextActionAt, "2026-10-13T05:00:00.000Z");
  const both = expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { nextAction: "Wait for their reply", nextActionAt: null }), 200).data;
  assert.deepEqual([both.nextAction, both.nextActionAt], ["Wait for their reply", undefined]);
  const legacy = await fetch(`${h.origin}/v1/opportunities/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-user": "user-contrib" }, body: JSON.stringify({ nextActionAt: "2026-10-14T05:00:00.000Z" }) });
  assert.equal(legacy.status, 200);
  const legacyClear = await fetch(`${h.origin}/v1/opportunities/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-user": "user-contrib" }, body: JSON.stringify({ nextActionAt: null }) });
  assert.equal(legacyClear.status, 200);
  assert.equal(((await legacyClear.json()) as any).data.nextActionAt, undefined);
  // The usual rights and validation still apply.
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { nextActionAt: null }), 403);
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${lead.id}`, { nextActionAt: "tomorrow" }), 400);
});

test("brain items can be archived: a head any item, the proposer their own draft, never an approved item by Claude", skip, async () => {
  const h = await getHarness();
  const propose = (who: Who, title: string, options?: { via?: "claude" }) => h.call(who, "POST", "/sales/brain", { ventureId: "venture-a", kind: "notes", title: `${title} ${suffix}`, body: "Notes" }, options);
  const archive = (who: Who, id: string, options?: { via?: "claude" }) => h.call(who, "POST", `/sales/brain/${id}/archive`, {}, options);
  // A draft: its proposer (or a head) archives it; nobody else.
  const draft = parse(brainItemSchema, expectStatus(await propose("contrib", "Archive me"), 201).data);
  expectStatus(await archive("contrib2", draft.id), 403);
  expectStatus(await archive("reviewer", draft.id), 403);
  expectStatus(await archive("learner", draft.id), 403);
  expectStatus(await archive("outsider", draft.id), 404);
  const archived = parse(brainItemSchema, expectStatus(await archive("contrib", draft.id), 200).data);
  assert.equal(archived.status, "archived");
  expectStatus(await archive("contrib", draft.id), 409);
  expectStatus(await h.call("contrib", "PATCH", `/sales/brain/${draft.id}`, { body: "Edit archived" }), 409);
  expectStatus(await h.call("head", "POST", `/sales/brain/${draft.id}/approve`, {}), 409);
  assert.ok(!(await h.call("learner", "GET", "/sales/brain?ventureId=venture-a")).data.some((item: any) => item.id === draft.id));
  assert.ok((await h.call("learner", "GET", "/sales/brain?ventureId=venture-a&status=archived")).data.some((item: any) => item.id === draft.id));
  // Claude archives a draft it proposed as the token owner; a head archives anyone's draft.
  const viaClaude = await propose("contrib", "Claude draft", { via: "claude" });
  assert.equal(expectStatus(await archive("contrib", viaClaude.data.id, { via: "claude" }), 200).data.status, "archived");
  const others = await propose("contrib2", "Someone else's draft");
  assert.equal(expectStatus(await archive("head", others.data.id), 200).data.status, "archived");
  // An approved item: a head or admin in the app; Claude and proposers cannot.
  const live = expectStatus(await propose("contrib", "Approved item"), 201).data;
  expectStatus(await h.call("head", "POST", `/sales/brain/${live.id}/approve`, {}), 200);
  expectStatus(await archive("contrib", live.id), 403);
  expectStatus(await archive("head", live.id, { via: "claude" }), 403);
  expectStatus(await archive("admin", live.id, { via: "claude" }), 403);
  assert.equal((await h.database.db.collection("sales_brain_items").findOne({ _id: live.id }))?.status, "approved");
  const gone = expectStatus(await archive("head", live.id), 200).data;
  assert.equal(gone.status, "archived");
  const audit = await h.database.db.collection("audit_events").findOne({ action: "sales.brain.archive", objectId: live.id });
  assert.equal(audit?.metadata.was, "approved");
  // Archiving the approved version leaves no approved item for that title; a new proposal starts the next version.
  const next = parse(brainItemSchema, expectStatus(await propose("contrib", "Approved item"), 201).data);
  assert.equal(next.version, 2);
});

test("a brain proposal can replace several approved items: checked when proposed, all retired in the approval", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const propose = (who: Who, input: Record<string, unknown>, options?: { via?: "claude" }) => h.call(who, "POST", "/sales/brain", { ventureId: "venture-a", body: "Rules", ...input }, options);
  const approve = async (id: string) => expectStatus(await h.call("head", "POST", `/sales/brain/${id}/approve`, {}), 200).data;
  const approved = async (kind: string, title: string, ventureId = "venture-a") => { const item = expectStatus(await propose("head", { kind, title: `${title} ${suffix}`, ventureId }), 201).data; await approve(item.id); return item as { id: string }; };
  const doc = (id: string) => db.collection("sales_brain_items").findOne({ _id: id });
  // Overlapping approved items in two kinds (the shared ones: offers live in offers now), one that stays, and the merged item's own same-title predecessor.
  const tone = await approved("venture_settings", "Tone");
  const length = await approved("venture_settings", "Length");
  const pricing = await approved("notes", "Pricing talk");
  const keep = await approved("notes", "Keep me");
  const predecessor = await approved("venture_settings", "Writing rules");
  // Only approved items of the same venture: not a draft, an archived item, another venture's item or an unknown id.
  const draft = expectStatus(await propose("contrib", { kind: "notes", title: `Just a draft ${suffix}` }), 201).data;
  const gone = await approved("notes", "Gone");
  expectStatus(await h.call("head", "POST", `/sales/brain/${gone.id}/archive`, {}), 200);
  const elsewhere = await approved("notes", "Gamma rules", "venture-c");
  for (const bad of [draft.id, gone.id, elsewhere.id, "no-such-item"]) {
    const refused = expectStatus(await propose("contrib", { kind: "venture_settings", title: `Bad ${suffix}`, replaces: [tone.id, bad] }), 400);
    assert.match(JSON.stringify(refused.body), /only replace approved items of the same venture.*not: /, bad);
  }
  expectStatus(await propose("contrib", { kind: "notes", title: `Too many ${suffix}`, replaces: Array.from({ length: 21 }, (_, index) => `id-${index}`) }), 400);
  assert.equal(await db.collection("sales_brain_items").countDocuments({ title: { $in: [`Bad ${suffix}`, `Too many ${suffix}`] } }), 0);

  // Proposing (here through Claude): duplicates dropped, any kind, and the predecessor may be listed. The answer names the items.
  const merged = parse(brainItemSchema, expectStatus(await propose("contrib", { kind: "venture_settings", title: `Writing rules ${suffix}`, body: "One clean set", replaces: [tone.id, length.id, tone.id, predecessor.id] }, { via: "claude" }), 201).data);
  assert.deepEqual([merged.status, merged.version, merged.replaces], ["draft", 2, [tone.id, length.id, predecessor.id]]);
  assert.deepEqual(merged.replacesItems?.map((entry) => [entry.title, entry.kind, entry.version, entry.status]), [[`Tone ${suffix}`, "venture_settings", 1, "approved"], [`Length ${suffix}`, "venture_settings", 1, "approved"], [`Writing rules ${suffix}`, "venture_settings", 1, "approved"]]);
  // Editing the draft changes the list, with the same checks.
  expectStatus(await h.call("contrib", "PATCH", `/sales/brain/${merged.id}`, { replaces: [elsewhere.id] }), 400);
  expectStatus(await h.call("contrib", "PATCH", `/sales/brain/${merged.id}`, { replaces: [draft.id] }), 400);
  const edited = parse(brainItemSchema, expectStatus(await h.call("contrib", "PATCH", `/sales/brain/${merged.id}`, { replaces: [tone.id, length.id, pricing.id, predecessor.id, length.id] }), 200).data);
  assert.deepEqual(edited.replaces, [tone.id, length.id, pricing.id, predecessor.id]);
  assert.equal(edited.replacesItems?.length, 4);
  assert.equal((await h.call("learner", "GET", "/sales/brain?ventureId=venture-a")).data.find((entry: any) => entry.id === merged.id).replacesItems.length, 4);

  // Approving stays a person's decision: never Claude, never a contributor. Nothing retires until then.
  expectStatus(await h.call("head", "POST", `/sales/brain/${merged.id}/approve`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("admin", "POST", `/sales/brain/${merged.id}/approve`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("contrib", "POST", `/sales/brain/${merged.id}/approve`, {}), 403);
  assert.equal((await doc(tone.id))?.status, "approved");
  // One listed item is archived meanwhile: the approval skips it silently.
  expectStatus(await h.call("head", "POST", `/sales/brain/${pricing.id}/archive`, {}), 200);
  const done = parse(brainItemSchema, await approve(merged.id));
  assert.deepEqual([done.status, done.retired], ["approved", 2], "the predecessor goes as the previous version, and is not counted");
  for (const id of [tone.id, length.id, predecessor.id]) {
    const row = await doc(id);
    assert.deepEqual([row?.status, row?.replacedBy, row?.archivedBy, row?.archivedAt instanceof Date], ["archived", merged.id, "user-head", true], id);
  }
  assert.deepEqual([(await doc(pricing.id))?.status, (await doc(pricing.id))?.replacedBy], ["archived", undefined]);
  assert.equal((await doc(keep.id))?.status, "approved");
  assert.equal((await doc(elsewhere.id))?.status, "approved");
  const audit = await db.collection("audit_events").findOne({ action: "sales.brain.approve", objectId: merged.id });
  assert.deepEqual([audit?.metadata.retired, audit?.metadata.version], [2, 2]);
  // The list: the retired items are out of the approved ones; the approved item still names what it replaced.
  const live = parse(successEnvelope(brainItemSchema.array()), (await h.call("learner", "GET", "/sales/brain?ventureId=venture-a")).body).data;
  assert.deepEqual(live.filter((entry) => [tone.id, length.id, pricing.id, predecessor.id].includes(entry.id)), []);
  assert.ok(live.some((entry) => entry.id === keep.id));
  assert.deepEqual(live.find((entry) => entry.id === merged.id)?.replacesItems?.map((entry) => entry.status), ["archived", "archived", "archived", "archived"]);
  // A new proposal can't name the retired items any more.
  expectStatus(await propose("contrib", { kind: "notes", title: `Later ${suffix}`, replaces: [tone.id] }), 400);
});

test("Claude's requests keep to the safety rules the tools rely on: verdicts, stages, WhatsApp opt-in, silence", skip, async () => {
  const h = await getHarness();
  const claude = { via: "claude" as const };
  const verdict = (decision: string, confidence: string) => ({ decision, confidence, offer: "Order tracking", offerFit: "Orders by phone", evidence: [{ claim: "Takes orders by phone", quote: "Call us to order", url: "https://example.com/contact" }], against: "Small team", summary: `Verdict ${decision} ${confidence}` });
  const saveVerdict = (who: Who, leadId: string, decision: string, confidence: string, options?: { via?: "claude" }) => h.call(who, "POST", `/sales/leads/${leadId}/verdicts`, verdict(decision, confidence), options);
  const stageOf = async (id: string) => (await leadDoc(h, id)).stage;
  const patchStage = (who: Who, id: string, body: Record<string, unknown>, options?: { via?: "claude" }) => h.call(who, "PATCH", `/sales/leads/${id}`, body, options);
  const patchLegacy = (who: Who, id: string, body: unknown, via = false) => fetch(`${h.origin}/v1/opportunities/${id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-user": `user-${who}`, ...(via ? { "x-test-via": "claude" } : {}) }, body: JSON.stringify(body) });

  // 1. Verdicts: Claude may judge a fresh lead, but not replace a verdict a person overrode, nor one that waits for a person.
  const judged = await newLead(h, "contrib");
  assert.equal((await saveVerdict("contrib", judged.id, "recommend", "high", claude)).status, 201);
  assert.equal((await saveVerdict("contrib", judged.id, "recommend", "medium", claude)).status, 201); // a clear verdict can be refreshed
  const waiting = await newLead(h, "contrib");
  const held = expectStatus(await saveVerdict("contrib", waiting.id, "hold", "low", claude), 201).data;
  assert.equal(held.lead.needsYou, true);
  const needsYou = expectStatus(await saveVerdict("contrib", waiting.id, "recommend", "high", claude), 409);
  assert.match(needsYou.body.error.message, /needs you|person/i);
  assert.equal((await h.database.db.collection("sales_verdicts").countDocuments({ leadId: waiting.id })), 1);
  // A person can still save one in the app, and override; afterwards Claude is refused because a person decided.
  expectStatus(await h.call("contrib", "POST", `/sales/verdicts/${held.verdict.id}/override`, { decision: "recommend", reason: "Spoke to the owner" }), 200);
  assert.equal((await leadDoc(h, waiting.id)).needsYou, false);
  const overridden = expectStatus(await saveVerdict("contrib", waiting.id, "hold", "high", claude), 409);
  assert.match(overridden.body.error.message, /overrode/);
  expectStatus(await saveVerdict("contrib", waiting.id, "recommend", "high"), 201); // the person's own new verdict (app) replaces it
  assert.equal((await leadDoc(h, waiting.id)).verdict.overridden, false);
  // The verdict is now a person's: Claude cannot replace it either.
  assert.equal((await leadDoc(h, waiting.id)).verdict.via, "app");
  const personVerdict = expectStatus(await saveVerdict("contrib", waiting.id, "recommend", "medium", claude), 409);
  assert.match(personVerdict.body.error.message, /person set/);

  // 2. Stages: Claude cannot approve for contact, reopen a closed lead, or send a contacted lead back; people can.
  const approveRefused = (reply: Reply) => { assert.equal(reply.status, 403, JSON.stringify(reply.body)); assert.match(reply.body.error.message, /person|app/); };
  expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Claude approved ${suffix}`, ownerId: "user-contrib", stage: "approved_for_contact" }, claude), 403);
  assert.equal(expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Claude researched ${suffix}`, ownerId: "user-contrib", stage: "researched" }, claude), 201).data.stage, "researched");
  const fresh = await newLead(h, "contrib");
  approveRefused(await patchStage("contrib", fresh.id, { stage: "approved_for_contact" }, claude));
  const legacyRefused = await patchLegacy("contrib", fresh.id, { stage: "approved_for_contact" }, true);
  assert.equal(legacyRefused.status, 403);
  assert.equal(await stageOf(fresh.id), "identified");
  expectStatus(await patchStage("contrib", fresh.id, { stage: "researched" }, claude), 200); // allowed
  expectStatus(await patchStage("contrib", fresh.id, { nextAction: "Research more" }, claude), 200); // other edits are fine
  assert.equal((await patchLegacy("contrib", fresh.id, { stage: "approved_for_contact" })).status, 200); // a person can (older route, app)
  assert.equal(await stageOf(fresh.id), "approved_for_contact");
  // Reopening lost / disqualified.
  const closed = await newLead(h, "contrib");
  expectStatus(await patchStage("contrib", closed.id, { stage: "lost", exitReason: "No budget" }, claude), 200); // Claude may close a lead with a reason
  approveRefused(await patchStage("contrib", closed.id, { stage: "replied" }, claude));
  approveRefused(await patchStage("contrib", closed.id, { stage: "identified" }, claude));
  assert.equal((await patchLegacy("contrib", closed.id, { stage: "replied" }, true)).status, 403);
  assert.equal(await stageOf(closed.id), "lost");
  expectStatus(await patchStage("head", closed.id, { exitReason: "Still no budget" }, claude), 200);
  assert.equal(expectStatus(await patchStage("contrib", closed.id, { stage: "replied" }), 200).data.stage, "replied"); // a person reopens
  // Contacted or later cannot go back to a stage before first contact.
  const contacted = await newLead(h, "contrib");
  expectStatus(await log(h, "contrib", contacted.id, { kind: "email", direction: "out" }), 201);
  for (const back of ["identified", "researched", "approved_for_contact"]) approveRefused(await patchStage("contrib", contacted.id, { stage: back }, claude));
  assert.equal((await patchLegacy("contrib", contacted.id, { stage: "researched" }, true)).status, 403);
  assert.equal(await stageOf(contacted.id), "contacted");
  expectStatus(await patchStage("contrib", contacted.id, { stage: "replied" }, claude), 200); // one step forward is fine
  approveRefused(await patchStage("contrib", contacted.id, { stage: "contacted" }, claude)); // but not back
  approveRefused(await patchStage("contrib", contacted.id, { stage: "qualified" }, claude)); // nor skipping ahead
  expectStatus(await patchStage("contrib", contacted.id, { stage: "discovery_booked" }, claude), 200);
  expectStatus(await patchStage("contrib", contacted.id, { stage: "qualified" }, claude), 200);
  expectStatus(await patchStage("contrib", contacted.id, { stage: "proposal" }, claude), 200);
  approveRefused(await patchStage("contrib", contacted.id, { stage: "researched" }, claude));
  for (const won of ["invoice_contract", "cash_collected", "delivery", "retained_referred", "won"]) approveRefused(await patchStage("contrib", contacted.id, { stage: won }, claude));
  assert.equal((await patchLegacy("contrib", contacted.id, { stage: "won" }, true)).status, 403);
  assert.equal(await stageOf(contacted.id), "proposal");
  assert.equal(expectStatus(await patchStage("contrib", contacted.id, { stage: "researched" }), 200).data.stage, "researched"); // a person can
  assert.equal(expectStatus(await patchStage("contrib", contacted.id, { stage: "invoice_contract" }), 200).data.stage, "invoice_contract"); // and can mark it won
  // Skipping ahead, and other jumps, from the start of the funnel.
  const jumper = await newLead(h, "contrib");
  for (const to of ["contacted", "replied", "qualified", "proposal", "invoice_contract"]) approveRefused(await patchStage("contrib", jumper.id, { stage: to }, claude));
  expectStatus(await patchStage("contrib", jumper.id, { stage: "researched" }, claude), 200);
  approveRefused(await patchStage("contrib", jumper.id, { stage: "identified" }, claude));
  approveRefused(await patchStage("contrib", jumper.id, { stage: "contacted" }, claude));
  expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Claude proposal ${suffix}`, ownerId: "user-contrib", stage: "proposal" }, claude), 403);
  expectStatus(await h.call("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Claude won ${suffix}`, ownerId: "user-contrib", stage: "invoice_contract" }, claude), 403);
  expectStatus(await patchStage("contrib", jumper.id, { stage: "disqualified", exitReason: "Wrong industry" }, claude), 200); // closing with a reason is fine
  // Logging activity still moves leads by the rules (that is not a stage edit): Claude logging a call that was made is fine.
  const logged = await newLead(h, "contrib");
  assert.equal(expectStatus(await log(h, "contrib", logged.id, { kind: "call", direction: "out", callOutcome: "no_answer" }, claude), 201).data.lead.stage, "contacted");

  // 3. WhatsApp opt-in: an inbound WhatsApp logged by Claude does not grant it; a person marking it handled does.
  const wa = await newLead(h, "contrib");
  const inbound = expectStatus(await log(h, "contrib", wa.id, { kind: "whatsapp", direction: "in", body: "Hello, please call", at: "2026-10-09T08:00:00.000Z" }, claude), 201);
  assert.equal(inbound.data.lead.stage, "replied");
  assert.equal(inbound.data.lead.whatsappOptIn, undefined);
  assert.equal(inbound.data.activity.via, "claude");
  // Setting its reply type through Claude does not grant it either, and nor does Claude marking it handled.
  expectStatus(await h.call("contrib", "PATCH", `/sales/activities/${inbound.data.activity.id}`, { replyType: "interested" }, claude), 200);
  assert.equal((await leadDoc(h, wa.id)).whatsappOptIn, undefined);
  expectStatus(await h.call("contrib", "POST", `/sales/activities/${inbound.data.activity.id}/handled`, {}, claude), 200);
  assert.equal((await leadDoc(h, wa.id)).whatsappOptIn, undefined);
  const handled = expectStatus(await h.call("contrib", "POST", `/sales/activities/${inbound.data.activity.id}/handled`, {}), 200);
  assert.ok(handled.data.handledAt);
  const optIn = (await leadDoc(h, wa.id)).whatsappOptIn;
  assert.deepEqual([optIn.how, optIn.by, optIn.at.toISOString()], ["they_messaged", "user-contrib", "2026-10-09T08:00:00.000Z"]);
  // A person who logs an inbound WhatsApp in the app sets it straight away, and an existing opt-in is never replaced.
  const direct = await newLead(h, "contrib");
  assert.equal(expectStatus(await log(h, "contrib", direct.id, { kind: "whatsapp", direction: "in" }), 201).data.lead.whatsappOptIn.how, "they_messaged");
  expectStatus(await h.call("contrib", "POST", `/sales/activities/${inbound.data.activity.id}/handled`, {}), 200);
  assert.equal((await leadDoc(h, wa.id)).whatsappOptIn.at.toISOString(), "2026-10-09T08:00:00.000Z");
  // Only inbound WhatsApp: an inbound email handled by a person grants nothing.
  const mail = await newLead(h, "contrib");
  const mailIn = expectStatus(await log(h, "contrib", mail.id, { kind: "email", direction: "in" }, claude), 201).data.activity;
  expectStatus(await h.call("contrib", "POST", `/sales/activities/${mailIn.id}/handled`, {}), 200);
  assert.equal((await leadDoc(h, mail.id)).whatsappOptIn, undefined);
  // Answering the message (a draft marked sent by a person) clears it and records the opt-in; through Claude it does not.
  for (const [options, expected] of [[undefined, true], [claude, false]] as const) {
    const lead = await newLead(h, "contrib");
    const message = expectStatus(await log(h, "contrib", lead.id, { kind: "whatsapp", direction: "in" }, claude), 201).data.activity;
    const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", subject: "Hi", body: "Thanks for writing", inReplyTo: message.id }), 201).data;
    expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
    expectStatus(await h.call("contrib", "POST", `/sales/drafts/${draft.id}/sent`, {}, options), 201);
    assert.equal(Boolean((await leadDoc(h, lead.id)).whatsappOptIn), expected);
    assert.ok((await h.database.db.collection("sales_activities").findOne({ _id: message.id }))?.handledAt);
  }

  // 4. Silence is not a reply: refused when logging, and when sorting a reply afterwards.
  const quiet = await newLead(h, "contrib");
  const silent = expectStatus(await log(h, "contrib", quiet.id, { kind: "email", direction: "in", replyType: "silence" }), 400);
  assert.match(silent.body.error.message, /Silence is not a reply/);
  expectStatus(await log(h, "contrib", quiet.id, { kind: "email", direction: "in", replyType: "silence" }, claude), 400);
  const message = expectStatus(await log(h, "contrib", quiet.id, { kind: "email", direction: "in", body: "Hmm" }), 201).data.activity;
  const sorted = expectStatus(await h.call("contrib", "PATCH", `/sales/activities/${message.id}`, { replyType: "silence" }), 400);
  assert.match(sorted.body.error.message, /Silence is not a reply/);
  assert.equal((await h.database.db.collection("sales_activities").findOne({ _id: message.id }))?.replyType, undefined);
  expectStatus(await log(h, "contrib", quiet.id, { kind: "email", direction: "out", replyType: "silence" }), 400);
  assert.equal(await h.database.db.collection("sales_activities").countDocuments({ leadId: quiet.id, replyType: "silence" }), 0);

  // 6. Activity Claude logs on a closed lead is recorded, but the lead stays closed (and an opt-out still suppresses).
  const lostLead = await newLead(h, "contrib", { stage: "lost", exitReason: "No budget", lostReason: "no_budget", nextAction: "", contactRoutes: [{ kind: "email", value: `lost${++counter}@lostco${counter}.example` }] });
  const onLost = expectStatus(await log(h, "contrib", lostLead.id, { kind: "call", direction: "out", callOutcome: "interested_book", nextAction: "Discovery call" }, claude), 201);
  assert.deepEqual([onLost.data.lead.stage, onLost.data.lead.exitReason, onLost.data.lead.nextAction], ["lost", "No budget", ""]);
  assert.equal(onLost.data.activity.stageTo, undefined);
  assert.equal(await h.database.db.collection("sales_activities").countDocuments({ leadId: lostLead.id }), 1);
  const replyOnLost = expectStatus(await log(h, "contrib", lostLead.id, { kind: "email", direction: "in", replyType: "interested", body: "Maybe after all" }, claude), 201);
  assert.deepEqual([replyOnLost.data.lead.stage, replyOnLost.data.lead.nextAction], ["lost", ""]);
  expectStatus(await h.call("contrib", "PATCH", `/sales/activities/${replyOnLost.data.activity.id}`, { replyType: "send_details" }, claude), 200);
  assert.equal((await leadDoc(h, lostLead.id)).stage, "lost");
  const optOutOnLost = expectStatus(await log(h, "contrib", lostLead.id, { kind: "email", direction: "in", replyType: "opt_out", body: "Stop" }, claude), 201).data.lead;
  assert.deepEqual([optOutOnLost.stage, optOutOnLost.doNotContact], ["disqualified", true]);
  assert.ok(await h.database.db.collection("sales_suppression").findOne({ leadId: lostLead.id, kind: "email" }));
  // A person's activity on a closed lead still reopens it by the rules.
  const personLost = await newLead(h, "contrib", { stage: "lost", exitReason: "No budget", lostReason: "no_budget" });
  assert.equal(expectStatus(await log(h, "contrib", personLost.id, { kind: "call", direction: "out", callOutcome: "interested_book" }), 201).data.lead.stage, "discovery_booked");
  // Not now only parks a lead that is replied (or contacted); from later stages a person decides.
  const meeting = await newLead(h, "contrib", { stage: "discovery_booked" });
  const parked = expectStatus(await log(h, "contrib", meeting.id, { kind: "email", direction: "in", replyType: "not_now" }, claude), 201).data.lead;
  assert.equal(parked.stage, "discovery_booked");
  const early = await newLead(h, "contrib", { stage: "contacted" });
  assert.equal(expectStatus(await log(h, "contrib", early.id, { kind: "email", direction: "in", replyType: "not_now" }, claude), 201).data.lead.stage, "thinking");
  // Activity never takes a lead back: an inbound reply on a proposal, a call on a qualified lead.
  const proposal = await newLead(h, "contrib", { stage: "proposal" });
  assert.equal(expectStatus(await log(h, "contrib", proposal.id, { kind: "call", direction: "out", callOutcome: "send_details" }, claude), 201).data.lead.stage, "proposal");

  // 7. Verdict provenance: who set the verdict, and a person's approval is not undone by Claude.
  const approvedByPerson = await newLead(h, "contrib", { stage: "researched" });
  expectStatus(await patchStage("head", approvedByPerson.id, { stage: "approved_for_contact" }), 200);
  assert.equal((await leadDoc(h, approvedByPerson.id)).approvedForContactBy, "user-head");
  const draftForApproved = expectStatus(await h.call("contrib", "POST", `/sales/leads/${approvedByPerson.id}/drafts`, { channel: "email", body: "Ready to go" }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${draftForApproved.id}/review`, { result: "pass" }), 200);
  for (const [decision, confidence] of [["reject", "high"], ["hold", "medium"]] as const) {
    const verdictReply = await saveVerdict("contrib", approvedByPerson.id, decision, confidence, claude);
    // Not needsYou before: the first one flags the lead, the second is then refused until a person decides.
    if (decision === "reject") {
      assert.equal(verdictReply.status, 201, JSON.stringify(verdictReply.body));
      assert.deepEqual([verdictReply.data.lead.stage, verdictReply.data.lead.needsYou, verdictReply.data.lead.verdict.decision], ["approved_for_contact", true, "reject"]);
    } else assert.equal(verdictReply.status, 409);
  }
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: draftForApproved.id }))?.status, "ready"); // its drafts are kept
  assert.equal((await leadDoc(h, approvedByPerson.id)).verdict.via, "claude");
  // Claude's own recommend approves a lead, but that is not a person's approval; a later Claude hold then asks a person too.
  const byClaude = await newLead(h, "contrib");
  const recommended = expectStatus(await saveVerdict("contrib", byClaude.id, "recommend", "high", claude), 201).data.lead;
  assert.equal(recommended.stage, "approved_for_contact");
  assert.equal((await leadDoc(h, byClaude.id)).approvedForContactBy, undefined);
  const flagged = expectStatus(await saveVerdict("contrib", byClaude.id, "hold", "high", claude), 201).data.lead;
  assert.deepEqual([flagged.stage, flagged.needsYou], ["approved_for_contact", true]);
  // A lead a verdict disqualified stays closed for Claude, and a person reopens it with a verdict or an override.
  const rejected = await newLead(h, "contrib");
  assert.equal(expectStatus(await saveVerdict("contrib", rejected.id, "reject", "high", claude), 201).data.lead.stage, "disqualified");
  assert.equal((await leadDoc(h, rejected.id)).disqualifiedByVerdict, true);
  assert.equal(expectStatus(await saveVerdict("contrib", rejected.id, "recommend", "high", claude), 201).data.lead.stage, "disqualified");
  assert.equal(expectStatus(await saveVerdict("contrib", rejected.id, "recommend", "high"), 201).data.lead.stage, "approved_for_contact");
  assert.equal((await leadDoc(h, rejected.id)).disqualifiedByVerdict, undefined);
  // What a person typed as the reason is never mistaken for a verdict: no flag, no reopening by a verdict.
  const typed = await newLead(h, "contrib", { stage: "disqualified", exitReason: "Not a fit: typed by a person" });
  assert.equal(expectStatus(await saveVerdict("contrib", typed.id, "recommend", "high"), 201).data.lead.stage, "disqualified");

  // 8. WhatsApp consent is only ever recorded by a person: a Claude-logged yes on a call does not grant it.
  const yesLead = await newLead(h, "contrib");
  const yesCall = expectStatus(await log(h, "contrib", yesLead.id, { kind: "call", direction: "out", callOutcome: "yes_whatsapp", body: "Said yes to WhatsApp" }, claude), 201);
  assert.deepEqual([yesCall.data.lead.stage, yesCall.data.lead.nextAction, yesCall.data.lead.whatsappOptIn], ["replied", "Send details on WhatsApp", undefined]);
  const optInPath = `/sales/leads/${yesLead.id}/whatsapp-opt-in`;
  expectStatus(await h.call("contrib", "POST", optInPath, { how: "yes_on_call", activityId: yesCall.data.activity.id }, claude), 403);
  expectStatus(await h.call("contrib2", "POST", optInPath, { how: "yes_on_call" }), 403);
  expectStatus(await h.call("learner", "POST", optInPath, { how: "yes_on_call" }), 403);
  expectStatus(await h.call("outsider", "POST", optInPath, { how: "yes_on_call" }), 404);
  expectStatus(await h.call("contrib", "POST", optInPath, { how: "whenever" }), 400);
  expectStatus(await h.call("contrib", "POST", optInPath, { how: "they_messaged", activityId: yesCall.data.activity.id }), 400); // that call is a yes on a call
  const otherNote = expectStatus(await log(h, "contrib", yesLead.id, { kind: "note", body: "unrelated" }), 201).data.activity;
  expectStatus(await h.call("contrib", "POST", optInPath, { how: "yes_on_call", activityId: otherNote.id }), 400);
  const strangerLead = await newLead(h, "contrib");
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${strangerLead.id}/whatsapp-opt-in`, { how: "yes_on_call", activityId: yesCall.data.activity.id }), 400); // another lead's call
  assert.equal((await leadDoc(h, yesLead.id)).whatsappOptIn, undefined);
  const recorded = expectStatus(await h.call("contrib", "POST", optInPath, { how: "yes_on_call", activityId: yesCall.data.activity.id }), 200).data;
  parse(opportunitySchema, recorded);
  assert.deepEqual([recorded.whatsappOptIn.how, recorded.whatsappOptIn.by], ["yes_on_call", "user-contrib"]);
  assert.ok(Math.abs(new Date(recorded.whatsappOptIn.at).getTime() - Date.now()) < 60_000);
  const again = expectStatus(await h.call("head", "POST", optInPath, { how: "yes_by_email" }), 200).data; // already recorded: nothing replaced
  assert.equal(again.whatsappOptIn.how, "yes_on_call");
  assert.ok(await h.database.db.collection("audit_events").findOne({ action: "sales.lead.whatsapp_opt_in", objectId: yesLead.id }));
  // By email without an activity; an inbound WhatsApp message as the evidence; never for a do-not-contact lead.
  const emailYes = await newLead(h, "contrib");
  assert.equal(expectStatus(await h.call("head", "POST", `/sales/leads/${emailYes.id}/whatsapp-opt-in`, { how: "yes_by_email" }), 200).data.whatsappOptIn.by, "user-head");
  const messaged = await newLead(h, "contrib");
  const wamsg = expectStatus(await log(h, "contrib", messaged.id, { kind: "whatsapp", direction: "in", body: "Hi" }, claude), 201).data.activity;
  assert.equal(expectStatus(await h.call("contrib", "POST", `/sales/leads/${messaged.id}/whatsapp-opt-in`, { how: "they_messaged", activityId: wamsg.id }), 200).data.whatsappOptIn.how, "they_messaged");
  const blocked = await newLead(h, "contrib");
  await h.database.db.collection("opportunities").updateOne({ _id: blocked.id }, { $set: { doNotContact: true } });
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${blocked.id}/whatsapp-opt-in`, { how: "yes_by_email" }), 409);

  // 5. The sales sessions the tools use expire on their own.
  const indexes = await h.database.db.collection("mcp_sales_sessions").indexes();
  assert.ok(indexes.some((index) => index.key?.expiresAt === 1 && index.expireAfterSeconds === 0), JSON.stringify(indexes));
});

test("a repeated requestId on an activity does not log it twice", skip, async () => {
  const h = await getHarness();
  const lead = await newLead(h, "contrib");
  const requestId = `req-${randomUUID()}`;
  const first = expectStatus(await log(h, "contrib", lead.id, { kind: "call", direction: "out", callOutcome: "no_answer", requestId }), 201);
  const again = expectStatus(await log(h, "contrib", lead.id, { kind: "call", direction: "out", callOutcome: "no_answer", requestId }), 200);
  assert.equal(again.data.activity.id, first.data.activity.id);
  assert.equal(await h.database.db.collection("sales_activities").countDocuments({ leadId: lead.id }), 1);
  // A different lead may reuse the same id; the same id with another body on the same lead still answers with the first.
  const other = await newLead(h, "contrib");
  expectStatus(await log(h, "contrib", other.id, { kind: "note", requestId }), 201);
  // The same id with other content is refused, not silently answered with the first activity.
  const different = await log(h, "contrib", lead.id, { kind: "note", body: "different", requestId });
  assert.equal(different.status, 409);
  assert.match(different.body.error.message, /different activity/);
  expectStatus(await log(h, "contrib", lead.id, { kind: "call", direction: "out", callOutcome: "not_interested", requestId }), 409);
  assert.equal((await leadDoc(h, lead.id)).stage, "contacted");
  assert.equal(await h.database.db.collection("sales_activities").countDocuments({ leadId: lead.id }), 1);
  // Five parallel calls with one requestId: one activity.
  const parallelLead = await newLead(h, "contrib");
  const parallelId = `req-${randomUUID()}`;
  const parallel = await Promise.all(Array.from({ length: 5 }, () => log(h, "contrib", parallelLead.id, { kind: "call", direction: "out", callOutcome: "no_answer", requestId: parallelId })));
  assert.ok(parallel.every((reply) => [200, 201, 409].includes(reply.status)), JSON.stringify(parallel.map((reply) => reply.status)));
  assert.ok(parallel.some((reply) => reply.status === 201));
  assert.equal(await h.database.db.collection("sales_activities").countDocuments({ leadId: parallelLead.id, requestId: parallelId }), 1);
});

test("verdicts map to stages, flag needs-you and can be overridden by a person with a reason", skip, async () => {
  const h = await getHarness();
  const verdict = (decision: string, confidence: string, extra: Record<string, unknown> = {}) => ({
    decision, confidence, offer: "Order tracking", offerFit: "They run orders by phone", evidence: [{ claim: "Takes orders by phone", quote: "Call us to order", url: "https://example.com/contact" }], against: "Small team", summary: `Verdict ${decision} ${confidence}`, ...extra,
  });
  const save = async (leadId: string, body: unknown, options?: { via?: "claude" }) => h.call("contrib", "POST", `/sales/leads/${leadId}/verdicts`, body, options);
  const high = await newLead(h, "contrib");
  const saved = expectStatus(await save(high.id, verdict("recommend", "high")), 201);
  assert.equal(parse(verdictSchema, saved.data.verdict).via, "app");
  const lead = parse(opportunitySchema, saved.data.lead);
  assert.deepEqual([lead.stage, lead.needsYou, lead.verdict?.decision, lead.verdict?.overridden, lead.evidenceConfidence], ["approved_for_contact", false, "recommend", false, "high"]);
  const low = expectStatus(await save((await newLead(h, "contrib")).id, verdict("recommend", "low")), 201).data.lead;
  assert.deepEqual([low.stage, low.needsYou], ["researched", true]);
  const hold = expectStatus(await save((await newLead(h, "contrib")).id, verdict("hold", "high")), 201).data.lead;
  assert.deepEqual([hold.stage, hold.needsYou], ["researched", true]);
  const mediumReject = expectStatus(await save((await newLead(h, "contrib")).id, verdict("reject", "medium", { summary: "Sells only to retail" })), 201).data.lead;
  assert.deepEqual([mediumReject.stage, mediumReject.exitReason, mediumReject.needsYou], ["disqualified", "Not a fit: Sells only to retail", false]);
  // A low-confidence reject only asks a person: researched, needs you, not disqualified.
  const lowReject = expectStatus(await save((await newLead(h, "contrib")).id, verdict("reject", "low")), 201).data.lead;
  assert.deepEqual([lowReject.stage, lowReject.needsYou, lowReject.exitReason, lowReject.verdict.decision, lowReject.verdict.via], ["researched", true, undefined, "reject", "app"]);
  // Claude saves verdicts too (as the token owner), recorded as via claude.
  const viaClaude = expectStatus(await save((await newLead(h, "contrib")).id, verdict("recommend", "medium"), { via: "claude" }), 201);
  assert.equal(viaClaude.data.verdict.via, "claude");
  // After first contact a verdict only updates the summary.
  const contacted = await newLead(h, "contrib");
  await log(h, "contrib", contacted.id, { kind: "email", direction: "out" });
  const late = expectStatus(await save(contacted.id, verdict("reject", "high")), 201).data.lead;
  assert.equal(late.stage, "contacted");
  assert.equal(late.verdict.decision, "reject");
  // Verdict input is validated (evidence is required, with a URL).
  expectStatus(await save(high.id, { ...verdict("recommend", "high"), evidence: [] }), 400);
  // Overrides: a person, with a reason, on the latest verdict, by the owner or a head.
  const held = await newLead(h, "contrib");
  const heldVerdict = expectStatus(await save(held.id, verdict("hold", "low")), 201).data;
  expectStatus(await h.call("contrib", "POST", `/sales/verdicts/${heldVerdict.verdict.id}/override`, { decision: "recommend", reason: "x" }), 400);
  expectStatus(await h.call("contrib", "POST", `/sales/verdicts/${heldVerdict.verdict.id}/override`, { decision: "recommend", reason: "Spoke to the owner" }, { via: "claude" }), 403);
  expectStatus(await h.call("contrib2", "POST", `/sales/verdicts/${heldVerdict.verdict.id}/override`, { decision: "recommend", reason: "Spoke to the owner" }), 403);
  expectStatus(await h.call("learner", "POST", `/sales/verdicts/${heldVerdict.verdict.id}/override`, { decision: "recommend", reason: "Spoke to the owner" }), 403);
  expectStatus(await h.call("outsider", "POST", `/sales/verdicts/${heldVerdict.verdict.id}/override`, { decision: "recommend", reason: "Spoke to the owner" }), 404);
  const overridden = expectStatus(await h.call("contrib", "POST", `/sales/verdicts/${heldVerdict.verdict.id}/override`, { decision: "recommend", reason: "Spoke to the owner" }), 200);
  assert.equal(parse(verdictSchema, overridden.data.verdict).override?.reason, "Spoke to the owner");
  assert.deepEqual([overridden.data.lead.stage, overridden.data.lead.needsYou, overridden.data.lead.verdict.decision, overridden.data.lead.verdict.overridden], ["approved_for_contact", false, "recommend", true]);
  // Only the latest verdict can be overridden.
  const second = expectStatus(await save(held.id, verdict("hold", "medium")), 201).data;
  expectStatus(await h.call("contrib", "POST", `/sales/verdicts/${heldVerdict.verdict.id}/override`, { decision: "reject", reason: "Changed my mind" }), 409);
  const rejected = expectStatus(await h.call("head", "POST", `/sales/verdicts/${second.verdict.id}/override`, { decision: "reject", reason: "Not for us" }), 200).data.lead;
  assert.deepEqual([rejected.stage, rejected.exitReason, rejected.needsYou], ["disqualified", "Not a fit: Not for us", false]);
  // A rejected lead that was never contacted can be reopened by a later override.
  const reopened = expectStatus(await h.call("head", "POST", `/sales/verdicts/${second.verdict.id}/override`, { decision: "recommend", reason: "Reconsidered" }), 200).data.lead;
  assert.deepEqual([reopened.stage, reopened.exitReason], ["approved_for_contact", undefined]);
  // The detail view lists all verdicts, newest first.
  const detail = parse(successEnvelope(leadDetailSchema), (await h.call("contrib", "GET", `/sales/leads/${held.id}`)).body).data;
  assert.equal(detail.verdicts.length, 2);
  assert.equal(detail.verdicts[0]!.id, second.verdict.id);
});

test("drafts: review, separate-session rule, first-batch approval, marking sent, veto and discard", skip, async () => {
  const h = await getHarness();
  const draftOf = (leadId: string, extra: Record<string, unknown> = {}, who: Who = "contrib", options?: { via?: "claude" }) => h.call(who, "POST", `/sales/leads/${leadId}/drafts`, { channel: "email", subject: "Hello", body: "Draft body", ...extra }, options);
  const lead = await newLead(h, "contrib");
  // Creation: submitted by default, or kept as a draft.
  const created = parse(draftSchema, expectStatus(await draftOf(lead.id), 201).data);
  assert.deepEqual([created.status, created.authorVia, created.authorId], ["in_review", "app", "user-contrib"]);
  const unsubmitted = expectStatus(await draftOf(lead.id, { submit: false }), 201).data;
  assert.equal(unsubmitted.status, "draft");
  expectStatus(await draftOf(lead.id, {}, "contrib2"), 403); // not their lead
  expectStatus(await draftOf(lead.id, {}, "learner"), 403);
  // Not sendable before review; a pass makes it ready, a fail needs changes; edits go back to review and clear the review.
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${created.id}/sent`, {}), 409);
  expectStatus(await h.call("learner", "POST", `/sales/drafts/${created.id}/review`, { result: "pass" }), 403);
  expectStatus(await h.call("outsider", "POST", `/sales/drafts/${created.id}/review`, { result: "pass" }), 404);
  const failed = expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${created.id}/review`, { result: "fail", issues: ["Too long"], notes: "Cut it down" }), 200).data;
  assert.deepEqual([failed.status, failed.review.result, failed.review.by, failed.review.issues], ["needs_changes", "fail", "user-reviewer", ["Too long"]]);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${created.id}/review`, { result: "pass" }), 409); // only drafts waiting for review
  expectStatus(await h.call("contrib2", "PATCH", `/sales/drafts/${created.id}`, { body: "Not mine" }), 403);
  const edited = expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${created.id}`, { body: "Shorter body" }), 200).data;
  assert.deepEqual([edited.status, edited.body, edited.review], ["in_review", "Shorter body", undefined]);
  const ready = expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${created.id}/review`, { result: "pass" }), 200).data;
  assert.equal(ready.status, "ready");
  expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${created.id}`, { body: "Edit after review" }), 200); // back to in_review
  assert.equal((await h.call("contrib", "GET", `/sales/leads/${lead.id}`)).data.drafts.find((d: any) => d.id === created.id).status, "in_review");
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${created.id}/review`, { result: "pass" }), 200);

  // Claude never approves its own work: the review of a Claude draft must come from a different session.
  const claudeLead = await newLead(h, "contrib");
  const claudeDraft = expectStatus(await draftOf(claudeLead.id, { sessionId: "session-1" }, "contrib", { via: "claude" }), 201).data;
  assert.deepEqual([claudeDraft.authorVia, claudeDraft.authorSessionId], ["claude", "session-1"]);
  const review = (body: Record<string, unknown>, options?: { via?: "claude" }) => h.call("contrib", "POST", `/sales/drafts/${claudeDraft.id}/review`, body, options);
  expectStatus(await review({ result: "pass", sessionId: "session-1" }, { via: "claude" }), 409);
  expectStatus(await review({ result: "pass" }, { via: "claude" }), 409);
  assert.equal((await h.database.db.collection("sales_drafts").findOne({ _id: claudeDraft.id }))?.status, "in_review");
  const passed = expectStatus(await review({ result: "pass", sessionId: "session-2", notes: "Checks fine" }, { via: "claude" }), 200).data;
  assert.deepEqual([passed.status, passed.review.via, passed.review.sessionId], ["ready", "claude", "session-2"]);
  // A person may review a Claude draft without any session.
  const claudeDraft2 = expectStatus(await draftOf(claudeLead.id, { sessionId: "session-1" }, "contrib", { via: "claude" }), 201).data;
  assert.equal(expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${claudeDraft2.id}/review`, { result: "pass" }), 200).data.status, "ready");
  // A person's draft reviewed by Claude needs no session.
  const personDraft = expectStatus(await draftOf(claudeLead.id), 201).data;
  assert.equal(expectStatus(await h.call("contrib", "POST", `/sales/drafts/${personDraft.id}/review`, { result: "pass" }, { via: "claude" }), 200).data.status, "ready");

  // First batch of a play: a head reads every message before it can be sent; Claude and non-heads cannot approve.
  const play = expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-a", name: `First batch ${suffix}`, batchSize: 2 }), 201).data;
  assert.equal(parse(playSchema, play).status, "draft");
  expectStatus(await h.call("head", "POST", `/sales/plays/${play.id}/approve`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("contrib", "POST", `/sales/plays/${play.id}/approve`, {}), 403);
  assert.equal(expectStatus(await h.call("head", "POST", `/sales/plays/${play.id}/approve`, {}), 200).data.status, "approved");
  const batch = [] as { id: string; leadId: string }[];
  for (let index = 0; index < 3; index++) {
    const batchLead = await newLead(h, "contrib", { playId: play.id });
    const drafted = expectStatus(await draftOf(batchLead.id), 201).data; // joins the lead's play
    assert.equal(drafted.playId, play.id);
    expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${drafted.id}/review`, { result: "pass" }), 200);
    batch.push({ id: drafted.id, leadId: batchLead.id });
  }
  const [a, b, c] = batch as [typeof batch[0], typeof batch[0], typeof batch[0]];
  const blocked = expectStatus(await h.call("contrib", "POST", `/sales/drafts/${a.id}/sent`, {}), 409);
  assert.match(blocked.body.error.message, /first batch/);
  expectStatus(await h.call("head", "POST", `/sales/drafts/${a.id}/approve`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${a.id}/approve`, {}), 403);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${a.id}/approve`, {}), 403);
  const approved = expectStatus(await h.call("head", "POST", `/sales/drafts/${a.id}/approve`, {}), 200).data;
  assert.equal(approved.personApproval.by, "user-head");
  // Editing clears the approval and the review.
  const editedAfter = expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${a.id}`, { body: "Changed after approval" }), 200).data;
  assert.deepEqual([editedAfter.status, editedAfter.personApproval, editedAfter.review], ["in_review", undefined, undefined]);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${a.id}/review`, { result: "pass" }), 200);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${a.id}/sent`, {}), 409);
  expectStatus(await h.call("head", "POST", `/sales/drafts/${a.id}/approve`, {}), 200);
  expectStatus(await h.call("head", "POST", `/sales/drafts/${b.id}/approve`, {}), 200);
  // Two approvals reach the batch size: the play's first batch counts as reviewed, so the third needs no approval.
  assert.equal((await h.database.db.collection("sales_plays").findOne({ _id: play.id }))?.firstBatchReviewed, true);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${c.id}/sent`, { requestId: `sent-${randomUUID()}` }), 201);

  // Marking sent: manual only, records an out activity, makes the lead contacted with a follow-up date, and cannot repeat.
  const sendLead = await newLead(h, "contrib");
  const sendDraft = expectStatus(await draftOf(sendLead.id, { subject: "Orders at Zorbo" }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${sendDraft.id}/review`, { result: "pass" }), 200);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${sendDraft.id}/sent`, { sentVia: "smtp" }), 503);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${sendDraft.id}/sent`, { sentVia: "whatsapp_api" }), 503);
  assert.equal(((await h.call("contrib", "POST", `/sales/drafts/${sendDraft.id}/sent`, { sentVia: "smtp" })).body as any).error.code, "INTEGRATION_UNAVAILABLE");
  expectStatus(await h.call("contrib2", "POST", `/sales/drafts/${sendDraft.id}/sent`, {}), 403);
  const requestId = `sent-${randomUUID()}`;
  const sent = expectStatus(await h.call("contrib", "POST", `/sales/drafts/${sendDraft.id}/sent`, { requestId, at: "2026-10-09T09:30:00.000Z" }), 201);
  const result = sent.data;
  assert.deepEqual([parse(draftSchema, result.draft).status, result.draft.sentVia, result.draft.sentBy, result.draft.sentAt], ["sent", "manual", "user-contrib", "2026-10-09T09:30:00.000Z"]);
  assert.deepEqual([result.activity.kind, result.activity.direction, result.activity.draftId, result.activity.stageTo], ["email", "out", sendDraft.id, "contacted"]);
  assert.match(result.activity.body, /^Subject: Orders at Zorbo/);
  assert.deepEqual([result.lead.stage, result.lead.followUpDueAt], ["contacted", iso(ist("2026-10-14"))]);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${sendDraft.id}/sent`, {}), 409);
  const replay = expectStatus(await h.call("contrib", "POST", `/sales/drafts/${sendDraft.id}/sent`, { requestId }), 200);
  assert.equal(replay.data.activity.id, result.activity.id);
  assert.equal(await h.database.db.collection("sales_activities").countDocuments({ leadId: sendLead.id, direction: "out" }), 1);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${sendDraft.id}/veto`, { reason: "Too late now" }), 409);
  expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${sendDraft.id}`, { body: "No" }), 409);

  // WhatsApp: only with the lead's opt-in. Call openers are scripts and can never be sent.
  const waLead = await newLead(h, "contrib");
  const waDraft = expectStatus(await draftOf(waLead.id, { channel: "whatsapp", subject: undefined, body: "Hi on WhatsApp" }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${waDraft.id}/review`, { result: "pass" }), 200);
  const noOptIn = expectStatus(await h.call("contrib", "POST", `/sales/drafts/${waDraft.id}/sent`, {}), 409);
  assert.match(noOptIn.body.error.message, /opts in|opt/i);
  expectStatus(await log(h, "contrib", waLead.id, { kind: "call", direction: "out", callOutcome: "yes_whatsapp" }), 201);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${waDraft.id}/sent`, {}), 201);
  const opener = expectStatus(await draftOf(waLead.id, { channel: "call_opener", subject: undefined, body: "Script: hello, I'm calling about..." }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${opener.id}/review`, { result: "pass" }), 200);
  assert.match(expectStatus(await h.call("contrib", "POST", `/sales/drafts/${opener.id}/sent`, {}), 409).body.error.message, /call opener/);

  // Veto (any writer in the venture) and discard (the owner, the author or a head).
  const vetoLead = await newLead(h, "contrib");
  const toVeto = expectStatus(await draftOf(vetoLead.id), 201).data;
  expectStatus(await h.call("learner", "POST", `/sales/drafts/${toVeto.id}/veto`, { reason: "No way" }), 403);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${toVeto.id}/veto`, { reason: "x" }), 400);
  const vetoed = expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${toVeto.id}/veto`, { reason: "Wrong tone for this client" }), 200).data;
  assert.deepEqual([vetoed.status, vetoed.veto.reason, vetoed.veto.by], ["vetoed", "Wrong tone for this client", "user-reviewer"]);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${toVeto.id}/review`, { result: "pass" }), 409);
  const toDiscard = expectStatus(await draftOf(vetoLead.id), 201).data;
  expectStatus(await h.call("contrib2", "POST", `/sales/drafts/${toDiscard.id}/discard`, {}), 403);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${toDiscard.id}/discard`, {}), 403);
  assert.equal(expectStatus(await h.call("contrib", "POST", `/sales/drafts/${toDiscard.id}/discard`, {}), 200).data.status, "discarded");
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${toDiscard.id}/discard`, {}), 409);

  // The draft list carries a small lead summary and filters by status and owner.
  const listed = parse(successEnvelope(draftWithLeadSchema.array()), (await h.call("contrib", "GET", "/sales/drafts?status=sent,vetoed&owner=me&limit=500")).body).data;
  assert.ok(listed.some((item) => item.id === sendDraft.id && item.lead.companyName === sendLead.companyName));
  assert.ok(listed.every((item) => item.lead.ownerId === "user-contrib" && ["sent", "vetoed"].includes(item.status)));
});

test("suppression: entries flag matching leads in any spelling; heads add, only admins remove (with a reason); who sees what follows the venture", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const n = ++counter;
  const byEmail = await newLead(h, "contrib", { contactRoutes: [{ kind: "email", value: `Info${n}@Mixed${n}.Example` }] });
  const byPlus = await newLead(h, "contrib", { contactRoutes: [{ kind: "email", value: `info${n}+deals@Mixed${n}.example` }] });
  const byPhone = await newLead(h, "contrib", { contactRoutes: [{ kind: "whatsapp", value: `+91 98000 ${String(10000 + n)}` }] });
  const byOther = await newLead(h, "contrib", { contactRoutes: [{ kind: "other", value: `Write to Hidden${n}@Other${n}.Example or call 098111 ${String(10000 + n)}` }] });
  const byDomain = await newLead(h, "contrib", { website: `https://www.domain${n}.example/about`, contactRoutes: [] });
  const byCompany = await newLead(h, "contrib", { companyName: `Quiet${n} Traders Pvt. Ltd.`, contactRoutes: [] });
  const byCompanyVariant = await newLead(h, "contrib", { companyName: `QUIET${n} traders (Raipur) & Co`, contactRoutes: [] });
  const byTwo = await newLead(h, "contrib", { contactRoutes: [{ kind: "email", value: `two${n}@twoco${n}.example` }, { kind: "phone", value: `+91 97000 ${String(10000 + n)}` }] });
  const clean = await newLead(h, "contrib");
  const add = (body: Record<string, unknown>, who: Who = "head") => h.call(who, "POST", "/sales/suppression", body);
  const flagged = async (id: string) => (await leadDoc(h, id)).doNotContact === true;

  // Only a venture head or admin adds by hand.
  for (const who of ["contrib", "reviewer", "learner", "outsider"] as const) expectStatus(await add({ kind: "email", value: `x${n}@y.example` }, who), 403);
  const emailEntry = expectStatus(await add({ kind: "email", value: `  INFO${n}@mixed${n}.example `, reason: "Asked to stop" }), 201).data;
  assert.equal(parse(suppressionSchema, emailEntry).value, `info${n}@mixed${n}.example`);
  assert.equal(emailEntry.createdBy, "user-head");
  assert.equal(await flagged(byEmail.id), true);
  assert.equal(await flagged(byPlus.id), true); // +tag and trailing dot do not hide a mailbox
  assert.equal(expectStatus(await add({ kind: "email", value: `Info${n}+again@MIXED${n}.example` }), 200).data.id, emailEntry.id); // the same entry again
  expectStatus(await add({ kind: "phone", value: `098000${String(10000 + n)}` }), 201);
  assert.equal(await flagged(byPhone.id), true);
  const otherEntries = [await add({ kind: "email", value: `hidden${n}@other${n}.example` }), await add({ kind: "phone", value: `98111${String(10000 + n)}` })];
  for (const reply of otherEntries) assert.equal(reply.status, 201);
  assert.equal(await flagged(byOther.id), true); // an email and a number inside a free-text route
  expectStatus(await add({ kind: "domain", value: `https://domain${n}.example/` }), 201);
  assert.equal(await flagged(byDomain.id), true);
  expectStatus(await add({ kind: "company", value: `QUIET${n} traders limited` }), 201);
  assert.equal(await flagged(byCompany.id), true);
  assert.equal(await flagged(byCompanyVariant.id), true);
  assert.equal(await flagged(clean.id), false);
  expectStatus(await add({ kind: "domain", value: "gmail.com" }), 400);
  expectStatus(await add({ kind: "email", value: "not an email" }), 400);
  expectStatus(await add({ kind: "phone", value: "12" }), 400);
  // Flagging discards the drafts that were waiting on a lead.
  const withDraft = await newLead(h, "contrib", { contactRoutes: [{ kind: "email", value: `waiting${n}@draftco${n}.example` }] });
  const waiting = expectStatus(await h.call("contrib", "POST", `/sales/leads/${withDraft.id}/drafts`, { channel: "email", body: "Hello" }), 201).data;
  expectStatus(await add({ kind: "email", value: `waiting${n}@draftco${n}.example` }), 201);
  assert.equal((await db.collection("sales_drafts").findOne({ _id: waiting.id }))?.status, "discarded");
  // A lead of another venture needs that venture's head: the head of venture-a cannot reach a venture-b lead; an admin can.
  const betaLead = expectStatus(await h.call("admin", "POST", "/sales/leads", { pipelineId: "pipeline-b", companyName: `Beta lead ${n}`, ownerId: "user-admin" }), 201).data;
  expectStatus(await add({ kind: "company", value: `Beta lead ${n}`, leadId: betaLead.id }), 404);
  const byAdmin = expectStatus(await add({ kind: "company", value: `Beta lead ${n}`, leadId: betaLead.id, reason: "Asked by letter" }, "admin"), 201).data;
  assert.equal((await db.collection("sales_suppression").findOne({ _id: byAdmin.id }))?.ventureId, "venture-b");

  // Who sees what: admins everything; others the entries made from their ventures' leads and their own; nothing across workspaces.
  const ids = async (who: Who) => ((await h.call(who, "GET", "/sales/suppression")).data as { id: string }[]).map((entry) => entry.id);
  assert.ok((await ids("head")).includes(emailEntry.id));
  assert.ok((await ids("admin")).includes(emailEntry.id) && (await ids("admin")).includes(byAdmin.id));
  assert.ok(!(await ids("contrib")).includes(emailEntry.id)); // not theirs, not from a lead
  assert.ok(!(await ids("learner")).includes(emailEntry.id));
  assert.ok(!(await ids("head")).includes(byAdmin.id)); // an entry from a lead of another venture
  assert.ok((await ids("outsider")).length === 0 || !(await ids("outsider")).includes(emailEntry.id));
  assert.equal((await ids("outside-admin")).length, 0);
  const optOutLead = await newLead(h, "contrib");
  expectStatus(await log(h, "contrib", optOutLead.id, { kind: "email", direction: "in", replyType: "opt_out", body: "Stop" }), 201);
  const automatic = (await db.collection("sales_suppression").find({ leadId: optOutLead.id }).toArray()).map((entry) => String(entry._id));
  assert.ok(automatic.length >= 3);
  for (const who of ["contrib", "learner", "reviewer", "head", "admin"] as const) assert.ok((await ids(who)).includes(automatic[0]!), `${who} sees the opt-out entries of their venture`);
  assert.ok(!(await ids("outsider")).includes(automatic[0]!));
  parse(successEnvelope(suppressionSchema.array()), (await h.call("learner", "GET", "/sales/suppression")).body);

  // Removing is for an admin, with a reason; leads flagged only by that entry are cleared, leads another entry still matches are not.
  const twoEmail = expectStatus(await add({ kind: "email", value: `two${n}@twoco${n}.example` }), 201).data;
  const twoPhone = expectStatus(await add({ kind: "phone", value: `97000${String(10000 + n)}` }), 201).data;
  assert.equal(await flagged(byTwo.id), true);
  for (const who of ["contrib", "head", "reviewer", "learner"] as const) expectStatus(await h.call(who, "DELETE", `/sales/suppression/${emailEntry.id}`, { reason: "Because I say so" }), 403);
  expectStatus(await h.call("admin", "DELETE", `/sales/suppression/${emailEntry.id}`), 400); // a reason is required
  expectStatus(await h.call("admin", "DELETE", `/sales/suppression/${emailEntry.id}`, { reason: "ok" }), 400); // at least 3 characters
  expectStatus(await h.call("admin", "DELETE", `/sales/suppression/${emailEntry.id}`, { reason: "x".repeat(301) }), 400);
  expectStatus(await h.call("outside-admin", "DELETE", `/sales/suppression/${emailEntry.id}`, { reason: "Not my workspace" }), 404);
  assert.ok(await db.collection("sales_suppression").findOne({ _id: emailEntry.id }));
  const removed = expectStatus(await h.call("admin", "DELETE", `/sales/suppression/${emailEntry.id}`, { reason: "The owner wrote back and asked to hear from us" }), 200);
  assert.equal(removed.data.cleared, 2); // byEmail and byPlus
  assert.equal(await flagged(byEmail.id), false);
  assert.equal(await flagged(byPlus.id), false);
  assert.equal(await flagged(byPhone.id), true);
  const removal = await db.collection("audit_events").findOne({ action: "sales.suppression.remove", objectId: emailEntry.id });
  assert.equal(removal?.metadata.reason, "The owner wrote back and asked to hear from us");
  assert.equal(removal?.actorId, "user-admin");
  // byTwo: removing one of its two entries leaves it flagged; removing the second clears it.
  assert.equal(expectStatus(await h.call("admin", "DELETE", `/sales/suppression/${twoEmail.id}`, { reason: "Checked with them" }), 200).data.cleared, 0);
  assert.equal(await flagged(byTwo.id), true);
  assert.equal(expectStatus(await h.call("admin", "DELETE", `/sales/suppression/${twoPhone.id}`, { reason: "Checked with them" }), 200).data.cleared, 1);
  assert.equal(await flagged(byTwo.id), false);
  // The list is workspace-wide for admins: other workspaces never see it.
  assert.equal((await h.call("outside-admin", "GET", "/sales/suppression")).data.length, 0);
  // Entries written without a key (an older import) are fixed by the migration and then count.
  const legacyEntry = { _id: `legacy-supp-${n}`, workspaceId: "workspace-a", kind: "email", value: `Legacy+x${n}@Oldco${n}.Example`, reason: "unsubscribed", createdBy: "user-admin", createdAt: new Date(), externalRef: { system: "dealflow-sqlite", id: `outbound_suppressions:${n}` } };
  await db.collection("sales_suppression").insertMany([legacyEntry, { ...legacyEntry, _id: `legacy-supp-${n}b`, value: `legacy@oldco${n}.example` }, { ...legacyEntry, _id: `legacy-supp-${n}c`, kind: "company", value: `Oldco${n} Pvt Ltd` }]);
  const early = expectStatus(await h.call("admin", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Fresh ${n}`, ownerId: "user-admin", contactRoutes: [{ kind: "email", value: `legacy@oldco${n}.example` }] }), 201);
  assert.notEqual(early.data.doNotContact, true); // key-less entries are invisible until migrated
  await migrateSalesLeads(db);
  assert.equal(await db.collection("sales_suppression").countDocuments({ _id: { $in: [`legacy-supp-${n}`, `legacy-supp-${n}b`] } }), 1); // the two spellings became one
  assert.equal((await db.collection("sales_suppression").findOne({ _id: `legacy-supp-${n}c` }))?.key, `company:oldco${n}`);
  assert.equal(await flagged(early.data.id), true); // and the lead it matches is now flagged
  const late = expectStatus(await h.call("admin", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Later ${n}`, ownerId: "user-admin", contactRoutes: [{ kind: "email", value: `legacy@oldco${n}.example` }] }), 201);
  assert.equal(late.data.doNotContact, true);
});

test("won: the owner, venture heads and admins are notified once, and delivery work becomes a Venture OS task", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  // Owned by contrib2 (not in venture-c): use venture-a, where head is the venture head.
  const lead = expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Wonder ${suffix}`, ownerId: "user-contrib" }), 201).data;
  // Delivery work only once the deal is won.
  expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/delivery-work`, {}), 409);
  const won = expectStatus(await h.call("head", "PATCH", `/sales/leads/${lead.id}`, { stage: "invoice_contract" }), 200).data;
  assert.ok(won.wonAt);
  const notices = await db.collection("notification_outbox").find({ resourceType: "opportunity", resourceId: lead.id }).toArray();
  // The owner and the admins are told; the head who made the change is not; no other head exists in venture-a.
  assert.deepEqual(notices.map((notice) => notice.userId).sort(), ["user-admin", "user-contrib"]);
  const ownerNotice = notices.find((notice) => notice.userId === "user-contrib")!;
  assert.deepEqual([ownerNotice.type, ownerNotice.state, ownerNotice.idempotencyKey], ["sales_won", "pending", `opportunity:${lead.id}:won:user-contrib`]);
  assert.match(ownerNotice.title, /^Won: Wonder/);
  // Moving through the other won stages (or back and forth) never notifies twice.
  await h.call("head", "PATCH", `/sales/leads/${lead.id}`, { stage: "delivery" });
  await h.call("head", "PATCH", `/sales/leads/${lead.id}`, { stage: "proposal" });
  await h.call("head", "PATCH", `/sales/leads/${lead.id}`, { stage: "cash_collected" });
  assert.equal(await db.collection("notification_outbox").countDocuments({ resourceType: "opportunity", resourceId: lead.id }), 2);
  // The owner winning their own lead notifies the heads instead.
  const own = await newLead(h, "contrib");
  await h.call("contrib", "PATCH", `/sales/leads/${own.id}`, { stage: "cash_collected" });
  assert.deepEqual((await db.collection("notification_outbox").find({ resourceId: own.id }).toArray()).map((notice) => notice.userId).sort(), ["user-admin", "user-head"]);
  // Logging a call that wins... is not a thing; but an admin moving a lead notifies the owner and the head.
  const third = await newLead(h, "contrib");
  await h.call("admin", "PATCH", `/sales/leads/${third.id}`, { stage: "retained_referred" });
  assert.deepEqual((await db.collection("notification_outbox").find({ resourceId: third.id }).toArray()).map((notice) => notice.userId).sort(), ["user-contrib", "user-head"]);

  // Delivery work: a task in the venture's first group and channel, assigned to the owner, linked on the lead.
  expectStatus(await h.call("contrib2", "POST", `/sales/leads/${lead.id}/delivery-work`, {}), 403);
  expectStatus(await h.call("learner", "POST", `/sales/leads/${lead.id}/delivery-work`, {}), 403);
  expectStatus(await h.call("reviewer", "POST", `/sales/leads/${lead.id}/delivery-work`, {}), 403);
  const made = expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/delivery-work`, {}), 201);
  const task = parse(taskSchema, made.data.task);
  assert.deepEqual([task.title, task.assigneeId, task.groupId, task.channelId, task.ventureId, task.priority, task.estimatedMinutes, task.timezone, task.status, task.creatorId], [`Deliver: Wonder ${suffix}`, "user-contrib", "group-a", "channel-a", "venture-a", "high", 120, "Asia/Kolkata", "proposed", "user-head"]);
  const due = new Date(task.dueAt).getTime() - Date.now();
  assert.ok(Math.abs(due - 7 * 86_400_000) < 60_000, `due in 7 days, got ${due}`);
  assert.equal(parse(opportunitySchema, made.data.lead).deliveryTaskId, task.id);
  assert.equal(await db.collection("tasks").countDocuments({ _id: task.id }), 1);
  assert.equal(await db.collection("reminders").countDocuments({ taskId: task.id, userId: "user-contrib" }), 1);
  assert.equal(await db.collection("notification_outbox").countDocuments({ resourceId: task.id, type: "assignment", userId: "user-contrib" }), 1);
  expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/delivery-work`, {}), 409);
  // Overrides: title, assignee and due date.
  const custom = expectStatus(await h.call("head", "POST", `/sales/leads/${third.id}/delivery-work`, { title: "Set up their order system", assigneeId: "user-contrib2", dueAt: "2030-01-01T00:00:00.000Z" }), 201).data.task;
  assert.deepEqual([custom.title, custom.assigneeId, custom.dueAt], ["Set up their order system", "user-contrib2", "2030-01-01T00:00:00.000Z"]);
  // The won lead shows on the Overview until its work exists.
  const overview = (await h.call("head", "GET", "/sales/overview?ventureId=venture-a")).data;
  assert.ok(!overview.wonToHandOver.some((card: any) => card.id === lead.id));
  assert.ok(overview.wonToHandOver.some((card: any) => card.id === own.id));
});

test("Overview counts what needs a person today and parses with the contract", skip, async () => {
  const h = await getHarness();
  const venture = "venture-c";
  const mk = (extra: Record<string, unknown>) => newLead(h, "head", { pipelineId: "pipeline-c", ...extra });
  const phone = [{ kind: "phone", value: "98111 22233" }];
  // Calls due: approved for contact with a phone; a call-back due earlier; no phone route -> not a call; not due yet -> not shown.
  const approved = await mk({ stage: "approved_for_contact", contactRoutes: phone });
  const callBack = await mk({ stage: "contacted", nextAction: "Call back", nextActionAt: "2026-10-01T05:00:00.000Z", contactRoutes: [{ kind: "whatsapp", value: "+91 98111 22244" }] });
  await mk({ stage: "contacted", nextAction: "Call back", nextActionAt: "2026-10-01T05:00:00.000Z", contactRoutes: [{ kind: "email", value: "x@y.example" }] });
  await mk({ stage: "contacted", nextAction: "Call back", nextActionAt: "2099-01-01T05:00:00.000Z", contactRoutes: phone });
  await mk({ stage: "contacted", nextAction: "Send the brochure", nextActionAt: "2026-10-01T05:00:00.000Z", contactRoutes: phone });
  // Follow-up due: contacted long ago and still silent.
  const silent = await mk({});
  expectStatus(await log(h, "head", silent.id, { kind: "email", direction: "out", at: "2026-09-01T05:00:00.000Z" }), 201);
  // Needs you: a hold verdict.
  const holdLead = await mk({});
  expectStatus(await h.call("head", "POST", `/sales/leads/${holdLead.id}/verdicts`, { decision: "hold", confidence: "medium", offer: "O", offerFit: "F", evidence: [{ claim: "c", quote: "q", url: "https://example.com" }], against: "a", summary: "No contact route found yet" }), 201);
  // Needs you also shows a low-confidence reject (kept as researched), and a lead whatever its stage (here a closed one that is also do-not-contact).
  const lowRejectLead = await mk({});
  expectStatus(await h.call("head", "POST", `/sales/leads/${lowRejectLead.id}/verdicts`, { decision: "reject", confidence: "low", offer: "O", offerFit: "F", evidence: [{ claim: "c", quote: "q", url: "https://example.com" }], against: "a", summary: "Unsure about this one" }), 201);
  const closedFlagged = await mk({});
  expectStatus(await h.call("head", "PATCH", `/sales/leads/${closedFlagged.id}`, { stage: "lost", exitReason: "No budget", lostReason: "no_budget" }), 200);
  await h.database.db.collection("opportunities").updateOne({ _id: closedFlagged.id }, { $set: { needsYou: true, doNotContact: true } });
  // Won, waiting for delivery work.
  const winner = await mk({});
  expectStatus(await h.call("head", "PATCH", `/sales/leads/${winner.id}`, { stage: "won" }), 200);
  // Replies: one unhandled, one handled.
  const replier = await mk({});
  const replied = expectStatus(await log(h, "head", replier.id, { kind: "whatsapp", direction: "in", body: "Call me" }), 201).data.activity;
  const replier2 = await mk({});
  const replied2 = expectStatus(await log(h, "head", replier2.id, { kind: "email", direction: "in", body: "Not now please", replyType: "not_now" }), 201).data.activity;
  expectStatus(await h.call("head", "POST", `/sales/activities/${replied2.id}/handled`, {}), 200);
  // Drafts: one in review, one ready, one ready but needing a person's approval (play first batch), one WhatsApp without opt-in.
  const play = expectStatus(await h.call("head", "POST", "/sales/plays", { ventureId: venture, name: `Overview play ${suffix}` }), 201).data;
  const draftLead = await mk({});
  const inReview = expectStatus(await h.call("head", "POST", `/sales/leads/${draftLead.id}/drafts`, { channel: "email", body: "In review" }), 201).data;
  const readyLead = await mk({});
  const ready = expectStatus(await h.call("head", "POST", `/sales/leads/${readyLead.id}/drafts`, { channel: "email", body: "Ready" }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${ready.id}/review`, { result: "pass" }), 404); // reviewer is not in venture-c
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${ready.id}/review`, { result: "pass" }), 200);
  const gatedLead = await mk({ playId: play.id });
  const gated = expectStatus(await h.call("head", "POST", `/sales/leads/${gatedLead.id}/drafts`, { channel: "email", body: "Needs the head" }), 201).data;
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${gated.id}/review`, { result: "pass" }), 200);
  const waLead = await mk({});
  const wa = expectStatus(await h.call("head", "POST", `/sales/leads/${waLead.id}/drafts`, { channel: "whatsapp", body: "Hi" }), 201).data;
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${wa.id}/review`, { result: "pass" }), 200);
  const needsFix = await mk({});
  const fix = expectStatus(await h.call("head", "POST", `/sales/leads/${needsFix.id}/drafts`, { channel: "email", body: "Fix me" }), 201).data;
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${fix.id}/review`, { result: "fail", issues: ["No question"] }), 200);
  // A lost lead and a deleted one count as neither open nor visible.
  const lost = await mk({});
  expectStatus(await h.call("head", "PATCH", `/sales/leads/${lost.id}`, { stage: "lost", exitReason: "No budget", lostReason: "no_budget" }), 200);
  const gone = await mk({});
  expectStatus(await h.call("head", "DELETE", `/sales/leads/${gone.id}`), 200);
  // A contact made today counts in the week strip.
  const contactedToday = await mk({});
  expectStatus(await log(h, "head", contactedToday.id, { kind: "email", direction: "out" }), 201);

  const reply = await h.call("head", "GET", `/sales/overview?ventureId=${venture}`);
  const overview = parse(successEnvelope(salesOverviewSchema), reply.body).data;
  const ids = (cards: { id: string }[]) => cards.map((card) => card.id).sort();
  assert.deepEqual(ids(overview.callsDue), ids([approved, callBack]));
  assert.equal(overview.counts.callsDue, 2);
  assert.match(overview.callsDue.find((card) => card.id === callBack.id)!.why, /Call back: overdue/);
  assert.match(overview.callsDue.find((card) => card.id === approved.id)!.why, /Approved for contact/);
  assert.deepEqual(ids(overview.followUpsDue), [silent.id]);
  assert.equal(overview.counts.followUpsDue, 1);
  assert.match(overview.followUpsDue[0]!.why, /^Follow-up due \(day \d+\)$/);
  assert.deepEqual(ids(overview.needsYou), ids([holdLead, lowRejectLead, closedFlagged]));
  assert.equal(overview.counts.needsYou, 3);
  assert.equal(overview.needsYou.find((card) => card.id === holdLead.id)!.why, "Claude: hold, medium confidence");
  assert.equal(overview.needsYou.find((card) => card.id === lowRejectLead.id)!.stage, "researched");
  // The cards carry the real do-not-contact flag (the app hides Call, email and WhatsApp for blocked leads).
  assert.deepEqual(overview.needsYou.map((card) => [card.id === closedFlagged.id, card.doNotContact]).filter(([blocked]) => blocked).map(([, flag]) => flag), [true]);
  assert.ok(overview.needsYou.filter((card) => card.id !== closedFlagged.id).every((card) => card.doNotContact === false));
  assert.ok(overview.callsDue.every((card) => card.doNotContact === false) && overview.followUpsDue.every((card) => card.doNotContact === false));
  assert.ok(overview.wonToHandOver.every((card) => card.doNotContact === false));
  assert.ok(overview.replies.every((item) => item.lead.doNotContact === false));
  assert.deepEqual(ids(overview.wonToHandOver), [winner.id]);
  assert.equal(overview.counts.wonToHandOver, 1);
  assert.deepEqual(overview.replies.map((item) => item.activity.id), [replied.id]);
  assert.equal(overview.counts.replies, 1);
  assert.match(overview.replies[0]!.lead.why, /^Replied on WhatsApp /);
  assert.deepEqual(overview.toReview.map((item) => item.id).sort(), [inReview.id, gated.id, fix.id].sort());
  assert.equal(overview.counts.toReview, 3);
  assert.deepEqual(overview.readyToSend.map((item) => item.id), [ready.id]);
  assert.equal(overview.counts.readyToSend, 1);
  assert.equal(overview.toReview[0]!.lead.companyName.length > 0, true);
  // Stage counts, totals and the last-7-days strip.
  assert.equal(overview.stageCounts.lost, 2);
  assert.equal(overview.stageCounts.invoice_contract, 1);
  assert.equal(overview.stageCounts.approved_for_contact, 1);
  assert.equal(overview.counts.totalLeads, Object.values(overview.stageCounts).reduce((sum, count) => sum + count, 0));
  assert.equal(overview.counts.openLeads, overview.counts.totalLeads - 3); // minus the two lost and the won
  assert.equal(overview.week.contacted, 1); // contactedToday only: the silent lead was contacted in September
  assert.equal(overview.week.replied, 2);
  assert.equal(overview.week.won, 1);
  // owner=me narrows to the person; a venture the person cannot open is empty.
  assert.equal((await h.call("contrib2", "GET", `/sales/overview?ventureId=${venture}`)).data.counts.totalLeads, 0);
  assert.equal((await h.call("contrib", "GET", `/sales/overview?ventureId=${venture}&owner=me`)).data.counts.totalLeads, 0);
  assert.equal((await h.call("head", "GET", `/sales/overview?ventureId=${venture}&owner=me`)).data.counts.totalLeads, overview.counts.totalLeads);
  assert.equal((await h.call("head", "GET", "/sales/overview?tz=Not/AZone")).status, 400);
});

test("lead list filters, searches and pages on the server", skip, async () => {
  const h = await getHarness();
  const tag = `list${suffix}`;
  const names = ["A+B (Traders)", "Alpha Pipes", "alpha fittings", "Beta Works"];
  const made = [];
  for (const [index, companyName] of names.entries()) made.push(await newLead(h, "contrib", { companyName: `${companyName} ${tag}`, city: index < 2 ? "Raipur" : "Bilaspur", contactName: index === 3 ? "Mr Needle" : "", relevance: 10 * (index + 1), ...(index === 1 ? { nextActionAt: "2026-12-01T00:00:00.000Z", nextAction: "Soon" } : {}), ...(index === 2 ? { nextActionAt: "2026-11-01T00:00:00.000Z", nextAction: "Sooner" } : {}) }));
  const list = async (query: string, who: Who = "contrib") => parse(successEnvelope(leadListSchema), (await h.call(who, "GET", `/sales/leads?${query}`)).body).data;
  assert.equal((await list(`q=${encodeURIComponent(tag)}&limit=2`)).total, 4);
  assert.equal((await list(`q=${encodeURIComponent(tag)}&limit=2`)).items.length, 2);
  assert.equal((await list(`q=${encodeURIComponent(tag)}&limit=2&offset=2`)).items.length, 2);
  assert.equal((await list(`q=${encodeURIComponent(tag)}&limit=2&offset=4`)).items.length, 0);
  // q is a case-insensitive text match over company, contact and city, not a regex.
  assert.equal((await list(`q=${encodeURIComponent(`a+b (traders) ${tag}`)}`)).total, 1);
  assert.equal((await list("q=" + encodeURIComponent(".*"))).total, 0);
  assert.equal((await list(`q=${encodeURIComponent("needle")}`)).items[0]?.companyName, `Beta Works ${tag}`);
  assert.equal((await list(`q=bilaspur&sort=name`)).items.every((lead) => lead.city === "Bilaspur"), true);
  assert.equal((await list(`q=${tag}&city=raipur`)).total, 2);
  // Sorting: name (case-insensitive), relevance, next action (undated last).
  assert.deepEqual((await list(`q=${tag}&sort=name`)).items.map((lead) => lead.companyName), [`A+B (Traders) ${tag}`, `alpha fittings ${tag}`, `Alpha Pipes ${tag}`, `Beta Works ${tag}`]);
  assert.deepEqual((await list(`q=${tag}&sort=relevance`)).items.map((lead) => lead.relevance), [40, 30, 20, 10]);
  assert.deepEqual((await list(`q=${tag}&sort=next`)).items.map((lead) => lead.nextAction), ["Sooner", "Soon", "", ""]);
  // Stage lists (comma separated, older names accepted), owner, needs-you, verdict, play.
  await h.call("contrib", "PATCH", `/sales/leads/${made[0]!.id}`, { stage: "researched" });
  await h.call("contrib", "PATCH", `/sales/leads/${made[1]!.id}`, { stage: "conversation" });
  assert.equal((await list(`q=${tag}&stage=researched,replied`)).total, 2);
  assert.equal((await list(`q=${tag}&stage=conversation`)).total, 1);
  assert.equal((await list(`q=${tag}&stage=identified`)).total, 2);
  expectStatus(await h.call("contrib", "GET", `/sales/leads?stage=bogus`), 400);
  assert.equal((await list(`q=${tag}&owner=me`)).total, 4);
  assert.equal((await list(`q=${tag}&owner=user-contrib2`)).total, 0);
  assert.equal((await list(`q=${tag}&needsYou=true`)).total, 0);
  assert.equal((await list(`q=${tag}&needsYou=false`)).total, 4);
  assert.equal((await list(`q=${tag}&verdict=none`)).total, 4);
  assert.equal((await list(`q=${tag}&verdict=recommend`)).total, 0);
  assert.equal((await list(`q=${tag}&pipelineId=pipeline-a2`)).total, 0);
  assert.equal((await list(`q=${tag}&ventureId=venture-a`)).total, 4);
  assert.equal((await list(`q=${tag}&ventureId=venture-b`)).total, 0);
  expectStatus(await h.call("contrib", "GET", "/sales/leads?limit=101"), 400);
  // The venture scope: other ventures' leads never show.
  assert.equal((await list(`q=${tag}`, "outsider")).total, 0);
  assert.equal((await list(`q=${tag}`, "learner")).total, 4);
});

test("lead filters by state, city, industry and how to reach them, and the facets count what each choice leaves", skip, async () => {
  const h = await getHarness();
  const tag = `fac${suffix}`;
  const db = h.database.db;
  const phone = (n: number) => ({ kind: "phone", value: `98765${String(40000 + n)}` });
  const email = (n: number) => ({ kind: "email", value: `f${n}@${tag}.example` });
  // [name, region, city, category, routes, raw spelling written straight to the database (as an import could)]
  const specs: [string, string | undefined, string | undefined, string | undefined, Record<string, unknown>[], Record<string, string> | undefined][] = [
    ["One", "Chhattisgarh", "Raipur", "pumps", [phone(1), email(1)], undefined],
    ["Two", "Chhattisgarh", "Raipur", "Pumps", [phone(2)], { region: "chhattisgarh ", city: "  raipur " }],
    ["Three", "Chhattisgarh", "Raipur", "pipes and fittings", [email(3)], undefined],
    ["Four", "Chhattisgarh", "Bilaspur", "pumps", [], undefined],
    ["Five", "Madhya Pradesh", "Indore", "pipes and fittings", [{ kind: "whatsapp", value: "98765 40005" }], undefined],
    ["Six", "Madhya Pradesh", "Raipur Road", undefined, [{ kind: "linkedin", value: "https://linkedin.example/six" }], undefined],
    ["Seven", undefined, undefined, undefined, [], undefined],
    ["Eight", undefined, undefined, undefined, [], { region: "", city: "   ", category: " " }],
  ];
  const made: Record<string, string> = {};
  for (const [name, region, city, category, routes, raw] of specs) {
    const lead = await newLead(h, "contrib", { companyName: `${name} ${tag}`, contactRoutes: routes, ...(region ? { region } : {}), ...(city ? { city } : {}), ...(category ? { category } : {}) });
    if (raw) await db.collection("opportunities").updateOne({ _id: lead.id }, { $set: raw });
    made[name] = lead.id;
  }
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${made.Two}/whatsapp-opt-in`, { how: "yes_by_email" }), 200);
  const names = (data: { items: { companyName: string }[] }) => data.items.map((lead) => lead.companyName.replace(` ${tag}`, "")).sort();
  const list = async (query: string, who: Who = "contrib") => parse(successEnvelope(leadListSchema), expectStatus(await h.call(who, "GET", `/sales/leads?q=${tag}&limit=100&${query}`), 200).body).data;
  const facets = async (query = "", who: Who = "contrib") => parse(successEnvelope(leadFacetsSchema), expectStatus(await h.call(who, "GET", `/sales/leads/facets?q=${tag}&${query}`), 200).body).data;

  // Filters: exact, ignoring case and spaces around the value; "none" is "not set".
  assert.deepEqual(names(await list("region=chhattisgarh")), ["Four", "One", "Three", "Two"]);
  assert.deepEqual(names(await list("region=MADHYA%20PRADESH")), ["Five", "Six"]);
  assert.deepEqual(names(await list("region=none")), ["Eight", "Seven"]);
  assert.deepEqual(names(await list("city=raipur")), ["One", "Three", "Two"]); // "Raipur Road" is another city
  assert.deepEqual(names(await list("city=Raipur%20Road")), ["Six"]);
  assert.deepEqual(names(await list("city=none")), ["Eight", "Seven"]);
  assert.deepEqual(names(await list("category=PUMPS")), ["Four", "One", "Two"]);
  assert.deepEqual(names(await list("category=none")), ["Eight", "Seven", "Six"]);
  assert.deepEqual(names(await list("contact=phone")), ["Five", "One", "Two"]); // a phone or WhatsApp number
  assert.deepEqual(names(await list("contact=email")), ["One", "Three"]);
  assert.deepEqual(names(await list("contact=whatsapp")), ["Two"]); // consent recorded
  assert.deepEqual(names(await list("contact=none")), ["Eight", "Four", "Seven", "Six"]); // no phone, WhatsApp or email route
  // They combine with each other and with the older filters.
  assert.deepEqual(names(await list("region=Chhattisgarh&category=pumps&contact=phone")), ["One", "Two"]);
  assert.deepEqual(names(await list("region=Chhattisgarh&city=raipur")), ["One", "Three", "Two"]);
  assert.equal((await list("region=Chhattisgarh&city=Indore")).total, 0);
  expectStatus(await h.call("contrib", "GET", "/sales/leads?contact=bogus"), 400);
  expectStatus(await h.call("contrib", "GET", "/sales/leads/facets?contact=bogus"), 400);

  // Facets: variants are one value (shown as the most common spelling), most common first, "not set" apart.
  const all = await facets();
  assert.equal(all.total, 8);
  assert.deepEqual(all.regions, [{ value: "Chhattisgarh", count: 4 }, { value: "Madhya Pradesh", count: 2 }]);
  assert.equal(all.notSet.regions, 2);
  assert.deepEqual(all.cities, [{ value: "Raipur", count: 3, region: "Chhattisgarh" }, { value: "Bilaspur", count: 1, region: "Chhattisgarh" }, { value: "Indore", count: 1, region: "Madhya Pradesh" }, { value: "Raipur Road", count: 1, region: "Madhya Pradesh" }]);
  assert.equal(all.notSet.cities, 2);
  assert.deepEqual(all.categories, [{ value: "pumps", count: 3 }, { value: "pipes and fittings", count: 2 }]);
  assert.equal(all.notSet.categories, 3);
  assert.deepEqual(all.contact, { phone: 3, email: 2, whatsappOptIn: 1, none: 4 });
  // Each group is counted with the OTHER filters on, not its own: choosing a state narrows the cities, and the states stay to switch between.
  const chhattisgarh = await facets("region=chhattisgarh");
  assert.equal(chhattisgarh.total, 4);
  assert.deepEqual(chhattisgarh.regions, all.regions);
  assert.deepEqual(chhattisgarh.cities.map((city) => [city.value, city.count]), [["Raipur", 3], ["Bilaspur", 1]]);
  assert.deepEqual(chhattisgarh.categories, [{ value: "pumps", count: 3 }, { value: "pipes and fittings", count: 1 }]);
  assert.equal(chhattisgarh.notSet.categories, 0);
  assert.deepEqual(chhattisgarh.contact, { phone: 2, email: 2, whatsappOptIn: 1, none: 1 });
  const narrowed = await facets("region=Chhattisgarh&category=pumps&contact=phone");
  assert.equal(narrowed.total, 2);
  assert.deepEqual(narrowed.cities, [{ value: "Raipur", count: 2, region: "Chhattisgarh" }]);
  assert.deepEqual(narrowed.categories.map((row) => [row.value.toLowerCase(), row.count]), [["pumps", 2]]); // the industry count ignores the chosen industry, not the state or the contact filter (a tied spelling is either one)
  assert.deepEqual(narrowed.regions, [{ value: "Chhattisgarh", count: 2 }]);
  const byCity = await facets("city=Raipur");
  assert.deepEqual(byCity.regions, all.regions); // a state and its cities go together: with a city picked the states can still be switched
  assert.deepEqual(byCity.cities, all.cities); // and the city counts ignore the chosen city
  assert.equal(byCity.total, 3);
  assert.equal((await facets("region=none")).total, 2);
  // The other filters (stage, owner, search) count too.
  await h.call("contrib", "PATCH", `/sales/leads/${made.One}`, { stage: "researched" });
  assert.deepEqual((await facets("stage=researched")).regions, [{ value: "Chhattisgarh", count: 1 }]);
  assert.equal((await facets("owner=user-contrib2")).total, 0);

  // Who sees what follows the venture: other ventures' leads never count, and a lead that was deleted is gone.
  assert.equal((await facets("", "outsider")).total, 0);
  assert.deepEqual((await facets("", "outsider")).regions, []);
  assert.equal((await facets("", "learner")).total, 8);
  assert.equal((await facets("ventureId=venture-b")).total, 0);
  assert.equal((await facets("ventureId=venture-a")).total, 8);
  const other = await newLead(h, "contrib", { pipelineId: "pipeline-c", companyName: `Gamma ${tag}`, region: "Gujarat", city: "Surat", category: "textiles", contactRoutes: [] });
  assert.equal((await facets("ventureId=venture-a")).total, 8);
  assert.deepEqual((await facets("", "contrib")).regions.map((row) => row.value), ["Chhattisgarh", "Madhya Pradesh", "Gujarat"]);
  assert.deepEqual((await facets("", "learner")).regions.map((row) => row.value), ["Chhattisgarh", "Madhya Pradesh"]);
  assert.deepEqual((await facets("", "admin")).regions.map((row) => row.value), ["Chhattisgarh", "Madhya Pradesh", "Gujarat"]);
  expectStatus(await h.call("contrib", "DELETE", `/sales/leads/${other.id}`), 200);
  expectStatus(await h.call("contrib", "DELETE", `/sales/leads/${made.Eight}`), 200);
  const afterDelete = await facets();
  assert.equal(afterDelete.total, 7);
  assert.equal(afterDelete.notSet.regions, 1);
  assert.deepEqual(afterDelete.regions.map((row) => row.value), ["Chhattisgarh", "Madhya Pradesh"]);
});

test("deals have a value, a close date and a probability; lost needs a reason category; lists carry money totals and the Overview the pipeline in money", skip, async () => {
  const h = await getHarness();
  const tag = `rev${suffix}`;
  const now = new Date();
  const monthDay = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15, 6)).toISOString();
  const mine = (extra: Record<string, unknown>) => newLead(h, "contrib2", { contactRoutes: [], ...extra });
  const list = async (query: string, who: Who = "contrib2") => parse(successEnvelope(leadListSchema), expectStatus(await h.call(who, "GET", `/sales/leads?q=${tag}&${query}`), 200).body).data;
  const value = async (query = "", who: Who = "contrib2") => parse(successEnvelope(pipelineValueSchema), expectStatus(await h.call(who, "GET", `/sales/pipeline-value?owner=user-contrib2&${query}`), 200).body).data;

  // The new fields are stored (dates as dates), returned, and cleared with null; a probability outside 0 to 100 is refused.
  const a = await mine({ companyName: `A ${tag}`, valueEstimateMinor: 1_000_000, currency: "INR", expectedCloseAt: monthDay(0) });
  assert.equal(a.expectedCloseAt, monthDay(0));
  assert.ok((await leadDoc(h, a.id)).expectedCloseAt instanceof Date);
  assert.equal(a.probability, undefined); // the stage default applies until a person sets one
  const patched = expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${a.id}`, { probability: 40, expectedCloseAt: monthDay(1) }), 200).data;
  assert.deepEqual([patched.probability, patched.expectedCloseAt, patched.valueEstimateMinor], [40, monthDay(1), 1_000_000]);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${a.id}`, { probability: 101 }), 400);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${a.id}`, { probability: -1 }), 400);
  const cleared = expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${a.id}`, { probability: null, expectedCloseAt: null }), 200).data;
  assert.deepEqual([cleared.probability, cleared.expectedCloseAt, cleared.valueEstimateMinor], [undefined, undefined, 1_000_000]);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${a.id}`, { probability: 0 }), 200); // zero is a real answer, not "unset"
  assert.equal((await leadDoc(h, a.id)).probability, 0);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${a.id}`, { probability: null }), 200);
  // Only the owner or a head edits it.
  expectStatus(await h.call("reviewer", "PATCH", `/sales/leads/${a.id}`, { probability: 10 }), 403);
  expectStatus(await h.call("learner", "PATCH", `/sales/leads/${a.id}`, { expectedCloseAt: monthDay(2) }), 403);

  // Lost needs a reason category as well as the written reason; the category goes when the lead is reopened.
  const lead = await mine({ companyName: `Lost ${tag}`, valueEstimateMinor: 500_000 });
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { stage: "lost", exitReason: "Went with someone else" }), 400);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { stage: "lost", exitReason: "Went with someone else", lostReason: "bogus" }), 400);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { lostReason: "price" }), 400); // not lost yet
  const lost = expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { stage: "lost", exitReason: "Went with someone else", lostReason: "chose_competitor" }), 200).data;
  assert.deepEqual([lost.stage, lost.exitReason, lost.lostReason], ["lost", "Went with someone else", "chose_competitor"]);
  assert.equal(expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { lostReason: "price" }), 200).data.lostReason, "price"); // changed while it stays lost
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { lostReason: null }), 400);
  const reopened = expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { stage: "researched" }), 200).data;
  assert.deepEqual([reopened.stage, reopened.exitReason, reopened.lostReason], ["researched", undefined, undefined]);
  expectStatus(await h.call("contrib2", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Born lost ${tag}`, ownerId: "user-contrib2", stage: "lost", exitReason: "x" }), 400);
  expectStatus(await h.call("contrib2", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Born lost ${tag}`, ownerId: "user-contrib2", stage: "lost", exitReason: "x", lostReason: "timing" }), 201);
  // "Not interested on call" is a lost lead with a reason of its own; Claude's own updates default to "other".
  const call = await mine({ companyName: `Call ${tag}` });
  assert.equal((await log(h, "contrib2", call.id, { kind: "call", direction: "out", callOutcome: "not_interested" })).status, 201);
  assert.deepEqual([(await leadDoc(h, call.id)).stage, (await leadDoc(h, call.id)).lostReason], ["lost", "no_need"]);
  const byClaude = await mine({ companyName: `Claude ${tag}` });
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${byClaude.id}`, { stage: "lost", exitReason: "No budget" }, { via: "claude" }), 200);
  assert.equal((await leadDoc(h, byClaude.id)).lostReason, "other");

  // Totals on the list: value and weighted value (own probability, else the stage's) by currency; leads without a value only count.
  const b = await mine({ companyName: `B ${tag}`, valueEstimateMinor: 2_000_000, currency: "INR", probability: 50, expectedCloseAt: monthDay(1) });
  await mine({ companyName: `C ${tag}`, valueEstimateMinor: 500_000, currency: "USD" });
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${(await mine({ companyName: `C2 ${tag}`, valueEstimateMinor: 400_000, currency: "USD" })).id}`, { stage: "researched" }), 200);
  const won = await mine({ companyName: `Won ${tag}`, valueEstimateMinor: 3_000_000, currency: "INR", stage: "invoice_contract" });
  await mine({ companyName: `D ${tag}` });
  assert.equal((await list("limit=1")).totals, undefined); // only on request
  const totals = (await list("totals=true&limit=1")).totals!;
  const inr = totals.byCurrency.find((row) => row.currency === "INR")!;
  const usd = totals.byCurrency.find((row) => row.currency === "USD")!;
  // INR: A (10,00,000 at the "identified" 2%), the reopened lead (5,00,000 at "researched" 5%), B (20,00,000 at its own 50%) and Won (30,00,000 at 90%).
  assert.deepEqual([inr.count, inr.valueMinor, inr.weightedMinor], [4, 1_000_000 + 500_000 + 2_000_000 + 3_000_000, 20_000 + 25_000 + 1_000_000 + 2_700_000]);
  assert.deepEqual([usd.count, usd.valueMinor, usd.weightedMinor], [2, 900_000, 500_000 * 0.02 + 400_000 * 0.05]);
  assert.equal(totals.count, 10); // every lead the filters match, with or without a value
  assert.equal((await list("totals=true&stage=invoice_contract&limit=1")).totals!.byCurrency[0]!.weightedMinor, 2_700_000); // the totals follow the filters
  assert.deepEqual((await list("totals=true&stage=lost&limit=1")).totals, { count: 3, byCurrency: [] }); // lost leads here have no value
  expectStatus(await h.call("contrib2", "GET", "/sales/leads?totals=maybe"), 400);
  assert.deepEqual((await list("totals=true", "outsider")).totals, { count: 0, byCurrency: [] }); // nothing from other ventures

  // The Overview's pipeline in money: open, weighted, forecast by expected close month (an earlier month that is still open counts now), won this month.
  const money = await value();
  assert.equal(money.months.current, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
  const open = money.rows.find((row) => row.currency === "INR")!;
  // Open INR: A (10,00,000, no date again, 2%) and B (20,00,000, own 50%, next month); the reopened lead is open too (5,00,000 at 5%).
  assert.deepEqual([open.openDeals, open.openValueMinor, open.openWeightedMinor], [3, 3_500_000, 20_000 + 1_000_000 + 25_000]);
  assert.deepEqual([open.forecastThisMonthMinor, open.forecastNextMonthMinor, open.unscheduledWeightedMinor], [0, 1_000_000, 45_000]);
  assert.deepEqual([open.wonThisMonthDeals, open.wonThisMonthMinor], [1, 3_000_000]);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${a.id}`, { expectedCloseAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 3, 6)).toISOString() }), 200);
  const overdue = (await value()).rows.find((row) => row.currency === "INR")!;
  assert.deepEqual([overdue.forecastThisMonthMinor, overdue.unscheduledWeightedMinor], [20_000, 25_000]);
  assert.equal((await value()).rows.find((row) => row.currency === "USD")!.openDeals, 2);
  assert.ok((await value()).openWithoutValue >= 1);
  assert.equal(b.expectedCloseAt, monthDay(1));
  assert.ok(won.wonAt);
  // Permissions follow the lead list: a learner sees the venture, an outsider nothing, a venture outside the person's reach nothing.
  assert.ok((await value("", "learner")).rows.length > 0);
  assert.deepEqual((await value("", "outsider")).rows, []);
  assert.deepEqual((await value("ventureId=venture-b")).rows, []);
  expectStatus(await h.call("contrib2", "GET", "/sales/pipeline-value?tz=Mars/Base"), 400);
});

test("plays, find-leads runs and the brain: proposals by writers, approvals by a person who heads the venture", skip, async () => {
  const h = await getHarness();
  // Plays: anyone but a learner proposes (as a draft); only the head or admin approves, and only in the app.
  const proposed = expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-a", name: `Cadence ${suffix}`, audience: "Dealers", hypothesis: "Calls beat email", steps: [{ day: 0, channel: "call", action: "Call" }, { day: 4, channel: "email", action: "Follow up" }], stopRule: "Stop on reply" }, { via: "claude" }), 201).data;
  const play = parse(playSchema, proposed);
  assert.deepEqual([play.status, play.createdVia, play.firstBatchReviewed, play.batchSize], ["draft", "claude", false, 10]);
  expectStatus(await h.call("outsider", "POST", "/sales/plays", { ventureId: "venture-a", name: "x" }), 404);
  assert.equal(expectStatus(await h.call("contrib", "PATCH", `/sales/plays/${play.id}`, { hypothesis: "Edited by the proposer" }), 200).data.hypothesis, "Edited by the proposer");
  expectStatus(await h.call("contrib", "PATCH", `/sales/plays/${play.id}`, { status: "running" }), 403);
  expectStatus(await h.call("contrib2", "PATCH", `/sales/plays/${play.id}`, { name: "Not theirs" }), 403);
  expectStatus(await h.call("head", "PATCH", `/sales/plays/${play.id}`, { status: "running" }), 409); // not approved yet
  expectStatus(await h.call("head", "PATCH", `/sales/plays/${play.id}`, { status: "approved" }), 400); // approval is its own action
  expectStatus(await h.call("admin", "POST", `/sales/plays/${play.id}/approve`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("reviewer", "POST", `/sales/plays/${play.id}/approve`, {}), 403);
  const approved = parse(playSchema, expectStatus(await h.call("admin", "POST", `/sales/plays/${play.id}/approve`, {}), 200).data);
  assert.deepEqual([approved.status, approved.approvedBy], ["approved", "user-admin"]);
  expectStatus(await h.call("admin", "POST", `/sales/plays/${play.id}/approve`, {}), 409);
  assert.equal(expectStatus(await h.call("head", "PATCH", `/sales/plays/${play.id}`, { status: "running" }), 200).data.status, "running");
  // The first-batch switch is a person's decision.
  expectStatus(await h.call("head", "PATCH", `/sales/plays/${play.id}`, { firstBatchReviewed: true }, { via: "claude" }), 403);
  assert.equal(expectStatus(await h.call("head", "PATCH", `/sales/plays/${play.id}`, { firstBatchReviewed: true }), 200).data.firstBatchReviewed, true);
  // Claude changing an approved play's content takes the approval back.
  const reverted = expectStatus(await h.call("head", "PATCH", `/sales/plays/${play.id}`, { audience: "Changed by Claude" }, { via: "claude" }), 200).data;
  assert.deepEqual([reverted.status, reverted.approvedBy, reverted.approvedAt], ["draft", undefined, undefined]);
  // Play stats follow the leads in the play.
  const inPlay = await newLead(h, "contrib", { playId: play.id });
  await log(h, "contrib", inPlay.id, { kind: "email", direction: "out" });
  await log(h, "contrib", inPlay.id, { kind: "email", direction: "in", body: "ok" });
  const plays = parse(successEnvelope(playSchema.array()), (await h.call("learner", "GET", "/sales/plays?ventureId=venture-a")).body).data;
  assert.deepEqual(plays.find((item) => item.id === play.id)?.stats, { leads: 1, contacted: 1, replied: 1, meetings: 0, won: 0 });
  assert.equal((await h.call("outsider", "GET", "/sales/plays?ventureId=venture-a")).data.length, 0);

  // Find runs: planned, or queued for the office PC; cancelled by the planner or a head.
  const plan = { places: ["Raipur", "Bilaspur"], categories: ["pumps"], searches: ["pump dealer raipur"], limit: 40 };
  const planned = parse(findRunSchema, expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Pump dealers in Chhattisgarh", plan }), 201).data);
  assert.equal(planned.status, "planned");
  const queued = parse(findRunSchema, expectStatus(await h.call("contrib", "POST", "/sales/find-runs?queue=true", { ventureId: "venture-a", request: "Pipe wholesalers in Raipur", plan }), 201).data);
  assert.equal(queued.status, "queued");
  expectStatus(await h.call("learner", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Nope nope", plan }), 403);
  expectStatus(await h.call("outsider", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Nope nope", plan }), 404);
  const queue = (await h.call("head", "GET", "/sales/find-runs?queue=true&ventureId=venture-a")).data;
  assert.deepEqual(queue.map((run: any) => run.id), [queued.id]);
  assert.equal((await h.call("head", "GET", "/sales/find-runs?ventureId=venture-a")).data.length, 2);
  expectStatus(await h.call("contrib2", "POST", `/sales/find-runs/${queued.id}/cancel`, {}), 403);
  assert.equal(expectStatus(await h.call("contrib", "POST", `/sales/find-runs/${queued.id}/cancel`, {}), 200).data.status, "cancelled");
  expectStatus(await h.call("contrib", "POST", `/sales/find-runs/${queued.id}/cancel`, {}), 409);
  assert.equal(expectStatus(await h.call("head", "POST", `/sales/find-runs/${planned.id}/cancel`, {}), 200).data.status, "cancelled");
  // A saved plan is queued in the app by its planner or a head: never by Claude, another contributor or a learner, and only while it is a plan.
  const saved = parse(findRunSchema, expectStatus(await h.call("contrib", "POST", "/sales/find-runs", { ventureId: "venture-a", request: "Valve dealers in Durg", plan }), 201).data);
  expectStatus(await h.call("contrib", "POST", `/sales/find-runs/${saved.id}/queue`, {}, { via: "claude" }), 403);
  expectStatus(await h.call("contrib2", "POST", `/sales/find-runs/${saved.id}/queue`, {}), 403);
  expectStatus(await h.call("learner", "POST", `/sales/find-runs/${saved.id}/queue`, {}), 403);
  expectStatus(await h.call("outsider", "POST", `/sales/find-runs/${saved.id}/queue`, {}), 404);
  const nowQueued = parse(findRunSchema, expectStatus(await h.call("contrib", "POST", `/sales/find-runs/${saved.id}/queue`, {}), 200).data);
  assert.equal(nowQueued.status, "queued");
  expectStatus(await h.call("head", "POST", `/sales/find-runs/${saved.id}/queue`, {}), 409);
  assert.deepEqual((await h.call("head", "GET", "/sales/find-runs?queue=true&ventureId=venture-a")).data.map((run: any) => run.id), [saved.id]);
  expectStatus(await h.call("contrib", "POST", `/sales/find-runs/${saved.id}/cancel`, {}), 200);

  // Brain: shared notes. Offers, target profiles and message rules live in offers now (docs/sales-offers.md): a new proposal of
  // those kinds is refused with a pointer to offers, and so is approving an old draft of one.
  for (const kind of ["offer", "target_profile", "message_rules"]) {
    const legacy = expectStatus(await h.call("contrib", "POST", "/sales/brain", { ventureId: "venture-a", kind, title: `Legacy ${kind} ${suffix}`, body: "Old style" }), 400);
    assert.match(legacy.body.error.message, /now live in offers.*propose a new offer/);
  }
  const oldDraft = `old-profile-${suffix}`;
  await h.database.db.collection("sales_brain_items").insertOne({ _id: oldDraft, workspaceId: "workspace-a", ventureId: "venture-a", kind: "target_profile", title: `Old profile ${suffix}`, body: "Who we sell to", status: "draft", version: 1, proposedBy: "user-contrib", via: "claude", createdAt: new Date(), updatedAt: new Date() });
  assert.match(expectStatus(await h.call("head", "POST", `/sales/brain/${oldDraft}/approve`, {}), 400).body.error.message, /target profile, which can no longer be approved here/);
  assert.equal(expectStatus(await h.call("contrib", "POST", `/sales/brain/${oldDraft}/archive`, {}), 200).data.status, "archived");
  // Notes: proposals are drafts; a head approves in the app; approving archives the previous approved item with the same title.
  const item = (body: string) => h.call("contrib", "POST", "/sales/brain", { ventureId: "venture-a", kind: "notes", title: `Order tracking ${suffix}`, body });
  const first = parse(brainItemSchema, expectStatus(await item("Version one"), 201).data);
  assert.deepEqual([first.status, first.version], ["draft", 1]);
  expectStatus(await h.call("contrib", "POST", `/sales/brain/${first.id}/approve`, {}), 403);
  expectStatus(await h.call("head", "POST", `/sales/brain/${first.id}/approve`, {}, { via: "claude" }), 403);
  assert.equal(expectStatus(await h.call("contrib", "PATCH", `/sales/brain/${first.id}`, { body: "Version one, edited" }), 200).data.body, "Version one, edited");
  expectStatus(await h.call("contrib2", "PATCH", `/sales/brain/${first.id}`, { body: "No" }), 403);
  expectStatus(await h.call("head", "POST", `/sales/brain/${first.id}/approve`, {}), 200);
  expectStatus(await h.call("contrib", "PATCH", `/sales/brain/${first.id}`, { body: "Edit approved" }), 409);
  const second = parse(brainItemSchema, expectStatus(await item("Version two"), 201).data);
  assert.equal(second.version, 2);
  assert.equal(expectStatus(await h.call("head", "POST", `/sales/brain/${second.id}/approve`, {}), 200).data.status, "approved");
  const items = parse(successEnvelope(brainItemSchema.array()), (await h.call("learner", "GET", "/sales/brain?ventureId=venture-a&status=draft,approved,archived")).body).data;
  const ours = items.filter((entry) => entry.title === `Order tracking ${suffix}`);
  assert.deepEqual(ours.map((entry) => [entry.version, entry.status]), [[2, "approved"], [1, "archived"]]);
  expectStatus(await h.call("learner", "POST", "/sales/brain", { ventureId: "venture-a", kind: "notes", title: "t", body: "b" }), 403);
  assert.equal((await h.call("outsider", "GET", "/sales/brain?ventureId=venture-a")).data.length, 0);
});

test("every Sales write is audited with the channel, and Claude's writes say so", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const lead = await newLead(h, "contrib");
  await log(h, "contrib", lead.id, { kind: "note", body: "by Claude" }, { via: "claude" });
  const stored0 = (await db.collection("sales_activities").findOne({ leadId: lead.id }))!;
  const viaClaude = await db.collection("audit_events").findOne({ action: "sales.activity.log", objectId: stored0._id });
  assert.ok(viaClaude);
  assert.equal(viaClaude.channel, "mcp");
  assert.equal(viaClaude.result, "success");
  assert.equal(viaClaude.actorId, "user-contrib");
  const stored = await db.collection("sales_activities").findOne({ leadId: lead.id });
  const created = await db.collection("audit_events").findOne({ action: "sales.lead.create", objectId: lead.id });
  assert.equal(created?.channel, "api");
  for (const action of ["sales.lead.create", "sales.activity.log"]) assert.ok(await db.collection("audit_events").countDocuments({ action }) > 0, action);
  // The record also says who: app for people, claude for the connector.
  assert.equal(stored?.via, "claude");
});

test("the older opportunities and pipelines routes keep working on the same records", skip, async () => {
  const h = await getHarness();
  const lead = await newLead(h, "contrib");
  const legacy = await fetch(`${h.origin}/v1/opportunities`, { headers: { "x-test-user": "user-contrib" } });
  const rows = parse(successEnvelope(opportunitySchema.array()), await legacy.json()).data;
  assert.ok(rows.some((row) => row.id === lead.id));
  const pipelines = await (await fetch(`${h.origin}/v1/pipelines`, { headers: { "x-test-user": "user-learner" } })).json() as any;
  assert.ok(pipelines.data.some((pipeline: any) => pipeline.id === "pipeline-a"));
  // The old create route applies the same owner rules: learners cannot add, owners must be members.
  const body = { pipelineId: "pipeline-a", companyName: `Old route ${suffix}`, ownerId: "user-learner" };
  const post = (who: string, payload: unknown) => fetch(`${h.origin}/v1/opportunities`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": who }, body: JSON.stringify(payload) });
  assert.equal((await post("user-learner", body)).status, 403);
  assert.equal((await post("user-contrib", { ...body, ownerId: "user-outsider" })).status, 400);
  assert.equal((await post("user-contrib", { ...body, ownerId: "user-contrib" })).status, 201);
});

test("imports can be re-run: the same external reference returns the existing lead", skip, async () => {
  const h = await getHarness();
  const externalRef = { system: "dealflow-sqlite", id: `lead-${suffix}-1` };
  const first = expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Imported ${suffix}`, ownerId: "user-head", externalRef }), 201).data;
  assert.deepEqual(first.externalRef, externalRef);
  const again = expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Imported ${suffix} (renamed)`, ownerId: "user-head", externalRef }), 200).data;
  assert.equal(again.id, first.id);
  assert.equal(await h.database.db.collection("opportunities").countDocuments({ "externalRef.id": externalRef.id }), 1);
  // The reference cannot be rewritten by an edit, and a deleted lead's reference is not reused silently.
  await h.call("head", "PATCH", `/sales/leads/${first.id}`, { externalRef: { system: "x", id: "y" }, nextAction: "kept" });
  assert.deepEqual((await leadDoc(h, first.id)).externalRef, externalRef);
  await h.call("head", "DELETE", `/sales/leads/${first.id}`);
  expectStatus(await h.call("head", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Imported ${suffix}`, ownerId: "user-head", externalRef }), 409);
});

test("migration renames older stages, sets won dates and backfills match keys, and can run again", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const now = new Date("2026-09-01T00:00:00Z");
  await db.collection("opportunities").insertMany([
    { _id: "legacy-conversation", workspaceId: "workspace-a", ventureId: "venture-a", pipelineId: "pipeline-a", companyName: "Legacy Conv Pvt Ltd", ownerId: "user-contrib", stage: "conversation", contactRoutes: [{ kind: "email", value: "A@Legacy.Example" }], createdAt: now, updatedAt: now },
    { _id: "legacy-won", workspaceId: "workspace-a", ventureId: "venture-a", pipelineId: "pipeline-a", companyName: "Legacy Won", ownerId: "user-contrib", stage: "won", createdAt: now, updatedAt: now },
    { _id: "legacy-open", workspaceId: "workspace-a", ventureId: "venture-a", pipelineId: "pipeline-a", companyName: "Legacy Open", ownerId: "user-contrib", stage: "qualified", createdAt: now, updatedAt: now },
  ]);
  // Before the migration the API already reads the older names as the current ones.
  const early = parse(opportunitySchema, expectStatus(await h.call("contrib", "GET", "/sales/leads/legacy-conversation"), 200).data.lead);
  assert.equal(early.stage, "replied");
  // An unmigrated "won" row is not a won stage yet: it neither waits for delivery work nor counts as won.
  assert.ok(!(await h.call("head", "GET", "/sales/overview?ventureId=venture-a")).data.wonToHandOver.some((card: any) => card.id === "legacy-won"));
  expectStatus(await h.call("head", "POST", "/sales/leads/legacy-won/delivery-work", {}), 409);
  // A lead a verdict disqualified is flagged once (the flag replaces reading the wording of the reason); one with contact history is not.
  await db.collection("migrations").deleteOne({ _id: "004-sales-verdict-flag" });
  const verdictLead = { workspaceId: "workspace-a", ventureId: "venture-a", pipelineId: "pipeline-a", ownerId: "user-contrib", createdAt: now, updatedAt: now, contactRoutes: [] };
  await db.collection("opportunities").insertMany([
    { _id: "legacy-rejected", ...verdictLead, companyName: "Legacy Rejected", stage: "disqualified", exitReason: "Not a fit: sells only retail" },
    { _id: "legacy-contacted-dq", ...verdictLead, companyName: "Legacy Typed", stage: "disqualified", exitReason: "Not a fit: typed", lastTouchAt: now },
  ]);
  const result = await migrateSalesLeads(db);
  assert.ok(result.stagesRenamed >= 2);
  assert.ok(result.verdictFlagsSet >= 1);
  assert.equal((await db.collection("opportunities").findOne({ _id: "legacy-rejected" }))?.disqualifiedByVerdict, true);
  assert.equal((await db.collection("opportunities").findOne({ _id: "legacy-contacted-dq" }))?.disqualifiedByVerdict, undefined);
  const converted = (await db.collection("opportunities").findOne({ _id: "legacy-conversation" }))!;
  assert.equal(converted.stage, "replied");
  assert.deepEqual(converted.suppressKeys.sort(), ["company:legacy conv", "email:a@legacy.example", "domain:legacy.example"].sort());
  const won = (await db.collection("opportunities").findOne({ _id: "legacy-won" }))!;
  assert.deepEqual([won.stage, won.wonAt?.toISOString()], ["invoice_contract", now.toISOString()]);
  assert.equal((await db.collection("opportunities").findOne({ _id: "legacy-open" }))?.stage, "qualified");
  const again = await migrateSalesLeads(db);
  assert.deepEqual(again, { stagesRenamed: 0, wonDatesSet: 0, keysBackfilled: 0, suppressionFixed: 0, dncFlagged: 0, verdictFlagsSet: 0 });
  // The older won lead is now handed over like any other.
  assert.ok((await h.call("head", "GET", "/sales/overview?ventureId=venture-a")).data.wonToHandOver.some((card: any) => card.id === "legacy-won"));
});

test("marking a draft sent claims it first: parallel calls, with or without a requestId, write one activity", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const readyDraft = async (extra: Record<string, unknown> = {}) => {
    const lead = await newLead(h, "contrib", extra);
    const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", subject: "Orders", body: "Hello there" }), 201).data;
    expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
    return { lead, draft };
  };
  const sentCount = (leadId: string) => db.collection("sales_activities").countDocuments({ leadId, direction: "out" });
  // Without a requestId: exactly one wins, the others are told the draft is already sent.
  const plain = await readyDraft();
  const plainReplies = await Promise.all(Array.from({ length: 5 }, () => h.call("contrib", "POST", `/sales/drafts/${plain.draft.id}/sent`, {})));
  assert.deepEqual(plainReplies.map((reply) => reply.status).sort(), [201, 409, 409, 409, 409]);
  assert.equal(await sentCount(plain.lead.id), 1);
  assert.equal((await db.collection("sales_drafts").findOne({ _id: plain.draft.id }))?.status, "sent");
  assert.equal((await leadDoc(h, plain.lead.id)).stage, "contacted");
  // With a requestId: one activity; the callers that lost the claim get the winner's answer, never a second activity.
  const withId = await readyDraft();
  const requestId = `sent-${randomUUID()}`;
  const idReplies = await Promise.all(Array.from({ length: 5 }, () => h.call("contrib", "POST", `/sales/drafts/${withId.draft.id}/sent`, { requestId })));
  assert.ok(idReplies.every((reply) => [200, 201, 409].includes(reply.status)), JSON.stringify(idReplies.map((reply) => reply.status)));
  assert.equal(idReplies.filter((reply) => reply.status === 201).length, 1);
  assert.equal(await sentCount(withId.lead.id), 1);
  const settled = await h.call("contrib", "POST", `/sales/drafts/${withId.draft.id}/sent`, { requestId });
  assert.equal(settled.status, 200);
  assert.equal(settled.data.activity.id, idReplies.find((reply) => reply.status === 201)!.data.activity.id);
  // The same requestId for another draft of that lead is refused, not answered with the first; the draft stays sendable.
  const second = expectStatus(await h.call("contrib", "POST", `/sales/leads/${withId.lead.id}/drafts`, { channel: "email", subject: "Again", body: "A second message", purpose: "follow_up" }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${second.id}/review`, { result: "pass" }), 200);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${second.id}/sent`, { requestId }), 409);
  assert.equal(await sentCount(withId.lead.id), 1);
  assert.equal((await db.collection("sales_drafts").findOne({ _id: second.id }))?.status, "ready");
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${second.id}/sent`, { requestId: `sent-${randomUUID()}` }), 201);
  // A send that is refused before or after the claim leaves the draft sendable.
  const blocked = await readyDraft();
  await db.collection("opportunities").updateOne({ _id: blocked.lead.id }, { $set: { doNotContact: true } });
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${blocked.draft.id}/sent`, {}), 409);
  assert.equal((await db.collection("sales_drafts").findOne({ _id: blocked.draft.id }))?.status, "ready");
  assert.equal(await sentCount(blocked.lead.id), 0);
  // Marking sent with a time in the future is refused and leaves the draft as it was.
  const future = await readyDraft();
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${future.draft.id}/sent`, { at: new Date(Date.now() + 3 * 3_600_000).toISOString() }), 400);
  const intact = await db.collection("sales_drafts").findOne({ _id: future.draft.id });
  assert.deepEqual([intact?.status, intact?.sentAt], ["ready", undefined]);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${future.draft.id}/sent`, {}), 201);
});

test("the older opportunities list is bounded: newest first, 500 by default, paged with limit and offset", skip, async () => {
  const h = await getHarness();
  const tag = `bounded${suffix}`;
  const made = [];
  for (let index = 0; index < 4; index++) made.push(await newLead(h, "contrib", { companyName: `${tag} ${index}` }));
  const list = async (query: string) => {
    const response = await fetch(`${h.origin}/v1/opportunities${query}`, { headers: { "x-test-user": "user-contrib" } });
    return { status: response.status, body: await response.json() as any };
  };
  const all = await list("");
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body.data));
  parse(successEnvelope(opportunitySchema.array()), all.body);
  const stamps = all.body.data.map((item: any) => String(item.updatedAt));
  assert.deepEqual(stamps, [...stamps].sort().reverse(), "newest updated first");
  // Touch the oldest one: it moves to the front.
  expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${made[0]!.id}`, { nextAction: "Bump" }), 200);
  assert.equal((await list("?limit=1")).body.data[0].id, made[0]!.id);
  const page1 = await list("?limit=2");
  const page2 = await list("?limit=2&offset=2");
  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body.data.every((item: any) => !page2.body.data.some((other: any) => other.id === item.id)));
  assert.equal(page1.body.data[0].id, made[0]!.id);
  assert.equal((await list("?limit=1000")).status, 200);
  assert.equal((await list("?limit=1001")).status, 400);
  assert.equal((await list("?limit=0")).status, 400);
  assert.equal((await list("?offset=-1")).status, 400);
  assert.equal((await list("?limit=abc")).status, 400);
  assert.equal((await list("?offset=100000")).body.data.length, 0);
});

test("notices about a won deal disappear with the lead, and the lead cards and draft lists carry the do-not-contact flag", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const lead = await newLead(h, "contrib", { stage: "invoice_contract" });
  const kept = await newLead(h, "contrib");
  const now = new Date();
  await db.collection("notifications").insertMany([lead, kept].map((item, index) => ({ _id: `won-notice-${suffix}-${index}`, outboxId: `won-notice-${suffix}-${index}`, workspaceId: "workspace-a", userId: "user-head", type: "sales_won", title: `Won: ${item.companyName}`, body: "Create delivery work", resourceType: "opportunity", resourceId: item.id, createdAt: new Date(now.getTime() + index) })));
  const actor = (await actorFor(db, { id: "user-head", email: "head@example.invalid", name: "head" }))!;
  const visible = async () => (await listVisibleNotifications(db, actor, { type: "sales_won" })).map((notice) => String(notice.resourceId));
  assert.deepEqual((await visible()).sort(), [lead.id, kept.id].sort());
  expectStatus(await h.call("head", "DELETE", `/sales/leads/${lead.id}`), 200);
  assert.deepEqual(await visible(), [kept.id]);
  // A person outside the venture does not see them either.
  const outsider = (await actorFor(db, { id: "user-outsider", email: "outsider@example.invalid", name: "outsider" }))!;
  await db.collection("notifications").insertOne({ _id: `won-notice-${suffix}-out`, outboxId: `won-notice-${suffix}-out`, workspaceId: "workspace-a", userId: "user-outsider", type: "sales_won", title: "Won", body: "x", resourceType: "opportunity", resourceId: kept.id, createdAt: new Date() });
  assert.deepEqual((await listVisibleNotifications(db, outsider, { type: "sales_won" })).map((notice) => String(notice.resourceId)), []);
  // Cards in the inbox and the draft lists show the real flag.
  const blockable = await newLead(h, "contrib");
  const message = expectStatus(await log(h, "contrib", blockable.id, { kind: "email", direction: "in", body: "Hello" }), 201).data.activity;
  const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${blockable.id}/drafts`, { channel: "email", body: "Reply to you", inReplyTo: message.id }), 201).data;
  const flagOf = async () => ({
    inbox: parse(successEnvelope(inboxItemSchema.array()), (await h.call("contrib", "GET", "/sales/inbox?owner=me&limit=200")).body).data.find((entry) => entry.activity.id === message.id)!.lead.doNotContact,
    draft: parse(successEnvelope(draftWithLeadSchema.array()), (await h.call("contrib", "GET", "/sales/drafts?owner=me&limit=500")).body).data.find((item) => item.id === draft.id)!.lead.doNotContact,
    detail: parse(successEnvelope(leadDetailSchema), (await h.call("contrib", "GET", `/sales/leads/${blockable.id}`)).body).data.lead.doNotContact,
  });
  assert.deepEqual(await flagOf(), { inbox: false, draft: false, detail: false });
  await db.collection("opportunities").updateOne({ _id: blockable.id }, { $set: { doNotContact: true, importUpdatedAt: new Date() } });
  assert.deepEqual(await flagOf(), { inbox: true, draft: true, detail: true });
  // Internal bookkeeping fields never leave the API.
  const exposed = JSON.stringify([(await h.call("contrib", "GET", `/sales/leads/${blockable.id}`)).body, (await h.call("contrib", "GET", `/sales/leads?q=${encodeURIComponent(blockable.companyName)}`)).body, await (await fetch(`${h.origin}/v1/opportunities`, { headers: { "x-test-user": "user-contrib" } })).json()]);
  for (const field of ["importUpdatedAt", "suppressKeys", "suppressKeysV", "deletedAt", "payloadHash", "disqualifiedByVerdict", "approvedForContactBy"]) assert.ok(!exposed.includes(`"${field}"`), field);
  const overview = parse(successEnvelope(salesOverviewSchema), (await h.call("contrib", "GET", "/sales/overview?owner=me&ventureId=venture-a")).body).data;
  assert.equal(overview.toReview.find((item) => item.id === draft.id)?.lead.doNotContact, true);
  assert.equal(overview.replies.find((item) => item.activity.id === message.id)?.lead.doNotContact, true);
});

test("a lead's next action has one reminder for its owner: replaced when the date or text changes, moved with the owner, cancelled when the lead closes", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const ahead = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const all = (leadId: string) => db.collection("reminders").find({ leadId, kind: "sales_next_action" }).sort({ createdAt: 1, _id: 1 }).toArray();
  const live = async (leadId: string) => (await all(leadId)).filter((row) => row.state === "scheduled");
  const patch = (who: Who, id: string, body: Record<string, unknown>) => h.call(who, "PATCH", `/sales/leads/${id}`, body);
  // Created with the lead: one reminder for the owner, at that time, worded with the next action and the company.
  const date = ahead(30);
  const lead = await newLead(h, "contrib", { nextAction: "Call again", nextActionAt: date });
  const first = await live(lead.id);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0]!.userId, first[0]!.message, first[0]!.timezone, first[0]!.repeatMinutes, first[0]!.sequence, first[0]!.ventureId, first[0]!.workspaceId], ["user-contrib", `Call again: ${lead.companyName}`, "Asia/Kolkata", null, 0, "venture-a", "workspace-a"]);
  assert.equal(first[0]!.scheduledAt.toISOString(), date);
  // The same data again changes nothing; a new date replaces it (the old one is cancelled, never left to fire).
  expectStatus(await patch("contrib", lead.id, { nextActionAt: date }), 200);
  assert.equal((await all(lead.id)).length, 1);
  const moved = ahead(50);
  expectStatus(await patch("contrib", lead.id, { nextActionAt: moved }), 200);
  const afterMove = await all(lead.id);
  assert.deepEqual(afterMove.map((row) => [row.state, row.cancelReason]), [["cancelled", "replaced"], ["scheduled", undefined]]);
  assert.equal(afterMove[1]!.scheduledAt.toISOString(), moved);
  // A new text reads in the reminder; the other legacy route works the same way.
  expectStatus(await patch("contrib", lead.id, { nextAction: "Send the brochure" }), 200);
  assert.equal((await live(lead.id))[0]!.message, `Send the brochure: ${lead.companyName}`);
  const legacy = await fetch(`${h.origin}/v1/opportunities/${lead.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-test-user": "user-contrib" }, body: JSON.stringify({ nextActionAt: ahead(60) }) });
  assert.equal(legacy.status, 200);
  assert.equal((await live(lead.id)).length, 1);
  // Cleared, in the past or less than a minute away: no reminder.
  for (const value of [null, ahead(-5), new Date(Date.now() + 20_000).toISOString()]) {
    expectStatus(await patch("contrib", lead.id, { nextActionAt: ahead(70) }), 200);
    assert.equal((await live(lead.id)).length, 1);
    expectStatus(await patch("contrib", lead.id, { nextActionAt: value }), 200);
    assert.equal((await live(lead.id)).length, 0, String(value));
  }
  // The reminder goes to whoever owns the lead.
  expectStatus(await patch("contrib", lead.id, { nextActionAt: ahead(80) }), 200);
  expectStatus(await patch("head", lead.id, { ownerId: "user-contrib2" }), 200);
  assert.deepEqual((await live(lead.id)).map((row) => row.userId), ["user-contrib2"]);
  // Closing the lead (lost, or an opt-out) and deleting it end it; reopening with a date makes a new one.
  expectStatus(await patch("head", lead.id, { stage: "lost", exitReason: "No budget", lostReason: "no_budget" }), 200);
  assert.equal((await live(lead.id)).length, 0);
  expectStatus(await patch("head", lead.id, { stage: "replied", nextActionAt: ahead(90), nextAction: "Call back" }), 200);
  assert.equal((await live(lead.id)).length, 1);
  expectStatus(await h.call("head", "DELETE", `/sales/leads/${lead.id}`), 200);
  assert.equal((await live(lead.id)).length, 0);
  // The automatic next steps of logged activity: "Call again" tomorrow, "Book the discovery call" within the working hours; "Send details" is due now, so no reminder.
  const caller = await newLead(h, "contrib");
  const noAnswer = expectStatus(await log(h, "contrib", caller.id, { kind: "call", direction: "out", callOutcome: "no_answer" }), 201);
  const callReminder = await live(caller.id);
  assert.deepEqual([callReminder.length, callReminder[0]!.message, callReminder[0]!.scheduledAt.toISOString()], [1, `Call again: ${caller.companyName}`, noAnswer.data.lead.nextActionAt]);
  expectStatus(await log(h, "contrib", caller.id, { kind: "call", direction: "out", callOutcome: "not_interested" }), 201);
  assert.equal((await live(caller.id)).length, 0);
  const warm = await newLead(h, "contrib");
  const interested = expectStatus(await log(h, "contrib", warm.id, { kind: "email", direction: "in", replyType: "interested", body: "Yes" }), 201);
  assert.equal((await live(warm.id))[0]?.scheduledAt.toISOString(), interested.data.lead.nextActionAt);
  assert.match((await live(warm.id))[0]!.message, /^Book the discovery call: /);
  const details = await newLead(h, "contrib");
  expectStatus(await log(h, "contrib", details.id, { kind: "email", direction: "in", replyType: "send_details", body: "Send details" }), 201);
  assert.equal((await live(details.id)).length, 0);
  const optOut = await newLead(h, "contrib", { nextAction: "Call", nextActionAt: ahead(40) });
  assert.equal((await live(optOut.id)).length, 1);
  expectStatus(await log(h, "contrib", optOut.id, { kind: "email", direction: "in", replyType: "opt_out", body: "Stop" }), 201);
  assert.equal((await live(optOut.id)).length, 0);
  // A lead that is on the do-not-contact list is not reminded about.
  const blocked = await newLead(h, "contrib");
  await db.collection("opportunities").updateOne({ _id: blocked.id }, { $set: { doNotContact: true } });
  expectStatus(await patch("contrib", blocked.id, { nextAction: "Call", nextActionAt: ahead(40) }), 200);
  assert.equal((await live(blocked.id)).length, 0);
});

test("notices: a reply on your lead, a message waiting for approval, a lead that needs you (each once)", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const notices = (type: string, resourceId: string) => db.collection("notification_outbox").find({ type, resourceId }).sort({ createdAt: 1, _id: 1 }).toArray();
  const users = async (type: string, resourceId: string) => (await notices(type, resourceId)).map((row) => row.userId as string).sort();
  // A reply logged by someone else (a teammate, or a head's Claude) tells the owner; the owner's own entry does not.
  const lead = await newLead(h, "contrib");
  const reply = expectStatus(await log(h, "head", lead.id, { kind: "email", direction: "in", body: `Hello ${"long ".repeat(60)}` }), 201).data.activity;
  const first = await notices("sales_reply", lead.id);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0]!.userId, first[0]!.title, first[0]!.resourceType, first[0]!.state, first[0]!.idempotencyKey, first[0]!.workspaceId], ["user-contrib", `Reply from ${lead.companyName}`, "opportunity", "pending", `activity:${reply.id}:reply`, "workspace-a"]);
  assert.match(first[0]!.body, /^Email: Hello long/);
  assert.ok(first[0]!.body.length <= 160);
  expectStatus(await log(h, "contrib", lead.id, { kind: "whatsapp", direction: "in", body: "my own" }), 201);
  expectStatus(await log(h, "head", lead.id, { kind: "email", direction: "out", body: "outbound is not a reply" }), 201);
  expectStatus(await h.call("head", "PATCH", `/sales/activities/${reply.id}`, { replyType: "interested" }), 200); // sorting it later is not a new reply
  assert.equal((await notices("sales_reply", lead.id)).length, 1);
  expectStatus(await log(h, "head", lead.id, { kind: "email", direction: "in", body: "via Claude" }, { via: "claude" }), 201);
  assert.equal((await notices("sales_reply", lead.id)).length, 2);

  // Needs you: the owner hears when a verdict lands the lead there; once while it stays there; through Claude the owner is told too.
  const verdict = (decision: string, confidence: string) => ({ decision, confidence, offer: "O", offerFit: "F", evidence: [{ claim: "c", quote: "q", url: "https://example.com" }], against: "a", summary: `Verdict ${decision}` });
  const judged = await newLead(h, "contrib");
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${judged.id}/verdicts`, verdict("hold", "medium")), 201); // the owner's own save in the app
  assert.deepEqual(await notices("sales_needs_you", judged.id), []);
  const held = expectStatus(await h.call("head", "POST", `/sales/leads/${judged.id}/verdicts`, verdict("hold", "high")), 201).data; // already needs you: no second notice
  assert.deepEqual(await notices("sales_needs_you", judged.id), []);
  const other = await newLead(h, "contrib");
  const lands = expectStatus(await h.call("head", "POST", `/sales/leads/${other.id}/verdicts`, verdict("hold", "medium")), 201).data;
  const needs = await notices("sales_needs_you", other.id);
  assert.deepEqual([needs.length, needs[0]!.userId, needs[0]!.title, needs[0]!.type, needs[0]!.idempotencyKey], [1, "user-contrib", `Needs you: ${other.companyName}`, "sales_needs_you", `lead:${other.id}:needs_you:${lands.verdict.id}`]);
  assert.match(needs[0]!.body, /hold, medium confidence/);
  expectStatus(await h.call("head", "POST", `/sales/leads/${other.id}/verdicts`, verdict("hold", "low")), 201);
  assert.equal((await notices("sales_needs_you", other.id)).length, 1);
  // A person decides (override), then Claude's next hold lands it there again: the owner is told, through Claude too.
  expectStatus(await h.call("contrib", "POST", `/sales/verdicts/${(await leadDoc(h, other.id)).verdict.verdictId}/override`, { decision: "recommend", reason: "Spoke to the owner" }), 200);
  const claudeOwn = await newLead(h, "contrib");
  expectStatus(await h.call("contrib", "POST", `/sales/leads/${claudeOwn.id}/verdicts`, verdict("hold", "medium"), { via: "claude" }), 201);
  assert.deepEqual(await users("sales_needs_you", claudeOwn.id), ["user-contrib"]);
  assert.ok(held.verdict.id);

  // Approval: a ready draft that needs a person (a play's first batch) tells the venture's heads and the admins, once per draft, not the reviewer.
  const play = expectStatus(await h.call("contrib", "POST", "/sales/plays", { ventureId: "venture-a", name: `Notice play ${suffix}` }), 201).data;
  const planned = await newLead(h, "contrib", { playId: play.id });
  const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${planned.id}/drafts`, { channel: "email", subject: "S", body: "Hello there" }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${draft.id}/review`, { result: "fail", issues: ["Too long"] }), 200);
  assert.deepEqual(await notices("sales_approval", draft.id), []); // a failed review needs no approval
  expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${draft.id}`, { body: "Hello again" }), 200);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
  const approvals = await notices("sales_approval", draft.id);
  assert.deepEqual(approvals.map((row) => row.userId).sort(), ["user-admin", "user-head"]);
  assert.deepEqual([approvals[0]!.resourceType, approvals[0]!.title, approvals[0]!.type], ["sales_draft", `Approve a message to ${planned.companyName}`, "sales_approval"]);
  assert.ok(approvals.every((row) => row.idempotencyKey === `draft:${draft.id}:approval:${row.userId}`));
  // Edited and passed again: the same draft does not notify twice.
  expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${draft.id}`, { body: "Hello a third time" }), 200);
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
  assert.equal((await notices("sales_approval", draft.id)).length, 2);
  // The head who reviews it is not told about their own review; a draft that needs no approval tells nobody.
  const second = expectStatus(await h.call("contrib", "POST", `/sales/leads/${planned.id}/drafts`, { channel: "email", subject: "S", body: "Another one" }), 201).data;
  expectStatus(await h.call("head", "POST", `/sales/drafts/${second.id}/review`, { result: "pass" }), 200);
  assert.deepEqual(await users("sales_approval", second.id), ["user-admin"]);
  const plain = await newLead(h, "contrib");
  const noPlay = expectStatus(await h.call("contrib", "POST", `/sales/leads/${plain.id}/drafts`, { channel: "email", subject: "S", body: "No play" }), 201).data;
  expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${noPlay.id}/review`, { result: "pass" }), 200);
  assert.deepEqual(await notices("sales_approval", noPlay.id), []);

  // Visibility: the approval notice goes once the draft is approved, discarded or its lead deleted; notices of a deleted lead go too.
  const now = new Date();
  const headActor = (await actorFor(h.database.db, { id: "user-head", email: "head@example.invalid", name: "head" }))!;
  const contribActor = (await actorFor(h.database.db, { id: "user-contrib", email: "contrib@example.invalid", name: "contrib" }))!;
  const note = (id: string, userId: string, type: string, resourceType: string, resourceId: string) => ({ _id: `${id}-${suffix}`, outboxId: `${id}-${suffix}`, workspaceId: "workspace-a", userId, type, title: type, body: type, resourceType, resourceId, createdAt: now });
  await db.collection("notifications").insertMany([note("n-appr", "user-head", "sales_approval", "sales_draft", draft.id), note("n-appr2", "user-head", "sales_approval", "sales_draft", second.id), note("n-reply", "user-contrib", "sales_reply", "opportunity", lead.id)]);
  const seen = async (actor: typeof headActor, type: string) => (await listVisibleNotifications(db, actor, { type })).map((item) => String(item.resourceId)).sort();
  assert.deepEqual(await seen(headActor, "sales_approval"), [draft.id, second.id].sort());
  expectStatus(await h.call("head", "POST", `/sales/drafts/${draft.id}/approve`, {}), 200);
  assert.deepEqual(await seen(headActor, "sales_approval"), [second.id]);
  expectStatus(await h.call("contrib", "POST", `/sales/drafts/${second.id}/discard`, {}), 200);
  assert.deepEqual(await seen(headActor, "sales_approval"), []);
  assert.deepEqual(await seen(contribActor, "sales_reply"), [lead.id]);
  expectStatus(await h.call("head", "DELETE", `/sales/leads/${lead.id}`), 200);
  assert.deepEqual(await seen(contribActor, "sales_reply"), []);
});

test("sales settings: defaults for every venture, saved by a head or admin in the app, validated", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  try {
    const get = (who: Who, ventureId = "venture-a") => h.call(who, "GET", `/sales/settings?ventureId=${ventureId}`);
    const put = (who: Who, body: unknown, ventureId = "venture-a", options?: { via?: "claude" }) => h.call(who, "PUT", `/sales/settings?ventureId=${ventureId}`, body, options);
    const defaults = { workingDays: [1, 2, 3, 4, 5, 6], blackoutDates: ["2026-10-20", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"], followUpAfterWorkingDays: 4, replySlaHours: 2, dailyCaps: { email: 20, whatsapp: 20 }, approvalMode: "claude_review_enough", allowedChannels: ["call", "email", "whatsapp", "linkedin"], timezone: "Asia/Kolkata" };
    for (const who of ["admin", "head", "contrib", "learner"] as const) {
      const reply = expectStatus(await get(who), 200);
      assert.deepEqual(salesSettingsViewSchema.parse(reply.data), { ventureId: "venture-a", ...defaults });
    }
    expectStatus(await get("outsider"), 404);
    expectStatus(await get("outside-admin"), 404);
    expectStatus(await h.call("head", "GET", "/sales/settings"), 400);
    expectStatus(await get("head", "no-such-venture"), 404);
    // Saving: a head of the venture or an admin, in the app; everyone else and Claude are refused.
    const custom = { workingDays: [1, 2, 3, 4, 5], blackoutDates: ["2026-09-09", "2026-12-25"], followUpAfterWorkingDays: 3, replySlaHours: 4, dailyCaps: { email: 2, whatsapp: 0 }, approvalMode: "person_approves_every_message", allowedChannels: ["call", "email"], timezone: "America/New_York" };
    for (const who of ["contrib", "learner", "reviewer", "outsider"] as const) expectStatus(await put(who, custom), who === "outsider" ? 404 : 403);
    expectStatus(await put("head", custom, "venture-a", { via: "claude" }), 403);
    expectStatus(await put("head", custom, "venture-b"), 404); // not their venture
    const saved = expectStatus(await put("head", custom), 200);
    const view = salesSettingsViewSchema.parse(saved.data);
    assert.deepEqual([view.ventureId, view.workingDays, view.blackoutDates, view.followUpAfterWorkingDays, view.replySlaHours, view.dailyCaps, view.approvalMode, view.allowedChannels, view.timezone, view.updatedBy], ["venture-a", [1, 2, 3, 4, 5], ["2026-09-09", "2026-12-25"], 3, 4, { email: 2, whatsapp: 0 }, "person_approves_every_message", ["call", "email"], "America/New_York", "user-head"]);
    assert.ok(view.updatedAt);
    assert.deepEqual(salesSettingsViewSchema.parse((await get("learner")).data).blackoutDates, ["2026-09-09", "2026-12-25"]);
    assert.deepEqual(salesSettingsViewSchema.parse((await get("head", "venture-c")).data), { ventureId: "venture-c", ...defaults }); // other ventures keep the defaults
    // The change is audited: who, which fields.
    const audit = await db.collection("audit_events").findOne({ action: "sales.settings.update", objectId: "venture-a", actorId: "user-head" });
    assert.equal(audit?.channel, "api");
    assert.deepEqual(audit?.metadata.changed.split(",").sort(), ["allowedChannels", "approvalMode", "blackoutDates", "dailyCaps", "followUpAfterWorkingDays", "replySlaHours", "timezone", "workingDays"]);
    // A save replaces everything: what the body leaves out is back to its default; an admin may save too; values are sorted and de-duplicated.
    const partial = salesSettingsViewSchema.parse(expectStatus(await put("admin", { followUpAfterWorkingDays: 6, workingDays: [6, 1, 1, 2], blackoutDates: ["2026-02-01", "2026-01-01", "2026-01-01"] }), 200).data);
    assert.deepEqual([partial.followUpAfterWorkingDays, partial.workingDays, partial.blackoutDates, partial.approvalMode, partial.timezone, partial.updatedBy], [6, [1, 2, 6], ["2026-01-01", "2026-02-01"], "claude_review_enough", "Asia/Kolkata", "user-admin"]);
    assert.equal(await db.collection("sales_settings").countDocuments({ _id: "venture-a" }), 1);
    // Validation.
    for (const [label, body] of [
      ["no working days", { workingDays: [] }], ["weekday 0", { workingDays: [0] }], ["weekday 8", { workingDays: [8] }], ["a bad date", { blackoutDates: ["2026-02-30"] }], ["a date in words", { blackoutDates: ["tomorrow"] }],
      ["follow-up 0", { followUpAfterWorkingDays: 0 }], ["follow-up 31", { followUpAfterWorkingDays: 31 }], ["sla 0", { replySlaHours: 0 }], ["negative cap", { dailyCaps: { email: -1, whatsapp: 1 } }], ["bad mode", { approvalMode: "whenever" }],
      ["no channels", { allowedChannels: [] }], ["unknown channel", { allowedChannels: ["fax"] }], ["bad zone", { timezone: "Mars/Olympus" }],
    ] as [string, unknown][]) expectStatus(await put("head", body), 400);
    assert.equal(salesSettingsViewSchema.parse((await get("head")).data).followUpAfterWorkingDays, 6);
  } finally { await db.collection("sales_settings").deleteMany({}); }
});

test("sales settings change what the rules do: a custom week and blackout, the follow-up and reply timing, channels, daily caps", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  try {
    // Monday to Friday, 9 Sep blacked out, follow-up after 3 working days: Friday 4 Sep + Mon 7, Tue 8, (Wed 9 is blacked out) Thu 10.
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { workingDays: [1, 2, 3, 4, 5], blackoutDates: ["2026-09-09"], followUpAfterWorkingDays: 3 }), 200);
    const touch = async (pipelineId: string, who: Who) => {
      const lead = await newLead(h, who, { pipelineId });
      return (await log(h, who, lead.id, { kind: "email", direction: "out", at: "2026-09-04T09:30:00.000Z" })).data.lead.followUpDueAt as string;
    };
    assert.equal(await touch("pipeline-c", "head"), iso(ist("2026-09-10")));
    // The same touch in a venture with the default settings: Sat 5, Mon 7, Tue 8, Wed 9 (Saturday counts, no blackout then).
    assert.equal(await touch("pipeline-a", "contrib"), iso(ist("2026-09-09")));
    // The default blackout is only a default: a venture that leaves it out schedules on those days.
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { blackoutDates: [] }), 200);
    assert.equal(await touch("pipeline-c", "head"), iso(ist("2026-09-09")));
  } finally { await db.collection("sales_settings").deleteMany({}); }
});

test("sales settings: allowed channels and daily caps limit drafts and sends, per person and venture", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const ready = async (who: Who, pipelineId: string, channel = "email", extra: Record<string, unknown> = {}) => {
    const lead = await newLead(h, who, { pipelineId, ...extra });
    const draft = expectStatus(await h.call(who, "POST", `/sales/leads/${lead.id}/drafts`, { channel, subject: channel === "email" ? "S" : undefined, body: "Hello there" }), 201).data;
    expectStatus(await h.call("head", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
    return { lead, draft };
  };
  const send = (who: Who, draftId: string) => h.call(who, "POST", `/sales/drafts/${draftId}/sent`, {});
  try {
    // Daily caps: counted per person and venture for the local day the sends happened (`at`); the venture's own number decides.
    // (Earlier tests already sent some emails as this person today, so the cap is set relative to that.)
    const used = await db.collection("sales_activities").countDocuments({ workspaceId: "workspace-a", ventureId: "venture-c", actorId: "user-head", direction: "out", kind: "email", at: { $gte: startOfLocalDay(new Date(), "Asia/Kolkata") } });
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { dailyCaps: { email: used + 2, whatsapp: 0 } }), 200);
    const emails = [await ready("head", "pipeline-c"), await ready("head", "pipeline-c"), await ready("head", "pipeline-c")];
    expectStatus(await send("head", emails[0]!.draft.id), 201);
    expectStatus(await send("head", emails[1]!.draft.id), 201);
    const capped = expectStatus(await send("head", emails[2]!.draft.id), 409);
    assert.match(capped.body.error.message, new RegExp(`daily email limit of ${used + 2}`));
    assert.equal((await db.collection("sales_drafts").findOne({ _id: emails[2]!.draft.id }))?.status, "ready");
    // Logged activity counts toward the person's day too; another person's day, and another venture, are separate.
    const opted = await newLead(h, "contrib", { pipelineId: "pipeline-c" });
    expectStatus(await log(h, "contrib", opted.id, { kind: "whatsapp", direction: "in", body: "hi" }), 201);
    const wa = expectStatus(await h.call("contrib", "POST", `/sales/leads/${opted.id}/drafts`, { channel: "whatsapp", body: "Hello on WhatsApp" }), 201).data;
    expectStatus(await h.call("head", "POST", `/sales/drafts/${wa.id}/review`, { result: "pass" }), 200);
    const zero = expectStatus(await send("contrib", wa.id), 409);
    assert.match(zero.body.error.message, /daily whatsapp limit of 0/);
    const otherPerson = await ready("contrib", "pipeline-c");
    expectStatus(await send("contrib", otherPerson.draft.id), 201);
    const elsewhere = await ready("contrib", "pipeline-a");
    expectStatus(await send("contrib", elsewhere.draft.id), 201);
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { dailyCaps: { email: used + 3, whatsapp: 5 } }), 200);
    expectStatus(await send("head", emails[2]!.draft.id), 201); // raised: now it goes
    expectStatus(await send("contrib", wa.id), 201);
    // Allowed channels: a venture that does not use LinkedIn or WhatsApp takes no drafts for it, and cannot send ones written before.
    const early = await ready("head", "pipeline-c", "linkedin");
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { allowedChannels: ["call", "email"] }), 200);
    const refused = expectStatus(await send("head", early.draft.id), 409);
    assert.match(refused.body.error.message, /does not use linkedin/);
    const lead = await newLead(h, "head", { pipelineId: "pipeline-c" });
    for (const channel of ["whatsapp", "linkedin"]) assert.match(expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/drafts`, { channel, body: "Hello" }), 409).body.error.message, new RegExp(`does not use ${channel}`));
    expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", subject: "S", body: "Hello" }), 201);
    expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "call_opener", body: "Script: hello" }), 201); // calls are allowed
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { allowedChannels: ["email"] }), 200);
    expectStatus(await h.call("head", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "call_opener", body: "Script: hello again" }), 409);
    // The other venture keeps its own (default) settings: WhatsApp drafts work there.
    expectStatus(await h.call("contrib", "POST", `/sales/leads/${(await newLead(h, "contrib")).id}/drafts`, { channel: "whatsapp", body: "Hello" }), 201);
  } finally { await db.collection("sales_settings").deleteMany({}); }
});

test("approval mode: claude_review_enough needs a person for a play's first batch; person_approves_every_message for every message", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const ready = async (who: Who, extra: Record<string, unknown> = {}, channel = "email") => {
    const lead = await newLead(h, who, { pipelineId: "pipeline-c", ...extra });
    const draft = expectStatus(await h.call(who, "POST", `/sales/leads/${lead.id}/drafts`, { channel, subject: channel === "email" ? "S" : undefined, body: "Hello there" }), 201).data;
    expectStatus(await h.call("head", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
    return { lead, draft };
  };
  const send = (who: Who, draftId: string, options?: { via?: "claude" }) => h.call(who, "POST", `/sales/drafts/${draftId}/sent`, {}, options);
  const overview = async () => parse(successEnvelope(salesOverviewSchema), (await h.call("head", "GET", "/sales/overview?ventureId=venture-c")).body).data;
  try {
    // Default mode: a draft with no play goes straight through once reviewed.
    const free = await ready("contrib");
    assert.ok((await overview()).readyToSend.some((item) => item.id === free.draft.id));
    expectStatus(await send("contrib", free.draft.id), 201);
    // Every message: reviewed drafts wait for a person; the Overview lists them under "to review", not "ready to send".
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { approvalMode: "person_approves_every_message" }), 200);
    const first = await ready("contrib");
    const blocked = expectStatus(await send("contrib", first.draft.id), 409);
    assert.match(blocked.body.error.message, /every message/);
    const view = await overview();
    assert.ok(view.toReview.some((item) => item.id === first.draft.id));
    assert.ok(!view.readyToSend.some((item) => item.id === first.draft.id));
    // Who approves: Claude never; the lead's owner or a head or admin in the app; a contributor who does not own the lead cannot.
    expectStatus(await h.call("contrib", "POST", `/sales/drafts/${first.draft.id}/approve`, {}, { via: "claude" }), 403);
    expectStatus(await h.call("head", "POST", `/sales/drafts/${first.draft.id}/approve`, {}, { via: "claude" }), 403);
    expectStatus(await h.call("reviewer", "POST", `/sales/drafts/${first.draft.id}/approve`, {}), 404); // not a member of venture-c
    const stranger = await ready("head");
    expectStatus(await h.call("contrib", "POST", `/sales/drafts/${stranger.draft.id}/approve`, {}), 403); // not their lead
    const approved = expectStatus(await h.call("contrib", "POST", `/sales/drafts/${first.draft.id}/approve`, {}), 200).data; // the owner
    assert.equal(approved.personApproval.by, "user-contrib");
    assert.ok((await overview()).readyToSend.some((item) => item.id === first.draft.id));
    // Editing sends it back: the approval is gone, and a new review needs a new approval.
    expectStatus(await h.call("contrib", "PATCH", `/sales/drafts/${first.draft.id}`, { body: "Changed after approval" }), 200);
    expectStatus(await h.call("head", "POST", `/sales/drafts/${first.draft.id}/review`, { result: "pass" }), 200);
    expectStatus(await send("contrib", first.draft.id), 409);
    expectStatus(await h.call("admin", "POST", `/sales/drafts/${first.draft.id}/approve`, {}), 200);
    expectStatus(await send("contrib", first.draft.id), 201);
    // The admin is told a message waits (once), as with a play's first batch; call openers are scripts, never messages to approve.
    // (The head reviewed it here, so only the admin is told.)
    assert.deepEqual((await db.collection("notification_outbox").find({ type: "sales_approval", resourceId: first.draft.id }).toArray()).map((row) => row.userId).sort(), ["user-admin"]);
    const opener = await ready("contrib", {}, "call_opener");
    assert.ok(!(await overview()).readyToSend.some((item) => item.id === opener.draft.id));
    assert.equal(await db.collection("notification_outbox").countDocuments({ type: "sales_approval", resourceId: opener.draft.id }), 0);
    // The other mode again: the first-batch rule only (a play whose first batch nobody has read).
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { approvalMode: "claude_review_enough" }), 200);
    const loose = await ready("contrib");
    expectStatus(await send("contrib", loose.draft.id), 201);
    const play = expectStatus(await h.call("head", "POST", "/sales/plays", { ventureId: "venture-c", name: `Approval play ${suffix}` }), 201).data;
    const inPlay = await ready("contrib", { playId: play.id });
    assert.match(expectStatus(await send("contrib", inPlay.draft.id), 409).body.error.message, /first batch/);
    expectStatus(await h.call("head", "POST", `/sales/drafts/${inPlay.draft.id}/approve`, {}), 200);
    expectStatus(await send("contrib", inPlay.draft.id), 201);
    // And in the per-message mode the play's first-batch counter is unaffected: approving does not mark the batch read unless the batch is full.
    assert.equal((await db.collection("sales_plays").findOne({ _id: play.id }))?.firstBatchReviewed, false);
  } finally { await db.collection("sales_settings").deleteMany({}); }
});

test("the Sales routes are reachable through the whole app with the dev sign-in", skip, async () => {
  const dbName = `vso_test_sales_${suffix}_full`;
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: "http://localhost:3000", API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  });
  const database = await connectDatabase(config);
  try {
    await ensureIndexes(database.db);
    const now = new Date();
    await database.db.collection("workspaces").insertOne({ _id: "workspace-a", name: "A", slug: "a", createdAt: now });
    await database.db.collection("ventures").insertOne({ _id: "venture-a", workspaceId: "workspace-a", name: "Alpha", status: "active", createdAt: now });
    await database.db.collection("pipelines").insertOne({ _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "P", offerName: "O", status: "active", createdAt: now, updatedAt: now });
    await database.db.collection("users").insertOne({ _id: "user-head", workspaceId: "workspace-a", email: "head@example.invalid", name: "head", handle: "head", status: "active", createdAt: now, updatedAt: now });
    await database.db.collection("memberships").insertOne({ _id: "membership-head", workspaceId: "workspace-a", userId: "user-head", role: "venture_head", ventureIds: ["venture-a"], groupIds: [], status: "active", createdAt: now, updatedAt: now });
    const { app } = createApp(database, config, createAuth(database.native, config), new LocalObjectStore(config));
    const server = createServer(app).listen(0);
    await once(server, "listening");
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const headers = { "content-type": "application/json", "x-dev-user-id": "user-head" };
    try {
      const created = await fetch(`${origin}/v1/sales/leads`, { method: "POST", headers, body: JSON.stringify({ pipelineId: "pipeline-a", companyName: "Full Stack Co", ownerId: "user-head" }) });
      assert.equal(created.status, 201, await created.clone().text());
      const overview = await fetch(`${origin}/v1/sales/overview?ventureId=venture-a`, { headers });
      assert.equal(parse(successEnvelope(salesOverviewSchema), await overview.json()).data.counts.totalLeads, 1);
      assert.equal((await fetch(`${origin}/v1/sales/overview`)).status, 401);
      assert.equal((await fetch(`${origin}/v1/sales/nothing-here`, { headers })).status, 404);
    } finally { server.close(); await once(server, "close"); }
  } finally {
    await database.native.dropDatabase();
    await database.client.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Review round 2 (audit fixes): approvals, do-not-contact flagging, currency codes, daily caps
// ---------------------------------------------------------------------------------------------------------------------

test("approvals: in the every-message mode a lead's owner approves their own message, but only a head's approval counts toward a play's first batch; the payload says who must approve", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const ready = async (playId: string, channel = "email") => {
    const lead = await newLead(h, "contrib", { pipelineId: "pipeline-c", playId });
    const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${lead.id}/drafts`, { channel, subject: channel === "email" ? "S" : undefined, body: "Hello there" }), 201).data;
    expectStatus(await h.call("head", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
    return { lead, draft };
  };
  const listed = async (draftId: string) => successEnvelope(draftWithLeadSchema.array()).parse((await h.call("contrib", "GET", "/sales/drafts?ventureId=venture-c&status=ready")).body).data.find((item) => item.id === draftId);
  const overview = async () => parse(successEnvelope(salesOverviewSchema), (await h.call("head", "GET", "/sales/overview?ventureId=venture-c")).body).data;
  const send = (draftId: string) => h.call("contrib", "POST", `/sales/drafts/${draftId}/sent`, {});
  try {
    const play = expectStatus(await h.call("head", "POST", "/sales/plays", { ventureId: "venture-c", name: `Owner approvals ${suffix}`, batchSize: 1 }), 201).data;
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { approvalMode: "person_approves_every_message" }), 200);
    // Every message: the draft says it waits for a person, and why (the lead's owner may approve it).
    const first = await ready(play.id);
    assert.deepEqual([(await listed(first.draft.id))?.needsPersonApproval, (await listed(first.draft.id))?.approvalReason], [true, "every_message"]);
    const inQueue = (await overview()).toReview.find((item) => item.id === first.draft.id);
    assert.deepEqual([inQueue?.needsPersonApproval, inQueue?.approvalReason], [true, "every_message"]);
    // The owner approves their own message and may send it, but that is not a head reading the play's first batch.
    const approved = expectStatus(await h.call("contrib", "POST", `/sales/drafts/${first.draft.id}/approve`, {}), 200).data;
    assert.deepEqual([approved.personApproval.by, approved.personApproval.byHead, approved.needsPersonApproval, approved.approvalReason], ["user-contrib", false, false, null]);
    assert.equal((await db.collection("sales_plays").findOne({ _id: play.id }))?.firstBatchReviewed, false, "an owner's approval never marks the batch read");
    expectStatus(await send(first.draft.id), 201);
    // A second owner-approved draft, not sent yet, when the venture goes back to the first-batch rule: a head still has to read it.
    const pending = await ready(play.id);
    expectStatus(await h.call("contrib", "POST", `/sales/drafts/${pending.draft.id}/approve`, {}), 200);
    expectStatus(await h.call("head", "PUT", "/sales/settings?ventureId=venture-c", { approvalMode: "claude_review_enough" }), 200);
    assert.deepEqual([(await listed(pending.draft.id))?.needsPersonApproval, (await listed(pending.draft.id))?.approvalReason], [true, "first_batch"]);
    assert.ok(!(await overview()).readyToSend.some((item) => item.id === pending.draft.id));
    assert.match(expectStatus(await send(pending.draft.id), 409).body.error.message, /first batch/);
    // Back in the first-batch mode the owner can't approve; a head can, and that approval completes the batch of one.
    const second = await ready(play.id);
    assert.deepEqual([(await listed(second.draft.id))?.needsPersonApproval, (await listed(second.draft.id))?.approvalReason], [true, "first_batch"]);
    assert.match(expectStatus(await send(second.draft.id), 409).body.error.message, /first batch/);
    expectStatus(await h.call("contrib", "POST", `/sales/drafts/${second.draft.id}/approve`, {}), 403);
    const byHead = expectStatus(await h.call("head", "POST", `/sales/drafts/${second.draft.id}/approve`, {}), 200).data;
    assert.deepEqual([byHead.personApproval.byHead, byHead.needsPersonApproval], [true, false]);
    assert.equal((await db.collection("sales_plays").findOne({ _id: play.id }))?.firstBatchReviewed, true);
    expectStatus(await send(second.draft.id), 201);
    // A draft with nothing to approve says so; the list and the single draft agree.
    const free = await newLead(h, "contrib", { pipelineId: "pipeline-c" });
    const plain = expectStatus(await h.call("contrib", "POST", `/sales/leads/${free.id}/drafts`, { channel: "email", subject: "S", body: "Hello" }), 201).data;
    assert.deepEqual([plain.needsPersonApproval, plain.approvalReason], [false, null]);
    // Approvals stored before `byHead` existed count when the approver heads the venture (and not when they don't).
    const legacyPlay = expectStatus(await h.call("head", "POST", "/sales/plays", { ventureId: "venture-c", name: `Legacy approvals ${suffix}`, batchSize: 2 }), 201).data;
    const old1 = await ready(legacyPlay.id); const old2 = await ready(legacyPlay.id);
    await db.collection("sales_drafts").updateOne({ _id: old1.draft.id }, { $set: { personApproval: { by: "user-contrib", at: new Date() } } });
    expectStatus(await h.call("head", "POST", `/sales/drafts/${old2.draft.id}/approve`, {}), 200);
    assert.equal((await db.collection("sales_plays").findOne({ _id: legacyPlay.id }))?.firstBatchReviewed, false, "a contributor's old approval does not count");
    await db.collection("sales_drafts").updateOne({ _id: old1.draft.id }, { $set: { personApproval: { by: "user-head", at: new Date() } } });
    const old3 = await ready(legacyPlay.id);
    expectStatus(await h.call("head", "POST", `/sales/drafts/${old3.draft.id}/approve`, {}), 200);
    assert.equal((await db.collection("sales_plays").findOne({ _id: legacyPlay.id }))?.firstBatchReviewed, true, "a head's old approval does");
  } finally { await db.collection("sales_settings").deleteMany({}); }
});

test("do-not-contact flagging stops the flagged leads' reminders and drafts: an opt-out on a twin lead, a manual entry and an edit", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
  const withWork = async (who: Who, extra: Record<string, unknown> = {}) => {
    const lead = await newLead(h, who, { nextAction: "Call again", nextActionAt: future(), ...extra });
    const draft = expectStatus(await h.call(who, "POST", `/sales/leads/${lead.id}/drafts`, { channel: "call_opener", body: "Hello, about your dealers" }), 201).data;
    assert.equal(await db.collection("reminders").countDocuments({ leadId: lead.id, state: "scheduled" }), 1);
    return { lead, draft };
  };
  const stopped = async (leadId: string, draftId: string) => {
    assert.equal((await leadDoc(h, leadId)).doNotContact, true);
    assert.deepEqual((await db.collection("reminders").find({ leadId }).toArray()).map((row) => [row.state, row.cancelReason]), [["cancelled", "do_not_contact"]]);
    const draft = await db.collection("sales_drafts").findOne({ _id: draftId });
    assert.deepEqual([draft?.status, draft?.discardedReason], ["discarded", "The lead is on the do-not-contact list"]);
  };
  // An opt-out on one lead flags its twin (the same company, owned by someone else): the twin's reminder and draft stop too.
  const name = `Twin Traders ${suffix}`;
  const one = await newLead(h, "contrib", { companyName: name });
  const twin = await withWork("contrib2", { companyName: `${name} Pvt Ltd` });
  expectStatus(await log(h, "contrib", one.id, { kind: "email", direction: "in", body: "Please stop emailing us", replyType: "opt_out" }), 201);
  await stopped(twin.lead.id, twin.draft.id);
  // A head adds the company to the list by hand.
  const manual = await withWork("contrib");
  expectStatus(await h.call("head", "POST", "/sales/suppression", { kind: "company", value: manual.lead.companyName, reason: "Asked by phone" }), 201);
  await stopped(manual.lead.id, manual.draft.id);
  // An edit adds an address the list already has.
  const edited = await withWork("contrib");
  const blockedEmail = `stop-r2-${suffix}@blocked.example`;
  expectStatus(await h.call("head", "POST", "/sales/suppression", { kind: "email", value: blockedEmail, reason: "Opted out elsewhere" }), 201);
  assert.equal(expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${edited.lead.id}`, { contactRoutes: [{ kind: "email", value: blockedEmail }] }), 200).data.doNotContact, true);
  await stopped(edited.lead.id, edited.draft.id);
});

test("currency: a three-letter code, upper-cased on input; anything else is refused, and a bad stored code never breaks the money numbers", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  assert.equal((await newLead(h, "contrib2", { valueEstimateMinor: 100_000, currency: " usd " })).currency, "USD");
  for (const currency of ["1@#", "INRR", "IN", "₹₹₹"]) {
    const refused = expectStatus(await h.call("contrib2", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Bad Currency ${currency} ${suffix}`, ownerId: "user-contrib2", valueEstimateMinor: 1, currency }), 400);
    assert.match(JSON.stringify(refused.body), /three-letter currency code/);
  }
  const lead = await newLead(h, "contrib2", { valueEstimateMinor: 200_000, currency: "INR" });
  expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { currency: "x1y" }), 400);
  assert.equal(expectStatus(await h.call("contrib2", "PATCH", `/sales/leads/${lead.id}`, { currency: "eur" }), 200).data.currency, "EUR");
  // A code stored before the check (here written directly) is left out of the totals and the pipeline value, and reads as no currency.
  const legacy = await newLead(h, "contrib2", { valueEstimateMinor: 300_000, currency: "INR", companyName: `Legacy Currency ${suffix}` });
  await db.collection("opportunities").updateOne({ _id: legacy.id }, { $set: { currency: "1@#" } });
  const value = parse(successEnvelope(pipelineValueSchema), expectStatus(await h.call("contrib2", "GET", "/sales/pipeline-value?owner=me"), 200).body).data;
  assert.ok(value.rows.every((row) => /^[A-Z]{3}$/.test(row.currency)), JSON.stringify(value.rows));
  const list = parse(successEnvelope(leadListSchema), expectStatus(await h.call("contrib2", "GET", "/sales/leads?owner=me&totals=true&limit=100"), 200).body).data;
  assert.ok(list.totals!.byCurrency.every((row) => /^[A-Z]{3}$/.test(row.currency)), JSON.stringify(list.totals));
  assert.equal(list.items.find((item) => item.id === legacy.id)?.currency, undefined, "the list still parses; the bad code reads as none");
  await db.collection("opportunities").updateOne({ _id: legacy.id }, { $set: { deletedAt: new Date() } });
});

test("daily caps: parallel sends never pass the cap, logged outbound messages take from the same count, and a send logged for an earlier day does not", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const now = new Date();
  await db.collection("ventures").insertOne({ _id: "venture-cap", workspaceId: "workspace-a", name: "Caps", status: "active", createdAt: now });
  await db.collection("pipelines").insertOne({ _id: "pipeline-cap", workspaceId: "workspace-a", ventureId: "venture-cap", name: "Caps", offerName: "Offer", status: "active", createdAt: now, updatedAt: now });
  const ready = async () => {
    const lead = await newLead(h, "admin", { pipelineId: "pipeline-cap" });
    const draft = expectStatus(await h.call("admin", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", subject: "S", body: "Hello there" }), 201).data;
    expectStatus(await h.call("admin", "POST", `/sales/drafts/${draft.id}/review`, { result: "pass" }), 200);
    return { lead, draft };
  };
  try {
    expectStatus(await h.call("admin", "PUT", "/sales/settings?ventureId=venture-cap", { dailyCaps: { email: 1, whatsapp: 0 } }), 200);
    const drafts = [await ready(), await ready(), await ready(), await ready()];
    const results = await Promise.all(drafts.map(({ draft }) => h.call("admin", "POST", `/sales/drafts/${draft.id}/sent`, {})));
    assert.deepEqual(results.map((reply) => reply.status).sort(), [201, 409, 409, 409], "four at once with a cap of one: one goes");
    for (const reply of results.filter((item) => item.status === 409)) assert.match(reply.body.error.message, /daily email limit of 1/);
    assert.deepEqual((await db.collection("sales_drafts").find({ _id: { $in: drafts.map(({ draft }) => draft.id) } }).toArray()).map((row) => row.status).sort(), ["ready", "ready", "ready", "sent"]);
    const counter = () => db.collection("sales_send_counters").findOne({ ventureId: "venture-cap", userId: "user-admin", channel: "email" });
    assert.equal((await counter())?.count, 1);
    // Logging an outbound email by hand takes from the same count: refused at the cap, and nothing is logged.
    const unsent = drafts.filter(({ draft }) => results[drafts.findIndex((item) => item.draft.id === draft.id)]!.status === 409);
    const lead = unsent[0]!.lead;
    const before = await db.collection("sales_activities").countDocuments({ leadId: lead.id });
    assert.match(expectStatus(await log(h, "admin", lead.id, { kind: "email", direction: "out", body: "Sent by hand" }), 409).body.error.message, /daily email limit of 1/);
    assert.equal(await db.collection("sales_activities").countDocuments({ leadId: lead.id }), before);
    // A message sent on an earlier day and logged now is not one of today's sends.
    const yesterday = new Date(startOfLocalDay(new Date(), "Asia/Kolkata").getTime() - 3_600_000).toISOString();
    expectStatus(await log(h, "admin", lead.id, { kind: "email", direction: "out", body: "Sent yesterday", at: yesterday }), 201);
    // A higher cap lets one more through, and the count follows.
    expectStatus(await h.call("admin", "PUT", "/sales/settings?ventureId=venture-cap", { dailyCaps: { email: 2, whatsapp: 0 } }), 200);
    expectStatus(await log(h, "admin", unsent[1]!.lead.id, { kind: "email", direction: "out", body: "Sent by hand" }), 201);
    assert.equal((await counter())?.count, 2);
    expectStatus(await h.call("admin", "POST", `/sales/drafts/${unsent[2]!.draft.id}/sent`, {}), 409);
    // WhatsApp with a cap of zero: nothing goes; calls are never capped.
    assert.match(expectStatus(await log(h, "admin", unsent[2]!.lead.id, { kind: "whatsapp", direction: "out", body: "Hi" }), 409).body.error.message, /daily whatsapp limit of 0/);
    expectStatus(await log(h, "admin", unsent[2]!.lead.id, { kind: "call", callOutcome: "no_answer" }), 201);
  } finally {
    await db.collection("sales_settings").deleteMany({});
    await db.collection("opportunities").updateMany({ ventureId: "venture-cap" }, { $set: { deletedAt: new Date() } });
    await db.collection("ventures").updateOne({ _id: "venture-cap" }, { $set: { status: "archived" } });
  }
});

test("the Dealflow importer's refresh flags leads the do-not-contact list now matches (one way), discards their drafts and cancels their reminders", skip, async () => {
  const h = await getHarness();
  const db = h.database.db;
  const imported = new Date("2026-09-01T00:00:00.000Z");
  const edited = new Date("2026-09-15T00:00:00.000Z");
  const lead = (ref: string, updatedAt: Date) => ({
    _id: `df-r2-${ref}-${suffix}`, workspaceId: "workspace-studio", ventureId: "venture-buildory", pipelineId: "pipeline-buildory", companyName: `Imported ${ref}`, stage: "researched", ownerId: "user-divyansh",
    externalRef: { system: "dealflow-sqlite", id: `r2-${ref}-${suffix}` }, doNotContact: false, nextAction: "Call again", nextActionAt: new Date(Date.now() + 3 * 86_400_000), createdAt: imported, updatedAt, importUpdatedAt: imported,
  });
  const rows = [lead("untouched", imported), lead("edited", edited), lead("clean", imported)];
  await db.collection("opportunities").insertMany(rows);
  for (const row of rows) {
    await db.collection("reminders").insertOne({ _id: `rem-${row._id}`, workspaceId: "workspace-studio", userId: "user-divyansh", kind: "sales_next_action", leadId: row._id, ventureId: row.ventureId, message: "Call again", scheduledAt: row.nextActionAt, state: "scheduled", createdAt: imported, updatedAt: imported });
    await db.collection("sales_drafts").insertOne({ _id: `draft-${row._id}`, workspaceId: "workspace-studio", ventureId: row.ventureId, leadId: row._id, channel: "email", purpose: "first_touch", subject: "S", body: "Hello", status: "in_review", authorId: "user-divyansh", authorVia: "import", createdAt: imported, updatedAt: imported });
  }
  // What the importer recomputed: the first two now match the list, the third does not.
  // (scripts/import-dealflow.ts passes the references of the leads its plan marks doNotContact.)
  const flag = (flags: boolean[], at = new Date()) => flagImportedDoNotContact(db, "workspace-studio", "dealflow-sqlite", rows.filter((_, index) => flags[index]).map((row) => row.externalRef.id), at);
  assert.deepEqual(await flag([true, true, false]), { flagged: 2, draftsDiscarded: 2, remindersCancelled: 2 });
  const docs: AppDocument[] = await Promise.all(rows.map((row) => leadDoc(h, row._id)));
  const untouched = docs[0]!, changed = docs[1]!, clean = docs[2]!;
  assert.deepEqual([untouched.doNotContact, changed.doNotContact, clean.doNotContact], [true, true, false]);
  // A lead nobody edited stays "untouched" for later refreshes; an edited one keeps its marker.
  assert.equal(new Date(untouched.importUpdatedAt).getTime(), new Date(untouched.updatedAt).getTime());
  assert.equal(new Date(changed.importUpdatedAt).getTime(), imported.getTime());
  const state = async (row: { _id: string }) => [(await db.collection("sales_drafts").findOne({ _id: `draft-${row._id}` }))?.status, (await db.collection("reminders").findOne({ _id: `rem-${row._id}` }))?.state];
  assert.deepEqual(await Promise.all(rows.map(state)), [["discarded", "cancelled"], ["discarded", "cancelled"], ["in_review", "scheduled"]]);
  // Again: nothing more to do. And one way: a plan that no longer matches never clears the flag.
  assert.deepEqual(await flag([true, true, false]), { flagged: 0, draftsDiscarded: 0, remindersCancelled: 0 });
  await flag([false, false, false]);
  assert.equal((await leadDoc(h, rows[0]!._id)).doNotContact, true);
  await db.collection("opportunities").deleteMany({ workspaceId: "workspace-studio" });
});

test("GET /sales/drafts/:id: one draft shaped like a list row, for members of the lead's venture only, gone with a deleted lead", skip, async () => {
  const h = await getHarness();
  const lead = await newLead(h, "contrib");
  const draft = expectStatus(await h.call("contrib", "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", subject: "S", body: "Hello there" }), 201).data;
  const one = successEnvelope(draftWithLeadSchema).parse(expectStatus(await h.call("contrib", "GET", `/sales/drafts/${draft.id}`), 200).body).data;
  assert.deepEqual([one.id, one.lead.id, one.status, one.needsPersonApproval, one.approvalReason], [draft.id, lead.id, "in_review", false, null]);
  const row = successEnvelope(draftWithLeadSchema.array()).parse((await h.call("contrib", "GET", "/sales/drafts?ventureId=venture-a&limit=500")).body).data.find((item) => item.id === draft.id);
  assert.deepEqual(one, row, "the same shape as the list");
  // Anyone who can open the venture reads it (a learner, a head, an admin); nobody else, and no other workspace.
  for (const who of ["learner", "head", "admin", "contrib2"] as Who[]) expectStatus(await h.call(who, "GET", `/sales/drafts/${draft.id}`), 200);
  for (const who of ["outsider", "outside-admin"] as Who[]) assert.match(expectStatus(await h.call(who, "GET", `/sales/drafts/${draft.id}`), 404).body.error.message, /Draft not found/);
  expectStatus(await h.call("contrib", "GET", "/sales/drafts/no-such-draft"), 404);
  // A play's first batch waiting for a head shows why.
  const play = expectStatus(await h.call("head", "POST", "/sales/plays", { ventureId: "venture-a", name: `Single draft ${suffix}` }), 201).data;
  const inPlay = await newLead(h, "contrib", { playId: play.id });
  const batch = expectStatus(await h.call("contrib", "POST", `/sales/leads/${inPlay.id}/drafts`, { channel: "email", subject: "S", body: "First batch" }), 201).data;
  expectStatus(await h.call("head", "POST", `/sales/drafts/${batch.id}/review`, { result: "pass" }), 200);
  const waiting = expectStatus(await h.call("contrib", "GET", `/sales/drafts/${batch.id}`), 200).data;
  assert.deepEqual([waiting.needsPersonApproval, waiting.approvalReason], [true, "first_batch"]);
  // A deleted lead takes its drafts with it.
  expectStatus(await h.call("head", "DELETE", `/sales/leads/${lead.id}`), 200);
  expectStatus(await h.call("contrib", "GET", `/sales/drafts/${draft.id}`), 404);
});

test("contact extraction stays fast on long text: bounded email matching, nothing extracted past 2,000 characters, no +0 numbers", () => {
  const long = ["a".repeat(60_000), `${"a".repeat(60_000)}@`, "a.".repeat(30_000), "1 ".repeat(30_000), `x@${"a.".repeat(30_000)}`, `${"a1".repeat(30_000)}@b`];
  const started = performance.now();
  for (const text of long) { assert.deepEqual(extractEmails(text), []); assert.deepEqual(extractPhones(text), []); }
  leadSuppressKeys({ companyName: "Long Notes Co", contactRoutes: [{ kind: "other", value: "a".repeat(60_000) }, { kind: "website_form", value: `${"a".repeat(60_000)}@` }] });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${Math.round(elapsed)} ms`);
  // Just under the cap the worst cases stay quick, and real values are still found.
  const near = performance.now();
  extractEmails("a".repeat(1_999)); extractEmails(`${"a".repeat(1_990)}@`); extractPhones("1 ".repeat(999)); extractPhones("1".repeat(1_999));
  assert.ok(performance.now() - near < 200);
  assert.deepEqual(extractEmails(`${"x ".repeat(900)} Sales <Sales@Acme.in>`), ["sales@acme.in"]);
  assert.deepEqual(extractEmails(`${"a".repeat(2_001)} sales@acme.in`), []);
  assert.deepEqual(extractPhones("Call 98765 43210 or 0771-4012345"), ["+919876543210", "+917714012345"]);
  // E.164: no country code starts with 0, and a number has 8 to 15 digits.
  for (const value of ["+0 98765 43210", "+01234567890", "+12 345", "+1234567890123456"]) assert.equal(normalizePhone(value), null, value);
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
});

test("a do-not-contact lead is never moved into a contact stage by an edit; closing it stays allowed", skip, async () => {
  const h = await getHarness();
  const blocked = await newLead(h, "contrib", { companyName: `Blocked Stage ${suffix}` });
  expectStatus(await h.call("head", "POST", "/sales/suppression", { kind: "company", value: blocked.companyName, reason: "Asked us to stop" }), 201);
  assert.equal((await leadDoc(h, blocked.id)).doNotContact, true);
  for (const stage of ["approved_for_contact", "contacted", "replied", "discovery_booked", "qualified", "proposal", "conversation"]) {
    for (const who of ["contrib", "head"] as Who[]) {
      const refused = expectStatus(await h.call(who, "PATCH", `/sales/leads/${blocked.id}`, { stage }), 409);
      assert.match(refused.body.error.message, /on the do-not-contact list/, `${who} ${stage}`);
    }
  }
  assert.equal((await leadDoc(h, blocked.id)).stage, "identified");
  // Closing it is fine.
  assert.equal(expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${blocked.id}`, { stage: "lost", exitReason: "Asked us to stop", lostReason: "other" }), 200).data.stage, "lost");
  const other = await newLead(h, "contrib", { companyName: `Blocked Stage Two ${suffix}` });
  expectStatus(await h.call("head", "POST", "/sales/suppression", { kind: "company", value: other.companyName, reason: "Asked us to stop" }), 201);
  assert.equal(expectStatus(await h.call("head", "PATCH", `/sales/leads/${other.id}`, { stage: "disqualified", exitReason: "Asked us to stop" }), 200).data.stage, "disqualified");
  // An edit that puts the lead on the list (a blocked address) cannot move it into a contact stage in the same request: nothing changes.
  const fresh = await newLead(h, "contrib");
  const email = `blocked-stage-${suffix}@blocked.example`;
  expectStatus(await h.call("head", "POST", "/sales/suppression", { kind: "email", value: email, reason: "Opted out elsewhere" }), 201);
  assert.match(expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${fresh.id}`, { stage: "researched", contactRoutes: [{ kind: "email", value: email }] }), 200).data.stage, /researched/);
  const twin = await newLead(h, "contrib");
  assert.match(expectStatus(await h.call("contrib", "PATCH", `/sales/leads/${twin.id}`, { stage: "approved_for_contact", contactRoutes: [{ kind: "email", value: email }] }), 409).body.error.message, /on the do-not-contact list/);
  assert.deepEqual([(await leadDoc(h, twin.id)).stage, (await leadDoc(h, twin.id)).doNotContact ?? false], ["identified", false]);
});
