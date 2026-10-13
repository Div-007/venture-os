import { HugeiconsIcon } from "@hugeicons/react";
import { AlertTriangle, AiMagicIcon } from "@hugeicons/core-free-icons";
import { Widget } from "./widget";
import { pendingPayments } from "@/lib/mock-data";
import { inrCompact } from "@/lib/format";

/** Widget ⑦ — Pending payments / overdue receivables. */
export function PendingPayments({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <Widget
      title="Pending Payments"
      delay={delay}
      footer={{ label: "All receivables", href: "/sales?tab=follow-ups" }}
      className={className}
    >
      <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-danger-surface px-2.5 py-1 text-[11.5px] font-bold text-danger-text tnum">
        <HugeiconsIcon icon={AlertTriangle} size={13} strokeWidth={1.75} />
        12 overdue · ₹4.2L outstanding
      </p>
      <ul className="space-y-2.5">
        {pendingPayments.map((p) => (
          <li
            key={p.name}
            className="flex items-center justify-between gap-2"
          >
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-semibold text-neutral-800">
                {p.name}
              </p>
              <p className="text-[11px] font-medium text-danger-text tnum">
                {p.days}d late
              </p>
            </div>
            <span className="text-[13px] font-semibold text-neutral-900 tnum">
              {inrCompact(p.amount)}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-3.5 inline-flex items-center gap-1.5 rounded-full bg-ai-surface px-3 py-1.5 text-[11.5px] font-bold text-ai-text transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai active:scale-[0.96]"
      >
        <HugeiconsIcon icon={AiMagicIcon} size={13} strokeWidth={1.75} />
        Send all reminders — AI draft
      </button>
    </Widget>
  );
}
