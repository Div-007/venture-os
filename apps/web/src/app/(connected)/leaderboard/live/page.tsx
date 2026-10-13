import { Suspense } from "react";
import { LiveLeaderboardScreen } from "@/screens/live-leaderboard";

export const metadata = { title: "Leaderboard — Venture Studio OS" };
export default function LiveLeaderboardPage() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading the leaderboard…</div>}><LiveLeaderboardScreen /></Suspense>; }
