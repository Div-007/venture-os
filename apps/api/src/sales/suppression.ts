// The one do-not-contact list: normalisation of emails, phones (India +91 by default), domains and company names, and the
// match keys stored on leads (`suppressKeys`) so a new suppression entry can flag every matching lead with one update.
// Matching is deliberately broad on contact details (any spelling of the same mailbox, number or company domain) and conservative
// on company names (punctuation, "&"/"and", brackets and legal suffixes are ignored; trade words like "traders" are not).

export type SuppressionKind = "email" | "phone" | "domain" | "company";
/** Bump when the normalisation changes: the migration recomputes keys that carry an older version. */
export const SUPPRESS_KEYS_VERSION = 2;

/** Mail providers and big platforms: a suppression or match on these would hit unrelated companies. */
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "rediffmail.com", "proton.me", "protonmail.com", "aol.com", "zoho.com", "gmx.com", "mail.com",
  "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "google.com", "wa.me", "whatsapp.com", "justdial.com", "indiamart.com", "tradeindia.com", "sulekha.com", "wixsite.com", "wordpress.com", "blogspot.com", "business.site", "godaddysites.com", "weebly.com", "carrd.co", "linktr.ee",
]);

export function isSharedDomain(domain: string): boolean {
  return SHARED_DOMAINS.has(domain) || [...SHARED_DOMAINS].some((shared) => domain.endsWith(`.${shared}`));
}

/** Digits of Indian scripts, Arabic-Indic and full-width forms read as ASCII digits. */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0xff10];
function asciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯０-９]/g, (char) => {
    const code = char.charCodeAt(0);
    const zero = DIGIT_ZEROS.find((start) => code >= start && code <= start + 9)!;
    return String(code - zero);
  });
}

/** One plain address: lowercase, "mailto:" / display name / query removed, "+tag" dropped from the mailbox, trailing dot dropped from the domain. */
export function normalizeEmail(value: string): string | null {
  const email = value.trim().replace(/^mailto:/i, "").replace(/\?.*$/, "").replace(/^.*<([^>]+)>.*$/, "$1").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1).replace(/\.+$/, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  const result = `${local}@${domain}`;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) ? result : null;
}

/** Bounded parts (a mailbox is at most 64 characters, a domain label 63, at most 8 labels after the first): the match stays linear on long text. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}\.?/g;
/** Free text longer than this is not a contact value: the extractors find nothing in it rather than spend time on it. */
export const MAX_CONTACT_TEXT = 2_000;
/** Every email address written in a free-text value (a contact page note, a mailto link, "Name <addr>"); nothing in text over 2,000 characters. */
export function extractEmails(text: string): string[] {
  if (text.length > MAX_CONTACT_TEXT) return [];
  return [...new Set((text.match(EMAIL_PATTERN) ?? []).map(normalizeEmail).filter((email): email is string => email !== null))];
}

/** "+<digits>": 10-digit numbers, 0-prefixed and 91-prefixed Indian numbers all become +91XXXXXXXXXX; extensions are ignored. */
export function normalizePhone(value: string): string | null {
  const text = asciiDigits(value);
  const wa = /wa\.me\/\+?(\d+)/i.exec(text) ?? /[?&]phone=\+?(\d+)/i.exec(text);
  const raw = (wa ? wa[1]! : text).trim().replace(/^tel:/i, "").replace(/\b(?:ext|extn|extension|x)\.?\s*\d+.*$/i, "").trim();
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) digits = digits.slice(2);
  if (!raw.startsWith("+") && !raw.startsWith("00")) {
    if (digits.length === 10) digits = `91${digits}`;
    else if (digits.length === 11 && digits.startsWith("0")) digits = `91${digits.slice(1)}`;
  }
  // A country code never starts with 0, and a number has 8 to 15 digits (E.164).
  return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
}

/** Every phone number written in a free-text value: wa.me and tel: links, and numbers separated by "/", ",", ";", "|", "or", "and". */
export function extractPhones(text: string): string[] {
  if (text.length > MAX_CONTACT_TEXT) return [];
  const phones = new Set<string>();
  let rest = asciiDigits(text).replace(EMAIL_PATTERN, " ");
  for (const match of rest.matchAll(/wa\.me\/\+?(\d{8,15})/gi)) { const phone = normalizePhone(`+${match[1]}`); if (phone) phones.add(phone); }
  rest = rest.replace(/https?:\/\/\S+/gi, " ").replace(/\btel:/gi, " ");
  for (const part of rest.split(/[/,;|\n]|\s(?:or|and)\s/i)) {
    const number = /\+?\d[\d\s().-]{6,}\d/.exec(part.replace(/\b(?:ext|extn|extension|x)\.?\s*\d+.*$/i, ""));
    const phone = number && number[0].replace(/\D/g, "").length >= 10 ? normalizePhone(number[0]) : null;
    if (phone) phones.add(phone);
  }
  return [...phones];
}

