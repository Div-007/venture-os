export const notificationSnapshotEvent = "vso:notification-snapshot";
export const notificationRefreshEvent = "vso:notification-refresh";

/** Latest inbox poll, shared by the bell, the shell, and the inbox (one poller feeds them all). */
type Snapshot = ReadonlyArray<{ readAt?: string; chatKind?: string; chatId?: string }>;
let latestSnapshot: Snapshot | null = null;
export function publishNotificationSnapshot<T extends { readAt?: string; chatKind?: string; chatId?: string }>(items: T[]) {
  latestSnapshot = items;
  window.dispatchEvent(new CustomEvent(notificationSnapshotEvent, { detail: items }));
}
export function subscribeNotificationSnapshot(listener: () => void) {
  window.addEventListener(notificationSnapshotEvent, listener);
  return () => window.removeEventListener(notificationSnapshotEvent, listener);
}
export const getNotificationUnread = () => latestSnapshot ? latestSnapshot.filter((item) => !item.readAt).length : 0;
export const getNotificationSnapshot = () => latestSnapshot;

type Linkable = { resourceType: string; resourceId: string; chatKind?: "direct" | "channel"; chatId?: string };
/** Where a notification should take the reader: the task, the conversation, or the inbox. */
export function notificationHref(item: Linkable): { href: string; label: string } {
  if (item.resourceType === "task") return { href: `/tasks/live?task=${encodeURIComponent(item.resourceId)}`, label: "Open task" };
  if (item.chatKind === "channel" && item.chatId) return { href: `/channels/live?channel=${encodeURIComponent(item.chatId)}`, label: "Open channel" };
  if (item.chatKind === "direct" && item.chatId) return { href: `/messages/live?with=${encodeURIComponent(item.chatId)}`, label: "Open conversation" };
  if (item.resourceType === "member") return { href: "/admin/live", label: "Open People & access" };
  if (item.resourceType === "opportunity") return { href: `/sales/live/leads?lead=${encodeURIComponent(item.resourceId)}`, label: "Open lead" };
  if (item.resourceType === "draft" || item.resourceType === "sales_draft") return { href: `/sales/live/review?draft=${encodeURIComponent(item.resourceId)}`, label: "Open draft" };
  if (item.resourceType === "activity") return { href: `/sales/live/inbox?reply=${encodeURIComponent(item.resourceId)}`, label: "Open reply" };
  if (item.resourceType === "event") return { href: `/calendar/live?event=${encodeURIComponent(item.resourceId)}`, label: "Open event" };
  if (item.resourceType === "document") return { href: `/knowledge/live?doc=${encodeURIComponent(item.resourceId)}`, label: "Open document" };
  return { href: "/notifications/live", label: "Open inbox" };
}
