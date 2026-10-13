"use client";
import { describeError } from "@/lib/errors";

import { useState } from "react";
import Link from "next/link";
import { AuthHeading, AuthMessage, AuthShell, authLink, authPrimary } from "@/components/auth/auth-shell";

export function CompleteSignupClient() {
  const [state, setState] = useState<"ready" | "claiming" | "done" | "error">("ready");
  const [error, setError] = useState("");
  const [failures, setFailures] = useState(0);

  async function claim() {
    setState("claiming"); setError("");
    try {
      const response = await fetch("/v1/setup/first-admin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `Setup failed (HTTP ${response.status}).`);
      setState("done");
    } catch (cause) { setError(describeError(cause, "Could not finish setup.")); setState("error"); setFailures((value) => value + 1); }
  }

  const done = state === "done";
  return <AuthShell headline="Start your studio's operating system." blurb="Create the first admin account, then invite your team into each venture and group.">
    <div key={failures} className={`w-full max-w-[400px] ${failures ? "vso-auth-shake" : ""}`}>
      <AuthHeading swapKey={done ? "done" : "ready"} title={done ? "You're all set" : "Finish setup"} subtitle={done ? "Your admin account is ready. First-admin signup is now closed." : "Your email is verified. Create the admin account to activate the workspace."} />
      <div className="mt-8 flex flex-col gap-4">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {done ? <Link href="/dashboard/live" className={authPrimary}>Open workspace</Link>
          : <button type="button" disabled={state === "claiming"} onClick={claim} className={authPrimary}>{state === "claiming" ? "Creating admin access…" : "Complete admin setup"}</button>}
      </div>
      {!done && <p className="mt-7 text-center text-[0.75rem] leading-5 text-[#71717a]">Link expired or opened on another device? <Link href="/signup" className={authLink}>Start again</Link></p>}
    </div>
  </AuthShell>;
}
