"use client";

import { useState } from "react";
import clsx from "clsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiMagicIcon, Cancel01Icon, Checkmark } from "@hugeicons/core-free-icons";
import { Widget } from "./widget";
import { aiSuggestions } from "@/lib/mock-data";

/** Widget ⑪ — AI suggestions feed with accept/dismiss loop. */
export function AiSuggestions({
  delay = 0,
  className,
}: {
  delay?: number;
  className?: string;
}) {
  const [items, setItems] = useState(aiSuggestions);

  return (
    <Widget
      title="AI Suggestions"
      ai
      delay={delay}
      footer={{ label: "All suggestions", href: "/ai/chat" }}
      className={clsx("bg-gradient-to-br from-white to-ai-surface/40", className)}
    >
      <ul className="space-y-2.5">
        {items.length === 0 && (
          <li className="rounded-xl bg-success-surface px-3 py-2.5 text-[12px] font-semibold text-success-text">
            Queue clear — check back tomorrow.
          </li>
        )}
        {items.map((s, i) => (
          <li key={i} className="rounded-xl bg-white/90 p-3">
            <p className="flex items-start gap-2 text-[12px] font-medium leading-4.5 text-neutral-700">
              <HugeiconsIcon
                icon={AiMagicIcon}
                size={13}
                strokeWidth={1.75}
                className="mt-0.5 shrink-0 text-ai"
              />
              {s.text}
            </p>
            <div className="mt-2.5 flex items-center gap-1.5 pl-5">
              <span className="rounded-full bg-ai-surface px-2 py-0.5 text-[9.5px] font-bold text-ai-text tnum">
                {s.confidence}% conf.
              </span>
              <span className="flex-1" />
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-neutral-500 transition-colors duration-150 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
              >
                Why?
              </button>
              <button
                type="button"
                onClick={() => setItems((l) => l.filter((_, j) => j !== i))}
                className="inline-flex items-center gap-1 rounded-full bg-success-surface px-2.5 py-1 text-[10.5px] font-bold text-success-text transition-[background-color,transform] duration-150 hover:bg-[#dcfce7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success active:scale-[0.96]"
              >
                <HugeiconsIcon icon={Checkmark} size={11} strokeWidth={2.25} /> Accept
              </button>
              <button
                type="button"
                onClick={() => setItems((l) => l.filter((_, j) => j !== i))}
                aria-label="Dismiss suggestion"
                className="grid h-6 w-6 place-items-center rounded-full text-neutral-400 transition-[color,background-color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
