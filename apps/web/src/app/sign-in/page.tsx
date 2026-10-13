"use client";

import { Select } from "@/components/ui/select";
import Link from "@/components/shell/demo-link";
import { Layers3, LockKeyhole } from "@/components/ui/icons";
import { StudioProvider, useStudio } from "@/lib/studio-store";
import { inputClass, primaryClass } from "@/components/studio/primitives";

function DemoSignIn(){const {data,currentUserId,setCurrentUserId}=useStudio();return <main className="grid min-h-dvh place-items-center bg-canvas p-4"><section className="w-full max-w-md rounded-2xl border border-neutral-100 bg-white p-7 shadow-card"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-600 text-white"><Layers3 size={21}/></span><p className="mt-5 text-xs font-semibold uppercase tracking-[.1em] text-primary-600">Meridian Studio</p><h1 className="mt-1 text-2xl font-extrabold tracking-tight text-neutral-900">Venture Studio OS</h1><p className="mt-2 text-sm leading-6 text-neutral-500">Choose a demo identity to review the workflow. This selector changes the demo only; it does not grant workspace access.</p><label className="mt-5 block"><span className="mb-1.5 block text-xs font-semibold text-neutral-600">Continue as</span><Select className={inputClass} value={currentUserId} onChange={(event)=>setCurrentUserId(event.target.value)}>{data.people.map((person)=><option key={person.id} value={person.id}>{person.name} · {person.role}</option>)}</Select></label><Link href="/today" className={`mt-5 w-full ${primaryClass}`}>Open demo workspace</Link><Link href="/sign-in/live" className="mt-3 block text-center text-xs font-semibold text-primary-700 underline">Sign in to the connected workspace</Link><p className="mt-4 flex items-start gap-2 text-xs leading-5 text-neutral-400"><LockKeyhole size={14} className="mt-0.5 shrink-0"/>Demo identities are for interface review only. They do not protect data or grant real access.</p></section></main>}
export default function Page(){return <StudioProvider><DemoSignIn/></StudioProvider>}
