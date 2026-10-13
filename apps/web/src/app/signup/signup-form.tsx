"use client";
import { describeError } from "@/lib/errors";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "@/components/ui/icons";
import { AuthHeading, AuthMessage, AuthShell, authField, authLabel, authLink, authPrimary } from "@/components/auth/auth-shell";

type Status = { available: boolean; complete: boolean; configured: boolean; emailDeliveryReady: boolean };

export function SignupForm({ status }: { status: Status | null }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState(0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), name: name.trim(), callbackURL: `${window.location.origin}/signup/complete` }) });
      if (!response.ok) throw new Error(`Could not send a verification link (HTTP ${response.status}).`);
      setSent(true);
    } catch (cause) { setError(describeError(cause, "Could not request a verification link.")); setFailures((value) => value + 1); }
    finally { setBusy(false); }
  }

  const blocker = !status ? "The API is unavailable. Start the backend and reload this page."
    : !status.configured ? "Setup is not configured. Set BOOTSTRAP_ADMIN_EMAIL to your email and use a MongoDB replica set, then restart the API."
    : !status.emailDeliveryReady ? "Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM in the server environment, then restart the API."
    : "";

  return <AuthShell headline="Start your studio's operating system." blurb="Create the first admin account, then invite your team into each venture and group.">
    <div key={failures} className={`w-full max-w-[400px] ${failures ? "vso-auth-shake" : ""}`}>
      <AuthHeading swapKey={sent ? "sent" : "form"} title={sent ? "Check your inbox" : "Set up your workspace"} subtitle={sent ? <>If <strong className="font-semibold text-[#3f3f46]">{email.trim()}</strong> is the configured owner address, a verification link is on its way. Open it on this device.</> : "This one-time setup is only for the owner email configured on the server."} />
      {blocker ? <div className="mt-8"><AuthMessage tone="warning">{blocker}</AuthMessage></div>
        : sent ? <div className="vso-auth-rise mt-8 flex items-start gap-3 rounded-xl bg-[#f4f4f6] p-4 text-[0.8125rem] leading-[1.45] text-[#52525b]"><MailCheck size={18} className="mt-0.5 shrink-0 text-[#18181b]" />The link brings you back here to finish setup. Nothing there after a minute? Check spam.</div>
        : <form onSubmit={submit} className="mt-8 flex flex-col">
          <label htmlFor="signup-email" className={authLabel}>Owner email</label>
          <input id="signup-email" required type="email" autoComplete="email" placeholder="Enter the owner email" className={authField} value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="signup-name" className={`${authLabel} mt-4`}>Your name</label>
          <input id="signup-name" required minLength={1} maxLength={120} autoComplete="name" placeholder="Your name" className={authField} value={name} onChange={(event) => setName(event.target.value)} />
          {error && <div className="mt-4"><AuthMessage tone="error">{error}</AuthMessage></div>}
          <button disabled={busy} className={`${authPrimary} mt-6`}>{busy ? "Sending link…" : "Email me a verification link"}</button>
        </form>}
      <p className="mt-7 text-center text-[0.75rem] leading-5 text-[#71717a]">Already a member? <Link href="/sign-in/live" className={authLink}>Sign in</Link></p>
    </div>
  </AuthShell>;
}
