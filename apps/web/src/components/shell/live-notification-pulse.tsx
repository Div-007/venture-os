"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Bell, X } from "@/components/ui/icons";
import { dismissToast, toast as showToast } from "@/components/ui/toast";
import { listLiveNotifications, markLiveNotificationsRead, readLiveNotification, snoozeLiveReminder } from "@/lib/studio-api";
import { getNotificationUnread, notificationHref, notificationRefreshEvent, publishNotificationSnapshot, subscribeNotificationSnapshot } from "@/lib/notification-events";
import { isActiveChat } from "@/lib/chat-presence";
import { raiseAlert } from "@/lib/device-alerts";
import { useNotificationNudges } from "@/lib/use-live-realtime";
import { prepareChatAudio } from "@/components/studio/chat-message-effects";
import { MessageIsland, type IslandMessage } from "./message-island";
import { replayAnimation } from "@/lib/motion";

type Notification = Awaited<ReturnType<typeof listLiveNotifications>>[number];
type Toast = { item: Notification; count: number };
const pollMs = 15_000;
// A tab in the background still checks now and then, in case the live connection dropped.
const hiddenPollMs = 60_000;
const alertWindowMs = 10 * 60_000;
// Messages (direct, channels followed, @mentions) go to the notch; everything else to the regular pop-up.
const isMessage = (item: Notification) => Boolean(item.chatKind) && ["message", "channel_message", "mention"].includes(item.type);
const TOAST_ID = "live-notification";
const errorText = (cause: unknown) => describeError(cause, "The action failed. Please try again.");
const reminderId = (item: Notification) => item.type === "reminder" ? item.reminderId ?? (item.resourceType === "reminder" ? item.resourceId : undefined) : undefined;
const sticky = (item: Notification) => item.type === "reminder" || item.type === "deadline_warning";

/** Top-bar bell. Reads the shared inbox snapshot; the badge pops once when the unread count rises. */
export function LiveNotificationBell() {
  const unread = useSyncExternalStore(subscribeNotificationSnapshot, getNotificationUnread, () => 0);
  const badge = useRef<HTMLSpanElement>(null);
  const bell = useRef<HTMLSpanElement>(null);
  const previous = useRef(unread);
  useEffect(() => {
    if (unread > previous.current) { replayAnimation(badge.current, "vso-badge-pop"); replayAnimation(bell.current, "vso-bell-ring"); }
    previous.current = unread;
  }, [unread]);
  return <Link data-notification-bell href="/notifications/live" aria-label={`Open notifications, ${unread}${unread >= 100 ? " or more" : ""} unread`} className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"><span ref={bell} className="grid"><Bell size={18} /></span><span ref={badge} aria-hidden="true" className={clsx("absolute -right-1 -top-0.5 grid h-4 min-w-4 place-items-center rounded-md bg-[var(--color-primary-700)] px-0.5 text-[9px] font-bold leading-none text-white tnum transition-[opacity,transform] duration-200", unread > 0 ? "scale-100 opacity-100" : "scale-75 opacity-0")}>{unread >= 100 ? "99+" : unread || ""}</span></Link>;
}

