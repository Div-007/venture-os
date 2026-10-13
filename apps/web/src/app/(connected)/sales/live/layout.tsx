"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Sparkles } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { HeaderActions, HeaderLabel, Panel, RefreshButton, SkeletonRows, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { useStudio } from "@/lib/studio-store";
import { listLiveMembers, loadLiveSession } from "@/lib/studio-api";
import { getSalesOverview, type SalesOverview } from "@/lib/sales-api";
import { SalesShellContext, type SalesSession, type SalesShell } from "@/components/sales/sales-context";
import { SalesLiveContext, type OverviewScope, type SalesLive, type SalesMember } from "@/components/sales/overview-context";
import { LeadDrawer } from "@/components/sales/lead-drawer";
import { SetupBanner } from "@/components/sales/setup-banner";
import { summarize } from "@/components/sales/overview-queue";
import { SALES_CHANGED_EVENT } from "@/components/shell/use-sales-nav-counts";
import { firstName, Phone, useUrlParams } from "@/components/sales/sales-ui";

const TABS = [
  { key: "overview", label: "Overview", href: "/sales/live" },
  { key: "leads", label: "Leads", href: "/sales/live/leads" },
  { key: "review", label: "Review", href: "/sales/live/review" },
  { key: "inbox", label: "Inbox", href: "/sales/live/inbox" },
  { key: "pipeline", label: "Pipeline", href: "/sales/live/pipeline" },
  { key: "plays", label: "Plays", href: "/sales/live/plays" },
  { key: "brain", label: "Offers", href: "/sales/live/brain" },
] as const;

/** Reached from buttons, not tabs. */
const TOOLS: Record<string, { title: string; description: string }> = {
  calls: { title: "Calls", description: "One lead at a time: the opener, the number, and the outcome buttons." },
  find: { title: "Find leads", description: "Describe who to find; Claude plans the search and the lead finder runs it." },
  "do-not-contact": { title: "Do not contact", description: "People and companies we never message or call again." },
  reports: { title: "Reports", description: "How the pipeline is doing, and how good Claude's judgement has been." },
  setup: { title: "Set up sales", description: "Make this venture ready for Claude to research leads and write drafts." },
};
const DESCRIPTIONS: Record<string, string> = {
  overview: "Replies to answer, calls to make, and drafts waiting for you.",
  leads: "Every company we know about, with Claude's verdict and the next step.",
  review: "Drafts Claude wrote and checked, ready for you to approve and send.",
  inbox: "Replies from the people we have contacted.",
  pipeline: "Deals from first touch to delivery.",
  plays: "Campaigns with a message, a few steps, and a stop rule.",
  brain: "What the venture sells: one packet per offer, with the buyers, gates and message rules Claude works with.",
};

function tabOf(pathname: string) {
  if (pathname === "/sales/live") return TABS[0];
  return TABS.find((tab) => tab.href !== "/sales/live" && (pathname === tab.href || pathname.startsWith(`${tab.href}/`)));
}

function Frame({ children }: { children: React.ReactNode }) {
  // Not a stagger group: the title and tabs stay still while the tab content animates in.
  return <div className="mx-auto min-w-0 w-full max-w-[1580px] px-4 py-5 sm:px-6 lg:px-7 lg:py-6">{children}</div>;
}

function Heading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <header className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-4">
    <div className="min-w-0 w-full sm:w-auto sm:flex-1"><h1 className="text-[clamp(1.6rem,3vw,2rem)] font-extrabold tracking-[-.04em] text-neutral-900 [overflow-wrap:anywhere]">{title}</h1><p className="mt-1 break-words text-sm font-normal leading-6 text-neutral-500">{description}</p></div>
    {action}
  </header>;
}

function ShellSkeleton() {
  return <Frame>
    <div role="status" aria-label="Loading sales" className="mb-4"><span className="vso-skeleton block h-8 w-56" /><span className="vso-skeleton mt-3 block h-4 w-80 max-w-full" /></div>
    <span className="vso-skeleton mb-4 block h-12 w-full max-w-lg rounded-xl" />
    <Panel><SkeletonRows rows={5} label="Loading sales" /></Panel>
  </Frame>;
}

