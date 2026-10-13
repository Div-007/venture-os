import clsx from "clsx";

const tones = {
  success: "bg-success-surface text-success-text",
  warning: "bg-warning-surface text-warning-text",
  danger: "bg-danger-surface text-danger-text",
  info: "bg-info-surface text-info-text",
  neutral: "bg-neutral-100 text-neutral-600",
  ai: "bg-ai-surface text-ai-text",
} as const;

export type Tone = keyof typeof tones;

/** Status pill — icon dot + word, never color alone. */
export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
        tones[tone]
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
