"use client";
import { describeError } from "@/lib/errors";

import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Hash, Layers3, LockKeyhole, Search, UserPlus, Users, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { flashById } from "@/lib/motion";
import { WorkspaceLink as Link } from "@/components/shell/workspace-link";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import { InviteMemberDrawer } from "@/components/studio/invite-member-drawer";
import { MemberTable } from "@/components/studio/member-table";
import { GroupAccessPicker, accessPayload, effectiveGroups, storedMode, type GroupMode } from "@/components/studio/group-access-picker";
import { createLiveChannel, listLiveMembers, listLiveMemberships, loadLiveSession, updateLiveMembership } from "@/lib/studio-api";
import { ActionLabel, Badge, DetailDrawer, Field, HeaderActions, inputClass, Notice, PageFrame, PageTitle, Panel, PanelHead, primaryClass, RefreshButton, secondaryClass, SkeletonRows } from "@/components/studio/primitives";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Membership = Awaited<ReturnType<typeof listLiveMemberships>>[number];
type Role = Membership["role"];
const roleLabel = (value: string) => value.replaceAll("_", " ");
const rank: Record<Role, number> = { admin: 4, venture_head: 3, reviewer: 2, contributor: 2, learner: 1 };
const checkRow = "flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700 transition-colors duration-150 hover:bg-neutral-100 has-[:checked]:bg-primary-50 has-[:checked]:text-primary-800";
const modeLabel: Record<GroupMode, string> = { all: "all groups", pick: "picked groups", none: "no groups" };

