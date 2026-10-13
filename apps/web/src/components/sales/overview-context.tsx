"use client";
import { createContext, useContext } from "react";
import type { SalesOverview } from "@/lib/sales-api";

export type SalesMember = { id: string; name: string; role: string };
export type OverviewScope = "me" | "all";

/**
 * What the Sales layout loads once for every tab: the Overview payload (it also feeds the tab badges) and the people
 * who can own leads. Tabs read it with `useSalesOverview()` instead of fetching the Overview again.
 */
export type SalesLive = {
  overview: SalesOverview | null;
  /** True until the first Overview arrives (or fails). */
  loading: boolean;
  /** True while any load or reload is running. */
  busy: boolean;
  /** Set only when the Overview could not be loaded. */
  error: string;
  scope: OverviewScope;
  setScope: (scope: OverviewScope) => void;
  members: SalesMember[];
};

export const SalesLiveContext = createContext<SalesLive | null>(null);

export function useSalesOverview(): SalesLive {
  const value = useContext(SalesLiveContext);
  if (!value) throw new Error("useSalesOverview must be used inside the Sales layout");
  return value;
}
