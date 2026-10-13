import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { reminderTransition } from "../src/rules.js";
import { Worker } from "../src/worker.js";
import { loadConfig } from "../src/config.js";

test("production NODE_ENV requires APP_MODE=production and its notification credentials", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /APP_MODE=production/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", APP_MODE: "production" }), /notification credentials/);
  assert.equal(loadConfig({ NODE_ENV: "development" }).APP_MODE, "local");
});

test("an unstarted task repeats on the reminder cadence, independent of delivery retry", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const transition = reminderTransition({ repeatMinutes: 10, sequence: 2 }, { status: "accepted" }, now);
  assert.equal(transition.state, "scheduled");
  assert.equal(transition.nextAt?.toISOString(), "2026-09-23T10:10:00.000Z");
  assert.equal(transition.nextSequence, 3);
});

test("starting or completing a task ends its reminder recurrence", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  assert.equal(reminderTransition({ repeatMinutes: 10, sequence: 0 }, { startedAt: now }, now).state, "completed");
  assert.equal(reminderTransition({ repeatMinutes: null, sequence: 0 }, null, now).state, "completed");
});

test("real Mongo replica-set smoke: reminder claim, recurrence, outbox idempotency, and delivery retry", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  const client = new MongoClient(process.env.TEST_MONGODB_URI!);
  await client.connect();
  const dbName = `venture_studio_worker_test_${process.pid}_${Date.now()}`;
  assert.match(dbName, /^venture_studio_worker_test_/);
  const db = client.db(dbName);
  const collection = (name: string) => db.collection<Record<string, any> & { _id: string }>(name);
  const now = new Date("2026-09-23T10:00:00.000Z");
  const config = { APP_MODE: "local" as const, MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DB: dbName, WORKER_ID: "worker-test", POLL_MS: 100, EMAIL_FROM: "Venture Studio <noreply@example.invalid>", VAPID_SUBJECT: "mailto:admin@example.invalid" };
  try {
    await collection("notification_outbox").createIndex({ idempotencyKey: 1 }, { unique: true });
    await collection("notifications").createIndex({ outboxId: 1 }, { unique: true });
    await collection("users").insertOne({ _id: "user-a", workspaceId: "workspace-a", status: "active", email: "a@example.invalid" });
    await collection("channels").insertOne({ _id: "channel-a", workspaceId: "workspace-a", ventureId: "venture-a", groupId: "group-a" });
    await collection("memberships").insertOne({ _id: "membership-a", workspaceId: "workspace-a", userId: "user-a", role: "contributor", ventureIds: ["venture-a"], groupIds: ["group-a"], status: "active" });
    await collection("messages").insertOne({ _id: "legacy-channel-message", workspaceId: "workspace-a", channelId: "channel-a" });
    await collection("tasks").insertOne({ _id: "task-a", workspaceId: "workspace-a", assigneeId: "user-a", status: "accepted", deadlineRisk: false });
    await collection("reminders").insertOne({ _id: "reminder-a", workspaceId: "workspace-a", userId: "user-a", taskId: "task-a", message: "Start work", scheduledAt: now, repeatMinutes: 10, sequence: 0, state: "scheduled", createdAt: now, updatedAt: now });
    const worker = new Worker(client, db, config, true);
    assert.equal(await worker.tick(now), true);
    const reminder = await collection("reminders").findOne({ _id: "reminder-a" });
    assert.equal(reminder?.state, "scheduled");
    assert.equal(reminder?.scheduledAt.toISOString(), "2026-09-23T10:10:00.000Z");
    assert.equal(await collection("notification_outbox").countDocuments({ idempotencyKey: "reminder:reminder-a:0" }), 1);
    assert.equal((await collection("notification_outbox").findOne({ idempotencyKey: "reminder:reminder-a:0" }))?.reminderId, "reminder-a");
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ idempotencyKey: "reminder:reminder-a:0" }))?.state, "delivered");
    assert.equal(await collection("notifications").countDocuments({ outboxId: { $exists: true } }), 1);
    assert.equal((await collection("notifications").findOne({ outboxId: { $exists: true } }))?.reminderId, "reminder-a");
    await collection("notification_outbox").insertOne({ _id: "outbox-fail", workspaceId: "workspace-a", userId: "missing-user", type: "message", title: "Fail", body: "Fail", resourceType: "message", resourceId: "message-a", idempotencyKey: "failure-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    const failed = await collection("notification_outbox").findOne({ _id: "outbox-fail" });
    assert.equal(failed?.state, "pending");
    assert.equal(failed?.attempts, 1);
    assert.equal(failed?.nextAttemptAt.toISOString(), "2026-09-23T10:01:00.000Z");

    await collection("tasks").insertOne({ _id: "task-terminal", workspaceId: "workspace-a", status: "done", completedAt: now });
    await collection("reminders").insertOne({ _id: "reminder-terminal", workspaceId: "workspace-a", userId: "user-a", taskId: "task-terminal", message: "Do not send", scheduledAt: now, repeatMinutes: 10, sequence: 0, state: "scheduled", createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("reminders").findOne({ _id: "reminder-terminal" }))?.completionReason, "task_terminal");
    assert.equal(await collection("notification_outbox").countDocuments({ idempotencyKey: "reminder:reminder-terminal:0" }), 0);

    await collection("reminders").insertOne({ _id: "reminder-expired", workspaceId: "workspace-a", userId: "user-a", taskId: "task-a", message: "Recovered", scheduledAt: now, repeatMinutes: null, sequence: 0, state: "claimed", claimedBy: "dead-worker", leaseUntil: new Date(now.getTime() - 1), createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("reminders").findOne({ _id: "reminder-expired" }))?.state, "completed");
    assert.equal(await collection("notification_outbox").countDocuments({ idempotencyKey: "reminder:reminder-expired:0" }), 1);
    assert.equal(await worker.tick(now), true);

    await collection("notification_preferences").insertOne({ _id: "preferences-a", workspaceId: "workspace-a", userId: "user-a", reminders: false, messages: false, email: true, webPush: true });
    await collection("notification_outbox").insertOne({ _id: "outbox-muted", workspaceId: "workspace-a", userId: "user-a", type: "reminder", title: "Muted", body: "Muted", resourceType: "task", resourceId: "task-a", idempotencyKey: "muted-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ _id: "outbox-muted" }))?.state, "delivered");
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-muted" }), 0);
    await collection("notification_outbox").insertOne({ _id: "outbox-message-muted", workspaceId: "workspace-a", userId: "user-a", type: "message", title: "DM", body: "Muted DM", resourceType: "message", resourceId: "message-a", chatKind: "direct", chatId: "user-b", idempotencyKey: "muted-message-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-message-muted" }), 0);
    // A current DM notice bypasses the legacy-message lookup, so this proves the muted preference rather than a scope skip.
    assert.ok((await collection("notification_outbox").findOne({ _id: "outbox-message-muted" }))?.delivery?.categorySkippedAt);
    // A channel followed for every message has no account-wide switch: the channel's own choice already said yes.
    await collection("channel_notification_settings").insertOne({ _id: "level-a", workspaceId: "workspace-a", userId: "user-a", channelId: "channel-a", level: "all" });
    await collection("notification_outbox").insertOne({ _id: "outbox-followed-channel", workspaceId: "workspace-a", userId: "user-a", type: "channel_message", title: "Ann in #general", body: "Standup at 11", resourceType: "message", resourceId: "followed-message", chatKind: "channel", chatId: "channel-a", idempotencyKey: "followed-channel-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-followed-channel" }), 1);
    // Turned off while notices waited: neither the queued channel message nor a queued @mention is delivered.
    await collection("channel_notification_settings").updateOne({ _id: "level-a" }, { $set: { level: "off" } });
    await collection("notification_outbox").insertMany([
      { _id: "outbox-after-off", workspaceId: "workspace-a", userId: "user-a", type: "channel_message", title: "Ann in #general", body: "Later", resourceType: "message", resourceId: "later-message", chatKind: "channel", chatId: "channel-a", idempotencyKey: "after-off-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now },
      { _id: "outbox-mention-after-off", workspaceId: "workspace-a", userId: "user-a", type: "mention", title: "Ann mentioned you in #general", body: "Later", resourceType: "message", resourceId: "later-mention", chatKind: "channel", chatId: "channel-a", idempotencyKey: "mention-after-off-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now },
    ]);
    assert.equal(await worker.tick(now), true);
    assert.equal(await worker.tick(now), true);
    assert.equal(await collection("notifications").countDocuments({ outboxId: { $in: ["outbox-after-off", "outbox-mention-after-off"] } }), 0);
    assert.ok((await collection("notification_outbox").findOne({ _id: "outbox-after-off" }))?.delivery?.levelSkippedAt);
    await collection("channel_notification_settings").deleteOne({ _id: "level-a" });

    await collection("notification_preferences").updateOne({ _id: "preferences-a" }, { $set: { messages: true, mentions: true } });
    await collection("memberships").updateOne({ _id: "membership-a" }, { $set: { groupIds: [] } });
    await collection("notification_outbox").insertMany([
      { _id: "outbox-revoked-channel", workspaceId: "workspace-a", userId: "user-a", type: "message", title: "Channel update", body: "Open channel", resourceType: "message", resourceId: "new-channel-message", chatKind: "channel", chatId: "channel-a", idempotencyKey: "revoked-channel-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now },
      { _id: "outbox-revoked-legacy", workspaceId: "workspace-a", userId: "user-a", type: "mention", title: "Old mention", body: "Private text", resourceType: "message", resourceId: "legacy-channel-message", idempotencyKey: "revoked-legacy-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now },
    ]);
    assert.equal(await worker.tick(now), true);
    assert.equal(await worker.tick(now), true);
    assert.equal(await collection("notifications").countDocuments({ outboxId: { $in: ["outbox-revoked-channel", "outbox-revoked-legacy"] } }), 0);
    assert.ok((await collection("notification_outbox").findOne({ _id: "outbox-revoked-channel" }))?.delivery?.scopeSkippedAt);
    assert.ok((await collection("notification_outbox").findOne({ _id: "outbox-revoked-legacy" }))?.delivery?.scopeSkippedAt);

    // Knowledge notices reach only people who can still read the document, requests only people who can still approve
    // them, and no preference switch mutes them.
    await collection("notification_preferences").updateOne({ _id: "preferences-a" }, { $set: { assignments: false } });
    await collection("documents").insertMany([
      { _id: "document-request", workspaceId: "workspace-a", ownerId: "user-z", status: "draft", sensitivity: "team", review: { state: "pending", requestedBy: "user-z" } },
      { _id: "document-manager", workspaceId: "workspace-a", ownerId: "user-z", status: "draft", sensitivity: "manager", review: { state: "pending", requestedBy: "user-z" } },
    ]);
    const knowledgeNotice = (id: string, documentId: string) => ({ _id: id, workspaceId: "workspace-a", userId: "user-a", type: "knowledge_request", title: "Share with all ventures?", body: "Review it", resourceType: "document", resourceId: documentId, idempotencyKey: `${id}-test`, state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    await collection("notification_outbox").insertOne(knowledgeNotice("outbox-not-approver", "document-request"));
    assert.equal(await worker.tick(now), true);
    assert.ok((await collection("notification_outbox").findOne({ _id: "outbox-not-approver" }))?.delivery?.scopeSkippedAt);
    await collection("memberships").updateOne({ _id: "membership-a" }, { $set: { canShareKnowledge: true } });
    await collection("notification_outbox").insertMany([knowledgeNotice("outbox-approver", "document-request"), knowledgeNotice("outbox-unreadable", "document-manager")]);
    assert.equal(await worker.tick(now), true);
    assert.equal(await worker.tick(now), true);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-approver" }), 1, "muting assignments doesn't hide a request");
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-unreadable" }), 0, "a contributor can't read a manager document");
    assert.ok((await collection("notification_outbox").findOne({ _id: "outbox-unreadable" }))?.delivery?.scopeSkippedAt);
    await collection("memberships").updateOne({ _id: "membership-a" }, { $unset: { canShareKnowledge: "" } });
    await collection("notification_preferences").updateOne({ _id: "preferences-a" }, { $set: { assignments: true } });

    await collection("notification_outbox").insertOne({ _id: "outbox-dead", workspaceId: "workspace-a", userId: "missing-user", type: "message", title: "Dead", body: "Dead", resourceType: "message", resourceId: "message-a", idempotencyKey: "dead-test", state: "pending", attempts: 7, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ _id: "outbox-dead" }))?.state, "dead");

    await collection("notification_preferences").updateOne({ _id: "preferences-a" }, { $set: { reminders: true, messages: true } });
    await collection("notification_outbox").insertOne({ _id: "outbox-race", workspaceId: "workspace-a", userId: "user-a", type: "reminder", title: "Race", body: "Race", resourceType: "task", resourceId: "task-a", idempotencyKey: "race-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    const competitor = new Worker(client, db, { ...config, WORKER_ID: "worker-competitor" }, true);
    const claims = await Promise.all([worker.tick(now), competitor.tick(now)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-race" }), 1);
    await collection("notification_outbox").insertOne({ _id: "outbox-stale-risk", workspaceId: "workspace-a", userId: "user-a", type: "deadline_warning", title: "Risk", body: "Risk", resourceType: "task", resourceId: "task-a", idempotencyKey: "stale-risk-test", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ _id: "outbox-stale-risk" }))?.state, "cancelled");
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-stale-risk" }), 0);
    await collection("tasks").updateOne({ _id: "task-a" }, { $set: { startedAt: now } });
    await collection("notification_outbox").insertOne({ _id: "outbox-stale-reminder", workspaceId: "workspace-a", userId: "user-a", type: "reminder", title: "Start", body: "Start", resourceType: "task", resourceId: "task-a", reminderId: "reminder-a", idempotencyKey: "reminder:reminder-a:99", state: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now });
    assert.equal(await worker.tick(now), true);
    assert.equal((await collection("notification_outbox").findOne({ _id: "outbox-stale-reminder" }))?.state, "cancelled");
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-stale-reminder" }), 0);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});

test("calendar reminders: planned ahead, kept through small edits, never repeated, dropped when the date moves or access ends", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  const client = new MongoClient(process.env.TEST_MONGODB_URI!);
  await client.connect();
  const dbName = `venture_studio_worker_test_${process.pid}_${Date.now()}_calendar`;
  assert.match(dbName, /^venture_studio_worker_test_/);
  const db = client.db(dbName);
  const collection = (name: string) => db.collection<Record<string, any> & { _id: string }>(name);
  const config = { APP_MODE: "local" as const, MONGODB_URI: process.env.TEST_MONGODB_URI!, MONGODB_DB: dbName, WORKER_ID: "worker-calendar", POLL_MS: 100, EMAIL_FROM: "Venture Studio <noreply@example.invalid>", VAPID_SUBJECT: "mailto:admin@example.invalid" };
  try {
    await collection("notification_outbox").createIndex({ idempotencyKey: 1 }, { unique: true });
    await collection("notifications").createIndex({ outboxId: 1 }, { unique: true });
    for (const id of ["user-o", "user-a", "user-d"]) {
      await collection("users").insertOne({ _id: id, workspaceId: "workspace-a", status: "active", email: `${id}@example.invalid` });
      await collection("memberships").insertOne({ _id: `membership-${id}`, workspaceId: "workspace-a", userId: id, role: "member", status: "active", ventureIds: ["venture-a"], groupIds: ["group-a"] });
    }
    // Weekly on Mondays at 10:00 in Kolkata (04:30 UTC) on venture A's calendar; one person going, one declined.
    await collection("calendar_events").insertOne({ _id: "event-sync", workspaceId: "workspace-a", title: "Weekly sync", visibility: "venture", ventureId: "venture-a", organizerId: "user-o", allDay: false, startAt: new Date("2026-10-12T04:30:00Z"), endAt: new Date("2026-10-12T05:00:00Z"), timezone: "Asia/Kolkata", recurrence: { freq: "weekly", interval: 1 }, exdates: [], seriesEndAt: null, attendees: [{ userId: "user-a", response: "going" }, { userId: "user-d", response: "declined" }], defaultReminders: [10], reminderPrefs: [], color: "green", version: 1, createdAt: new Date(), updatedAt: new Date() });
    const worker = new Worker(client, db, config, true);
    const now = new Date("2026-10-12T04:00:00Z");
    assert.equal(await worker.planEventReminders(now), 2);
    assert.equal(await worker.planEventReminders(now), 0, "planning again adds nothing");
    assert.deepEqual((await collection("reminders").find({ eventId: "event-sync" }).toArray()).map((item) => item.userId).sort(), ["user-a", "user-o"]);
    // A title fix before they fire changes nothing about them: both go out, worded with the new title.
    await collection("calendar_events").updateOne({ _id: "event-sync" }, { $set: { title: "Weekly team sync", version: 2 } });
    const dueAt = new Date("2026-10-12T04:20:00Z");
    assert.equal(await worker.tick(dueAt), true);
    assert.equal(await worker.tick(dueAt), true);
    const delivered = await collection("notification_outbox").find({ resourceType: "event" }).toArray();
    assert.deepEqual(delivered.map((item) => item.body), ["Weekly team sync starts in 10 minutes", "Weekly team sync starts in 10 minutes"]);
    assert.equal(delivered[0]?.resourceId, "event-sync");
    // Planning after the edit never sends a delivered reminder again.
    assert.equal(await worker.planEventReminders(new Date("2026-10-12T04:22:00Z")), 0);
    // Next week: user-a has left the venture, so only the organiser is planned for, and a reminder already planned for
    // user-a is dropped at delivery.
    assert.equal(await worker.planEventReminders(new Date("2026-10-17T04:00:00Z")), 2);
    await collection("memberships").updateOne({ _id: "membership-user-a" }, { $set: { ventureIds: [] } });
    const nextDue = new Date("2026-10-19T04:20:00Z");
    assert.equal(await worker.tick(nextDue), true);
    assert.equal(await worker.tick(nextDue), true);
    assert.equal(await collection("reminders").countDocuments({ eventId: "event-sync", userId: "user-a", state: "cancelled", cancelReason: "no_access" }), 1);
    assert.equal(await collection("notification_outbox").countDocuments({ resourceType: "event" }), 3);
    assert.equal(await worker.planEventReminders(new Date("2026-10-24T04:00:00Z")), 1);
    // The series moves to 11:00: the reminder planned for 10:00 is dropped instead of sent.
    await collection("calendar_events").updateOne({ _id: "event-sync" }, { $set: { startAt: new Date("2026-10-12T05:30:00Z"), endAt: new Date("2026-10-12T06:00:00Z"), version: 3 } });
    assert.equal(await worker.tick(new Date("2026-10-26T04:20:00Z")), true);
    assert.equal(await collection("reminders").countDocuments({ eventId: "event-sync", state: "cancelled", cancelReason: "event_changed" }), 1);
    assert.equal(await collection("notification_outbox").countDocuments({ resourceType: "event" }), 3);
    // A notice about an event goes only to someone who can still open it.
    await collection("notification_outbox").insertOne({ _id: "outbox-update-a", workspaceId: "workspace-a", userId: "user-a", type: "event_update", title: "Updated: Weekly team sync", body: "changed", resourceType: "event", resourceId: "event-sync", idempotencyKey: "event:event-sync:v3:update:user-a", state: "pending", attempts: 0, nextAttemptAt: new Date("2026-10-26T04:20:00Z"), createdAt: new Date(), updatedAt: new Date() });
    // Earlier notices are still queued ahead of it; deliver everything due.
    for (let round = 0; round < 10 && await worker.tick(new Date("2026-10-26T04:21:00Z")); round++);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-update-a" }), 0);
    assert.ok((await collection("notification_outbox").findOne({ _id: "outbox-update-a" }))?.delivery?.scopeSkippedAt);
    // A private event's queued invitation isn't delivered to someone taken off its list before it went out.
    await collection("calendar_events").insertOne({ _id: "event-private", workspaceId: "workspace-a", title: "1:1", visibility: "private", organizerId: "user-o", allDay: false, startAt: new Date("2026-11-02T04:30:00Z"), endAt: new Date("2026-11-02T05:00:00Z"), timezone: "UTC", recurrence: null, exdates: [], seriesEndAt: new Date("2026-11-02T05:00:00Z"), attendees: [], defaultReminders: [10], reminderPrefs: [], color: "green", version: 2, createdAt: new Date(), updatedAt: new Date() });
    await collection("notification_outbox").insertOne({ _id: "outbox-invite-d", workspaceId: "workspace-a", userId: "user-d", type: "event_invite", title: "Invitation: 1:1", body: "invited", resourceType: "event", resourceId: "event-private", idempotencyKey: "event:event-private:invite:user-d", state: "pending", attempts: 0, nextAttemptAt: new Date("2026-10-26T04:20:00Z"), createdAt: new Date(), updatedAt: new Date() });
    for (let round = 0; round < 10 && await worker.tick(new Date("2026-10-26T04:22:00Z")); round++);
    assert.equal(await collection("notifications").countDocuments({ outboxId: "outbox-invite-d" }), 0);
    // A reminder left from an earlier id scheme for the same moment is superseded instead of sent a second time.
    await collection("reminders").insertOne({ _id: "evrem_legacy", workspaceId: "workspace-a", userId: "user-o", kind: "event", eventId: "event-sync", eventVersion: 1, occurrenceKey: "2026-11-02T05:30:00.000Z", occurrenceStart: new Date("2026-11-02T05:30:00Z"), minutes: 10, scheduledAt: new Date("2026-11-02T05:20:00Z"), state: "scheduled", sequence: 0, createdAt: new Date(), updatedAt: new Date() });
    for (let round = 0; round < 10 && await worker.tick(new Date("2026-11-02T05:20:00Z")); round++);
    assert.equal((await collection("reminders").findOne({ _id: "evrem_legacy" }))?.cancelReason, "superseded");
    assert.equal(await collection("notification_outbox").countDocuments({ reminderId: "evrem_legacy" }), 0);
    assert.equal(await collection("notification_outbox").countDocuments({ resourceId: "event-sync", type: "reminder", userId: "user-o", body: /starts in 10 minutes/, createdAt: new Date("2026-11-02T05:20:00Z") }), 1);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
