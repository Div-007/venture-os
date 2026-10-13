"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useState, type ReactNode } from "react";
import { BellRing } from "@/components/ui/icons";
import { getLivePushConfig, registerLivePushSubscription, unregisterLivePushSubscription } from "@/lib/studio-api";
import { existingPushRegistration, pushSupported, turnOnPush } from "@/lib/web-push";
import clsx from "clsx";
import { Notice, secondaryClass } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { askNotificationPermission, notificationsSupported, setAlertBanners, testAlert, useAlertBanners } from "@/lib/device-alerts";
import { prepareChatAudio, setChatSoundMuted, useChatSoundMuted } from "@/components/studio/chat-message-effects";

type PushState = "checking" | "unavailable" | "unsupported" | "ready" | "enabled" | "error";
const errorText = (cause: unknown) => describeError(cause, "Notifications could not be updated.");

/** iPhones and iPads only allow notifications for the site added to the Home Screen and opened from there. */
function needsHomeScreen() {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return apple && !installed;
}


function SwitchRow({ label, detail, checked, disabled, onChange }: { label: string; detail: ReactNode; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <label className={clsx("flex min-h-12 items-center justify-between gap-3 rounded-xl bg-neutral-50 px-3 py-2 transition-colors duration-150", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-neutral-100")}>
    <span className="min-w-0"><span className="block text-sm font-semibold text-neutral-700">{label}</span><span className="block text-xs leading-5 text-neutral-500">{detail}</span></span>
    <input type="checkbox" role="switch" className="vso-toggle shrink-0" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

/**
 * How this browser tells me about new messages: a banner and a sound while Venture Studio is open (another tab, or
 * minimised), and push when it is closed. The account-wide preferences above still decide what counts.
 */
export function LiveWebPush({ preferenceEnabled }: { preferenceEnabled?: boolean }) {
  const banners = useAlertBanners();
  const muted = useChatSoundMuted();
  const [push, setPush] = useState<PushState>("checking");
  const [publicKey, setPublicKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [homeScreen, setHomeScreen] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setHomeScreen(needsHomeScreen()); });
    queueMicrotask(() => getLivePushConfig().then(async (config) => {
      if (!active) return;
      if (!config.available || !config.publicKey) { setPush("unavailable"); return; }
      setPublicKey(config.publicKey);
      if (!pushSupported()) { setPush("unsupported"); return; }
      const registration = await existingPushRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!active) return;
      if (subscription && Notification.permission === "granted") {
        // A browser subscription survives sign-out; the server must confirm its current owner.
        try { await registerLivePushSubscription(subscription); }
        catch (cause) { throw new Error("Could not reconnect notifications to your account: " + errorText(cause)); }
        if (active) setPush("enabled");
      } else setPush("ready");
    }).catch((cause: unknown) => { if (active) { setError(errorText(cause)); setPush("error"); } }));
    return () => { active = false; };
  }, [revision]);

  async function allowed(): Promise<boolean> {
    const permission = await askNotificationPermission();
    if (permission === "granted") return true;
    setError(permission === "denied" ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again." : "Notifications weren't allowed.");
    return false;
  }

  async function changeBanners(next: boolean) {
    setError("");
    if (next && !await allowed()) return;
    setAlertBanners(next);
  }

  async function enablePush() {
    if (busy || !publicKey || !pushSupported()) return;
    setBusy(true); setError("");
    try {
      if (!await allowed()) return;
      await turnOnPush(publicKey);
      setPush("enabled");
      toast({ title: "Notifications on when closed", body: "Messages will reach this device even when Venture Studio isn't open." });
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function disablePush() {
    if (busy || !pushSupported()) return;
    setBusy(true); setError("");
    try {
      const registration = await existingPushRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await unregisterLivePushSubscription(subscription.endpoint);
        if (!await subscription.unsubscribe()) throw new Error("This browser could not finish turning off notifications. Check this site's notification settings in your browser.");
      }
      setPush("ready");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  const permission = banners.permission;
  const status = permission === "unsupported" ? "This browser can't show notifications."
    : permission === "denied" ? "Blocked for this site. Allow notifications in your browser's site settings to use banners and push."
    : permission === "granted" ? "Allowed in this browser." : "Your browser will ask the first time you turn one on.";
  const pushDetail = push === "unavailable" ? "Not set up for this workspace yet."
    : push === "unsupported" ? (homeScreen ? "Add Venture Studio to your Home Screen first (see below)." : "Not supported in this browser.")
    : push === "error" ? "Couldn't check this browser. Try again in a moment."
    : "Push notifications, even with every tab closed (and banners while it is in the background).";

  return <div className="space-y-3 p-4">
    <div className="flex items-start gap-2"><span className="relative mt-0.5 shrink-0"><BellRing size={17} className="text-primary-700" /><span aria-hidden="true" className={clsx("absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-white transition-[background-color,transform] duration-300", permission === "granted" ? "scale-100 bg-success" : permission === "denied" ? "scale-100 bg-danger" : "scale-0 bg-neutral-300")} /></span><div><p className="text-sm font-semibold text-neutral-800">Alerts on this device</p><p role="status" className="mt-1 text-xs leading-5 text-neutral-500">{status}</p></div></div>
    <div className="space-y-2">
      <SwitchRow label="Banner when a message arrives" detail="While Venture Studio is open in another tab or minimised." checked={banners.active} disabled={!notificationsSupported() || permission === "denied"} onChange={(next) => void changeBanners(next)} />
      <SwitchRow label="Play a sound" detail="For new messages and alerts while the site is open." checked={!muted} onChange={(next) => { setChatSoundMuted(!next); if (next) prepareChatAudio(); }} />
      <SwitchRow label="Also when Venture Studio is closed" detail={busy ? (push === "enabled" ? "Turning off…" : "Turning on…") : pushDetail} checked={push === "enabled"} disabled={busy || !["ready", "enabled"].includes(push) || permission === "denied"} onChange={(next) => void (next ? enablePush() : disablePush())} />
    </div>
    <div data-open={preferenceEnabled === false && push === "enabled"} className="vso-collapse"><div><p className="text-xs leading-5 text-warning-text">&ldquo;Push when the site is closed&rdquo; is off in the preferences above, so nothing is pushed to this device. Turn it on and save.</p></div></div>
    {homeScreen && <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">On iPhone or iPad: tap <strong className="font-semibold">Share</strong>, then <strong className="font-semibold">Add to Home Screen</strong>, and open Venture Studio from there to turn on notifications.</p>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={permission === "unsupported"} onClick={() => { prepareChatAudio(); void testAlert().then((shown) => { if (!shown) setError(permission === "granted" ? "The test notification couldn't be shown." : "Turn on a banner above first, then test."); }); }} className={secondaryClass}>Send a test</button>
      {push === "error" && <button type="button" onClick={() => { setError(""); setPush("checking"); setRevision((value) => value + 1); }} className={secondaryClass}>Check again</button>}
    </div>
    <p className="text-xs leading-5 text-neutral-400">These apply to this browser only. Each channel&apos;s bell chooses which of its messages notify you.</p>
  </div>;
}
