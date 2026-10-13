"use client";

import { useEffect } from "react";

type ChatKind = "direct" | "channel";
type Chat = { kind: ChatKind; id: string };
let activeChat: Chat | null = null;

export function isActiveChat(kind?: string, id?: string) {
  return Boolean(kind && id && activeChat?.kind === kind && activeChat.id === id && document.visibilityState === "visible" && document.hasFocus());
}

export function useActiveChatPresence(kind: ChatKind, id: string) {
  useEffect(() => {
    if (!id) return;
    const chat = { kind, id };
    activeChat = chat;
    return () => { if (activeChat === chat) activeChat = null; };
  }, [kind, id]);
}
