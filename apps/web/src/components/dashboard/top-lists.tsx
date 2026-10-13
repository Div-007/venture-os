import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertTriangle,
  AiMagicIcon,
} from "@hugeicons/core-free-icons";
import { Widget } from "./widget";
import { topCustomers, topRisks, topVendors } from "@/lib/mock-data";
import { inrCompact } from "@/lib/format";

function RankedList({
  items,
  delay,
  title,
  href,
  className,
}: {
  items: { name: string; value: number }[];
  delay: number;
  title: string;
  href: string;
  className?: string;
}) {
  return (
    <Widget
      title={title}
      delay={delay}
      footer={{ label: "View all", href }}
      className={className}
    >
      <ul className="space-y-2">
        {items.map((it, i) => (
          <li key={it.name} className="flex items-center gap-2.5">
            <span className="grid h-5.5 w-5.5 shrink-0 place-items-center rounded-full bg-primary-50 text-[10px] font-semibold text-primary-700 tnum">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-neutral-700">
              {it.name}
            </span>
            <span className="text-[12.5px] font-bold text-neutral-900 tnum">
              {inrCompact(it.value)}
            </span>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

export function TopCustomers({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <RankedList
      items={topCustomers}
      title="Top Customers"
      href="/sales?tab=customers"
      delay={delay}
      className={className}
    />
  );
}

export function TopVendors({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <RankedList
      items={topVendors}
      title="Top Vendors"
      href="/purchase?tab=vendors"
      delay={delay}
      className={className}
    />
  );
}

const riskIcon = {
  danger: { icon: Alert02Icon, cls: "text-danger", bg: "bg-danger-surface" },
  warning: { icon: AlertTriangle, cls: "text-warning", bg: "bg-warning-surface" },
} as const;

/** Widget ⑥ — Top risks. */
export function TopRisks({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <Widget
      title="Top Risks"
      delay={delay}
      footer={{ label: "Explain each", href: "/ai/chat" }}
      className={className}
    >
      <ul className="space-y-2.5">
        {topRisks.map((r) => {
          const s = riskIcon[r.sev];
          return (
            <li key={r.text} className="flex items-start gap-2.5">
              <span
                className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg ${s.bg}`}
              >
                <HugeiconsIcon icon={s.icon} size={13} strokeWidth={1.75} className={s.cls} />
              </span>
              <p className="text-[12px] font-medium leading-4.5 text-neutral-700">
                {r.text}
              </p>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="mt-3.5 inline-flex items-center gap-1.5 rounded text-[11.5px] font-bold text-ai-text transition-colors duration-150 hover:text-ai focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai"
      >
        <HugeiconsIcon icon={AiMagicIcon} size={13} strokeWidth={1.75} />
        Ask AI to explain
      </button>
    </Widget>
  );
}
