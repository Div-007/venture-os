"use client";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

// Venture OS has two modes with one click between them: Studio (tasks, communication) and Sales (the sales dashboard).
// The route decides when it can; shared pages (calendar, knowledge, messages, notifications, people & access) keep the current mode,
// which is remembered per browser.

export type AppMode = "studio" | "sales";
const MODE_KEY = "vso-app-mode";
const STUDIO_PATH_KEY = "vso-last-studio-path";
const EVENT = "vso-app-mode-change";
const STUDIO_ONLY = new Set(["dashboard", "today", "tasks", "board", "channels", "ventures", "decisions", "classes", "timeline", "requests", "focus", "planning", "leaderboard"]);

/** The mode a route belongs to, or null for a shared page that keeps whichever mode is on. */
export function routeMode(pathname: string): AppMode | null {
  const first = pathname.replace(/^\/demo(?=\/|$)/, "").split("/").filter(Boolean)[0];
  if (first === "sales") return "sales";
  return first && STUDIO_ONLY.has(first) ? "studio" : null;
}

function read(): AppMode {
  try { return window.localStorage.getItem(MODE_KEY) === "sales" ? "sales" : "studio"; } catch { return "studio"; }
}
function write(mode: AppMode) {
  try { window.localStorage.setItem(MODE_KEY, mode); } catch { /* Remembering the mode is a convenience. */ }
  window.dispatchEvent(new Event(EVENT));
}
const subscribe = (onChange: () => void) => {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener("storage", onChange); };
};

/** The current mode (route first, then the remembered one). Also remembers the mode and the last Studio page as the route changes. */
export function useAppMode(): { mode: AppMode; routeMode: AppMode | null } {
  const pathname = usePathname();
  const stored = useSyncExternalStore(subscribe, read, () => "studio" as AppMode);
  const fromRoute = routeMode(pathname);
  // Remember the mode only when this tab navigates, never because another tab changed it: two tabs on different modes would otherwise keep overwriting each other.
  useEffect(() => {
    if (fromRoute && read() !== fromRoute) write(fromRoute);
    if (fromRoute === "studio") { try { window.localStorage.setItem(STUDIO_PATH_KEY, pathname.replace(/^\/demo(?=\/|$)/, "").replace(/\/live$/, "") || "/dashboard"); } catch { /* ignore */ } }
  }, [fromRoute, pathname]);
  return { mode: fromRoute ?? stored, routeMode: fromRoute };
}

/** Where "Studio" goes: the last Studio page visited, else the dashboard. A path without the /live suffix (the link maps it). */
export function lastStudioPath(): string {
  try {
    const saved = window.localStorage.getItem(STUDIO_PATH_KEY);
    return saved && routeMode(saved) === "studio" ? saved : "/dashboard";
  } catch { return "/dashboard"; }
}

export function rememberAppMode(mode: AppMode) { write(mode); }
