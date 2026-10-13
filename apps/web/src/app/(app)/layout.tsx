import { AppShell } from "@/components/shell/app-shell";
import { RouteTransition } from "@/components/ui/route-transition";
import { StudioProvider } from "@/lib/studio-store";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <StudioProvider><AppShell><RouteTransition>{children}</RouteTransition></AppShell></StudioProvider>;
}
