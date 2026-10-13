import { Suspense } from "react";
import { ConnectedVentures } from "@/screens/connected-ventures";

export const metadata = { title: "Ventures — Venture Studio OS" };
export default function Page() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading ventures…</div>}><ConnectedVentures /></Suspense>; }
