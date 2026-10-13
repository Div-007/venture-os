import type { AppRole, Membership } from "@venture-studio/contracts";

export type Action =
  | "workspace:read" | "venture:read" | "group:read" | "channel:read" | "message:write"
  | "task:create" | "task:update" | "task:review" | "outcome:write" | "knowledge:write"
  | "membership:manage" | "pat:manage";

const roleActions: Record<AppRole, ReadonlySet<Action>> = {
  admin: new Set<Action>(["workspace:read", "venture:read", "group:read", "channel:read", "message:write", "task:create", "task:update", "task:review", "outcome:write", "knowledge:write", "membership:manage", "pat:manage"]),
  venture_head: new Set<Action>(["workspace:read", "venture:read", "group:read", "channel:read", "message:write", "task:create", "task:update", "task:review", "outcome:write", "knowledge:write", "pat:manage"]),
  contributor: new Set<Action>(["workspace:read", "venture:read", "group:read", "channel:read", "message:write", "task:create", "task:update", "knowledge:write", "pat:manage"]),
  reviewer: new Set<Action>(["workspace:read", "venture:read", "group:read", "channel:read", "message:write", "task:review", "pat:manage"]),
  learner: new Set<Action>(["workspace:read", "venture:read", "group:read", "channel:read", "pat:manage"]),
};

export function can(membership: Membership, action: Action, scope: { ventureId?: string; groupId?: string } = {}): boolean {
  if (!roleActions[membership.role].has(action)) return false;
  // Archived ventures are frozen for everyone, admins included, until restored.
  if (scope.ventureId && membership.archivedVentureIds?.includes(scope.ventureId)) return false;
  if (scope.groupId && membership.archivedGroupIds?.includes(scope.groupId)) return false;
  if (membership.role === "admin") return true;
  if (scope.ventureId && !membership.ventureIds.includes(scope.ventureId)) return false;
  if (scope.groupId && !membership.groupIds.includes(scope.groupId)) return false;
  return true;
}

/** The knowledge sensitivities a role may read. */
export function readableSensitivities(role: string): string[] {
  return role === "admin" ? ["team", "venture_restricted", "manager", "founder_private"] : role === "venture_head" ? ["team", "venture_restricted", "manager"] : ["team", "venture_restricted"];
}

/** May publish knowledge to every venture and approve others' requests to: admins, and writers given the permission. */
export function sharesKnowledge(membership: { role: string; canShareKnowledge?: boolean }): boolean {
  return membership.role === "admin" || (membership.canShareKnowledge === true && (membership.role === "venture_head" || membership.role === "contributor"));
}

export function validateMembershipSubset(membership: Membership, groups: ReadonlyArray<{ id: string; ventureId: string }>): boolean {
  const allowedVentures = new Set(membership.ventureIds);
  const groupVentures = new Map(groups.map((group) => [group.id, group.ventureId]));
  return membership.groupIds.every((groupId) => {
    const ventureId = groupVentures.get(groupId);
    return ventureId !== undefined && allowedVentures.has(ventureId);
  });
}

export function dmKey(userA: string, userB: string): string {
  return [userA, userB].sort().join(":");
}
