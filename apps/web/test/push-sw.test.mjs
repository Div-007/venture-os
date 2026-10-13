import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";

const source = readFileSync(new URL("../public/push-sw.js", import.meta.url), "utf8");

function worker(windows = []) {
  const handlers = new Map();
  const notices = [];
  const opened = [];
  const self = {
    location: { origin: "https://studio.example" },
    registration: { showNotification: async (title, options) => { notices.push({ title, ...options }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); },
    },
    addEventListener: (name, handler) => { handlers.set(name, handler); },
  };
  runInNewContext(source, { self, URL, encodeURIComponent, MessageChannel, setTimeout, clearTimeout });
  return { handlers, notices, opened };
}

test("push never displays private payload text or routes across accounts", async () => {
  const { handlers, notices, opened } = worker();
  const push = handlers.get("push");
  const click = handlers.get("notificationclick");
  for (const payload of [
    { title: "Private task", body: "Confidential details", resourceType: "task", resourceId: "task_123" },
    { title: "Private reminder", body: "Confidential details", resourceType: "reminder", resourceId: "reminder_456" },
    { title: "Unsafe", resourceType: "task", resourceId: "https://elsewhere.test" },
  ]) {
    let done;
    push({ data: { json: () => payload }, waitUntil: (promise) => { done = promise; } });
    await done;
    const notice = notices.at(-1);
    assert.equal(notice.title, "Venture Studio update");
    assert.equal(notice.body, "Open your inbox to view the latest update.");
    assert.equal(notice.data.url, "/notifications/live");
    let closed = false;
    click({ notification: { data: notice.data, close: () => { closed = true; } }, waitUntil: (promise) => { done = promise; } });
    await done;
    assert.equal(closed, true);
    assert.equal(opened.at(-1), "https://studio.example/notifications/live");
  }
});

test("malformed push data still shows an inbox notice", async () => {
  const { handlers, notices } = worker();
  let done;
  handlers.get("push")({ data: { json: () => { throw new Error("bad json"); } }, waitUntil: (promise) => { done = promise; } });
  await done;
  assert.equal(notices[0].title, "Venture Studio update");
  assert.equal(notices[0].data.url, "/notifications/live");
});

test("focused active chat suppresses push; an inactive chat receives it", async () => {
  let active = true;
  const client = { focused: true, url: "https://studio.example/channels/live", postMessage: (_message, ports) => { ports[0].postMessage({ active }); ports[0].close(); } };
  const { handlers, notices } = worker([client]);
  const push = handlers.get("push");
  let done;
  const payload = { notificationId: "notice-1", chat: { kind: "channel", id: "channel-a" } };
  push({ data: { json: () => payload }, waitUntil: (promise) => { done = promise; } });
  await done;
  assert.equal(notices.length, 0);
  active = false;
  push({ data: { json: () => payload }, waitUntil: (promise) => { done = promise; } });
  await done;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].data.url, "/notifications/live");
});
