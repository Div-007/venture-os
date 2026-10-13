import { Widget } from "./widget";
import { branches } from "@/lib/mock-data";
import { inrCompact } from "@/lib/format";

const segs = ["bg-primary-600", "bg-primary-400", "bg-primary-200"];
const dots = ["bg-primary-600", "bg-primary-400", "bg-primary-200"];

/** Widget ⑬ — Branch comparison as a segmented breakdown bar. */
export function BranchComparison({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <Widget
      title="Branch Comparison"
      delay={delay}
      period="This Month"
      footer={{ label: "Compare MoM", href: "/dashboard" }}
      className={className}
    >
      {/* stacked segmented bar */}
      <div className="flex h-3.5 w-full gap-1 overflow-hidden pt-1">
        {branches.map((b, i) => (
          <div
            key={b.name}
            className={`h-full rounded-full ${segs[i]}`}
            style={{
              width: `${b.pct}%`,
              transition: "width 600ms cubic-bezier(0.23,1,0.32,1)",
            }}
          />
        ))}
      </div>

      {/* legend */}
      <ul className="mt-4 space-y-2.5">
        {branches.map((b, i) => (
          <li key={b.name} className="flex items-center gap-2.5">
            <span className={`h-2.5 w-2.5 rounded-full ${dots[i]}`} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-neutral-700">
              {b.name}
            </span>
            <span className="text-[12px] font-semibold text-neutral-900 tnum">
              {inrCompact(b.value)}
            </span>
            <span className="w-8 text-right text-[11px] font-semibold text-neutral-400 tnum">
              {b.pct}%
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3.5 text-[11.5px] leading-4.5 text-neutral-500">
        Delhi HQ drives{" "}
        <span className="font-bold text-neutral-700 tnum">54%</span> of revenue
        this month.
      </p>
    </Widget>
  );
}
