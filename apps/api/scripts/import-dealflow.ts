// Imports the owner's Dealflow sales data (local SQLite, opened read-only) into the Venture OS dev database so the Sales
// screens can be built and tested on real data. Spec: docs/sales-dealflow.md. Contracts: packages/contracts/src/sales.ts.
// Run from the repo root (see scripts/README-import-dealflow.md):
//   node --env-file=.env node_modules/tsx/dist/cli.mjs apps/api/scripts/import-dealflow.ts --dry-run
//
// Safe by design: the SQLite file is only read; the only database written is the one named by MONGODB_DB, and only when
// APP_MODE is not production, the MongoDB host is local (or --allow-host is passed) and the name ends with "_dev" (or is
// passed to --allow-db). Ids are deterministic and every write is an upsert, so running it twice changes nothing. No network
// calls; nothing is sent to anyone.
//
// --refresh touches only these descriptive fields of leads, and only on leads nobody has edited since the import:
//   companyName, city, region, country, category, website, contactRoutes, observedSignal, tags (+ the derived suppressKeys).
// It never rewrites stage, owner, nextAction/nextActionAt, whatsappOptIn, verdict, needsYou, fitBand or any other lead field,
// and it never updates activities, verdicts, brain items or suppression rows (insert-only). One exception, for safety: a lead whose
// recomputed match keys hit the do-not-contact list is flagged doNotContact (one way: never cleared here), and its unsent drafts are
// discarded and its next-action reminders cancelled, exactly as the app does when it flags a lead.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { MongoClient, type AnyBulkWriteOperation, type Db } from "mongodb";
// The API's own helpers, so keys here match what the app computes (never a copy).
import { leadSuppressKeys, normalizeEmail, normalizePhone, normalizeValue, suppressionKey } from "../src/sales/suppression.js";
import { AppDb } from "../src/db.js";
import { flagImportedDoNotContact } from "../src/sales/leads.js";

const SYSTEM = "dealflow-sqlite";
const WORKSPACE_ID = "workspace-studio";
const DEFAULT_SQLITE = path.join(homedir(), "Documents", "Dealflow Data", "dealflow.sqlite3");
const DEFAULT_URI = "mongodb://127.0.0.1:27017/?directConnection=true";
/** Databases of other projects on the same local server, and server internals: never written, whatever the flags say. */
const NEVER_WRITE = new Set(["admin", "config", "local", "laxmi_agro", "library_flow_dev"]);

/** Legacy Dealflow stage -> SLS-01 stage (same mapping as Prospector/tooling/export_to_supabase.py). */
const STAGE_MAP: Record<string, string> = { new: "identified", shortlisted: "researched", contacted: "contacted", replied: "replied", meeting: "discovery_booked", won: "invoice_contract", lost: "lost", rejected: "disqualified" };
const WON_STAGES = new Set(["invoice_contract", "cash_collected", "delivery", "retained_referred"]);
const EXIT_STAGES = new Set(["lost", "disqualified"]);
const PRE_CONTACT = new Set(["identified", "researched", "approved_for_contact"]);
/** SQLite venture name -> Venture OS ids. Anything else is skipped and reported. */
const VENTURES: { match: RegExp; slug: string; ventureId: string; pipelineId: string; pipeline?: { name: string; offerName: string } }[] = [
  { match: /^buildory/i, slug: "buildory", ventureId: "venture-buildory", pipelineId: "pipeline-buildory" },
  { match: /^edithood/i, slug: "edithood", ventureId: "venture-edithood", pipelineId: "pipeline-edithood", pipeline: { name: "EditHood opportunities", offerName: "Video editing" } },
];
const INDIAN_STATES = new Set(["andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana", "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu", "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal", "delhi", "jammu and kashmir", "ladakh", "chandigarh", "puducherry", "andaman and nicobar islands", "dadra and nagar haveli and daman and diu", "lakshadweep"]);

type Doc = Record<string, any>;
type Row = Record<string, any>;
const clip = (value: unknown, max: number): string => String(value ?? "").trim().slice(0, max);
const date = (value: unknown): Date => { const parsed = new Date(String(value ?? "")); return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed; };
const safeId = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, "-");
const sha = (value: string): string => createHash("sha1").update(value).digest("hex").slice(0, 24);
const json = <T>(value: unknown, fallback: T): T => { try { return value ? (JSON.parse(String(value)) as T) : fallback; } catch { return fallback; } };
const validUrl = (value: unknown): string | undefined => { try { const url = String(value ?? "").trim(); if (!url || url.length > 2000) return undefined; new URL(url); return url; } catch { return undefined; } };

// ---------------------------------------------------------------------------------------------------------- parsers
// Claude's notes in SQLite follow the formats in Prospector .claude/skills/dealflow-sales/reference/formats.md.

const QUOTE_URL = /"([^"]{3,1000})"\s*\(\s*(https?:\/\/[^\s),]+)/g;
const toInt = (value: string): number | undefined => { const number = Number.parseInt(value, 10); return Number.isFinite(number) ? number : undefined; };

function fieldMap(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) { const match = /^([a-z][a-z ./-]{1,40}):\s*(.*)$/i.exec(line); if (match && !fields.has(match[1]!.toLowerCase())) fields.set(match[1]!.toLowerCase(), match[2]!.trim()); }
  return fields;
}
const afterDash = (value: string): string => { const match = /\s[—–-]\s(.+)$/s.exec(value); return match ? match[1]!.trim() : ""; };

function evidenceFrom(label: string, line: string, seenAt?: Date): Doc[] {
  const out: Doc[] = []; QUOTE_URL.lastIndex = 0;
  for (let match = QUOTE_URL.exec(line); match; match = QUOTE_URL.exec(line)) {
    const url = validUrl(match[2]); if (!url) continue;
    out.push({ claim: clip(label, 500) || "Evidence", quote: clip(match[1], 1000), url, ...(seenAt ? { seenAt } : {}) });
  }
  return out;
}

/** Contract score keys from the free-text criteria in a v1 note ("workflow closeness 2, reachability 3 = 12/15"). */
function mapScores(line: string): Doc {
  const scores: Doc = {}; const body = line.split("=")[0] ?? "";
  for (const part of body.split(",")) {
    const match = /^(.+?)\s+([1-3])\s*$/.exec(part.trim()); if (!match) continue;
    const name = match[1]!.toLowerCase(); const value = toInt(match[2]!)!;
    const key = /timing|why now|trigger/.test(name) ? "timing" : /access|reachab/.test(name) ? "access" : /abilit|size|budget|plausib/.test(name) ? "ability" : /need|ordering/.test(name) ? "need" : /\bfit\b|workflow|closeness/.test(name) ? "fit" : undefined;
    if (key && scores[key] === undefined) scores[key] = value;
  }
  return scores;
}

