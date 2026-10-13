"use client";

import { Suspense, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowDown01Icon,
  Copy01Icon,
  ReceiptIcon,
  BankIcon,
  PencilEdit01Icon,
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
import { expenses, income, budgets } from "@/lib/mock-modules";
import { CashFlow } from "@/components/dashboard/cash-flow";

const tabs = [
  { key: "overview", label: "Overview" },
  { key: "income", label: "Income" },
  { key: "expenses", label: "Expenses", badge: 1 },
  { key: "cash-flow", label: "Cash Flow" },
  { key: "budgets", label: "Budgets" },
  { key: "tax", label: "Tax / GST" },
];

function Inner() {
  const tab = useTab(tabs);
  const [form, setForm] = useState(false);

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="Finance"
        subtitle="Books, expenses, cash flow and tax — FY Apr 2026–Mar 2027"
      >
        <Dropdown
          align="right"
          items={[
            { label: "Export GSTR-1", icon: Copy01Icon },
            { label: "Export P&L PDF", icon: Copy01Icon },
            { label: "Share with CA", icon: Copy01Icon },
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
          New Expense
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "overview" && (
        <Anim delay={130} className="space-y-4">
          <StatCards
            stats={[
              { label: "Income MTD", value: "₹42.3L", hint: "▲ 8.2% vs Aug" },
              { label: "Expenses MTD", value: "₹31.0L", hint: "▼ 3.0%" },
              { label: "Net profit", value: "₹11.3L", hint: "margin 26.7%" },
              { label: "Cash on hand", value: "₹8.2L", hint: "~6 weeks runway" },
            ]}
          />
          <div className="grid gap-5 lg:grid-cols-12">
            <CashFlow className="lg:col-span-8" />
            <div className="rounded-2xl bg-white p-5 lg:col-span-4">
              <p className="text-[13px] font-semibold text-neutral-900">P&L — September</p>
              <div className="mt-4 space-y-3">
                {[
                  ["Income", "₹42.3L", "text-neutral-900"],
                  ["COGS", "−₹24.1L", "text-neutral-500"],
                  ["Expenses", "−₹6.9L", "text-neutral-500"],
                  ["Net profit", "₹11.3L", "text-success-text"],
                  ["Margin", "26.7%", "text-primary-700"],
                ].map(([l, v, c]) => (
                  <div key={l} className="flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold text-neutral-500">{l}</span>
                    <span className={`text-[13px] font-semibold tnum ${c}`}>{v}</span>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-xl bg-ai-surface p-3">
                <p className="flex items-start gap-2 text-[11.5px] font-semibold leading-snug text-ai-text">
                  <HugeiconsIcon icon={ReceiptIcon} size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                  ✦ Expense anomalies: 2 entries look unusual vs history — EXP-0908 is 4× the category median.
                </p>
              </div>
            </div>
          </div>
        </Anim>
      )}

      {tab === "income" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "id", label: "Payment" },
              { key: "date", label: "Date" },
              { key: "from", label: "From" },
              { key: "m", label: "Method" },
              { key: "amt", label: "Amount", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={income.map((i) => ({
              id: i.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{i.id}</span>,
                i.date, i.from, i.method, inr(i.amount),
                <StatusChip key="s" label={i.status} tone={i.tone as Tone} />,
              ],
              menu: [
                { label: "View receipt", icon: ReceiptIcon },
                { label: "Match to invoice", icon: BankIcon },
              ],
            }))}
            searchPlaceholder="Search payments…"
            chips={["NEFT", "UPI", "Cheque", "Clearing"]}
          />
        </Anim>
      )}

      {tab === "expenses" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="ai"
            text="✦ AI flagged EXP-0908 (Office supplies ₹9.8K) — 4× category median"
            cta="Review"
          />
          <DataTable
            cols={[
              { key: "id", label: "Expense" },
              { key: "date", label: "Date" },
              { key: "cat", label: "Category" },
              { key: "ven", label: "Vendor" },
              { key: "amt", label: "Amount", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={expenses.map((e) => ({
              id: e.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{e.id}</span>,
                e.date, e.category, e.vendor, inr(e.amount),
                <StatusChip key="s" label={e.status} tone={e.tone as Tone} />,
              ],
              menu: [
                { label: "View receipt", icon: ReceiptIcon },
                { label: "Recategorize", icon: PencilEdit01Icon },
                "divider",
                { label: "Delete", icon: PencilEdit01Icon, danger: true },
              ],
            }))}
            searchPlaceholder="Search expenses…"
            chips={["Pending", "Flagged", "Approved"]}
          />
        </Anim>
      )}

      {tab === "cash-flow" && (
        <Anim delay={130} className="space-y-4">
          <StatCards
            stats={[
              { label: "Cash on hand", value: "₹8.2L", hint: "across 3 accounts" },
              { label: "Receivables due", value: "₹6.4L", hint: "next 30 days" },
              { label: "Payables due", value: "₹9.1L", hint: "PO-118 batch" },
              { label: "Projected low", value: "₹5.5L", hint: "~12 Oct · AI ✦" },
            ]}
          />
          <CashFlow className="col-span-12" />
        </Anim>
      )}

      {tab === "budgets" && (
        <Anim delay={130}>
          <div className="grid gap-4 sm:grid-cols-2">
            {budgets.map((b) => (
              <div key={b.name} className="rounded-2xl bg-white p-5">
                <div className="flex items-center justify-between">
                  <p className="text-[13.5px] font-bold text-neutral-900">{b.name}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${b.used > 85 ? "bg-warning-surface text-warning-text" : "bg-neutral-100 text-neutral-500"}`}>
                    {b.used}% used
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className={`h-full rounded-full ${b.used > 85 ? "bg-gradient-to-r from-warning to-danger" : "bg-gradient-to-r from-primary-400 to-primary-600"}`}
                    style={{ width: `${b.used}%` }}
                  />
                </div>
                <p className="mt-2 text-[11.5px] font-medium text-neutral-400 tnum">{b.of}</p>
              </div>
            ))}
          </div>
        </Anim>
      )}

      {tab === "tax" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="danger"
            text="GSTR-3B filing due in 5 days — auto-prepared draft is ready"
            cta="Review & file"
          />
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { l: "Output GST (sales)", v: "₹6.4L", h: "GSTR-1 · Sep" },
              { l: "Input credit", v: "₹4.1L", h: "GSTR-2B matched 98%" },
              { l: "Net payable", v: "₹2.3L", h: "GSTR-3B due 20 Sep" },
              { l: "TDS deducted", v: "₹38.4K", h: "Q2 · 194C/194J" },
              { l: "TDS payable", v: "₹12.1K", h: "due 07 Oct" },
              { l: "Advance tax", v: "₹3.4L", h: "Q3 installment" },
            ].map((x) => (
              <div key={x.l} className="rounded-2xl bg-white p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-400">{x.l}</p>
                <p className="mt-1.5 text-[22px] font-bold tracking-tight text-neutral-900 tnum">{x.v}</p>
                <p className="mt-1 text-[11px] font-medium text-neutral-400">{x.h}</p>
              </div>
            ))}
          </div>
        </Anim>
      )}

      <Drawer
        open={form}
        onClose={() => setForm(false)}
        title={drawerForms.expense.title}
        fields={drawerForms.expense.fields}
        submitLabel={drawerForms.expense.submitLabel}
      />
    </div>
  );
}

export function FinanceScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
