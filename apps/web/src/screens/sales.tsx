"use client";

import { Suspense, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowDown01Icon,
  MoneyBag01Icon,
  SentIcon,
  Copy01Icon,
  PrinterIcon,
  Cancel01Icon,
  PencilEdit01Icon,
  UserIcon,
  Call02Icon,
  Message01Icon,
  Invoice01Icon,
  ShoppingCart01Icon,
  CheckmarkCircle01Icon,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, useTab } from "@/components/ui/tabs";
import { DataTable, type Row } from "@/components/ui/data-table";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { StatCards } from "@/components/ui/stat-cards";
import { AlertStrip } from "@/components/ui/alert-strip";
import { Anim } from "@/components/ui/anim";
import { Dropdown } from "@/components/ui/dropdown";
import { Drawer, drawerForms } from "@/components/ui/drawer";
import { ghostBtn, primaryBtn } from "@/components/ui/btn";
import { inr } from "@/lib/format";
import {
  invoices,
  customers,
  salesOrders,
  quotations,
  followUps,
} from "@/lib/mock-modules";
import { SalesTrend } from "@/components/dashboard/sales-trend";

const tabs = [
  { key: "invoices", label: "Invoices", badge: 8 },
  { key: "customers", label: "Customers" },
  { key: "orders", label: "Orders", badge: 5 },
  { key: "quotations", label: "Quotations" },
  { key: "follow-ups", label: "Follow-ups", badge: 3 },
  { key: "analytics", label: "Analytics" },
];

const invoiceMenu = [
  { label: "Record payment", icon: MoneyBag01Icon },
  { label: "Send reminder ✦", icon: SentIcon },
  { label: "Duplicate", icon: Copy01Icon },
  { label: "Print PDF", icon: PrinterIcon },
  "divider" as const,
  { label: "Cancel invoice", icon: Cancel01Icon, danger: true },
];


