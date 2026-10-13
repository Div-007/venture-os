import { Anim } from "./anim";

/** Page header — title, optional context, and right-side actions. */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <Anim className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-neutral-900">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-0.5 text-[13px] font-medium text-neutral-500">
            {subtitle}
          </p>
        )}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </Anim>
  );
}
