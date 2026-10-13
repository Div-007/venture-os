"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import clsx from "clsx";

export type DrawerField = { label: string; placeholder: string; half?: boolean };

/** Right-side create drawer (§5.5 simple-create pattern). */
const subscribe = () => () => {};

function useDrawerHost() {
  return useSyncExternalStore(
    subscribe,
    () => document.getElementById("drawer-root"),
    () => null
  );
}

export function Drawer({
  open,
  onClose,
  title,
  fields,
  submitLabel = "Save",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: DrawerField[];
  submitLabel?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const tree = (
    <>
      {/* scrim */}
      <div
        aria-hidden
        onClick={onClose}
        className={clsx(
          "absolute inset-0 z-40 bg-neutral-900/20 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <aside
        aria-hidden={!open}
        className={clsx(
          "absolute bottom-0 right-0 top-0 z-50 flex w-[440px] max-w-[92%] flex-col bg-white",
          "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-[15px] font-bold tracking-tight text-neutral-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 transition-[color,background-color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="thin-scroll flex-1 space-y-4 overflow-y-auto px-5 pb-4">
          {fields.map((f) => (
            <label key={f.label} className="block">
              <span className="mb-1.5 block text-[11.5px] font-bold text-neutral-600">
                {f.label}
              </span>
              <input
                type="text"
                placeholder={f.placeholder}
                className="h-11 w-full rounded-xl bg-neutral-100 px-3.5 text-[13px] font-medium text-neutral-800 placeholder:text-neutral-400 transition-[background-color] duration-150 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-600/30"
              />
            </label>
          ))}
          <p className="rounded-xl bg-neutral-50 px-3.5 py-2.5 text-[11px] font-medium text-neutral-400">
            Auto-saves as draft every 30s. Required fields marked in the final form.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-[12.5px] font-bold text-neutral-500 transition-[color,background-color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-primary-600 px-4 py-2 text-[12.5px] font-bold text-white transition-[background-color,transform] duration-150 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 active:scale-[0.97]"
          >
            {submitLabel}
          </button>
        </div>
      </aside>
    </>
  );

  const host = useDrawerHost();
  return host ? createPortal(tree, host) : null;
}

/** Field presets for the quick actions. */
export const drawerForms: Record<string, { title: string; fields: DrawerField[]; submitLabel: string }> = {
  invoice: {
    title: "New Invoice",
    submitLabel: "Save & Send",
    fields: [
      { label: "Customer", placeholder: "Search customer…" },
      { label: "Invoice #", placeholder: "INV-0236", half: true },
      { label: "Due date", placeholder: "30 Sep 2026 (Net 15)", half: true },
      { label: "Amount", placeholder: "₹ 0.00" },
      { label: "Notes / Terms", placeholder: "Payment terms…" },
    ],
  },
  order: {
    title: "New Sales Order",
    submitLabel: "Create order",
    fields: [
      { label: "Customer", placeholder: "Search customer…" },
      { label: "Items", placeholder: "Search SKU / name…" },
      { label: "Delivery date", placeholder: "20 Sep 2026" },
      { label: "Notes", placeholder: "Optional" },
    ],
  },
  expense: {
    title: "New Expense",
    submitLabel: "Save expense",
    fields: [
      { label: "Category", placeholder: "Logistics, utilities…" },
      { label: "Vendor / Payee", placeholder: "Who was paid?" },
      { label: "Amount", placeholder: "₹ 0.00" },
      { label: "Receipt", placeholder: "Attach or scan…" },
    ],
  },
  employee: {
    title: "Add Employee",
    submitLabel: "Send invite",
    fields: [
      { label: "Full name", placeholder: "e.g. Ramesh Meena" },
      { label: "Role", placeholder: "Sales Executive…" },
      { label: "Branch", placeholder: "Delhi HQ" },
      { label: "Phone", placeholder: "98xxx xxxxx" },
      { label: "Monthly salary", placeholder: "₹ 42,000" },
    ],
  },
  po: {
    title: "New Purchase Order",
    submitLabel: "Send for approval",
    fields: [
      { label: "Vendor", placeholder: "Search vendor…" },
      { label: "Items", placeholder: "Search SKU / name…" },
      { label: "Expected by", placeholder: "25 Sep 2026" },
      { label: "Notes", placeholder: "Optional" },
    ],
  },
  customer: {
    title: "New Customer",
    submitLabel: "Create customer",
    fields: [
      { label: "Business name", placeholder: "e.g. Sharma Traders" },
      { label: "GSTIN", placeholder: "07AAB… (optional)" },
      { label: "Phone", placeholder: "98xxx xxxxx" },
      { label: "City / Branch", placeholder: "Delhi" },
    ],
  },
};
