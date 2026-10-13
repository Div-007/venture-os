"use client";
import { describeError } from "@/lib/errors";
import { TASK_CREATED_EVENT } from "@/components/studio/new-task-dialog";

import { useEffect, useState } from "react";
import { StudioDashboard } from "./studio-dashboard";
import { TodayScreen } from "./studio-today";
import { connectedDashboardData } from "@/lib/live-shell-data";
import { listLiveClasses, listLiveDecisions, listLiveDocuments, listLiveFocusHistory, listLiveMembers, listLiveNotifications, listLiveOpportunities, listLiveOutcomes, listLiveTasks, loadLiveSession } from "@/lib/studio-api";

type Snapshot = ReturnType<typeof connectedDashboardData>;

export function ConnectedDashboard({ view = "dashboard" }: { view?: "dashboard" | "today" }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => { const onCreated = () => setRevision((value) => value + 1); window.addEventListener(TASK_CREATED_EVENT, onCreated); return () => window.removeEventListener(TASK_CREATED_EVENT, onCreated); }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      try {
        const session = await loadLiveSession();
        const [tasks, notifications, members, outcomes, decisions, documents, opportunities, focusHistory, classes] = await Promise.all([
          listLiveTasks(), listLiveNotifications(), listLiveMembers({ limit: 100 }), listLiveOutcomes(),
          listLiveDecisions(), listLiveDocuments(), listLiveOpportunities(), listLiveFocusHistory(), listLiveClasses(),
        ]);
        if (!active) return;
        setData(connectedDashboardData(session, {
          tasks: tasks.items, notifications, members: members.items, outcomes, decisions,
          documents: documents.items, opportunities, focusHistory: focusHistory.items, classes,
        }));
        setError("");
      } catch (cause) {
        if (!active) return;
        setError(describeError(cause, "The dashboard could not load."));
      }
    });
    return () => { active = false; };
  }, [revision]);

  if (error) return <div role="alert" className="vso-fade-enter m-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger-surface bg-white p-6 text-sm text-danger-text"><span>{error}</span><button type="button" onClick={() => { setError(""); setRevision((value) => value + 1); }} className="min-h-10 rounded-xl bg-primary-700 px-4 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 active:scale-[0.97]">Try again</button></div>;
  // The placeholder keeps the page's shape so the content settles in place.
  if (!data) return <div role="status" aria-label={view === "today" ? "Loading today" : "Loading your dashboard"} className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6"><span className="vso-skeleton h-9 w-64" /><span className="vso-skeleton mt-2 h-4 w-48" /><div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((index) => <span key={index} className="vso-skeleton h-[118px] rounded-2xl" />)}</div><div className="mt-4 grid grid-cols-12 gap-4"><span className="vso-skeleton col-span-12 h-64 rounded-2xl lg:col-span-8" /><span className="vso-skeleton col-span-12 h-64 rounded-2xl lg:col-span-4" /></div></div>;
  return view === "today" ? <TodayScreen snapshot={data} /> : <StudioDashboard snapshot={data} />;
}
