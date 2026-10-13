import { Suspense } from "react";
import { LiveKnowledgeScreen } from "@/screens/live-knowledge";

export const metadata = { title: "Knowledge — Venture Studio OS" };
export default function LiveKnowledgePage() { return <Suspense fallback={<div className="p-6 text-sm text-neutral-500">Loading knowledge…</div>}><LiveKnowledgeScreen /></Suspense>; }
