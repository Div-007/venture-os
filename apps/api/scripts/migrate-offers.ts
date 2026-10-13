// Moves each venture's sales brain into offers (docs/sales-offers.md, "Migration"). Same guards as clean-sales-dev.ts: APP_MODE is not
// production, the MongoDB host is local (or --allow-host), the database name ends with "_dev" (or --allow-db names it), and never one of
// the databases in NEVER_WRITE. A run that writes first saves the collections it touches as EJSON under
// ~/Documents/Dealflow Data/vso-dev-backups/<time>/. No network calls. Safe to run twice: what is done already is left as it is.
// Run from the repo root:
//   node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/scripts/migrate-offers.ts --dry-run
//
// For each venture with approved brain items of the legacy kinds (offer, target_profile, message_rules) it creates one offer:
//   - named after the approved offer item (the name of the venture's v2 packet when it has one: Buildory's is "Dealer Commerce");
//   - v1, approved, mapped mechanically from the approved items, keeping their approval (who approved, the latest approval time):
//       the offer item          -> summary (its opening lines), say.* (value proposition, pitch angles, proof, approved claims, claims to
//                                  avoid), its exclusions, and the price boundary;
//       the batch-1 profile     -> whoFor (its opening as the description; industries, customer types, places, sizes, buyer roles), the
//                                  gates (each "(Gn)" exclusion, worded as the rubric states the gate), signals.lookFor (its positive
//                                  signals), signals.negatives (its keyword exclusions) and its other exclusions, plus its price boundary;
//       the message rules       -> messages (the whole text, without its source date and owner);
//       the rubric note         -> scoring (the model, buckets, score, row discipline and verdicts, and its claims to avoid);
//       the other profiles      -> notes, after the batch-1 profile's and the rubric's own notes, trimmed to fit.
//     A research draft's status line ("RESEARCH DRAFT dated ...", "Not approved.") is dropped: the items were approved since.
//   - v2, a draft proposed by Claude, from offer-packets/<file>.json when the venture has one (V2_PACKETS);
//   - the approved legacy items and the rubric note are archived with replacedBy = the v1 id; the venture's DRAFT proposals of the legacy
//     kinds and its drafted rubric proposal are discarded (archived), because v2 carries them. Other draft notes stay;
//   - every lead of the venture (deleted ones too), and every verdict, play and find run without an offer, gets the offer's id.
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BSON, MongoClient, type Db, type Document } from "mongodb";
import { offerPacketSchema, type OfferPacket } from "@venture-studio/contracts";

