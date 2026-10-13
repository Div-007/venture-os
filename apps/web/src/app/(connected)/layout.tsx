import { LiveShell } from "@/components/shell/live-shell";
import { RouteTransition } from "@/components/ui/route-transition";

export default function ConnectedLayout({ children }: { children: React.ReactNode }) { return <LiveShell><RouteTransition>{children}</RouteTransition></LiveShell>; }
