import { Anim } from "./anim";

export type Stat = { label: string; value: string; hint?: string };

/** Row of small stat cards for module pages. */
export function StatCards({ stats, delay = 0 }: { stats: Stat[]; delay?: number }) {
  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 4)}, minmax(0,1fr))` }}
    >
      {stats.map((s, i) => (
        <Anim key={s.label} delay={delay + i * 50}>
          <div className="rounded-2xl bg-white px-5 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-400">
              {s.label}
            </p>
            <p className="mt-1.5 text-[22px] font-bold leading-7 tracking-tight text-neutral-900 tnum">
              {s.value}
            </p>
            {s.hint && (
              <p className="mt-1 text-[11px] font-medium text-neutral-400">{s.hint}</p>
            )}
          </div>
        </Anim>
      ))}
    </div>
  );
}
