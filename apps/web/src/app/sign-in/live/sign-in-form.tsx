"use client";
import { describeError } from "@/lib/errors";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "@/components/ui/icons";
import { AuthHeading, AuthMessage, AuthShell, authField, authLabel, authLink, authPrimary, authSecondary } from "@/components/auth/auth-shell";
import { demoEnabled } from "@/lib/demo";

export function SignInForm({ next, setupAvailable }: { next: string; setupAvailable: boolean }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  // Bumped on each failure so the form replays its shake.
  const [failures, setFailures] = useState(0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}), callbackURL: `${window.location.origin}${next}` }) });
      if (!response.ok) throw new Error(`Sign-in request failed (HTTP ${response.status}).`);
      setSent(true);
    } catch (cause) { setError(describeError(cause, "Could not request a sign-in link.")); setFailures((value) => value + 1); }
    finally { setBusy(false); }
  }

  return <AuthShell>
    <div key={failures} className={`w-full max-w-[400px] ${failures ? "vso-auth-shake" : ""}`}>
      <AuthHeading swapKey={sent ? "sent" : "form"} title={sent ? "Check your inbox" : "Welcome back"} subtitle={sent ? <>We sent a one-time sign-in link to <strong className="font-semibold text-[#3f3f46]">{email.trim()}</strong>. Open it on this device.</> : "Enter your email and we'll send you a one-time sign-in link."} />
      {sent ? <div className="vso-auth-rise mt-8 flex flex-col gap-3">
        <div className="flex items-start gap-3 rounded-xl bg-[#f4f4f6] p-4 text-[0.8125rem] leading-[1.45] text-[#52525b]"><MailCheck size={18} className="mt-0.5 shrink-0 text-[#18181b]" />Nothing there after a minute? Check spam. If it still doesn&apos;t arrive, ask a workspace admin to confirm your invitation.</div>
        <button type="button" onClick={() => { setSent(false); setError(""); }} className={authSecondary}>Use a different email</button>
      </div> : <form onSubmit={submit} className="mt-8 flex flex-col">
        <label htmlFor="sign-in-email" className={authLabel}>Email</label>
        <input id="sign-in-email" required type="email" autoComplete="email" placeholder="Enter your email" className={authField} value={email} onChange={(event) => setEmail(event.target.value)} />
        <label htmlFor="sign-in-name" className={`${authLabel} mt-4`}>Name <span className="font-normal text-[#a1a1aa]">· first sign-in only</span></label>
        <input id="sign-in-name" autoComplete="name" maxLength={120} placeholder="Your name" className={authField} value={name} onChange={(event) => setName(event.target.value)} />
        {error && <div className="mt-4"><AuthMessage tone="error">{error}</AuthMessage></div>}
        <button disabled={busy} className={`${authPrimary} mt-6`}>{busy ? "Sending link…" : "Email me a sign-in link"}</button>
        {demoEnabled && <Link href="/demo/sign-in" className={`${authSecondary} mt-3`}>Explore the demo</Link>}
      </form>}
      <p className="mt-7 text-center text-[0.75rem] leading-5 text-[#71717a]">
        {/* Only while the workspace has no admin yet; after that, people join by invitation. */}
        {setupAvailable ? <>Setting up this workspace for the first time? <Link href="/signup" className={authLink}>Create the admin account</Link></> : "Access is by invitation from a workspace admin."}
      </p>
    </div>
  </AuthShell>;
}
