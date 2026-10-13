"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Checkmark } from "@hugeicons/core-free-icons";
import { Widget } from "./widget";
import { pendingApprovals } from "@/lib/mock-data";

/** Widget ⑧ — Pending approvals with inline approve/reject. */
export function PendingApprovals({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  const [items, setItems] = useState(pendingApprovals);

  const act = (id: number) =>
    setItems((list) => list.filter((i) => i.id !== id));

  return (
    <Widget
      title="Pending Approvals"
      delay={delay}
      footer={{ label: "Open inbox", href: "/operations" }}
      className={className}
    >
      <p className="mb-2.5 text-[11.5px] font-semibold text-neutral-500">
        <span className="text-neutral-900 tnum">{items.length}</span> waiting on
        you
      </p>
      <ul className="space-y-1">
        {items.length === 0 && (
          <li className="rounded-xl bg-success-surface px-3 py-2.5 text-[12px] font-semibold text-success-text">
            All clear — nothing needs you right now.
          </li>
        )}
        {items.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-2 rounded-xl px-1.5 py-1.5 transition-colors duration-150 hover:bg-neutral-50"
          >
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-semibold text-neutral-800">
                {a.title}
              </p>
              <p className="truncate text-[11px] font-medium text-neutral-400">
                {a.sub}
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={() => act(a.id)}
                aria-label={`Approve ${a.title}`}
                className="grid h-7.5 w-7.5 place-items-center rounded-full bg-success-surface p-2 text-success-text transition-[background-color,transform] duration-150 hover:bg-[#dcfce7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success active:scale-[0.96]"
              >
                <HugeiconsIcon icon={Checkmark} size={14} strokeWidth={2.25} />
              </button>
              <button
                type="button"
                onClick={() => act(a.id)}
                aria-label={`Reject ${a.title}`}
                className="grid h-7.5 w-7.5 place-items-center rounded-full bg-danger-surface p-2 text-danger-text transition-[background-color,transform] duration-150 hover:bg-[#fee2e2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger active:scale-[0.96]"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2.25} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
