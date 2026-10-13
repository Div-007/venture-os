import { z } from "zod";

export const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid opaque ID");
export const isoDateSchema = z.iso.datetime({ offset: true });
export const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");

export const appRoleSchema = z.enum(["admin", "venture_head", "contributor", "reviewer", "learner"]);
export const errorCodeSchema = z.enum([
  "BAD_REQUEST", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT",
  "RATE_LIMITED", "STALE_PREVIEW", "INTERNAL_ERROR", "INTEGRATION_UNAVAILABLE",
]);

export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

export const successEnvelope = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data });
export const pagedDataSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: idSchema.optional() });
export const pagedSuccessEnvelope = <T extends z.ZodType>(item: T) => successEnvelope(pagedDataSchema(item));

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const eventEnvelopeSchema = z.object({
  version: z.literal(1),
  eventId: idSchema,
  occurredAt: isoDateSchema,
  actorId: idSchema.nullable(),
  workspaceId: idSchema,
  ventureId: idSchema.optional(),
  groupId: idSchema.optional(),
  channelId: idSchema.optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type AppRole = z.infer<typeof appRoleSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
