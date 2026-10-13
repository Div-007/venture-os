"use client";

import { Suspense } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowDown01Icon,
  PencilEdit01Icon,
  Shield01Icon,
  Download01Icon,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, useTab } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { AlertStrip } from "@/components/ui/alert-strip";
import { Anim } from "@/components/ui/anim";
import { Dropdown } from "@/components/ui/dropdown";
import { ghostBtn, primaryBtn } from "@/components/ui/btn";
import { users, roles, branchesAdmin, integrations, auditLogs } from "@/lib/mock-modules";

const tabs = [
  { key: "users", label: "Users & Roles", badge: 5 },
  { key: "companies", label: "Companies & Branches" },
  { key: "integrations", label: "Integrations" },
  { key: "audit", label: "Audit Logs" },
  { key: "security", label: "Security" },
];

function Inner() {
  const tab = useTab(tabs);

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="Admin"
        subtitle="Users, roles, branches, integrations and security"
      >
        <Dropdown
          align="right"
          items={[
            { label: "Backup now", icon: Download01Icon },
            { label: "Download audit log", icon: Download01Icon },
          ]}
          trigger={
            <button type="button" className={ghostBtn}>
              Actions
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
        <button type="button" className={primaryBtn}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          Invite User
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "users" && (
        <Anim delay={130} className="space-y-4">
          <DataTable
            cols={[
              { key: "name", label: "User" },
              { key: "role", label: "Role" },
              { key: "br", label: "Branch" },
              { key: "tfa", label: "2FA" },
              { key: "last", label: "Last active" },
              { key: "st", label: "Status" },
            ]}
            rows={users.map((u) => ({
              id: u.name,
              cells: [
                <span key="n" className="flex items-center gap-2.5">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-600 text-[9.5px] font-bold text-white">
                    {u.name.split(" ").map((w) => w[0]).join("")}
                  </span>
                  <span className="font-bold text-neutral-900">{u.name}</span>
                </span>,
                u.role, u.branch,
                u.tfa === "On"
                  ? <StatusChip label="On" tone="success" />
                  : u.tfa === "Off"
                    ? <StatusChip label="Off" tone="warning" />
                    : <span className="text-neutral-300">—</span>,
                u.last,
                <StatusChip key="s" label={u.status} tone={u.tone as Tone} />,
              ],
              menu: [
                { label: "Edit access", icon: PencilEdit01Icon },
                { label: "Reset 2FA", icon: Shield01Icon },
                "divider",
                { label: "Deactivate", icon: PencilEdit01Icon, danger: true },
              ],
            }))}
            searchPlaceholder="Search users…"
            chips={["Active", "2FA off", "Delhi", "Jaipur"]}
          />
          <div className="rounded-2xl bg-white p-5">
            <p className="text-[13px] font-semibold text-neutral-900">Role presets</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {roles.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  className="rounded-xl bg-neutral-50 p-3.5 text-left transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]"
                >
                  <p className="text-[12.5px] font-bold text-neutral-900">{r.name}</p>
                  <p className="mt-0.5 text-[10.5px] font-medium text-neutral-400 tnum">{r.users} user{r.users > 1 ? "s" : ""}</p>
                  <p className="mt-1.5 text-[11px] font-medium leading-snug text-neutral-500">{r.scope}</p>
                </button>
              ))}
            </div>
          </div>
        </Anim>
      )}

      {tab === "companies" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "name", label: "Branch" },
              { key: "gstin", label: "GSTIN", mono: true },
              { key: "users", label: "Users", align: "right" },
              { key: "since", label: "Since" },
              { key: "st", label: "Status" },
            ]}
            rows={branchesAdmin.map((b) => ({
              id: b.name,
              cells: [
                <span key="n" className="font-bold text-neutral-900">{b.name}</span>,
                b.gstin, b.users, b.since,
                <StatusChip key="s" label={b.status} tone={b.tone as Tone} />,
              ],
              menu: [{ label: "Edit branch", icon: PencilEdit01Icon }],
            }))}
            searchPlaceholder="Search branches…"
            chips={[]}
          />
        </Anim>
      )}

      {tab === "integrations" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip tone="danger" text="GST / e-invoice credentials expiring — reconnect NIC before filing" cta="Reconnect" />
          <div className="grid gap-4 sm:grid-cols-2">
            {integrations.map((i) => (
              <div key={i.name} className="flex items-center gap-3.5 rounded-2xl bg-white p-5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-bold text-neutral-900">{i.name}</p>
                  <p className="mt-0.5 text-[11.5px] font-medium text-neutral-400">{i.detail}</p>
                </div>
                <StatusChip label={i.status} tone={i.tone as Tone} />
                <button type="button" className="rounded-full bg-neutral-100 px-3 py-1.5 text-[11px] font-semibold text-neutral-600 transition-colors hover:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                  Configure
                </button>
              </div>
            ))}
          </div>
        </Anim>
      )}

      {tab === "audit" && (
        <Anim delay={130}>
          <div className="rounded-2xl bg-white p-3">
            {auditLogs.map((a, i) => (
              <div key={i} className="flex items-center gap-4 rounded-xl px-4 py-3 transition-colors hover:bg-neutral-50">
                <span className="w-12 shrink-0 font-mono text-[11px] font-semibold text-neutral-400 tnum">{a.when}</span>
                <span className="w-20 shrink-0 text-[12px] font-semibold text-neutral-800">{a.who}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-neutral-600">{a.what}</span>
                <span className="shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 text-[10.5px] font-bold text-neutral-500">{a.where}</span>
              </div>
            ))}
          </div>
        </Anim>
      )}

      {tab === "security" && (
        <Anim delay={130}>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { t: "Two-factor authentication", d: "Required for Owner & Finance · optional for others", on: true },
              { t: "Session timeout", d: "Auto-lock after 30 min idle", on: true },
              { t: "IP allowlist", d: "Restrict admin to office network", on: false },
              { t: "Data export audit", d: "Log every CSV/PDF export with user & time", on: true },
            ].map((s) => (
              <div key={s.t} className="flex items-center gap-4 rounded-2xl bg-white p-5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-neutral-100 text-neutral-500">
                  <HugeiconsIcon icon={Shield01Icon} size={19} strokeWidth={1.5} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-neutral-900">{s.t}</p>
                  <p className="mt-0.5 text-[11.5px] font-medium text-neutral-400">{s.d}</p>
                </div>
                <StatusChip label={s.on ? "On" : "Off"} tone={s.on ? "success" : "neutral"} />
              </div>
            ))}
          </div>
        </Anim>
      )}
    </div>
  );
}

export function AdminScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
