import { Widget } from "./widget";
import { monthlyTargets } from "@/lib/mock-data";

/** Widget ⑭ — Monthly targets progress. */
export function MonthlyTargets({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <Widget
      title="Monthly Targets"
      delay={delay}
      footer={{ label: "All targets", href: "/dashboard" }}
      className={className}
    >
      <ul className="space-y-4 pt-1">
        {monthlyTargets.map((t) => (
          <li key={t.label}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[12.5px] font-semibold text-neutral-700">
                {t.label}
              </span>
              <span className="text-[11px] font-medium text-neutral-400 tnum">
                {t.of}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-neutral-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary-500 to-primary-600"
                style={{
                  width: `${t.pct}%`,
                  transition: "width 600ms cubic-bezier(0.23,1,0.32,1)",
                }}
              />
            </div>
            <p className="mt-1 text-right text-[11px] font-semibold text-primary-700 tnum">
              {t.pct}%
            </p>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
