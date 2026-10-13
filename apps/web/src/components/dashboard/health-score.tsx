"use client";

import { useEffect, useState } from "react";
import { Widget } from "./widget";

const SCORE = 78;

/** Widget ⑤ — AI Business Health Score: animated semicircle gauge. */
export function HealthScore({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  const [v, setV] = useState(0);

  useEffect(() => {
    const t = requestAnimationFrame(() => setV(SCORE));
    return () => cancelAnimationFrame(t);
  }, []);

  const R = 70;
  const LEN = Math.PI * R;
  const frac = v / 100;
  const color = SCORE >= 70 ? "#16A34A" : SCORE >= 45 ? "#F59E0B" : "#DC2626";

  return (
    <Widget
      title="AI Business Health"
      ai
      delay={delay}
      footer={{ label: "Breakdown", href: "/ai/chat" }}
      className={className}
    >
      <div className="flex flex-col items-center pt-1">
        <svg viewBox="0 0 180 104" className="w-full max-w-[230px]">
          <defs>
            <linearGradient id="hsGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-primary-400)" />
              <stop offset="100%" stopColor={color} />
            </linearGradient>
          </defs>
          <path
            d="M 20 92 A 70 70 0 0 1 160 92"
            fill="none"
            stroke="var(--color-neutral-100)"
            strokeWidth="15"
            strokeLinecap="round"
          />
          <path
            d="M 20 92 A 70 70 0 0 1 160 92"
            fill="none"
            stroke="url(#hsGrad)"
            strokeWidth="15"
            strokeLinecap="round"
            strokeDasharray={LEN}
            strokeDashoffset={LEN * (1 - frac)}
            style={{
              transition: "stroke-dashoffset 900ms cubic-bezier(0.23,1,0.32,1)",
            }}
          />
          <text
            x="90"
            y="80"
            textAnchor="middle"
            className="tnum"
            style={{ fontSize: 36, fontWeight: 800, fill: "var(--color-neutral-900)" }}
          >
            {Math.round(frac * 100) === 0 ? "" : Math.round(frac * 100)}
          </text>
          <text
            x="90"
            y="97"
            textAnchor="middle"
            style={{
              fontSize: 10,
              fontWeight: 700,
              fill: "#16A34A",
              letterSpacing: "0.08em",
            }}
          >
            GOOD · /100
          </text>
        </svg>
        <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-success-surface px-2.5 py-1 text-[11px] font-semibold text-success-text tnum">
          ▲ 6 pts vs Aug · cash &amp; receivables improving
        </p>
      </div>
    </Widget>
  );
}
