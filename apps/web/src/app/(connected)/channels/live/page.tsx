import { Suspense } from "react";
import { LiveChannelsScreen } from "@/screens/live-channels";

export const metadata = { title: "Channels — Venture Studio OS" };
export default function Page() { return <Suspense fallback={<div className="p-6 text-sm">Loading channels…</div>}><LiveChannelsScreen /></Suspense>; }
