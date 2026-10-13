"use client";

import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import type { ChannelNotificationLevel } from "@venture-studio/contracts";
import { Bell, BellOff, BellRing, Check } from "@/components/ui/icons";
import { getLiveChannelNotificationLevel, setLiveChannelNotificationLevel } from "@/lib/studio-api";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";

const OPTIONS: { level: ChannelNotificationLevel; label: string; detail: string }[] = [
  { level: "all", label: "All messages", detail: "Every new message in this channel." },
  { level: "mentions", label: "@mentions only", detail: "Only when someone @mentions you. The default." },
  { level: "off", label: "Off", detail: "Nothing from this channel, not even @mentions." },
];
const ICON = { all: BellRing, mentions: Bell, off: BellOff } as const;

/** The channel header's bell: how this channel notifies me (sound, banner, push, and the inbox all follow it). */
export function ChannelNotifyMenu({ channelId, channelName }: { channelId: string; channelName: string }) {
  const [level, setLevel] = useState<ChannelNotificationLevel | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) { setLevel(null); setFailed(false); } });
    getLiveChannelNotificationLevel(channelId).then((value) => { if (active) setLevel(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [channelId]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function choose(next: ChannelNotificationLevel) {
    setOpen(false);
    button.current?.focus();
    if (next === level) return;
    const previous = level;
    setLevel(next);
    try {
      await setLiveChannelNotificationLevel(channelId, next);
      toast({ title: `#${channelName}: ${OPTIONS.find((option) => option.level === next)!.label}`, body: next === "all" ? "You'll be notified about every new message." : next === "off" ? "This channel won't notify you." : "You'll be notified when someone @mentions you." });
    } catch (cause) {
      setLevel(previous);
      toast({ tone: "error", title: "Couldn't change notifications", body: describeError(cause, "Please try again.") });
    }
  }

  const current = OPTIONS.find((option) => option.level === (level ?? "mentions"))!;
  const Icon = ICON[current.level];
  return <div ref={root} className="relative">
    <button ref={button} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={!level} aria-label={failed ? `Notifications for #${channelName} couldn't be loaded` : `Notifications for #${channelName}: ${current.label}`} title={failed ? "Couldn't load this channel's notification setting" : `Notifications: ${current.label}`} onClick={() => setOpen((value) => !value)} className={clsx("chat-icon disabled:opacity-40", open && "chat-icon-active")}>
      <span key={current.level} className="vso-label-swap grid place-items-center"><Icon size={17} /></span>
    </button>
    {open && <div id={menuId} role="menu" aria-label={`Notifications for #${channelName}`} data-align="right" className="vso-enter-popover absolute right-0 top-full z-50 mt-1.5 w-[17rem] rounded-2xl bg-white p-1.5 shadow-e3 ring-1 ring-neutral-900/5 max-sm:fixed max-sm:inset-x-3 max-sm:top-[4.5rem] max-sm:mt-0 max-sm:w-auto"
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const items = [...(root.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
      <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400">Notify me about</p>
      {OPTIONS.map((option) => {
        const OptionIcon = ICON[option.level];
        const selected = option.level === current.level;
        return <button key={option.level} type="button" role="menuitemradio" aria-checked={selected} onClick={() => void choose(option.level)}
          className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left transition-colors duration-100 hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none">
          <OptionIcon size={16} className={clsx("mt-0.5 shrink-0", selected ? "text-primary-700" : "text-neutral-400")} />
          <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold text-neutral-800">{option.label}</span><span className="block text-xs leading-5 text-neutral-500">{option.detail}</span></span>
          {selected && <Check size={15} className="mt-0.5 shrink-0 text-primary-700" />}
        </button>;
      })}
    </div>}
  </div>;
}
