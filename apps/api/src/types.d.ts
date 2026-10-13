import type { Membership } from "@venture-studio/contracts";

declare global {
  namespace Express {
    interface Request {
      id: string;
      identity?: { id: string; email: string; name: string };
      actor?: { id: string; email: string; name: string; membership: Membership };
      auditWorkspaceId?: string;
      interfaceChannel: "api" | "mcp" | "engine";
    }
  }
}

export {};
