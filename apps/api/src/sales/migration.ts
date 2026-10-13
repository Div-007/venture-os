// Idempotent migration of the older deal records to the Sales (Dealflow) model: stage names, the won date, the
// do-not-contact match keys (and the keys of the list entries themselves) and the verdict flag. Safe to run repeatedly (npm run migrate).
import type { AppDb } from "../db.js";
import { SUPPRESS_KEYS_VERSION, leadSuppressKeys, normalizeValue, suppressionKey, type SuppressionKind } from "./suppression.js";

export type SalesMigrationResult = { stagesRenamed: number; wonDatesSet: number; keysBackfilled: number; suppressionFixed: number; dncFlagged: number; verdictFlagsSet: number };

export async function migrateSalesLeads(db: AppDb, options: { whenChanged?: boolean } = {}): Promise<SalesMigrationResult> {
  const leads = db.collection("opportunities");
  // conversation -> replied; won -> invoice_contract (a won lead keeps the date it was last touched as its won date).
  const replied = await leads.updateMany({ stage: "conversation" }, { $set: { stage: "replied" } });
  const won = await leads.updateMany({ stage: "won" }, [{ $set: { stage: "invoice_contract", wonAt: { $ifNull: ["$wonAt", { $ifNull: ["$updatedAt", "$$NOW"] }] } } }]);
  const noWonDate = await leads.updateMany({ stage: { $in: ["invoice_contract", "cash_collected", "delivery", "retained_referred"] }, wonAt: null }, [{ $set: { wonAt: { $ifNull: ["$updatedAt", "$$NOW"] } } }]);

  // The do-not-contact list: every entry gets the normalised value and key of the current rules (entries written without a key, or under older rules,
  // are fixed; two entries that now mean the same thing become one).
  let suppressionFixed = 0;
  const entries = db.collection("sales_suppression");
  for await (const entry of entries.find({ keyV: { $ne: SUPPRESS_KEYS_VERSION } })) {
    const value = normalizeValue(entry.kind as SuppressionKind, String(entry.value));
    if (!value) { await entries.updateOne({ _id: entry._id }, { $set: { keyV: SUPPRESS_KEYS_VERSION } }); continue; }
    const key = suppressionKey(entry.kind as SuppressionKind, value);
    if (await entries.findOne({ workspaceId: entry.workspaceId, key, _id: { $ne: entry._id } }, { projection: { _id: 1 } })) await entries.deleteOne({ _id: entry._id });
    else await entries.updateOne({ _id: entry._id }, { $set: { key, value, keyV: SUPPRESS_KEYS_VERSION } });
    suppressionFixed++;
  }

  // Leads: the match keys under the current rules.
  let keysBackfilled = 0;
  const pending = leads.find({ suppressKeysV: { $ne: SUPPRESS_KEYS_VERSION } }, { projection: { companyName: 1, website: 1, contactRoutes: 1 } });
  let batch: { updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }[] = [];
  const flush = async () => {
    if (batch.length) keysBackfilled += (await leads.bulkWrite(batch as never, { ordered: false })).modifiedCount;
    batch = [];
  };
  for await (const lead of pending) {
    batch.push({ updateOne: { filter: { _id: lead._id, suppressKeysV: { $ne: SUPPRESS_KEYS_VERSION } }, update: { $set: { suppressKeys: leadSuppressKeys(lead as { companyName?: string; website?: string; contactRoutes?: { kind: string; value: string }[] }), suppressKeysV: SUPPRESS_KEYS_VERSION } } } });
    if (batch.length >= 500) await flush();
  }
  await flush();
  // Leads that the (re)normalised keys now match to an entry are flagged do-not-contact. The run at API start (`whenChanged`) skips this
  // pass when no key changed and a pass already finished under the current rules: nothing new can match (an entry added since flagged its
  // leads when it was added). A pass cut short (the server stopped) leaves no marker, so the next start runs it. npm run migrate always checks.
  let dncFlagged = 0;
  const passMarker = { _id: "004-sales-dnc-pass" };
  const passDone = (await db.collection("migrations").findOne(passMarker))?.keysVersion === SUPPRESS_KEYS_VERSION;
  if (!options.whenChanged || keysBackfilled + suppressionFixed > 0 || !passDone) {
    for await (const entry of entries.find({ key: { $type: "string" } }, { projection: { key: 1, workspaceId: 1 } })) {
      dncFlagged += (await leads.updateMany({ workspaceId: entry.workspaceId, suppressKeys: entry.key, deletedAt: null, doNotContact: { $ne: true } }, { $set: { doNotContact: true } })).modifiedCount;
    }
    await db.collection("migrations").updateOne(passMarker, { $set: { keysVersion: SUPPRESS_KEYS_VERSION, lastRunAt: new Date() } }, { upsert: true });
  }

  // A lead a verdict disqualified is remembered by a flag, not by the wording of its reason: flag the ones already stored (once).
  let verdictFlagsSet = 0;
  const marker = await db.collection("migrations").findOne({ _id: "004-sales-verdict-flag" });
  if (!marker) {
    verdictFlagsSet = (await leads.updateMany({ stage: "disqualified", exitReason: /^Not a fit/, lastTouchAt: null, disqualifiedByVerdict: { $exists: false } }, { $set: { disqualifiedByVerdict: true } })).modifiedCount;
    await db.collection("migrations").updateOne({ _id: "004-sales-verdict-flag" }, { $setOnInsert: { appliedAt: new Date(), verdictFlagsSet } }, { upsert: true });
  }
  return { stagesRenamed: replied.modifiedCount + won.modifiedCount, wonDatesSet: noWonDate.modifiedCount, keysBackfilled, suppressionFixed, dncFlagged, verdictFlagsSet };
}
