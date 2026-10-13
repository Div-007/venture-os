"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, Bell, BellRing, Check, Clock3 } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { dismissToast, toast } from "@/components/ui/toast";
import { getLiveNotificationPreferences, getLiveReminder, listLiveNotifications, listLiveReminders, markLiveNotificationsRead, readLiveNotification, snoozeLiveReminder, updateLiveNotificationPreferences } from "@/lib/studio-api";
import { notificationHref, notificationRefreshEvent, notificationSnapshotEvent } from "@/lib/notification-events";
import { ActionLabel, Badge, HeaderActions, Notice, PageFrame, PageTitle, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass, SkeletonRows, useFlag } from "@/components/studio/primitives";
import { LiveWebPush } from "@/components/studio/live-web-push";

type Notification = Awaited<ReturnType<typeof listLiveNotifications>>[number];
type Preferences = Awaited<ReturnType<typeof getLiveNotificationPreferences>>;
type Reminder = Awaited<ReturnType<typeof listLiveReminders>>["items"][number];
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const preferenceLabels: Record<keyof Preferences, string> = { email: "Email delivery", webPush: "Push when the site is closed", mentions: "@mentions in channels", messages: "Direct messages", assignments: "Assignments", reminders: "Reminders", calendar: "Calendar invitations and changes" };
const UNDO_MS = 5000;
const snoozeText = (value: string) => value === "never" ? "Reminder cancelled" : `Snoozed for ${value} minutes`;

