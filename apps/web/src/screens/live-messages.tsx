"use client";
import { notificationRefreshEvent } from "@/lib/notification-events";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bookmark, Info, MessageCircle, RefreshCw, Users, X } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import clsx from "clsx";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { Message } from "@venture-studio/contracts";
import { listLiveDirectMessages, listLiveMembers, loadLiveSession, sendLiveDirectMessage, updateLiveMessageReaction, updateLiveMessageSave } from "@/lib/studio-api";
import { ChatMessageMenu } from "@/components/studio/chat-message-menu";
import { useMentionNames, withMentionNames } from "@/lib/mention-names";
import { autosize, continuesGroup, DaySeparator, ViaClaude, isComposing, jumpToMessage, MessageText, NewMessagesPill, PendingStatus, QuickReactionBar, ReactionChips, startsNewDay, timeLabel, toggledReaction, useChatScroll, type PendingMessage } from "@/components/studio/chat-thread";
import { Notice } from "@/components/studio/primitives";
import { toast } from "@/components/ui/toast";
import { ChatAvatar, ChatCredit, ChatEmpty, ChatNav, ChatSearch, ChatShell } from "@/components/studio/chat-ui";
import { useLiveRealtime } from "@/lib/use-live-realtime";
import { AttachmentPicker, MessageAttachmentList, messageAttachments, useChatAttachments } from "@/components/studio/chat-attachments";
import { ChatSendIcon, playChatSound, prepareChatAudio, useChatMessageArrival } from "@/components/studio/chat-message-effects";
import { useActiveChatPresence } from "@/lib/chat-presence";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type Member = Awaited<ReturnType<typeof listLiveMembers>>["items"][number];
const errorText = (value: unknown) => describeError(value, "Something went wrong.");

