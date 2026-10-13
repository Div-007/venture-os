import { z } from "zod";
import { appRoleSchema, idSchema, isoDateSchema, successEnvelope } from "./common.js";

export const workspaceSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  createdAt: isoDateSchema,
});

export const ventureSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1).max(120),
  status: z.enum(["active", "parked", "archived"]),
  goal30Day: z.string().max(500).default(""),
  health: z.number().int().min(0).max(100).optional(),
  createdAt: isoDateSchema,
});

export const groupSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  ventureId: idSchema,
  name: z.string().min(1).max(120),
  createdAt: isoDateSchema,
});

export const channelSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  ventureId: idSchema,
  groupId: idSchema,
  name: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  createdAt: isoDateSchema,
});
export const createChannelSchema = z.object({ groupId: idSchema, name: z.string().trim().min(1).max(80) });
// Permanent delete must repeat the venture's exact name, so a stray click or a stale tab cannot erase the wrong one.
export const deleteVentureSchema = z.object({ confirmName: z.string().min(1).max(120) }).strict();
export const archivedVentureSchema = z.object({ id: idSchema, name: z.string(), goal30Day: z.string(), archivedAt: isoDateSchema.optional(), archivedBy: idSchema.optional() });
export const deletedVentureSchema = z.object({ deleted: z.literal(true), deletionId: idSchema, counts: z.record(z.string(), z.number()), recoverableUntil: isoDateSchema });
// Only the 30-day goal is editable after creation; an empty string clears it.
export const updateVentureSchema = z.object({ goal30Day: z.string().trim().max(500) }).strict();
// allGroupVentureIds: ventures where the member has every group, including groups created later (each must also be in
// ventureIds). Elsewhere groupIds alone decide: the picked groups, or none. Leaving it out means no venture gets new groups.
export const updateMembershipSchema = z.object({ role: appRoleSchema, ventureIds: z.array(idSchema).max(100), groupIds: z.array(idSchema).max(500), allGroupVentureIds: z.array(idSchema).max(100).default([]), canShareKnowledge: z.boolean().optional() });

export const membershipSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  role: appRoleSchema,
  ventureIds: z.array(idSchema),
  groupIds: z.array(idSchema),
  // Ventures whose groups all belong to this member; new groups there are added to groupIds as they are created.
  allGroupVentureIds: z.array(idSchema).optional(),
  // May publish knowledge to every venture (and approve others' requests to). Admins always may; learners never.
  canShareKnowledge: z.boolean().optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  // Set per request (never stored): archived ventures and their groups. They are already removed from ventureIds/groupIds,
  // and `can` refuses them even for admins, so an archived venture stays hidden and frozen until it is restored.
  archivedVentureIds: z.array(idSchema).optional(),
  archivedGroupIds: z.array(idSchema).optional(),
});
export const memberDirectoryItemSchema = z.object({ id: idSchema, name: z.string(), handle: z.string().optional(), role: appRoleSchema });
export const memberDirectoryQuerySchema = z.object({
  ventureId: idSchema.optional(), groupId: idSchema.optional(), handle: z.string().trim().min(1).max(80).optional(),
  q: z.string().trim().min(2).max(80).optional(), cursor: idSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const hierarchySchema = z.object({
  workspace: workspaceSchema,
  ventures: z.array(ventureSchema.extend({
    groups: z.array(groupSchema.extend({ channels: z.array(channelSchema) })),
  })),
});

export const sessionBootstrapSchema = z.object({
  user: z.object({ id: idSchema, name: z.string(), email: z.email() }),
  membership: membershipSchema,
  hierarchy: hierarchySchema,
});
export const sessionBootstrapResponseSchema = successEnvelope(sessionBootstrapSchema);

export type Membership = z.infer<typeof membershipSchema>;
