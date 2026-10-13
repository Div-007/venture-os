"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, Copy, LinkIcon, RefreshCw } from "@/components/ui/icons";
import { DetailDrawer, Notice, primaryClass, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { createLiveCalendarFeed, deleteLiveCalendarFeed, getLiveCalendarFeed } from "@/lib/studio-api";
import { describeError } from "@/lib/errors";

/**
 * A private link that puts your calendar (events, invitations, deadlines, reviews, classes) into Google or Apple Calendar,
 * read-only. The address is shown once; resetting it makes a new one and stops the old one.
 */
export function SubscribeDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<{ enabled: boolean; createdAt?: string | undefined } | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => { getLiveCalendarFeed().then(setState).catch((cause: unknown) => setError(describeError(cause, "Could not load your calendar link."))); }, []);

  async function make() {
    setBusy(true); setError(""); setCopied(false);
    try { const feed = await createLiveCalendarFeed(); setState({ enabled: true, createdAt: feed.createdAt }); setUrl(feed.url ?? ""); }
    catch (cause) { setError(describeError(cause, "Could not make the link.")); }
    finally { setBusy(false); }
  }
  async function turnOff() {
    setBusy(true); setError("");
    try { await deleteLiveCalendarFeed(); setState({ enabled: false }); setUrl(""); setConfirmOff(false); }
    catch (cause) { setError(describeError(cause, "Could not turn the link off.")); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setError("Copy was unavailable. Select the link and copy it yourself."); }
  }

  return createPortal(<DetailDrawer title="Add to your phone's calendar" subtitle="Google Calendar, Apple Calendar, or Outlook" onClose={onClose}>
    <div className="space-y-5">
      <p className="text-sm leading-6 text-neutral-600">A private link shows your Venture Studio calendar in the calendar app you already use: your events and invitations, task deadlines, reviews, and classes. It updates on its own, about every hour. Change things here; the other app only shows them.</p>
      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      {!state ? (!error && <SkeletonRows rows={2} label="Loading" />) : url ? <div className="vso-fade-enter space-y-3">
        <p className="text-xs font-semibold text-neutral-600">Your private link: copy it now, it&apos;s shown only once</p>
        <div className="vso-code-well flex items-center gap-2 rounded-xl px-3 py-2.5"><code className="min-w-0 flex-1 truncate font-mono text-xs">{url}</code><button type="button" onClick={() => void copy()} className={clsx(secondaryClass, "!min-h-8 shrink-0 !px-2.5 !text-xs")}>{copied ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy</>}</button></div>
        <ol className="space-y-2 text-sm leading-6 text-neutral-700">
          <li><strong className="font-semibold">Google Calendar</strong> (on a computer): Other calendars → <em>+</em> → From URL → paste the link.</li>
          <li><strong className="font-semibold">Apple Calendar</strong>: File → New Calendar Subscription (Mac), or Settings → Calendar → Accounts → Add Subscribed Calendar (iPhone).</li>
          <li><strong className="font-semibold">Outlook</strong>: Add calendar → Subscribe from web.</li>
        </ol>
        <p className="rounded-xl bg-warning-surface p-3 text-xs leading-5 text-warning-text">Anyone with this link can see your calendar. If it gets shared by mistake, reset it.</p>
      </div> : state.enabled ? <div className="space-y-2 rounded-xl bg-neutral-50 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-neutral-800"><LinkIcon size={15} className="text-primary-700" />Your link is on</p>
        <p className="text-xs leading-5 text-neutral-500">Made {state.createdAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(state.createdAt)) : "earlier"}. For your safety it can&apos;t be shown again. Lost it? Reset it to get a new one; the old link stops working.</p>
      </div> : <div className="rounded-xl bg-neutral-50 p-4 text-sm text-neutral-600">No link yet.</div>}
      {state && <div className="flex flex-wrap gap-2 border-t border-neutral-100 pt-4">
        <button type="button" disabled={busy} onClick={() => void make()} className={primaryClass}>{state.enabled ? <><RefreshCw size={15} />{busy ? "Resetting…" : "Reset link"}</> : <><LinkIcon size={15} />{busy ? "Making…" : "Make my link"}</>}</button>
        {state.enabled && !confirmOff && <button type="button" onClick={() => setConfirmOff(true)} className={secondaryClass}>Turn off</button>}
        {confirmOff && <span className="vso-fade-enter inline-flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-danger-text">Stop the link working?</span><button type="button" onClick={() => setConfirmOff(false)} className={secondaryClass}>Keep it</button><button type="button" disabled={busy} onClick={() => void turnOff()} className="min-h-10 rounded-xl bg-[#b42318] px-4 text-sm font-semibold text-white transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.97]">Turn off</button></span>}
      </div>}
    </div>
  </DetailDrawer>, document.body);
}
