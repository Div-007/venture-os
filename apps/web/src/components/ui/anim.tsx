import clsx from "clsx";

/** Blur+slide entrance wrapper — one per major block, staggered via delay. */
export function Anim({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      className={clsx("animate-page-in", className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