function Inner() {
  const tab = useTab(tabs);
  const [form, setForm] = useState<string | null>(null);

  const invoiceRows: Row[] = invoices.map((v) => ({
    id: v.id,
    cells: [
      <span key="id" className="font-bold text-primary-600">{v.id}</span>,
      v.date,
      v.customer,
      inr(v.amount),
      <span key="d" className={v.due.startsWith("OVER") ? "font-bold text-danger" : ""}>{v.due}</span>,
      <StatusChip key="s" label={v.status} tone={v.tone as Tone} />,
    ],
    menu: invoiceMenu,
  }));

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="Sales"
        subtitle="Invoices, orders, customers and collections — Delhi HQ +2"
      >
        <Dropdown
          align="right"
          items={[
            { label: "Export CSV", icon: Copy01Icon },
            { label: "Export GSTR-1", icon: Copy01Icon },
          ]}
          trigger={
            <button type="button" className={ghostBtn}>
              Export
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
        <button type="button" onClick={() => setForm("invoice")} className={primaryBtn}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          New Invoice
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "invoices" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="danger"
            text="12 invoices overdue — ₹4.2L outstanding · AI: Sharma Traders responds best Tue morning ✦"
            cta="Send reminders"
          />
          <DataTable
            cols={[
              { key: "id", label: "Invoice" },
              { key: "date", label: "Date" },
              { key: "cust", label: "Customer" },
              { key: "amt", label: "Amount", align: "right" },
              { key: "due", label: "Due" },
              { key: "st", label: "Status" },
            ]}
            rows={invoiceRows}
            searchPlaceholder="Search invoices…"
            chips={["Draft", "Sent", "Partial", "Paid", "Overdue"]}
          />
        </Anim>
      )}

      {tab === "customers" && (
        <Anim delay={130} className="space-y-4">
          <StatCards
            stats={[
              { label: "Active customers", value: "142", hint: "+6 this month" },
              { label: "Total outstanding", value: "₹4.2L", hint: "12 invoices overdue" },
              { label: "Avg collection", value: "11 days", hint: "▲ improved vs Aug" },
              { label: "Lifetime revenue", value: "₹1.8Cr", hint: "FY 2026–27" },
            ]}
          />
          <DataTable
            cols={[
              { key: "name", label: "Customer" },
              { key: "grade", label: "Grade" },
              { key: "city", label: "City" },
              { key: "ltv", label: "Lifetime", align: "right" },
              { key: "out", label: "Outstanding", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={customers.map((c) => ({
              id: c.id,
              cells: [
                <span key="n" className="font-bold text-neutral-900">{c.name}</span>,
                <span key="g" className="rounded-md bg-primary-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-primary-700">{c.grade}</span>,
                c.city,
                inr(c.lifetime),
                <span key="o" className={c.outstanding > 0 ? "font-bold text-danger" : ""}>{inr(c.outstanding)}</span>,
                <StatusChip key="s" label={c.status} tone={c.tone as Tone} />,
              ],
              menu: [
                { label: "Customer 360", icon: UserIcon },
                { label: "Call", icon: Call02Icon },
                { label: "WhatsApp", icon: Message01Icon },
                "divider",
                { label: "Edit", icon: PencilEdit01Icon },
              ],
            }))}
            searchPlaceholder="Search customers…"
            chips={["A-grade", "B-grade", "With outstanding"]}
          />
        </Anim>
      )}

      {tab === "orders" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "id", label: "Order" },
              { key: "date", label: "Date" },
              { key: "cust", label: "Customer" },
              { key: "items", label: "Items", align: "right" },
              { key: "amt", label: "Amount", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={salesOrders.map((o) => ({
              id: o.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{o.id}</span>,
                o.date, o.customer, o.items, inr(o.amount),
                <StatusChip key="s" label={o.status} tone={o.tone as Tone} />,
              ],
              menu: [
                { label: "Convert to invoice", icon: Invoice01Icon },
                { label: "Duplicate", icon: Copy01Icon },
                "divider",
                { label: "Cancel order", icon: Cancel01Icon, danger: true },
              ],
            }))}
            searchPlaceholder="Search orders…"
            chips={["Draft", "Confirmed", "Packed", "Dispatched", "Delivered"]}
          />
        </Anim>
      )}

      {tab === "quotations" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "id", label: "Quotation" },
              { key: "date", label: "Date" },
              { key: "cust", label: "Customer" },
              { key: "amt", label: "Amount", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={quotations.map((qt) => ({
              id: qt.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{qt.id}</span>,
                qt.date, qt.customer, inr(qt.amount),
                <StatusChip key="s" label={qt.status} tone={qt.tone as Tone} />,
              ],
              menu: [
                { label: "Convert to order", icon: ShoppingCart01Icon },
                { label: "Send reminder ✦", icon: SentIcon },
                { label: "Duplicate", icon: Copy01Icon },
              ],
            }))}
            searchPlaceholder="Search quotations…"
            chips={["Sent", "Negotiation", "Accepted", "Expired"]}
          />
        </Anim>
      )}

      {tab === "follow-ups" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="ai"
            text="✦ AI drafted reminders for all 3 overdue accounts — review before sending"
            cta="Review drafts"
          />
          <DataTable
            cols={[
              { key: "id", label: "Invoice" },
              { key: "cust", label: "Customer" },
              { key: "amt", label: "Amount", align: "right" },
              { key: "days", label: "Overdue", align: "right" },
              { key: "last", label: "Last contact" },
              { key: "next", label: "Next action" },
            ]}
            rows={followUps.map((f) => ({
              id: f.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{f.id}</span>,
                f.customer, inr(f.amount),
                <span key="d" className="font-bold text-danger">{f.days}d</span>,
                f.last,
                <span key="n" className="font-semibold text-primary-700">{f.next}</span>,
              ],
              menu: [
                { label: "Send WhatsApp reminder ✦", icon: SentIcon },
                { label: "Log call", icon: Call02Icon },
                { label: "Promise-to-pay", icon: CheckmarkCircle01Icon },
              ],
            }))}
            searchPlaceholder="Search follow-ups…"
            chips={[">30 days", ">45 days", "Promise made"]}
          />
        </Anim>
      )}

      {tab === "analytics" && (
        <Anim delay={130} className="space-y-4">
          <StatCards
            stats={[
              { label: "Revenue MTD", value: "₹42.3L", hint: "▲ 8.2% vs Aug" },
              { label: "Avg order value", value: "₹78.4K", hint: "▲ 4.1%" },
              { label: "Win rate", value: "64%", hint: "quotations → orders" },
              { label: "Forecast Oct", value: "₹48L ✦", hint: "AI · 81% confidence" },
            ]}
          />
          <SalesTrend className="col-span-12" />
        </Anim>
      )}

      <Drawer
        open={form !== null}
        onClose={() => setForm(null)}
        title={form ? drawerForms[form].title : ""}
        fields={form ? drawerForms[form].fields : []}
        submitLabel={form ? drawerForms[form].submitLabel : "Save"}
      />
    </div>
  );
}

export function SalesScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
