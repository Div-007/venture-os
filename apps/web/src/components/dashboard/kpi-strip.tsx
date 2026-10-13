import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDownRightIcon, ArrowUpRightIcon } from "@hugeicons/core-free-icons";
import clsx from "clsx";
import { kpis } from "@/lib/mock-data";
import { inrCompact } from "@/lib/format";

/** Widget ⑫ — KPI Dashboard: six flat stat cards. */
export function KpiStrip({ delay = 0 }: { delay?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
      {kpis.map((k, i) => {
        const up = (k.delta ?? 0) >= 0;
        const positive = k.good === "up" ? up : !up;
        return (
          <section
            key={k.label}
            className="animate-widget-in rounded-2xl bg-white px-5 py-4 transition-colors duration-150 hover:bg-neutral-50/60"
            style={{ animationDelay: `${delay + i * 40}ms` }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-400">
              {k.label}
            </p>
            <p className="mt-1.5 text-[24px] font-extrabold leading-8 tracking-tight text-neutral-900 tnum">
              {k.label === "New Orders" ? k.value : inrCompact(k.value)}
            </p>
            {k.delta !== null ? (
              <p
                className={clsx(
                  "mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tnum",
                  positive
                    ? "bg-success-surface text-success-text"
                    : "bg-danger-surface text-danger-text"
                )}
              >
                <HugeiconsIcon
                  icon={up ? ArrowUpRightIcon : ArrowDownRightIcon}
                  size={12}
                  strokeWidth={2}
                />
                {Math.abs(k.delta)}%
              </p>
            ) : (
              <p className="mt-1.5 text-[11px] font-medium text-neutral-400">
                {"suffix" in k ? k.suffix : ""}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