export function LiveAdminScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof listLiveMembers>>["items"]>([]);
  const [tab, setTab] = useState<"Members" | "Structure">("Members");
  const [selected, setSelected] = useState<Membership | null>(null);
  const [role, setRole] = useState<Role>("contributor");
  const [ventureIds, setVentureIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, GroupMode>>({});
  const [shareKnowledge, setShareKnowledge] = useState(false);
  const [channelGroupId, setChannelGroupId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [error, setError] = useState("");
  // The last load failure, kept apart from `error` (which also carries save errors) so an empty list never reads as "nothing yet" after a failed load.
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  // Saving a change that removes access asks once more, showing exactly what will change.
  const [confirming, setConfirming] = useState(false);
  const [inviting, setInviting] = useState(false);
  const confirmShownAt = useRef(0);
  const tabMotion = useTabMotion(tab, ["Members", "Structure"]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setLoading(true); });
    queueMicrotask(() => loadLiveSession().then(async (value) => {
      if (!active) return;
      setSession(value);
      if (value.membership.role !== "admin") { setError(""); setLoadError(""); setLoading(false); return; }
      const [next, directory] = await Promise.all([listLiveMemberships(), listLiveMembers({ limit: 100 }).catch(() => null)]);
      if (active) { setMemberships(next); setMembers(directory?.items ?? []); setError(""); setLoadError(""); setLoading(false); }
    }).catch((cause: unknown) => { if (active) { const message = describeError(cause, "Could not load administration records."); setError(message); setLoadError(message); setLoading(false); } }));
    return () => { active = false; };
  }, [revision]);

  const accessVentures = session?.hierarchy.ventures ?? [];
  const groups = accessVentures.flatMap((venture) => venture.groups.map((group) => ({ ...group, ventureName: venture.name })));
  const channelCount = groups.reduce((total, group) => total + group.channels.length, 0);
  const ventureName = (id: string) => session?.hierarchy.ventures.find((item) => item.id === id)?.name ?? id;
  const groupName = (id: string) => groups.find((item) => item.id === id)?.name ?? id;
  const personName = (id: string) => members.find((item) => item.id === id)?.name ?? (id === session?.user.id ? session.user.name : "Workspace member");

  const savedModes = (item: Membership) => Object.fromEntries(item.ventureIds.map((id) => [id, storedMode(id, item.allGroupVentureIds ?? [], item.groupIds, accessVentures)])) as Record<string, GroupMode>;
  function edit(item: Membership) {
    setSelected(item); setRole(item.role); setVentureIds(item.ventureIds); setGroupIds(item.groupIds); setModes(savedModes(item)); setShareKnowledge(Boolean(item.canShareKnowledge)); setError(""); setConfirming(false);
  }

  // Compared as the groups they end up in, so switching a venture to "All groups" lists each group it adds.
  const changes = selected ? (() => {
    const before = selected.groupIds.filter((id) => groups.some((group) => group.id === id));
    const after = effectiveGroups(ventureIds, modes, groupIds, accessVentures);
    const saved = savedModes(selected);
    return {
      role: role !== selected.role ? { from: selected.role, to: role } : null,
      addedVentures: ventureIds.filter((id) => !selected.ventureIds.includes(id)),
      removedVentures: selected.ventureIds.filter((id) => !ventureIds.includes(id)),
      addedGroups: after.filter((id) => !before.includes(id)),
      removedGroups: before.filter((id) => !after.includes(id)),
      // Picked and no groups already show as group changes; turning "All groups" on or off also changes what new groups do.
      modeChanges: ventureIds.filter((id) => selected.ventureIds.includes(id) && saved[id] !== modes[id] && (saved[id] === "all" || modes[id] === "all")).map((id) => ({ id, from: saved[id] ?? "none", to: modes[id] ?? "none" })),
      share: Boolean(selected.canShareKnowledge) !== shareKnowledge ? { to: shareKnowledge } : null,
    };
  })() : null;
  const dirty = Boolean(changes && (changes.role || changes.addedVentures.length || changes.removedVentures.length || changes.addedGroups.length || changes.removedGroups.length || changes.modeChanges.length || changes.share));
  const risky = Boolean(changes && ((changes.role && (rank[changes.role.to] < rank[changes.role.from] || changes.role.to === "admin")) || changes.removedVentures.length || changes.removedGroups.length || changes.modeChanges.some((item) => item.from === "all")));
  const needle = query.trim().toLowerCase();
  const shown = needle ? memberships.filter((item) => `${personName(item.userId)} ${item.role} ${item.ventureIds.map(ventureName).join(" ")}`.toLowerCase().includes(needle)) : memberships;
  // A failed load shows the error (with Try again) in place of the list, never "No members".
  const sessionFailed = !session && !loading && !!loadError;
  const membersFailed = session?.membership.role === "admin" && tab === "Members" && !!loadError && !memberships.length && !loading;
  const loadErrorShown = (sessionFailed || membersFailed) && error === loadError;
  const retryLoad = () => { setError(""); setRevision((value) => value + 1); };
  const quotedQuery = query.trim().length > 40 ? `${query.trim().slice(0, 40)}…` : query.trim();

  function toggleVenture(id: string) {
    const next = ventureIds.includes(id) ? ventureIds.filter((item) => item !== id) : [...ventureIds, id];
    setVentureIds(next);
    // A newly added venture starts on "All groups"; ticks in removed ventures are dropped when saving (see accessPayload).
    setModes((current) => next.includes(id) ? { ...current, [id]: current[id] ?? "all" } : current);
  }

  async function saveMembership(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !dirty || busy) return;
    if (risky && !confirming) { confirmShownAt.current = Date.now(); setConfirming(true); return; }
    // The confirm button sits where Save was; ignore a double-click that lands before the summary can be read.
    if (risky && Date.now() - confirmShownAt.current < 600) return;
    setBusy(true); setError("");
    try {
      const updated = await updateLiveMembership(selected.id, { role, ventureIds, ...accessPayload(ventureIds, modes, groupIds, accessVentures), canShareKnowledge: shareKnowledge });
      setMemberships((items) => items.map((item) => item.id === updated.id ? updated : item));
      setSelected(null); setConfirming(false);
      toast({ title: "Access updated", body: `${personName(updated.userId)} is now ${roleLabel(updated.role)} with ${updated.ventureIds.length} venture${updated.ventureIds.length === 1 ? "" : "s"}.` });
      flashById(`membership-${updated.id}`);
    } catch (cause) { setError(describeError(cause, "Could not update membership.")); setConfirming(false); }
    finally { setBusy(false); }
  }

  async function addChannel(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const created = await createLiveChannel({ groupId: channelGroupId, name: channelName });
      setChannelName(""); toast({ title: `#${created.name} created`, body: `In ${groupName(created.groupId)}.` }); setRevision((value) => value + 1); flashById(`channel-${created.id}`);
    } catch (cause) { setError(describeError(cause, "Could not create channel.")); }
    finally { setBusy(false); }
  }

  return <PageFrame>
    <PageTitle title="People & access" description="Manage the workspace hierarchy and member access." action={<HeaderActions><RefreshButton busy={loading} onClick={() => setRevision((value) => value + 1)} />{session?.membership.role === "admin" && <button type="button" onClick={() => setInviting(true)} className={primaryClass}><UserPlus size={15} />Invite member</button>}</HeaderActions>} />
    <Notice tone="error" message={selected || loadErrorShown ? "" : error} onDismiss={() => setError("")} className="pb-4" />
    {session?.membership.role !== "admin" ? session ? <Panel><EmptyState variant="card" icon={LockKeyhole} tone="blue" title="Only workspace admins can manage access" body="Ask a workspace admin if you need a different role or access to a venture." /></Panel>
      : sessionFailed ? <Panel><EmptyState variant="error" title="Could not load access" body={loadError} action={{ label: "Try again", onClick: retryLoad }} /></Panel>
      : <Panel><SkeletonRows rows={4} label="Loading workspace access" /></Panel> : <><SlidingTabs tabs={[{ key: "Members", label: "Members" }, { key: "Structure", label: "Structure" }]} active={tab} onChange={(key) => setTab(key as typeof tab)} label="Administration sections" className="mb-4" />
      <div key={tab} className={tabMotion.className} style={tabMotion.style}>{tab === "Members" && <Panel><PanelHead title="Workspace members" aside={<Badge tone="blue">{needle ? `${shown.length} of ${memberships.length}` : memberships.length}</Badge>} /><div className="border-b border-neutral-100 px-5 py-3"><label className="flex h-10 items-center gap-2 rounded-xl bg-neutral-100 px-3 text-neutral-400 transition-[background-color,box-shadow] duration-150 focus-within:bg-white focus-within:ring-2 focus-within:ring-primary-100"><Search size={15} /><span className="sr-only">Search members</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} placeholder="Search by name, role, or venture" className="min-w-0 flex-1 bg-transparent text-sm text-neutral-800 outline-none placeholder:text-neutral-400" />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="vso-fade-enter grid h-7 w-7 place-items-center rounded-md transition-colors duration-150 hover:bg-neutral-200 hover:text-neutral-600"><X size={13} /></button>}</label></div><div className="divide-y divide-neutral-100">{loading && !memberships.length ? <SkeletonRows rows={4} label="Loading members" /> : shown.length ? <div key={needle} className="vso-stagger-in"><MemberTable rows={shown.map((item) => {
        const handle = members.find((member) => member.id === item.userId)?.handle;
        return { id: item.id, flashId: `membership-${item.id}`, name: personName(item.userId), ...(handle || (item.canShareKnowledge && (item.role === "venture_head" || item.role === "contributor")) ? { detail: [handle ? `@${handle}` : "", item.canShareKnowledge && (item.role === "venture_head" || item.role === "contributor") ? "shares knowledge with all ventures" : ""].filter(Boolean).join(" · ") } : {}), you: item.userId === session.user.id, role: roleLabel(item.role), allVentures: item.role === "admin", ventures: item.ventureIds.map(ventureName), groups: item.role === "admin" ? null : item.groupIds.length, allGroups: item.role !== "admin" && item.ventureIds.length > 0 && item.ventureIds.every((id) => item.allGroupVentureIds?.includes(id)),
          // Your own access is changed by another admin, so your row has no edit button.
          action: item.userId !== session.user.id ? <button type="button" onClick={() => edit(item)} aria-label={`Edit access for ${personName(item.userId)}`} className="min-h-8 rounded-lg px-3 text-xs font-semibold text-neutral-600 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-900 active:scale-[0.97]">Edit</button> : undefined };
      })} /></div> : membersFailed ? <EmptyState variant="error" title="Could not load members" body={loadError} action={{ label: "Try again", onClick: retryLoad }} />
        : needle ? <EmptyState variant="filtered" title={`No members match “${quotedQuery}”`} body="Try a different name, role, or venture." action={{ label: "Clear search", onClick: () => setQuery("") }} />
        : <EmptyState variant="card" icon={Users} tone="blue" title="No members yet" body="Invite someone and they appear here once they accept." action={{ label: "Invite member", icon: UserPlus, onClick: () => setInviting(true) }} />}</div></Panel>}
      {tab === "Structure" && <><div className="grid gap-4 lg:grid-cols-3"><Panel className="p-4"><PanelHead title="Ventures" aside={<Link href="/ventures" className="text-xs font-semibold text-primary-700">Open ventures</Link>} />{session.hierarchy.ventures.length ? session.hierarchy.ventures.map((item) => <div key={item.id} className="border-b border-neutral-100 py-3 text-sm font-semibold text-neutral-800">{item.name}</div>) : <EmptyState variant="card" icon={Layers3} tone="green" title="No ventures yet" body="Ventures appear here once one is created." />}</Panel><Panel className="p-4"><PanelHead title="Groups" aside={<Link href="/channels" className="text-xs font-semibold text-primary-700">Open groups</Link>} />{groups.length ? groups.map((item) => <div key={item.id} className="border-b border-neutral-100 py-3"><p className="text-sm font-semibold text-neutral-800">{item.name}</p><p className="text-xs text-neutral-500">{item.ventureName}</p></div>) : <EmptyState variant="card" icon={Users} tone="teal" title="No groups yet" body="Groups inside a venture appear here." />}</Panel><Panel className="p-4"><PanelHead title="Channels" />{channelCount ? groups.flatMap((group) => group.channels.map((channel) => <div key={channel.id} data-flash-id={`channel-${channel.id}`} className="-mx-2 rounded-lg border-b border-neutral-100 px-2 py-3"><p className="text-sm font-semibold text-neutral-800"># {channel.name}</p><p className="text-xs text-neutral-500">{group.ventureName} · {group.name}</p></div>)) : <EmptyState variant="card" icon={Hash} tone="teal" title="No channels yet" body={groups.length ? "Use Create channel below to add the first one." : "Channels appear here once a group exists."} />}</Panel></div><Panel className="mt-4 max-w-xl"><PanelHead title="Create channel" /><form onSubmit={addChannel} className="space-y-4 p-5"><Field label="Group"><Select required className={inputClass} value={channelGroupId} onChange={(event) => setChannelGroupId(event.target.value)}><option value="">Choose a group</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.ventureName} · {item.name}</option>)}</Select></Field><Field label="Channel name"><input required maxLength={80} className={inputClass} value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="product-updates" /></Field><p className="text-xs leading-5 text-neutral-500">Names become channel addresses. Each name must be unique within its group.</p><button disabled={busy || !channelGroupId} className={primaryClass}><ActionLabel busy={busy} busyText="Creating…" idle="Create channel" /></button></form></Panel></>}</div>
    </>}
    {selected && <DetailDrawer title="Edit member access" subtitle={personName(selected.userId)} dirty={dirty} onClose={() => { setSelected(null); setConfirming(false); }}><form onSubmit={saveMembership} className="space-y-5"><Notice tone="error" message={error} onDismiss={() => setError("")} /><Field label="Role"><Select className={inputClass} value={role} onChange={(event) => { setRole(event.target.value as Role); setConfirming(false); }}><option value="admin">Admin</option><option value="venture_head">Venture head</option><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option><option value="learner">Learner</option></Select></Field><fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Ventures</legend><div className="space-y-2">{session?.hierarchy.ventures.map((item) => <label key={item.id} className={checkRow}><input type="checkbox" checked={ventureIds.includes(item.id)} onChange={() => { toggleVenture(item.id); setConfirming(false); }} />{item.name}</label>)}</div></fieldset><fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Group access</legend>{accessVentures.some((item) => ventureIds.includes(item.id)) ? <GroupAccessPicker ventures={accessVentures.filter((item) => ventureIds.includes(item.id))} modes={modes} groupIds={groupIds} onMode={(id, mode) => { setModes((current) => ({ ...current, [id]: mode })); setConfirming(false); }} onToggleGroup={(id) => { setGroupIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); setConfirming(false); }} /> : <p className="text-xs text-neutral-500">Choose a venture to set which of its groups they join.</p>}</fieldset><fieldset><legend className="mb-2 text-xs font-semibold text-neutral-600">Knowledge</legend><label className={clsx(checkRow, !(role === "venture_head" || role === "contributor") && "cursor-not-allowed opacity-60")}><input type="checkbox" checked={role === "admin" || ((role === "venture_head" || role === "contributor") && shareKnowledge)} disabled={!(role === "venture_head" || role === "contributor")} onChange={(event) => { setShareKnowledge(event.target.checked); setConfirming(false); }} className="accent-[var(--color-primary-600)]" /><span>Can share knowledge with all ventures</span></label><p className="mt-1.5 text-xs leading-5 text-neutral-500">{role === "admin" ? "Admins always can." : (role === "venture_head" || role === "contributor") ? "They publish documents every venture sees, and approve other people's requests to. Without it, their requests wait for an approver." : "Only contributors and venture heads can be given this."}</p></fieldset>
      <div data-open={dirty} className="vso-collapse"><div><div className={clsx("rounded-xl border p-3 text-xs leading-5 transition-colors duration-200", confirming ? "border-warning bg-warning-surface text-warning-text" : "border-neutral-200 bg-neutral-50 text-neutral-600")}><p className="font-semibold">{confirming ? changes?.role?.to === "admin" && !changes.removedVentures.length && !changes.removedGroups.length ? "Admins can see and change everything. Confirm:" : "This changes access. Confirm these changes:" : "Changes to save"}</p><ul className="mt-1.5 space-y-0.5">{changes?.role && <li>Role: {roleLabel(changes.role.from)} → <strong>{roleLabel(changes.role.to)}</strong></li>}{changes?.addedVentures.map((id) => <li key={`+v${id}`}>+ Venture {ventureName(id)} · {modeLabel[modes[id] ?? "none"]}</li>)}{changes?.modeChanges.map((item) => <li key={`m${item.id}`}>{ventureName(item.id)}: {modeLabel[item.from]} → <strong>{modeLabel[item.to]}</strong>{item.from === "all" && <span className="opacity-75"> (new groups no longer added)</span>}</li>)}{changes?.removedVentures.map((id) => <li key={`-v${id}`} className="font-semibold">− Venture {ventureName(id)}</li>)}{changes?.addedGroups.map((id) => <li key={`+g${id}`}>+ Group {groupName(id)}</li>)}{changes?.removedGroups.map((id) => <li key={`-g${id}`} className="font-semibold">− Group {groupName(id)}</li>)}{changes?.share && <li className={clsx(!changes.share.to && "font-semibold")}>{changes.share.to ? "+ Can share knowledge with all ventures" : "− Can no longer share knowledge with all ventures"}</li>}</ul></div></div></div>
      <p className="text-xs leading-5 text-neutral-500">Saving replaces the member’s role and access. Changes are recorded in the audit log.</p><div className="flex flex-wrap gap-2"><button disabled={busy || !dirty} className={clsx(primaryClass, confirming && "!bg-[#a95142] hover:!bg-[#94463a]")}><ActionLabel busy={busy} idle={confirming ? "Confirm and save" : "Save access"} /></button>{confirming && <button type="button" onClick={() => setConfirming(false)} className={clsx(secondaryClass, "vso-fade-enter")}>Review again</button>}</div></form></DetailDrawer>}
    {inviting && session && <InviteMemberDrawer ventures={session.hierarchy.ventures} onClose={() => setInviting(false)} onInvited={(email) => { setInviting(false); toast({ title: "Invitation sent", body: `${email} will get a link to join. They appear here once they accept.` }); }} />}
  </PageFrame>;
}