export function LiveMessagesScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const mentionNames = useMentionNames();
  const [cursor, setCursor] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  // People search accepts "@handle" as well as names.
  const term = search.trim().replace(/^@+/, "");
  // Learners can read but not send direct messages (the API refuses message:write).
  const canPost = !!session && session.membership.role !== "learner";
  const [recipientId, setRecipientId] = useState("");
  const [selectedRecipient, setSelectedRecipient] = useState<Member | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  // A failed conversation load shows as an error in the thread, never as "No messages yet".
  const [messagesError, setMessagesError] = useState("");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [composer, setComposer] = useState("");
  const [error, setError] = useState("");
  // The people list's own failure; a later successful conversation load must not hide it behind a skeleton.
  const [peopleError, setPeopleError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [localKeys, setLocalKeys] = useState<Record<string, string>>({});
  const [reloading, setReloading] = useState(false);
  const [replyShown, setReplyShown] = useState<Message | null>(null);
  if (replyTo && replyTo !== replyShown) setReplyShown(replyTo);
  const clientId = useRef<string | null>(null);
  const activeConversationId = useRef(recipientId);
  // Notification links open a conversation with ?with=<userId>; read once on mount (no Suspense boundary needed).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("with");
    if (wanted && /^[A-Za-z0-9_-]{1,128}$/.test(wanted)) queueMicrotask(() => setRecipientId(wanted));
  }, []);
  const realtime = useLiveRealtime(() => setRevision((value) => value + 1));
  const recipient = members.find((item) => item.id === recipientId) ?? (selectedRecipient?.id === recipientId ? selectedRecipient : undefined);
  const attachments = useChatAttachments(recipientId, recipientId ? { recipientId } : null);
  useActiveChatPresence("direct", recipientId);
  useEffect(() => { if (recipientId) window.dispatchEvent(new Event(notificationRefreshEvent)); }, [recipientId]);
  const arrived = useChatMessageArrival(recipientId, messages, session?.user.id, messagesLoaded);
  useEffect(() => { activeConversationId.current = recipientId; }, [recipientId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => Promise.all([loadLiveSession(), listLiveMembers({ limit: 100 })]).then(([identity, page]) => {
      if (!active) return;
      setSession(identity);
      setMembers(page.items.filter((item) => item.id !== identity.user.id));
      setCursor(page.nextCursor);
      setError(""); setPeopleError("");
    }).catch((cause: unknown) => { if (active) { setError(errorText(cause)); setPeopleError(errorText(cause)); } }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session || (term.length > 0 && term.length < 2)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      listLiveMembers({ ...(term ? { q: term } : {}), limit: 100 }).then((page) => {
        if (active) { setMembers(page.items.filter((item) => item.id !== session.user.id)); setCursor(page.nextCursor); }
      }).catch((cause: unknown) => { if (active) setError(errorText(cause)); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [term, session]);

  useEffect(() => {
    if (!recipientId) return;
    let active = true;
    queueMicrotask(() => { if (active) setReloading(true); });
    queueMicrotask(() => listLiveDirectMessages(recipientId).then((items) => { if (active) { setMessages(items); setMessagesLoaded(true); setError(""); setMessagesError(""); setReloading(false); } }).catch((cause: unknown) => { if (active) { const message = errorText(cause); setError(message); setMessagesError(message); setMessagesLoaded(true); setReloading(false); } }));
    return () => { active = false; };
  }, [recipientId, revision]);

  const conversationPending = pending.filter((item) => item.conversationId === recipientId);
  const scroll = useChatScroll(listRef, messagesLoaded ? recipientId : "", messages.at(-1)?.id ?? "", conversationPending.at(-1)?.clientId ?? "");

  async function moreMembers() {
    if (!cursor) return;
    try {
      const page = await listLiveMembers({ ...(term.length >= 2 ? { q: term } : {}), cursor, limit: 100 });
      setMembers((current) => [...current, ...page.items.filter((item) => item.id !== session?.user.id && !current.some((existing) => existing.id === item.id))]);
      setCursor(page.nextCursor);
    } catch (cause) { setError(errorText(cause)); }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = composer.trim();
    if (!recipientId || (!body && !attachments.items.length) || attachments.uploading) return;
    prepareChatAudio();
    setError("");
    // The message shows at once (faded) and becomes real when the server confirms it.
    submit({ clientId: clientId.current ?? crypto.randomUUID(), conversationId: recipientId, body, attachmentFileIds: attachments.items.map((file) => file.id), attachments: attachments.items, ...(replyTo ? { threadRootId: replyTo.id } : {}), createdAt: new Date().toISOString(), state: "sending" });
    setComposer(""); setReplyTo(null); clientId.current = null; attachments.clear();
    requestAnimationFrame(() => autosize(composerRef.current));
  }

  function submit(entry: PendingMessage) {
    const to = entry.conversationId;
    const handle = (members.find((item) => item.id === to) ?? (selectedRecipient?.id === to ? selectedRecipient : undefined))?.handle?.toLowerCase();
    setPending((items) => [...items.filter((item) => item.clientId !== entry.clientId), { ...entry, state: "sending", error: undefined }]);
    void (async () => {
      try {
        const handles = [...entry.body.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9._-]*)/gi)].map((match) => match[1]!.toLowerCase().replace(/[._-]+$/, ""));
        const created = await sendLiveDirectMessage({ recipientId: to, body: entry.body, attachmentFileIds: entry.attachmentFileIds, mentionUserIds: handle && handles.includes(handle) ? [to] : [], clientId: entry.clientId, ...(entry.threadRootId ? { threadRootId: entry.threadRootId } : {}) });
        playChatSound("sent");
        setLocalKeys((keys) => ({ ...keys, [created.id]: entry.clientId }));
        if (activeConversationId.current === to) setMessages((items) => items.some((item) => item.id === created.id) ? items : [...items, created]);
        setPending((items) => items.filter((item) => item.clientId !== entry.clientId));
      } catch (cause) {
        setPending((items) => items.map((item) => item.clientId === entry.clientId ? { ...item, state: "failed", error: errorText(cause) } : item));
      }
    })();
  }

  function editPending(entry: PendingMessage) {
    if (composer.trim() || attachments.items.length) { toast({ tone: "info", title: "Finish your current draft first", body: "Send or clear what you're writing, then edit the message that failed." }); return; }
    setPending((items) => items.filter((item) => item.clientId !== entry.clientId));
    setComposer(entry.body); clientId.current = entry.clientId;
    if (entry.attachments?.length) attachments.restore(entry.attachments);
    const root = entry.threadRootId ? messages.find((item) => item.id === entry.threadRootId) : undefined;
    if (root) setReplyTo(root);
    requestAnimationFrame(() => { autosize(composerRef.current); composerRef.current?.focus(); });
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

  async function toggleSave(item: Message) {
    try {
      const updated = await updateLiveMessageSave(item.id, !item.savedByMe);
      setMessages((items) => items.map((message) => message.id === updated.id ? updated : message));
      toast({ title: updated.savedByMe ? "Message saved" : "Removed from saved", action: { label: "Undo", onClick: () => void toggleSave(updated) } });
    } catch (cause) { setError(errorText(cause)); }
  }

  async function copyText(body: string) {
    try { await navigator.clipboard.writeText(body); toast({ title: "Copied to clipboard" }); }
    catch { toast({ tone: "error", title: "Could not copy", body: "Your browser blocked clipboard access." }); }
  }

  function startReply(item: Message) {
    const root = item.threadRootId ? messages.find((message) => message.id === item.threadRootId) : undefined;
    setReplyTo(item.threadRootId ? root ?? item : item);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openConversation(member: Member) {
    if (member.id === recipientId) return;
    setRecipientId(member.id); setSelectedRecipient(member); setMessages([]); setMessagesLoaded(false); setMessagesError(""); setComposer(""); setReplyTo(null); clientId.current = null;
    requestAnimationFrame(() => autosize(composerRef.current));
  }

  const bubbleClass = (mine: boolean) => clsx("inline-block max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-2.5 text-left text-[12px] leading-[1.65]", mine ? "rounded-br-[5px] bg-[var(--color-primary-600)] text-white" : "rounded-bl-[5px] border border-[var(--color-neutral-100)] bg-white text-[var(--color-neutral-700)]");
  function renderRows(other: Member) {
    const rows: React.ReactNode[] = [];
    messages.forEach((item, index) => {
      const previous = messages[index - 1];
      if (startsNewDay(previous, item)) rows.push(<DaySeparator key={`day-${item.id}`} iso={item.createdAt} />);
      const grouped = continuesGroup(previous, item);
      // The avatar sits beside the last message of a run, as in iMessage; the name and time stay on the first.
      const next = messages[index + 1];
      const endsGroup = !next || !continuesGroup(item, next);
      const mine = item.authorId === session?.user.id;
      const author = mine ? session?.user.name ?? "You" : other.name;
      const threadRoot = item.threadRootId ? messages.find((message) => message.id === item.threadRootId) : undefined;
      const actions = [
        ...(canPost ? [{ label: "Reply", onSelect: () => startReply(item) }] : []),
        ...(item.body ? [{ label: "Copy text", onSelect: () => void copyText(withMentionNames(item.body, mentionNames)) }] : []),
        { label: item.savedByMe ? "Remove from saved" : "Save message", onSelect: () => void toggleSave(item) },
        ...(canPost ? [{ label: (item.myReactions ?? []).includes("👍") ? "Remove 👍" : "React 👍", onSelect: () => void react(item, "👍") }] : []),
      ];
      rows.push(<article key={localKeys[item.id] ?? item.id} data-message-id={item.id} className={clsx("group/msg flex items-end gap-2 rounded-2xl", grouped ? "mt-1" : "mt-5", arrived.has(item.id) && !localKeys[item.id] && "chat-message-arrive", mine && "flex-row-reverse")}>
        <span className="w-[25px] shrink-0">{endsGroup && <ChatAvatar id={item.authorId} name={author} size={25} />}</span>
        <div className={clsx("relative max-w-[min(75%,560px)]", mine && "text-right")}>
          {canPost && <QuickReactionBar mine={mine} onReact={(emoji) => void react(item, emoji)} onReply={() => startReply(item)} />}
          {!grouped && <div className={clsx("mb-1 flex items-center gap-2 text-[10px]", mine && "flex-row-reverse")}><span className="font-semibold">{mine ? "You" : other.name}</span>{item.via === "claude" && <ViaClaude />}<time dateTime={item.createdAt} className="text-[var(--color-neutral-400)]">{timeLabel(item.createdAt)}</time>{item.savedByMe && <span className="vso-fade-enter inline-flex items-center gap-0.5 text-[var(--color-neutral-500)]"><Bookmark size={11} aria-hidden="true" />Saved</span>}</div>}
          {item.threadRootId && <button type="button" onClick={() => { if (!jumpToMessage(listRef.current, item.threadRootId!)) toast({ tone: "info", title: "That message is further back" }); }} title="Show the original message" className={clsx("mb-1 block max-w-full truncate border-l-2 border-[var(--color-primary-300)] px-2 text-left text-[10px] text-[var(--color-neutral-500)] transition-colors duration-150 hover:text-[var(--color-primary-700)]", mine && "ml-auto border-l-0 border-r-2 text-right")}>↳ Reply to {threadRoot ? `${threadRoot.authorId === session?.user.id ? "you" : other.name}: ${withMentionNames(threadRoot.body, mentionNames).slice(0, 80) || "an attachment"}` : "an earlier message"}</button>}
          <ChatMessageMenu actions={actions} label={`Actions for message from ${mine ? "you" : other.name}`}>
            {item.body && <MessageText body={item.body} mine={mine} names={mentionNames} className={bubbleClass(mine)} />}
            <MessageAttachmentList files={messageAttachments(item)} mine={mine} />
          </ChatMessageMenu>
          <ReactionChips message={item} mine={mine} disabled={!canPost} onToggle={(emoji) => void react(item, emoji)} />
        </div>
      </article>);
    });
    conversationPending.forEach((entry, index) => {
      if (index === 0 && startsNewDay(messages.at(-1), entry)) rows.push(<DaySeparator key={`day-${entry.clientId}`} iso={entry.createdAt} />);
      rows.push(<article key={entry.clientId} className="vso-send-rise group/msg mt-5 flex flex-row-reverse items-start gap-2 rounded-2xl">
        <span className="mt-5 shrink-0"><ChatAvatar id={session?.user.id ?? ""} name={session?.user.name ?? "You"} size={25} /></span>
        <div className="relative max-w-[min(75%,560px)] text-right">
          <div className="mb-1 flex flex-row-reverse items-center gap-2 text-[10px]"><span className="font-semibold">You</span><time className="text-[var(--color-neutral-400)]">{timeLabel(entry.createdAt)}</time></div>
          {entry.body && <MessageText body={entry.body} mine names={mentionNames} className={clsx(bubbleClass(true), "transition-opacity duration-200", entry.state === "sending" ? "opacity-60" : "opacity-90 outline outline-2 outline-offset-2 outline-[var(--color-danger)]")} />}
          {entry.attachments?.length ? <div className={clsx("transition-opacity duration-200", entry.state === "sending" && "opacity-70")}><MessageAttachmentList files={entry.attachments} mine /></div> : entry.attachmentFileIds.length > 0 && <p className="mt-1 text-[10px] text-[var(--color-neutral-400)]">{entry.attachmentFileIds.length} attachment{entry.attachmentFileIds.length === 1 ? "" : "s"}</p>}
          <PendingStatus pending={entry} onRetry={() => submit(entry)} onEdit={() => editPending(entry)} onDiscard={() => setPending((items) => items.filter((item) => item.clientId !== entry.clientId))} />
        </div>
      </article>);
    });
    return rows;
  }

  const peopleLoading = !session && !peopleError;
  const peopleFailed = !session && Boolean(peopleError);
  const messagesFailed = Boolean(messagesError) && !messages.length && !conversationPending.length;
  const visible = term.length >= 2 ? members : members.filter((item) => `${item.name} ${item.handle ?? ""}`.toLowerCase().includes(term.toLowerCase()));
  const detailPanel = <aside className={clsx("chat-details thin-scroll border-l border-[var(--color-neutral-200)] bg-white p-5 xl:w-[290px] xl:shrink-0", detailsOpen ? "fixed inset-y-0 right-0 z-20 w-[min(320px,92vw)] shadow-2xl vso-enter-right xl:animate-none! xl:static xl:shadow-none" : "hidden xl:block")}>
    <div className="flex min-h-full flex-col">
    <div className="flex items-center justify-between"><p className="text-xs font-semibold text-[var(--color-neutral-800)]">Contact Details</p><button type="button" aria-label="Close details" onClick={() => setDetailsOpen(false)} className="chat-icon xl:!hidden"><X size={17} /></button></div>
    {recipient ? <><div className="mt-8 flex flex-col items-center text-center"><ChatAvatar id={recipient.id} name={recipient.name} size={78} /><h2 className="mt-3 text-sm font-semibold">{recipient.name}</h2><p className="mt-1 text-xs text-[var(--color-neutral-400)]">{recipient.handle ? `@${recipient.handle}` : recipient.role.replaceAll("_", " ")}</p></div><div className="mt-8 border-t border-[var(--color-neutral-100)] pt-5"><p className="text-xs font-semibold">Conversation</p><p className="mt-2 text-xs leading-5 text-[var(--color-neutral-400)]">{messages.length} recent messages with this workspace member. Direct messages are visible only to participants.</p></div><div className="mt-7 border-t border-[var(--color-neutral-100)] pt-5"><p className="text-xs font-semibold">Shared media</p><p className="mt-2 text-xs leading-5 text-[var(--color-neutral-400)]">Files in this conversation: {messages.reduce((count, item) => count + messageAttachments(item).length, 0)}.</p></div></> : <EmptyState variant="select" icon={MessageCircle} title="Pick someone to message" body="Their profile, shared groups and files appear here." className="max-md:hidden flex-1" />}
    <div className="mt-auto pt-8"><div className="border-t border-[var(--color-neutral-100)] pt-3 [&_p]:text-[9px]"><ChatCredit /></div></div>
    </div>
  </aside>;

  return <ChatShell ready={Boolean(session) || Boolean(error)}>
    <aside className={clsx("chat-list flex w-full shrink-0 flex-col border-r border-[var(--color-neutral-200)] bg-white md:w-[282px] xl:w-[310px]", recipientId ? "hidden md:flex" : "flex")}>
      <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-[var(--color-neutral-100)] px-5"><ChatNav mode="messages" /><span className="text-[10px] font-semibold text-[var(--color-neutral-400)]">VENTURE STUDIO</span></div>
      <div className="px-5 pb-3 pt-5"><div className="mb-4 flex items-center justify-between"><h1 className="text-[15px] font-bold tracking-tight">Messages <span aria-hidden="true" className="text-[var(--color-neutral-400)]">⌄</span></h1><button type="button" aria-label="Refresh messages" title="Refresh messages" className="chat-icon" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button></div><ChatSearch value={search} onChange={setSearch} placeholder="Search people..." /></div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">{peopleLoading ? <div role="status" aria-label="Loading people" className="grid gap-1 pt-1">{[0, 1, 2, 3, 4].map((index) => <div key={index} className="flex min-h-[68px] items-center gap-3 px-3"><span className="vso-skeleton h-[39px] w-[39px] shrink-0 rounded-full" /><span className="grid min-w-0 flex-1 gap-2"><span className="vso-skeleton h-3" style={{ width: `${70 - (index % 3) * 12}%` }} /><span className="vso-skeleton h-2.5 w-1/3" /></span></div>)}</div> : peopleFailed ? <EmptyState variant="error" title="Could not load people" body={peopleError} action={{ label: "Try again", onClick: () => window.location.reload() }} /> : visible.map((member) => <button type="button" key={member.id} onClick={() => openConversation(member)} aria-current={recipientId === member.id ? "true" : undefined} className={clsx("flex min-h-[68px] w-full items-center gap-3 rounded-lg px-3 text-left transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary-500)] active:scale-[0.99]", recipientId === member.id ? "bg-[var(--color-primary-100)]" : "hover:bg-[var(--color-neutral-50)]")}><ChatAvatar id={member.id} name={member.name} size={39} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold">{member.name}</span><span className="mt-1 block truncate text-[10px] text-[var(--color-neutral-400)]">{member.handle ? `@${member.handle}` : member.role.replaceAll("_", " ")}</span></span></button>)}{!peopleLoading && !peopleFailed && visible.length === 0 && (search.trim() ? <EmptyState variant="filtered" title={`No one matches "${search.trim()}"`} body="Check the spelling, or try a name or @handle." action={{ label: "Clear search", onClick: () => setSearch("") }} /> : <EmptyState variant="card" tone="teal" icon={Users} title="No one to message yet" body="Other workspace members appear here." />)}{cursor && <button type="button" onClick={moreMembers} className="mx-3 mt-2 min-h-9 rounded-lg px-3 text-xs font-semibold text-[var(--color-primary-600)] transition-colors duration-150 hover:bg-[var(--color-primary-50)]">Load more people</button>}</div>
      {session && <div className="flex items-center gap-2 border-t border-[var(--color-neutral-100)] px-5 py-3"><ChatAvatar id={session.user.id} name={session.user.name} size={30} /><span className="truncate text-[11px] font-semibold">{session.user.name}</span><span className="ml-auto inline-flex items-center gap-1.5 text-[9px] text-[var(--color-neutral-400)]"><span aria-hidden="true" className={clsx("h-1.5 w-1.5 rounded-full transition-colors duration-300", realtime === "live" ? "bg-[var(--color-success)]" : realtime === "connecting" ? "animate-pulse bg-[var(--color-warning)]" : "bg-[var(--color-neutral-300)]")} />{realtime === "live" ? "Live" : realtime === "connecting" ? "Connecting…" : "Offline"}</span></div>}
    </aside>
    <section key={recipientId ? "conversation" : "empty"} className={clsx("relative flex min-w-0 flex-1 flex-col bg-white", recipientId ? "vso-enter-right" : "hidden md:flex")}>
      <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-[var(--color-neutral-200)] px-4 sm:px-6"><button type="button" aria-label="Back to people" onClick={() => setRecipientId("")} className="chat-icon md:!hidden"><ArrowLeft size={18} /></button>{recipient ? <><ChatAvatar id={recipient.id} name={recipient.name} size={34} /><div className="min-w-0 flex-1"><h2 className="truncate text-[12px] font-semibold">{recipient.name}</h2><p className="truncate text-[10px] text-[var(--color-neutral-400)]">{recipient.handle ? `@${recipient.handle}` : "Workspace member"}</p></div></> : <h2 className="flex-1 text-sm font-semibold">Select a conversation</h2>}<ThemeToggle /><button type="button" aria-label="Show contact details" title="Contact details" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)} className={clsx("chat-icon", detailsOpen && "chat-icon-active")}><Info size={17} /></button><button type="button" aria-label="Refresh conversation" title="Refresh" aria-busy={reloading || undefined} onClick={() => setRevision((value) => value + 1)} className="chat-icon"><RefreshCw size={16} className={clsx(reloading && "vso-spin")} /></button></header>
      <Notice tone="error" message={(messagesFailed && error === messagesError) || peopleFailed ? "" : error} onDismiss={() => setError("")} className="px-5 pt-3" />
      <div ref={listRef} onScroll={scroll.onScroll} className="thin-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 pt-2 sm:px-7">{recipient ? !messagesLoaded ? <div role="status" aria-label="Loading messages" className="space-y-6 pt-6">{[46, 34, 58].map((width, index) => <div key={index} className={clsx("flex items-start gap-2", index % 2 && "flex-row-reverse")}><span className="vso-skeleton mt-5 h-[25px] w-[25px] shrink-0 rounded-full" /><span className="grid gap-1.5" style={{ width: `${width}%` }}><span className={clsx("vso-skeleton h-2.5 w-16", index % 2 && "justify-self-end")} /><span className="vso-skeleton h-10 rounded-2xl" /></span></div>)}</div> : messagesFailed ? <EmptyState variant="error" title="Messages unavailable" body={messagesError} action={{ label: "Try again", onClick: () => setRevision((value) => value + 1) }} className="h-full" /> : messages.length || conversationPending.length ? <div className="vso-fade-enter">{renderRows(recipient)}</div> : <ChatEmpty title="No messages yet" detail={canPost ? `Say hello to ${recipient.name}.` : `Messages with ${recipient.name} will appear here.`} /> : <ChatEmpty title="Your conversations, together" detail="Choose someone from the left to send a direct message." />}</div>
      <NewMessagesPill count={scroll.unseen} onClick={scroll.jumpToLatest} className="bottom-28" />
      {recipient && <form onSubmit={send} className="shrink-0 border-t border-[var(--color-neutral-200)] bg-white p-3 sm:px-6 sm:py-4">
        <div data-open={Boolean(replyTo)} className="vso-collapse"><div><div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-[var(--color-primary-50)] px-3 py-2 text-[11px] text-[var(--color-primary-800)]"><span className="min-w-0 truncate"><span className="font-semibold">Replying to {replyShown ? replyShown.authorId === session?.user.id ? "yourself" : recipient.name : ""}</span>{replyShown ? `: ${withMentionNames(replyShown.body, mentionNames).slice(0, 80) || "an attachment"}` : ""}</span><button type="button" tabIndex={replyTo ? 0 : -1} aria-label="Cancel reply" title="Cancel reply (Esc)" onClick={() => { setReplyTo(null); composerRef.current?.focus(); }} className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors duration-150 hover:bg-[var(--color-primary-100)]"><X size={13} /></button></div></div></div>
        <div className="mb-2"><AttachmentPicker attachments={attachments} disabled={!canPost} /></div>
        <div className="flex items-end gap-2 rounded-xl border border-[var(--color-neutral-200)] px-3 py-2 transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--color-primary-400)] focus-within:ring-2 focus-within:ring-[var(--color-primary-100)]"><label htmlFor="dm-composer" className="sr-only">Message</label><textarea ref={composerRef} id="dm-composer" maxLength={10000} rows={1} value={composer} onChange={(event) => { setComposer(event.target.value); autosize(event.currentTarget); clientId.current = null; }} onPaste={(event) => { if (event.clipboardData.files.length && canPost) { event.preventDefault(); void attachments.addFiles(event.clipboardData.files); } }} onKeyDown={(event) => { if (isComposing(event)) return; if (event.key === "Escape" && replyTo) { event.preventDefault(); event.stopPropagation(); setReplyTo(null); return; } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} className="min-h-8 max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-xs outline-none placeholder:text-[var(--color-neutral-400)]" disabled={!canPost} placeholder={canPost ? "Type a message..." : "Learners can read messages but cannot send them."} /><button type="submit" disabled={!canPost || attachments.uploading || (!composer.trim() && !attachments.items.length)} aria-label="Send message" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-600)] text-white transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--color-primary-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary-300)] active:scale-[0.92] disabled:opacity-40 disabled:active:scale-100"><ChatSendIcon /></button></div>
      </form>}
    </section>
    {detailPanel}
  </ChatShell>;
}
