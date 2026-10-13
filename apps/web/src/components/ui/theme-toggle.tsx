"use client";

import { useState, useSyncExternalStore } from "react";
import { Moon, Sun } from "./icons";

const eventName = "venture-studio-theme-change";
const subscribe = (listener: () => void) => {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
};
const isDark = () => document.documentElement.dataset.theme === "dark";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  // The icons only turn once the member has used the toggle, never on page load.
  const [animate, setAnimate] = useState(false);

  const toggle = () => {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(style);
    void document.body.offsetHeight; // Commit the new theme without crossfading the entire interface.
    setAnimate(true);
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { document.cookie = `venture_studio_theme=${next}; Path=/; SameSite=Lax; Max-Age=31536000`; } catch { /* Keep the current tab usable. */ }
    window.dispatchEvent(new Event(eventName));
    requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
  };

  return <button type="button" onClick={toggle} aria-label={dark ? "Use light theme" : "Use dark theme"}
    aria-pressed={dark} title={dark ? "Use light theme" : "Use dark theme"}
    className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[color,background-color,scale] duration-150 hover:bg-neutral-100 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.96] ${className}`}>
    <span aria-hidden="true" className="grid"><span className="vso-icon-swap grid place-items-center" data-animate={animate} data-state={dark ? "in" : "out"}><Sun size={18} /></span><span className="vso-icon-swap grid place-items-center" data-animate={animate} data-state={dark ? "out" : "in"}><Moon size={18} /></span></span>
  </button>;
}
