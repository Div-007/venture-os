"use client";
import { useContext, useEffect } from "react";
import { usePathname } from "next/navigation";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { CircleAlert } from "@/components/ui/icons";
import { cachedSetup, isFresh, loadSetupData, readiness, SETUP_TOTAL, useCachedSetup } from "./setup-checks";
import { SalesShellContext } from "./sales-context";

/**
 * A quiet one-line strip for a venture that is not ready to sell: no pipeline, or no approved offer. Nothing otherwise.
 * It reads the same checks as the setup screen, kept per venture for 5 minutes, so it costs one round of requests per venture.
 */
export function SetupBanner({ ventureId, ventureName }: { ventureId: string; ventureName?: string }) {
  const shell = useContext(SalesShellContext);
  const pathname = usePathname();
  const data = useCachedSetup(ventureId);
  useEffect(() => {
    if (!ventureId || isFresh(cachedSetup(ventureId))) return;
    void loadSetupData(ventureId);
  }, [ventureId, data?.at]);

  if (!ventureId || !data || pathname.startsWith("/sales/live/setup")) return null;
  const { ready, known, done } = readiness(data);
  if (!known || ready) return null;
  const name = ventureName || shell?.ventureName(ventureId) || "This venture";
  return <div role="note" className="mb-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-warning-surface px-3.5 py-2.5 text-xs font-medium leading-5 text-warning-text">
    <CircleAlert size={15} className="shrink-0" aria-hidden="true" />
    <p className="min-w-0 flex-1">{name} isn&apos;t set up for sales yet — <span className="tnum">{done} of {SETUP_TOTAL}</span> done · <WorkspaceLink href={`/sales/live/setup?venture=${encodeURIComponent(ventureId)}`} className="font-bold underline underline-offset-2 hover:opacity-80">Set up</WorkspaceLink></p>
  </div>;
}
