import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * A secret that exists only in this API process. Hosted MCP tools call the product API over loopback as the token's
 * owner by sending it with the user id, so every permission rule stays in one place. It is never logged or returned,
 * and a new one is made on every start, so it cannot be learned from outside the process.
 */
const INTERNAL_KEY = randomBytes(32).toString("base64url");
export const INTERNAL_USER_HEADER = "x-vso-internal-user";
export const INTERNAL_KEY_HEADER = "x-vso-internal-key";

export function internalHeaders(userId: string): Record<string, string> {
  return { [INTERNAL_USER_HEADER]: userId, [INTERNAL_KEY_HEADER]: INTERNAL_KEY };
}

/** The user id of a genuine internal call, or undefined (wrong, missing, or repeated headers). */
export function internalUserId(headers: IncomingHttpHeaders): string | undefined {
  const key = headers[INTERNAL_KEY_HEADER];
  const userId = headers[INTERNAL_USER_HEADER];
  if (typeof key !== "string" || typeof userId !== "string" || !userId) return undefined;
  const given = Buffer.from(key); const expected = Buffer.from(INTERNAL_KEY);
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : undefined;
}
