"use client";

import { Suspense, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle01Icon,
  Cancel01Icon,
  AiMagicIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import clsx from "clsx";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, useTab } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { Anim } from "@/components/ui/anim";
import { Drawer } from "@/components/ui/drawer";
import { primaryBtn } from "@/components/ui/btn";
import { approvalsQueue, projects, opsTasks } from "@/lib/mock-modules";

const tabs = [
  { key: "approvals", label: "Approvals", badge: 5 },
  { key: "projects", label: "Projects" },
  { key: "tasks", label: "Tasks", badge: 3 },
];

function Inner() {
  const tab = useTab(tabs);
  const [sel, setSel] = useState<string>(approvalsQueue[0].id);
  const [form, setForm] = useState(false);
  const [filter, setFilter] = useState("Needs me");
  const item = approvalsQueue.find((a) => a.id === sel)!;

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="Operations"
        subtitle="Approvals, projects and tasks"
      >
        <button type="button" onClick={() => setForm(true)} className={primaryBtn}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          New Task
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "approvals" && (
        <Anim delay={130}>
          {/* 3-pane approvals inbox — §6g */}
          <div className="grid gap-4 lg:grid-cols-12">
            {/* filters */}
            <div className="space-y-1 rounded-2xl bg-white p-3 lg:col-span-3">
              {[
                { k: "Needs me", n: 5 },
                { k: "Purchase", n: 2 },
                { k: "HR / Leave", n: 2 },
                { k: "Discount", n: 1 },
                { k: "Delegated", n: 2 },
                { k: "Approved history", n: 0 },
              ].map((f) => (
                <button
                  key={f.k}
                  type="button"
                  onClick={() => setFilter(f.k)}
                  className={clsx(
                    "flex w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-[12.5px] font-semibold",
                    "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]",
                    filter === f.k
                      ? "bg-primary-700 text-white"
                      : "text-neutral-600 hover:bg-neutral-100"
                  )}
                >
                  {f.k}
                  <span className={clsx("rounded-full px-1.5 py-0.5 text-[9.5px] font-bold tnum", filter === f.k ? "bg-white/20 text-white" : "bg-neutral-100 text-neutral-400")}>
                    {f.n}
                  </span>
                </button>
              ))}
            </div>

            {/* queue */}
            <div className="space-y-1.5 rounded-2xl bg-white p-3 lg:col-span-4">
              <p className="px-2 pb-1 text-[11px] font-semibold text-neutral-400">
                5 pending · oldest 2d
              </p>
              {approvalsQueue.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSel(a.id)}
                  className={clsx(
                    "w-full rounded-xl px-3.5 py-3 text-left",
                    "transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]",
                    sel === a.id ? "bg-primary-50" : "hover:bg-neutral-50"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[12.5px] font-bold text-neutral-900">
                      {a.kind} · {a.id}
                    </span>
                    <span className={clsx("text-[10px] font-semibold tnum", a.ageTone === "warning" ? "text-warning-text" : "text-neutral-400")}>
                      {a.age}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11.5px] font-medium text-neutral-500">
                    {a.who} · {a.meta}
                  </p>
                  {a.amount && (
                    <p className="mt-1 text-[12px] font-semibold text-neutral-900 tnum">{a.amount}</p>
                  )}
                </button>
              ))}
            </div>

            {/* detail */}
            <div className="rounded-2xl bg-white p-5 lg:col-span-5">
              <div className="flex items-center justify-between">
                <p className="text-[15px] font-bold tracking-tight text-neutral-900">
                  {item.id} · {item.kind}
                </p>
                <StatusChip label="Pending" tone="warning" />
              </div>
              <p className="mt-1 text-[12.5px] font-medium text-neutral-500">{item.meta}</p>

              <div className="mt-4 space-y-2 rounded-xl bg-neutral-50 p-4 text-[12.5px] font-medium text-neutral-600">
                <p className="flex justify-between"><span>Requester</span><span className="font-bold text-neutral-800">{item.who}</span></p>
                {item.amount && <p className="flex justify-between"><span>Amount</span><span className="font-bold text-neutral-800 tnum">{item.amount}</span></p>}
                <p className="flex justify-between"><span>Waiting</span><span className="font-bold text-neutral-800 tnum">{item.age}</span></p>
                <p className="flex justify-between"><span>Budget</span><span className="font-bold text-success-text">Within Q3 ✓</span></p>
              </div>

              <div className="mt-3 rounded-xl bg-ai-surface p-3.5">
                <p className="flex items-start gap-2 text-[12px] font-semibold leading-snug text-ai-text">
                  <HugeiconsIcon icon={AiMagicIcon} size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                  Price is 3.4% over last PO for this vendor; vendor rating A, delivery on-time 96%. Low risk.
                </p>
              </div>

              <input
                placeholder="Comment (optional)…"
                className="mt-3 h-10 w-full rounded-xl bg-neutral-100 px-3.5 text-[12.5px] font-medium text-neutral-800 placeholder:text-neutral-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-600/25"
              />

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-primary-700 py-2.5 text-[12.5px] font-bold text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]"
                >
                  <HugeiconsIcon icon={CheckmarkCircle01Icon} size={15} strokeWidth={1.75} />
                  Approve
                </button>
                <button
                  type="button"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-danger-surface py-2.5 text-[12.5px] font-bold text-danger-text transition-[background-color,transform] duration-150 hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger active:scale-[0.98]"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.75} />
                  Reject
                </button>
              </div>
              <button type="button" className="mt-2 w-full rounded-full py-2 text-[11.5px] font-bold text-neutral-400 transition-colors hover:bg-neutral-50 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                Ask requester a question ↩
              </button>
            </div>
          </div>
        </Anim>
      )}

      {tab === "projects" && (
        <Anim delay={130}>
          <div className="grid gap-4 sm:grid-cols-3">
            {projects.map((p) => (
              <div key={p.id} className="rounded-2xl bg-white p-5">
                <div className="flex items-center justify-between">
                  <p className="text-[13.5px] font-bold text-neutral-900">{p.name}</p>
                  <StatusChip label={p.status} tone={p.tone as Tone} />
                </div>
                <p className="mt-1 text-[11.5px] font-medium text-neutral-400">{p.id} · {p.owner} · due {p.due}</p>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-neutral-100">
                  <div className="h-full rounded-full bg-gradient-to-r from-primary-400 to-primary-600" style={{ width: `${p.progress}%` }} />
                </div>
                <p className="mt-2 text-[11px] font-semibold text-neutral-500 tnum">{p.progress}% complete</p>
              </div>
            ))}
          </div>
        </Anim>
      )}

      {tab === "tasks" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "id", label: "Task" },
              { key: "title", label: "Title" },
              { key: "who", label: "Owner" },
              { key: "due", label: "Due" },
              { key: "st", label: "Status" },
            ]}
            rows={opsTasks.map((t) => ({
              id: t.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{t.id}</span>,
                <span key="t" className="font-bold text-neutral-900">{t.title}</span>,
                t.who, t.due,
                <StatusChip key="s" label={t.status} tone={t.tone as Tone} />,
              ],
              menu: [
                { label: "Mark done", icon: CheckmarkCircle01Icon },
                { label: "Reassign", icon: Cancel01Icon },
              ],
            }))}
            searchPlaceholder="Search tasks…"
            chips={["Open", "Done", "Mine"]}
          />
        </Anim>
      )}

      <Drawer
        open={form}
        onClose={() => setForm(false)}
        title="New Task"
        fields={[
          { label: "Title", placeholder: "What needs doing?" },
          { label: "Assign to", placeholder: "Person…" },
          { label: "Due", placeholder: "18 Sep 2026" },
        ]}
        submitLabel="Create task"
      />
    </div>
  );
}

export function OperationsScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
