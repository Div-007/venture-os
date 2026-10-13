import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/safe-next";
import { SignInForm } from "./sign-in-form";

const apiOrigin = () => process.env.VSO_API_ORIGIN ?? "http://localhost:4000";
// A slow API must not hold the sign-in page hostage: past this, the visitor just gets the form.
const API_TIMEOUT_MS = 3000;
// First-admin setup can only be closed, never reopened, so once it is seen closed this server stops asking.
let setupClosed = false;

/** Whether the visitor's cookies hold a Better Auth session. Any failure counts as signed out, so the form still shows. */
async function hasSession(cookie: string | null, forward: Record<string, string>) {
  if (!cookie) return false;
  try {
    const response = await fetch(`${apiOrigin()}/api/auth/get-session`, { cache: "no-store", headers: { cookie, ...forward }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!response.ok) return false;
    const session = await response.json().catch(() => null) as { user?: { id?: unknown } } | null;
    return typeof session?.user?.id === "string";
  } catch { return false; }
}

/** Whether first-admin setup is still open, so the page can point a brand-new workspace's owner to /signup. */
async function setupAvailable(forward: Record<string, string>) {
  if (setupClosed) return false;
  try {
    const response = await fetch(`${apiOrigin()}/v1/setup/first-admin`, { cache: "no-store", headers: forward, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as { data?: { available?: unknown; complete?: unknown } } | null;
    if (body?.data?.complete === true) setupClosed = true;
    return body?.data?.available === true && body.data.complete !== true;
  } catch { return false; }
}

export default async function Page({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const next = safeNextPath((await searchParams).next);
  const requestHeaders = await headers();
  // Pass the visitor's Cloudflare address along so the API rate-limits them, not this server.
  const visitor = requestHeaders.get("cf-connecting-ip");
  const forward: Record<string, string> = visitor ? { "cf-connecting-ip": visitor } : {};
  // Already signed in: skip the form and continue to where they were going.
  if (await hasSession(requestHeaders.get("cookie"), forward)) redirect(next);
  return <SignInForm next={next} setupAvailable={await setupAvailable(forward)} />;
}
