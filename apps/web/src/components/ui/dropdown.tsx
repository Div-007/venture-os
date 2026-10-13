"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import clsx from "clsx";

export type MenuItem = {
  label: string;
  icon?: React.ComponentProps<typeof HugeiconsIcon>["icon"];
  href?: string;
  danger?: boolean;
  onClick?: () => void;
};

/** Lightweight dropdown — closes on outside click / Escape. */
export function Dropdown({
  trigger,
  items,
  align = "right",
  className,
}: {
  trigger: React.ReactNode;
  items: (MenuItem | "divider")[];
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={clsx("relative", className)}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          role="menu"
          className={clsx(
            "vso-enter-popover absolute top-full z-50 mt-1.5 min-w-44 rounded-2xl bg-white p-1.5 ring-1 ring-neutral-900/5",
            align === "right" ? "right-0" : "left-0"
          )}
          data-align={align}
        >
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={i} className="my-1 h-px bg-neutral-100" />
            ) : (
              <a
                key={i}
                href={it.href ?? "#"}
                role="menuitem"
                onClick={(e) => {
                  if (!it.href) e.preventDefault();
                  it.onClick?.();
                  setOpen(false);
                }}
                className={clsx(
                  "flex items-center gap-2.5 rounded-xl px-3 py-2 text-[12.5px] font-semibold",
                  "transition-[color,background-color] duration-100",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600",
                  it.danger
                    ? "text-danger hover:bg-danger-surface"
                    : "text-neutral-700 hover:bg-neutral-100"
                )}
              >
                {it.icon && (
                  <HugeiconsIcon
                    icon={it.icon}
                    size={15}
                    strokeWidth={1.5}
                    className={it.danger ? "text-danger" : "text-neutral-400"}
                  />
                )}
                {it.label}
              </a>
            )
          )}
        </div>
      )}
    </div>
  );
}
