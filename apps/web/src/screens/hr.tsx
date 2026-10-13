"use client";

import { Suspense, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowDown01Icon,
  UserIcon,
  PencilEdit01Icon,
  IdIcon,
  Copy01Icon,
  CheckmarkCircle01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, useTab } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { StatCards } from "@/components/ui/stat-cards";
import { AlertStrip } from "@/components/ui/alert-strip";
import { Anim } from "@/components/ui/anim";
import { Dropdown } from "@/components/ui/dropdown";
import { Drawer, drawerForms } from "@/components/ui/drawer";
import { ghostBtn, primaryBtn } from "@/components/ui/btn";
import { inr } from "@/lib/format";
import {
  employees,
  attendance,
  leaveRequests,
  payroll,
  recruitment,
} from "@/lib/mock-modules";

const tabs = [
  { key: "employees", label: "Employees", badge: 6 },
  { key: "attendance", label: "Attendance" },
  { key: "leave", label: "Leave", badge: 2 },
  { key: "payroll", label: "Payroll" },
  { key: "recruitment", label: "Recruitment" },
];

function Inner() {
  const tab = useTab(tabs);
  const [form, setForm] = useState(false);

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="HR"
        subtitle="People, attendance, leave and payroll"
      >
        <Dropdown
          align="right"
          items={[
            { label: "Attendance report", icon: Copy01Icon },
            { label: "Payroll register", icon: Copy01Icon },
          ]}
          trigger={
            <button type="button" className={ghostBtn}>
              Export
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
        <button type="button" onClick={() => setForm(true)} className={primaryBtn}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          Add Employee
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "employees" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "name", label: "Employee" },
              { key: "role", label: "Role" },
              { key: "br", label: "Branch" },
              { key: "sal", label: "Salary", align: "right" },
              { key: "lv", label: "Leave balance" },
              { key: "st", label: "Status" },
            ]}
            rows={employees.map((e) => ({
              id: e.id,
              cells: [
                <span key="n" className="flex items-center gap-2.5">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary-400 to-primary-600 text-[9.5px] font-bold text-white">
                    {e.name.split(" ").map((w) => w[0]).join("")}
                  </span>
                  <span>
                    <span className="block font-bold text-neutral-900">{e.name}</span>
                    <span className="block font-mono text-[10px] text-neutral-400">{e.id}</span>
                  </span>
                </span>,
                e.role, e.branch, inr(e.salary),
                <span key="l" className="text-[11.5px] text-neutral-500 tnum">{e.leave}</span>,
                <StatusChip key="s" label={e.status} tone={e.tone as Tone} />,
              ],
              menu: [
                { label: "Profile", icon: UserIcon },
                { label: "ID card ⤓", icon: IdIcon },
                "divider",
                { label: "Edit", icon: PencilEdit01Icon },
              ],
            }))}
            searchPlaceholder="Search employees…"
            chips={["Delhi", "Jaipur", "On leave"]}
          />
        </Anim>
      )}

      {tab === "attendance" && (
        <Anim delay={130} className="space-y-4">
          <StatCards
            stats={[
              { label: "Present today", value: "38/42", hint: "2 on leave · 1 late" },
              { label: "Punctuality", value: "91%", hint: "▲ 4% vs Aug" },
              { label: "Overtime MTD", value: "124h", hint: "Mohan: 18h" },
              { label: "Absent w/o leave", value: "0", hint: "this month" },
            ]}
          />
          <DataTable
            cols={[
              { key: "name", label: "Employee" },
              { key: "p", label: "Present" },
              { key: "late", label: "Late days" },
              { key: "ot", label: "Overtime" },
              { key: "st", label: "Today" },
            ]}
            rows={attendance.map((a) => ({
              id: a.name,
              cells: [
                <span key="n" className="font-bold text-neutral-900">{a.name}</span>,
                <span key="p" className="tnum">{a.present}</span>,
                a.late, a.ot,
                <StatusChip key="s" label={a.status} tone={a.tone as Tone} />,
              ],
              menu: [{ label: "View calendar", icon: CheckmarkCircle01Icon }],
            }))}
            searchPlaceholder="Search attendance…"
            chips={["Late", "Overtime"]}
          />
        </Anim>
      )}

      {tab === "leave" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="warning"
            text="2 leave requests pending — R. Meena (CL, 18–20 Sep) overlaps with 1 other sales leave"
            cta="Review"
          />
          <DataTable
            cols={[
              { key: "id", label: "Request" },
              { key: "name", label: "Employee" },
              { key: "type", label: "Type" },
              { key: "dates", label: "Dates" },
              { key: "days", label: "Days", align: "right" },
              { key: "why", label: "Reason" },
              { key: "st", label: "Status" },
            ]}
            rows={leaveRequests.map((l) => ({
              id: l.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{l.id}</span>,
                l.name, l.type, l.dates, l.days, l.reason,
                <StatusChip key="s" label={l.status} tone={l.tone as Tone} />,
              ],
              menu: [
                { label: "Approve", icon: CheckmarkCircle01Icon },
                { label: "Reject", icon: Cancel01Icon, danger: true },
              ],
            }))}
            searchPlaceholder="Search leave…"
            chips={["Pending", "Approved", "Rejected"]}
          />
        </Anim>
      )}

      {tab === "payroll" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="warning"
            text="September payroll due in 2 days — 1 employee on hold (bank a/c unverified)"
            cta="Run payroll"
          />
          <DataTable
            cols={[
              { key: "name", label: "Employee" },
              { key: "gross", label: "Gross", align: "right" },
              { key: "pf", label: "PF", align: "right" },
              { key: "tds", label: "TDS", align: "right" },
              { key: "net", label: "Net pay", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={payroll.map((p) => ({
              id: p.name,
              cells: [
                <span key="n" className="font-bold text-neutral-900">{p.name}</span>,
                inr(p.gross), inr(p.pf), inr(p.tds),
                <span key="net" className="font-bold text-neutral-900">{inr(p.net)}</span>,
                <StatusChip key="s" label={p.status} tone={p.tone as Tone} />,
              ],
              menu: [
                { label: "Payslip PDF", icon: IdIcon },
                { label: "Salary structure", icon: PencilEdit01Icon },
              ],
            }))}
            searchPlaceholder="Search payroll…"
            chips={["Ready", "On hold", "Paid"]}
          />
        </Anim>
      )}

      {tab === "recruitment" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="ai"
            text="✦ AI resume screening: 12 of 34 applicants shortlisted for Sales Executive — Jaipur"
            cta="Review shortlist"
          />
          <DataTable
            cols={[
              { key: "id", label: "Job" },
              { key: "role", label: "Role" },
              { key: "app", label: "Applicants", align: "right" },
              { key: "stage", label: "Stage" },
              { key: "st", label: "Status" },
            ]}
            rows={recruitment.map((r) => ({
              id: r.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{r.id}</span>,
                <span key="r" className="font-bold text-neutral-900">{r.role}</span>,
                r.applicants, r.stage,
                <StatusChip key="s" label={r.status} tone={r.tone as Tone} />,
              ],
              menu: [
                { label: "View pipeline", icon: UserIcon },
                { label: "Close job", icon: Cancel01Icon },
              ],
            }))}
            searchPlaceholder="Search jobs…"
            chips={["Open", "Closing"]}
          />
        </Anim>
      )}

      <Drawer
        open={form}
        onClose={() => setForm(false)}
        title={drawerForms.employee.title}
        fields={drawerForms.employee.fields}
        submitLabel={drawerForms.employee.submitLabel}
      />
    </div>
  );
}

export function HrScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
