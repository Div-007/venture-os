import Link from "next/link";
import type { Metadata } from "next";
import { Layers3 } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Page not found — Venture Studio OS" };

export default function NotFound() {
  return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-50 text-primary-700"><Layers3 size={20} /></span><h1 className="mt-4 text-xl font-bold text-neutral-900">Page not found</h1><p className="mt-2 text-sm leading-6 text-neutral-500">This address does not match a page in Venture Studio. Check the link, or go back to your workspace.</p><div className="mt-5 flex flex-wrap gap-2"><Link href="/dashboard/live" className="inline-flex min-h-10 items-center rounded-xl bg-primary-700 px-4 text-xs font-semibold text-white">Go to dashboard</Link></div></section></main>;
}
