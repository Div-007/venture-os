import { HugeiconsIcon } from "@hugeicons/react";
import { AiMagicIcon } from "@hugeicons/core-free-icons";
import clsx from "clsx";
import { Widget } from "./widget";

/** Widget ① — AI Daily Business Summary (XL). */
export function AiSummary({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  return (
    <Widget
      title="AI Daily Summary"
      ai
      delay={delay}
      footer={{ label: "Tell me more", href: "/ai/chat" }}
      className={clsx("bg-gradient-to-br from-white via-white to-ai-surface/50", className)}
    >
      <div className="flex h-full gap-3.5">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ai-surface">
          <HugeiconsIcon icon={AiMagicIcon} size={17} strokeWidth={1.75} className="text-ai" />
        </span>
        <div className="space-y-2.5">
          <p className="text-[15.5px] font-medium leading-6.5 text-neutral-800">
            Sales up{" "}
            <span className="font-bold text-success-text">8%</span> vs last month.
            Watch <span className="font-bold">Sharma Traders</span> — 45 days
            late, <span className="font-bold tnum">₹1.2L</span> pending. Payroll
            run due in <span className="font-bold">2 days</span>. Cash OK for ~6
            weeks.
          </p>
          <p className="text-[12.5px] leading-5 text-neutral-500">
            Biggest driver: collections from Gupta &amp; Sons (+₹3.4L). One risk
            to watch — cash gap projected in week 3 of October.
          </p>
        </div>
      </div>
    </Widget>
  );
}
