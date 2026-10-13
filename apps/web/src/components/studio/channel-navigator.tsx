"use client";

import { Select } from "@/components/ui/select";
import { useSyncExternalStore } from "react";
import { ChevronRight, Hash, Layers3, Plus, UserLock } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { getNotificationSnapshot, subscribeNotificationSnapshot } from "@/lib/notification-events";
import clsx from "clsx";
import { ChatAvatar, ChatNav } from "./chat-ui";
import type { loadLiveSession } from "@/lib/studio-api";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type CreateKind = "venture" | "group" | "channel";

type Props = {
  session: Session | null;
  selectedVentureId: string;
  selectedGroupId: string;
  selectedChannelId: string;
  railExpanded: boolean;
  listOpen: boolean;
  realtime: string;
  canCreate: boolean;
  onVentureSelect: (id: string) => void;
  onGroupSelect: (id: string) => void;
  onChannelSelect: (id: string) => void;
  onToggleRail: () => void;
  onCreate: (kind: CreateKind, parent?: string) => void;
};

/** True for someone who cannot create spaces and sits in no group at all: there is nothing for them to choose. */
export const lacksGroupAccess = (session: Session | null, canCreate: boolean) => !!session && !canCreate && !session.hierarchy.ventures.some((item) => item.groups.length > 0);

