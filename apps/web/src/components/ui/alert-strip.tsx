import { HugeiconsIcon } from "@hugeicons/react";
import { AlertTriangle, AiMagicIcon, Alert02Icon } from "@hugeicons/core-free-icons";
import clsx from "clsx";

const tones = {
  danger: { bg: "bg-danger-surface", fg: "text-danger-text", icon: Alert02Icon },
  warning: { bg: "bg-warning-surface", fg: "text-warning-text", icon: AlertTriangle },
  ai: { bg: "bg-ai-surface", fg: "text-ai-text", icon: AiMagicIcon },
  info: { bg: "bg-info-surface", fg: "text-info-text", icon: Alert02Icon },
} as const;

/** Contextual alert strip between filters and table (§5.2). */
export function AlertStrip({
  tone = "warning",
  text,
  cta,
  href = "#",
}: {
  tone?: keyof typeof tones;
  text: string;
  cta?: string;
  href?: string;
}) {
  const t = tones[tone];
  return (
    <div
      className={clsx(
        "flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[12px] font-semibold",
        t.bg,
        t.fg
      )}
    >
      <HugeiconsIcon icon={t.icon} size={15} strokeWidth={1.75} />
      <span className="flex-1">{text}</span>
      {cta && (
        <a
          href={href}
          className="rounded-full bg-white/80 px-2.5 py-1 text-[10.5px] font-bold transition-colors duration-150 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
        >
          {cta}
        </a>
      )}
    </div>
  );
}
