import type { NextConfig } from "next";
import { resolve } from "node:path";

const apiOrigin = process.env.VSO_API_ORIGIN ?? "http://localhost:4000";
// Mirrors src/lib/demo.ts: production hides the sample-data prototype unless NEXT_PUBLIC_ENABLE_DEMO=true.
const demoEnabled = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ENABLE_DEMO === "true";

const nextConfig: NextConfig = {
  distDir: process.env.VSO_NEXT_DIST_DIR ?? ".next",
  // Docker production images run the self-contained server; the monorepo root is traced so workspace packages are included.
  ...(process.env.VSO_NEXT_OUTPUT === "standalone" ? { output: "standalone" as const, outputFileTracingRoot: resolve(process.cwd(), "../..") } : {}),
  images: { remotePatterns: [{ protocol: "https", hostname: "api.dicebear.com", pathname: "/10.x/adventurer/svg" }] },
  async redirects() {
    const connected = ["dashboard", "today", "calendar", "tasks", "board", "channels", "messages", "knowledge", "sales", "notifications", "focus", "planning", "admin", "leaderboard"];
    const planning = ["classes", "decisions", "timeline", "requests"];
    const unavailable = ["ai/chat", "finance", "help", "hr", "inventory", "logout", "operations", "purchase", "settings"];
    return [
      ...connected.map((name) => ({ source: `/${name}`, destination: `/${name}/live`, permanent: false })),
      ...planning.map((name) => ({ source: `/${name}`, destination: `/${name}/live`, permanent: false })),
      ...unavailable.map((name) => ({ source: `/${name}`, destination: "/unavailable", permanent: false })),
      { source: "/documents", destination: "/knowledge/live", permanent: false },
      { source: "/ventures", destination: "/ventures/live", permanent: false },
      { source: "/status", destination: "/dashboard/live", permanent: false },
      { source: "/sign-in", destination: "/sign-in/live", permanent: false },
      { source: "/invite", destination: "/invite/live", permanent: false },
      ...(demoEnabled ? [] : [
        { source: "/demo", destination: "/dashboard/live", permanent: false },
        { source: "/demo/:path*", destination: "/dashboard/live", permanent: false },
      ]),
    ];
  },
  async rewrites() {
    return [
      ...(demoEnabled ? [
        { source: "/demo", destination: "/dashboard" },
        { source: "/demo/:path*", destination: "/:path*" },
      ] : []),
      { source: "/v1/:path*", destination: `${apiOrigin}/v1/:path*` },
      { source: "/api/auth/:path*", destination: `${apiOrigin}/api/auth/:path*` },
      // Hosted MCP for Claude Code and other MCP clients (personal access tokens): Venture Studio at /mcp, Dealflow Sales at /mcp/sales.
      { source: "/mcp", destination: `${apiOrigin}/mcp` },
      { source: "/mcp/sales", destination: `${apiOrigin}/mcp/sales` },
      { source: "/socket.io", destination: `${apiOrigin}/socket.io/` },
      { source: "/socket.io/:path*", destination: `${apiOrigin}/socket.io/:path*` },
    ];
  },
};

export default nextConfig;
