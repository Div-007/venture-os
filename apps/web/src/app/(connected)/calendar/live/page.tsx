import { Suspense } from "react";
import { LiveCalendarScreen } from "@/screens/live-calendar";

export const metadata = { title: "Calendar — Venture Studio OS" };
export default function LiveCalendarPage() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading your calendar…</div>}><LiveCalendarScreen /></Suspense>; }