/** Prefixes the tab title with the unread count, e.g. "(3) Tasks", and keeps it through route changes. */
export function LiveTitleBadge() {
  const unread = useSyncExternalStore(subscribeNotificationSnapshot, getNotificationUnread, () => 0);
  useEffect(() => {
    const strip = (title: string) => title.replace(/^\(\d+\+?\) /, "");
    const apply = () => {
      const next = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${strip(document.title)}` : strip(document.title);
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); document.title = strip(document.title); };
  }, [unread]);
  return null;
}

/**
 * Polls the inbox once for the whole shell, publishes the snapshot (bell, sidebar, inbox), and raises a toast for
 * new notifications. Reminders and deadline warnings stay until handled; other alerts close on their own.
 */
export function LiveNotificationPulse({ userId }: { userId: string }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [island, setIsland] = useState<IslandMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [snoozed, setSnoozed] = useState("");
  const seenIdsRef = useRef<Set<string> | null>(null);
  const pollRef = useRef<() => void>(() => {});
  const inFlightRef = useRef(false);
  const rerunRef = useRef(false);
  const toastRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const openRef = useRef((href: string) => router.push(href));
  useEffect(() => { openRef.current = (href: string) => router.push(href); }, [router]);
  // The server says something new is in my inbox: look now rather than at the next poll (a burst becomes one look).
  const nudgeTimer = useRef(0);
  useNotificationNudges(() => {
    window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => window.dispatchEvent(new Event(notificationRefreshEvent)), 600);
  });
  useEffect(() => () => window.clearTimeout(nudgeTimer.current), []);
  useEffect(() => {
    // A banner clicked while this tab was behind: the notification worker asks the tab to open it, keeping any draft.
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const url = event.data?.type === "venture:open" ? event.data.url : undefined;
      if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return;
      openRef.current(url);
      event.ports[0]?.postMessage({ opened: true });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    // Browsers only allow sound after a click or key press in the page.
    window.addEventListener("pointerdown", prepareChatAudio, { passive: true });
    window.addEventListener("keydown", prepareChatAudio);
    return () => { window.removeEventListener("pointerdown", prepareChatAudio); window.removeEventListener("keydown", prepareChatAudio); };
  }, []);

  useEffect(() => {
    let active = true;
    let lastPoll = 0;
    // A different account starts fresh: its existing unread notices are not new.
    seenIdsRef.current = null;
    async function poll(force = false) {
      if (inFlightRef.current) { if (force) rerunRef.current = true; return; }
      if (!force && document.visibilityState === "hidden" && Date.now() - lastPoll < hiddenPollMs) return;
      inFlightRef.current = true;
      lastPoll = Date.now();
      try {
        let next = await listLiveNotifications();
        if (!active || next.some((item) => item.userId !== userId)) return;
        // Notices for the conversation the member is looking at are already read.
        const viewing = [...new Map(next.filter((item) => !item.readAt && item.chatKind && item.chatId && isActiveChat(item.chatKind, item.chatId)).map((item) => [`${item.chatKind}:${item.chatId}`, { chatKind: item.chatKind!, chatId: item.chatId! }])).values()];
        if (viewing.length) {
          await Promise.all(viewing.map((scope) => markLiveNotificationsRead(scope).catch(() => 0)));
          const readAt = new Date().toISOString();
          next = next.map((item) => !item.readAt && viewing.some((scope) => scope.chatKind === item.chatKind && scope.chatId === item.chatId) ? { ...item, readAt } : item);
          if (!active) return;
        }
        if (seenIdsRef.current) {
          const unseen = next.filter((item) => !item.readAt && !seenIdsRef.current!.has(item.id) && !isActiveChat(item.chatKind, item.chatId));
          const messages = unseen.filter(isMessage);
          if (messages.length) setIsland((current) => [...messages.map((item) => ({ id: item.id, title: item.title, body: item.body, href: notificationHref(item).href, at: item.createdAt })), ...current.filter((shown) => !messages.some((item) => item.id === shown.id))].slice(0, 8));
          if (unseen.length) {
            // A sound and, with the tab behind, a system banner: the newest few, oldest first.
            // Only recent ones: waking a computer from sleep shouldn't replay old news.
            const recent = unseen.filter((notice) => Date.now() - new Date(notice.createdAt).getTime() < alertWindowMs);
            for (const notice of recent.slice(0, 3).reverse()) void raiseAlert({ id: notice.id, title: notice.title, body: notice.body, href: notificationHref(notice).href }, (href) => openRef.current(href));
            const others = unseen.filter((item) => !isMessage(item));
            const item = others.find(sticky) ?? others[0];
            if (item) {
              setToasts((current) => [{ item, count: others.length }, ...current].slice(0, 3));
              setActionError(""); setSnoozed("");
            }
          }
          next.forEach((item) => seenIdsRef.current!.add(item.id));
        } else seenIdsRef.current = new Set(next.map((item) => item.id));
        // Messages read elsewhere (or by opening their chat) leave the notch.
        const read = new Set(next.filter((item) => item.readAt).map((item) => item.id));
        setIsland((current) => current.some((shown) => read.has(shown.id)) ? current.filter((shown) => !read.has(shown.id)) : current);
        publishNotificationSnapshot(next);
      } catch { /* The inbox keeps its last good count; it shows request errors on open. */ }
      finally {
        inFlightRef.current = false;
        // A change made while this poll was in flight may not be in its result; fetch once more.
        if (rerunRef.current && active) { rerunRef.current = false; void poll(true); }
      }
    }
    pollRef.current = () => { void poll(); };
    queueMicrotask(() => { if (active) void poll(true); });
    const interval = window.setInterval(() => { void poll(); }, pollMs);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    // A refresh asked for by an action (mark read, snooze) runs even in a background tab.
    const onRefresh = () => { void poll(true); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(notificationRefreshEvent, onRefresh);
    return () => {
      active = false; window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(notificationRefreshEvent, onRefresh);
    };
  }, [userId]);

  const toast = toasts[0];
  const dismiss = () => {
    const returnFocus = toastRef.current?.contains(document.activeElement);
    setToasts((current) => current.slice(1)); setActionError(""); setSnoozed("");
    if (returnFocus) requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-notification-bell]")?.focus());
  };

  async function markRead(item: Notification) {
    setBusy(true); setActionError("");
    try {
      await readLiveNotification(item.id);
      dismiss(); pollRef.current();
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function snooze(item: Notification, value: string) {
    const id = reminderId(item);
    if (!id || !value) return;
    setBusy(true); setActionError("");
    try {
      await snoozeLiveReminder(id, value === "never" ? "never" : Number(value) as 10 | 20 | 30);
      setSnoozed(value === "never" ? "Reminder cancelled" : `Snoozed for ${value} minutes`);
      window.setTimeout(() => { dismiss(); pollRef.current(); }, 900);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  // Non-reminder alerts close themselves; reminders and deadline warnings wait for an action.
  useEffect(() => {
    if (!toast || sticky(toast.item)) return;
    const timer = window.setTimeout(dismiss, 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!toast) { dismissToast(TOAST_ID); return; }
    const open = notificationHref(toast.item);
    showToast({ id: TOAST_ID, sticky: true, node: <aside ref={toastRef} role="status" aria-label="New in-app notification" className="rounded-xl border border-[var(--color-neutral-200)] bg-white p-4 text-left shadow-[0_12px_34px_rgba(38,38,55,.16)]">
      <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-700)]"><Bell size={17} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[.1em] text-[var(--color-primary-700)]">{toast.count > 1 ? `${toast.count} new notifications` : "New notification"}</p><h2 className="mt-1 break-words text-xs font-semibold text-[var(--color-neutral-800)]">{toast.item.title}</h2><p className="mt-1 line-clamp-3 break-words text-xs leading-5 text-[var(--color-neutral-500)]">{toast.item.body}</p></div><button type="button" onClick={dismiss} aria-label="Dismiss notification" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--color-neutral-400)] transition-colors duration-150 hover:bg-[var(--color-neutral-100)] hover:text-[var(--color-neutral-700)]"><X size={16} /></button></div>
      {actionError && <p role="alert" className="vso-fade-enter mt-3 text-xs text-red-700">{actionError}</p>}
      {snoozed ? <p role="status" className="vso-fade-enter mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--color-success-surface)] px-3 text-[11px] font-semibold text-[var(--color-success-text)]">✓ {snoozed}</p>
        : <div className="mt-3 flex flex-wrap items-center gap-2"><Link href={open.href} onClick={dismiss} className="inline-flex min-h-9 items-center rounded-lg bg-[var(--color-primary-100)] px-3 text-[11px] font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]">{open.label}</Link>{reminderId(toast.item) && <Select aria-label={`Snooze ${toast.item.title}`} disabled={busy} defaultValue="" onChange={(event) => { const value = event.currentTarget.value; event.currentTarget.value = ""; void snooze(toast.item, value); }} className="min-h-9 rounded-lg border border-[var(--color-neutral-200)] bg-white px-2 text-[11px] font-semibold text-[var(--color-neutral-700)]"><option value="">Snooze…</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option><option value="never">Cancel reminder</option></Select>}<button type="button" disabled={busy} onClick={() => void markRead(toast.item)} className="min-h-9 rounded-lg px-2 text-[11px] font-semibold text-[var(--color-neutral-500)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--color-neutral-100)] hover:text-[var(--color-neutral-800)] active:scale-[0.97] disabled:opacity-40">{busy ? "Marking…" : "Mark read"}</button></div>}
    </aside> });
  });

  useEffect(() => () => dismissToast(TOAST_ID), []);

  function openMessage(item: IslandMessage) {
    // Opening a chat shows everything in it, so its other messages leave the notch too.
    const chat = item.href;
    setIsland((current) => current.filter((shown) => shown.href !== chat));
    openRef.current(item.href);
    void readLiveNotification(item.id).then(() => pollRef.current()).catch(() => undefined);
  }
  return <MessageIsland items={island} onOpen={openMessage} onClose={() => setIsland([])} />;
}
