export function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === "_id" ? "id" : key, jsonValue(item)]));
  return value;
}

/** Store validated ISO 8601 inputs as BSON dates so range queries and sorts treat them consistently. */
export function withDates<T extends Record<string, unknown>>(input: T, fields: readonly string[]): T {
  const result: Record<string, unknown> = { ...input };
  for (const field of fields) if (typeof result[field] === "string") result[field] = new Date(result[field] as string);
  return result as T;
}

/** Earlier writes persisted absent optional fields as null (the driver serializes `undefined` as null); contracts treat them as absent. */
export function omitNullFields<T extends Record<string, unknown>>(item: T, fields: readonly string[]): T {
  const result: Record<string, unknown> = { ...item };
  for (const field of fields) if (result[field] === null) delete result[field];
  return result as T;
}

export function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
