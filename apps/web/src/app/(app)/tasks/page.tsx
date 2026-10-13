import { Suspense } from "react";
import { TasksScreen } from "@/screens/studio-tasks";
export default function Page(){return <Suspense fallback={<div className="p-6">Loading tasks…</div>}><TasksScreen/></Suspense>}
