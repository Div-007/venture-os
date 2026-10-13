// Cleans the Sales data in the Venture OS DEV database. Same guards as import-dealflow.ts: APP_MODE is not production, the
// MongoDB host is local (or --allow-host), the database name ends with "_dev" (or --allow-db names it). Every run that writes
// first saves the collections it will touch as EJSON under ~/Documents/Dealflow Data/vso-dev-backups/<time>/. No network calls.
// Run from the repo root:
//   node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/scripts/clean-sales-dev.ts --qa --dry-run
//
//   --qa              Removes what the QA scripts leave behind (Prospector tooling/vso-qa): leads they created and deleted
//                     (tag "qa", or a name the scripts write: "QA Flow Test …", "ZZ UI check co (delete me)"), and those leads' drafts,
//                     activities, verdicts, reminders, notices and find runs. Today's send counters are recounted from what is
//                     left, so test sends never use up a person's daily cap. Never touches a lead that is not deleted.
//   --old-import      One-off clean of the leads imported from the old Dealflow SQLite, so Sales shows only work worth doing:
//                     1. drafts written by the old engine before any research (not sent) are discarded;
//                     2. imported leads marked "researched" without a verdict go back to "identified", and the old engine's
//                        fit grade and "review the draft" next step are cleared (a lead counts as researched once it has a verdict);
//                     3. imported leads outside the target are parked: tagged "old-import-parked" and soft-deleted (hidden
//                        everywhere, kept in the database, still known to duplicate checks). Kept: office in Chhattisgarh,
//                        Madhya Pradesh, Maharashtra or Odisha, a trade the dealer app fits, its own website to research (not a
//                        directory, listing or article page), and not a big brand; plus any lead with a verdict, a contact or a later stage.
//   --restore-parked  Undoes step 3: un-deletes every lead parked by --old-import.
//   --dry-run         Prints what would change; writes nothing.
import os from "node:os";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { BSON, MongoClient, type Db, type Document } from "mongodb";
import { mongoHosts } from "./import-dealflow.js";
import { localDay } from "../src/sales/workdays.js";

