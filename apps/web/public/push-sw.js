const opaqueId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const ALLOWED_PATHS = ["/tasks/live", "/notifications/live", "/messages/live", "/channels/live", "/calendar/live"];
/** Sales opens on its own screens: /sales/live and every tab under it (review, inbox, leads, calls…). */
const isSalesPath = (pathname) => pathname === "/sales/live" || /^\/sales\/live\/[a-z-]+$/.test(pathname);
const allowedPath = (pathname) => ALLOWED_PATHS.includes(pathname) || isSalesPath(pathname);
/** A same-site path under /sales/live carried by the notice itself (path and query only), or "". */
function salesUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/sales/live") || value.startsWith("//")) return "";
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && isSalesPath(url.pathname) ? url.pathname + url.search : "";
  } catch { return ""; }
}

// This worker only shows notifications, so a new version can take over at once.
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

/** Where a notice opens: its conversation, task, event, or Sales screen (lead, draft, reply); otherwise the inbox. */
function noticeUrl(notice) {
  const sales = salesUrl(notice?.url);
  if (sales) return sales;
  if (notice?.chatKind === "channel" && opaqueId(notice.chatId)) return `/channels/live?channel=${encodeURIComponent(notice.chatId)}`;
  if (notice?.chatKind === "direct" && opaqueId(notice.chatId)) return `/messages/live?with=${encodeURIComponent(notice.chatId)}`;
  if (notice?.resourceType === "task" && opaqueId(notice.resourceId)) return `/tasks/live?task=${encodeURIComponent(notice.resourceId)}`;
  if (notice?.resourceType === "event" && opaqueId(notice.resourceId)) return `/calendar/live?event=${encodeURIComponent(notice.resourceId)}`;
  if (notice?.resourceType === "opportunity" && opaqueId(notice.resourceId)) return `/sales/live/leads?lead=${encodeURIComponent(notice.resourceId)}`;
  if ((notice?.resourceType === "draft" || notice?.resourceType === "sales_draft") && opaqueId(notice.resourceId)) return `/sales/live/review?draft=${encodeURIComponent(notice.resourceId)}`;
  if (notice?.resourceType === "activity" && opaqueId(notice.resourceId)) return `/sales/live/inbox?reply=${encodeURIComponent(notice.resourceId)}`;
  return "/notifications/live";
}

/**
 * The push carries only an id. The text comes from the inbox, read with this browser's own sign-in, so a browser now
 * signed in as someone else (or signed out) shows only a generic notice.
 */
async function readNotice(id) {
  if (!opaqueId(id)) return null;
  try {
    // A slow or unreachable server falls back to the generic notice rather than delaying it.
    const response = await fetch(`/v1/notifications/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok && body.data ? body.data : null;
  } catch { return null; }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* A malformed payload still gets a visible notice. */ }
  if (!payload || typeof payload !== "object") payload = {};
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) => new URL(client.url).origin === self.location.origin);
    // With the site in front, the page itself shows a pop-up and plays its sound.
    if (windows.some((client) => client.focused)) return;
    const notice = await readNotice(payload.notificationId);
    const tag = opaqueId(payload.notificationId) ? payload.notificationId : undefined;
    await self.registration.showNotification(notice?.title || "Venture Studio update", {
      body: notice ? String(notice.body || "").slice(0, 300) : "Open your inbox to view the latest update.",
      tag,
      icon: "/brand/icon-192.png",
      badge: "/brand/badge-96.png",
      // A tab someone is looking at plays the app's own sound; otherwise (behind, frozen, or closed) the system sound plays.
      silent: windows.some((client) => client.visibilityState === "visible"),
      // A push may name its Sales screen itself (url: "/sales/live/..."); otherwise the notice decides.
      data: { url: salesUrl(payload.url) || (notice ? noticeUrl(notice) : "/notifications/live") },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.url;
  let target = new URL(typeof path === "string" ? path : "/notifications/live", self.location.origin);
  if (target.origin !== self.location.origin || !allowedPath(target.pathname)) target = new URL("/notifications/live", self.location.origin);
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter((client) => new URL(client.url).origin === target.origin);
    const existing = windows.find((client) => client.focused) ?? windows.find((client) => client.visibilityState === "visible") ?? windows[0];
    if (existing) {
      await existing.focus().catch(() => undefined);
      // Opening it inside the app keeps an unsent draft; a tab from before this version is navigated instead.
      const opened = await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 600);
        channel.port1.onmessage = () => { clearTimeout(timer); channel.port1.close(); resolve(true); };
        try { existing.postMessage({ type: "venture:open", url: target.pathname + target.search }, [channel.port2]); }
        catch { clearTimeout(timer); channel.port1.close(); resolve(false); }
      });
      if (opened) return;
      try {
        const navigated = await existing.navigate(target.href);
        await (navigated ?? existing).focus();
        return;
      } catch { /* A closed tab can fail navigation; open a fresh one below. */ }
    }
    await self.clients.openWindow(target.href);
  })());
});
