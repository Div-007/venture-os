"use client";
import { describeError } from "@/lib/errors";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthHeading, AuthMessage, AuthShell, authPrimary, authSecondary } from "@/components/auth/auth-shell";
import { acceptLiveInvitation, liveAuthIdentity, signOutLive } from "@/lib/studio-api";

type Identity = Awaited<ReturnType<typeof liveAuthIdentity>>;

function ConnectedInvite() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  // undefined while checking, null when signed out.
  const [identity, setIdentity] = useState<Identity | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState(0);
  const invitePath = `/invite/live?token=${encodeURIComponent(token)}`;
  const signInUrl = `/sign-in/live?next=${encodeURIComponent(invitePath)}`;

  useEffect(() => {
    let active = true;
    liveAuthIdentity().then((value) => { if (active) setIdentity(value); }, () => { if (active) setIdentity(null); });
    return () => { active = false; };
  }, []);

  async function accept() {
    if (busy) return;
    setBusy(true); setError("");
    try { await acceptLiveInvitation(token); setAccepted(true); }
    catch (cause) { setError(describeError(cause, "Could not accept the invitation.")); setFailures((value) => value + 1); }
    finally { setBusy(false); }
  }

  function switchAccount() {
    setSigningOut(true); setError("");
    signOutLive(invitePath).catch((cause) => { setSigningOut(false); setError(describeError(cause, "Could not sign out. Try again.")); });
  }

  const heading = !token ? { key: "broken", title: "Link incomplete", subtitle: "This invitation link is missing its code. Ask the person who invited you for a new link." }
    : accepted ? { key: "accepted", title: "You're in", subtitle: "Your invitation is accepted and your workspace access is active." }
    : identity ? { key: "signed-in", title: "You're invited", subtitle: <>Accept to join Venture Studio as <strong className="font-semibold text-[#3f3f46]">{identity.email}</strong>. Use the email address the invitation was sent to.</> }
    : { key: "signed-out", title: "You're invited", subtitle: "Sign in with the email address this invitation was sent to, then accept it here." };

  return <AuthShell headline="Your team is waiting for you." blurb="Join the ventures and groups you were invited to: shared goals, tasks, channels, and decisions.">
    <div key={failures} className={`w-full max-w-[400px] ${failures ? "vso-auth-shake" : ""}`}>
      <AuthHeading swapKey={heading.key} title={heading.title} subtitle={heading.subtitle} />
      <div className="mt-8 flex flex-col gap-3">
        {error && <AuthMessage tone="error">{error}</AuthMessage>}
        {!token ? <Link href="/sign-in/live" className={authSecondary}>Go to sign in</Link>
          : accepted ? <Link href="/dashboard/live" className={authPrimary}>Open workspace</Link>
          : identity === undefined ? <div role="status" aria-label="Checking your sign-in" className="vso-skeleton h-[50px] rounded-xl" />
          : identity ? <>
            <button type="button" disabled={busy || signingOut} onClick={accept} className={authPrimary}>{busy ? "Accepting…" : "Accept invitation"}</button>
            <button type="button" disabled={busy || signingOut} onClick={switchAccount} className={authSecondary}>{signingOut ? "Signing out…" : "Use a different account"}</button>
          </>
          : <Link href={signInUrl} className={authPrimary}>Sign in to accept</Link>}
      </div>
      <p className="mt-7 text-center text-[0.75rem] leading-5 text-[#71717a]">Invitations expire after 7 days and work once. If yours has expired, ask a workspace admin to send a new one.</p>
    </div>
  </AuthShell>;
}

export default function Page() { return <Suspense fallback={null}><ConnectedInvite /></Suspense>; }