const NEVER_WRITE = new Set(["admin", "config", "local", "laxmi_agro", "library_flow_dev"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LEGACY_KINDS = ["offer", "target_profile", "message_rules"];
const PACKETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "offer-packets");
/** v2 drafts by venture: a packet Claude wrote for the owner to approve, settling the venture's draft proposals. */
export const V2_PACKETS: Record<string, string> = { "venture-buildory": "buildory-dealer-commerce-v2.json" };
/** The collections a run changes, all saved before a run that writes (it also adds one audit event per venture). */
export const TOUCHED = ["sales_offers", "sales_offer_versions", "sales_brain_items", "opportunities", "sales_verdicts", "sales_plays", "sales_find_runs"];
const LINKED = ["opportunities", "sales_verdicts", "sales_plays", "sales_find_runs"] as const;
/** Marks the offer this script made, so a second run finds it instead of making another. */
const MIGRATED = "brain";

// ---- Reading the brain items' Markdown ------------------------------------------------------------------------------------

type Doc = Document & { _id: string };
type Parsed = { intro: string; sections: Map<string, string> };

/** An item's text before its first "## " heading, and each section's text by its heading (lower case). */
export function parseBody(body: unknown): Parsed {
  const sections = new Map<string, string>();
  const intro: string[] = [];
  let name: string | undefined;
  let lines = intro;
  const close = () => { if (name !== undefined) sections.set(name, lines.join("\n").trim()); };
  for (const line of String(body ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { close(); name = heading[1]!.trim().toLowerCase(); lines = []; } else lines.push(line);
  }
  close();
  return { intro: intro.join("\n").trim(), sections };
}
const section = (item: Parsed | undefined, name: string) => item?.sections.get(name) ?? "";
/** A section's "- " items; a section written as a paragraph is one item. */
function items(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, "").trim());
  return bullets.length ? bullets : (text.trim() ? [text.trim().replace(/\s+/g, " ")] : []);
}
/** Text cut to `max` characters at a word, with an ellipsis. */
export function cut(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}
const list = (values: string[], itemMax: number, count: number) => [...new Set(values.map((value) => cut(value, itemMax)).filter(Boolean))].slice(0, count);
/** A research draft's status line ("RESEARCH DRAFT dated ...", "Not approved.") goes: the item was approved since. */
export const withoutDraftStatus = (text: string) => text.replace(/^\s*RESEARCH DRAFT\b[^.]*\.\s*/, "").replace(/(^|\s)Not approved\.(?=\s|$)/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
/** The sentences of `text` that fit in `max` characters (at least the first one, cut). */
function sentences(text: string, max: number): string {
  const all = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [];
  let out = "";
  for (const sentence of all) { if ((out + sentence).trim().length > max) break; out += sentence; }
  return cut(out.trim() || text, max);
}
/** An item's sections (some left out) as "Heading: a; b; c" lines. */
function sectionLines(item: Parsed, leave: string[]): string {
  return [...item.sections.entries()].filter(([name, text]) => text && !leave.includes(name)).map(([name, text]) => `${name[0]!.toUpperCase()}${name.slice(1)}: ${items(text).join("; ")}`).join("\n");
}

// ---- The v1 packet --------------------------------------------------------------------------------------------------------

type Source = { offer?: Doc; profile?: Doc; otherProfiles: Doc[]; messageRules: Doc[]; rubric?: Doc };
const GATE_TAG = /\((G\d{1,2})\b[^)]*\)/;
const isKeyword = (text: string) => !GATE_TAG.test(text) && !/[.:;]/.test(text) && text.length <= 60 && text.split(/\s+/).length <= 4;

/** The gates as the rubric words them: "G1 address in ..." in its GATES paragraph, by code. */
function rubricGates(rubric: Parsed | undefined): Map<string, string> {
  const paragraph = (rubric?.intro ?? "").split(/\n\s*\n/).map((text) => text.trim()).find((text) => /^GATES\b/.test(text));
  if (!paragraph) return new Map();
  const body = paragraph.slice(paragraph.indexOf(":") + 1).replace(/\s+/g, " ").trim();
  return new Map(body.split(/\s(?=G\d{1,2}\s)/).flatMap((piece) => {
    const found = /^(G\d{1,2})\s+([\s\S]+)$/.exec(piece.trim());
    return found ? [[found[1]!, `${found[2]![0]!.toUpperCase()}${found[2]!.slice(1)}`.trim()] as [string, string]] : [];
  }));
}

