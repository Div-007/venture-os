"use client";

import { Suspense, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowDown01Icon,
  Copy01Icon,
  SentIcon,
  PencilEdit01Icon,
  TruckIcon,
  CheckmarkCircle01Icon,
  PackageIcon,
  ShoppingCart01Icon,
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
  purchaseOrders,
  vendors,
  purchaseRequests,
  goodsReceipts,
} from "@/lib/mock-modules";

const tabs = [
  { key: "orders", label: "Purchase Orders", badge: 5 },
  { key: "vendors", label: "Vendors" },
  { key: "requests", label: "Requests", badge: 3 },
  { key: "receipts", label: "Goods Received" },
];

function Inner() {
  const tab = useTab(tabs);
  const [form, setForm] = useState(false);

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="Purchase"
        subtitle="Vendors, purchase orders and goods received"
      >
        <Dropdown
          align="right"
          items={[{ label: "Export CSV", icon: Copy01Icon }]}
          trigger={
            <button type="button" className={ghostBtn}>
              Export
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
        <button type="button" onClick={() => setForm(true)} className={primaryBtn}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          New PO
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "orders" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="warning"
            text="PO-118 awaiting your approval — ₹2.4L to ABC Supplies"
            cta="Review"
            href="/operations"
          />
          <DataTable
            cols={[
              { key: "id", label: "PO" },
              { key: "date", label: "Date" },
              { key: "ven", label: "Vendor" },
              { key: "items", label: "Items", align: "right" },
              { key: "amt", label: "Amount", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={purchaseOrders.map((o) => ({
              id: o.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{o.id}</span>,
                o.date, o.vendor, o.items, inr(o.amount),
                <StatusChip key="s" label={o.status} tone={o.tone as Tone} />,
              ],
              menu: [
                { label: "Send to vendor", icon: SentIcon },
                { label: "Track receipt", icon: TruckIcon },
                { label: "Duplicate", icon: Copy01Icon },
                "divider",
                { label: "Cancel PO", icon: PencilEdit01Icon, danger: true },
              ],
            }))}
            searchPlaceholder="Search POs…"
            chips={["Draft", "Pending approval", "Sent", "Received"]}
          />
        </Anim>
      )}

      {tab === "vendors" && (
        <Anim delay={130} className="space-y-4">
          <StatCards
            stats={[
              { label: "Active vendors", value: "38", hint: "+2 this quarter" },
              { label: "Payables due", value: "₹9.1L", hint: "PO-118 batch" },
              { label: "Avg rating", value: "B+", hint: "AI-rated on delivery & price" },
              { label: "Spend MTD", value: "₹11.4L", hint: "▼ 6% vs Aug" },
            ]}
          />
          <DataTable
            cols={[
              { key: "name", label: "Vendor" },
              { key: "city", label: "City" },
              { key: "rate", label: "Rating" },
              { key: "spend", label: "FY spend", align: "right" },
              { key: "out", label: "Outstanding", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={vendors.map((v) => ({
              id: v.id,
              cells: [
                <span key="n" className="font-bold text-neutral-900">{v.name}</span>,
                v.city,
                <span key="r" className="rounded-md bg-primary-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-primary-700">{v.rating}</span>,
                inr(v.spend),
                v.outstanding > 0 ? <span className="font-bold text-warning-text">{inr(v.outstanding)}</span> : inr(0),
                <StatusChip key="s" label={v.status} tone={v.tone as Tone} />,
              ],
              menu: [
                { label: "Vendor profile", icon: PackageIcon },
                { label: "Price history", icon: Copy01Icon },
                { label: "Rate vendor", icon: CheckmarkCircle01Icon },
              ],
            }))}
            searchPlaceholder="Search vendors…"
            chips={["A-rated", "With payables", "On hold"]}
          />
        </Anim>
      )}

      {tab === "requests" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="ai"
            text="✦ 1 request auto-raised by Inventory (SKU-102 low stock) — one click converts to PO"
            cta="Convert"
          />
          <DataTable
            cols={[
              { key: "id", label: "Request" },
              { key: "item", label: "Item" },
              { key: "by", label: "Raised by" },
              { key: "amt", label: "Est. value", align: "right" },
              { key: "st", label: "Status" },
            ]}
            rows={purchaseRequests.map((r) => ({
              id: r.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{r.id}</span>,
                r.item, r.by, inr(r.amount),
                <StatusChip key="s" label={r.status} tone={r.tone as Tone} />,
              ],
              menu: [
                { label: "Convert to PO", icon: ShoppingCart01Icon },
                { label: "Request changes", icon: PencilEdit01Icon },
              ],
            }))}
            searchPlaceholder="Search requests…"
            chips={["Awaiting PO", "Approved", "Converted"]}
          />
        </Anim>
      )}

      {tab === "receipts" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "id", label: "GRN" },
              { key: "po", label: "PO" },
              { key: "ven", label: "Vendor" },
              { key: "date", label: "Received" },
              { key: "items", label: "Items" },
              { key: "st", label: "QC" },
            ]}
            rows={goodsReceipts.map((g) => ({
              id: g.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{g.id}</span>,
                g.po, g.vendor, g.date, g.items,
                <StatusChip key="s" label={g.status} tone={g.tone as Tone} />,
              ],
              menu: [
                { label: "View QC photos", icon: PackageIcon },
                { label: "Raise discrepancy", icon: PencilEdit01Icon },
              ],
            }))}
            searchPlaceholder="Search GRNs…"
            chips={["QC passed", "Partial", "Disputed"]}
          />
        </Anim>
      )}

      <Drawer
        open={form}
        onClose={() => setForm(false)}
        title={drawerForms.po.title}
        fields={drawerForms.po.fields}
        submitLabel={drawerForms.po.submitLabel}
      />
    </div>
  );
}

export function PurchaseScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
