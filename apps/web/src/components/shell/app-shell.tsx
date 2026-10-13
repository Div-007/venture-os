"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { FocusDock } from "./ai-dock";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { workspaceHref } from "./workspace-link";
import { ChatSidebarContext } from "./chat-sidebar-context";
import { LiveNotificationPulse, LiveTitleBadge } from "./live-notification-pulse";
import { AlertsPrompt } from "./alerts-prompt";
import { ToastRegion } from "@/components/ui/toast";
import { useStudio } from "@/lib/studio-store";

type ChatEntry = { path: string; phase: "waiting" | "leaving" };
const SIDEBAR_KEY = "vso-sidebar";
const storedCollapsed = () => { try { return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed"; } catch { return false; } };

export function AppShell({ children, connected = false }: { children: React.ReactNode; connected?: boolean }) {
  const { currentUserId } = useStudio();
  const router = useRouter();
  const pathname = usePathname();
  // The connected shell mounts in the browser, so it starts in the remembered state; the server-rendered demo restores it after hydration.
  const [collapsed, setCollapsed] = useState(() => connected && storedCollapsed());
  const [instantNav, setInstantNav] = useState(false);
  const savedCollapse = useRef(false);
  // Back and Forward return to where the page was scrolled; new navigations start at the top.
  const mainRef = useRef<HTMLElement>(null);
  const scrollByPath = useRef(new Map<string, number>());
  const restoreScroll = useRef(0);
  const shownPath = useRef(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusInstant, setFocusInstant] = useState(false);
  const [revealedChatPath, setRevealedChatPath] = useState<string | null>(null);
  const [chatEntry, setChatEntry] = useState<ChatEntry | null>(null);
  const lastEscape = useRef(0);
  const isChat = /^\/(?:demo\/)?(?:channels|messages)(?:\/live)?$/.test(pathname);
  const waitingForChat = isChat && chatEntry?.path === pathname && chatEntry.phase === "waiting";
  const leavingForChat = isChat && chatEntry?.path === pathname && chatEntry.phase === "leaving";
  const immersive = isChat && revealedChatPath !== pathname && !waitingForChat;

  useEffect(() => {
    if (chatEntry?.phase !== "leaving") return;
    const timer = window.setTimeout(() => setChatEntry((current) => current === chatEntry ? null : current), 220);
    return () => window.clearTimeout(timer);
  }, [chatEntry]);

  useEffect(() => {
    lastEscape.current = 0;
  }, [pathname]);

  useEffect(() => {
    // Capture phase, ahead of the router: it may render the previous page synchronously inside its own listener.
    // Browsers with the Navigation API announce Back/Forward as a "traverse" before popstate fires.
    // Only a Back/Forward to a different page counts (query-only changes keep their place anyway).
    const mark = (toPath: string) => { if (toPath && toPath !== shownPath.current) restoreScroll.current = Date.now(); };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    if (navigation) {
      const onNavigate = (event: Event) => {
        const navigate = event as Event & { navigationType?: string; destination?: { url: string } };
        if (navigate.navigationType === "traverse" && navigate.destination) mark(new URL(navigate.destination.url).pathname);
      };
      navigation.addEventListener("navigate", onNavigate, { capture: true });
      return () => navigation.removeEventListener("navigate", onNavigate, { capture: true });
    }
    const onPop = () => mark(window.location.pathname);
    window.addEventListener("popstate", onPop, { capture: true });
    return () => window.removeEventListener("popstate", onPop, { capture: true });
  }, []);

  useEffect(() => {
    const markedAt = restoreScroll.current;
    restoreScroll.current = 0;
    shownPath.current = pathname;
    if (!markedAt || Date.now() - markedAt > 2000) return;
    const main = mainRef.current;
    const target = scrollByPath.current.get(pathname) ?? 0;
    if (!main || !target) return;
    // The page may still be loading; wait (briefly) until it is tall enough, unless the member scrolls first.
    const until = Date.now() + 2500;
    const timer = window.setInterval(() => {
      if (main.scrollHeight - main.clientHeight < target && Date.now() < until) return;
      main.scrollTop = target;
      stop();
    }, 50);
    const stop = () => window.clearInterval(timer);
    main.addEventListener("wheel", stop, { once: true, passive: true });
    main.addEventListener("touchstart", stop, { once: true, passive: true });
    return () => { stop(); main.removeEventListener("wheel", stop); main.removeEventListener("touchstart", stop); };
  }, [pathname]);

  useEffect(() => {
    if (connected || !storedCollapsed()) return;
    queueMicrotask(() => { setInstantNav(true); setCollapsed(true); requestAnimationFrame(() => requestAnimationFrame(() => setInstantNav(false))); });
  }, [connected]);

  useEffect(() => {
    if (!savedCollapse.current) { savedCollapse.current = true; return; }
    try { window.localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded"); } catch { /* Remembering the rail is a convenience. */ }
  }, [collapsed]);

  useEffect(() => {
    const onReady = (event: Event) => {
      const readyPath = (event as CustomEvent<string>).detail;
      if (chatEntry?.phase !== "waiting" || chatEntry.path !== readyPath || pathname !== readyPath) return;
      setRevealedChatPath(null);
      setChatEntry(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? null : { path: readyPath, phase: "leaving" });
    };
    window.addEventListener("venture:chat-ready", onReady);
    return () => window.removeEventListener("venture:chat-ready", onReady);
  }, [chatEntry, pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Ctrl+B folds the rail at once (keyboard actions skip the animation); text fields keep Ctrl+B for bold.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b" && !isChat && window.matchMedia("(min-width: 1024px)").matches && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))) {
        event.preventDefault();
        toggleSidebar(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "/") {
        event.preventDefault();
        if (connected) { router.push("/focus/live"); return; }
        setFocusInstant(true);
        setFocusOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setFocusInstant(true);
        setFocusOpen(false);
        setMobileOpen(false);
        const mobileChat = isChat && window.matchMedia("(max-width: 1023px)").matches;
        if (mobileChat && mobileOpen) { lastEscape.current = 0; setRevealedChatPath(null); return; }
        if (isChat && (immersive || mobileChat) && !event.repeat && !event.defaultPrevented) {
          // Let the first Escape dismiss any chat dialog before counting a pair.
          if (document.querySelector('[role="dialog"][aria-modal="true"], [role="combobox"][aria-expanded="true"]')) {
            lastEscape.current = 0;
            return;
          }
          const now = Date.now();
          if (now - lastEscape.current < 650) {
            lastEscape.current = 0;
            setRevealedChatPath(pathname);
            if (mobileChat) setMobileOpen(true);
          } else lastEscape.current = now;
        }
      }
    };
    const onFocusRequest = () => {
      if (connected) { router.push("/focus/live"); return; }
      setFocusInstant(false);
      setFocusOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("venture:focus-sprint", onFocusRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("venture:focus-sprint", onFocusRequest);
    };
  }, [connected, immersive, isChat, mobileOpen, pathname, router]);

  function toggleSidebar(instant: boolean) {
    setInstantNav(instant);
    setCollapsed((value) => !value);
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => setInstantNav(false)));
  }

  const openChat = (href: string, event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.detail === 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const destination = workspaceHref(href, connected ? "connected" : "demo");
    const targetPath = destination.split("?")[0];
    if (targetPath === pathname) {
      setRevealedChatPath(null);
      setChatEntry(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? null : { path: pathname, phase: "leaving" });
      return;
    }
    setChatEntry({ path: targetPath, phase: "waiting" });
    router.push(destination);
  };

  const toggleChatSidebar = () => {
    if (!isChat) return;
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobileOpen((value) => !value);
      setRevealedChatPath(mobileOpen ? null : pathname);
      setChatEntry(null);
      return;
    }
    if (immersive) {
      setChatEntry(null);
      setRevealedChatPath(pathname);
    } else {
      setRevealedChatPath(null);
      setChatEntry(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? null : { path: pathname, phase: "leaving" });
    }
  };

  const toggleFocus = () => {
    setFocusInstant(false);
    setFocusOpen((value) => !value);
  };

  return (
    <ChatSidebarContext.Provider value={{ visible: isChat && !immersive, toggle: toggleChatSidebar }}>
    <div className={clsx("vso-shell flex h-dvh overflow-hidden bg-white", isChat && "vso-shell-chat")} data-chat-motion={leavingForChat ? "leaving" : immersive ? "immersive" : "idle"}>
      <div className={clsx("vso-shell-sidebar-slot w-0 shrink-0 lg:overflow-hidden", immersive ? "lg:!w-0" : collapsed ? "lg:w-[76px]" : "lg:w-[248px]", instantNav && "!transition-none")}>
        <Sidebar collapsed={collapsed} instant={instantNav} mobileOpen={mobileOpen} immersive={immersive} onCloseMobile={() => { setMobileOpen(false); if (isChat) setRevealedChatPath(null); }} onOpenChat={openChat} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="vso-shell-topbar relative z-20 h-14 shrink-0" aria-hidden={isChat} inert={isChat}>
        {!isChat && <Topbar
          collapsed={collapsed}
          onToggleSidebar={() => toggleSidebar(false)}
          onOpenMobileNav={() => setMobileOpen(true)}
          focusOpen={focusOpen}
          onToggleFocus={toggleFocus}
        />}
        </div>
        <main id="main-content" ref={mainRef} onScroll={(event) => scrollByPath.current.set(window.location.pathname, event.currentTarget.scrollTop)} className={clsx("min-h-0 min-w-0 flex-1 overflow-y-auto bg-canvas", !isChat && "rounded-tl-[22px]")}>
          {!connected && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary-100 bg-primary-50 px-4 py-2 text-xs font-semibold text-primary-900 sm:px-6">
            <span>Demo prototype · Sample records only. Changes here do not reach the connected workspace.</span>
            <Link href="/dashboard/live" className="rounded-lg px-2 py-1 font-extrabold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Open connected workspace</Link>
          </div>}
          {children}
        </main>
      </div>
      {!connected && <FocusDock open={focusOpen} instant={focusInstant} onClose={() => setFocusOpen(false)} />}
      {connected && <LiveNotificationPulse userId={currentUserId} />}
      {connected && <LiveTitleBadge />}
      {connected && <AlertsPrompt />}
      <ToastRegion />
    </div>
    </ChatSidebarContext.Provider>
  );
}
