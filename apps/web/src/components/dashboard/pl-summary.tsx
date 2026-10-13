import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRightIcon } from "@hugeicons/core-free-icons";
import { Widget } from "./widget";
import { plSummary } from "@/lib/mock-data";
import { inrCompact } from "@/lib/format";

/** Widget ② — Profit/Loss summary. */
export function PlSummary({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <Widget
      title="Profit / Loss"
      delay={delay}
      period="This Month"
      footer={{ label: "P&L report", href: "/finance" }}
      className={className}
    >
      <ul className="space-y-2">
        {plSummary.map((r) => (
          <li
            key={r.label}
            className="flex items-baseline justify-between text-[13px]"
          >
            <span className="font-medium text-neutral-500">{r.label}</span>
            <span className="font-semibold text-neutral-800 tnum">
              {r.value < 0 ? `−${inrCompact(-r.value)}` : inrCompact(r.value)}
            </span>
          </li>
        ))}
      </ul>
      <div className="my-3" />
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-neutral-800">Net Profit</span>
        <span className="flex items-center gap-1.5">
          <span className="text-[19px] font-bold text-neutral-900 tnum">
            ₹11.3L
          </span>
          <span className="inline-flex items-center gap-0.5 rounded-full bg-success-surface px-2 py-0.5 text-[10.5px] font-bold text-success-text tnum">
            <HugeiconsIcon icon={ArrowUpRightIcon} size={11} strokeWidth={2} /> 15%
          </span>
        </span>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-neutral-500">Margin</span>
        <span className="text-[13px] font-semibold text-primary-700 tnum">26.7%</span>
      </div>
    </Widget>
  );
}
