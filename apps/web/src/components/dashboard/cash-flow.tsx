"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { useState } from "react";
import clsx from "clsx";
import { Widget } from "./widget";
import { cashFlow } from "@/lib/mock-data";

const ranges = ["Inflow", "Outflow", "Net"] as const;
const HILITE = 4; // Aug — highlighted bar

/** Floating callout card over the highlighted bar — Fundora style. */
function CalloutLabel(props: {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  index?: number;
}) {
  const { x, y, width, index } = props;
  if (index !== HILITE || x == null || y == null) return null;
  const cx = Number(x) + Number(width ?? 0) / 2;
  const W = 112;
  const H = 40;
  const left = cx - W / 2;
  const top = Number(y) - H - 14;
  return (
    <g>
      {/* connector dot on bar top */}
      <circle cx={cx} cy={Number(y) - 5} r={4} fill="#fff" stroke="var(--color-primary-500)" strokeWidth={3} />
      <rect x={left} y={top} width={W} height={H} rx={10} fill="#fff" stroke="var(--color-neutral-200)" />
      <text x={cx} y={top + 15} textAnchor="middle" style={{ fontSize: 9.5, fontWeight: 600, fill: "var(--color-neutral-400)" }}>
        Aug 2025
      </text>
      <text x={cx} y={top + 30} textAnchor="middle" className="tnum" style={{ fontSize: 13, fontWeight: 800, fill: "var(--color-neutral-900)" }}>
        ₹38.9L
      </text>
    </g>
  );
}

/** Widget ④ — Cash Flow: rounded bars, highlighted month + callout. */
export function CashFlow({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  const [range, setRange] = useState<(typeof ranges)[number]>("Inflow");

  return (
    <Widget
      title="Cash Flow"
      delay={delay}
      period="This Month"
      footer={{ label: "Cash flow report", href: "/finance?tab=cash-flow" }}
      className={className}
    >
      <div className="mb-1 flex items-end justify-between">
        <p className="text-[26px] font-extrabold tracking-tight text-neutral-900 tnum">
          ₹34.2L
        </p>
        {/* segmented — dark pill active, Fundora style */}
        <div className="flex items-center gap-1">
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={clsx(
                "rounded-full px-3.5 py-1.5 text-[11.5px] font-bold",
                "transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]",
                range === r
                  ? "bg-primary-700 text-white"
                  : "text-neutral-400 hover:text-neutral-700"
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-[168px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={cashFlow} margin={{ top: 48, right: 0, bottom: 0, left: -18 }} barCategoryGap="28%">
            <defs>
              <linearGradient id="cfBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-primary-400)" />
                <stop offset="100%" stopColor="var(--color-primary-700)" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--color-neutral-100)" vertical={false} />
            <XAxis
              dataKey="m"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--color-neutral-400)", fontWeight: 600 }}
              dy={8}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--color-neutral-400)", fontWeight: 600 }}
              tickFormatter={(v: number) => `${v}L`}
              ticks={[0, 10, 20, 30, 40]}
            />
            <Bar dataKey="in" radius={[9, 9, 9, 9]} maxBarSize={34}>
              {cashFlow.map((_, i) => (
                <Cell key={i} fill={i === HILITE ? "url(#cfBar)" : "var(--color-neutral-100)"} />
              ))}
              <LabelList content={<CalloutLabel />} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Widget>
  );
}
