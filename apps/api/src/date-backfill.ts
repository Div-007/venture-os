import type { AppDb } from "./db.js";

/** Create routes previously stored these validated ISO 8601 inputs as strings; updates and seeds already used BSON dates. */
export const backfilledDateFields: Readonly<Record<string, readonly string[]>> = {
  tasks: ["dueAt", "reviewAt"],
  outcomes: ["startAt", "reviewAt"],
  decisions: ["decidedAt"],
  classes: ["scheduledAt"],
  information_requests: ["dueAt"],
};

export async function backfillStringDates(db: AppDb): Promise<number> {
  let converted = 0;
  for (const [collection, fields] of Object.entries(backfilledDateFields)) {
    for (const field of fields) {
      const rows = await db.collection(collection).find({ [field]: { $type: "string" } }, { projection: { [field]: 1 } }).toArray();
      const updates = rows.flatMap((row) => {
        const value = new Date(row[field] as string);
        if (Number.isNaN(value.getTime())) return [];
        // Compare-and-set on the original string so a concurrent edit is never overwritten.
        return [{ updateOne: { filter: { _id: row._id, [field]: row[field] }, update: { $set: { [field]: value } } } }];
      });
      if (updates.length) converted += (await db.collection(collection).bulkWrite(updates, { ordered: false })).modifiedCount;
    }
  }
  return converted;
}