export function normalizeDomain(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

const COMPANY_SUFFIXES = new Set(["pvt", "private", "ltd", "limited", "llp", "inc", "incorporated", "llc", "co", "corp", "corporation", "company", "opc", "the"]);

/** Brackets, "&"/"and", punctuation, case and legal suffixes (Pvt Ltd, LLP, Co ...) are ignored; trade words such as "traders" stay. */
export function normalizeCompany(value: string): string | null {
  const words = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9ऀ-ॿ]+/g, " ").trim().split(/\s+/).filter((word) => word && word !== "and");
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[0]!)) words.shift();
  const name = words.join(" ");
  return name.length >= 2 ? name : null;
}

/** A city as people write it, down to its name: "Indore", "indore ", "Indore, MP" and "Indore (M.P.)" are one city. */
export const cityKey = (value: unknown) => String(value ?? "").toLowerCase().split(/[,(]/)[0]!.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Two cities that don't tell two companies of the same name apart: either is not known, or they are the same city. */
export const sameCity = (a: unknown, b: unknown) => { const left = cityKey(a); const right = cityKey(b); return !left || !right || left === right; };

export function normalizeValue(kind: SuppressionKind, value: string): string | null {
  switch (kind) {
    case "email": return normalizeEmail(value);
    case "phone": return normalizePhone(value);
    case "domain": return normalizeDomain(value);
    case "company": return normalizeCompany(value);
  }
}

export const suppressionKey = (kind: SuppressionKind, normalized: string) => `${kind}:${normalized}`;

type RouteLike = { kind: string; value: string };
type LeadLike = { companyName?: string; website?: string; contactRoutes?: RouteLike[] };

/** The emails, phones and company domains a lead can be reached on (published routes of every kind, and its website). */
export function leadContacts(lead: LeadLike): { emails: string[]; phones: string[]; domains: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const domains = new Set<string>();
  const addDomain = (value: string | null) => { if (value && !isSharedDomain(value)) domains.add(value); };
  for (const route of lead.contactRoutes ?? []) {
    if (route.kind === "linkedin") continue;
    if (route.kind === "email") for (const email of extractEmails(route.value)) emails.add(email);
    else if (route.kind === "phone" || route.kind === "whatsapp") for (const phone of extractPhones(route.value)) phones.add(phone);
    else {
      // "other" and website forms can hold anything: a mailto link, a wa.me link, a page address, a number in a sentence.
      for (const email of extractEmails(route.value)) emails.add(email);
      for (const phone of extractPhones(route.value)) phones.add(phone);
      if (/^https?:\/\//i.test(route.value.trim())) addDomain(normalizeDomain(route.value));
    }
  }
  for (const email of emails) addDomain(normalizeDomain(email));
  if (lead.website) addDomain(normalizeDomain(lead.website));
  return { emails: [...emails], phones: [...phones], domains: [...domains] };
}

/** Every key a lead can be matched on: its emails and phones, the company's own domains, and the company name. */
export function leadSuppressKeys(lead: LeadLike): string[] {
  const { emails, phones, domains } = leadContacts(lead);
  const keys = new Set<string>([...emails.map((value) => suppressionKey("email", value)), ...phones.map((value) => suppressionKey("phone", value)), ...domains.map((value) => suppressionKey("domain", value))]);
  const company = lead.companyName ? normalizeCompany(lead.companyName) : null;
  if (company) keys.add(suppressionKey("company", company));
  return [...keys];
}

/** The entries an opt-out or hostile reply creates for a lead: its emails and phones, the company's own domains (never a shared mail domain) and the company name. */
export function optOutEntries(lead: LeadLike): { kind: SuppressionKind; value: string }[] {
  const { emails, phones, domains } = leadContacts(lead);
  const entries: { kind: SuppressionKind; value: string }[] = [...emails.map((value) => ({ kind: "email" as const, value })), ...phones.map((value) => ({ kind: "phone" as const, value })), ...domains.map((value) => ({ kind: "domain" as const, value }))];
  const company = lead.companyName ? normalizeCompany(lead.companyName) : null;
  if (company) entries.push({ kind: "company", value: company });
  return entries;
}
