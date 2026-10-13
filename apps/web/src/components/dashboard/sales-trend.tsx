"use client";

import {
  Area,
  AreaChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiMagicIcon } from "@hugeicons/core-free-icons";
import { Widget } from "./widget";
import { salesTrend } from "@/lib/mock-data";

const HOT = 5; // Sep — highlighted point

/** Widget ③ — Sales trend: gradient line + highlighted month. */
export function SalesTrend({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  const hot = salesTrend[HOT];
  return (
    <Widget
      title="Sales"
      delay={delay}
      period="This Month"
      footer={{ label: "Sales analytics", href: "/sales?tab=analytics" }}
      className={className}
    >
      <div className="min-h-[108px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={salesTrend} margin={{ top: 10, right: 12, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="salesG" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-primary-500)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--color-primary-500)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="d"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "var(--color-neutral-400)", fontWeight: 600 }}
              dy={6}
            />
            <Tooltip
              cursor={{ stroke: "var(--color-neutral-300)" }}
              contentStyle={{
                borderRadius: 12,
                boxShadow: "0 4px 12px rgba(15,23,42,.10)",
                fontSize: 12,
                fontWeight: 700,
              }}
              formatter={(v) => [`₹${v}L`, "Sales"]}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke="var(--color-primary-700)"
              strokeWidth={2.75}
              fill="url(#salesG)"
              dot={false}
              activeDot={{ r: 4.5, strokeWidth: 2.5, stroke: "#fff" }}
            />
            <ReferenceDot
              x={hot.d}
              y={hot.v}
              r={5}
              fill="var(--color-primary-700)"
              stroke="#fff"
              strokeWidth={3}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2.5 space-y-1.5 text-[12px]">
        <p className="flex justify-between font-medium text-neutral-600">
          <span>Top item</span>
          <span className="font-mono font-semibold text-neutral-900">SKU-77</span>
        </p>
        <p className="flex items-center justify-between font-medium text-neutral-600">
          <span className="inline-flex items-center gap-1.5">
            <HugeiconsIcon icon={AiMagicIcon} size={13} strokeWidth={1.75} className="text-ai" />
            Forecast Oct
          </span>
          <span className="font-bold text-ai-text tnum">₹48L</span>
        </p>
      </div>
    </Widget>
  );
}
