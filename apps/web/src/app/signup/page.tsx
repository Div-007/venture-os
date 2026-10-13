import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SignupForm } from "./signup-form";

type Status = { available: boolean; complete: boolean; configured: boolean; emailDeliveryReady: boolean };

export default async function SignupPage() {
  let status: Status | null = null;
  try {
    const apiOrigin = process.env.VSO_API_ORIGIN ?? "http://localhost:4000";
    // Pass the visitor's Cloudflare address along so the API rate-limits them, not this server.
    const visitor = (await headers()).get("cf-connecting-ip");
    const response = await fetch(`${apiOrigin}/v1/setup/first-admin`, { cache: "no-store", headers: visitor ? { "cf-connecting-ip": visitor } : {} });
    if (response.ok) status = (await response.json() as { data: Status }).data;
  } catch { /* The page shows the unavailable state while the API is offline. */ }
  if (status?.complete) notFound();
  return <SignupForm status={status} />;
}
