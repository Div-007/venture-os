"use client";

import { getCurrentLiveFocus } from "@/lib/studio-api";

/* The running focus session, shared by the focus screen and the top-bar timer. `undefined` means not loaded yet. */
type FocusSnapshot = { endsAt: string; pausedAt?: string } | null | undefined;
let current: FocusSnapshot;
let requested = false;
const listeners = new Set<() => void>();

export function publishFocus(value: { endsAt: string; pausedAt?: string; completedAt?: string | null } | null) {
  current = value && !value.completedAt ? { endsAt: value.endsAt, ...(value.pausedAt ? { pausedAt: value.pausedAt } : {}) } : null;
  listeners.forEach((listener) => listener());
}

export function subscribeFocus(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getFocus = () => current;

/** Loads the running session once per visit; the focus screen keeps it current afterwards. */
export function ensureFocusLoaded() {
  if (requested || current !== undefined) return;
  requested = true;
  getCurrentLiveFocus().then(publishFocus).catch(() => { requested = false; });
}
