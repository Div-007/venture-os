const DEFAULT_NEXT = "/dashboard/live";
const BASE = "http://next.invalid";

/** The normalized same-site path for a value, or null when it resolves anywhere else. */
function sameSitePath(value: string): string | null {
  let url: URL;
  try { url = new URL(value, BASE); } catch { return null; }
  if (url.origin !== BASE) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Turns a `?next=` value into a same-site path, or the dashboard when it is missing or unsafe.
 * Parsing it the way a browser would catches `//host`, `/\host` and tab/newline tricks that a prefix check misses.
 * The normalized result is checked again, because dot segments can collapse into a new `//host` (`/.//host`).
 * Sign-in and signup pages are refused so a signed-in redirect can never loop back to itself, and API routes are
 * refused because they are not pages.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return DEFAULT_NEXT;
  const path = sameSitePath(value);
  if (!path || !/^\/(?![/\\])/.test(path) || sameSitePath(path) !== path) return DEFAULT_NEXT;
  let decoded: string;
  try { decoded = decodeURIComponent(path.split(/[?#]/, 1)[0]!); } catch { return DEFAULT_NEXT; }
  if (/^(\/demo)?\/(sign-in|signup)(\/|$)/i.test(decoded) || /^\/(api|v1|socket\.io)(\/|$)/i.test(decoded)) return DEFAULT_NEXT;
  return path;
}
