import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router } from "express";
import { occurrences } from "@venture-studio/core";
import type { AppConfig } from "../config.js";
import type { AppDb, Database } from "../db.js";
import { audit } from "../audit.js";
import { AppError } from "../errors.js";
import { jsonValue } from "../json.js";
import { actorFor, overLimit } from "../middleware.js";
import { canSeeEvent, layerItems, timingOf } from "./calendar.js";

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN = /^vsocal_[A-Za-z0-9_-]{30,64}$/;
const DAY_MS = 86_400_000;
const MAX_FEED_ITEMS = 1_500;

/** Turning the personal calendar link on, resetting it (the old link stops working), or off. */
export function calendarFeedRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();
  const feedUrl = (token: string) => `${new URL(config.APP_ORIGIN).origin}/v1/calendar/feed/${token}.ics`;
  router.get("/calendar/feed", async (req, res) => {
    const actor = req.actor!;
    const feed = await db.collection("calendar_feeds").findOne({ workspaceId: actor.membership.workspaceId, userId: actor.id });
    res.json({ ok: true, data: jsonValue(feed ? { enabled: true, createdAt: feed.createdAt } : { enabled: false }) });
  });
  router.post("/calendar/feed", async (req, res) => {
    const actor = req.actor!;
    const token = `vsocal_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    // One link per person: making a new one replaces (and so switches off) the previous link.
    await db.collection("calendar_feeds").updateOne({ workspaceId: actor.membership.workspaceId, userId: actor.id }, { $set: { tokenHash: hashOf(token), createdAt: now }, $setOnInsert: { _id: randomUUID() } }, { upsert: true });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "calendar.feed.create", objectType: "calendar_feed", result: "success" });
    res.status(201).json({ ok: true, data: { enabled: true, createdAt: now.toISOString(), url: feedUrl(token) } });
  });
  router.delete("/calendar/feed", async (req, res) => {
    const actor = req.actor!;
    await db.collection("calendar_feeds").deleteOne({ workspaceId: actor.membership.workspaceId, userId: actor.id });
    await audit(db, { workspaceId: actor.membership.workspaceId, actorId: actor.id, channel: "api", action: "calendar.feed.delete", objectType: "calendar_feed", result: "success" });
    res.json({ ok: true, data: { enabled: false } });
  });
  return router;
}

/**
 * The private calendar link, read by Google or Apple Calendar without signing in: the secret in the address is the key.
 * It carries the person's own calendar (their events and invitations, deadlines, reviews, classes, requests) from 30 days
 * back to 180 days ahead, under the same visibility rules as the app. It stops working when reset, turned off, or when
 * the person's membership ends.
 */
export function publicCalendarFeedRoutes(database: Database, config: AppConfig): Router {
  const db = database.db;
  const router = Router();
  const appOrigin = new URL(config.APP_ORIGIN).origin;
  router.get("/calendar/feed/:file", async (req, res) => {
    const token = String(req.params.file).replace(/\.ics$/i, "");
    if (!TOKEN.test(token)) throw new AppError(404, "NOT_FOUND", "Calendar not found");
    // Per link as well as per address: Google and Apple fetch many people's calendars from the same addresses.
    const wait = await overLimit(db, `calendar-feed:${hashOf(token).slice(0, 24)}`, 20);
    if (wait) { res.set("Retry-After", String(wait)); throw new AppError(429, "RATE_LIMITED", "Too many requests for this calendar; try again shortly"); }
    const feed = await db.collection("calendar_feeds").findOne({ tokenHash: hashOf(token) });
    const user = feed ? await db.collection("users").findOne({ _id: feed.userId, workspaceId: feed.workspaceId, status: "active" }) : null;
    const actor = user ? await actorFor(db, { id: String(user._id), email: String(user.email), name: String(user.name) }) : undefined;
    if (!feed || !actor || actor.membership.workspaceId !== feed.workspaceId) throw new AppError(404, "NOT_FOUND", "Calendar not found");
    const now = new Date(); const from = new Date(now.getTime() - 30 * DAY_MS); const to = new Date(now.getTime() + 180 * DAY_MS);
    const events = await db.collection("calendar_events").find({ workspaceId: feed.workspaceId, deletedAt: { $exists: false }, startAt: { $lt: to }, $or: [{ seriesEndAt: null }, { seriesEndAt: { $gt: from } }], $and: [{ $or: [{ organizerId: actor.id }, { "attendees.userId": actor.id }] }] }).sort({ startAt: 1, _id: 1 }).limit(2_000).toArray();
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Venture Studio OS//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Venture Studio", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
    const stamp = icsTime(now);
    let count = 0;
    feed: for (const event of events) {
      const response = event.organizerId === actor.id ? "organizer" : (event.attendees as { userId: string; response: string }[]).find((item) => item.userId === actor.id)?.response;
      if (!canSeeEvent(actor, event) || response === "declined") continue;
      const link = `${appOrigin}/calendar/live?event=${encodeURIComponent(String(event._id))}`;
      // Stamped with the event's last change, so calendar apps see an unchanged event as unchanged.
      const changed = icsTime(new Date(event.updatedAt ?? event.createdAt));
      for (const item of occurrences(timingOf(event), from, to, Math.max(1, Math.min(500, MAX_FEED_ITEMS - count)))) {
        if (++count > MAX_FEED_ITEMS) break feed;
        lines.push("BEGIN:VEVENT", `UID:${event._id}-${item.key.replace(/[^0-9A-Za-z]/g, "")}@venture-studio`, `DTSTAMP:${changed}`, `LAST-MODIFIED:${changed}`, `SEQUENCE:${Math.max(0, Number(event.version ?? 1) - 1)}`,
          ...(event.allDay ? [`DTSTART;VALUE=DATE:${item.startDate!.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${item.endDate!.replaceAll("-", "")}`] : [`DTSTART:${icsTime(item.startAt)}`, `DTEND:${icsTime(item.endAt)}`]),
          `SUMMARY:${icsText(String(event.title))}`, `DESCRIPTION:${icsText([event.description, event.meetingUrl ? `Join: ${event.meetingUrl}` : "", `Open in Venture Studio: ${link}`].filter(Boolean).join("\n\n"))}`,
          ...(event.location ? [`LOCATION:${icsText(String(event.location))}`] : []), `URL:${link}`, `STATUS:${response === "maybe" || response === "pending" ? "TENTATIVE" : "CONFIRMED"}`, "END:VEVENT");
      }
    }
    const labels: Record<string, string> = { task_due: "Due", review: "Review", class: "Class", request_due: "Request due", deal_followup: "Follow up", outcome_review: "Outcome review" };
    for (const item of await layerItems(db, actor, new Set(["tasks", "reviews", "classes", "requests"]), from, to)) {
      if (++count > MAX_FEED_ITEMS) break;
      const start = new Date(item.at);
      lines.push("BEGIN:VEVENT", `UID:${item.id.replace(/[^0-9A-Za-z:_-]/g, "")}@venture-studio`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(new Date(start.getTime() + (item.kind === "class" ? Number.parseInt(item.detail ?? "60", 10) || 60 : 15) * 60_000))}`,
        `SUMMARY:${icsText(`${labels[item.kind] ?? "Item"}: ${item.title}`)}`, `URL:${appOrigin}${item.href}`, "TRANSP:TRANSPARENT", "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    await db.collection("calendar_feeds").updateOne({ _id: feed._id }, { $set: { lastReadAt: now } });
    res.set({ "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "Content-Disposition": 'inline; filename="venture-studio.ics"' });
    res.send(lines.map(fold).join("\r\n") + "\r\n");
  });
  return router;
}

const icsTime = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** RFC 5545 text: backslash, semicolon, comma, and every line break (a lone CR too) escaped; control characters and Unicode line separators dropped. */
const icsText = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029]/g, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n?|\n/g, "\\n");
/** Lines longer than 75 bytes continue on the next line after a space, without splitting a character. */
function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = []; let current = ""; let size = 0;
  for (const character of line) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > (parts.length ? 74 : 75)) { parts.push(current); current = ""; size = 0; }
    current += character; size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