/** Maps the approved items to a packet, field by field, as the header says. Throws when the result is not a valid packet. */
export function v1Packet(source: Source): OfferPacket {
  const offer = source.offer ? parseBody(source.offer.body) : undefined;
  const profile = source.profile ? parseBody(source.profile.body) : undefined;
  const rubric = source.rubric ? parseBody(source.rubric.body) : undefined;
  const exclusions = items(section(profile, "exclusions"));
  const worded = rubricGates(rubric);
  const gates = exclusions.flatMap((text) => {
    const code = GATE_TAG.exec(text)?.[1];
    if (!code) return [];
    // "(G4); an unclear case..." and "(G9; buckets B and C ...)": only the code goes, the rest of the sentence stays.
    const failing = text.replace(/\(G\d{1,2}\)/, "").replace(/\(G\d{1,2};\s*/, "(").replace(/\s+([.;:,])/g, "$1").replace(/\s+/g, " ").trim();
    return [{ code, rule: cut(worded.get(code) ?? failing, 500), ifFails: "reject" as const, note: cut(`Fails when: ${failing}`, 500) }];
  }).sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)));
  const price = [...new Set([section(offer, "price boundary"), section(profile, "price boundary")].map((text) => items(text).join(" ")).filter(Boolean))].join("\n\n");
  const scoring = rubric ? [
    ...rubric.intro.split(/\n\s*\n/).map((text) => text.trim()).filter((text, index) => index > 0 && text && !/^GATES\b/.test(text)),
    ...(section(rubric, "claims to avoid") ? [`Claims to avoid in research: ${items(section(rubric, "claims to avoid")).join(" ")}`] : []),
  ].join("\n\n") : "";
  const messages = source.messageRules.map((item) => {
    const parsed = parseBody(item.body);
    const rest = [...parsed.sections.entries()].filter(([name, text]) => text && !["source date", "owner"].includes(name)).map(([name, text]) => `## ${name[0]!.toUpperCase()}${name.slice(1)}\n${text}`);
    return [withoutDraftStatus(parsed.intro), ...rest].filter(Boolean).join("\n\n");
  }).join("\n\n");
  // Notes: the batch-1 profile's and the rubric's own notes first, then each other profile, sharing what is left.
  const NOTES_MAX = 6_000;
  const fixed = [
    section(profile, "notes") && `From the target profile "${String(source.profile?.title)}": ${items(section(profile, "notes")).join(" ")}`,
    section(rubric, "notes") && `From the rubric "${String(source.rubric?.title)}": ${items(section(rubric, "notes")).join(" ")}`,
  ].filter(Boolean).map((text) => cut(text as string, 1_200));
  const left = NOTES_MAX - fixed.join("\n\n").length - 2 * (source.otherProfiles.length + 1);
  const share = source.otherProfiles.length ? Math.max(200, Math.floor(left / source.otherProfiles.length)) : 0;
  const others = source.otherProfiles.map((item) => {
    const parsed = parseBody(item.body);
    return cut(`### ${String(item.title)}\n${[withoutDraftStatus(parsed.intro), sectionLines(parsed, ["source date", "source url", "owner"])].filter(Boolean).join("\n")}`, share);
  });
  const packet = {
    summary: sentences(withoutDraftStatus(offer?.intro || profile?.intro || String(source.offer?.title ?? source.profile?.title ?? "")), 300),
    whoFor: {
      description: cut(withoutDraftStatus(profile?.intro ?? ""), 3_000),
      industries: list(items(section(profile, "target industries")), 120, 40), customerTypes: list(items(section(profile, "target customer types")), 120, 20),
      places: list(items(section(profile, "locations")), 120, 60), companySizes: list(items(section(profile, "company sizes")), 300, 20), buyerRoles: list(items(section(profile, "buyer roles")), 300, 20),
    },
    gates,
    signals: {
      lookFor: list(items(section(profile, "positive signals")), 80, 40).map((phrase) => ({ phrase, meaning: "A positive signal of the target profile: a reason to ask, never proof of a problem." })),
      searchWords: [], negatives: list(exclusions.filter(isKeyword), 60, 10),
    },
    exclusions: list([...exclusions.filter((text) => !GATE_TAG.test(text) && !isKeyword(text)), ...items(section(offer, "exclusions"))], 500, 30),
    say: {
      valueProposition: cut(section(offer, "value proposition"), 3_000), pitchAngles: list(items(section(offer, "pitch angles")), 600, 20), proofWords: cut(items(section(offer, "proof")).join(" "), 500),
      approvedClaims: list(items(section(offer, "approved claims")), 500, 20), claimsToAvoid: list(items(section(offer, "claims to avoid")), 500, 30),
    },
    messages: cut(messages, 12_000), price: cut(price, 2_000), scoring: cut(scoring, 3_000), notes: cut([...fixed, ...others].join("\n\n"), NOTES_MAX),
  };
  return offerPacketSchema.parse(packet);
}