export function ChannelNavigator(props: Props) {
  const { session, selectedVentureId, selectedGroupId, selectedChannelId, railExpanded, listOpen, realtime, canCreate, onVentureSelect, onGroupSelect, onChannelSelect, onToggleRail, onCreate } = props;
  const venture = session?.hierarchy.ventures.find((item) => item.id === selectedVentureId);
  const group = venture?.groups.find((item) => item.id === selectedGroupId);
  const channels = group?.channels ?? [];
  const noAccess = lacksGroupAccess(session, canCreate);
  const ventureCount = session?.hierarchy.ventures.length ?? 0;
  // Nothing is selected: say why (no access, nothing created yet, or just pick one) instead of "Choose a venture".
  const noGroupEmpty = !session || group ? null : noAccess
    ? <EmptyState variant="card" tone="blue" icon={UserLock} title="You're not in a group yet" body="Ask a workspace admin to add you to a group to see its channels." />
    : !venture
      ? ventureCount === 0 && canCreate
        ? <EmptyState variant="card" tone="teal" icon={Layers3} title="No ventures yet" body="Create a venture, then add a group to start conversations." action={{ label: "Create venture", icon: Plus, onClick: () => onCreate("venture") }} />
        : <EmptyState variant="compact" icon={Layers3} title="Choose a venture" body="Pick one above." className="m-2" />
      : venture.groups.length === 0
        ? canCreate
          ? <EmptyState variant="card" tone="teal" icon={Layers3} title="No groups in this venture yet" body={`Create a group to start conversations in ${venture.name}.`} action={{ label: "Create group", icon: Plus, onClick: () => onCreate("group", venture.id) }} />
          : <EmptyState variant="card" tone="blue" icon={UserLock} title="No groups in this venture yet" body={`Ask a workspace admin to add you to a group in ${venture.name}.`} />
        : <EmptyState variant="compact" icon={Layers3} title="Choose a group" body="Pick one from the rail." className="m-2" />;
  // A dot marks channels with an unread @mention for you (each channel's bell decides what else notifies).
  const snapshot = useSyncExternalStore(subscribeNotificationSnapshot, getNotificationSnapshot, () => null);
  const mentioned = new Set((snapshot ?? []).filter((item) => !item.readAt && item.chatKind === "channel" && item.chatId).map((item) => item.chatId!));

  return <aside role={listOpen ? "dialog" : undefined} aria-modal={listOpen ? true : undefined} aria-label="Channel navigation" className={clsx("chat-list shrink-0 flex-col border-r border-[var(--color-neutral-200)] bg-white max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:w-[min(350px,94vw)] max-md:shadow-xl md:flex md:transition-[width] md:duration-200 md:ease-[var(--ease-drawer)]", railExpanded ? "md:w-[420px]" : "md:w-[330px]", listOpen ? "vso-enter-left flex" : "hidden")}>
    <div className="flex h-[68px] shrink-0 items-center gap-1.5 border-b border-[var(--color-neutral-100)] px-2 sm:px-3">
      <ChatNav mode="channels" />
      <div className="relative min-w-0 flex-1"><label htmlFor="channel-venture" className="sr-only">Select venture</label><Select id="channel-venture" value={selectedVentureId} onChange={(event) => onVentureSelect(event.target.value)} disabled={!session || session.hierarchy.ventures.length === 0} className="h-9 w-full appearance-none truncate rounded-lg bg-[var(--color-neutral-100)] pl-2.5 pr-6 text-[11px] font-semibold text-[var(--color-neutral-700)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)]">{(!session || session.hierarchy.ventures.length === 0) && <option value="">{session ? "No ventures" : "Loading ventures…"}</option>}{session?.hierarchy.ventures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
      {canCreate && <button type="button" aria-label="Create venture" title="Create venture" onClick={() => onCreate("venture")} className="chat-icon"><Plus size={17} /></button>}
    </div>
    <div className="flex min-h-0 flex-1">
      <div className={clsx("thin-scroll flex shrink-0 flex-col overflow-y-auto border-r border-[var(--color-neutral-200)] bg-[var(--color-neutral-50)] px-2 py-3 transition-[width] duration-200 ease-[var(--ease-drawer)]", railExpanded ? "w-[148px] md:w-[180px]" : "w-[58px] md:w-[66px]")}>
        <div className={clsx("mb-3 flex items-center", railExpanded ? "justify-between" : "justify-center")}>
          {railExpanded && <span className="vso-fade-enter truncate pl-1 text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--color-neutral-400)]">Groups</span>}
          <button type="button" aria-label={railExpanded ? "Collapse group rail" : "Expand group rail"} aria-expanded={railExpanded} onClick={onToggleRail} className="chat-icon !h-9 !w-9"><ChevronRight size={16} className={clsx("transition-transform duration-200", railExpanded && "rotate-180")} /></button>
        </div>
        {venture?.groups.map((item) => { const active = item.id === selectedGroupId; const short = item.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase(); return <button key={item.id} type="button" title={item.name} aria-label={`Open ${item.name} group`} aria-pressed={active} onClick={() => onGroupSelect(item.id)} className={clsx("mb-2 flex min-h-11 w-full items-center rounded-xl text-left transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)] active:scale-[0.97]", railExpanded ? "gap-2 px-1.5" : "justify-center", active ? "bg-[var(--color-primary-100)] text-[var(--color-primary-700)]" : "text-[var(--color-neutral-500)] hover:bg-white")}><span className={clsx("grid h-10 w-10 shrink-0 place-items-center rounded-[11px] text-[11px] font-semibold", active ? "bg-[var(--color-primary-600)] text-white" : "bg-white text-[var(--color-neutral-500)]")}>{short || <Layers3 size={17} />}</span>{railExpanded && <span className="min-w-0 truncate text-[11px] font-semibold">{item.name}</span>}</button>; })}
        {venture && venture.groups.length === 0 && <p className="px-1 text-center text-[10px] leading-4 text-[var(--color-neutral-400)]">{railExpanded ? noAccess ? "You're not in a group yet." : "No groups in this venture yet." : "No groups"}</p>}
        {canCreate && venture && <button type="button" onClick={() => onCreate("group", venture.id)} title={`Create group in ${venture.name}`} aria-label={`Create group in ${venture.name}`} className={clsx("mt-1 flex min-h-10 items-center rounded-xl text-[var(--color-primary-700)] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)]", railExpanded ? "gap-2 px-2 text-[11px] font-semibold" : "justify-center")}><Plus size={17} />{railExpanded && <span>Create group</span>}</button>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-[58px] items-center justify-between gap-1 px-3 pt-2"><div className="min-w-0"><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[var(--color-neutral-400)]">Channels</p><h1 className="truncate text-[13px] font-semibold text-[var(--color-neutral-800)]">{group?.name ?? (noAccess ? "Not in a group" : venture ? "Choose a group" : "Choose a venture")}</h1></div>{canCreate && group && <button type="button" aria-label={`Create channel in ${group.name}`} title={`Create channel in ${group.name}`} onClick={() => onCreate("channel", group.id)} className="chat-icon"><Plus size={17} /></button>}</div>
        <nav aria-label={group ? `Channels in ${group.name}` : "Channels"} className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {channels.map((channel) => <button key={channel.id} type="button" onClick={() => onChannelSelect(channel.id)} aria-pressed={channel.id === selectedChannelId} className={clsx("my-0.5 flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11px] font-medium transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-600)] active:scale-[0.98]", selectedChannelId === channel.id ? "bg-[var(--color-primary-100)] font-semibold text-[var(--color-primary-700)]" : "text-[var(--color-neutral-600)] hover:bg-[var(--color-neutral-50)]")}><Hash size={14} className="shrink-0" /><span className="flex-1 truncate">{channel.name}</span>{mentioned.has(channel.id) && channel.id !== selectedChannelId && <span role="img" aria-label="Unread mention" title="You were mentioned" className="vso-badge-pop h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary-600)]" />}</button>)}
          {group && channels.length === 0 && <EmptyState variant="compact" icon={Hash} title="No channels yet" body={canCreate ? undefined : "Ask a workspace admin to add one."} action={canCreate ? { label: "Create channel", onClick: () => onCreate("channel", group.id) } : undefined} className="m-1 mt-3" />}
          {noGroupEmpty}
          {!session && <div role="status" aria-label="Loading channels" className="grid gap-2 px-2 py-2">{[70, 55, 62].map((width) => <span key={width} className="vso-skeleton h-8" style={{ width: `${width}%` }} />)}</div>}
        </nav>
      </div>
    </div>
    {session && <div className="flex items-center gap-2 border-t border-[var(--color-neutral-100)] px-3 py-3"><ChatAvatar id={session.user.id} name={session.user.name} size={30} /><span className="min-w-0 truncate text-[10px] font-semibold">{session.user.name}</span><span className="ml-auto inline-flex items-center gap-1.5 text-[9px] text-[var(--color-neutral-400)]"><span aria-hidden="true" className={clsx("h-1.5 w-1.5 rounded-full transition-colors duration-300", realtime === "live" ? "bg-[var(--color-success)]" : realtime === "connecting" ? "animate-pulse bg-[var(--color-warning)]" : "bg-[var(--color-neutral-300)]")} />{realtime === "live" ? "Live" : realtime === "connecting" ? "Connecting…" : "Offline"}</span></div>}
  </aside>;
}
