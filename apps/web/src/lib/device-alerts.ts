"use client";

import { useSyncExternalStore } from "react";
import { isChatAudioReady, playChatSound, prepareChatAudio } from "@/components/studio/chat-message-effects";

/**
 * WhatsApp-style alerts while Venture Studio is open: a sound, and a system banner (Windows, macOS, Linux) when the tab
 * isn't the one in front. Both are this browser's choice. Push, for when the site is closed, is separate; when push is on
 * in this browser its notification worker shows the banner instead, so one message never makes two banners.
 */
const BANNERS_KEY = "vso-alert-banners";
const ALERTED_KEY = "vso-alerted";
const WORKER_PATH = "/push-sw.js";
const listeners = new Set<() => void>();
let banners = (() => { try { return typeof window !== "undefined" && window.localStorage.getItem(BANNERS_KEY) === "on"; } catch { return false; } })();

export type AlertPermission = NotificationPermission | "unsupported";
export type DeviceAlert = { id: string; title: string; body: string; href: string };

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
}

export function notificationPermission(): AlertPermission {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** Asks the browser once; it only shows its question after a click. */
export async function askNotificationPermission(): Promise<AlertPermission> {
  if (!notificationsSupported()) return "unsupported";
  const result = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  listeners.forEach((listener) => listener());
  return result;
}

export function setAlertBanners(next: boolean) {
  banners = next;
  try { window.localStorage.setItem(BANNERS_KEY, next ? "on" : "off"); } catch { /* The choice still applies for this visit. */ }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === BANNERS_KEY) { banners = event.newValue === "on"; listener(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/** Whether this browser shows a banner while the site is open: switched on here, and allowed by the browser. */
export function useAlertBanners() {
  const on = useSyncExternalStore(subscribe, () => banners, () => false);
  const permission = useSyncExternalStore(subscribe, notificationPermission, () => "default" as AlertPermission);
  return { on, permission, active: on && permission === "granted" };
}

/** The registered notification worker, if push was ever turned on here; it also shows the page's banners. */
async function notificationWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration("/");
    const script = registration?.active?.scriptURL;
    return registration && script && new URL(script).pathname === WORKER_PATH ? registration : null;
  } catch { return null; }
}

/** Whether push already showed this notice here (it uses the notice id as its tag, as the page does). */
async function alreadyShown(registration: ServiceWorkerRegistration | null, id: string): Promise<boolean> {
  try { return Boolean(registration && (await registration.getNotifications({ tag: id })).length); } catch { return false; }
}

function alreadyAlerted(id: string): boolean {
  try {
    const recent = JSON.parse(window.localStorage.getItem(ALERTED_KEY) ?? "[]") as string[];
    if (recent.includes(id)) return true;
    window.localStorage.setItem(ALERTED_KEY, JSON.stringify([id, ...recent].slice(0, 60)));
  } catch { /* Without storage each tab may alert; the banner tag still collapses repeats. */ }
  return false;
}

/** One tab alerts per notice. The tab in front claims at once; tabs behind wait a moment so it can. */
async function claim(id: string, front: boolean): Promise<boolean> {
  if (!front) await new Promise((resolve) => window.setTimeout(resolve, 400));
  if (navigator.locks?.request) {
    try { return await navigator.locks.request(`vso-alert-${id}`, { ifAvailable: true }, async (lock) => Boolean(lock) && !alreadyAlerted(id)); }
    catch { /* Fall through to storage alone. */ }
  }
  return !alreadyAlerted(id);
}

/**
 * A new notice arrived while the site is open. In front: the in-page pop-up shows it, so only the sound plays. Behind
 * (another tab, minimised): the sound, and a banner that opens the conversation when clicked. Push may show the same
 * notice; both use the notice id as the banner's tag, so there is only ever one banner and one sound.
 */
export async function raiseAlert(alert: DeviceAlert, open: (href: string) => void): Promise<void> {
  const front = document.visibilityState === "visible" && document.hasFocus();
  if (!await claim(alert.id, front)) return;
  if (front) { playChatSound("alert"); return; }
  const banner = banners && notificationPermission() === "granted";
  const registration = await notificationWorker();
  // With banners off here but push on, push shows the banner with its own sound: give it a moment, then stay quiet if it did.
  if (!banner && registration && await registration.pushManager.getSubscription().catch(() => null)) await new Promise((resolve) => window.setTimeout(resolve, 1500));
  if (await alreadyShown(registration, alert.id)) return;
  playChatSound("alert");
  if (!banner) return;
  // The page's own sound plays when it can; the system sound is only used when this tab can't play one yet.
  const options: NotificationOptions = { body: alert.body, tag: alert.id, icon: "/brand/icon-192.png", badge: "/brand/badge-96.png", silent: isChatAudioReady(), data: { url: alert.href } };
  if (registration) {
    // Its clicks go through the notification worker, which opens the conversation in this tab.
    try { await registration.showNotification(alert.title, options); return; } catch { /* Fall back to a page banner. */ }
  }
  try {
    const shown = new Notification(alert.title, options);
    shown.onclick = () => { window.focus(); shown.close(); open(alert.href); };
  } catch { /* The tab title count and the inbox still show it. */ }
}

/** A test alert from the settings: the sound and a banner, even with the tab in front. */
export async function testAlert(): Promise<boolean> {
  await prepareChatAudio();
  playChatSound("alert");
  if (notificationPermission() !== "granted") return false;
  const options: NotificationOptions = { body: "This is how new messages will look on this device.", tag: "vso-test-alert", icon: "/brand/icon-192.png", badge: "/brand/badge-96.png", silent: isChatAudioReady() };
  try { new Notification("Venture Studio", options); return true; }
  catch {
    try { await (await navigator.serviceWorker?.getRegistration("/"))?.showNotification("Venture Studio", options); return true; }
    catch { return false; }
  }
}
