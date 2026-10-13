import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { ensureIndexes } from "./indexes.js";
import { backfillMissingHandles } from "./handles.js";
import { backfillStringDates } from "./date-backfill.js";
import { migrateSalesLeads } from "./sales/migration.js";

const config = loadConfig();
const database = await connectDatabase(config);
try {
  await ensureIndexes(database.db);
  await database.db.collection("migrations").updateOne(
    { _id: "001-initial-indexes" },
    { $setOnInsert: { appliedAt: new Date() } },
    { upsert: true },
  );
  console.info("Migration 001-initial-indexes applied");
  const handlesBackfilled = await backfillMissingHandles(database);
  await database.db.collection("migrations").updateOne(
    { _id: "002-user-handles" },
    { $set: { lastRunAt: new Date(), handlesBackfilled }, $setOnInsert: { appliedAt: new Date() } },
    { upsert: true },
  );
  console.info(`Migration 002-user-handles applied; ${handlesBackfilled} handles backfilled`);
  const datesConverted = await backfillStringDates(database.db);
  await database.db.collection("migrations").updateOne(
    { _id: "003-string-dates" },
    { $set: { lastRunAt: new Date(), datesConverted }, $setOnInsert: { appliedAt: new Date() } },
    { upsert: true },
  );
  console.info(`Migration 003-string-dates applied; ${datesConverted} date fields converted`);
  const sales = await migrateSalesLeads(database.db);
  await database.db.collection("migrations").updateOne(
    { _id: "004-sales-leads" },
    { $set: { lastRunAt: new Date(), ...sales }, $setOnInsert: { appliedAt: new Date() } },
    { upsert: true },
  );
  console.info(`Migration 004-sales-leads applied; ${sales.stagesRenamed} stages renamed, ${sales.wonDatesSet} won dates set, ${sales.keysBackfilled} leads given do-not-contact keys, ${sales.suppressionFixed} list entries normalised, ${sales.dncFlagged} leads flagged do-not-contact, ${sales.verdictFlagsSet} verdict flags set`);
} finally {
  await database.client.close();
}
