/**
 * People who can be given work in a venture (and group): members listed there, or workspace admins, who open every venture
 * and group through their role, so their memberships list none. Used for task assignees and reviewers, chat /assign and
 * /notify recipients, and class reviewers, facilitators and participants.
 */
export const listedInOrAdmin = (ventureId: string, groupId?: string) => ({ $or: [{ ventureIds: ventureId, ...(groupId ? { groupIds: groupId } : {}) }, { role: "admin" }] });

/** One person's active membership, if they can be given work in this venture and group. */
export const assignableMembership = (workspaceId: string, userId: string, ventureId: string, groupId: string) => ({ workspaceId, userId, status: "active", ...listedInOrAdmin(ventureId, groupId) });
