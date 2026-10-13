"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useStudio } from "@/lib/studio-store";

const connectedRoutes: Record<string, string> = {
  dashboard: "/dashboard/live", today: "/today/live", calendar: "/calendar/live", ventures: "/ventures/live",
  tasks: "/tasks/live", board: "/board/live", channels: "/channels/live",
  messages: "/messages/live", notifications: "/notifications/live",
  knowledge: "/knowledge/live", decisions: "/decisions/live", classes: "/classes/live",
  timeline: "/timeline/live", requests: "/requests/live", sales: "/sales/live",
  admin: "/admin/live", settings: "/notifications/live", focus: "/focus/live", connect: "/connect/live", leaderboard: "/leaderboard/live",
};

export function workspaceHref(href: string, mode: "demo" | "connected") {
  if (!href.startsWith("/") || href.startsWith("/demo") || href.includes("/live")) return href;
  if (mode === "demo") return `/demo${href}`;
  const url = new URL(href, "http://workspace.local");
  const route = connectedRoutes[url.pathname.slice(1)];
  if (!route) return "/dashboard/live";
  const destination = new URL(route, "http://workspace.local");
  url.searchParams.forEach((value, key) => destination.searchParams.set(key, value));
  return `${destination.pathname}${destination.search}${url.hash}`;
}

export function WorkspaceLink({ href, ...props }: ComponentProps<typeof Link>) {
  const { mode } = useStudio();
  return <Link href={typeof href === "string" ? workspaceHref(href, mode) : href} {...props} />;
}
