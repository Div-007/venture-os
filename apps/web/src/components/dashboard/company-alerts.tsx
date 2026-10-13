import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertTriangle,
  AiMagicIcon,
} from "@hugeicons/core-free-icons";
import { Widget } from "./widget";
import { companyAlerts } from "@/lib/mock-data";

const ctaHref: Record<string, string> = {
  "Prepare": "/finance?tab=tax",
  "View stock": "/inventory?tab=alerts",
  "Review": "/finance?tab=expenses",
};

const sev = {
  danger: {
    icon: Alert02Icon,
    chip: "bg-danger-surface text-danger-text",
    iconCls: "text-danger",
    row: "bg-danger-surface/40",
  },
  warning: {
    icon: AlertTriangle,
    chip: "bg-warning-surface text-warning-text",
    iconCls: "text-warning",
    row: "bg-warning-surface/40",
  },
  ai: {
    icon: AiMagicIcon,
    chip: "bg-ai-surface text-ai-text",
    iconCls: "text-ai",
    row: "bg-ai-surface/40",
  },
} as const;

/** Widget ⑮ — Company alerts strip. */
export function CompanyAlerts({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <Widget
      title="Company Alerts"
      delay={delay}
      footer={{ label: "All alerts", href: "/dashboard" }}
      className={className}
    >
      <ul className="space-y-2">
        {companyAlerts.map((a) => {
          const s = sev[a.sev];
          return (
            <li
              key={a.text}
              className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 ${s.row}`}
            >
              <HugeiconsIcon icon={s.icon} size={15} strokeWidth={1.75} className={s.iconCls} />
              <p className="flex-1 text-[12px] font-semibold leading-4.5 text-neutral-700">
                {a.text}
              </p>
              <a
                href={ctaHref[a.cta]}
                className={`rounded-full bg-white/80 px-2.5 py-1 text-[10.5px] font-bold transition-[background-color,transform] duration-150 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96] ${s.chip.split(" ")[1]}`}
              >
                {a.cta}
              </a>
            </li>
          );
        })}
      </ul>
    </Widget>
  );
}
