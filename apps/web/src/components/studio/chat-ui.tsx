"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Hash, MessageCircle, PanelLeftClose, PanelLeftOpen, Search, X, type Icon } from "@/components/ui/icons";
import { EmptyState, type EmptyAction, type EmptyTone } from "@/components/ui/empty-state";
import { ChatSoundToggle } from "@/components/studio/chat-message-effects";
import clsx from "clsx";
import type { ReactNode } from "react";
import { useChatSidebar } from "@/components/shell/chat-sidebar-context";

// Artwork already shown once this visit appears at once; new artwork fades in over the tinted placeholder.
const loadedAvatars = new Set<string>();

export function ChatAvatar({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  const src = `https://api.dicebear.com/10.x/adventurer/svg?seed=${encodeURIComponent(id)}`;
  const [loaded, setLoaded] = useState(() => loadedAvatars.has(src));
  const settle = () => { loadedAvatars.add(src); setLoaded(true); };
  return <span className="inline-block shrink-0 overflow-hidden rounded-full bg-[var(--color-primary-100)] ring-1 ring-black/5" style={{ width: size, height: size }}><Image unoptimized src={src} alt={`${name}'s avatar`} width={size} height={size} data-loaded={loaded || loadedAvatars.has(src)} onLoad={settle} onError={settle} className="vso-avatar-img block rounded-full" style={{ width: size, height: size }} /></span>;
}

export function useChatReady(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("venture:chat-ready", { detail: window.location.pathname })));
    });
    return () => { window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame); };
  }, [ready]);
}

export function ChatShell({ children, ready }: { children: ReactNode; ready: boolean }) {
  useChatReady(ready);
  return <div className="flex h-full min-h-[420px] flex-col overflow-hidden bg-[var(--color-neutral-50)] text-[var(--color-neutral-900)]"><div data-vso-stagger-group className="flex h-full min-h-0 w-full flex-row overflow-hidden bg-white shadow-[0_12px_50px_rgba(33,36,69,.06)]">{children}</div></div>;
}

export function ChatNav({ mode }: { mode: "messages" | "channels" }) {
  const sidebar = useChatSidebar();
  return <div className="flex items-center gap-1"><button type="button" onClick={sidebar.toggle} aria-label={sidebar.visible ? "Hide workspace sidebar" : "Show workspace sidebar"} aria-expanded={sidebar.visible} title={sidebar.visible ? "Hide sidebar" : "Show sidebar"} className="chat-icon">{sidebar.visible ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button><div className="mx-1 h-5 w-px bg-black/10" /><Link href="/messages/live" aria-label="Direct messages" title="Direct messages" className={clsx("chat-icon", mode === "messages" && "chat-icon-active")}><MessageCircle size={17} /></Link><Link href="/channels/live" aria-label="Channels" title="Channels" className={clsx("chat-icon", mode === "channels" && "chat-icon-active")}><Hash size={17} /></Link><ChatSoundToggle /></div>;
}

export function ChatSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  const input = useRef<HTMLInputElement>(null);
  return <label className="flex h-10 items-center gap-2 rounded-lg bg-[var(--color-neutral-100)] px-3 text-[var(--color-neutral-400)] transition-[background-color,box-shadow] duration-150 focus-within:bg-white focus-within:ring-2 focus-within:ring-[var(--color-primary-200)]"><Search size={15} /><span className="sr-only">{placeholder}</span><input ref={input} className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-neutral-900)] outline-none placeholder:text-[var(--color-neutral-400)]" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && value) { event.preventDefault(); event.stopPropagation(); onChange(""); } }} placeholder={placeholder} />{value && <button type="button" aria-label="Clear search" onClick={() => { onChange(""); input.current?.focus(); }} className="vso-fade-enter -mr-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-150 hover:bg-[var(--color-neutral-200)] hover:text-[var(--color-neutral-600)]"><X size={13} /></button>}</label>;
}

/** Empty message area: the kit's card empty (gradient tile over a soft dither), centred in the thread. */
export function ChatEmpty({ title, detail, icon = MessageCircle, tone = "teal", action, className }: { title: string; detail: string; icon?: Icon; tone?: EmptyTone; action?: EmptyAction; className?: string }) {
  return <EmptyState variant="card" icon={icon} tone={tone} title={title} body={detail} action={action} className={clsx("h-full", className)} />;
}

export function ChatCredit() {
  return <p className="text-[10px] leading-4 text-[var(--color-neutral-400)]">Avatar artwork: <a className="underline" href="https://www.dicebear.com/styles/adventurer/" target="_blank" rel="noreferrer">Adventurer by Lisa Wischofsky, remixed by DiceBear</a> · <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></p>;
}
