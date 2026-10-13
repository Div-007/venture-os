"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Select } from "@/components/ui/select";
import { Check, Copy } from "@/components/ui/icons";
import { ActionLabel, DetailDrawer, Field, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { GroupAccessPicker, accessPayload, type GroupMode } from "@/components/studio/group-access-picker";
import { StudioApiError, createLiveInvitation } from "@/lib/studio-api";

type Role = "admin" | "venture_head" | "contributor" | "reviewer" | "learner";
type Venture = { id: string; name: string; groups: { id: string; name: string }[] };

const roles: { value: Role; label: string; hint: string }[] = [
  { value: "contributor", label: "Contributor", hint: "Works on tasks, writes knowledge, and chats in their groups." },
  { value: "reviewer", label: "Reviewer", hint: "Reviews submitted work and chats in their groups." },
  { value: "learner", label: "Learner", hint: "Reads their ventures and groups without changing anything." },
  { value: "venture_head", label: "Venture head", hint: "Leads the chosen ventures: tasks, outcomes, reviews, and the 30-day goal." },
  { value: "admin", label: "Admin", hint: "Sees and changes everything in the workspace, including people and access." },
];
const checkRow = "flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700 transition-colors duration-150 hover:bg-neutral-100 has-[:checked]:bg-primary-50 has-[:checked]:text-primary-800";

/**
 * Workspace-level invitation for admins: the person gets an email link that grants the chosen role and access.
 * The server re-checks the admin role and that every group belongs to a chosen venture in this workspace.
 */
export function InviteMemberDrawer({ ventures, onClose, onInvited }: { ventures: Venture[]; onClose: () => void; onInvited: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("contributor");
  const [ventureIds, setVentureIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  // A venture starts on "All groups"; the admin can narrow it to picked groups or none.
  const [modes, setModes] = useState<Record<string, GroupMode>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set only when email delivery is off: the admin shares this link themselves.
  const [manualLink, setManualLink] = useState("");
  const [copied, setCopied] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);
  // Focus after DetailDrawer records the opener (child effects run first), like the other drawers.
  useEffect(() => { emailInput.current?.focus(); }, []);

  const isAdmin = role === "admin";
  const hint = roles.find((item) => item.value === role)?.hint ?? "";
  const chosenVentures = ventures.filter((venture) => ventureIds.includes(venture.id));

  function toggleVenture(id: string) {
    const next = ventureIds.includes(id) ? ventureIds.filter((item) => item !== id) : [...ventureIds, id];
    setVentureIds(next);
    setModes((current) => next.includes(id) ? { ...current, [id]: current[id] ?? "all" } : current);
    // Groups only make sense inside a chosen venture.
    setGroupIds((current) => current.filter((groupId) => ventures.some((venture) => next.includes(venture.id) && venture.groups.some((group) => group.id === groupId))));
  }
  const toggleGroup = (id: string) => setGroupIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!isAdmin && !ventureIds.length) { setError("Choose at least one venture they should be able to open."); return; }
    setBusy(true); setError(""); setManualLink(""); setCopied(false);
    try {
      const address = email.trim().toLowerCase();
      // Admins already reach every venture, so their invitation carries no venture or group list.
      const access = accessPayload(ventureIds, modes, groupIds, ventures);
      const delivery = await createLiveInvitation({ email: address, role, ventureIds: isAdmin ? [] : ventureIds, groupIds: isAdmin ? [] : access.groupIds, allGroupVentureIds: isAdmin ? [] : access.allGroupVentureIds });
      if (delivery.kind === "email") onInvited(address);
      else setManualLink(`${window.location.origin}/invite/live?token=${encodeURIComponent(delivery.token)}`);
    } catch (cause) {
      // The only conflict here is an existing member; their access is changed from their row instead.
      setError(cause instanceof StudioApiError && cause.code === "CONFLICT" ? "This person is already a member. Close this and use Edit access on their row to change what they can open." : describeError(cause, "Could not send the invitation."));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(manualLink); setCopied(true); }
    catch { setError("Copy was unavailable. Select the link and copy it yourself."); }
  }

  const dirty = !manualLink && Boolean(email.trim() || ventureIds.length || role !== "contributor");

  return createPortal(<DetailDrawer title="Invite member" subtitle="Destination · this workspace" dirty={dirty} onClose={onClose}>
    {manualLink ? <div className="space-y-4">
      <p role="status" className="rounded-xl bg-success-surface p-3 text-sm leading-6 text-success-text">Invitation created for {email.trim().toLowerCase()}. Email delivery is off, so share this one-time link with them. It expires in 7 days.</p>
      <Field label="Invite link"><input readOnly value={manualLink} onFocus={(event) => event.currentTarget.select()} className={inputClass} /></Field>
      {error && <p role="alert" className="text-sm text-danger-text">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={copyLink} className={secondaryClass}>{copied ? <><Check size={15} />Copied</> : <><Copy size={15} />Copy link</>}</button><button type="button" onClick={onClose} className={primaryClass}>Done</button></div>
    </div> : <form onSubmit={invite} className="space-y-5">
      <Field label="Email"><input ref={emailInput} required type="email" autoComplete="off" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} placeholder="name@company.com" /></Field>
      <div>
        <Field label="Role"><Select aria-label="Role" className={inputClass} value={role} onChange={(event) => { setRole(event.target.value as Role); setError(""); }}>{roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></Field>
        <p className="mt-1.5 text-xs leading-5 text-neutral-500">{hint}</p>
      </div>
      {isAdmin
        ? <p className="rounded-xl bg-warning-surface p-3 text-xs leading-5 text-warning-text">Admins can open every venture and group, and can change anyone&apos;s access. Only invite people you fully trust.</p>
        : <>
          <fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Ventures</legend><div className="space-y-2">
            {ventures.map((venture) => <label key={venture.id} className={checkRow}><input type="checkbox" checked={ventureIds.includes(venture.id)} onChange={() => { toggleVenture(venture.id); setError(""); }} />{venture.name}</label>)}
            {!ventures.length && <p className="text-xs text-neutral-500">Create a venture first, then invite people into it.</p>}
          </div></fieldset>
          <fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Group access</legend>
            {chosenVentures.length ? <GroupAccessPicker ventures={chosenVentures} modes={modes} groupIds={groupIds} onMode={(id, mode) => { setModes((current) => ({ ...current, [id]: mode })); setError(""); }} onToggleGroup={toggleGroup} />
              : <p className="text-xs text-neutral-500">Choose a venture to set which of its groups they join.</p>}
          </fieldset>
        </>}
      <p className="text-xs leading-5 text-neutral-500">They get an email with a one-time link that expires in 7 days. The invitation is recorded in the audit log.</p>
      {error && <p role="alert" className="text-sm text-danger-text">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button><button type="submit" disabled={busy} className={primaryClass}><ActionLabel busy={busy} idle="Send invitation" busyText="Sending…" /></button></div>
    </form>}
  </DetailDrawer>, document.body);
}
