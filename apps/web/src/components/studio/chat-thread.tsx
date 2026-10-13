"use client";

import type { ChatAttachment } from "@/components/studio/chat-attachments";
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import type { Message } from "@venture-studio/contracts";
import { ChevronDown, Reply } from "@/components/ui/icons";
import { prefersReducedMotion, replayAnimation } from "@/lib/motion";
import { mentionName, type MentionNames } from "@/lib/mention-names";

/** A message shown the moment it is sent; it becomes the real message (same row, no jump) once the server confirms it. */
export type PendingMessage = { clientId: string; conversationId: string; body: string; threadRootId?: string; attachmentFileIds: string[]; attachments?: ChatAttachment[]; createdAt: string; state: "sending" | "failed"; error?: string };

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;
const minute = 60_000;
export const timeLabel = (iso: string) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const dayKey = (iso: string) => { const date = new Date(iso); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };
export function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Today";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Yesterday";
  const sameYear = date.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat("en", { weekday: "long", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}
export const startsNewDay = (previous: { createdAt: string } | undefined, item: { createdAt: string }) => !previous || dayKey(previous.createdAt) !== dayKey(item.createdAt);
/** Consecutive messages from one author within five minutes share a header and avatar. */
export const continuesGroup = (previous: Message | undefined, item: Message) => !!previous && previous.authorId === item.authorId && previous.via === item.via && !startsNewDay(previous, item) && !item.threadRootId && Date.parse(item.createdAt) - Date.parse(previous.createdAt) < 5 * minute;

/** Marks a message the author posted through a Claude connection. */
export function ViaClaude() {
  return <span title="Posted through Claude" className="rounded-full bg-[var(--color-neutral-100)] px-1.5 py-px text-[9px] font-semibold text-[var(--color-neutral-500)]">via Claude</span>;
}

export function DaySeparator({ iso }: { iso: string }) {
  return <div role="separator" aria-label={dayLabel(iso)} className="flex items-center gap-3 py-1 text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--color-neutral-400)]"><span className="h-px flex-1 bg-[var(--color-neutral-100)]" />{dayLabel(iso)}<span className="h-px flex-1 bg-[var(--color-neutral-100)]" /></div>;
}

/** Message text with @mentions drawn as pills, showing the person's name (their handle on hover). */
export function MessageText({ body, mine, className, names }: { body: string; mine: boolean; className?: string; names?: MentionNames }) {
  const parts = body.split(/(@[a-z0-9][a-z0-9._-]*)/gi);
  return <p className={className}>{parts.map((part, index) => {
    if (!(index % 2)) return part;
    const found = names ? mentionName(part.slice(1), names) : null;
    return <Fragment key={index}>
      <span title={found ? part.slice(0, part.length - found.rest.length) : undefined} className={clsx("rounded px-0.5 font-semibold", mine ? "bg-white/20 text-white" : "bg-[var(--color-primary-100)] text-[var(--color-primary-700)]")}>{found ? `@${found.name}` : part}</span>
      {found?.rest}
    </Fragment>;
  })}</p>;
}

/** Applies a reaction toggle locally so the chip responds before the server does. */
export function toggledReaction(message: Message, emoji: string): Message {
  const mine = new Set(message.myReactions ?? []);
  const counts = { ...(message.reactions ?? {}) };
  if (mine.has(emoji)) { mine.delete(emoji); counts[emoji] = Math.max(0, (counts[emoji] ?? 1) - 1); }
  else { mine.add(emoji); counts[emoji] = (counts[emoji] ?? 0) + 1; }
  return { ...message, myReactions: [...mine], reactions: counts };
}

export function ReactionChips({ message, mine, disabled, onToggle }: { message: Message; mine: boolean; disabled?: boolean; onToggle: (emoji: string) => void }) {
  const entries = Object.entries(message.reactions ?? {}).filter(([, count]) => count > 0);
  if (!entries.length) return null;
  return <div className={clsx("mt-1 flex flex-wrap gap-1", mine && "justify-end")}>{entries.map(([emoji, count]) => {
    const active = Boolean(message.myReactions?.includes(emoji));
    return <button key={emoji} type="button" disabled={disabled} onClick={(event) => { replayAnimation(event.currentTarget, "vso-pop"); onToggle(emoji); }} aria-pressed={active} aria-label={`${count} ${emoji} reaction${count === 1 ? "" : "s"}; ${active ? "remove yours" : "add yours"}`}
      className={clsx("vso-fade-enter inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-[11px] tabular-nums transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.94] disabled:opacity-60", active ? "border-[var(--color-primary-300)] bg-[var(--color-primary-50)] text-[var(--color-primary-800)]" : "border-[var(--color-neutral-200)] bg-white text-[var(--color-neutral-600)] hover:border-[var(--color-neutral-300)]")}>{emoji}<span key={count} className="vso-label-swap">{count}</span></button>;
  })}</div>;
}

/** Hover/focus toolbar with quick reactions and reply. Hidden on touch screens, which use long-press instead. */
export function QuickReactionBar({ mine, onReact, onReply }: { mine: boolean; onReact: (emoji: string) => void; onReply?: () => void }) {
  return <div role="toolbar" aria-label="Quick reactions" className={clsx("pointer-events-none absolute -top-4 z-[2] flex translate-y-1 items-center gap-0.5 rounded-xl border border-[var(--color-neutral-200)] bg-white p-0.5 opacity-0 shadow-[0_6px_18px_rgba(16,24,40,.12)] transition-[opacity,transform] duration-150 group-hover/msg:pointer-events-auto group-hover/msg:translate-y-0 group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:translate-y-0 group-focus-within/msg:opacity-100 [@media(hover:none)]:hidden", mine ? "right-0" : "left-0")}>
    {QUICK_REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={(event) => { replayAnimation(event.currentTarget, "vso-pop"); onReact(emoji); }} aria-label={`React with ${emoji}`} className="grid h-7 w-7 place-items-center rounded-lg text-[13px] transition-[background-color,transform] duration-150 hover:bg-[var(--color-neutral-100)] active:scale-90">{emoji}</button>)}
    {onReply && <button type="button" onClick={onReply} aria-label="Reply" title="Reply" className="grid h-7 w-7 place-items-center rounded-lg text-[var(--color-neutral-500)] transition-[background-color,transform] duration-150 hover:bg-[var(--color-neutral-100)] active:scale-90"><Reply size={13} className="-scale-x-100" /></button>}
  </div>;
}

