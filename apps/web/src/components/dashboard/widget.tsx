"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  Download01Icon,
  Setting07Icon,
} from "@hugeicons/core-free-icons";
import clsx from "clsx";
import { Dropdown } from "@/components/ui/dropdown";

/** Dashboard widget chrome — flat soft card, caps title, period pill / ⋮ menu, "as of" stamp. */
export function Widget({
  title,
  ai,
  children,
  footer,
  className,
  delay = 0,
  period,
}: {
  title: string;
  ai?: boolean;
  children: React.ReactNode;
  footer?: { label: string; href: string };
  className?: string;
  delay?: number;
  period?: string;
}) {
  return (
    <section
      className={clsx(
        "animate-widget-in flex flex-col rounded-2xl bg-white",
        className
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <header className="flex items-center gap-2 px-6 pt-5">
        <h2
          className={clsx(
            "text-[13px] font-semibold text-neutral-800",
            ai && "text-ai"
          )}
        >
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {period && (
            <Dropdown
              align="right"
              items={["This Week", "This Month", "This Quarter", "This Year"].map(
                (p) => ({ label: p })
              )}
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-3 py-1.5 text-[11px] font-semibold text-neutral-600 transition-[color,background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"
                >
                  {period}
                  <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.75} />
                </button>
              }
            />
          )}
          <Dropdown
            align="right"
            items={[
              { label: "Refresh", icon: RefreshIcon },
              { label: "Export CSV", icon: Download01Icon },
              { label: "Configure widget", icon: Setting07Icon },
            ]}
            trigger={
              <button
                type="button"
                aria-label={`${title} options`}
                className="grid h-7 w-7 place-items-center rounded-full text-neutral-400 transition-[color,background-color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96]"
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} size={17} strokeWidth={1.75} />
              </button>
            }
          />
        </div>
      </header>

      <div className="flex flex-1 flex-col px-6 py-3.5">{children}</div>

      <footer className="flex items-center justify-between px-6 pb-4">
        <span className="text-[10.5px] font-medium text-neutral-400 tnum">
          as of 10:42 am
        </span>
        {footer && (
          <a
            href={footer.href}
            className="rounded text-[11.5px] font-bold text-primary-600 transition-colors duration-150 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
          >
            {footer.label} →
          </a>
        )}
      </footer>
    </section>
  );
}
