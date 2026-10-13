import Link from "next/link";
import { Layers3 } from "@/components/ui/icons";
import { demoEnabled } from "@/lib/demo";

export default function UnavailablePage() {
  return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-50 text-primary-700"><Layers3 size={20} /></span><h1 className="mt-4 text-xl font-bold text-neutral-900">This feature is not available yet</h1><p className="mt-2 text-sm leading-6 text-neutral-500">You can explore a sample version in the demo, or return to your workspace. Nothing on this page changes your data.</p><div className="mt-5 flex flex-wrap gap-2"><Link href="/dashboard/live" className="inline-flex min-h-10 items-center rounded-xl bg-primary-700 px-4 text-xs font-semibold text-white">Connected dashboard</Link>{demoEnabled && <Link href="/demo" className="inline-flex min-h-10 items-center rounded-xl border border-neutral-200 px-4 text-xs font-semibold text-neutral-700">Explore demo</Link>}</div></section></main>;
}
