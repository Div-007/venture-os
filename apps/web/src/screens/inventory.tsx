"use client";

import { Suspense, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PlusSignIcon,
  ArrowDown01Icon,
  Exchange01Icon,
  PencilEdit01Icon,
  WarehouseIcon,
  AlertTriangle,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, useTab } from "@/components/ui/tabs";
import { DataTable } from "@/components/ui/data-table";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { AlertStrip } from "@/components/ui/alert-strip";
import { Anim } from "@/components/ui/anim";
import { Dropdown } from "@/components/ui/dropdown";
import { Drawer } from "@/components/ui/drawer";
import { ghostBtn, primaryBtn } from "@/components/ui/btn";
import { inr } from "@/lib/format";
import { stock, stockAlerts, warehouses, transfers } from "@/lib/mock-modules";

const tabs = [
  { key: "stock", label: "Stock" },
  { key: "alerts", label: "Low Stock Alerts", badge: 3 },
  { key: "transfers", label: "Transfers" },
  { key: "warehouses", label: "Warehouses" },
];

function Inner() {
  const tab = useTab(tabs);
  const [form, setForm] = useState(false);

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="Inventory"
        subtitle="Stock levels, batches and transfers across 3 warehouses"
      >
        <Dropdown
          align="right"
          items={[
            { label: "All warehouses", icon: WarehouseIcon },
            { label: "Delhi HQ", icon: WarehouseIcon },
            { label: "Jaipur", icon: WarehouseIcon },
            { label: "Lucknow", icon: WarehouseIcon },
          ]}
          trigger={
            <button type="button" className={ghostBtn}>
              Warehouse: All
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.75} className="text-neutral-400" />
            </button>
          }
        />
        <button type="button" onClick={() => setForm(true)} className={primaryBtn}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} />
          Stock Entry
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "stock" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="warning"
            text="8 items below reorder level · 3 batches expiring <30d"
            cta="View alerts"
          />
          <DataTable
            cols={[
              { key: "sku", label: "SKU" },
              { key: "item", label: "Item" },
              { key: "whs", label: "Whs" },
              { key: "hand", label: "In hand", align: "right" },
              { key: "res", label: "Reserved", align: "right" },
              { key: "avail", label: "Available", align: "right" },
              { key: "reo", label: "Reorder", align: "right" },
              { key: "st", label: "Status" },
              { key: "val", label: "Value", align: "right" },
            ]}
            rows={stock.map((s) => ({
              id: s.sku,
              cells: [
                <span key="k" className="font-mono text-[11.5px] font-bold text-primary-600">{s.sku}</span>,
                <span key="i" className="font-bold text-neutral-900">{s.item}</span>,
                s.whs, s.inHand, s.reserved,
                <span key="a" className="font-bold">{s.avail}</span>,
                s.reorder,
                <StatusChip key="s" label={s.status} tone={s.tone as Tone} />,
                inr(s.val),
              ],
              menu: [
                { label: "Transfer", icon: Exchange01Icon },
                { label: "Adjust", icon: PencilEdit01Icon },
                { label: "Demand forecast ✦", icon: AlertTriangle },
                { label: "Price history", icon: WarehouseIcon },
              ],
            }))}
            searchPlaceholder="Search items, SKU, barcode…"
            chips={["Low", "Out", "Expiring"]}
          />
        </Anim>
      )}

      {tab === "alerts" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="ai"
            text="✦ AI demand forecast: SKU-102 demand rising before Diwali — suggested reorder 250 units"
            cta="Create request"
          />
          <DataTable
            cols={[
              { key: "sku", label: "SKU" },
              { key: "item", label: "Item" },
              { key: "issue", label: "Issue" },
              { key: "sev", label: "Severity" },
            ]}
            rows={stockAlerts.map((a) => ({
              id: a.sku + a.issue,
              cells: [
                <span key="k" className="font-mono text-[11.5px] font-bold text-primary-600">{a.sku}</span>,
                <span key="i" className="font-bold text-neutral-900">{a.item}</span>,
                a.issue,
                <StatusChip key="s" label={a.sev === "danger" ? "Critical" : "Warning"} tone={a.sev as Tone} />,
              ],
              menu: [
                { label: "Create purchase request", icon: PlusSignIcon },
                { label: "Snooze 7 days", icon: PencilEdit01Icon },
              ],
            }))}
            searchPlaceholder="Search alerts…"
            chips={["Critical", "Expiring"]}
          />
        </Anim>
      )}

      {tab === "transfers" && (
        <Anim delay={130}>
          <DataTable
            cols={[
              { key: "id", label: "Transfer" },
              { key: "from", label: "From" },
              { key: "to", label: "To" },
              { key: "items", label: "Items" },
              { key: "date", label: "Date" },
              { key: "st", label: "Status" },
            ]}
            rows={transfers.map((t) => ({
              id: t.id,
              cells: [
                <span key="i" className="font-bold text-primary-600">{t.id}</span>,
                t.from, t.to, t.items, t.date,
                <StatusChip key="s" label={t.status} tone={t.tone as Tone} />,
              ],
              menu: [
                { label: "Track", icon: Exchange01Icon },
                { label: "Mark received", icon: PencilEdit01Icon },
              ],
            }))}
            searchPlaceholder="Search transfers…"
            chips={["In transit", "Received"]}
          />
        </Anim>
      )}

      {tab === "warehouses" && (
        <Anim delay={130}>
          <div className="grid gap-4 sm:grid-cols-3">
            {warehouses.map((w) => (
              <div key={w.id} className="rounded-2xl bg-white p-5">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary-50 text-primary-600">
                    <HugeiconsIcon icon={WarehouseIcon} size={18} strokeWidth={1.5} />
                  </span>
                  <div>
                    <p className="text-[13.5px] font-bold text-neutral-900">{w.name}</p>
                    <p className="text-[11px] font-medium text-neutral-400">{w.id} · {w.manager}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <p className="text-[20px] font-bold tracking-tight text-neutral-900 tnum">
                    {w.items} <span className="text-[12px] font-semibold text-neutral-400">SKUs</span>
                  </p>
                  <p className="text-[11px] font-semibold text-neutral-500 tnum">{w.util}% utilized</p>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary-400 to-primary-600"
                    style={{ width: `${w.util}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Anim>
      )}

      <Drawer
        open={form}
        onClose={() => setForm(false)}
        title="Stock Entry"
        fields={[
          { label: "Item / SKU", placeholder: "Search SKU or scan…" },
          { label: "Warehouse", placeholder: "Delhi HQ" },
          { label: "Quantity", placeholder: "0" },
          { label: "Batch / Expiry", placeholder: "B-2291 · 05 Oct (optional)" },
        ]}
        submitLabel="Save entry"
      />
    </div>
  );
}

export function InventoryScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
