"use client";
import { notificationRefreshEvent } from "@/lib/notification-events";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpenText, Bookmark, Columns3, FolderOpen, Hash, Info, Layers3, Menu, Pin, Plus, RefreshCw, Search, UserLock, Users, X } from "@/components/ui/icons";
import clsx from "clsx";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ChannelNotifyMenu } from "@/components/studio/channel-notify-menu";
import type { CommandPreview, Message } from "@venture-studio/contracts";
import { createLiveChannel, createLiveGroup, createLiveVenture, executeLiveCommand, listLiveChannelMessages, listLiveMembers, loadLiveSession, previewLiveCommand, sendLiveChannelMessage, updateLiveMessagePin, updateLiveMessageReaction, updateLiveMessageSave } from "@/lib/studio-api";
import { ChatAvatar, ChatEmpty, ChatShell } from "@/components/studio/chat-ui";
import { ChannelNavigator, lacksGroupAccess } from "@/components/studio/channel-navigator";
import { EmptyState } from "@/components/ui/empty-state";
import { ChannelSearchDialog } from "@/components/studio/channel-search-dialog";
import { GroupWorkspaceSheet, type WorkspaceTab } from "@/components/studio/group-workspace-sheet";
import { GroupPeople } from "@/components/studio/group-people";
import { AttachmentMenu, AttachmentTray, MessageAttachmentList, messageAttachments, useChatAttachments } from "@/components/studio/chat-attachments";
import { useLiveRealtime } from "@/lib/use-live-realtime";
import { useStudio } from "@/lib/studio-store";
import { ChatSendIcon, playChatSound, prepareChatAudio, useChatMessageArrival } from "@/components/studio/chat-message-effects";
import { ChatMessageMenu } from "@/components/studio/chat-message-menu";
import { useActiveChatPresence } from "@/lib/chat-presence";
import { mentionsIn, useMentionNames, withMentionHandles, withMentionNames } from "@/lib/mention-names";
import { autosize, continuesGroup, DaySeparator, ViaClaude, isComposing, jumpToMessage, MessageText, NewMessagesPill, PendingStatus, QuickReactionBar, ReactionChips, startsNewDay, timeLabel, toggledReaction, useChatScroll, type PendingMessage } from "@/components/studio/chat-thread";
import { Notice } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { useExitTransition } from "@/lib/motion";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
type CreateKind = "venture" | "group" | "channel";
const errorText = (cause: unknown) => describeError(cause, "The request failed. Please try again.");
const stamp = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const SLASH_COMMANDS = [{ command: "/assign", hint: "@person \"Task title\" due=YYYY-MM-DD", detail: "Create a task for a group member" }, { command: "/notify", hint: "@person \"Message\" at=YYYY-MM-DDTHH:MM", detail: "Schedule a reminder for someone" }];

/** Placeholder bubbles shown while a channel's messages (or the workspace itself) load. */
function MessagesSkeleton() {
  return <div role="status" aria-label="Loading messages" className="space-y-6 pt-2">{[52, 38, 60, 30].map((width, index) => <div key={index} className={clsx("flex items-start gap-2", index % 2 && "flex-row-reverse")}><span className="vso-skeleton mt-5 h-[25px] w-[25px] shrink-0 rounded-full" /><span className="grid gap-1.5" style={{ width: `${width}%` }}><span className={clsx("vso-skeleton h-2.5 w-20", index % 2 && "justify-self-end")} /><span className="vso-skeleton h-10 rounded-2xl" /></span></div>)}</div>;
}