export function parseVerdict(text: string): { doc: Doc; fitHeadline: string } | null {
  if (!text.startsWith("[CLAUDE VERDICT v1]")) return null;
  const fields = fieldMap(text);
  const verdictLine = fields.get("verdict") ?? ""; const decision = /^(recommend|hold|reject)\b/i.exec(verdictLine)?.[1]?.toLowerCase();
  const confidence = /^(high|medium|low)\b/i.exec(fields.get("confidence") ?? "")?.[1]?.toLowerCase();
  if (!decision || !confidence) return null;
  const fitLine = fields.get("fit") ?? ""; const signalLine = fields.get("signal to open with") ?? ""; const againstLine = fields.get("against") ?? "";
  const seenAt = /seen\s+(\d{4}-\d{2}-\d{2})/.exec(signalLine)?.[1]; const signalSeenAt = seenAt ? new Date(`${seenAt}T00:00:00.000Z`) : undefined;
  // Gates: one "- G1 name: pass — note" line each, or an inline "gates: G1-G6 as above; G7 name: pass — note" form.
  const gates: Doc[] = []; const evidence: Doc[] = [];
  const addGate = (name: string, result: string, note: string) => {
    gates.push({ gate: clip(name, 80), result: result === "pass" ? "pass" : result === "fail" ? "fail" : "unknown", note: clip(note, 500) });
    evidence.push(...evidenceFrom(name, note));
  };
  for (const line of text.split(/\r?\n/)) { const match = /^-\s+([^:]{2,80}):\s*(pass|fail|unclear|unknown)\b\s*(?:[—–-]\s*)?(.*)$/i.exec(line); if (match) addGate(match[1]!.trim(), match[2]!.toLowerCase(), match[3]!.trim()); }
  if (!gates.length) for (const match of (fields.get("gates") ?? "").matchAll(/(G\d+[^:;]{0,70}):\s*(pass|fail|unclear|unknown)\b\s*(?:[—–-]\s*)?([^;]*?)(?=;\s*G\d|$)/gi)) addGate(match[1]!.trim(), match[2]!.toLowerCase(), match[3]!.trim());
  evidence.unshift(...evidenceFrom("Fit", fitLine), ...evidenceFrom("Signal to open with", signalLine, signalSeenAt), ...evidenceFrom("Against", againstLine));
  const seen = new Set<string>(); const unique = evidence.filter((item) => { const key = `${item.quote}|${item.url}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 20);
  if (!unique.length) return null; // the contract needs at least one quoted, linked piece of evidence; keep the note as a note instead
  const offerLine = fields.get("venture") ?? ""; const offer = clip(/offer:\s*(.+)$/i.exec(offerLine)?.[1] ?? "", 200) || "Not stated";
  const scoresLine = fields.get("scores") ?? ""; const scores = mapScores(scoresLine);
  const fitSentence = afterDash(fitLine) || fitLine;
  const fitWord = /^(strong|possible|no)\b/i.exec(fitLine)?.[1]?.toLowerCase();
  const fitShort = (fitSentence.split(/:\s*"/)[0] ?? "").trim();
  const summary = clip(afterDash(verdictLine) || (fitWord ? `${fitWord[0]!.toUpperCase()}${fitWord.slice(1)} fit: ${fitShort}` : verdictLine), 500) || decision;
  const keepScoresText = scoresLine && !/pending/i.test(scoresLine);
  const openQuestion = fields.get("open question") ?? "";
  const fitHeadline = fitWord ? `${fitWord[0]!.toUpperCase()}${fitWord.slice(1)} fit: ${fitShort}` : fitSentence;
  const doc = {
    decision, confidence, offer,
    offerFit: clip(`${fitLine || fitSentence}${keepScoresText ? `\nScores in the original note: ${scoresLine}` : ""}`, 2000) || "See evidence.",
    evidence: unique, gates, scores, against: clip(againstLine, 2000) || "Not recorded in the imported note.",
    openQuestion: /^none\.?$/i.test(openQuestion) ? "" : clip(openQuestion, 1000), contactRoute: clip(fields.get("contact route") ?? "", 500),
    signal: clip(signalLine, 1000), ...(signalSeenAt ? { signalSeenAt } : {}), summary,
  };
  return { doc, fitHeadline };
}

export function parseReview(text: string): { draftRef: string; result: "pass" | "fail"; checks: string; fixes: string[] } | null {
  const head = /^\[CLAUDE REVIEW v1\]\s*draft:\s*(.*)$/im.exec(text); if (!head) return null;
  const result = /^result:\s*(pass|fix|fail)\b/im.exec(text)?.[1]?.toLowerCase(); if (!result) return null;
  const checks = /^checks:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? "";
  const fixes = [...text.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((match) => clip(match[1], 300)).filter(Boolean).slice(0, 20);
  return { draftRef: head[1]!.trim(), result: result === "pass" ? "pass" : "fail", checks, fixes };
}

// ------------------------------------------------------------------------------------------------ contact routes
// The CRM keeps contact details out of its fact tables on purpose. Business routes are read only from pages the engine already
// stored from the company's own site (contact, home, locations), never from the network, and each route carries the page URL.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*?\.(?:co\.in|org\.in|net\.in|gov\.in|ac\.in|com\.au|co\.uk|com|net|org|info|biz|industries|solutions|services|agency|studio|digital|media|store|shop|online|site|tech|xyz|app|dev|edu|gov|in|co|io|ai|me|us|uk|ae|au|ca)(?![a-z])/g;
const JUNK_EMAIL = /^(?:example|yourname|your-?email|name|email|username|user|test|abc|xyz)@|@(?:example|domain|email|yourdomain|yourcompany|sentry|wixpress|godaddy|wordpress|test)\.|^(?:no-?reply|do-?not-?reply|donotreply)@|\.(?:png|jpe?g|gif|svg|webp)$/i;
const PHONE_LABEL = /(tel|phone|ph\b|call|mob|mobile|cell|contact|whatsapp|\bwa\b|sales|support|helpline|toll|landline|office|enquir|inquir|customer|reach)\W{0,12}[^\n]{0,24}$/i;
const IN_PHONE = /(?<![\d.])(\+?\(?91\)?[\s.-]?|0)?(\(?[6-9]\d{4}\)?[\s.-]?\d{5}|\(?0?\d{2,4}\)?[\s.-]?\d{6,8})(?!\d)/g;
const INTL_PHONE = /(?<![\d])\+(?!91)(\d{1,3})[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/g;

/** A short generic label from the words just before a number. Free text is never kept: it can hold a person's name. */
const LABELS: [RegExp, string][] = [[/whatsapp/i, "WhatsApp"], [/sales/i, "Sales"], [/service/i, "Service"], [/support/i, "Support"], [/enq|inq/i, "Enquiry"], [/helpline|toll/i, "Helpline"], [/customer/i, "Customer care"], [/office/i, "Office"], [/mobile|\bmob\b|cell/i, "Mobile"]];
function phoneLabel(before: string): string | undefined {
  let best: { at: number; label: string } | undefined;
  for (const [pattern, label] of LABELS) { const hits = [...before.matchAll(new RegExp(pattern.source, "gi"))]; const at = hits.at(-1)?.index; if (at !== undefined && (!best || at > best.at)) best = { at, label }; }
  return best?.label;
}

export function routesFromText(text: string, sourceUrl: string): Doc[] {
  const routes: Doc[] = []; const seen = new Set<string>(); const source = validUrl(sourceUrl);
  const push = (kind: string, value: string, label?: string) => { const key = `${kind}:${value}`; if (seen.has(key)) return; seen.add(key); routes.push({ kind, value, ...(label ? { label: clip(label, 80) } : {}), ...(source ? { sourceUrl: source } : {}), publishedByCompany: true }); };
  for (const match of text.matchAll(EMAIL)) { const email = match[0].toLowerCase().replace(/^[.\-_%+]+/, ""); if (!JUNK_EMAIL.test(email)) push("email", email); }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const match of line.matchAll(IN_PHONE)) {
      const prefix = match[1]; const digits = match[2]!.replace(/\D/g, "");
      const before = line.slice(Math.max(0, (match.index ?? 0) - 42), match.index ?? 0);
      if (/fax\W{0,8}$/i.test(before)) continue;
      const mobile = /^[6-9]\d{9}$/.test(digits); const national = digits.replace(/^0/, "");
      const landline = !mobile && /^[1-9]\d{9}$/.test(national) ;
      if (!mobile && !landline) continue;
      const labelled = PHONE_LABEL.test(before) || /whatsapp/i.test(before);
      const prefixed = Boolean(prefix) || /[\s.-]/.test(match[2]!.trim());
      if (!(labelled || (mobile && prefixed) || (landline && Boolean(prefix)))) continue;
      const label = phoneLabel(before);
      const isWhatsapp = /whatsapp/i.test(before.slice(-30)); // a number written after the word WhatsApp is the WhatsApp number
      push(isWhatsapp && mobile ? "whatsapp" : "phone", `+91${national}`, label);
    }
    for (const match of line.matchAll(INTL_PHONE)) { const digits = match[0].replace(/\D/g, ""); if (digits.length >= 10 && digits.length <= 15 && new Set(digits).size >= 4) push("phone", `+${digits}`); }
  }
  // Emails first (at most 3), then phones/WhatsApp (at most 4).
  return [...routes.filter((r) => r.kind === "email").slice(0, 3), ...routes.filter((r) => r.kind !== "email").slice(0, 4)];
}

// ------------------------------------------------------------------------------------------------ text helpers

function renderBrainBody(content: Row): string {
  const out: string[] = [];
  const title = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  for (const [key, value] of Object.entries(content)) {
    if (key === "demo_only" || value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) continue;
    const text = Array.isArray(value) ? value.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n") : typeof value === "object" ? JSON.stringify(value) : String(value);
    out.push(key === "description" ? text : `## ${title(key)}\n${text}`);
  }
  const body = out.join("\n\n").trim() || "(empty)";
  return body.length > 20_000 ? `${body.slice(0, 19_980)}\n...[truncated]` : body;
}

function brainKind(kind: string, title: string): string {
  if (kind === "offer" || kind === "target_profile") return kind;
  if (kind === "pitch_playbook" && /message rules/i.test(title)) return "message_rules";
  return "notes"; // industry, knowledge and the other playbooks
}

function signalFromFacts(features: Map<string, Row>): string {
  const parts: string[] = []; let evidence = "";
  const dealer = features.get("dealer_network")?.value; const ordering = features.get("ordering_signals")?.value;
  if (dealer?.become_dealer) parts.push('Has a "become a dealer" enquiry page');
  else if (dealer?.present) parts.push("Sells through a dealer network");
  if (dealer?.dealer_locator) parts.push("dealer locator");
  if (dealer?.dealer_count) parts.push(`about ${dealer.dealer_count} dealers`);
  const ordered = ["enquiry_form", "request_quote", "bulk_enquiry", "call_for_price", "whatsapp_order", "pdf_price_list", "online_cart"].filter((key) => ordering?.[key]).map((key) => key.replace(/_/g, " "));
  if (ordered.length) parts.push(`orders via ${ordered.join(", ")}`);
  const quote = features.get("dealer_network")?.evidence?.[0] ?? features.get("ordering_signals")?.evidence?.[0];
  if (quote?.quote && validUrl(quote.url)) evidence = ` "${clip(quote.quote, 200)}" (${quote.url})`;
  return clip(parts.length ? `${parts.join("; ")}.${evidence}` : "", 2000);
}

/** The shortlist note without its workflow chatter ("Draft email saved ...", "Send from ..."), as the lead's reason for fit. */
function fitFromNote(note: string): string {
  return note.split(/(?<=[.!?])\s+/).filter((sentence) => !/^(draft email saved|send from|no new contacts)/i.test(sentence.trim())).join(" ").trim();
}

function engineFitReason(row: Row): string {
  const bits: string[] = [];
  if (row.relevance === "relevant") bits.push("marked relevant by the engine"); else if (row.relevance === "off_topic" || row.relevance === "excluded") bits.push(`engine says ${row.relevance.replace("_", " ")}`);
  const what = [row.business_type, row.segment].filter((v) => v && v !== "unknown").join(" in ");
  if (what) bits.push(what);
  if (row.become_dealer) bits.push("has a become-a-dealer page"); else if (row.dealer_network) bits.push("sells through a dealer network");
  if (row.digital_maturity) bits.push(`${row.digital_maturity} digital maturity${row.dealer_login ? " (has a dealer login)" : ""}`);
  if (row.national_brand) bits.push("national brand");
  return clip(bits.length ? `Engine read: ${bits.join("; ")}.` : "", 2000);
}

const draftChannel = (channel: unknown): string => channel === "whatsapp" ? "whatsapp" : channel === "linkedin" ? "linkedin" : channel === "phone" ? "call_opener" : "email";
const activityKind = (channel: unknown): string => channel === "email" ? "email" : channel === "whatsapp" ? "whatsapp" : channel === "linkedin" ? "linkedin" : channel === "phone" ? "call" : channel === "in_person" ? "meeting" : "note";

// ------------------------------------------------------------------------------------------------------- the plan

type Options = { sqlite: string; owner: string; limit?: number; onlyWorked: boolean; includeJunk: boolean };
type Plan = { collections: Record<string, Doc[]>; stats: Record<string, any>; suppressionKeys: Set<string> };

export function buildPlan(source: DatabaseSync, options: Options): Plan {
  const all = (sql: string, ...params: any[]): Row[] => source.prepare(sql).all(...params) as Row[];
  const stats: Record<string, any> = { skipped: {}, verdicts: { parsed: 0, keptAsNotes: 0 }, reviews: { applied: 0, keptAsNotes: 0 } };
  const skip = (reason: string, count = 1) => { stats.skipped[reason] = (stats.skipped[reason] ?? 0) + count; };
  const owner = options.owner;
  const collections: Record<string, Doc[]> = { opportunities: [], sales_activities: [], sales_verdicts: [], sales_drafts: [], sales_brain_items: [], sales_suppression: [], pipelines: [] };

  // Ventures
  const ventures = new Map<string, (typeof VENTURES)[number]>();
  for (const venture of all("select id, name from ventures")) { const target = VENTURES.find((item) => item.match.test(String(venture.name))); if (target) ventures.set(venture.id, target); else skip(`venture "${venture.name}" (no Venture OS counterpart)`); }

  // Leads: worked leads first, then the rest of the index; junk (off-topic / excluded by the engine) only when asked for or already worked.
  const index = all("select * from crm_lead_index order by has_crm_row desc, case when lead_id like 'company_%' then 0 else 1 end, lead_id");
  const crmRows = new Map(all("select * from crm_leads").map((row) => [`${row.venture_id}|${row.company_id}`, row]));
  const seenKeys = new Set<string>(); const chosen: { row: Row; venture: (typeof VENTURES)[number]; crm?: Row }[] = [];
  for (const row of index) {
    const venture = ventures.get(row.venture_id); if (!venture) { skip("lead in a venture without a counterpart"); continue; }
    const worked = Boolean(row.has_crm_row);
    if (options.onlyWorked && !worked) { skip("lead not worked yet (--only-worked)"); continue; }
    if (row.is_junk && !worked && !options.includeJunk) { skip(`junk lead (engine: ${row.relevance_key})`); continue; }
    const key = `${row.venture_id}|${row.domain || `name:${row.name_key || row.lead_id}`}`;
    if (seenKeys.has(key)) { skip("duplicate company (same domain or name)"); continue; }
    seenKeys.add(key);
    chosen.push({ row, venture, crm: crmRows.get(`${row.venture_id}|${row.company_id}`) });
  }
  const limited = options.limit ? chosen.slice(0, options.limit) : chosen;
  stats.leadsSkippedByLimit = chosen.length - limited.length;

  // Lookups for the chosen leads
  const companyIds = new Set(limited.map((item) => item.row.company_id).filter(Boolean));
  const entityIds = limited.filter((item) => String(item.row.lead_id).startsWith("entity:")).map((item) => String(item.row.lead_id).slice(7));
  const entityCreated = new Map(all("select id, created_at from discovery_entities").filter((row) => entityIds.includes(row.id)).map((row) => [row.id, row.created_at]));
  const companyCreated = new Map(all("select id, created_at from companies").map((row) => [row.id, row.created_at]));
  const features = new Map<string, Map<string, Row>>();
  for (const row of all("select company_id, name, value_json, evidence_json from company_features")) {
    if (!companyIds.has(row.company_id)) continue;
    const map = features.get(row.company_id) ?? new Map<string, Row>(); features.set(row.company_id, map);
    map.set(row.name, { value: json<any>(row.value_json, null), evidence: json<any[]>(row.evidence_json, []) });
  }
  const pageText = (row: Row, blobs: Map<string, Buffer | null>): string => { const blob = row.text_z ?? (row.duplicate_of_page_id ? blobs.get(row.duplicate_of_page_id) : null); try { return blob ? zlib.inflateSync(blob).toString("utf8") : ""; } catch { return ""; } };
  const blobs = new Map<string, Buffer | null>(all("select id, text_z from pages where text_z is not null and id in (select duplicate_of_page_id from pages where duplicate_of_page_id is not null and page_kind in ('contact','home','locations'))").map((row) => [row.id, row.text_z]));
  const pages = new Map<string, Row[]>();
  for (const row of all("select company_id, normalized_url, page_kind, text_z, duplicate_of_page_id from pages where page_kind in ('contact','home','locations') order by case page_kind when 'contact' then 0 when 'locations' then 1 else 2 end, normalized_url")) {
    if (!companyIds.has(row.company_id)) continue; (pages.get(row.company_id) ?? pages.set(row.company_id, []).get(row.company_id)!).push(row);
  }

  // Activities by company; split into verdicts, reviews, drafts and plain activities.
  const activitiesByCompany = new Map<string, Row[]>();
  for (const row of all("select * from crm_activities order by occurred_at, id")) (activitiesByCompany.get(`${row.venture_id}|${row.company_id}`) ?? activitiesByCompany.set(`${row.venture_id}|${row.company_id}`, []).get(`${row.venture_id}|${row.company_id}`)!).push(row);

  // Suppression list
  const suppressionKeys = new Set<string>();
  for (const row of all("select * from outbound_suppressions")) {
    const value = normalizeValue("email", clip(row.email_address, 320)); if (!value) { skip("suppression entry that is not a valid email"); continue; }
    const key = suppressionKey("email", value); if (suppressionKeys.has(key)) continue; suppressionKeys.add(key);
    collections.sales_suppression!.push({ _id: `df-supp-${sha(key)}`, workspaceId: WORKSPACE_ID, key, kind: "email", value, reason: clip(row.reason, 300), createdBy: owner, createdAt: date(row.created_at), externalRef: { system: SYSTEM, id: `outbound_suppressions:${row.workspace_id}:${row.email_address}` } });
  }

  const stageCounts: Record<string, Record<string, number>> = {}; const routeStats = { leadsWithEmail: 0, leadsWithPhone: 0, leadsWithForm: 0, leadsWithAnyRoute: 0 };
  for (const { row, venture, crm } of limited) {
    const leadId = `df-lead-${venture.slug}-${safeId(String(row.lead_id))}`;
    const externalRef = { system: SYSTEM, id: `crm_lead_index:${row.venture_id}:${row.lead_id}` };
    const acts = activitiesByCompany.get(`${row.venture_id}|${row.company_id}`) ?? [];
    const stage = STAGE_MAP[row.stage as string] ?? "identified";
    const feats = features.get(row.company_id) ?? new Map<string, Row>();
    const note = clip(crm?.note ?? row.note, 2000);
    const createdAt = date(crm?.created_at ?? companyCreated.get(row.company_id) ?? entityCreated.get(String(row.lead_id).slice(7)) ?? row.updated_at);
    const updatedAt = date(row.updated_at || crm?.updated_at);

    // Claude verdicts and reviews are notes; the rest are activities or drafts.
    const verdictDocs: Doc[] = []; const reviews: { at: Date; parsed: NonNullable<ReturnType<typeof parseReview>>; id: string; text: string }[] = []; const draftActs: Row[] = []; const plain: Row[] = [];
    for (const act of acts) {
      if (act.kind === "draft") { draftActs.push(act); continue; }
      if (act.kind === "note") {
        const parsed = parseVerdict(String(act.text ?? ""));
        if (parsed) { verdictDocs.push({ _id: `df-verdict-${safeId(act.id)}`, workspaceId: WORKSPACE_ID, ventureId: venture.ventureId, leadId, ...parsed.doc, createdBy: owner, via: "import", createdAt: date(act.occurred_at), fitHeadline: parsed.fitHeadline, externalRef: { system: SYSTEM, id: `crm_activities:${act.id}` } }); stats.verdicts.parsed++; continue; }
        const review = parseReview(String(act.text ?? ""));
        if (review) { reviews.push({ at: date(act.occurred_at), parsed: review, id: act.id, text: String(act.text) }); continue; }
        if (String(act.text ?? "").startsWith("[CLAUDE VERDICT")) stats.verdicts.keptAsNotes++;
      }
      plain.push(act);
    }

    // Drafts: ready after a passing review, needs_changes after a failing one, otherwise in_review.
    const draftDocs: Doc[] = draftActs.map((act) => ({
      _id: `df-draft-${safeId(act.id)}`, workspaceId: WORKSPACE_ID, ventureId: venture.ventureId, leadId, channel: draftChannel(act.channel), purpose: "first_touch",
      ...(act.subject ? { subject: clip(act.subject, 200) } : {}), body: clip(act.text, 5000) || "(empty draft)", status: "in_review", authorId: owner, authorVia: "import",
      createdAt: date(act.occurred_at), updatedAt: date(act.occurred_at), externalRef: { system: SYSTEM, id: `crm_activities:${act.id}` },
    }));
    for (const review of reviews) {
      const ref = review.parsed.draftRef.toLowerCase();
      const target = [...draftDocs].reverse().find((draft) => ref && ((draft.subject ?? "").toLowerCase().includes(ref) || ref.includes((draft.subject ?? "\u0000").toLowerCase()) || draft.body.toLowerCase().startsWith(ref))) ?? [...draftDocs].reverse().find((draft) => draft.createdAt <= review.at);
      if (!target) { plain.push({ id: review.id, kind: "note", text: review.text, occurred_at: review.at.toISOString(), actor: "claude-mcp" }); stats.reviews.keptAsNotes++; continue; }
      target.review = { result: review.parsed.result, issues: review.parsed.fixes, notes: clip(review.parsed.checks, 2000), by: owner, via: "import", at: review.at };
      target.status = review.parsed.result === "pass" ? "ready" : "needs_changes"; target.updatedAt = review.at; stats.reviews.applied++;
    }

    // Plain activities
    const activityDocs: Doc[] = []; let lastTouch: Date | undefined; let exitReasonFromActivity = "";
    for (const act of plain) {
      const at = date(act.occurred_at); const text = String(act.text ?? "");
      const base: Doc = { _id: `df-act-${safeId(act.id)}`, workspaceId: WORKSPACE_ID, ventureId: venture.ventureId, leadId, actorId: owner, via: "import", at, createdAt: date(act.created_at ?? act.occurred_at), externalRef: { system: SYSTEM, id: `crm_activities:${act.id}` } };
      if (act.kind === "status") {
        const move = /^Stage:\s*(\w+)\s*->\s*(\w+)\.?\s*(.*)$/s.exec(text);
        if (move) { const to = STAGE_MAP[move[2]!]; if (to && EXIT_STAGES.has(to) && move[3]) exitReasonFromActivity = move[3]; activityDocs.push({ ...base, kind: "note", body: clip(text, 10_000), ...(STAGE_MAP[move[1]!] ? { stageFrom: STAGE_MAP[move[1]!] } : {}), ...(to ? { stageTo: to } : {}) }); }
        else activityDocs.push({ ...base, kind: "note", body: clip(text, 10_000) });
        continue;
      }
      const kind = act.kind === "call" ? "call" : act.kind === "meeting" ? "meeting" : act.kind === "sent" || act.kind === "reply" ? activityKind(act.channel) : "note";
      const direction = act.kind === "sent" ? "out" : act.kind === "reply" ? "in" : undefined;
      const body = clip(`${act.subject && kind !== "note" ? `Subject: ${act.subject}\n\n` : ""}${text}`, 10_000);
      activityDocs.push({ ...base, kind, ...(direction ? { direction } : {}), body, ...(act.kind === "reply" ? { handledAt: at, handledBy: owner } : {}) });
      if (act.kind === "sent" && (!lastTouch || at > lastTouch)) lastTouch = at;
    }
    // The stage note the owner typed on the lead stays visible as a note when no activity already carries it.
    if (note && !acts.some((act) => String(act.text ?? "").includes(note.slice(0, 40)))) activityDocs.push({ _id: `df-note-${venture.slug}-${safeId(String(row.company_id))}`, workspaceId: WORKSPACE_ID, ventureId: venture.ventureId, leadId, actorId: owner, via: "import", kind: "note", body: note, at: date(crm?.updated_at ?? row.updated_at), createdAt: date(crm?.created_at ?? row.updated_at), externalRef: { system: SYSTEM, id: `crm_leads:${row.venture_id}:${row.company_id}` } });

    // Verdict summary on the lead (the latest one).
    verdictDocs.sort((a, b) => a.createdAt - b.createdAt || String(a._id).localeCompare(String(b._id)));
    const latest = verdictDocs.at(-1);
    const verdict = latest ? { verdictId: latest._id, decision: latest.decision, confidence: latest.confidence, summary: latest.summary, at: latest.createdAt, overridden: false } : undefined;

    // Contact routes from the company's own site, plus its enquiry and dealer pages.
    let routes: Doc[] = []; const domain = String(row.domain ?? "").toLowerCase().replace(/^www\./, "");
    if (domain) for (const page of pages.get(row.company_id) ?? []) {
      let host = ""; try { host = new URL(page.normalized_url).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
      if (host !== domain && !host.endsWith(`.${domain}`)) continue;
      for (const route of routesFromText(pageText(page, blobs), page.normalized_url)) if (!routes.some((r) => r.kind === route.kind && r.value === route.value)) routes.push(route);
    }
    routes = [...routes.filter((r) => r.kind === "email").slice(0, 3), ...routes.filter((r) => r.kind !== "email").slice(0, 4)];
    const ordering = feats.get("ordering_signals"); const dealerFact = feats.get("dealer_network");
    const formEvidence = (fact: Row | undefined, label: string, pattern: RegExp) => { const hit = fact?.evidence?.find((item: Row) => pattern.test(String(item.url ?? "")) && validUrl(item.url)); if (hit) routes.push({ kind: "website_form", value: clip(hit.url, 320), label, sourceUrl: hit.url, publishedByCompany: true }); };
    if (ordering?.value?.enquiry_form || ordering?.value?.request_quote || ordering?.value?.bulk_enquiry) formEvidence(ordering, "Enquiry form", /enquir|inquir|quote|contact|bulk/i);
    if (dealerFact?.value?.become_dealer) formEvidence(dealerFact, "Dealer enquiry", /dealer|distribut|partner|franchis|enquir|inquir/i);
    routes = routes.filter((route, at) => routes.findIndex((r) => r.kind === route.kind && r.value === route.value) === at).slice(0, 20);
    if (routes.some((r) => r.kind === "email")) routeStats.leadsWithEmail++; if (routes.some((r) => r.kind === "phone" || r.kind === "whatsapp")) routeStats.leadsWithPhone++; if (routes.some((r) => r.kind === "website_form")) routeStats.leadsWithForm++; if (routes.length) routeStats.leadsWithAnyRoute++;

    // Signal, fit reason, next action, location
    const noteSignal = /Signal(?: is [a-z ]+)?:\s*(.+?)(?:\.\s+(?=[A-Z])|\.?$)/s.exec(note)?.[1]?.trim();
    const observedSignal = clip((latest?.signal && /"([^"]{3,1000})"/.exec(latest.signal)?.[1]) || latest?.signal || noteSignal || signalFromFacts(feats), 2000);
    const fitReason = clip(latest ? latest.fitHeadline : fitFromNote(note) || engineFitReason(row), 2000);
    for (const doc of verdictDocs) delete doc.fitHeadline; // only needed for the lead's fit reason, not stored on the verdict
    const sendFrom = /Send from (\d{4}-\d{2}-\d{2})/i.exec(note)?.[1];
    const hasPendingDraft = draftDocs.some((d) => d.status === "in_review" || d.status === "ready");
    const preContact = PRE_CONTACT.has(stage);
    const nextAction = preContact && hasPendingDraft ? "Review the draft, then send the first message" : preContact && sendFrom ? "Send the first message" : "";
    const nextActionAt = nextAction && sendFrom ? new Date(`${sendFrom}T03:30:00.000Z`) : undefined; // 09:00 IST
    const stateLabel = row.state_label && row.state_label !== "unknown" ? String(row.state_label) : "";
    const country = row.office_country || (INDIAN_STATES.has(stateLabel.toLowerCase()) ? "India" : "");
    const sources = json<string[]>(row.sources_json, []);
    const tags = [...new Set([...sources.map((s) => s.replace(/^seed_list:/, "")), row.segment && row.segment !== "unknown" ? row.segment : "", row.relevance === "relevant" ? "relevant" : "", row.national_brand ? "national brand" : "", row.needs_website ? "needs website" : ""].map((t) => clip(t, 40)).filter(Boolean))].slice(0, 20);
    const exitReason = EXIT_STAGES.has(stage) ? clip(exitReasonFromActivity || note || `Imported as ${row.stage}`, 500) : "";
    const bucket = /\bbucket\s+([ABC])\b/i.exec(note)?.[1]?.toUpperCase();

    const lead: Doc = {
      _id: leadId, workspaceId: WORKSPACE_ID, ventureId: venture.ventureId, pipelineId: venture.pipelineId, companyName: clip(row.name, 200) || clip(row.domain, 200) || "Unnamed company", contactName: "",
      source: clip(sources.join(", "), 500), observedSignal, fitReason, evidenceConfidence: latest?.confidence ?? "low", stage, ownerId: owner, nextAction: clip(nextAction, 1000),
      ...(nextActionAt ? { nextActionAt } : {}), ...(row.office_city ? { city: clip(row.office_city, 120) } : {}), ...(stateLabel ? { region: clip(stateLabel, 120) } : {}), ...(country ? { country: clip(country, 80) } : {}),
      ...(row.website ? { website: clip(row.website, 500) } : {}), ...(clip(row.segment && row.segment !== "unknown" ? row.segment : row.business_type, 200) ? { category: clip(row.segment && row.segment !== "unknown" ? row.segment : row.business_type, 200) } : {}),
      contactRoutes: routes, ...(bucket ? { fitBand: bucket } : {}), ...(exitReason ? { exitReason } : {}), tags,
      ...(verdict ? { verdict } : {}), needsYou: Boolean(latest && (latest.decision === "hold" || latest.confidence === "low")), doNotContact: false, suppressKeys: [], // both set by finalizeLeads
      ...(lastTouch ? { lastTouchAt: lastTouch } : {}), ...(WON_STAGES.has(stage) ? { wonAt: updatedAt } : {}), externalRef, createdAt, updatedAt,
    };
    collections.opportunities!.push(lead);
    collections.sales_activities!.push(...activityDocs); collections.sales_verdicts!.push(...verdictDocs); collections.sales_drafts!.push(...draftDocs);
    (stageCounts[venture.ventureId] ??= {})[stage] = (stageCounts[venture.ventureId]?.[stage] ?? 0) + 1;
  }
  stats.stageCounts = stageCounts; stats.routes = routeStats;
  if (collections.opportunities!.some((lead) => lead.ventureId === "venture-edithood")) { const edithood = VENTURES.find((v) => v.slug === "edithood")!; collections.pipelines!.push({ _id: edithood.pipelineId, workspaceId: WORKSPACE_ID, ventureId: edithood.ventureId, ...edithood.pipeline, status: "active", createdAt: new Date(), updatedAt: new Date() }); }

  // Brain items (every venture item; items without a counterpart venture are skipped).
  const versions = new Map(all("select * from managed_context_versions").map((row) => [`${row.item_id}|${row.version}`, row]));
  for (const item of all("select * from managed_context_items order by created_at, id")) {
    const venture = ventures.get(item.venture_id); if (!venture) { skip("brain item without a venture counterpart"); continue; }
    const version = versions.get(`${item.id}|${item.current_version}`); if (!version) { skip("brain item without a current version"); continue; }
    const status = item.archived_at ? "archived" : item.approved_version !== null && Number(item.approved_version) === Number(item.current_version) ? "approved" : "draft";
    const title = clip(version.title || item.title, 160);
    collections.sales_brain_items!.push({
      _id: `df-brain-${safeId(item.id)}`, workspaceId: WORKSPACE_ID, ventureId: venture.ventureId, kind: brainKind(item.kind, title), title, body: renderBrainBody(json<Row>(version.content_json, {})), status, version: 1,
      proposedBy: owner, via: "import", ...(status === "approved" ? { approvedBy: owner, approvedAt: date(version.approved_at ?? item.updated_at) } : {}), createdAt: date(item.created_at), updatedAt: date(item.updated_at),
      externalRef: { system: SYSTEM, id: `managed_context_items:${item.id}` },
    });
  }
  return { collections, stats, suppressionKeys };
}

/** Do-not-contact match keys (the API's own `leadSuppressKeys`) and the flag: a lead is suppressed when one of its keys is in the list. */
function finalizeLeads(plan: Plan, extraKeys: Set<string> = new Set()): void {
  let suppressed = 0;
  for (const lead of plan.collections.opportunities!) {
    lead.suppressKeys = leadSuppressKeys(lead as { companyName: string; website?: string; contactRoutes: { kind: string; value: string }[] });
    lead.doNotContact = (lead.suppressKeys as string[]).some((key) => plan.suppressionKeys.has(key) || extraKeys.has(key));
    if (lead.doNotContact) suppressed++;
  }
  plan.stats.doNotContact = suppressed;
}

// ------------------------------------------------------------------------------------------------ validation

const isWebUrl = (value: unknown): boolean => /^https?:\/\//i.test(String(value ?? ""));

/**
 * One route per value: an email route is one plain address (no recipient lists, no mailto parameters), a phone or WhatsApp route
 * one number, and a sourceUrl an http(s) link. Multi-value routes are split into separate routes; what cannot be made plain is dropped.
 */
export function splitRoute(route: Doc): Doc[] {
  const { sourceUrl, ...rest } = route; const base = { ...rest, ...(isWebUrl(sourceUrl) ? { sourceUrl } : {}) };
  if (route.kind === "email") return [...new Set(String(route.value).split(/[\s,;]+/).map((part) => normalizeEmail(part)).filter((email): email is string => Boolean(email)))].map((value) => ({ ...base, value }));
  if (route.kind === "phone" || route.kind === "whatsapp") {
    const parts = String(route.value).split(/[,;|]|\s\/\s|\s+(?:or|and)\s+/i).map((part) => part.trim()).filter(Boolean);
    return [...new Set(parts.map((part) => normalizePhone(part)).filter((phone): phone is string => Boolean(phone)))].map((value) => ({ ...base, value }));
  }
  return [base];
}

/** Checks every document against the shared contracts (dates as ISO strings, `id` for `_id`). Drops invalid ones and their children. */
async function validate(plan: Plan): Promise<string[]> {
  // Routes first: split multi-value ones into one route per value (works without the contracts too).
  let split = 0;
  for (const lead of plan.collections.opportunities!) {
    const seen = new Set<string>(); const routes: Doc[] = [];
    for (const route of lead.contactRoutes as Doc[]) { const parts = splitRoute(route); if (parts.length !== 1 || parts[0]!.value !== route.value) split++; for (const part of parts) { const key = `${part.kind}:${part.value}`; if (!seen.has(key)) { seen.add(key); routes.push(part); } } }
    lead.contactRoutes = routes.slice(0, 20);
  }
  plan.stats.routesSplitOrFixed = split;
  const contracts: any = await import("@venture-studio/contracts").catch(() => null);
  if (!contracts?.opportunitySchema) return ["contracts not built (npm run build:packages): documents were not validated"];
  // Then each route against the contract's contactRouteSchema; one bad route is dropped, not the whole lead.
  let dropped = 0; const droppedKinds: Record<string, number> = {};
  for (const lead of plan.collections.opportunities!) lead.contactRoutes = (lead.contactRoutes as Doc[]).filter((route) => { if (contracts.contactRouteSchema.safeParse(route).success) return true; dropped++; droppedKinds[route.kind] = (droppedKinds[route.kind] ?? 0) + 1; return false; });
  plan.stats.routesDropped = dropped; if (dropped) plan.stats.routesDroppedByKind = droppedKinds;
  const wire = (doc: Doc): Doc => { const out: Doc = {}; for (const [key, value] of Object.entries(doc)) {
    out[key === "_id" ? "id" : key] = revive(value); } return out; };
  const revive = (value: any): any => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(revive) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)])) : value;
  const schemas: Record<string, any> = { opportunities: contracts.opportunitySchema, sales_activities: contracts.activitySchema, sales_verdicts: contracts.verdictSchema, sales_drafts: contracts.draftSchema, sales_brain_items: contracts.brainItemSchema, sales_suppression: contracts.suppressionSchema, pipelines: contracts.pipelineSchema };
  const problems: string[] = []; const badLeads = new Set<string>();
  for (const name of ["opportunities", "sales_activities", "sales_verdicts", "sales_drafts", "sales_brain_items", "sales_suppression", "pipelines"]) {
    const schema = schemas[name]; if (!schema) { problems.push(`no schema for ${name}`); continue; }
    const kept: Doc[] = [];
    for (const doc of plan.collections[name]!) {
      const orphan = doc.leadId && badLeads.has(doc.leadId);
      const parsed = orphan ? null : schema.safeParse(wire(doc));
      if (orphan || !parsed?.success) { if (name === "opportunities") badLeads.add(doc._id); if (!orphan && problems.length < 12) problems.push(`${name} ${doc._id}: ${parsed?.error?.issues?.slice(0, 2).map((i: any) => `${i.path.join(".")} ${i.message}`).join("; ")}`); plan.stats.invalid = (plan.stats.invalid ?? 0) + 1; continue; }
      kept.push(doc);
    }
    plan.collections[name] = kept;
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------- guards

/** Hosts named by a MongoDB connection string. mongodb+srv always means a remote cluster. */
export function mongoHosts(uri: string): string[] {
  const match = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(uri.trim());
  if (!match) throw new Error("MONGODB_URI is not a mongodb:// connection string.");
  if (match[1]) return ["(mongodb+srv cluster)"];
  return match[2]!.split(",").map((part) => { const host = part.trim().toLowerCase(); const bracket = /^\[(.*)\](?::\d+)?$/.exec(host); return bracket ? bracket[1]! : host.replace(/:\d+$/, ""); });
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// ------------------------------------------------------------------------------------------------------ writing

const REFRESH_FIELDS = ["companyName", "city", "region", "country", "category", "website", "contactRoutes", "observedSignal", "tags", "suppressKeys"] as const;
/** Rows keyed by something other than `_id`, as the API does: leads by externalRef (unique per venture; these ids name the venture), suppression entries by key (unique per workspace). */
const FILTERS: Record<string, (doc: Doc) => Doc> = {
  opportunities: (doc) => ({ workspaceId: doc.workspaceId, "externalRef.system": doc.externalRef.system, "externalRef.id": doc.externalRef.id }),
  sales_suppression: (doc) => ({ workspaceId: doc.workspaceId, key: doc.key }),
};
/** Fields the filter already supplies on insert (an equality filter creates them; setting them again would only risk a path conflict). */
const FROM_FILTER: Record<string, string[]> = { opportunities: ["workspaceId", "externalRef"], sales_suppression: ["workspaceId", "key"] };
const WRITE_ORDER = ["pipelines", "sales_suppression", "opportunities", "sales_activities", "sales_verdicts", "sales_drafts", "sales_brain_items"];

type Counts = { inserted: number; matched: number; modified: number };

/** Insert-only for every collection: a row that exists is never rewritten, so what people did in the app survives a re-run. */
async function insertMissing(db: Db, plan: Plan): Promise<Record<string, Counts>> {
  const result: Record<string, Counts> = {};
  for (const name of WRITE_ORDER) {
    const docs = plan.collections[name] ?? []; const total: Counts = { inserted: 0, matched: 0, modified: 0 };
    for (let start = 0; start < docs.length; start += 500) {
      const ops: AnyBulkWriteOperation<Doc>[] = docs.slice(start, start + 500).map((doc) => {
        const insert: Doc = { ...doc }; for (const field of FROM_FILTER[name] ?? []) delete insert[field];
        if (name === "opportunities") insert.importUpdatedAt = doc.updatedAt; // what a later --refresh compares against to know nobody edited the lead
        return { updateOne: { filter: FILTERS[name]?.(doc) ?? { _id: doc._id }, update: { $setOnInsert: insert }, upsert: true } };
      });
      const res = await db.collection<Doc>(name).bulkWrite(ops, { ordered: false });
      total.inserted += res.upsertedCount; total.matched += res.matchedCount; total.modified += res.modifiedCount;
    }
    result[name] = total;
  }
  return result;
}

const comparable = (value: any): string => JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item === undefined ? null : item);

/**
 * --refresh: updates the descriptive fields (REFRESH_FIELDS) of leads that nobody has edited since the import. A lead counts as
 * untouched when its `updatedAt` still equals the `importUpdatedAt` the importer stored (every app edit stamps `updatedAt` with the
 * time of the edit). Rows imported before that marker existed count as untouched when their `updatedAt` is not later than the first
 * import's audit event. The update is compare-and-set on `updatedAt`, so an edit made while the refresh runs wins.
 */
export async function refreshLeads(db: Db, plan: Plan): Promise<Record<string, number>> {
  const leads = db.collection<Doc>("opportunities"); const outcome = { checked: 0, refreshed: 0, unchanged: 0, leftAloneEditedInApp: 0, leftAloneSoftDeleted: 0, lostRace: 0 };
  const firstImport = await db.collection<Doc>("audit_events").findOne({ action: "sales.import" }, { sort: { occurredAt: 1 } });
  const legacyCutoff = firstImport?.occurredAt ? new Date(firstImport.occurredAt).getTime() : undefined;
  const wanted = new Map(plan.collections.opportunities!.map((lead) => [lead.externalRef.id as string, lead]));
  const refs = [...wanted.keys()];
  for (let start = 0; start < refs.length; start += 500) {
    const existing = await leads.find({ workspaceId: WORKSPACE_ID, "externalRef.system": SYSTEM, "externalRef.id": { $in: refs.slice(start, start + 500) } }).toArray();
    const ops: AnyBulkWriteOperation<Doc>[] = [];
    for (const row of existing) {
      const want = wanted.get(row.externalRef.id); if (!want) continue; outcome.checked++;
      if (row.deletedAt) { outcome.leftAloneSoftDeleted++; continue; }
      const stamp = new Date(row.updatedAt).getTime();
      const untouched = row.importUpdatedAt ? new Date(row.importUpdatedAt).getTime() === stamp : legacyCutoff !== undefined && stamp <= legacyCutoff;
      if (!untouched) { outcome.leftAloneEditedInApp++; continue; }
      const $set: Doc = {}; const $unset: Doc = {};
      for (const field of REFRESH_FIELDS) { if (comparable(row[field]) === comparable(want[field])) continue; if (want[field] === undefined) $unset[field] = ""; else $set[field] = want[field]; }
      if (!Object.keys($set).length && !Object.keys($unset).length) { outcome.unchanged++; continue; }
      $set.updatedAt = want.updatedAt; $set.importUpdatedAt = want.updatedAt;
      ops.push({ updateOne: { filter: { _id: row._id, workspaceId: WORKSPACE_ID, updatedAt: row.updatedAt }, update: { $set, ...(Object.keys($unset).length ? { $unset } : {}) } } });
    }
    if (ops.length) { const res = await leads.bulkWrite(ops, { ordered: false }); outcome.refreshed += res.modifiedCount; outcome.lostRace += ops.length - res.matchedCount; }
  }
  return outcome;
}

/**
 * --refresh, for safety: every imported lead (not soft-deleted) whose recomputed match keys hit the do-not-contact list (`doNotContact`
 * from finalizeLeads, which counts the entries already in the database too) is flagged, whether or not people edited it since. The flag
 * is one way: a lead the list no longer matches keeps it (a person clears it in the app). Its unsent drafts are discarded and its
 * next-action reminders cancelled with the app's own helper. A lead nobody edited stays "untouched" for later refreshes.
 */
export async function flagDoNotContact(db: Db, plan: Plan, now = new Date()): Promise<{ flagged: number; draftsDiscarded: number; remindersCancelled: number }> {
  const refs = plan.collections.opportunities!.filter((lead) => lead.doNotContact === true).map((lead) => lead.externalRef.id as string);
  return flagImportedDoNotContact(new AppDb(db), WORKSPACE_ID, SYSTEM, refs, now);
}

// ---------------------------------------------------------------------------------------------------------- main

async function main() {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, limit: { type: "string" }, owner: { type: "string", default: "user-divyansh" }, sqlite: { type: "string", default: DEFAULT_SQLITE }, "allow-db": { type: "string" }, "allow-host": { type: "boolean", default: false }, refresh: { type: "boolean", default: false }, "only-worked": { type: "boolean", default: false }, "include-junk": { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help) { console.log("Usage: import-dealflow.ts [--dry-run] [--limit N] [--owner user-id] [--sqlite path] [--allow-db name] [--allow-host] [--refresh] [--only-worked] [--include-junk]"); return; }
  const dbName = process.env.MONGODB_DB ?? ""; const uri = process.env.MONGODB_URI ?? DEFAULT_URI;
  if (process.env.APP_MODE === "production") throw new Error("Refusing to run: APP_MODE=production.");
  if (!dbName) throw new Error("MONGODB_DB is not set (run with --env-file=.env).");
  if (NEVER_WRITE.has(dbName)) throw new Error(`Refusing to run: "${dbName}" is not a Venture OS database.`);
  if (!dbName.endsWith("_dev") && values["allow-db"] !== dbName) throw new Error(`Refusing to run: database "${dbName}" does not end with "_dev". Pass --allow-db ${dbName} to confirm.`);
  const remote = mongoHosts(uri).filter((host) => !LOCAL_HOSTS.has(host));
  if (remote.length && !values["allow-host"]) throw new Error(`Refusing to run: MONGODB_URI host "${remote.join(", ")}" is not localhost or 127.0.0.1. Pass --allow-host to confirm.`);
  const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined; if (values.limit && !(limit && limit > 0)) throw new Error("--limit must be a positive number.");
  const options: Options = { sqlite: values.sqlite!, owner: values.owner!, ...(limit ? { limit } : {}), onlyWorked: values["only-worked"]!, includeJunk: values["include-junk"]! };

  // Read-only, twice over: the connection URI says so and the session refuses any write.
  const source = new DatabaseSync(`${pathToFileURL(path.resolve(options.sqlite)).href}?mode=ro`, { readOnly: true });
  source.exec("PRAGMA query_only = 1");
  const plan = buildPlan(source, options); source.close();
  const problems = await validate(plan);

  const print = (title: string, result?: Record<string, Counts>, refreshed?: Record<string, number>) => {
    console.log(`\n${title}`);
    for (const name of WRITE_ORDER) { const docs = plan.collections[name] ?? []; const r = result?.[name]; console.log(`  ${name.padEnd(18)} ${String(docs.length).padStart(6)}${r ? `   inserted ${r.inserted}, already there ${r.matched}` : ""}`); }
    console.log("  by venture and stage:", JSON.stringify(plan.stats.stageCounts));
    console.log(`  verdicts: ${plan.stats.verdicts.parsed} parsed into sales_verdicts, ${plan.stats.verdicts.keptAsNotes} kept as notes; reviews: ${plan.stats.reviews.applied} applied to drafts, ${plan.stats.reviews.keptAsNotes} kept as notes`);
    console.log("  contact routes (from stored own-site pages and enquiry facts):", JSON.stringify(plan.stats.routes), `; split/fixed ${plan.stats.routesSplitOrFixed ?? 0}, dropped as invalid ${plan.stats.routesDropped ?? 0}${plan.stats.routesDroppedByKind ? ` ${JSON.stringify(plan.stats.routesDroppedByKind)}` : ""}`);
    console.log(`  do-not-contact: ${plan.stats.doNotContact ?? 0} leads flagged; suppression rows from SQLite: ${plan.collections.sales_suppression!.length}`);
    console.log("  skipped:", JSON.stringify(plan.stats.skipped), plan.stats.leadsSkippedByLimit ? `(+${plan.stats.leadsSkippedByLimit} leads beyond --limit)` : "", plan.stats.invalid ? `invalid dropped: ${plan.stats.invalid}` : "");
    if (refreshed) console.log("  refresh (descriptive fields of untouched leads only; do-not-contact flags, discarded drafts and cancelled reminders on any lead):", JSON.stringify(refreshed));
    for (const problem of problems) console.log(`  warning: ${problem}`);
  };
  if (values["dry-run"]) { finalizeLeads(plan); print(`DRY RUN (nothing written) -> would target database "${dbName}"`); return; }

  const client = new MongoClient(uri, { ignoreUndefined: true }); await client.connect();
  try {
    const db = client.db(dbName);
    if (!(await db.collection("workspaces").findOne({ _id: WORKSPACE_ID as any }))) throw new Error(`"${dbName}" has no ${WORKSPACE_ID} workspace: run the API seed first (npm run seed --workspace @venture-studio/api).`);
    if (!(await db.collection("users").findOne({ _id: options.owner as any }))) throw new Error(`Owner "${options.owner}" is not a user in "${dbName}".`);
    for (const venture of new Set(plan.collections.opportunities!.map((lead) => lead.ventureId).concat(plan.collections.sales_brain_items!.map((item) => item.ventureId)))) if (!(await db.collection("ventures").findOne({ _id: venture as any }))) throw new Error(`Venture ${venture} is missing in "${dbName}".`);
    for (const pipelineId of new Set(plan.collections.opportunities!.map((lead) => lead.pipelineId))) if (!plan.collections.pipelines!.some((p) => p._id === pipelineId) && !(await db.collection("pipelines").findOne({ _id: pipelineId as any }))) throw new Error(`Pipeline ${pipelineId} is missing in "${dbName}".`);
    // Suppression entries already in the database (added in the app) count too, as when the app creates a lead.
    const existingKeys = new Set((await db.collection("sales_suppression").find({ workspaceId: WORKSPACE_ID }, { projection: { key: 1 } }).toArray()).map((row) => String(row.key)));
    finalizeLeads(plan, existingKeys);
    const result = await insertMissing(db, plan);
    const refreshed: Record<string, number> | undefined = values.refresh ? { ...await refreshLeads(db, plan), ...await flagDoNotContact(db, plan) } : undefined;
    print(`IMPORTED into "${dbName}"`, result, refreshed);
    const changed = Object.values(result).reduce((sum, item) => sum + item.inserted, 0) + (refreshed?.refreshed ?? 0) + (refreshed?.flagged ?? 0) + (refreshed?.draftsDiscarded ?? 0) + (refreshed?.remindersCancelled ?? 0);
    if (changed) await db.collection<Doc>("audit_events").insertOne({ _id: `df-import-${Date.now()}`, workspaceId: WORKSPACE_ID, actorId: options.owner, channel: "worker", action: "sales.import", objectType: "dealflow-sqlite", result: "success", metadata: { leads: plan.collections.opportunities!.length, changed }, occurredAt: new Date() });
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