/** The batch-1 profile: titled "batch-1", else the profile tagging the most gates, else the latest approved. */
function pickProfile(profiles: Doc[]): Doc | undefined {
  const tags = (item: Doc) => (String(item.body ?? "").match(/\(G\d{1,2}\b/g) ?? []).length;
  return profiles.find((item) => /batch[- ]?1\b/i.test(String(item.title))) ?? [...profiles].sort((a, b) => tags(b) - tags(a) || +new Date(b.approvedAt ?? 0) - +new Date(a.approvedAt ?? 0))[0];
}
const isRubric = (item: Doc) => item.kind === "notes" && /\brubric\b/i.test(String(item.title));
/** "Dealer Commerce Implementation — Agricultural Equipment & Irrigation" names the offer "Dealer Commerce Implementation". */
const offerNameOf = (title: string) => cut(title.split(/\s[—–-]\s/)[0]!.trim() || title, 120);

// ---- The migration --------------------------------------------------------------------------------------------------------

export type VentureReport = {
  ventureId: string; workspaceId: string; offerId?: string; offerName: string; offer: "created" | "exists" | "skipped"; skipped?: string;
  v1?: { items: string[]; gates: number; signals: number; negatives: number; exclusions: number; industries: number; places: number }; v2?: "created" | "exists" | "none";
  archived: string[]; discarded: string[]; linked: Record<string, number>;
};
export type MigrationOptions = { dryRun: boolean; actor: string; now?: Date; ventureId?: string; packetsDir?: string };

const loadV2 = (ventureId: string, dir: string) => {
  const file = V2_PACKETS[ventureId];
  if (!file || !existsSync(path.join(dir, file))) return undefined;
  const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { name: string; change?: string; packet: unknown };
  return { file, name: cut(String(raw.name), 120), change: cut(String(raw.change ?? ""), 1_000), packet: offerPacketSchema.parse(raw.packet) };
};

/** Runs the migration on `db` (nothing is written with dryRun) and says, per venture, what it did or would do. */
export async function migrateOffers(db: Db, options: MigrationOptions): Promise<VentureReport[]> {
  const now = options.now ?? new Date();
  const dir = options.packetsDir ?? PACKETS_DIR;
  const brain = db.collection<Doc>("sales_brain_items");
  const offers = db.collection<Doc>("sales_offers");
  const versions = db.collection<Doc>("sales_offer_versions");
  const only = options.ventureId ? { ventureId: options.ventureId } : {};
  const ventureIds = [...new Set([
    ...(await brain.distinct("ventureId", { ...only, kind: { $in: LEGACY_KINDS }, status: "approved" })),
    ...(await offers.distinct("ventureId", { ...only, migratedFrom: MIGRATED })),
  ].map(String))].sort();
  const reports: VentureReport[] = [];
  for (const ventureId of ventureIds) {
    const approved = await brain.find({ ventureId, status: "approved", $or: [{ kind: { $in: LEGACY_KINDS } }, { kind: "notes" }] }).sort({ approvedAt: 1, _id: 1 }).toArray();
    const legacy = approved.filter((item) => LEGACY_KINDS.includes(String(item.kind)));
    const rubric = approved.find(isRubric);
    const existing = await offers.findOne({ ventureId, migratedFrom: MIGRATED });
    const workspaceId = String(existing?.workspaceId ?? legacy[0]?.workspaceId ?? "");
    const v2 = loadV2(ventureId, dir);
    const offerItem = legacy.filter((item) => item.kind === "offer").at(-1);
    const offerName = String(existing?.name ?? v2?.name ?? offerNameOf(String(offerItem?.title ?? legacy[0]?.title ?? "Main offer")));
    const report: VentureReport = { ventureId, workspaceId, offerName, offer: existing ? "exists" : "created", archived: [], discarded: [], linked: {} };
    reports.push(report);
    // An offer of that name made in the app before this ran is never overwritten: the person links it by hand.
    const clash = existing ? null : await offers.findOne({ workspaceId, ventureId, name: offerName }, { collation: { locale: "en", strength: 2 } });
    if (clash) { report.offer = "skipped"; report.skipped = `an offer called "${String(clash.name)}" already exists in this venture (made in the app): nothing was changed`; continue; }

    const offerId = existing ? String(existing._id) : randomUUID();
    report.offerId = offerId;
    let v1Id = existing?.approvedVersionId ? String(existing.approvedVersionId) : (await versions.findOne({ offerId, version: 1 }))?._id;
    if (!existing) {
      const profiles = legacy.filter((item) => item.kind === "target_profile");
      const profile = pickProfile(profiles);
      const source: Source = { offer: offerItem, profile, otherProfiles: profiles.filter((item) => item !== profile), messageRules: legacy.filter((item) => item.kind === "message_rules"), rubric };
      const packet = v1Packet(source);
      const from = [...legacy, ...(rubric ? [rubric] : [])];
      const approvedAt = from.map((item) => item.approvedAt).filter((at): at is Date => at instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? now;
      report.v1 = { items: from.map((item) => `${String(item.kind)}: ${String(item.title)}`), gates: packet.gates.length, signals: packet.signals.lookFor.length, negatives: packet.signals.negatives.length, exclusions: packet.exclusions.length, industries: packet.whoFor.industries.length, places: packet.whoFor.places.length };
      v1Id = randomUUID();
      if (!options.dryRun) {
        await offers.insertOne({ _id: offerId, workspaceId, ventureId, name: offerName, state: "active", approvedVersionId: v1Id, createdBy: options.actor, createdVia: "import", migratedFrom: MIGRATED, createdAt: now, updatedAt: now });
        await versions.insertOne({
          _id: v1Id, offerId, workspaceId, ventureId, version: 1, status: "approved", name: offerName, packet,
          change: cut(`Moved from the approved sales brain (${from.length} items: ${from.map((item) => String(item.title)).join("; ")}). Mapped mechanically; research-draft status lines dropped, since the items were approved.`, 1_000),
          proposedBy: String(offerItem?.proposedBy ?? options.actor), via: "import", approvedBy: String(offerItem?.approvedBy ?? legacy[0]?.approvedBy ?? options.actor), approvedAt, migratedFrom: from.map((item) => item._id), createdAt: now, updatedAt: now,
        });
      }
    }
    if (v2) {
      const has = await versions.findOne({ offerId, version: 2 });
      report.v2 = has ? "exists" : "created";
      if (!has && !options.dryRun) await versions.insertOne({ _id: randomUUID(), offerId, workspaceId, ventureId, version: 2, status: "draft", name: v2.name, packet: v2.packet, change: v2.change, proposedBy: options.actor, via: "claude", source: v2.file, createdAt: now, updatedAt: now });
    } else report.v2 = "none";

    // The approved legacy items and the rubric note are replaced by v1; the draft proposals v2 carries are discarded.
    const retire = [...legacy, ...(rubric ? [rubric] : [])];
    report.archived = retire.map((item) => `${String(item.kind)}: ${String(item.title)}`);
    const drafts = v2 ? await brain.find({ ventureId, status: "draft", $or: [{ kind: { $in: LEGACY_KINDS } }, { kind: "notes", title: /\brubric\b/i }] }).toArray() : [];
    report.discarded = drafts.map((item) => `${String(item.kind)}: ${String(item.title)}`);
    if (!options.dryRun) {
      if (retire.length) await brain.updateMany({ _id: { $in: retire.map((item) => item._id) }, status: "approved" }, { $set: { status: "archived", archivedAt: now, archivedBy: options.actor, replacedBy: v1Id, replacedByOffer: offerId, updatedAt: now } });
      if (drafts.length) await brain.updateMany({ _id: { $in: drafts.map((item) => item._id) }, status: "draft" }, { $set: { status: "archived", archivedAt: now, archivedBy: options.actor, archivedReason: `Carried by the draft version 2 of the offer "${offerName}"`, replacedByOffer: offerId, updatedAt: now } });
    }
    // Every lead (deleted ones too), verdict, play and find run of the venture without an offer gets this one.
    for (const name of LINKED) {
      const filter = { workspaceId, ventureId, offerId: null };
      report.linked[name] = await db.collection(name).countDocuments(filter);
      if (name === "opportunities") report.linked.deletedLeads = await db.collection(name).countDocuments({ ...filter, deletedAt: { $ne: null } });
      if (!options.dryRun && report.linked[name]) await db.collection(name).updateMany(filter, { $set: { offerId } });
    }
    if (!options.dryRun) {
      await db.collection<Doc>("audit_events").insertOne({ _id: randomUUID(), workspaceId, actorId: options.actor, channel: "api", action: "sales.offer.migrate", objectType: "offer", objectId: offerId, ventureId, result: "success",
        metadata: { offer: report.offer, v2: report.v2 ?? "none", archived: report.archived.length, discarded: report.discarded.length, leads: report.linked.opportunities ?? 0, verdicts: report.linked.sales_verdicts ?? 0, plays: report.linked.sales_plays ?? 0, findRuns: report.linked.sales_find_runs ?? 0 }, occurredAt: now });
    }
  }
  return reports;
}

/** The run's report in plain lines. */
export function describe(reports: VentureReport[], dryRun: boolean): string {
  if (!reports.length) return "Nothing to migrate: no venture has approved offer, target profile or message rules items, and no migrated offer to finish.";
  const verb = (done: string, will: string) => (dryRun ? will : done);
  return reports.map((report) => {
    if (report.skipped) return `${report.ventureId}: skipped, ${report.skipped}.`;
    const lines = [`${report.ventureId}: offer "${report.offerName}" ${report.offer === "exists" ? "exists already" : verb("created", "would be created")} (${report.offerId})`];
    if (report.v1) {
      lines.push(`  v1, approved, ${verb("mapped", "would be mapped")} from ${report.v1.items.length} items: ${report.v1.gates} gates, ${report.v1.signals} look-for signals, ${report.v1.negatives} negatives, ${report.v1.exclusions} exclusions, ${report.v1.industries} industries, ${report.v1.places} places`);
      for (const item of report.v1.items) lines.push(`    - ${item}`);
    }
    lines.push(`  v2, draft by Claude: ${report.v2 === "created" ? verb("created", "would be created") : report.v2 === "exists" ? "exists already" : "no packet file for this venture"}`);
    lines.push(`  archived with replacedBy v1: ${report.archived.length ? "" : "none (already done)"}`);
    for (const item of report.archived) lines.push(`    - ${item}`);
    lines.push(`  draft proposals discarded: ${report.discarded.length ? "" : "none"}`);
    for (const item of report.discarded) lines.push(`    - ${item}`);
    const linked = report.linked;
    lines.push(`  ${verb("linked", "to link")} to the offer: ${linked.opportunities ?? 0} leads (${linked.deletedLeads ?? 0} of them deleted), ${linked.sales_verdicts ?? 0} verdicts, ${linked.sales_plays ?? 0} plays, ${linked.sales_find_runs ?? 0} find runs`);
    return lines.join("\n");
  }).join("\n");
}

/** The hosts of a mongodb:// connection string (as import-dealflow.ts reads them; kept here so this script loads nothing else). */
function mongoHosts(uri: string): string[] {
  const match = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(uri.trim());
  if (!match) throw new Error("MONGODB_URI is not a mongodb:// connection string.");
  if (match[1]) return ["(mongodb+srv cluster)"];
  return match[2]!.split(",").map((part) => { const host = part.trim().toLowerCase(); const bracket = /^\[(.*)\](?::\d+)?$/.exec(host); return bracket ? bracket[1]! : host.replace(/:\d+$/, ""); });
}

function guard(values: { "allow-db"?: string | undefined; "allow-host"?: boolean | undefined }) {
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
  for (const name of names) writeFileSync(path.join(dir, `${name}.json`), BSON.EJSON.stringify(await db.collection(name).find({}).toArray(), undefined, 0, { relaxed: false }));
  console.log(`  backup: ${names.length} collections saved to ${dir}`);
}

async function main() {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, venture: { type: "string" }, actor: { type: "string", default: "user-divyansh" }, "backup-dir": { type: "string" }, "no-backup": { type: "boolean", default: false }, "allow-db": { type: "string" }, "allow-host": { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help) { console.log("Usage: migrate-offers.ts [--dry-run] [--venture venture-id] [--actor user-id] [--backup-dir dir] [--no-backup] [--allow-db name] [--allow-host]"); return; }
  const { dbName, uri } = guard(values);
  const dryRun = values["dry-run"]!;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  try {
    const db = client.db(dbName);
    console.log(`Database ${dbName}${dryRun ? " (dry run: nothing is written)" : ""}`);
    if (!dryRun && !values["no-backup"]) await backup(db, TOUCHED, values["backup-dir"] ?? path.join(os.homedir(), "Documents", "Dealflow Data", "vso-dev-backups", new Date().toISOString().replace(/[:.]/g, "-")));
    console.log(describe(await migrateOffers(db, { dryRun, actor: values.actor!, ...(values.venture ? { ventureId: values.venture } : {}) }), dryRun));
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