const WORKSPACE_ID = "workspace-studio";
const NEVER_WRITE = new Set(["admin", "config", "local", "laxmi_agro", "library_flow_dev"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export const PARKED_TAG = "old-import-parked";
const IMPORT_SYSTEM = "dealflow-sqlite";
const OPEN_DRAFT = ["draft", "in_review", "ready", "needs_changes"];
const PRE_CONTACT = new Set(["identified", "researched"]);

/**
 * A lead the QA scripts made: tagged "qa", or with a name they write ("QA Flow Test 123", "QA MCP Lead 123", "ZZ UI check co (delete me)").
 * A real company such as "QA Infotech" or "ZZ Traders" that someone deleted is never removed for good. Find runs: only the scripts' markers.
 */
export const QA_NAME = /^(?:QA (?:Flow Test|Opt-out Test|Same Person|Consent|UI Flow|MCP Lead)\b|ZZ UI (?:test|check)\b)|\(delete me\)/i;
const QA_RUN = /safe to ignore|\(delete me\)/i;

/** Buildory sells in person: the buyer's office must be in one of these states (owner, 2026-09-29). */
const TARGET_STATES = new Set(["chhattisgarh", "madhya pradesh", "maharashtra", "odisha"]);
const STATE_ALIASES: Record<string, string> = { cg: "chhattisgarh", "c.g.": "chhattisgarh", mp: "madhya pradesh", "m.p.": "madhya pradesh", orissa: "odisha", mh: "maharashtra" };
/** For imported leads with no state: cities in the target states. */
const TARGET_CITY = /\b(raipur|bhilai|durg|bilaspur|korba|rajnandgaon|urla|siltara|bhanpuri|jagdalpur|indore|bhopal|jabalpur|gwalior|ujjain|pithampur|dewas|dhar|sagar|ratlam|mandideep|nagpur|pune|mumbai|thane|navi mumbai|bhiwandi|nashik|kolhapur|jalgaon|aurangabad|sambhajinagar|sangli|satara|solapur|amravati|akola|ahmednagar|latur|nanded|bhubaneswar|cuttack|rourkela|sambalpur|berhampur|balasore)\b/i;
/** Trades the dealer ordering app fits: makers and distributors who sell through dealers. */
const TRADE = /pump|pipe|tube|irrigat|drip|sprinkler|agri|krishi|farm|tractor|sprayer|motor|electric|cable|wire|valve|fitting|borewell|plumb|sanitar|hardware|building/i;
/** "Websites" that are directories, listings, maps or articles, not the company's own site: nothing there to research or quote. */
const LISTING_HOSTS = ["idbf.in", "all.biz", "indiamart.com", "justdial.com", "tradeindia.com", "exportersindia.com", "sulekha.com", "globallinker.com", "buildingworld.ai", "rocketreach.co",
  "importinfo.com", "mappls.com", "sachniti.com", "bharatibiz.com", "indian-traders.com", "wheree.com", "myahmednagar.com", "msmeleap.com", "adshopee.com", "adseed.in", "naharmart.in",
  "gujarattilesinfo.com", "ueniweb.com", "precedenceresearch.com", "wotr.org", "krishitek.com", "printpackipama.com", "theteras.com", "tuffbathrooms.com", "agri-route.com",
  "buildingandinteriors.com", "appointdistributors.com", "cabralirrigation.com", "tractorkarvan.com", "facebook.com", "linkedin.com", "instagram.com", "youtube.com", "wikipedia.org"];
/** National and multinational brands the old engine missed: they run their own dealer systems; not buyers for this offer. */
const BIG_BRAND_HOSTS = ["waaree.com", "makita.in", "meil.in", "spxflow.com", "goldmedalindia.com", "astralbathware.com", "nrbindustrialbearings.com", "indoasian.com", "inframarketstores.com", "cera-india.com", "dynapar.co.in"];
const hostOf = (website: unknown) => String(website ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#:].*$/, "");
const onHost = (lead: Lead, hosts: string[]) => { const host = hostOf(lead.website); return !!host && hosts.some((item) => host === item || host.endsWith(`.${item}`)); };
export const isListing = (lead: Lead) => onHost(lead, LISTING_HOSTS);
export const isBigBrand = (lead: Lead) => tagsOf(lead).includes("national brand") || onHost(lead, BIG_BRAND_HOSTS);

type Lead = Document & { _id: string; companyName?: string; region?: string; city?: string; category?: string; website?: string; tags?: string[]; stage?: string };
const tagsOf = (lead: Lead) => (Array.isArray(lead.tags) ? lead.tags.map(String) : []);
const stateOf = (lead: Lead) => { const value = String(lead.region ?? "").trim().toLowerCase(); return STATE_ALIASES[value] ?? value; };

export function inRegion(lead: Lead): boolean {
  const state = stateOf(lead);
  return state ? TARGET_STATES.has(state) : TARGET_CITY.test(String(lead.city ?? ""));
}
export function fitsTrade(lead: Lead): boolean {
  return TRADE.test(String(lead.category ?? "")) || tagsOf(lead).some((tag) => TRADE.test(tag)) || TRADE.test(String(lead.companyName ?? ""));
}
/** Imported leads worth researching now; everything else imported is parked. */
export function keepImported(lead: Lead): boolean {
  if (lead.verdict || lead.lastTouchAt || !PRE_CONTACT.has(String(lead.stage)) || lead.doNotContact) return true;
  return inRegion(lead) && fitsTrade(lead) && !!String(lead.website ?? "").trim() && !isListing(lead) && !isBigBrand(lead);
}

function guard(values: { "allow-db"?: string; "allow-host"?: boolean }) {
  const dbName = process.env.MONGODB_DB ?? ""; const uri = process.env.MONGODB_URI ?? "";
  if (process.env.APP_MODE === "production") throw new Error("Refusing to run: APP_MODE=production.");
  if (!dbName || !uri) throw new Error("MONGODB_DB and MONGODB_URI must be set (run with --env-file=.env).");
  if (NEVER_WRITE.has(dbName)) throw new Error(`Refusing to run: "${dbName}" is not a Venture OS database.`);
  if (!dbName.endsWith("_dev") && values["allow-db"] !== dbName) throw new Error(`Refusing to run: database "${dbName}" does not end with "_dev". Pass --allow-db ${dbName} to confirm.`);
  const remote = mongoHosts(uri).filter((host) => !LOCAL_HOSTS.has(host));
  if (remote.length && !values["allow-host"]) throw new Error(`Refusing to run: MONGODB_URI host "${remote.join(", ")}" is not local. Pass --allow-host to confirm.`);
  return { dbName, uri };
}

async function backup(db: Db, names: string[], dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    writeFileSync(path.join(dir, `${name}.json`), BSON.EJSON.stringify(docs, undefined, 0, { relaxed: false }));
  }
  console.log(`  backup: ${names.length} collections saved to ${dir}`);
}

const audit = (db: Db, actorId: string, action: string, metadata: Record<string, number | string>) =>
  db.collection<Document>("audit_events").insertOne({ _id: randomUUID() as unknown as Document["_id"], workspaceId: WORKSPACE_ID, actorId, channel: "api", action, objectType: "sales", result: "success", metadata, occurredAt: new Date() });

// ------------------------------------------------------------------------------------------------ --qa

async function purgeQa(db: Db, dry: boolean, actor: string) {
  const deleted = await db.collection<Lead>("opportunities").find({ workspaceId: WORKSPACE_ID, deletedAt: { $ne: null } }).toArray();
  const qa = deleted.filter((lead) => !tagsOf(lead).includes(PARKED_TAG) && (tagsOf(lead).includes("qa") || QA_NAME.test(String(lead.companyName ?? ""))));
  const ids = qa.map((lead) => lead._id);
  const other = deleted.length - qa.length;
  const drafts = await db.collection("sales_drafts").find({ leadId: { $in: ids } }, { projection: { _id: 1 } }).toArray();
  const activities = await db.collection("sales_activities").find({ leadId: { $in: ids } }, { projection: { _id: 1 } }).toArray();
  const related = [...ids, ...drafts.map((row) => String(row._id)), ...activities.map((row) => String(row._id))];
  const runs = (await db.collection("sales_find_runs").find({ workspaceId: WORKSPACE_ID }).toArray()).filter((run) => {
    if (QA_RUN.test(String(run.request ?? "")) || String(run._id).startsWith("qa-")) return true;
    const named = [...(run.leadIds ?? []), ...((run.leads ?? []) as Document[]).map((row) => row.leadId ?? row.id)].map(String).filter(Boolean);
    return named.length > 0 && named.every((id) => ids.includes(id));
  });
  const plan: Record<string, Document> = {
    sales_drafts: { leadId: { $in: ids } },
    sales_activities: { leadId: { $in: ids } },
    sales_verdicts: { leadId: { $in: ids } },
    reminders: { leadId: { $in: ids } },
    notifications: { resourceId: { $in: related } },
    notification_outbox: { resourceId: { $in: related } },
    sales_find_runs: { _id: { $in: runs.map((run) => run._id) } },
    opportunities: { _id: { $in: ids }, deletedAt: { $ne: null } },
  };
  console.log(`\n--qa: ${qa.length} QA leads (deleted) to remove with everything attached; ${other} other deleted leads left alone.`);
  if (qa.length) console.log(`  e.g. ${qa.slice(0, 4).map((lead) => lead.companyName).join(" | ")}`);
  const counts: Record<string, number> = {};
  for (const [name, filter] of Object.entries(plan)) counts[name] = ids.length || name === "sales_find_runs" ? await db.collection(name).countDocuments(filter) : 0;
  console.log("  rows:", JSON.stringify(counts));
  if (dry) return counts;
  for (const [name, filter] of Object.entries(plan)) if (counts[name]) await db.collection(name).deleteMany(filter);
  counts.sendCounters = await recountSendCounters(db);
  await audit(db, actor, "sales.cleanup.qa", counts);
  console.log(`  removed; send counters recounted: ${counts.sendCounters} changed`);
  return counts;
}

/** Sets each send counter to the outbound messages still logged that day (deleting rows that drop to zero). */
async function recountSendCounters(db: Db): Promise<number> {
  let changed = 0;
  for (const row of await db.collection("sales_send_counters").find({}).toArray()) {
    const from = new Date(Date.parse(`${row.day}T00:00:00Z`) - 36 * 3_600_000), to = new Date(Date.parse(`${row.day}T00:00:00Z`) + 36 * 3_600_000);
    const sent = (await db.collection("sales_activities").find({ workspaceId: row.workspaceId, ventureId: row.ventureId, actorId: row.userId, direction: "out", kind: row.channel, at: { $gte: from, $lt: to } }, { projection: { at: 1 } }).toArray())
      .filter((activity) => localDay(new Date(activity.at)) === row.day).length;
    if (sent === row.count) continue;
    changed++;
    if (sent === 0) await db.collection("sales_send_counters").deleteOne({ _id: row._id });
    else await db.collection("sales_send_counters").updateOne({ _id: row._id }, { $set: { count: sent, updatedAt: new Date() } });
  }
  return changed;
}

// ------------------------------------------------------------------------------------------------ --old-import

async function cleanOldImport(db: Db, dry: boolean, actor: string) {
  const now = new Date();
  const leads = db.collection<Lead>("opportunities");
  const live = await leads.find({ workspaceId: WORKSPACE_ID, deletedAt: null }).toArray();
  const imported = live.filter((lead) => lead.externalRef?.system === IMPORT_SYSTEM);
  const staleDrafts = await db.collection("sales_drafts").find({ workspaceId: WORKSPACE_ID, "externalRef.system": IMPORT_SYSTEM, status: { $in: OPEN_DRAFT } }, { projection: { _id: 1, leadId: 1, subject: 1, status: 1 } }).toArray();
  const unjudged = imported.filter((lead) => !lead.verdict && (lead.stage === "researched" || lead.fitBand || /review the draft/i.test(String(lead.nextAction ?? ""))));
  const openDraftLeads = new Set((await db.collection("sales_drafts").find({ workspaceId: WORKSPACE_ID, status: { $in: OPEN_DRAFT }, "externalRef.system": { $ne: IMPORT_SYSTEM } }, { projection: { leadId: 1 } }).toArray()).map((row) => String(row.leadId)));
  const staleNext = imported.filter((lead) => lead.verdict && /review the draft/i.test(String(lead.nextAction ?? "")) && !openDraftLeads.has(lead._id));
  const park = imported.filter((lead) => !keepImported(lead));
  const keep = imported.filter((lead) => keepImported(lead));
  const tally = (rows: Lead[], key: (lead: Lead) => string) => Object.entries(rows.reduce<Record<string, number>>((all, lead) => { const k = key(lead) || "(none)"; all[k] = (all[k] ?? 0) + 1; return all; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(", ");

  console.log(`\n--old-import: ${live.length} live leads, ${imported.length} imported from the old Dealflow.`);
  console.log(`  1. discard ${staleDrafts.length} unsent old-engine drafts (${tally(staleDrafts as unknown as Lead[], (row) => String(row.status))})`);
  console.log(`  2. un-mark ${unjudged.length} leads that look researched without a verdict (stage ${tally(unjudged, (lead) => String(lead.stage))})`);
  console.log(`  2b. clear ${staleNext.length} "review the draft" next steps whose draft is gone (${staleNext.map((lead) => lead.companyName).slice(0, 5).join(", ")})`);
  console.log(`  3. park ${park.length}: out of region ${park.filter((lead) => !inRegion(lead)).length}, no website ${park.filter((lead) => !String(lead.website ?? "").trim()).length}, other trade ${park.filter((lead) => !fitsTrade(lead)).length}, directory or article page ${park.filter(isListing).length}, big brand ${park.filter(isBigBrand).length} (a lead can have several reasons)`);
  console.log(`  keep ${keep.length} to research: by state ${tally(keep, (lead) => String(lead.region ?? ""))}`);
  console.log(`    by city ${tally(keep, (lead) => String(lead.city ?? ""))}`);
  console.log(`    by trade ${tally(keep, (lead) => String(lead.category ?? ""))}`);
  if (dry) return;

  const draftIds = staleDrafts.map((row) => row._id);
  const discarded = (await db.collection("sales_drafts").updateMany({ _id: { $in: draftIds }, status: { $in: OPEN_DRAFT } }, { $set: { status: "discarded", discardedAt: now, discardedReason: "Old import: written by the old engine before any research. Rewrite after a verdict.", updatedAt: now } })).modifiedCount;

  const unjudgedIds = unjudged.map((lead) => lead._id);
  const reset = (await leads.updateMany({ _id: { $in: unjudgedIds }, deletedAt: null, verdict: null }, [{ $set: { stage: { $cond: [{ $eq: ["$stage", "researched"] }, "identified", "$stage"] }, evidenceConfidence: "low", updatedAt: now } }, { $unset: ["fitBand", "nextAction", "nextActionAt"] }])).modifiedCount;

  const staleIds = staleNext.map((lead) => lead._id);
  const cleared = (await leads.updateMany({ _id: { $in: staleIds }, deletedAt: null }, { $unset: { nextAction: "", nextActionAt: "" }, $set: { updatedAt: now } })).modifiedCount;
  await db.collection("reminders").updateMany({ workspaceId: WORKSPACE_ID, leadId: { $in: staleIds }, state: "scheduled" }, { $set: { state: "cancelled", cancelReason: "cleared", updatedAt: now } });

  const parkIds = park.map((lead) => lead._id);
  await db.collection("reminders").updateMany({ workspaceId: WORKSPACE_ID, leadId: { $in: parkIds }, state: "scheduled" }, { $set: { state: "cancelled", cancelReason: "lead_closed", updatedAt: now } });
  await db.collection("sales_drafts").updateMany({ workspaceId: WORKSPACE_ID, leadId: { $in: parkIds }, status: { $in: OPEN_DRAFT } }, { $set: { status: "discarded", discardedAt: now, discardedReason: "The lead was parked (old import outside the target)", updatedAt: now } });
  const parked = (await leads.updateMany({ _id: { $in: parkIds }, deletedAt: null }, { $addToSet: { tags: PARKED_TAG }, $set: { deletedAt: now, deletedBy: actor, updatedAt: now } })).modifiedCount;

  await audit(db, actor, "sales.cleanup.old_import", { draftsDiscarded: discarded, leadsReset: reset, nextStepsCleared: cleared, leadsParked: parked, leadsKept: keep.length });
  console.log(`  done: ${discarded} drafts discarded, ${reset} leads reset, ${cleared} stale next steps cleared, ${parked} leads parked, ${keep.length} kept.`);
}

async function restoreParked(db: Db, dry: boolean, actor: string) {
  const filter = { workspaceId: WORKSPACE_ID, tags: PARKED_TAG, deletedAt: { $ne: null } };
  const count = await db.collection("opportunities").countDocuments(filter);
  console.log(`\n--restore-parked: ${count} parked leads to bring back.`);
  if (dry || !count) return;
  const result = await db.collection("opportunities").updateMany(filter, { $unset: { deletedAt: "", deletedBy: "" }, $pull: { tags: PARKED_TAG } as Document, $set: { updatedAt: new Date() } });
  await audit(db, actor, "sales.cleanup.restore_parked", { restored: result.modifiedCount });
  console.log(`  restored ${result.modifiedCount}.`);
}

async function main() {
  const { values } = parseArgs({ options: { qa: { type: "boolean", default: false }, "old-import": { type: "boolean", default: false }, "restore-parked": { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, actor: { type: "string", default: "user-divyansh" }, "backup-dir": { type: "string" }, "no-backup": { type: "boolean", default: false }, "allow-db": { type: "string" }, "allow-host": { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help || !(values.qa || values["old-import"] || values["restore-parked"])) { console.log("Usage: clean-sales-dev.ts [--qa] [--old-import] [--restore-parked] [--dry-run] [--actor user-id] [--backup-dir dir] [--no-backup] [--allow-db name] [--allow-host]"); return; }
  const { dbName, uri } = guard(values);
  const dry = values["dry-run"]!;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  try {
    const db = client.db(dbName);
    console.log(`Database ${dbName}${dry ? " (dry run: nothing is written)" : ""}`);
    if (!dry && !values["no-backup"]) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await backup(db, ["opportunities", "sales_drafts", "sales_activities", "sales_verdicts", "sales_find_runs", "sales_send_counters", "reminders", "notifications", "notification_outbox"], values["backup-dir"] ?? path.join(os.homedir(), "Documents", "Dealflow Data", "vso-dev-backups", stamp));
    }
    if (values["restore-parked"]) await restoreParked(db, dry, values.actor!);
    if (values.qa) await purgeQa(db, dry, values.actor!);
    if (values["old-import"]) await cleanOldImport(db, dry, values.actor!);
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
