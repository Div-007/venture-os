import { Suspense } from "react";
import { ChannelsScreen } from "@/screens/studio-collab";
export default function Page(){return <Suspense fallback={<div className="p-6">Loading channels…</div>}><ChannelsScreen/></Suspense>}
