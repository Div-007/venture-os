"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers3 } from "@/components/ui/icons";
import { AppShell } from "./app-shell";
import { StudioProvider } from "@/lib/studio-store";
import { connectedNotices, connectedShellData } from "@/lib/live-shell-data";
import { notificationSnapshotEvent } from "@/lib/notification-events";
import { StudioApiError, getWeeklyLeaderboardStatus, hasLiveAuthSession, listLiveMembers, listLiveNotifications, listLiveTasks, loadLiveSession, signOutLive } from "@/lib/studio-api";
import { demoEnabled } from "@/lib/demo";
import { NewTaskHost } from "@/components/studio/new-task-dialog";
import { CelebrationHost } from "./celebration-host";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Snapshot = { session: Session; data: ReturnType<typeof connectedShellData> };

export function LiveShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  // Signed in, but the account has no workspace access: offer sign-out, since sign-in would send them straight back here.
  const [noAccess, setNoAccess] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [hierarchyRevision, setHierarchyRevision] = useState(0);
  const weeklyChecked = useRef(false);

  useEffect(() => {
    const refresh = () => setHierarchyRevision((value) => value + 1);
    window.addEventListener("venture:hierarchy-changed", refresh);
    return () => window.removeEventListener("venture:hierarchy-changed", refresh);
  }, []);

  useEffect(() => {
    const onNotifications = (event: Event) => {
      const notices = connectedNotices((event as CustomEvent<Awaited<ReturnType<typeof listLiveNotifications>>>).detail);
      setSnapshot((current) => current ? { ...current, data: { ...current.data, notices } } : current);
    };
    window.addEventListener(notificationSnapshotEvent, onNotifications);
    return () => window.removeEventListener(notificationSnapshotEvent, onNotifications);
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      try {
        const session = await loadLiveSession();
        if (!active) return;
        setSnapshot({ session, data: connectedShellData(session) });
        setError(""); setNoAccess(false);
        // On the first open after Saturday's edition is out, show it once (then carry on to where they were going).
        if (!weeklyChecked.current) {
          weeklyChecked.current = true;
          // Marked while it's decided, and kept until Saturday's film has played if it opens, so a celebration waits.
          document.documentElement.dataset.vsoWeekly = "pending";
          void getWeeklyLeaderboardStatus().then((status) => {
            if (status.seen || !status.ranked || window.location.pathname.startsWith("/leaderboard/weekly")) { delete document.documentElement.dataset.vsoWeekly; return; }
            router.replace(`/leaderboard/weekly/live?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
            // If the film never starts (reduced motion, or the page left), don't hold celebrations for long.
            window.setTimeout(() => { if (!document.documentElement.dataset.vsoFilm) delete document.documentElement.dataset.vsoWeekly; }, 8000);
          }, () => { delete document.documentElement.dataset.vsoWeekly; });
        }
        const [tasks, notifications, members] = await Promise.allSettled([
          listLiveTasks(), listLiveNotifications(), listLiveMembers({ limit: 100 }),
        ]);
        if (!active) return;
        setSnapshot({ session, data: connectedShellData(
          session,
          tasks.status === "fulfilled" ? tasks.value.items : [],
          notifications.status === "fulfilled" ? notifications.value : [],
          members.status === "fulfilled" ? members.value.items : [],
        ) });
      } catch (cause) {
        if (!active) return;
        if (cause instanceof StudioApiError && cause.code === "UNAUTHENTICATED") {
          // No session: go to sign-in and come back. A session without an active membership would loop, so explain instead.
          const signedIn = await hasLiveAuthSession().catch(() => false);
          if (!active) return;
          if (!signedIn) { router.replace(`/sign-in/live?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`); return; }
          setSnapshot(null);
          setNoAccess(true);
          setError("You're signed in, but this account doesn't have access to this workspace yet. Ask a workspace admin to invite you, or sign in with a different email.");
          return;
        }
        setSnapshot(null);
        setError(describeError(cause, "Could not open your workspace."));
      }
    });
    return () => { active = false; };
  }, [hierarchyRevision, router]);

  if (error) return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-danger-surface text-danger-text"><Layers3 size={20} /></span><h1 className="mt-4 text-xl font-bold text-neutral-900">Workspace unavailable</h1><p role="alert" className="mt-2 text-sm leading-6 text-neutral-500">{error}</p><div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => { setError(""); setHierarchyRevision((value) => value + 1); }} className="min-h-10 rounded-xl bg-primary-700 px-4 py-2.5 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 active:scale-[0.97]">Try again</button>{noAccess && <button type="button" disabled={signingOut} onClick={() => { setSigningOut(true); setSignOutError(""); signOutLive().catch((cause) => { setSigningOut(false); setSignOutError(describeError(cause, "Could not sign out. Try again.")); }); }} className="min-h-10 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-xs font-semibold text-neutral-700 transition-[background-color,transform] duration-150 hover:bg-neutral-50 active:scale-[0.97] disabled:opacity-60">{signingOut ? "Signing out…" : "Sign out"}</button>}{demoEnabled && <Link href="/demo" className="min-h-10 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-xs font-semibold text-neutral-700">Explore demo</Link>}</div>{signOutError && <p role="alert" className="mt-3 text-sm font-semibold text-danger-text">{signOutError}</p>}</section></main>;
  // The loading state already has the shell's shape, so the workspace settles in place instead of jumping.
  if (!snapshot) return <main aria-busy="true" className="vso-fade-enter flex h-dvh overflow-hidden bg-white"><span role="status" className="sr-only">Loading workspace…</span>
    <div aria-hidden="true" className="hidden w-[248px] shrink-0 flex-col gap-2 p-3 lg:flex"><div className="flex items-center gap-2.5"><span className="vso-skeleton h-8 w-8 rounded-[10px]" /><span className="grid flex-1 gap-1.5"><span className="vso-skeleton h-3 w-28" /><span className="vso-skeleton h-2.5 w-20" /></span></div><span className="vso-skeleton mt-4 h-11 rounded-xl" /><span className="vso-skeleton mt-3 mb-1 h-2.5 w-16" />{Array.from({ length: 10 }, (_, index) => <span key={index} className="vso-skeleton h-9 rounded-xl" style={{ opacity: 1 - index * 0.07 }} />)}</div>
    <div aria-hidden="true" className="flex min-w-0 flex-1 flex-col"><div className="flex h-14 shrink-0 items-center gap-3 px-4"><span className="vso-skeleton h-10 w-10 rounded-xl" /><span className="vso-skeleton mx-auto h-10 w-full max-w-[520px] rounded-xl" /><span className="vso-skeleton h-10 w-10 rounded-xl" /><span className="vso-skeleton h-10 w-10 rounded-xl" /></div><div className="flex-1 rounded-tl-[22px] bg-canvas px-4 py-5 sm:px-6 lg:px-7 lg:py-6"><span className="vso-skeleton h-8 w-56" /><span className="vso-skeleton mt-2 h-4 w-80 max-w-full" /><div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((index) => <span key={index} className="vso-skeleton h-28 rounded-2xl" />)}</div><span className="vso-skeleton mt-4 h-64 rounded-2xl" /></div></div>
  </main>;

  return <StudioProvider mode="connected" initialData={snapshot.data} initialUserId={snapshot.session.user.id} workspaceName={snapshot.session.hierarchy.workspace.name} role={snapshot.session.membership.role.replaceAll("_", " ")}><AppShell connected>{children}<NewTaskHost /><CelebrationHost /></AppShell></StudioProvider>;
}
