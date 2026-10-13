"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

/** Animate semantic sections after a client-side route change, leaving the shell still. */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const previousPath = useRef(pathname);
  const lastKeyboardNavigation = useRef(0);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trackKeyboardNavigation = (event: KeyboardEvent) => {
      if (event.key === "Enter" && event.target instanceof Element && event.target.closest("a[href]")) {
        lastKeyboardNavigation.current = Date.now();
      }
    };
    document.addEventListener("keydown", trackKeyboardNavigation, true);
    return () => document.removeEventListener("keydown", trackKeyboardNavigation, true);
  }, []);

  useLayoutEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || Date.now() - lastKeyboardNavigation.current < 500) return;

    const groups = content.current?.querySelectorAll<HTMLElement>("[data-vso-stagger-group]");
    if (!groups?.length) return;
    const sections = [...groups].flatMap((group) => [...group.children] as HTMLElement[])
      .filter((element) => !element.querySelector("[data-vso-stagger-group]") && !element.closest('[role="dialog"]'));

    sections.forEach((element, index) => {
      element.animate([
        { opacity: 0, filter: "blur(4px)", transform: "translateY(9px) scale(0.985)" },
        { opacity: 1, filter: "blur(0)", transform: "translateY(0) scale(1)" },
      ], { duration: 220, delay: 25 + Math.min(index, 9) * 28, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "both" });
    });
  }, [pathname]);

  return <div ref={content} className="vso-route-content">{children}</div>;
}
