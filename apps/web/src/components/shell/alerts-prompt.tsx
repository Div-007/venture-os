"use client";

import { useEffect, useState } from "react";
import { BellRing, X } from "@/components/ui/icons";
import { primaryClass, secondaryClass } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { askNotificationPermission, notificationPermission, setAlertBanners, useAlertBanners } from "@/lib/device-alerts";
import { prepareChatAudio } from "@/components/studio/chat-message-effects";
import { getLivePushConfig } from "@/lib/studio-api";
import { pushSupported, turnOnPush } from "@/lib/web-push";

const DISMISSED_KEY = "vso-alerts-prompt";

/**
 * Asks once per device whether to turn on message alerts: a sound and a banner while the site is in the background, and
 * push while it's closed (where available). Browsers only show their permission question after a click, so this card
 * carries the click. "Not now" is remembered; Notifications → This device has the same switches.
 */
export function AlertsPrompt() {
  const { on } = useAlertBanners();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(DISMISSED_KEY) === "dismissed"; } catch { /* Ask this visit. */ }
    if (dismissed || on || notificationPermission() !== "default") return;
    // Give the page a moment to settle before asking.
    const timer = window.setTimeout(() => setShow(true), 2500);
    return () => window.clearTimeout(timer);
  }, [on]);

  const dismiss = () => {
    try { window.localStorage.setItem(DISMISSED_KEY, "dismissed"); } catch { /* It may ask again next visit. */ }
    setShow(false);
  };

  async function turnOn() {
    setBusy(true);
    void prepareChatAudio();
    try {
      const permission = await askNotificationPermission();
      if (permission !== "granted") {
        toast({ tone: "error", title: "Notifications weren't allowed", body: "You can allow them later in your browser's site settings, then turn them on in Notifications." });
        dismiss();
        return;
      }
      setAlertBanners(true);
      // Push too, where this workspace and browser support it; the banners work either way.
      let pushed = false;
      try {
        const config = await getLivePushConfig();
        if (config.available && config.publicKey && pushSupported()) { await turnOnPush(config.publicKey); pushed = true; }
      } catch { /* Push can be turned on later in Notifications → This device. */ }
      toast({ title: "Notifications on", body: pushed ? "You'll get a sound and a banner for new messages, even when Venture Studio is closed." : "You'll get a sound and a banner for new messages while Venture Studio is open." });
      dismiss();
    } finally { setBusy(false); }
  }

  if (!show) return null;
  return <section role="dialog" aria-labelledby="alerts-prompt-title" className="vso-fade-enter fixed bottom-4 right-4 z-[60] w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-neutral-200 bg-white p-4 shadow-e3">
    <div className="flex items-start gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-700"><BellRing size={18} /></span>
      <div className="min-w-0 flex-1">
        <h2 id="alerts-prompt-title" className="text-sm font-bold text-neutral-900">Get notified about new messages</h2>
        <p className="mt-1 text-xs leading-5 text-neutral-500">A sound and a banner when someone messages or @mentions you, even with Venture Studio in the background.</p>
      </div>
      <button type="button" aria-label="Not now" onClick={dismiss} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700"><X size={15} /></button>
    </div>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" onClick={dismiss} className={secondaryClass}>Not now</button>
      <button type="button" disabled={busy} onClick={() => void turnOn()} className={primaryClass}>{busy ? "Turning on…" : "Turn on"}</button>
    </div>
  </section>;
}
