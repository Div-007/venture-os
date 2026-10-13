import { Suspense } from "react";
import { VenturesScreen } from "@/screens/studio-ventures";
export default function Page(){return <Suspense fallback={<div className="p-6">Loading venture…</div>}><VenturesScreen/></Suspense>}
