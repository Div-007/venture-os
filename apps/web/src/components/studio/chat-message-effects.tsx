"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Message } from "@venture-studio/contracts";
import { Volume2, VolumeX } from "@/components/ui/icons";

type Sound = "sent" | "received" | "alert";
let audio: AudioContext | null = null;

/* Message sounds can be muted per browser; the choice is a convenience, so storage failures fall back to sound on. */
const SOUND_KEY = "vso-chat-sound";
const soundListeners = new Set<() => void>();
let muted = (() => { try { return typeof window !== "undefined" && window.localStorage.getItem(SOUND_KEY) === "off"; } catch { return false; } })();

export function setChatSoundMuted(next: boolean) {
  muted = next;
  try { window.localStorage.setItem(SOUND_KEY, next ? "off" : "on"); } catch { /* The toggle still works for this visit. */ }
  soundListeners.forEach((listener) => listener());
}

function subscribeSound(listener: () => void) {
  soundListeners.add(listener);
  return () => { soundListeners.delete(listener); };
}

export function useChatSoundMuted() {
  return useSyncExternalStore(subscribeSound, () => muted, () => false);
}

export function ChatSoundToggle() {
  const isMuted = useChatSoundMuted();
  return <button type="button" aria-pressed={isMuted} aria-label={isMuted ? "Turn message sounds on" : "Mute message sounds"} title={isMuted ? "Message sounds off" : "Message sounds on"} className="chat-icon" onClick={() => {
    setChatSoundMuted(!isMuted);
    // Turning sound back on plays the cue once so the change is audible.
    if (isMuted) { prepareChatAudio(); playChatSound("received"); }
  }}><span key={String(isMuted)} className="vso-label-swap grid place-items-center">{isMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}</span></button>;
}

export function prepareChatAudio(): Promise<void> {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") return audio.resume().catch(() => undefined);
  } catch { /* Audio is optional when the browser or device disallows it. */ }
  return Promise.resolve();
}

/** Browsers only let a page play sound after someone has clicked or typed in it. */
export function isChatAudioReady() {
  return !muted && audio?.state === "running";
}

/** A new message while the site is open but not in front: two soft notes, fuller than the in-chat cue. */
function playAlert(context: AudioContext) {
  const now = context.currentTime;
  for (const [index, frequency] of [659.25, 987.77].entries()) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = now + index * 0.11;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.11, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.34);
  }
}

export function playChatSound(kind: Sound) {
  if (muted || !audio || audio.state !== "running") return;
  if (kind === "alert") { try { playAlert(audio); } catch { /* Sound is optional. */ } return; }
  try {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const now = audio.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(kind === "sent" ? 630 : 440, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === "sent" ? 880 : 660, now + 0.085);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.14);
  } catch { /* A failed cue must never interrupt sending or receiving. */ }
}

/** Existing history is quiet; only messages added after the first load animate. */
export function useChatMessageArrival(conversationId: string, messages: Message[], userId: string | undefined, loaded: boolean) {
  const seen = useRef<{ conversationId: string; ids: Set<string>; latestAt: number; initialized: boolean }>({ conversationId: "", ids: new Set(), latestAt: 0, initialized: false });
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  useEffect(() => {
    window.addEventListener("pointerdown", prepareChatAudio, { once: true });
    window.addEventListener("keydown", prepareChatAudio, { once: true });
    return () => { window.removeEventListener("pointerdown", prepareChatAudio); window.removeEventListener("keydown", prepareChatAudio); };
  }, []);
  useEffect(() => {
    if (seen.current.conversationId !== conversationId) {
      seen.current = { conversationId, ids: new Set(), latestAt: 0, initialized: false };
      queueMicrotask(() => setArrived(new Set()));
    }
    if (!conversationId || !loaded) return;
    if (!seen.current.initialized) {
      seen.current.ids = new Set(messages.map((message) => message.id));
      seen.current.latestAt = Math.max(0, ...messages.map((message) => Date.parse(message.createdAt) || 0));
      seen.current.initialized = true;
      return;
    }
    const fresh = messages.filter((message) => !seen.current.ids.has(message.id) && (Date.parse(message.createdAt) || 0) >= seen.current.latestAt);
    for (const message of messages) seen.current.ids.add(message.id);
    seen.current.latestAt = Math.max(seen.current.latestAt, ...messages.map((message) => Date.parse(message.createdAt) || 0));
    if (!fresh.length) return;
    queueMicrotask(() => setArrived((current) => new Set([...current, ...fresh.map((message) => message.id)])));
    if (fresh.some((message) => message.authorId !== userId) && document.visibilityState === "visible" && document.hasFocus()) {
      playChatSound("received");
    }
  }, [conversationId, loaded, messages, userId]);
  return arrived;
}

export function ChatSendIcon({ size = 17 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3 3.5 10.4a.9.9 0 0 0 .07 1.69l6.57 2.19 2.19 6.57a.9.9 0 0 0 1.69.07L21 3Z" /><path d="m10.1 14.3 6.2-6.2" /></svg>;
}
