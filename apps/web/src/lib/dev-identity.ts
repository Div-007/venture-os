const fallbackDevUserId = "user-divyansh";

/**
 * Local development only: the seeded user this browser origin acts as when the API runs with ALLOW_DEV_AUTH.
 * Production builds never send it. Each origin (e.g. alice.localhost:3012) has its own storage, so setting
 * localStorage["vso-dev-user-id"] lets several users be tested side by side.
 */
export function localDevUserId(): string | null {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && !host.endsWith(".localhost")) return null;
  try { return window.localStorage.getItem("vso-dev-user-id")?.trim() || fallbackDevUserId; } catch { return fallbackDevUserId; }
}