export function LiveChannelsScreen() {
  const { activeVentureId, setActiveVentureId, data: shellData } = useStudio();
  // A venture created here is unknown to the sidebar until the shell reloads; hold the scope handoff until then.
  const [pendingScope, setPendingScope] = useState<{ ventureId: string; from: string } | null>(null);
  const params = useSearchParams();
  const router = useRouter();
  const initialScope = useRef({ venture: params.get("venture"), group: params.get("group"), channel: params.get("channel") });
  const [session, setSession] = useState<Session | null>(null);
  const [selectedVentureId, setSelectedVentureId] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [railExpanded, setRailExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const shownChannel = useRef("");
  const [messagesError, setMessagesError] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [memberState, setMemberState] = useState<{ groupId: string; items: Member[]; loading: boolean; error: string }>({ groupId: "", items: [], loading: false, error: "" });
  const [memberRevision, setMemberRevision] = useState(0);
  const [composer, setComposer] = useState("");
  const [mentionRange, setMentionRange] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [createName, setCreateName] = useState("");
  const [createGoal, setCreateGoal] = useState("");
  const [createParent, setCreateParent] = useState("");
  // Messages shown before the server confirms them; `localKeys` keeps the same row once they are real.
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [localKeys, setLocalKeys] = useState<Record<string, string>>({});
  const [replyShown, setReplyShown] = useState<Message | null>(null);
  if (replyTo && replyTo !== replyShown) setReplyShown(replyTo);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const [reloading, setReloading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const listButtonRef = useRef<HTMLButtonElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const createDialogRef = useRef<HTMLElement>(null);
  const createReturnRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const workspaceReturnRef = useRef<HTMLElement | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  // The workspace sheet slides back down before it unmounts.
  const workspaceExit = useExitTransition(() => {
    setWorkspaceTab(null);
    requestAnimationFrame(() => (workspaceReturnRef.current?.getClientRects().length ? workspaceReturnRef.current : detailsButtonRef.current)?.focus());
  }, 240);
  const closeSheet = workspaceExit.close;
  const pendingJumpRef = useRef("");
  const jumpPagesRef = useRef(0);
  const loadOlderRef = useRef<() => void>(() => undefined);
  const clientId = useRef<string | null>(null);
  const activeConversationId = useRef(selectedId);
  const realtime = useLiveRealtime(() => setRevision((value) => value + 1), selectedId || undefined);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => loadLiveSession().then((value) => {
      if (!active) return;
      setSession(value);
      const ventures = value.hierarchy.ventures;
      const requested = initialScope.current;
      const channelVenture = ventures.find((venture) => venture.groups.some((group) => group.channels.some((channel) => channel.id === requested.channel)));
      const channelGroup = channelVenture?.groups.find((group) => group.channels.some((channel) => channel.id === requested.channel));
      const groupVenture = ventures.find((venture) => venture.groups.some((group) => group.id === requested.group));
      const chosenVenture = channelVenture ?? (requested.venture ? ventures.find((venture) => venture.id === requested.venture) : undefined) ?? groupVenture ?? ventures.find((venture) => venture.id === activeVentureId) ?? ventures[0];
      const chosenGroup = channelGroup ?? chosenVenture?.groups.find((group) => group.id === requested.group) ?? chosenVenture?.groups[0];
      const chosenChannel = chosenGroup?.channels.find((channel) => channel.id === requested.channel) ?? chosenGroup?.channels[0];
      setSelectedVentureId(chosenVenture?.id ?? "");
      if (chosenVenture && (requested.channel || requested.group || requested.venture)) setActiveVentureId(chosenVenture.id);
      setSelectedGroupId(chosenGroup?.id ?? "");
      setSelectedId(chosenChannel?.id ?? "");
      setMessagesLoading(Boolean(chosenChannel));
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); }));
    return () => { active = false; };
  // URL context is applied once; subsequent global scope changes use the effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session || pendingScope || !activeVentureId || activeVentureId === selectedVentureId) return;
    const nextVenture = session.hierarchy.ventures.find((item) => item.id === activeVentureId);
    if (!nextVenture) return;
    const nextGroup = nextVenture.groups[0];
    const nextChannel = nextGroup?.channels[0];
    queueMicrotask(() => {
      setSelectedVentureId(nextVenture.id); setSelectedGroupId(nextGroup?.id ?? "");
      resetConversation(nextChannel?.id ?? "");
      const next = new URLSearchParams({ venture: nextVenture.id });
      if (nextGroup) next.set("group", nextGroup.id);
      if (nextChannel) next.set("channel", nextChannel.id);
      router.replace(`/channels/live?${next}`, { scroll: false });
    });
  }, [activeVentureId, pendingScope, selectedVentureId, session, router]);

  useEffect(() => {
    if (!pendingScope) return;
    // The member picked another scope meanwhile; let the ordinary sync follow that choice.
    if (activeVentureId !== pendingScope.from) { queueMicrotask(() => setPendingScope(null)); return; }
    if (!shellData.ventures.some((venture) => venture.id === pendingScope.ventureId)) return;
    setActiveVentureId(pendingScope.ventureId);
    queueMicrotask(() => setPendingScope(null));
  }, [activeVentureId, pendingScope, setActiveVentureId, shellData.ventures]);

  const venture = session?.hierarchy.ventures.find((item) => item.id === selectedVentureId);
  const group = venture?.groups.find((item) => item.id === selectedGroupId);
  const selected = group?.channels.find((channel) => channel.id === selectedId);
  const attachments = useChatAttachments(selectedId, selected ? { ventureId: selectedVentureId, groupId: selectedGroupId } : null);
  useActiveChatPresence("channel", selectedId);
  useEffect(() => { if (selectedId) window.dispatchEvent(new Event(notificationRefreshEvent)); }, [selectedId]);
  const arrived = useChatMessageArrival(selectedId, messages, session?.user.id, !messagesLoading);
  useEffect(() => { activeConversationId.current = selectedId; }, [selectedId]);
  const [directory, setDirectory] = useState<Record<string, string>>({});
  const mentionNames = useMentionNames();
  // Mentions picked from the list read as "@Name" while writing; they are sent as "@handle".
  const chosenMentions = useRef(new Map<string, string>());
  const sessionUserId = session?.user.id;
  useEffect(() => {
    if (!sessionUserId) return;
    let active = true;
    queueMicrotask(() => listLiveMembers({ limit: 100 }).then((page) => { if (active) setDirectory(Object.fromEntries(page.items.map((item) => [item.id, item.name]))); }).catch(() => { /* Names fall back to the group roster. */ }));
    return () => { active = false; };
  }, [sessionUserId]);
  const activeGroupId = group?.id ?? "";
  const members = memberState.groupId === activeGroupId ? memberState.items : [];
  const membersLoading = Boolean(activeGroupId) && (memberState.groupId !== activeGroupId || memberState.loading);
  const membersError = memberState.groupId === activeGroupId ? memberState.error : "";
  const canCreate = session?.membership.role === "admin";
  // Learners can read channels but not post (the API refuses message:write).
  const canPost = !!session && session.membership.role !== "learner";
  const canCommand = session?.membership.role === "admin" || session?.membership.role === "venture_head";
  const mentionSuggestions = mentionRange ? members.filter((member) => member.id !== session?.user.id && member.handle && `${member.name} ${member.handle}`.toLowerCase().includes(mentionRange.query.toLowerCase())).slice(0, 6) : [];

  function trackMention(value: string, cursor: number) {
    const match = value.slice(0, cursor).match(/(?:^|[^\w@])@([a-z0-9._-]*)$/i);
    setMentionRange(match ? { start: cursor - match[1]!.length - 1, end: cursor, query: match[1]! } : null);
    setMentionIndex(0);
  }

  function chooseMention(member: Member) {
    if (!mentionRange || !member.handle) return;
    // Two people with the same name: the second is written by handle, so each mention stays unambiguous.
    const taken = chosenMentions.current.get(member.name);
    const byName = !taken || taken === member.handle;
    if (byName) chosenMentions.current.set(member.name, member.handle);
    const replacement = `@${byName ? member.name : member.handle} `;
    const next = `${composer.slice(0, mentionRange.start)}${replacement}${composer.slice(mentionRange.end)}`;
    const caret = mentionRange.start + replacement.length;
    setComposer(next); setMentionRange(null); clientId.current = null;
    requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(caret, caret); });
  }

  const slashMatches = canCommand && /^\/[a-z]*$/i.test(composer) ? SLASH_COMMANDS.filter((item) => item.command.startsWith(composer.toLowerCase())) : [];
  function chooseSlash(command: string) {
    setComposer(`${command} `); setSlashIndex(0); clientId.current = null;
    requestAnimationFrame(() => { const input = composerRef.current; if (!input) return; input.focus(); input.setSelectionRange(input.value.length, input.value.length); autosize(input); });
  }

  function closeSearch() { setSearchOpen(false); requestAnimationFrame(() => searchButtonRef.current?.focus()); }

  useEffect(() => {
    if (!createKind) return;
    createDialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('[role="combobox"]'))) return; closeCreateRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = createDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), input:not([disabled]), textarea:not([disabled])');
      if (!items?.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createKind]);

  useEffect(() => {
    if (!listOpen || createKind) return;
    const navigator = document.querySelector<HTMLElement>('aside[aria-label="Channel navigation"]');
    navigator?.querySelector<HTMLSelectElement>("#channel-venture")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('[role="combobox"]'))) return; setListOpen(false); listButtonRef.current?.focus(); return; }
      if (event.key !== "Tab") return;
      const items = navigator?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), input:not([disabled])');
      if (!items?.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen, createKind]);

  useEffect(() => {
    if (!workspaceTab || createKind) return;
    workspaceRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof HTMLElement && event.target.closest('[role="combobox"]'))) closeSheet(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaceTab, createKind, closeSheet]);

  // On small screens the details panel covers the chat; Esc closes it like any overlay.
  useEffect(() => {
    if (!detailsOpen || workspaceTab || createKind) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || window.innerWidth >= 1024) return;
      event.preventDefault(); setDetailsOpen(false); detailsButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen, workspaceTab, createKind]);

  useEffect(() => {
    if (!workspaceTab) return;
    const onResize = () => { if (window.innerWidth < 1024) setDetailsOpen(false); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [workspaceTab]);

  useEffect(() => {
    if (!selectedId || !session) return;
    let active = true;
    queueMicrotask(() => { if (!active) return; if (shownChannel.current !== selectedId) setMessagesLoading(true); else setReloading(true); });
    queueMicrotask(() => listLiveChannelMessages(selectedId).then((page) => {
      if (!active) return;
      const sameChannel = shownChannel.current === selectedId;
      shownChannel.current = selectedId;
      // A refresh brings the newest page; keep older history the reader already loaded instead of dropping it.
      const latest = new Set(page.items.map((item) => item.id));
      const oldest = page.items[0]?.createdAt;
      const older = sameChannel && oldest ? messagesRef.current.filter((item) => !latest.has(item.id) && item.createdAt < oldest) : [];
      setMessages([...older, ...page.items]);
      if (!older.length) setCursor(page.nextCursor);
      setMessagesError(""); setMessagesLoading(false); setReloading(false);
    }).catch((cause: unknown) => { if (active) { setMessagesError(errorText(cause)); setMessagesLoading(false); setReloading(false); } }));
    return () => { active = false; };
  }, [selectedId, revision, session]);

  useEffect(() => {
    if (!group?.id) return;
    let active = true;
    const groupId = group.id;
    queueMicrotask(async () => {
      if (!active) return;
      setMemberState({ groupId, items: [], loading: true, error: "" });
      try {
        const items: Member[] = [];
        let cursor: string | undefined;
        do {
          const page = await listLiveMembers({ groupId, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!active) return;
          items.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        if (active) setMemberState({ groupId, items, loading: false, error: "" });
      } catch (cause) { if (active) setMemberState({ groupId, items: [], loading: false, error: errorText(cause) }); }
    });
    return () => { active = false; };
  }, [group?.id, memberRevision]);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => {
    const id = pendingJumpRef.current;
    if (!id || messagesLoading || workspaceTab || busy) return;
    if (jumpToMessage(listRef.current, id)) { pendingJumpRef.current = ""; jumpPagesRef.current = 0; return; }
    // An older saved message: page back through history (a few pages at most) until it is loaded.
    if (cursor && jumpPagesRef.current < 8) { jumpPagesRef.current += 1; loadOlderRef.current(); return; }
    pendingJumpRef.current = ""; jumpPagesRef.current = 0;
    toast({ tone: "info", title: "Couldn't find that message", body: "It may have been deleted, or it is further back than the history loaded here." });
  }, [messagesLoading, workspaceTab, messages, busy, cursor]);
  useEffect(() => { loadOlderRef.current = () => { void more(); }; });
  const channelPending = pending.filter((item) => item.conversationId === selectedId);
  const scroll = useChatScroll(listRef, selectedId, messages.at(-1)?.id ?? "", channelPending.at(-1)?.clientId ?? "");

  function writeScope(ventureId: string, groupId: string, channelId: string) {
    const next = new URLSearchParams();
    if (ventureId) next.set("venture", ventureId);
    if (groupId) next.set("group", groupId);
    if (channelId) next.set("channel", channelId);
    router.replace(`/channels/live${next.size ? `?${next}` : ""}`, { scroll: false });
  }

  function resetConversation(channelId: string) {
    setSelectedId(channelId); setMessages([]); setCursor(undefined); setMessagesLoading(Boolean(channelId)); setMessagesError(""); setPreview(null); setReplyTo(null); setComposer(""); chosenMentions.current.clear(); setMentionRange(null); setSearchOpen(false); setResult(""); setError(""); clientId.current = null;
    requestAnimationFrame(() => autosize(composerRef.current));
  }

  function changeVenture(id: string) {
    const nextVenture = session?.hierarchy.ventures.find((item) => item.id === id);
    if (!nextVenture) return;
    const nextGroup = nextVenture.groups[0];
    const nextChannel = nextGroup?.channels[0];
    setActiveVentureId(id); setSelectedVentureId(id); setSelectedGroupId(nextGroup?.id ?? ""); setRailExpanded(false); if ((nextChannel?.id ?? "") !== selectedId) resetConversation(nextChannel?.id ?? ""); closeList(); writeScope(id, nextGroup?.id ?? "", nextChannel?.id ?? "");
  }

  function changeGroup(id: string) {
    const nextGroup = venture?.groups.find((item) => item.id === id);
    if (!nextGroup) return;
    const nextChannel = nextGroup.channels[0];
    setSelectedGroupId(id); setRailExpanded(false); if ((nextChannel?.id ?? "") !== selectedId) resetConversation(nextChannel?.id ?? ""); closeList(); writeScope(selectedVentureId, id, nextChannel?.id ?? "");
  }

  function changeChannel(id: string) {
    if (!group?.channels.some((item) => item.id === id)) return;
    if (id !== selectedId) resetConversation(id); closeList(); writeScope(selectedVentureId, selectedGroupId, id);
  }

  function closeList() { setListOpen(false); if (listOpen) listButtonRef.current?.focus(); }

  function openWorkspace(tab: WorkspaceTab) {
    workspaceReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (window.matchMedia("(max-width: 1023px)").matches) setDetailsOpen(false);
    workspaceExit.cancel();
    setWorkspaceTab(tab);
  }

  function closeWorkspace() { workspaceExit.close(); }

  /** From a saved message: close the sheet, open its channel, and glide to the message once it is on screen. */
  function openSavedMessage(target: { id: string; channelId: string }) {
    pendingJumpRef.current = target.id;
    jumpPagesRef.current = 0;
    closeWorkspace();
    if (target.channelId !== selectedId) changeChannel(target.channelId);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = withMentionHandles(composer.trim(), chosenMentions.current);
    if (!selectedId || busy || (!body && !attachments.items.length) || attachments.uploading) return;
    prepareChatAudio();
    setError(""); setResult(""); setPreview(null);
    if (body.startsWith("/")) {
      setBusy(true);
      try {
        if (attachments.items.length) throw new Error("Send attachments separately from slash commands.");
        setPreview(await previewLiveCommand({ channelId: selectedId, input: body }));
      } catch (cause) { setError(errorText(cause)); }
      finally { setBusy(false); }
      return;
    }
    // The message appears at once (faded) and becomes real when the server confirms it.
    submit({ clientId: clientId.current ?? crypto.randomUUID(), conversationId: selectedId, body, attachmentFileIds: attachments.items.map((file) => file.id), attachments: attachments.items, ...(replyTo ? { threadRootId: replyTo.id } : {}), createdAt: new Date().toISOString(), state: "sending" });
    clientId.current = null; setComposer(""); chosenMentions.current.clear(); setMentionRange(null); setReplyTo(null); attachments.clear();
    requestAnimationFrame(() => autosize(composerRef.current));
  }

  function submit(entry: PendingMessage) {
    const channelId = entry.conversationId;
    setPending((items) => [...items.filter((item) => item.clientId !== entry.clientId), { ...entry, state: "sending", error: undefined }]);
    void (async () => {
      try {
        const handles = [...new Set([...entry.body.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9._-]*)/gi)].map((match) => match[1]!.toLowerCase().replace(/[._-]+$/, "")))];
        const groupId = session?.hierarchy.ventures.flatMap((item) => item.groups).find((item) => item.channels.some((channel) => channel.id === channelId))?.id;
        const resolved = await Promise.all(handles.map(async (handle) => {
          const page = await listLiveMembers({ groupId, handle, limit: 1 });
          const member = page.items[0];
          if (!member || member.handle?.toLowerCase() !== handle) throw new Error(`@${handle} is not an active member of this channel.`);
          return member.id;
        }));
        const created = await sendLiveChannelMessage(channelId, { body: entry.body, attachmentFileIds: entry.attachmentFileIds, mentionUserIds: resolved, clientId: entry.clientId, ...(entry.threadRootId ? { threadRootId: entry.threadRootId } : {}) });
        playChatSound("sent");
        setLocalKeys((keys) => ({ ...keys, [created.message.id]: entry.clientId }));
        if (activeConversationId.current === channelId) setMessages((items) => items.some((item) => item.id === created.message.id) ? items : [...items, created.message]);
        setPending((items) => items.filter((item) => item.clientId !== entry.clientId));
      } catch (cause) {
        setPending((items) => items.map((item) => item.clientId === entry.clientId ? { ...item, state: "failed", error: errorText(cause) } : item));
      }
    })();
  }

  function editPending(entry: PendingMessage) {
    if (composer.trim() || attachments.items.length) { toast({ tone: "info", title: "Finish your current draft first", body: "Send or clear what you're writing, then edit the message that failed." }); return; }
    setPending((items) => items.filter((item) => item.clientId !== entry.clientId));
    // Mentions read as names again (a name already picked for someone else stays a handle).
    const editable = new Map<string, string>();
    for (const [name, handle] of mentionsIn(entry.body, mentionNames)) {
      const taken = chosenMentions.current.get(name);
      if (taken && taken !== handle) continue;
      chosenMentions.current.set(name, handle);
      editable.set(handle.toLowerCase(), name);
    }
    setComposer(withMentionNames(entry.body, editable));
    clientId.current = entry.clientId;
    if (entry.attachments?.length) attachments.restore(entry.attachments);
    const root = entry.threadRootId ? messages.find((item) => item.id === entry.threadRootId) : undefined;
    if (root) setReplyTo(root);
    requestAnimationFrame(() => { autosize(composerRef.current); composerRef.current?.focus(); });
  }

  async function execute() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const executed = await executeLiveCommand({ previewId: preview.previewId, idempotencyKey: preview.previewId }, preview.command.kind);
      const task = executed.task;
      if (task) toast({ title: "Task created", body: `${task.title} · its reminder is scheduled.`, action: { label: "Open task", onClick: () => router.push(`/tasks/live?task=${encodeURIComponent(task.id)}`) } });
      else toast({ title: "Reminder scheduled" });
      setPreview(null); setComposer(""); setMentionRange(null);
      requestAnimationFrame(() => { autosize(composerRef.current); composerRef.current?.focus(); });
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function more() {
    if (!selectedId || !cursor) return;
    const channelId = selectedId;
    setBusy(true);
    try {
      const page = await listLiveChannelMessages(channelId, cursor);
      if (activeConversationId.current !== channelId) return;
      // Older history is prepended; keep the reader's place instead of jumping to the newest message.
      if (page.items.length) scroll.preserveForPrepend();
      setMessages((items) => { const loaded = new Set(items.map((item) => item.id)); return [...page.items.filter((item) => !loaded.has(item.id)), ...items]; });
      setCursor(page.nextCursor); setError("");
    }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function react(item: Message, emoji: string) {
    if (!canPost) return;
    const active = !(item.myReactions ?? []).includes(emoji);
    setMessages((items) => items.map((message) => message.id === item.id ? toggledReaction(message, emoji) : message));
    try {
      const updated = await updateLiveMessageReaction(item.id, emoji, active);
      setMessages((items) => items.map((message) => message.id === updated.id ? updated : message));
    } catch (cause) {
      setMessages((items) => items.map((message) => message.id === item.id ? item : message));
      toast({ tone: "error", title: "Reaction not saved", body: errorText(cause) });
    }
  }

  async function updateMessage(item: Message, kind: "save" | "pin") {
    setError("");
    try {
      const updated = kind === "save" ? await updateLiveMessageSave(item.id, !item.savedByMe) : await updateLiveMessagePin(item.id, !item.pinned);
      setMessages((items) => items.map((message) => message.id === updated.id ? updated : message));
      const undo = { label: "Undo", onClick: () => void updateMessage(updated, kind) };
      toast(kind === "save" ? { title: updated.savedByMe ? "Message saved" : "Removed from saved", action: undo } : { title: updated.pinned ? "Message pinned" : "Message unpinned", action: undo });
    } catch (cause) { setError(errorText(cause)); }
  }

  function jumpTo(messageId: string) {
    if (!jumpToMessage(listRef.current, messageId)) toast({ tone: "info", title: "That message is further back", body: "Load older messages to see it." });
  }

  function openCreate(kind: CreateKind, parent = "") {
    if (kind !== "venture" && !parent) return;
    createReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    createExit.cancel();
    setCreateKind(kind); setCreateName(""); setCreateGoal(""); setCreateParent(kind === "venture" ? "" : parent); setError("");
  }

  const createExit = useExitTransition(() => { setCreateKind(null); setError(""); }, 130);
  const closeCreateRef = useRef(() => {});
  useEffect(() => { closeCreateRef.current = closeCreate; });
  function closeCreate() {
    createExit.close();
    requestAnimationFrame(() => (createReturnRef.current?.isConnected ? createReturnRef.current : listButtonRef.current)?.focus());
  }

  async function createSpace(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !createKind || !canCreate) return;
    if (!createParentValid) { setError("This parent space is no longer available. Close this dialog and reopen it from the current space."); return; }
    setBusy(true); setError(""); setResult("");
    try {
      let nextVenture = selectedVentureId;
      let nextGroup = selectedGroupId;
      let nextChannel = selectedId;
      let notice = "";
      if (createKind === "venture") {
        const created = await createLiveVenture({ name: createName.trim(), ownerId: session.user.id, goal30Day: createGoal.trim() });
        nextVenture = created.id; nextGroup = ""; nextChannel = "";
        notice = `${created.name} created. Add a group to start its conversations.`;
      } else if (createKind === "group") {
        const created = await createLiveGroup({ ventureId: createParent, name: createName.trim() });
        nextVenture = createParent; nextGroup = created.id;
        nextChannel = created.channels[0]?.id ?? "";
        notice = `${created.name} created with a #general channel.`;
      } else {
        const created = await createLiveChannel({ groupId: createParent, name: createName.trim() });
        const parent = session.hierarchy.ventures.find((item) => item.groups.some((entry) => entry.id === createParent));
        nextVenture = parent?.id ?? selectedVentureId; nextGroup = createParent;
        nextChannel = created.id;
        notice = `#${created.name} created.`;
      }
      setSession(await loadLiveSession());
      if (createKind === "venture" && activeVentureId) setPendingScope({ ventureId: nextVenture, from: activeVentureId });
      setSelectedVentureId(nextVenture); setSelectedGroupId(nextGroup); setRailExpanded(false); resetConversation(nextChannel); writeScope(nextVenture, nextGroup, nextChannel);
      closeCreate(); setResult(notice);
      window.dispatchEvent(new Event("venture:hierarchy-changed"));
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  const memberName = (id: string) => id === session?.user.id ? session.user.name : members.find((item) => item.id === id)?.name ?? directory[id] ?? "Former member";
  const createVentureParent = session?.hierarchy.ventures.find((item) => item.id === createParent || item.groups.some((entry) => entry.id === createParent));
  const createGroupParent = createVentureParent?.groups.find((item) => item.id === createParent);
  const createParentValid = createKind === "venture" || createKind === null || (createKind === "group" ? createVentureParent?.id === createParent : Boolean(createGroupParent));
  const createScopeLabel = createKind === "group" ? createVentureParent?.name : createKind === "channel" ? `${createGroupParent?.name ?? "Unknown group"} · ${createVentureParent?.name ?? "Unknown venture"}` : "";
  const lead = session?.membership.role === "admin" || session?.membership.role === "venture_head";
  const noAccess = lacksGroupAccess(session, canCreate);
  /** Nothing is selected yet: explain why (no access, nothing created, or pick one) rather than telling people to choose what they cannot. */
  function scopeEmpty() {
    if (noAccess) return <ChatEmpty icon={UserLock} tone="blue" title="You're not in a group yet" detail="Ask a workspace admin to add you to a group to see its channels." />;
    if (!venture) return canCreate && !session?.hierarchy.ventures.length
      ? <ChatEmpty icon={Layers3} title="No ventures yet" detail="Create a venture, then add a group to start conversations." action={{ label: "Create venture", icon: Plus, onClick: () => openCreate("venture") }} />
      : <ChatEmpty title="Choose a venture" detail="Open the channel list to choose a conversation." />;
    if (!group) return venture.groups.length === 0
      ? canCreate
        ? <ChatEmpty icon={Layers3} title="No groups in this venture yet" detail={`Create a group to start conversations in ${venture.name}.`} action={{ label: "Create group", icon: Plus, onClick: () => openCreate("group", venture.id) }} />
        : <ChatEmpty icon={UserLock} tone="blue" title="No groups in this venture yet" detail={`Ask a workspace admin to add you to a group in ${venture.name}.`} />
      : <ChatEmpty title="Choose a group" detail="Open the channel list to choose a conversation." />;
    return <ChatEmpty icon={Hash} title="No channels in this group yet" detail={canCreate ? "Create a channel to start a conversation." : "Ask a workspace admin to add a channel."} action={canCreate ? { label: "Create channel", icon: Plus, onClick: () => openCreate("channel", group.id) } : undefined} />;
  }
  function startReply(item: Message) {
    const root = item.threadRootId ? messages.find((message) => message.id === item.threadRootId) : undefined;
    setReplyTo(item.threadRootId ? root ?? item : item); setPreview(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  async function copyText(body: string) {
    try { await navigator.clipboard.writeText(body); toast({ title: "Copied to clipboard" }); }
    catch { toast({ tone: "error", title: "Could not copy", body: "Your browser blocked clipboard access." }); }
  }
  const bubbleClass = (mine: boolean, mentionsMe: boolean) => clsx("inline-block max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-2.5 text-left text-[12px] leading-[1.65]", mine ? "rounded-br-[5px] bg-[var(--color-primary-600)] text-white" : mentionsMe ? "rounded-bl-[5px] border border-[var(--color-primary-300)] bg-[var(--color-primary-50)] text-[var(--color-neutral-800)]" : "rounded-bl-[5px] border border-[var(--color-neutral-100)] bg-white text-[var(--color-neutral-700)]");
  /** One flat list so a sent message keeps its row (same key) when the server confirms it. */
  function renderRows() {
    const rows: React.ReactNode[] = [];
    messages.forEach((item, index) => {
      const previous = messages[index - 1];
      if (startsNewDay(previous, item)) rows.push(<DaySeparator key={`day-${item.id}`} iso={item.createdAt} />);
      const grouped = continuesGroup(previous, item);
      // The avatar sits beside the last message of a run, as in iMessage; the name and time stay on the first.
      const next = messages[index + 1];
      const endsGroup = !next || !continuesGroup(item, next);
      const mine = item.authorId === session?.user.id;
      const mentionsMe = !mine && !!session && item.mentionUserIds.includes(session.user.id);
      const threadRoot = item.threadRootId ? messages.find((message) => message.id === item.threadRootId) : undefined;
      const replyCount = item.threadRootId ? 0 : messages.filter((message) => message.threadRootId === item.id).length;
      const actions = [
        ...(canPost ? [{ label: "Reply", onSelect: () => startReply(item) }] : []),
        ...(item.body ? [{ label: "Copy text", onSelect: () => void copyText(withMentionNames(item.body, mentionNames)) }] : []),
        { label: item.savedByMe ? "Remove from saved" : "Save message", onSelect: () => void updateMessage(item, "save") },
        ...(lead ? [{ label: item.pinned ? "Unpin message" : "Pin message", onSelect: () => void updateMessage(item, "pin") }] : []),
        ...(canPost ? [{ label: (item.myReactions ?? []).includes("👍") ? "Remove 👍" : "React 👍", onSelect: () => void react(item, "👍") }] : []),
      ];
      rows.push(<article key={localKeys[item.id] ?? item.id} data-message-id={item.id} className={clsx("group/msg flex items-end gap-2 rounded-2xl", grouped ? "mt-1" : "mt-5", arrived.has(item.id) && !localKeys[item.id] && "chat-message-arrive", mine && "flex-row-reverse")}>
        <span className="w-[25px] shrink-0">{endsGroup && <ChatAvatar id={item.authorId} name={memberName(item.authorId)} size={25} />}</span>
        <div className={clsx("relative max-w-[min(78%,620px)]", mine && "text-right")}>
          {canPost && <QuickReactionBar mine={mine} onReact={(emoji) => void react(item, emoji)} onReply={() => startReply(item)} />}
          {!grouped && <div className={clsx("mb-1 flex items-center gap-2 text-[10px]", mine && "flex-row-reverse")}><span className="font-semibold">{mine ? "You" : memberName(item.authorId)}</span>{item.via === "claude" && <ViaClaude />}<time dateTime={item.createdAt} title={stamp(item.createdAt)} className="text-[var(--color-neutral-400)]">{timeLabel(item.createdAt)}</time>{item.pinned && <span className="vso-fade-enter inline-flex items-center gap-0.5 text-[var(--color-primary-600)]"><Pin size={11} aria-hidden="true" />Pinned</span>}{item.savedByMe && <span className="vso-fade-enter inline-flex items-center gap-0.5 text-[var(--color-neutral-500)]"><Bookmark size={11} aria-hidden="true" />Saved</span>}{replyCount > 0 && <span className="text-[var(--color-neutral-500)]">{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>}</div>}
          {item.threadRootId && <button type="button" onClick={() => jumpTo(item.threadRootId!)} title="Show the original message" className={clsx("mb-1 block max-w-full truncate border-l-2 border-[var(--color-primary-300)] px-2 text-left text-[10px] text-[var(--color-neutral-500)] transition-colors duration-150 hover:text-[var(--color-primary-700)]", mine && "ml-auto border-l-0 border-r-2 text-right")}>↳ Reply to {threadRoot ? `${threadRoot.authorId === session?.user.id ? "you" : memberName(threadRoot.authorId)}: ${withMentionNames(threadRoot.body, mentionNames).slice(0, 80) || "an attachment"}` : "an earlier message"}</button>}
          <ChatMessageMenu actions={actions} label={`Actions for message from ${mine ? "you" : memberName(item.authorId)}`}>
            {item.body && <MessageText body={item.body} mine={mine} names={mentionNames} className={bubbleClass(mine, mentionsMe)} />}
            <MessageAttachmentList files={messageAttachments(item)} mine={mine} />
          </ChatMessageMenu>
          <ReactionChips message={item} mine={mine} disabled={!canPost} onToggle={(emoji) => void react(item, emoji)} />
        </div>
      </article>);
    });
    channelPending.forEach((entry, index) => {
      if (index === 0 && startsNewDay(messages.at(-1), entry)) rows.push(<DaySeparator key={`day-${entry.clientId}`} iso={entry.createdAt} />);
      rows.push(<article key={entry.clientId} className="vso-send-rise group/msg mt-5 flex flex-row-reverse items-start gap-2 rounded-2xl">
        <span className="mt-5 shrink-0"><ChatAvatar id={session?.user.id ?? ""} name={session?.user.name ?? "You"} size={25} /></span>
        <div className="relative max-w-[min(78%,620px)] text-right">
          <div className="mb-1 flex flex-row-reverse items-center gap-2 text-[10px]"><span className="font-semibold">You</span><time className="text-[var(--color-neutral-400)]">{timeLabel(entry.createdAt)}</time></div>
          {entry.body && <MessageText body={entry.body} mine names={mentionNames} className={clsx(bubbleClass(true, false), "transition-opacity duration-200", entry.state === "sending" ? "opacity-60" : "opacity-90 outline outline-2 outline-offset-2 outline-[var(--color-danger)]")} />}
          {entry.attachments?.length ? <div className={clsx("transition-opacity duration-200", entry.state === "sending" && "opacity-70")}><MessageAttachmentList files={entry.attachments} mine /></div> : entry.attachmentFileIds.length > 0 && <p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{entry.attachmentFileIds.length} attachment{entry.attachmentFileIds.length === 1 ? "" : "s"}</p>}
          <PendingStatus pending={entry} onRetry={() => submit(entry)} onEdit={() => editPending(entry)} onDiscard={() => setPending((items) => items.filter((item) => item.clientId !== entry.clientId))} />
        </div>
      </article>);
    });
    return rows;
  }

  const details = <aside aria-label="Group details" aria-hidden={!detailsOpen} inert={!detailsOpen} data-open={detailsOpen} className="vso-group-details bg-white shadow-2xl lg:shadow-none">
    <div className="chat-details thin-scroll h-full overflow-y-auto p-5">
    <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold">Group Details</p><button type="button" aria-label="Close details" onClick={() => { setDetailsOpen(false); detailsButtonRef.current?.focus(); }} className="chat-icon"><X size={17} /></button></div>
    {group ? <>
      <div className="mt-7 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--color-primary-100)] text-[var(--color-primary-600)]"><Hash size={22} /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{group.name}</h2><p className="mt-1 truncate text-[11px] text-[var(--color-neutral-400)]">{venture?.name}{selected ? ` · #${selected.name}` : ""}</p></div></div>
      <GroupPeople key={group.id} ventureId={venture?.id ?? ""} ventureName={venture?.name ?? ""} groupId={group.id} groupName={group.name} members={members} loading={membersLoading} error={membersError} canManage={canCreate} onOpen={() => setWorkspaceTab(null)} onRefresh={() => setMemberRevision((value) => value + 1)} />
      <div className="mt-7 border-t border-[var(--color-neutral-100)] pt-5"><p className="text-xs font-semibold">Pinned messages</p>{messages.filter((item) => item.pinned).slice(0, 3).map((item) => <button type="button" key={item.id} onClick={() => jumpTo(item.id)} className="mt-2 line-clamp-3 w-full rounded-lg bg-[var(--color-neutral-50)] p-3 text-left text-[11px] leading-5 text-[var(--color-neutral-600)] transition-colors duration-150 hover:bg-[var(--color-primary-50)]">{withMentionNames(item.body, mentionNames)}</button>)}{!messages.some((item) => item.pinned) && <EmptyState variant="compact" icon={Pin} title="No pinned messages yet" body={lead ? "Pin one from a message's menu." : "Pinned messages appear here."} className="mt-2" />}</div>
      <div className="mt-7 space-y-2"><button type="button" onClick={() => openWorkspace("kanban")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[var(--color-primary-100)] px-3 text-left text-xs font-semibold text-[var(--color-primary-700)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-200)] active:scale-[0.98]"><Columns3 size={16} />Kanban</button><button type="button" onClick={() => openWorkspace("attachments")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[var(--color-neutral-100)] px-3 text-left text-xs font-semibold text-[var(--color-neutral-700)]"><FolderOpen size={16} />Attachments</button><button type="button" onClick={() => openWorkspace("saved")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[var(--color-neutral-100)] px-3 text-left text-xs font-semibold text-[var(--color-neutral-700)]"><Bookmark size={16} />Saved messages</button><button type="button" onClick={() => openWorkspace("knowledge")} className="flex min-h-10 w-full items-center gap-2 rounded-lg bg-[var(--color-neutral-100)] px-3 text-left text-xs font-semibold text-[var(--color-neutral-700)]"><BookOpenText size={16} />Knowledge</button></div>
    </> : <EmptyState variant="compact" icon={noAccess ? UserLock : Layers3} title={noAccess ? "You're not in a group yet" : "No group selected"} body={noAccess ? "Ask a workspace admin to add you." : "Choose a group to see its details."} className="mt-6" />}
    </div>
  </aside>;

  return <ChatShell ready={Boolean(error) || (Boolean(session) && !messagesLoading)}>
    {listOpen && <button type="button" aria-label="Close channel list" onClick={closeList} className="vso-backdrop fixed inset-0 z-10 bg-[var(--color-neutral-900)]/25 md:!hidden" />}
    <ChannelNavigator session={session} selectedVentureId={selectedVentureId} selectedGroupId={selectedGroupId} selectedChannelId={selectedId} railExpanded={railExpanded} listOpen={listOpen} realtime={realtime} canCreate={canCreate} onVentureSelect={changeVenture} onGroupSelect={changeGroup} onChannelSelect={changeChannel} onToggleRail={() => setRailExpanded((value) => !value)} onCreate={openCreate} />
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
    <section className="relative flex min-w-0 flex-1 flex-col bg-white"
      onDragEnter={(event) => { if (!selected || !canPost || !event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current += 1; setDropActive(true); }}
      onDragOver={(event) => { if (!dropActive) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={() => { if (!dropActive) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropActive(false); }}
      onDrop={(event) => { if (!dropActive) return; event.preventDefault(); dragDepth.current = 0; setDropActive(false); void attachments.addFiles(event.dataTransfer.files); composerRef.current?.focus(); }}>
      <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-[var(--color-neutral-200)] px-4 sm:px-6">
        <button ref={listButtonRef} type="button" aria-label="Open channel list" aria-expanded={listOpen} onClick={() => setListOpen(true)} className="chat-icon md:!hidden"><Menu size={18} /></button>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-100)] text-[var(--color-primary-600)]"><Hash size={17} /></span>
        <div className="min-w-0 flex-1"><h2 className="truncate text-[12px] font-semibold">{selected ? `# ${selected.name}` : "Choose a channel"}</h2><p className="truncate text-[10px] text-[var(--color-neutral-400)]">{venture?.name}{group ? ` · ${group.name}` : ""}</p></div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button ref={searchButtonRef} type="button" aria-label="Search group messages and files" title="Search messages and files" disabled={!group} onClick={() => setSearchOpen(true)} className="chat-icon disabled:opacity-40"><Search size={17} /></button>
          {selected && <ChannelNotifyMenu channelId={selected.id} channelName={selected.name} />}
          <ThemeToggle />
          <button ref={detailsButtonRef} type="button" aria-label={detailsOpen ? "Hide group details" : "Show group details"} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)} className={clsx("chat-icon", detailsOpen && "chat-icon-active")}><Info size={17} /></button>
          <button type="button" aria-label="Refresh messages" title="Refresh messages" aria-busy={reloading || undefined} onClick={() => setRevision((value) => value + 1)} className="chat-icon"><RefreshCw size={16} className={clsx(reloading && "vso-spin")} /></button>
        </div>
      </header>
      <Notice tone="error" message={createKind || !session ? "" : error} onDismiss={() => setError("")} className="px-5 pt-3" /><Notice tone="success" message={result} onDismiss={() => setResult("")} autoDismissMs={5000} className="px-5 pt-3" />
      <div ref={listRef} onScroll={scroll.onScroll} aria-busy={reloading || undefined} className="thin-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pt-6 pb-40 sm:px-7">{!session ? error ? <EmptyState variant="error" title="Could not load your channels" body={error} action={{ label: "Try again", onClick: () => window.location.reload() }} className="h-full" /> : <MessagesSkeleton /> : selected ? messagesLoading ? <MessagesSkeleton /> : messagesError ? <EmptyState variant="error" title="Messages unavailable" body={messagesError} action={{ label: "Try again", onClick: () => setRevision((value) => value + 1) }} className="h-full" /> : messages.length || channelPending.length ? <div className="vso-fade-enter">{cursor && <button type="button" disabled={busy} onClick={more} className="mx-auto mb-2 flex min-h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-semibold text-[var(--color-primary-700)] transition-colors duration-150 hover:bg-[var(--color-primary-50)] disabled:opacity-60">{busy ? <><RefreshCw size={12} className="vso-spin" />Loading…</> : "Load older messages"}</button>}{renderRows()}</div> : <ChatEmpty icon={Hash} title={canPost ? `Start the conversation in #${selected.name}` : `Nothing in #${selected.name} yet`} detail={!canPost ? "Messages posted here will appear for you to read." : canCommand ? "Post an update, share a file, or type /assign to give someone a task." : "Post an update or share a file to get things going."} /> : scopeEmpty()}</div>
      <NewMessagesPill count={scroll.unseen} onClick={scroll.jumpToLatest} className="bottom-24" />
      {dropActive && <div aria-hidden="true" className="vso-backdrop pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-[var(--color-primary-400)] bg-[var(--color-primary-50)]/90"><p className="vso-enter-modal text-sm font-semibold text-[var(--color-primary-800)]">Drop files to attach them</p></div>}
      {selected && <form onSubmit={send} className="absolute inset-x-4 bottom-4 z-10 sm:inset-x-6">
        {preview && <section aria-label="Review command" data-side="top" data-align="left" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPreview(null); composerRef.current?.focus(); } }} className="vso-enter-popover mb-2 rounded-xl border border-[var(--color-primary-200)] bg-[var(--color-primary-50)] px-4 py-3 shadow-e3"><p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-primary-700)]">Review command</p><p className="mt-1 text-xs font-semibold">{preview.command.kind === "assign" ? `Assign “${preview.command.title}” to @${preview.command.assignee}` : `Notify @${preview.command.recipient}: “${preview.command.message}”`}</p><p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{preview.command.kind === "assign" ? `Due ${stamp(preview.command.dueAt)} · ${preview.command.estimatedMinutes} min` : `At ${stamp(preview.command.scheduledAt)}`}</p>{preview.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-amber-700">{warning}</p>)}<div className="mt-2 flex gap-2"><button type="button" autoFocus disabled={busy} onClick={execute} className="min-h-8 rounded-lg bg-[var(--color-primary-600)] px-3 text-[11px] font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-700)] active:scale-[0.97] disabled:opacity-60">{busy ? "Working…" : "Confirm command"}</button><button type="button" onClick={() => { setPreview(null); composerRef.current?.focus(); }} className="min-h-8 rounded-lg px-3 text-[11px] font-semibold text-[var(--color-neutral-500)] transition-colors duration-150 hover:bg-white/70">Cancel</button></div></section>}
        <div data-open={Boolean(replyTo)} className="vso-collapse"><div><div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-[var(--color-primary-50)] px-3 py-2 text-[11px] text-[var(--color-primary-800)]"><span className="min-w-0 truncate"><span className="font-semibold">Replying to {replyShown ? replyShown.authorId === session?.user.id ? "yourself" : memberName(replyShown.authorId) : ""}</span>{replyShown ? `: ${withMentionNames(replyShown.body, mentionNames).slice(0, 80) || "an attachment"}` : ""}</span><button type="button" tabIndex={replyTo ? 0 : -1} aria-label="Cancel reply" title="Cancel reply (Esc)" onClick={() => { setReplyTo(null); composerRef.current?.focus(); }} className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors duration-150 hover:bg-[var(--color-primary-100)]"><X size={13} /></button></div></div></div>
        <AttachmentTray attachments={attachments} />
        <div className="relative">
          {slashMatches.length > 0 && !preview && <div id="channel-slash-options" role="listbox" aria-label="Commands" className="absolute bottom-full left-0 z-20 mb-2 w-[min(360px,100%)] rounded-xl border border-[var(--color-neutral-200)] bg-white p-1.5 shadow-e3">{slashMatches.map((item, index) => <button id={`slash-option-${index}`} key={item.command} type="button" role="option" aria-selected={index === slashIndex % slashMatches.length} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSlash(item.command)} className={clsx("flex w-full flex-col rounded-lg px-3 py-2 text-left text-[11px]", index === slashIndex % slashMatches.length ? "bg-[var(--color-primary-100)] text-[var(--color-primary-800)]" : "text-[var(--color-neutral-700)] hover:bg-[var(--color-neutral-100)]")}><span className="font-semibold">{item.command} <span className="font-normal text-[var(--color-neutral-400)]">{item.hint}</span></span><span className="text-[10px] text-[var(--color-neutral-500)]">{item.detail}</span></button>)}</div>}
          {mentionRange && <div id="channel-mention-options" role="listbox" aria-label="Mention a group member" className="absolute bottom-full left-0 z-20 mb-2 w-[min(320px,100%)] rounded-xl border border-[var(--color-neutral-200)] bg-white p-1.5 shadow-e3">
            {mentionSuggestions.length ? mentionSuggestions.map((member, index) => <button id={`mention-option-${index}`} key={member.id} type="button" role="option" aria-selected={index === mentionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(member)} className={clsx("flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px]", index === mentionIndex ? "bg-[var(--color-primary-100)] text-[var(--color-primary-700)]" : "text-[var(--color-neutral-700)] hover:bg-[var(--color-neutral-100)]")}><ChatAvatar id={member.id} name={member.name} size={25} /><span className="min-w-0"><span className="block truncate font-semibold">{member.name}</span><span className="block truncate text-[10px] text-[var(--color-neutral-400)]">@{member.handle}</span></span></button>) : membersLoading || membersError ? <p className="px-3 py-3 text-[11px] text-[var(--color-neutral-400)]">{membersLoading ? "Loading group members…" : membersError}</p> : <EmptyState variant="compact" icon={Users} title="No matching group members" />}
          </div>}
          <div className="flex items-end gap-2 rounded-xl border border-[var(--color-neutral-200)] bg-white px-3 py-2 shadow-e2 transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--color-primary-400)] focus-within:ring-2 focus-within:ring-[var(--color-primary-100)]">
            <AttachmentMenu attachments={attachments} disabled={busy || !canPost} />
            <label htmlFor="channel-composer" className="sr-only">Message or slash command</label>
            <textarea ref={composerRef} id="channel-composer" maxLength={10000} rows={1} value={composer} onChange={(event) => { setComposer(event.target.value); autosize(event.currentTarget); trackMention(event.target.value, event.target.selectionStart); setPreview(null); setSlashIndex(0); clientId.current = null; }} onSelect={(event) => trackMention(event.currentTarget.value, event.currentTarget.selectionStart)} onPaste={(event) => { if (event.clipboardData.files.length && canPost) { event.preventDefault(); void attachments.addFiles(event.clipboardData.files); } }} onKeyDown={(event) => {
              if (isComposing(event)) return;
              if (mentionRange && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMentionRange(null); return; }
              if (event.key === "Escape" && (preview || replyTo)) { event.preventDefault(); event.stopPropagation(); if (preview) setPreview(null); else setReplyTo(null); return; }
              if (slashMatches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSlashIndex((index) => index + (event.key === "ArrowDown" ? 1 : slashMatches.length - 1)); return; }
              if (slashMatches.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { event.preventDefault(); chooseSlash(slashMatches[slashIndex % slashMatches.length]!.command); return; }
              if (mentionSuggestions.length && event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((index) => (index + 1) % mentionSuggestions.length); return; }
              if (mentionSuggestions.length && event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((index) => (index + mentionSuggestions.length - 1) % mentionSuggestions.length); return; }
              if (mentionSuggestions.length && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); chooseMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]!); return; }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
            }} aria-controls={mentionRange ? "channel-mention-options" : slashMatches.length ? "channel-slash-options" : undefined} aria-activedescendant={mentionSuggestions.length ? `mention-option-${mentionIndex}` : slashMatches.length ? `slash-option-${slashIndex % slashMatches.length}` : undefined} className="min-h-8 max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-[var(--color-neutral-400)]" disabled={!canPost} placeholder={!canPost ? "Learners can read this channel but cannot post." : canCommand ? "Type a message, /assign or /notify..." : "Type a message..."} />
            <button type="submit" disabled={!canPost || busy || attachments.uploading || (!composer.trim() && !attachments.items.length)} aria-label={composer.trim().startsWith("/") ? "Preview command" : "Send message"} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-600)] text-white transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--color-primary-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-300)] active:scale-[0.92] disabled:opacity-40 disabled:active:scale-100"><ChatSendIcon /></button>
          </div>
        </div>
      </form>}
    </section>
    {detailsOpen && <button type="button" aria-label="Close group details" onClick={() => { setDetailsOpen(false); detailsButtonRef.current?.focus(); }} className="vso-backdrop fixed inset-0 z-[19] bg-[var(--color-neutral-900)]/20 lg:hidden" />}
    {details}
    {searchOpen && group && <ChannelSearchDialog key={group.id} groupId={group.id} groupName={group.name} channels={group.channels} onClose={closeSearch} onOpenChannel={changeChannel} />}
    {workspaceTab && <div ref={workspaceRef} data-state={workspaceExit.state} className="pointer-events-none absolute inset-0 z-30 overflow-hidden"><GroupWorkspaceSheet tab={workspaceTab} onTabChange={setWorkspaceTab} onClose={closeWorkspace} onOpenMessage={openSavedMessage} ventureId={venture?.id ?? ""} ventureName={venture?.name ?? ""} group={group} userId={session?.user.id ?? ""} role={session?.membership.role ?? ""} onSavedChange={(changed) => setMessages((items) => items.map((item) => item.id === changed.id ? changed : item))} /></div>}
    </div>
    {createKind && <div data-state={createExit.state} className="vso-backdrop fixed inset-0 z-30 grid place-items-center bg-[#272736]/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}><section ref={createDialogRef} role="dialog" aria-modal="true" aria-label={`Create ${createKind}`} className="vso-enter-modal w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center justify-between"><h2 className="text-base font-bold">Create {createKind}</h2><button type="button" aria-label="Close" onClick={closeCreate} className="chat-icon"><X size={18} /></button></div><p className="mt-2 text-xs leading-5 text-[var(--color-neutral-400)]">{createKind === "venture" ? "Add a venture to this workspace." : createKind === "group" ? "Add a group to this venture. A #general channel is created automatically." : "Add a channel to this group."}</p><form onSubmit={createSpace} className="mt-5 space-y-4">{createKind !== "venture" && <div aria-label="Creation scope" className="rounded-lg bg-[var(--color-neutral-100)] px-3 py-2.5"><p className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--color-neutral-400)]">{createKind === "group" ? "Venture" : "Group · Venture"}</p><p className="mt-1 text-xs font-semibold text-[var(--color-neutral-700)]">In {createScopeLabel}</p></div>}<label className="block text-xs font-semibold">Name<input required maxLength={createKind === "channel" ? 80 : 120} value={createName} onChange={(event) => setCreateName(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-[var(--color-neutral-200)] px-3 text-xs outline-none focus:border-[var(--color-primary-400)]" placeholder={createKind === "channel" ? "product-updates" : createKind === "group" ? "Product team" : "New venture"} /></label>{createKind === "venture" && <label className="block text-xs font-semibold">30-day goal <span className="font-normal text-[var(--color-neutral-400)]">(optional)</span><textarea maxLength={500} value={createGoal} onChange={(event) => setCreateGoal(event.target.value)} className="mt-1.5 min-h-20 w-full rounded-lg border border-[var(--color-neutral-200)] p-3 text-xs outline-none focus:border-[var(--color-primary-400)]" placeholder="What will this venture achieve next?" /></label>}{!createParentValid && <p role="alert" className="text-xs text-red-700">This parent space is unavailable. Reopen creation from the current space.</p>}<Notice tone="error" message={error} onDismiss={() => setError("")} /><div className="flex justify-end gap-2 pt-2"><button type="button" onClick={closeCreate} className="min-h-10 rounded-lg px-4 text-xs font-semibold text-[var(--color-neutral-500)] transition-colors duration-150 hover:bg-[var(--color-neutral-100)]">Cancel</button><button type="submit" disabled={busy || !createName.trim() || !createParentValid} className="min-h-10 rounded-lg bg-[var(--color-primary-600)] px-4 text-xs font-semibold text-white transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--color-primary-700)] active:scale-[0.97] disabled:opacity-50">{busy ? "Creating…" : `Create ${createKind}`}</button></div></form></section></div>}
  </ChatShell>;
}
