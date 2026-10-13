"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Mail, Plus, SearchX, UserPlus, Users, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { addLiveGroupMember, createLiveGroupInvitation, listLiveMembers, removeLiveGroupMember } from "@/lib/studio-api";
import { ChatAvatar } from "@/components/studio/chat-ui";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import clsx from "clsx";
import { Notice, useFlag } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { flashById, useExitTransition } from "@/lib/motion";

type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
type InviteRole = "venture_head" | "contributor" | "reviewer" | "learner";
type Mode = "existing" | "invite";
const errorText = (cause: unknown) => describeError(cause, "The request failed. Please try again.");

export function GroupPeople({ ventureId, ventureName, groupId, groupName, members, loading, error, canManage, onOpen, onRefresh }: {
  ventureId: string;
  ventureName: string;
  groupId: string;
  groupName: string;
  members: Member[];
  loading: boolean;
  error: string;
  canManage: boolean;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("existing");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [candidates, setCandidates] = useState<Member[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [chosenId, setChosenId] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("contributor");
  const [inviteLink, setInviteLink] = useState("");
  const [showManualLink, setShowManualLink] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState("");
  const [busyRemoveId, setBusyRemoveId] = useState("");
  const [removeError, setRemoveError] = useState("");
  // The removed row closes before the roster refreshes; copying the link confirms on the button itself.
  const [leavingId, setLeavingId] = useState("");
  const [copied, markCopied] = useFlag();
  const modeMotion = useTabMotion(mode, ["existing", "invite"]);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || mode !== "existing") return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSearching(true); setSearchError(""); setCandidates([]); setCursor(undefined); setChosenId("");
      listLiveMembers({ ...(query ? { q: query } : {}), limit: 100 }).then((page) => {
        if (active) { setCandidates(page.items); setCursor(page.nextCursor); setSearching(false); }
      }).catch((cause: unknown) => { if (active) { setSearchError(errorText(cause)); setSearching(false); } });
    });
    return () => { active = false; };
  }, [open, mode, query, searchRevision]);

  useEffect(() => {
    if (!open) return;
    if (mode === "existing" && searching) return;
    (mode === "existing" ? searchRef.current : emailRef.current)?.focus();
  }, [open, mode, searching]);

  const existingIds = new Set(members.map((member) => member.id));
  const available = candidates.filter((member) => !existingIds.has(member.id));
  const chosen = available.find((member) => member.id === chosenId);

  const dialogExit = useExitTransition(() => {
    setOpen(false); setInviteLink(""); setShowManualLink(false); setEmailSent(false); setActionError(""); setActionStatus("");
    requestAnimationFrame(() => { if (!dialogRef.current) addButtonRef.current?.focus(); });
  }, 130);
  const close = dialogExit.close;

  function switchMode(next: Mode) {
    setMode(next); setActionError(""); setActionStatus(""); setInviteLink(""); setShowManualLink(false); setEmailSent(false);
  }

  function search(event: React.FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (next && next.length < 2) { setSearchError("Search at least two characters."); return; }
    setCandidates([]); setChosenId(""); setCursor(undefined);
    setQuery(next); setSearchRevision((value) => value + 1);
  }

  async function more() {
    if (!cursor || searching) return;
    setSearching(true); setSearchError("");
    try {
      const page = await listLiveMembers({ ...(query ? { q: query } : {}), cursor, limit: 100 });
      setCandidates((items) => [...items, ...page.items]); setCursor(page.nextCursor);
    } catch (cause) { setSearchError(errorText(cause)); }
    finally { setSearching(false); }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen || loading || busy) return;
    setBusy(true); setActionError(""); setActionStatus("");
    try {
      await addLiveGroupMember(groupId, ventureId, chosen.id);
      toast({ title: `${chosen.name} added`, body: `They can now open ${groupName}.` });
      onRefresh(); close(); flashById(`member-${chosen.id}`);
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setActionError(""); setActionStatus(""); setInviteLink(""); setShowManualLink(false); setEmailSent(false);
    try {
      const delivery = await createLiveGroupInvitation({ email: email.trim().toLowerCase(), role, ventureId, groupId });
      if (delivery.kind === "email") { setEmailSent(true); setActionStatus(`Invitation email sent to ${email.trim().toLowerCase()}.`); }
      else { setInviteLink(`${window.location.origin}/invite/live?token=${encodeURIComponent(delivery.token)}`); setActionStatus("Invite link ready. Copy it to share with the person you're inviting."); }
    } catch (cause) { setActionError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(inviteLink); setActionError(""); markCopied("link"); }
    catch { setShowManualLink(true); setActionError("Copy was unavailable. Select the link below to copy it."); requestAnimationFrame(() => linkRef.current?.select()); }
  }

  async function remove(member: Member) {
    setBusyRemoveId(member.id); setRemoveError("");
    try {
      const { endedAllGroups } = await removeLiveGroupMember(groupId, member.id); setConfirmRemoveId("");
      setLeavingId(member.id);
      window.setTimeout(() => { onRefresh(); setLeavingId(""); }, 320);
      toast({ title: `${member.name} removed from ${groupName}`, body: endedAllGroups ? "They keep their other groups here, but new groups in this venture are no longer added for them." : "Other access they have may remain.", action: { label: "Undo", onClick: () => { void addLiveGroupMember(groupId, ventureId, member.id, { allGroups: endedAllGroups }).then(() => { onRefresh(); flashById(`member-${member.id}`); }).catch((cause: unknown) => toast({ tone: "error", title: "Could not add them back", body: errorText(cause) })); } } });
      requestAnimationFrame(() => addButtonRef.current?.focus()); }
    catch (cause) { setRemoveError(errorText(cause)); }
    finally { setBusyRemoveId(""); }
  }

  const openAdd = () => { onOpen(); setOpen(true); setMode("existing"); };

  function dialogKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") { if (event.target instanceof HTMLElement && event.target.closest('[role="combobox"][aria-expanded="true"]')) return; event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]):not([aria-hidden="true"])');
    if (!items?.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="mt-7 border-t border-[var(--color-neutral-100)] pt-5">
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold">People <span className="font-normal text-[var(--color-neutral-400)]">{loading ? "…" : members.length}</span></h3>{canManage && <button ref={addButtonRef} type="button" onClick={openAdd} className="flex min-h-9 items-center gap-1 rounded-lg bg-[var(--color-primary-100)] px-2.5 text-[11px] font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-200)] active:scale-[0.97]"><UserPlus size={14} />Add people</button>}</div>
    {loading ? <div role="status" aria-label="Loading group members" className="mt-3 grid gap-2.5">{[0, 1, 2].map((index) => <div key={index} className="flex items-center gap-2"><span className="vso-skeleton h-[30px] w-[30px] shrink-0 rounded-full" /><span className="vso-skeleton h-3 w-2/3" /></div>)}</div> : error ? <div className="mt-3"><p role="alert" className="text-xs text-red-700">{error}</p><button type="button" onClick={onRefresh} className="mt-2 min-h-8 text-xs font-semibold text-[var(--color-primary-700)]">Retry</button></div> : members.length ? <ul className="mt-3">{members.map((member) => <li key={member.id} data-open={leavingId !== member.id} className="vso-collapse min-w-0"><div><div data-flash-id={`member-${member.id}`} className="flex min-w-0 items-center gap-2 rounded-lg py-1"><ChatAvatar id={member.id} name={member.name} size={30} /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-[var(--color-neutral-700)]">{member.name}</p>{member.handle && <p className="truncate text-[10px] text-[var(--color-neutral-400)]">@{member.handle}</p>}</div>{canManage && member.role !== "admin" && <button type="button" disabled={Boolean(busyRemoveId)} onClick={() => { setConfirmRemoveId(member.id); setRemoveError(""); }} className="min-h-8 shrink-0 rounded-lg px-2 text-[10px] font-semibold text-[var(--color-danger-text)] transition-colors duration-150 hover:bg-[var(--color-danger-surface)] disabled:opacity-40">Remove from group</button>}</div><div data-open={confirmRemoveId === member.id} className="vso-collapse"><div><div className="mt-1 mb-2 rounded-lg bg-[var(--color-primary-50)] p-2.5"><p className="text-[11px] leading-4 text-[var(--color-primary-800)]">Remove {member.name} from {groupName}? Other access may remain.</p><div className="mt-2 flex gap-2"><button type="button" tabIndex={confirmRemoveId === member.id ? 0 : -1} disabled={Boolean(busyRemoveId)} onClick={() => remove(member)} className="min-h-8 rounded-lg bg-[#a95142] px-2.5 text-[10px] font-semibold text-white transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] disabled:opacity-40">{busyRemoveId ? "Removing…" : "Confirm removal"}</button><button type="button" tabIndex={confirmRemoveId === member.id ? 0 : -1} onClick={() => setConfirmRemoveId("")} className="min-h-8 rounded-lg px-2 text-[10px] font-semibold text-[var(--color-neutral-500)] transition-colors duration-150 hover:bg-white">Cancel</button></div>{removeError && <p role="alert" className="mt-2 text-[11px] text-red-700">{removeError}</p>}</div></div></div></div></li>)}</ul> : <EmptyState variant="compact" icon={Users} title="No members yet" body={canManage ? undefined : "People in this group appear here."} action={canManage ? { label: "Add people", onClick: openAdd } : undefined} className="mt-3" />}
    {open && canManage && createPortal(<div data-state={dialogExit.state} className="vso-backdrop fixed inset-0 z-50 grid place-items-center bg-[#272736]/45 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section ref={dialogRef} role="dialog" aria-modal="true" aria-label="Add people to group" onKeyDownCapture={dialogKey} className="vso-enter-modal thin-scroll max-h-[min(90dvh,720px)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-bold text-[var(--color-neutral-800)]">Add people</h2><button type="button" onClick={close} aria-label="Close add people" className="grid h-9 w-9 place-items-center rounded-lg text-[var(--color-neutral-500)] hover:bg-[var(--color-neutral-100)]"><X size={18} /></button></div>
      <div aria-label="Destination" className="mt-4 rounded-lg bg-[var(--color-neutral-100)] px-3 py-2.5"><p className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--color-neutral-400)]">Adding to this group</p><p className="mt-1 text-xs font-semibold text-[var(--color-neutral-700)]">{ventureName} · {groupName}</p></div>
      <SlidingTabs tabs={[{ key: "existing", label: <><Plus size={14} />Existing member</> }, { key: "invite", label: <><Mail size={14} />Invite by email</> }]} active={mode} onChange={(key) => switchMode(key as Mode)} label="Add people method" className="mt-5" />
      <div className="min-h-[340px]">{mode === "existing" ? <div key="existing" role="tabpanel" aria-label="Existing member" style={modeMotion.style} className={clsx(modeMotion.className, "mt-5")}><p className="text-xs leading-5 text-[var(--color-neutral-500)]">Find someone in your workspace who is not already in this group.</p><form onSubmit={search} className="mt-3 flex gap-2"><label htmlFor="group-person-search" className="sr-only">Search workspace people</label><input ref={searchRef} id="group-person-search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search name or handle" className="min-h-10 min-w-0 flex-1 rounded-lg border border-[var(--color-neutral-200)] px-3 text-xs outline-none focus:border-[var(--color-primary-400)]" /><button type="submit" disabled={searching} className="min-h-10 rounded-lg bg-[var(--color-neutral-100)] px-3 text-xs font-semibold text-[var(--color-neutral-700)] disabled:opacity-40">Search</button></form>
        {searchError && <p role="alert" className="mt-3 text-xs text-red-700">{searchError}</p>}
        {searching && candidates.length === 0 ? <div role="status" aria-label="Searching workspace members" className="mt-4 grid gap-2">{[0, 1, 2, 3].map((index) => <div key={index} className="flex items-center gap-2 px-2"><span className="vso-skeleton h-7 w-7 shrink-0 rounded-full" /><span className="vso-skeleton h-3 w-1/2" /></div>)}</div> : <form onSubmit={add} className="mt-4"><fieldset disabled={busy || loading}><legend className="mb-2 text-xs font-semibold text-[var(--color-neutral-700)]">Available people</legend><div className="thin-scroll max-h-56 space-y-1 overflow-y-auto">{available.map((member) => <label key={member.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-150 hover:bg-[var(--color-neutral-100)] has-[:checked]:bg-[var(--color-primary-50)]"><input type="radio" name="new-group-member" checked={chosenId === member.id} onChange={() => setChosenId(member.id)} /><ChatAvatar id={member.id} name={member.name} size={28} /><span className="min-w-0 truncate text-xs font-semibold text-[var(--color-neutral-700)]">{member.name}{member.handle ? <span className="ml-1 font-normal text-[var(--color-neutral-400)]">@{member.handle}</span> : null}</span></label>)}{!available.length && !searchError && (query ? <EmptyState variant="compact" icon={SearchX} title="No eligible people matched" body="Try a different name or handle." action={{ label: "Clear search", onClick: () => { setDraft(""); setQuery(""); } }} className="my-2" /> : <EmptyState variant="compact" icon={Users} title="No other people to add" body="Invite someone by email instead." className="my-2" />)}</div></fieldset>{cursor && <button type="button" disabled={searching} onClick={more} className="mt-2 min-h-8 text-xs font-semibold text-[var(--color-primary-700)]">Load more people</button>}<div className="mt-5 flex justify-end"><button type="submit" disabled={!chosen || busy || loading} className="min-h-10 rounded-lg bg-[var(--color-primary-600)] px-4 text-xs font-semibold text-white transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--color-primary-700)] active:scale-[0.97] disabled:opacity-40">{busy ? "Adding…" : "Add to group"}</button></div></form>}
      </div> : <form key="invite" role="tabpanel" aria-label="Invite by email" onSubmit={invite} style={modeMotion.style} className={clsx(modeMotion.className, "mt-5 space-y-4")}><p className="text-xs leading-5 text-[var(--color-neutral-500)]">Invite someone new to this workspace. You&apos;ll receive an email confirmation or a link to share.</p><label className="block text-xs font-semibold text-[var(--color-neutral-700)]">Email<input ref={emailRef} required type="email" value={email} onChange={(event) => { setEmail(event.target.value); setInviteLink(""); setShowManualLink(false); setEmailSent(false); setActionStatus(""); }} className="mt-1.5 min-h-10 w-full rounded-lg border border-[var(--color-neutral-200)] px-3 text-xs outline-none focus:border-[var(--color-primary-400)]" placeholder="person@example.com" /></label><label className="block text-xs font-semibold text-[var(--color-neutral-700)]">Role<Select value={role} onChange={(event) => { setRole(event.target.value as InviteRole); setInviteLink(""); setShowManualLink(false); setEmailSent(false); setActionStatus(""); }} className="mt-1.5 min-h-10 w-full rounded-lg border border-[var(--color-neutral-200)] px-3 text-xs outline-none focus:border-[var(--color-primary-400)]"><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option><option value="learner">Learner</option><option value="venture_head">Venture head</option></Select></label><button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-[var(--color-primary-600)] px-4 text-xs font-semibold text-white transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--color-primary-700)] active:scale-[0.97] disabled:opacity-40">{busy ? "Creating…" : "Create invitation"}</button>{emailSent && <p className="vso-row-enter rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700">Invitation email sent. The recipient can open it to join this group.</p>}{inviteLink && <div className="vso-row-enter rounded-lg bg-[var(--color-primary-50)] p-3"><p className="text-[11px] font-semibold text-[var(--color-primary-800)]">Invite link ready</p><p className="mt-1 text-[11px] leading-4 text-[var(--color-primary-800)]">Copy and share it with the intended recipient.</p><button type="button" onClick={copyLink} className={clsx("mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-[11px] font-semibold transition-[background-color,color,transform] duration-200 active:scale-[0.97]", copied ? "bg-[var(--color-success-surface)] text-[var(--color-success-text)]" : "bg-white text-[var(--color-primary-700)]")}>{copied ? <span key="copied" className="vso-label-swap inline-flex items-center gap-1.5"><Check size={15} />Copied</span> : <span key="copy" className="inline-flex items-center gap-1.5"><Copy size={15} />Copy invite link</span>}</button>{showManualLink && <label className="mt-3 block text-[11px] font-semibold text-[var(--color-primary-800)]">Select invite link<input ref={linkRef} readOnly value={inviteLink} onFocus={(event) => event.target.select()} className="mt-1 min-h-10 w-full rounded-lg border border-[var(--color-primary-200)] bg-white px-2 text-[11px] font-normal text-[var(--color-neutral-700)]" /></label>}</div>}</form>}</div>
      <Notice tone="error" message={actionError} onDismiss={() => setActionError("")} className="pt-3" /><Notice tone="success" message={actionStatus} className="pt-3" />
    </section></div>, document.body)}
  </div>;
}
