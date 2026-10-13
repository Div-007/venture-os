import { Suspense } from "react";
import { LiveWeeklyLeaderboardScreen } from "@/screens/live-weekly-leaderboard";

export const metadata = { title: "Top performers of the week — Venture Studio OS" };
export default function LiveWeeklyLeaderboardPage() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading this week&apos;s top performers…</div>}><LiveWeeklyLeaderboardScreen /></Suspense>; }
