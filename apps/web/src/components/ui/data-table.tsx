"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon, Search01Icon } from "@hugeicons/core-free-icons";
import clsx from "clsx";
import { Dropdown, type MenuItem } from "./dropdown";

export type Col = {
  key: string;
  label: string;
  align?: "left" | "right";
  mono?: boolean;
  w?: string;
};

export type Row = {
  id: string;
  cells: React.ReactNode[];
  href?: string;
  menu?: (MenuItem | "divider")[];
};

/** List-page workhorse: search + filter chips + flat table + row menus. */
export function DataTable({
  cols,
  rows,
  searchPlaceholder = "Search…",
  chips = [],
}: {
  cols: Col[];
  rows: Row[];
  searchPlaceholder?: string;
  chips?: string[];
}) {
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("All");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const filtered = rows.filter((r) =>
    q ? JSON.stringify(r.cells).toLowerCase().includes(q.toLowerCase()) : true
  );

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
      }
      return n;
    });

  return (
    <div className="rounded-2xl bg-white">
      {/* filter bar */}
      <div className="flex items-center gap-2.5 px-4 py-3">
        <div className="flex h-9 min-w-0 max-w-64 flex-1 items-center gap-2 rounded-full bg-neutral-100 px-3.5 transition-[background-color] duration-150 focus-within:bg-white focus-within:ring-2 focus-within:ring-primary-600/25">
          <HugeiconsIcon
            icon={Search01Icon}
            size={15}
            strokeWidth={1.5}
            className="shrink-0 text-neutral-400"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full bg-transparent text-[12.5px] font-medium text-neutral-800 placeholder:text-neutral-400 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 overflow-x-auto">
          {["All", ...chips].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChip(c)}
              className={clsx(
                "whitespace-nowrap rounded-full px-3 py-1.5 text-[11.5px] font-bold",
                "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]",
                chip === c
                  ? "bg-primary-700 text-white"
                  : "bg-neutral-100 text-neutral-500 hover:text-neutral-800"
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-neutral-50/80">
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={sel.size === filtered.length && filtered.length > 0}
                  onChange={() =>
                    setSel(
                      sel.size === filtered.length
                        ? new Set()
                        : new Set(filtered.map((r) => r.id))
                    )
                  }
                  className="h-3.5 w-3.5 rounded accent-primary-600"
                />
              </th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  style={c.w ? { width: c.w } : undefined}
                  className={clsx(
                    "px-3 py-2.5 text-[10.5px] font-bold uppercase tracking-[0.07em] text-neutral-400",
                    c.align === "right" && "text-right"
                  )}
                >
                  {c.label}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                className={clsx(
                  "group cursor-pointer transition-colors duration-100 hover:bg-neutral-50",
                  sel.has(r.id) && "bg-primary-50/50"
                )}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select row"
                    checked={sel.has(r.id)}
                    onChange={() => toggle(r.id)}
                    className="h-3.5 w-3.5 rounded accent-primary-600"
                  />
                </td>
                {r.cells.map((cell, i) => (
                  <td
                    key={i}
                    className={clsx(
                      "px-3 py-3 text-[12.5px] font-medium text-neutral-700",
                      cols[i].align === "right" && "text-right tnum",
                      cols[i].mono && "font-mono text-[12px]"
                    )}
                  >
                    {cell}
                  </td>
                ))}
                <td className="pr-3 text-right">
                  {r.menu && (
                    <Dropdown
                      align="right"
                      items={r.menu}
                      trigger={
                        <span className="inline-grid h-7 w-7 place-items-center rounded-full text-neutral-300 transition-[color,background-color] duration-100 hover:bg-neutral-100 hover:text-neutral-600 group-hover:text-neutral-500">
                          <HugeiconsIcon
                            icon={MoreHorizontalIcon}
                            size={16}
                            strokeWidth={1.75}
                          />
                        </span>
                      }
                    />
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={cols.length + 2}
                  className="px-4 py-10 text-center text-[12.5px] font-medium text-neutral-400"
                >
                  No results for &ldquo;{q}&rdquo; —{" "}
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    className="font-bold text-primary-600 hover:text-primary-700"
                  >
                    clear search
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* footer */}
      <div className="flex items-center justify-between px-4 py-3 text-[11px] font-medium text-neutral-400">
        <span className="tnum">
          Showing {filtered.length} of {rows.length}
          {sel.size > 0 && ` · ${sel.size} selected`}
        </span>
        <span className="tnum">‹ 1 2 3 ›</span>
      </div>
    </div>
  );
}