/** Everyone in the workspace (pages of 100, up to 2,000), so owner names show on every lead whatever the team's size. */
async function allMembers() {
  const items: Awaited<ReturnType<typeof listLiveMembers>>["items"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const next = await listLiveMembers({ limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...next.items);
    if (!next.nextCursor) break;
    cursor = next.nextCursor;
  }
  return { items };
}

function SalesLiveShell({ children }: { children: React.ReactNode }) {
  const { activeVentureId: ventureId, setActiveVentureId } = useStudio();
  const pathname = usePathname();
  const router = useRouter();
  const { params, update } = useUrlParams();
  const requestedVenture = params.get("venture");
  const leadId = params.get("lead");
  const [session, setSession] = useState<SalesSession | null>(null);
  const [members, setMembers] = useState<SalesMember[]>([]);
  const [sessionError, setSessionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scope, setScope] = useState<OverviewScope>("me");
  const [result, setResult] = useState<{ key: string; data: SalesOverview | null; error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (requestedVenture) queueMicrotask(() => setActiveVentureId(requestedVenture)); }, [requestedVenture, setActiveVentureId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      setSessionError("");
      Promise.all([loadLiveSession(), allMembers().catch(() => null)]).then(([nextSession, directory]) => {
        if (!active) return;
        setSession(nextSession);
        setMembers((directory?.items ?? []).map(({ id, name, role }) => ({ id, name, role })));
      }).catch((cause: unknown) => { if (active) setSessionError(describeError(cause, "Check your connection and try again.")); });
    });
    return () => { active = false; };
  }, [attempt]);

  // One Overview for every tab: it feeds the Overview screen and the tab badges.
  const key = `${ventureId}|${scope}`;
  useEffect(() => {
    if (!session) return;
    let active = true;
    queueMicrotask(() => {
      setBusy(true);
      getSalesOverview({ ...(ventureId ? { ventureId } : {}), ...(scope === "me" ? { owner: "me" as const } : {}) }).then((data) => {
        if (!active) return;
        setResult({ key, data, error: "" }); setBusy(false);
      }).catch((cause: unknown) => {
        if (!active) return;
        setResult((previous) => ({ key, data: previous?.key === key ? previous.data : null, error: describeError(cause, "Could not load the overview. Try again.") }));
        setBusy(false);
      });
    });
    return () => { active = false; };
  }, [session, ventureId, scope, key, refreshKey]);

  // A change anywhere in Sales reloads the open lists and the sidebar counts.
  const refresh = useCallback(() => { setRefreshKey((value) => value + 1); window.dispatchEvent(new Event(SALES_CHANGED_EVENT)); }, []);
  const openLead = useCallback((id: string) => update({ lead: id }, "push"), [update]);
  const closeLead = useCallback(() => update({ lead: null }), [update]);
  const ventureName = useCallback((id: string) => session?.hierarchy.ventures.find((venture) => venture.id === id)?.name ?? "Venture", [session]);
  const personName = useCallback((id: string) => members.find((member) => member.id === id)?.name ?? (session?.user.id === id ? session.user.name : "Teammate"), [members, session]);

  const shell = useMemo<SalesShell>(() => ({ ventureId, session, openLead, refreshKey, refresh, ventureName, personName }), [ventureId, session, openLead, refreshKey, refresh, ventureName, personName]);
  const current = result?.key === key ? result : null;
  const live = useMemo<SalesLive>(() => ({ overview: current?.data ?? null, loading: !!session && !current, busy, error: current?.error ?? "", scope, setScope, members }), [current, session, busy, scope, members]);

  const tab = tabOf(pathname);
  const tool = TOOLS[pathname.split("/")[3] ?? ""];
  const counts = live.overview?.counts;
  const tabs = TABS.map((item) => ({
    key: item.key, label: item.label,
    ...(item.key === "review" && counts && counts.toReview + counts.readyToSend > 0 ? { badge: counts.toReview + counts.readyToSend } : {}),
    ...(item.key === "inbox" && counts && counts.replies > 0 ? { badge: counts.replies } : {}),
  }));

  if (sessionError && !session) return <Frame><Panel><EmptyState variant="error" title="Could not open Sales" body={sessionError} action={{ label: "Try again", onClick: () => setAttempt((value) => value + 1) }} /></Panel></Frame>;
  if (!session) return <ShellSkeleton />;

  const title = tab?.key === "overview" ? `Sales today, ${firstName(session.user.name)}.` : tab?.label ?? tool?.title ?? "Sales";
  const description = tab?.key === "overview" && counts ? summarize(counts) : tab ? DESCRIPTIONS[tab.key]! : tool?.description ?? "Dealflow for your ventures.";
  return <SalesShellContext.Provider value={shell}><SalesLiveContext.Provider value={live}>
    <Frame>
      <Heading title={title} description={description} action={<HeaderActions>
        <RefreshButton busy={busy} onClick={refresh} />
        {!pathname.startsWith("/sales/live/calls") && <Link href="/sales/live/calls" className={clsx(secondaryClass, "lg:hidden")}><Phone size={15} /><HeaderLabel>Calls</HeaderLabel></Link>}
        {!pathname.startsWith("/sales/live/find") && <Link href="/sales/live/find" className={clsx(secondaryClass, "lg:hidden")}><Sparkles size={15} /><HeaderLabel>Find leads</HeaderLabel></Link>}
      </HeaderActions>} />
      {ventureId && <SetupBanner ventureId={ventureId} ventureName={ventureName(ventureId)} />}
      {/* On laptops the sidebar is the navigation; below lg it is a drawer, so the compact tabs stay. */}
      <div className="lg:hidden">{tab
        ? <SlidingTabs label="Sales sections" tabs={tabs} active={tab.key} className="mb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onChange={(next) => { const target = TABS.find((item) => item.key === next); if (target) router.push(target.href); }} />
        : <Link href="/sales/live" className="mb-4 inline-flex min-h-10 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><ArrowLeft size={15} />Sales overview</Link>}</div>
      {children}
      {leadId && <LeadDrawer key={leadId} leadId={leadId} onClose={closeLead} />}
    </Frame>
  </SalesLiveContext.Provider></SalesShellContext.Provider>;
}

export default function SalesLiveLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<ShellSkeleton />}><SalesLiveShell>{children}</SalesLiveShell></Suspense>;
}
