"use client";

import { registerLivePushSubscription } from "@/lib/studio-api";

/** Push: notifications that reach this browser while Venture Studio is closed, through the notification worker. */
const WORKER_PATH = "/push-sw.js";

export function pushSupported() {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function publicKeyBytes(key: string) {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function existingPushRegistration() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const script = registration?.active?.scriptURL ?? registration?.waiting?.scriptURL ?? registration?.installing?.scriptURL;
  return script && new URL(script).pathname === WORKER_PATH ? registration : null;
}

/** Subscribes this browser and tells the server whose it is. Notification permission must already be granted. */
export async function turnOnPush(publicKey: string): Promise<void> {
  let newlyCreated: PushSubscription | null = null;
  try {
    const other = await navigator.serviceWorker.getRegistration("/");
    const otherScript = other?.active?.scriptURL ?? other?.waiting?.scriptURL ?? other?.installing?.scriptURL;
    if (otherScript && new URL(otherScript).pathname !== WORKER_PATH) throw new Error("This browser session is using a different notification service. Notifications were not turned on.");
    await navigator.serviceWorker.register(WORKER_PATH, { scope: "/" });
    const ready = await navigator.serviceWorker.ready;
    const current = await ready.pushManager.getSubscription();
    const subscription = current ?? await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(publicKey) });
    if (!current) newlyCreated = subscription;
    await registerLivePushSubscription(subscription);
  } catch (cause) {
    if (newlyCreated) await newlyCreated.unsubscribe().catch(() => false);
    throw cause;
  }
}
