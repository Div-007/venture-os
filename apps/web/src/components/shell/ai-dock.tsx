"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { Check, Pause, Play, RotateCcw, TimerReset, X } from "@/components/ui/icons";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";

const timerKey = "venture-studio-demo-timer";
const duration = 25 * 60;

export function FocusDock({ open, instant, onClose }: { open: boolean; instant: boolean; onClose: () => void }) {
  const { data, currentUserId, updateSection } = useStudio();
  const [remaining, setRemaining] = useState(duration);
  const [targetAt, setTargetAt] = useState<number | null>(null);
  const [taskId, setTaskId] = useState("task-offers");
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const stored = Number(localStorage.getItem(timerKey));
        if (stored > Date.now()) { setTargetAt(stored); setRemaining(Math.max(0, Math.ceil((stored - Date.now()) / 1000))); }
      } catch { /* Local demo timer starts fresh. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!targetAt) return;
    const interval = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((targetAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) { window.clearInterval(interval); setTargetAt(null); localStorage.removeItem(timerKey); setFinished(true); }
    }, 250);
    return () => window.clearInterval(interval);
  }, [targetAt]);

  const toggle = () => {
    if (targetAt) { setRemaining(Math.max(0, Math.ceil((targetAt - Date.now()) / 1000))); setTargetAt(null); localStorage.removeItem(timerKey); }
    else { const end = Date.now() + remaining * 1000; setTargetAt(end); localStorage.setItem(timerKey, String(end)); setFinished(false); }
  };
  const complete = () => { const minutes = Math.max(1, Math.round((duration - remaining) / 60)); updateSection("focusSessions", (items) => [{ id: `focus-${Date.now()}`, taskId: focusTaskId, minutes, endedAt: new Date().toISOString() }, ...items]); setRemaining(duration); setTargetAt(null); localStorage.removeItem(timerKey); setFinished(false); };
  const reset = () => { setRemaining(duration); setTargetAt(null); localStorage.removeItem(timerKey); setFinished(false); };
  const clock = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  const tasks = data.tasks.filter((task) => task.ownerId === currentUserId && task.status !== "Done");
  // Fall back to the first of your tasks when the remembered one is not yours (or is done), so the picker never shows "Select…".
  const focusTaskId = tasks.some((task) => task.id === taskId) ? taskId : tasks[0]?.id ?? "task-offers";
  return <>
    <button type="button" aria-label="Close focus sprint" onClick={onClose} className={clsx("fixed inset-0 z-40 bg-neutral-900/20 backdrop-blur-[1px]", !instant && "transition-opacity duration-150", open ? "opacity-100" : "pointer-events-none opacity-0")} />
    <aside aria-hidden={!open} aria-label="Focus sprint" className={clsx("fixed bottom-0 right-0 top-0 z-50 flex w-[400px] max-w-[94vw] flex-col bg-white p-5 shadow-e4", !instant && "transition-transform duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)]", open ? "translate-x-0" : "translate-x-full")}>
      <header className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-50 text-primary-700"><TimerReset size={19}/></span><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-neutral-900">Focus sprint</h2><p className="truncate text-[11px] font-semibold text-neutral-400">25-minute work session</p></div><button type="button" onClick={onClose} aria-label="Close focus sprint" className="grid h-10 w-10 place-items-center rounded-xl text-neutral-400 hover:bg-neutral-100"><X size={17}/></button></header>
      <div className="thin-scroll mt-5 flex-1 overflow-y-auto"><div className="rounded-2xl bg-primary-700 p-5 text-white shadow-e3"><p className="text-[10px] font-semibold uppercase tracking-[.1em] text-white/45">Work on</p><Select aria-label="Focus task" value={focusTaskId} onChange={(event)=>setTaskId(event.target.value)} className="mt-2 w-full rounded-lg border border-white/15 bg-primary-800 px-3 py-2 text-sm font-semibold text-white outline-none focus:ring-2 focus:ring-white">{tasks.map((task)=><option key={task.id} value={task.id}>{task.title}</option>)}{tasks.length===0&&<option value="task-offers">Unassigned focus</option>}</Select><div className="my-6 text-center font-mono text-[46px] font-medium tracking-[-.06em] tnum" role="timer" aria-live="off">{clock}</div><div className="grid grid-cols-[1fr_auto] gap-2"><button type="button" onClick={toggle} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-neutral-900 hover:bg-neutral-100">{targetAt?<Pause size={16} fill="currentColor"/>:<Play size={16} fill="currentColor"/>}{targetAt?"Pause":remaining<duration&&!finished?"Resume":"Start sprint"}</button><button type="button" onClick={reset} aria-label="Reset timer" title="Reset timer" className="grid h-12 w-12 place-items-center rounded-xl border border-white/20 text-white hover:bg-white/10"><RotateCcw size={16}/></button></div>{(remaining<duration||finished)&&<button type="button" onClick={complete} className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/20 text-xs font-semibold text-white hover:bg-white/10"><Check size={15}/>Log session{finished?" · complete":""}</button>}</div>
        <section className="mt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-neutral-900">Recent focus sessions</h3><span className="font-mono text-xs text-neutral-400">{data.focusSessions.length}</span></div><div className="mt-3 space-y-2">{data.focusSessions.slice(0,4).map((session)=><div key={session.id} className="rounded-xl bg-neutral-50 p-3"><p className="text-sm font-semibold text-neutral-700">{data.tasks.find((task)=>task.id===session.taskId)?.title??"Focused work"}</p><p className="mt-1 text-xs text-neutral-400">{session.minutes} min · {new Date(session.endedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p></div>)}</div></section>
      </div><p className="mt-3 rounded-xl bg-primary-50 px-4 py-3 text-center text-[11px] font-semibold leading-5 text-primary-700">Press <kbd className="rounded bg-white px-1.5 py-0.5 font-mono">Ctrl /</kbd> to open or close instantly.</p>
    </aside>
  </>;
}
