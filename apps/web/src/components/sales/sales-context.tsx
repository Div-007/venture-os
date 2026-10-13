"use client";
import { createContext, useContext } from "react";
import type { loadLiveSession } from "@/lib/studio-api";

export type SalesSession = Awaited<ReturnType<typeof loadLiveSession>>;

/** Shared state for every Sales tab, provided by the Sales layout (app/(connected)/sales/live/layout.tsx). */
export type SalesShell = {
  /** The venture picked in the sidebar; "" means all ventures I can open. */
  ventureId: string;
  session: SalesSession | null;
  /** Opens the lead drawer (also reachable as ?lead=<id>). */
  openLead: (leadId: string) => void;
  /** Bumped after any change so open lists reload. */
  refreshKey: number;
  refresh: () => void;
  ventureName: (ventureId: string) => string;
  personName: (userId: string) => string;
};

export const SalesShellContext = createContext<SalesShell | null>(null);

export function useSalesShell(): SalesShell {
  const value = useContext(SalesShellContext);
  if (!value) throw new Error("useSalesShell must be used inside the Sales layout");
  return value;
}
