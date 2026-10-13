import { AppError } from "./errors.js";

/** Required free text must contain more than whitespace. Contracts keep plain min(1) so older blank records still parse on read. */
export function assertNotBlank(input: Record<string, unknown>, fields: readonly string[]): void {
  const blank = fields.filter((field) => typeof input[field] === "string" && !(input[field] as string).trim());
  if (blank.length) throw new AppError(400, "BAD_REQUEST", `${blank.join(", ")} cannot be blank`);
}

/** A review or end date must come after the start date. */
export function assertOrderedDates(start: unknown, end: unknown, message: string): void {
  if (start === undefined || end === undefined || start === null || end === null) return;
  if (new Date(end as string | Date).getTime() <= new Date(start as string | Date).getTime()) throw new AppError(400, "BAD_REQUEST", message);
}
