import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createPat(): { token: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  const token = `vso_${secret}`;
  return { token, prefix: token.slice(0, 12), hash: hashPat(token) };
}

export function hashPat(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function matchesPat(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPat(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
