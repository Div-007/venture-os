import { Suspense } from "react";
import { LiveTasksScreen } from "@/screens/live-tasks";

export const metadata = { title: "Tasks — Venture Studio OS" };
export default function LiveTasksPage() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading connected tasks…</div>}><LiveTasksScreen /></Suspense>; }