/** Scrolls to a message already on screen and flashes it; returns false when it is not loaded. */
export function jumpToMessage(list: HTMLElement | null, messageId: string) {
  const target = list?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!target) return false;
  target.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  replayAnimation(target, "vso-message-flash");
  return true;
}

/**
 * Keeps the reader's place: the first load lands at the newest message instantly, new messages follow only when
 * the reader is already at the bottom (or just sent one), and otherwise a "New messages" pill counts them.
 */
export function useChatScroll(listRef: RefObject<HTMLElement | null>, conversationId: string, newestId: string, ownKey: string) {
  const nearBottom = useRef(true);
  const last = useRef({ conversationId: "", newestId: "", ownKey: "" });
  const keep = useRef<{ conversationId: string; height: number; top: number } | null>(null);
  const [unseen, setUnseen] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = last.current;
    last.current = { conversationId, newestId, ownKey };
    const kept = keep.current;
    keep.current = null;
    if (kept && kept.conversationId === conversationId) { list.scrollTop = list.scrollHeight - kept.height + kept.top; return; }
    if (previous.conversationId !== conversationId || !previous.newestId) {
      list.scrollTop = list.scrollHeight;
      nearBottom.current = true;
      queueMicrotask(() => setUnseen(0));
      return;
    }
    const sentByMe = !!ownKey && ownKey !== previous.ownKey;
    if (newestId === previous.newestId && !sentByMe) return;
    if (sentByMe || nearBottom.current) list.scrollTo({ top: list.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    else queueMicrotask(() => setUnseen((count) => count + 1));
  }, [conversationId, newestId, ownKey, listRef]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    nearBottom.current = near;
    if (near) setUnseen(0);
  }, [listRef]);

  const jumpToLatest = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    setUnseen(0);
  }, [listRef]);

  /** Call before prepending older history so the reader stays on the same message. */
  const preserveForPrepend = useCallback(() => {
    const list = listRef.current;
    if (list) keep.current = { conversationId, height: list.scrollHeight, top: list.scrollTop };
  }, [conversationId, listRef]);

  return { unseen, onScroll, jumpToLatest, preserveForPrepend };
}

export function NewMessagesPill({ count, onClick, className }: { count: number; onClick: () => void; className?: string }) {
  if (!count) return null;
  return <button type="button" onClick={onClick} className={clsx("vso-pill-in absolute left-1/2 z-20 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--color-primary-700)] px-4 text-[11px] font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-[var(--color-primary-800)] active:scale-[0.97]", className)}><ChevronDown size={14} />{count === 1 ? "New message" : "New messages"}</button>;
}

/** Status line under a message that has not reached the server yet, or failed to. */
export function PendingStatus({ pending, onRetry, onEdit, onDiscard }: { pending: PendingMessage; onRetry: () => void; onEdit: () => void; onDiscard: () => void }) {
  if (pending.state === "sending") return <span className="mt-1 block text-[10px] text-[var(--color-neutral-400)]">Sending…</span>;
  return <span role="alert" className="vso-fade-enter mt-1 flex flex-wrap items-center justify-end gap-x-2 text-[10px] font-semibold text-[var(--color-danger-text)]">{pending.error ?? "Not sent"}<button type="button" onClick={onRetry} className="underline-offset-2 hover:underline">Retry</button><button type="button" onClick={onEdit} className="text-[var(--color-neutral-500)] underline-offset-2 hover:underline">Edit</button><button type="button" onClick={onDiscard} className="text-[var(--color-neutral-500)] underline-offset-2 hover:underline">Discard</button></span>;
}

/** Grows the composer with its text, up to a few lines. */
export function autosize(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
}

/** Enter while an input method (e.g. Hindi, Japanese) is composing a word must not send. */
export const isComposing = (event: React.KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;