export function LiveNotificationsScreen() {
  const [items, setItems] = useState<Notification[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderCursor, setReminderCursor] = useState<string | undefined>();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState("");
  // A failed first load shows in the inbox itself (never as "nothing yet"); other errors stay in the banner.
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const filterMotion = useTabMotion(unreadOnly ? "unread" : "all", ["all", "unread"]);
  const [revision, setRevision] = useState(0);
  const [linkedReminderId, setLinkedReminderId] = useState("");
  const [linkedReminderError, setLinkedReminderError] = useState("");
  // Mark read is undoable: the row reads as read at once and the change is sent when the Undo window closes.
  const [pendingReads, setPendingReads] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const awaitingRead = useRef(new Set<string>());
  // Reads already sent stay shown as read even if an older inbox snapshot arrives afterwards.
  const sentReads = useRef(new Set<string>());
  const [saved, markSaved] = useFlag();

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([listLiveNotifications(), listLiveReminders(), getLiveNotificationPreferences()]).then(([nextItems, page, nextPreferences]) => {
      if (active) { setItems(nextItems); setReminders((current) => { const linked = current.find((item) => item.id === new URLSearchParams(window.location.search).get("reminder")); return linked && !page.items.some((item) => item.id === linked.id) ? [linked, ...page.items] : page.items; }); setReminderCursor(page.nextCursor); setPreferences(nextPreferences); setLoading(false); setError(""); setLoadError(""); }
    }).catch((cause: unknown) => { if (active) { const message = describeError(cause, "Could not load your inbox."); setError(message); setLoadError(message); setLoading(false); } }));
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("reminder");
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    let active = true;
    queueMicrotask(() => getLiveReminder(id).then((item) => {
      if (!active) return;
      setLinkedReminderId(id);
      setReminders((current) => current.some((entry) => entry.id === id) ? current : [item, ...current]);
    }).catch(() => { if (active) setLinkedReminderError("The linked reminder is unavailable or no longer accessible."); }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!linkedReminderId || !reminders.some((item) => item.id === linkedReminderId)) return;
    const target = document.getElementById(`reminder-${linkedReminderId}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [linkedReminderId, reminders]);

  useEffect(() => {
    const onSnapshot = (event: Event) => {
      const snapshot = (event as CustomEvent<Notification[]>).detail;
      if (!Array.isArray(snapshot)) return;
      snapshot.forEach((item) => { if (item.readAt) sentReads.current.delete(item.id); });
      setItems(snapshot.map((item) => !item.readAt && sentReads.current.has(item.id) ? { ...item, readAt: new Date().toISOString() } : item));
    };
    window.addEventListener(notificationSnapshotEvent, onSnapshot);
    return () => window.removeEventListener(notificationSnapshotEvent, onSnapshot);
  }, []);

  async function act(id: string, action: () => Promise<unknown>, done?: string) {
    setBusyId(id); setError("");
    try { await action(); setRevision((value) => value + 1); window.dispatchEvent(new Event(notificationRefreshEvent)); if (done) toast({ title: done }); }
    catch (cause) { setError(describeError(cause, "Could not update the record.")); }
    finally { setBusyId(null); }
  }

  const setIn = (setter: typeof setPendingReads, id: string, on: boolean) => setter((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });

  function commitRead(id: string) {
    if (!awaitingRead.current.delete(id)) return;
    sentReads.current.add(id);
    readLiveNotification(id).then(() => {
      setItems((current) => current.map((item) => item.id === id && !item.readAt ? { ...item, readAt: new Date().toISOString() } : item));
      window.dispatchEvent(new Event(notificationRefreshEvent));
    }).catch((cause: unknown) => { sentReads.current.delete(id); toast({ tone: "error", title: "Could not mark it read", body: describeError(cause, "Please try again.") }); })
      .finally(() => setIn(setPendingReads, id, false));
  }

  function markRead(item: Notification) {
    setIn(setPendingReads, item.id, true);
    // In the Unread view the row folds away (decision 16B); in All it simply turns read.
    if (unreadOnly) { setIn(setLeaving, item.id, true); window.setTimeout(() => setIn(setLeaving, item.id, false), 320); }
    awaitingRead.current.add(item.id);
    toast({ id: `read-${item.id}`, title: "Marked as read", body: item.title, duration: UNDO_MS, action: { label: "Undo", onClick: () => undefined }, onClose: (reason) => {
      if (reason === "dismissed") { commitRead(item.id); return; }
      awaitingRead.current.delete(item.id);
      setIn(setPendingReads, item.id, false);
    } });
  }

  // Leaving the inbox (or the page) sends any read that is still inside its Undo window.
  useEffect(() => {
    const pending = awaitingRead.current;
    const flush = () => [...pending].forEach((id) => dismissToast(`read-${id}`));
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);

  async function markAll() {
    const unread = items.filter((item) => !item.readAt).length;
    setBusyId("all"); setError("");
    const before = items;
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt }));
    try { await markLiveNotificationsRead(); window.dispatchEvent(new Event(notificationRefreshEvent)); toast({ title: "All caught up", body: `${unread} notification${unread === 1 ? "" : "s"} marked as read.` }); }
    catch (cause) { setItems(before); setError(describeError(cause, "Could not mark notifications read.")); }
    finally { setBusyId(null); }
  }

  async function savePreferences(event: React.FormEvent) {
    event.preventDefault();
    if (!preferences) return;
    setBusyId("preferences"); setError("");
    try { setPreferences(await updateLiveNotificationPreferences(preferences)); markSaved("preferences"); }
    catch (cause) { setError(describeError(cause, "Could not save preferences.")); }
    finally { setBusyId(null); }
  }

  async function moreReminders() {
    if (!reminderCursor) return;
    setBusyId("reminders"); setError("");
    try { const page = await listLiveReminders(reminderCursor); setReminders((current) => [...current, ...page.items]); setReminderCursor(page.nextCursor); }
    catch (cause) { setError(describeError(cause, "Could not load more reminders.")); }
    finally { setBusyId(null); }
  }

  const effective = items.map((item) => !item.readAt && pendingReads.has(item.id) ? { ...item, readAt: "pending" } : item);
  const unreadCount = effective.filter((item) => !item.readAt).length;
  const visible = effective.filter((item) => !unreadOnly || !item.readAt || leaving.has(item.id));
  const retry = () => { setLoading(true); setRevision((value) => value + 1); };
  const loadFailed = Boolean(loadError) && !items.length && !loading;
  return <PageFrame>
    <PageTitle title="Notifications" description="Messages, reminders, and delivery preferences for your workspace." action={<HeaderActions><RefreshButton busy={loading} onClick={retry} /></HeaderActions>} />
    <Notice tone="error" message={loadFailed ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    <Notice tone="error" message={linkedReminderError} onDismiss={() => setLinkedReminderError("")} className="pb-4" />
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_350px]">
      <Panel><div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 p-3"><SlidingTabs fitContent label="Notification filter" active={unreadOnly ? "unread" : "all"} onChange={(key) => setUnreadOnly(key === "unread")} tabs={[{ key: "all", label: "All" }, { key: "unread", label: "Unread", ...(unreadCount ? { badge: unreadCount } : {}) }]} />{unreadCount > 0 && <button type="button" disabled={busyId === "all"} onClick={() => void markAll()} className="vso-fade-enter ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-primary-50 active:scale-[0.97] disabled:opacity-40"><Check size={15} />Mark all read</button>}</div>
        {loading && !items.length ? <SkeletonRows rows={4} label="Loading notifications" /> : visible.length ? <div key={unreadOnly ? "unread" : "all"} className={filterMotion.className} style={filterMotion.style}>{visible.map((item) => {
          const reminderId = item.type === "reminder" ? item.reminderId ?? (item.resourceType === "reminder" ? item.resourceId : undefined) : undefined;
          return <div key={item.id} data-open={!leaving.has(item.id)} className="vso-collapse border-b border-neutral-100 last:border-b-0"><div><article className={clsx("flex flex-wrap items-start gap-3 p-4 transition-colors duration-300", !item.readAt && "bg-primary-50/40")}><span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-700"><Bell size={17} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-neutral-800">{item.title}</p><Badge tone={item.readAt ? "neutral" : "blue"}>{item.readAt ? "Read" : "Unread"}</Badge></div><p className="mt-1 text-sm text-neutral-500">{item.body}</p><p className="mt-1 text-xs text-neutral-400">{stamp(item.createdAt)} · {item.type}</p></div><div className="flex flex-wrap gap-2">{notificationHref(item).href !== "/notifications/live" && <Link href={notificationHref(item).href} className={secondaryClass}>{notificationHref(item).label}</Link>}{!item.readAt && <button type="button" disabled={busyId === item.id} onClick={() => markRead(item)} className={secondaryClass}>Mark read</button>}{reminderId && <Select aria-label={`Snooze ${item.title}`} disabled={busyId === item.id} defaultValue="" onChange={(event) => { const value = event.target.value; if (value) act(item.id, () => snoozeLiveReminder(reminderId, value === "never" ? "never" : Number(value) as 10 | 20 | 30), snoozeText(value)); event.currentTarget.value = ""; }} className="min-h-10 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-semibold text-neutral-700"><option value="">Snooze…</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option><option value="never">Cancel reminder</option></Select>}</div></article></div></div>;
        })}</div> : loadFailed ? <EmptyState variant="error" title="Could not load your inbox" body={loadError} action={{ label: "Try again", onClick: retry }} /> : <EmptyState variant="card" tone="teal" icon={BellRing} title={unreadOnly ? "All caught up" : "No notifications yet"} body="New assignments, mentions and reminders appear here." secondary={unreadOnly && items.length ? { label: "Show all", onClick: () => setUnreadOnly(false) } : undefined} />}
      </Panel>
      <div className="space-y-4"><Panel><PanelHead title="Delivery preferences" /><form onSubmit={savePreferences} className="space-y-2 p-4">{preferences ? (Object.keys(preferenceLabels) as (keyof Preferences)[]).map((key) => <label key={key} className="flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-xl bg-neutral-50 px-3 text-sm font-semibold text-neutral-700 transition-colors duration-150 hover:bg-neutral-100"><span>{preferenceLabels[key]}</span><input type="checkbox" role="switch" className="vso-toggle" checked={preferences[key]} onChange={(event) => setPreferences((current) => current ? { ...current, [key]: event.target.checked } : current)} /></label>) : <div role="status" aria-label="Loading preferences" className="grid gap-2">{[0, 1, 2, 3, 4, 5].map((index) => <span key={index} className="vso-skeleton h-10 rounded-xl" />)}</div>}<button disabled={!preferences || busyId === "preferences"} className={clsx(primaryClass, "mt-2", saved && "!bg-success hover:!bg-success")}><ActionLabel busy={busyId === "preferences"} done={Boolean(saved)} idle="Save preferences" doneText="Saved" /></button></form></Panel>
        <Panel><PanelHead title="This device" /><LiveWebPush preferenceEnabled={preferences?.webPush} /></Panel>
        <Panel><PanelHead title="Your reminders" aside={<Badge tone="blue">{reminders.length}{reminderCursor ? "+" : ""}</Badge>} /><div className="divide-y divide-neutral-100">{loading && !reminders.length ? <SkeletonRows rows={2} label="Loading reminders" /> : reminders.length ? reminders.map((item) => <article key={item.id} id={`reminder-${item.id}`} tabIndex={-1} className={clsx("p-4 outline-none transition-[background-color,box-shadow] duration-300", linkedReminderId === item.id && "bg-primary-50 ring-2 ring-inset ring-primary-300")}><p className="break-words text-sm font-semibold text-neutral-800 [overflow-wrap:anywhere]">{item.message}</p><p className="mt-1 text-xs text-neutral-500">{stamp(item.scheduledAt)} · {item.state}</p>{item.taskId && <Link href={`/tasks/live?task=${encodeURIComponent(item.taskId)}`} className="mt-2 inline-block text-xs font-semibold text-primary-700 underline">Open task</Link>}{item.state === "scheduled" && <Select aria-label={`Snooze reminder ${item.id}`} disabled={busyId === item.id} defaultValue="" onChange={(event) => { const value = event.target.value; if (value) act(item.id, () => snoozeLiveReminder(item.id, value === "never" ? "never" : Number(value) as 10 | 20 | 30), snoozeText(value)); event.currentTarget.value = ""; }} className="mt-2 block min-h-10 rounded-xl border border-neutral-200 bg-white px-3 text-xs font-semibold text-neutral-700"><option value="">Snooze…</option><option value="10">10 min</option><option value="20">20 min</option><option value="30">30 min</option><option value="never">Cancel reminder</option></Select>}</article>) : loadFailed ? <EmptyState variant="compact" icon={AlertTriangle} title="Reminders unavailable" body="They did not load with your inbox." className="m-4" /> : <EmptyState variant="card" tone="teal" icon={Clock3} title="No reminders scheduled" body="Reminders from tasks and /notify appear here." />}</div>{reminderCursor && <div className="p-4 text-center"><button type="button" disabled={busyId === "reminders"} onClick={moreReminders} className={secondaryClass}><ActionLabel busy={busyId === "reminders"} busyText="Loading…" idle="Load more reminders" /></button></div>}</Panel>
      </div>
    </div>
  </PageFrame>;
}
