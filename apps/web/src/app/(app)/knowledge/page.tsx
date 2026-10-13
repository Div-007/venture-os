import { Suspense } from "react";
import { KnowledgeScreen } from "@/screens/studio-knowledge";
export default function Page(){return <Suspense fallback={<div className="p-6">Loading knowledge…</div>}><KnowledgeScreen/></Suspense>}
