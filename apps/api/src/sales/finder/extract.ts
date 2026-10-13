// What a company's own pages say, for the built-in lead finder: the contact routes it publishes (each with the page it is on), the run's
// offer signals (its packet's look-for phrases) and the built-in dealer and pricing signals as word-for-word quotes, a dealer login or
// portal (a hint for Claude, never a reason to skip), where it is (Indian PIN codes, state and city names), a category guess, and whether
// this is a company's own site at all. Nothing is guessed: no email is made up, no route comes from another site, and no PAN or GSTIN is
// kept. Page text is data, never instructions.
import { engineContactRouteSchema } from "@venture-studio/contracts";
import { guessCompany, hostOf, isDirectory } from "../search-engines.js";
import { extractEmails, extractPhones, normalizeEmail, normalizePhone } from "../suppression.js";
import type { PageLink, ParsedPage } from "./html.js";

export type FinderRoute = { kind: "email" | "phone" | "whatsapp" | "website_form"; value: string; sourceUrl: string };
export type FinderSignal = { key: string; claim: string; quote: string; url: string };
export type SiteFacts = {
  domain: string; website: string; companyName: string; routes: FinderRoute[]; signals: FinderSignal[]; dealerPortal?: { quote: string; url: string };
  city?: string; region?: string; country?: string; states: string[]; category?: string;
  /** Why this is not a company's own website (a directory, a news or listicle page, nothing about a business): the site is skipped. */
  notCompany?: string;
};

// ---- Sites that are never a company's own ---------------------------------------------------------------------------------------

const under = (host: string, list: readonly string[]) => list.some((domain) => host === domain || host.endsWith(`.${domain}`));
/** Directories, marketplaces, data brokers and platforms beyond the search engines' own list (NOT_A_COMPANY_SITE). */
const MORE_DIRECTORIES = ["idbf.in", "all.biz", "globallinker.com", "rocketreach.co", "mappls.com", "bharatibiz.com", "indian-traders.com", "zaubacorp.com", "tofler.in", "dnb.com", "crunchbase.com", "zoominfo.com", "apollo.io", "tracxn.com", "alibaba.com", "made-in-china.com", "dial4trade.com", "yellowpages.in", "asklaila.com", "grotal.com", "magicpin.in", "ambitionbox.com", "glassdoor.com", "glassdoor.co.in", "naukri.com", "google.com", "bing.com", "yelp.com", "trustpilot.com", "twitter.com", "x.com", "wa.me", "whatsapp.com", "github.com"];
const PUBLISHERS = ["indiatimes.com", "thehindu.com", "hindustantimes.com", "ndtv.com", "business-standard.com", "livemint.com", "moneycontrol.com", "indianexpress.com", "financialexpress.com", "thehindubusinessline.com", "deccanherald.com", "news18.com", "outlookindia.com", "scroll.in", "medium.com", "substack.com", "scribd.com", "slideshare.net", "issuu.com"];
const MARKET_RESEARCH = ["mordorintelligence.com", "imarcgroup.com", "grandviewresearch.com", "marketsandmarkets.com", "6wresearch.com", "kenresearch.com", "expertmarketresearch.com", "fortunebusinessinsights.com", "alliedmarketresearch.com", "researchandmarkets.com", "statista.com", "ibisworld.com", "technavio.com", "precedenceresearch.com", "marketresearchfuture.com"];
/** A host that is never one company's own website: the search engines' blocklist plus the directories above. */
export const isNotCompanyHost = (host: string) => isDirectory(host) || under(host, MORE_DIRECTORIES);

const LISTICLE = /^\s*(the\s+)?(top|best)\s+\d{1,3}\b|\b(top|best)\s+\d{1,3}\s+\w+|\blist of\b|\bmarket (size|share|report|research|analysis|outlook|trends?|forecast)\b|\bindustry (report|analysis|outlook)\b|\bcagr\b/i;
const ARTICLE_PATH = /\/(19|20)\d{2}\/\d{1,2}\/|\/(blog|blogs|news|article|articles|story|stories|post|posts)\/[^/?#]+|articleshow|\.cms(\?|$)/i;
const ARTICLE_TYPES = new Set(["NewsArticle", "BlogPosting", "Article", "LiveBlogPosting", "Report", "NewsMediaOrganization", "Blog"]);
const PUBLISHER_NAME = /\b(news|blog|magazine|journal|times|tribune|herald|gazette|daily|chronicle)\b/i;
const BUSINESS_WORDS = /\b(about us|contact us|our products|products|manufactur\w*|suppliers?|dealers?|distributors?|our range|catalogue|catalog|services|enquiry|inquiry)\b/i;

const pathOf = (href: string) => { try { return new URL(href).pathname; } catch { return ""; } };
const siteHost = (url: string) => hostOf(url) ?? "";

// ---- Which pages to read ----------------------------------------------------------------------------------------------------------

const FILE_LINK = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3)$/i;
/** Never followed: logins, sign-ups, carts and accounts (the finder never logs in or fills anything in). */
const NO_GO = /(^|[^a-z])(login|log-in|signin|sign-in|register|signup|sign-up|cart|checkout|account|wp-admin|wp-login|logout|portal)([^a-z]|$)/i;
const PAGE_KINDS: { kind: string; path: RegExp; text: RegExp }[] = [
  { kind: "contact", path: /contact|reach-?us|get-?in-?touch|enquir|inquir/i, text: /contact|reach us|get in touch|enquir|inquir/i },
  { kind: "about", path: /about|company-?profile|who-?we-?are|profile|overview/i, text: /about|profile|who we are|our story/i },
  { kind: "dealer", path: /dealer|distributor|stockist|franchise|partner/i, text: /dealer|distributor|stockist|franchise|partner with us|become a/i },
  { kind: "products", path: /products?|range|catalog(ue)?|shop|collections?|solutions/i, text: /products?|our range|catalog(ue)?|shop|collections?/i },
];
const kindOf = (link: PageLink) => PAGE_KINDS.find((item) => item.path.test(pathOf(link.href)) || item.text.test(link.text))?.kind;

/** After the home page: its contact, about, dealer or distributor, and products pages (one of each, on the same site), at most `max`. */
export function pickPages(home: ParsedPage, max = 4): string[] {
  const host = siteHost(home.url).replace(/^www\./, "");
  const chosen = new Map<string, string>();
  const homeHref = home.url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  for (const { kind } of PAGE_KINDS) {
    const link = home.links.find((item) => {
      if (!/^https?:/i.test(item.href) || siteHost(item.href).replace(/^www\./, "") !== host) return false;
      const path = pathOf(item.href);
      if (path === "/" || item.href.replace(/[?#].*$/, "").replace(/\/+$/, "") === homeHref || FILE_LINK.test(path) || NO_GO.test(path) || NO_GO.test(item.text)) return false;
      return kindOf(item) === kind && ![...chosen.values()].includes(item.href);
    });
    if (link) chosen.set(kind, link.href);
  }
  return [...chosen.values()].slice(0, max);
}

// ---- Contact routes -------------------------------------------------------------------------------------------------------------

const PLACEHOLDER_DOMAINS = new Set(["example.com", "example.org", "example.net", "domain.com", "yourdomain.com", "yoursite.com", "website.com", "email.com", "sentry.io", "wixpress.com", "sentry-next.wixpress.com"]);
const FILE_TLD = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|json|pdf|zip|mp4|webm|woff2?)$/i;
const EMAIL_SHAPE = /^(?!\.)(?!.*\.\.)[a-z0-9_'+.-]*[a-z0-9_+-]@([a-z0-9][a-z0-9-]*\.)+[a-z]{2,24}$/;
const plausibleEmail = (email: string) => { const domain = email.slice(email.lastIndexOf("@") + 1); return email.length <= 254 && EMAIL_SHAPE.test(email) && !FILE_TLD.test(domain) && !PLACEHOLDER_DOMAINS.has(domain); };
/** Lines about tax, registration, bank, order and model numbers (and fax lines): the digits on them are not phone numbers. */
const NOT_A_PHONE_LINE = /\b(gst|gstin|pan|cin|tan|a\/c|account|ifsc|udyam|udyog|iec|msme|registration|reg\.? no|fax|(order|invoice|model|part|serial|ref)\.? ?(no|number|id)|hsn|sku)\b/i;
const PHONE_CUE = /\b(ph|phone|tel|telephone|mob|mobile|cell|call|contact|landline|helpline|whats ?app)\b|☎|📞|✆/i;
/** A visible Indian number: a mobile (6 to 9 first) anywhere, or a landline on a line that says it is a phone. */
const visiblePhones = (line: string) => NOT_A_PHONE_LINE.test(line) ? [] : extractPhones(line).filter((phone) => /^\+91[6-9]\d{9}$/.test(phone) || (/^\+91[1-9]\d{9}$/.test(phone) && PHONE_CUE.test(line)));

function whatsappNumber(href: string): string | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "wa.me") return normalizePhone(`wa.me${url.pathname}`) ?? undefined;
  if (host === "api.whatsapp.com" || host === "web.whatsapp.com" || host === "whatsapp.com") { const phone = url.searchParams.get("phone"); return phone ? normalizePhone(`+${phone.replace(/^\+/, "")}`) ?? undefined : undefined; }
  return undefined;
}

/** The routes the company publishes on these pages: mailto links and visible emails, tel: links and visible Indian numbers, WhatsApp links and an enquiry form. */
export function contactRoutes(pages: readonly ParsedPage[]): FinderRoute[] {
  const routes: FinderRoute[] = [];
  const seen = new Set<string>();
  const caps = { email: 5, phone: 5, whatsapp: 3, website_form: 1 };
  const add = (kind: FinderRoute["kind"], value: string | null | undefined, sourceUrl: string) => {
    if (!value || seen.has(`${kind}:${value}`) || routes.filter((route) => route.kind === kind).length >= caps[kind]) return;
    const route = { kind, value, sourceUrl };
    // Only what the engine contract accepts: one plain address, a number, a form page, each with the http(s) page it came from.
    if (!engineContactRouteSchema.safeParse(route).success) return;
    seen.add(`${kind}:${value}`);
    routes.push(route);
  };
  for (const page of pages) {
    for (const link of page.links) {
      if (/^mailto:/i.test(link.href)) { const email = normalizeEmail(safeDecode(link.href.slice(7))); if (email && plausibleEmail(email)) add("email", email, page.url); }
      else if (/^tel:/i.test(link.href)) add("phone", normalizePhone(safeDecode(link.href.slice(4))), page.url);
      else { const number = whatsappNumber(link.href); if (number) add("whatsapp", number, page.url); }
    }
    for (const line of page.lines) {
      for (const email of extractEmails(line)) if (plausibleEmail(email)) add("email", email, page.url);
      for (const phone of visiblePhones(line)) add("phone", phone, page.url);
    }
    if (page.forms.enquiry) add("website_form", page.url, page.url);
  }
  return routes;
}
function safeDecode(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }

// ---- An offer's own phrases ---------------------------------------------------------------------------------------------------

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Spaces and hyphens (and the dashes pages use for them) between a phrase's words. */
const GAP = "[\\s\\-\\u2010\\u2011\\u2013\\u2014]";
/**
 * One word of a phrase with its simple variants: enquiry or inquiry, and a plain plural ("dealer" and "dealers", "company" and
 * "companies", "branch" and "branches", "OEM" and "OEMs"). Other short words ("a", "our") and words with digits or signs are matched as written.
 */
function wordVariants(word: string): string {
  if (/^(?:en|in)quir(?:y|ies)$/i.test(word)) return "(?:en|in)quir(?:y|ies)";
  if (/^[A-Z]{2,6}$/.test(word)) return `${word}s?`;
  if (word.length < 4 || !/^\p{L}+$/u.test(word)) return escapeRegex(word).replace(/['’]/g, "['’]");
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}(?:y|ies)`;
  if (/[^aeiou]ies$/i.test(word)) return `${word.slice(0, -3)}(?:y|ies)`;
  if (/(?:ch|sh|x|z)es$/i.test(word)) return `${word.slice(0, -2)}(?:es)?`;
  if (/[^siu]s$/i.test(word)) return `${word.slice(0, -1)}(?:e?s)?`;
  return `${word}(?:e?s)?`;
}
/**
 * A phrase from an offer packet as a pattern: any case, any spaces or hyphens between its words ("e-commerce", "e commerce" and
 * "ecommerce" are one), each word with its variants, and never inside a longer word. Null for a phrase with no words in it.
 */
export function phrasePattern(phrase: string): RegExp | null {
  const words = phrase.split(new RegExp(`${GAP}+`, "u")).filter(Boolean);
  return words.length ? new RegExp(`(?<![\\p{L}\\p{N}])${words.map(wordVariants).join(`${GAP}*`)}(?![\\p{L}\\p{N}])`, "iu") : null;
}
/** Any of the phrases (an offer's negatives, say) as one pattern; undefined when there are none. */
export function anyPhrase(phrases: readonly string[]): RegExp | undefined {
  const sources = phrases.flatMap((phrase) => phrasePattern(phrase)?.source ?? []);
  return sources.length ? new RegExp(sources.map((source) => `(?:${source})`).join("|"), "iu") : undefined;
}

// ---- Signals: word-for-word quotes --------------------------------------------------------------------------------------------

/** A signal the finder quotes when a line matches it: the built-in dealer ones below, or an offer's own look-for phrases. */
export type SignalPattern = { key: string; claim: string; pattern: RegExp };
/** An offer packet's look-for phrases as signals, in the packet's order: the claim is what the phrase means for the offer. */
export function offerSignals(lookFor: readonly { phrase: string; meaning: string }[]): SignalPattern[] {
  return lookFor.flatMap((item, index) => { const pattern = phrasePattern(item.phrase); return pattern ? [{ key: `offer_${index + 1}`, claim: item.meaning.slice(0, 500), pattern }] : []; });
}

const enquiry = "(?:enquiry|inquiry|enquiries|inquiries)";
/** The built-in phrases the finder quotes, best first: they still find dealer-led sellers, and come after the run's offer signals. */
export const SIGNALS: SignalPattern[] = [
  { key: "dealer_wanted", claim: "Invites new dealers or distributors", pattern: /\b(become (?:a|an|our) (?:authori[sz]ed )?(?:dealer|distributor|stockist)s?|(?:dealers?|distributors?|stockists?) (?:wanted|required)|dealership opportunit(?:y|ies)|apply for (?:a )?(?:dealership|distributorship))\b/i },
  { key: "dealer_enquiry", claim: "Takes dealer enquiries", pattern: new RegExp(`\\bdealer(?:ship)? ${enquiry}\\b`, "i") },
  { key: "distributor_enquiry", claim: "Takes distributor enquiries", pattern: new RegExp(`\\bdistributor(?:ship)? ${enquiry}\\b`, "i") },
  { key: "dealer_network", claim: "Sells through a dealer network", pattern: /\b(our (?:authori[sz]ed )?(?:dealers|distributors)|(?:dealer|distributor) network)\b/i },
  { key: "wholesale", claim: "Sells wholesale", pattern: /\bwholesal(?:e|er|ers)\b/i },
  { key: "bulk_enquiry", claim: "Takes bulk enquiries", pattern: new RegExp(`\\bbulk (?:${enquiry.slice(3, -1)}|orders?)\\b`, "i") },
  { key: "price_list", claim: "Publishes a price or rate list", pattern: /\b(price ?list|rate ?list)s?\b/i },
  { key: "price_on_request", claim: "Gives prices on request", pattern: /\b(call (?:us )?for (?:the )?(?:best )?prices?|whats ?app (?:us )?for (?:the )?(?:best )?prices?)\b/i },
  { key: "request_quote", claim: "Asks buyers to request a quote", pattern: /\b(request (?:a |for (?:a )?)?quot(?:e|ation)|get (?:a )?quot(?:e|ation))\b/i },
  { key: "catalogue", claim: "Offers a catalogue or brochure to download", pattern: /\bdownload (?:our |the )?(?:product |e-?)?(catalogue|catalog|brochure)s?\b/i },
];
const DEALER_LOGIN_TEXT = /\b(dealer|distributor|partner|retailer|stockist)s?'? ?(login|log in|sign in|signin|portal|zone|corner)\b/i;
const DEALER_LOGIN_PATH = /(dealer|distributor|partner|retailer|stockist)s?[-_/]?(login|portal|signin|sign-in|zone)/i;
/** GSTIN and PAN numbers: a quote that carries one is not kept. */
const TAX_ID = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b|\b[A-Z]{5}\d{4}[A-Z]\b/;
const MAX_QUOTE_WORDS = 25;

/** At most 25 words of `line` around the match starting at `index`, exactly as written there (the line already has one space between words). */
export function quoteAround(line: string, index: number): string {
  const words = line.split(" ");
  let first = 0;
  for (let position = 0, at = 0; position < words.length; position++) { if (at + words[position]!.length > index) { first = position; break; } at += words[position]!.length + 1; }
  // Up to 8 words before the match, and the window filled to 25 words when the line ends soon after it.
  const start = Math.max(0, Math.min(first - 8, words.length - MAX_QUOTE_WORDS));
  return words.slice(start, start + MAX_QUOTE_WORDS).join(" ").slice(0, 1_000).trim();
}

/** How much a line says: a sentence (punctuation, eight words or more) beats a menu line like "Home Products Become a Dealer". */
const lineWeight = (line: string) => (/[.!?,;:]/.test(line) ? 2 : 0) + (line.split(" ").length >= 8 ? 1 : 0);

/**
 * One quote per kind of signal (the first line that says the most), and a dealer login or portal, if the site shows one. The offer's
 * signals (`offer`, from offerSignals) come first, so the first one found becomes the lead's observed signal; a built-in signal that
 * matched the very words an offer signal quotes (the packet's "dealer enquiry" and the built-in one, say) is left out.
 */
export function siteSignals(pages: readonly ParsedPage[], offer: readonly SignalPattern[] = []): { signals: FinderSignal[]; dealerPortal?: { quote: string; url: string } } {
  const found = new Map<string, FinderSignal & { weight: number; line: string; start: number; end: number }>();
  const all = [...offer, ...SIGNALS];
  let dealerPortal: { quote: string; url: string } | undefined;
  for (const page of pages) {
    for (const line of page.lines) {
      if (TAX_ID.test(line)) continue;
      const weight = lineWeight(line);
      for (const signal of all) {
        if ((found.get(signal.key)?.weight ?? -1) >= weight) continue;
        const match = signal.pattern.exec(line);
        if (match) found.set(signal.key, { key: signal.key, claim: signal.claim, quote: quoteAround(line, match.index), url: page.url, weight, line, start: match.index, end: match.index + match[0].length });
      }
      const login = !dealerPortal && DEALER_LOGIN_TEXT.exec(line);
      if (login) dealerPortal = { quote: quoteAround(line, login.index), url: page.url };
    }
    if (!dealerPortal) {
      const link = page.links.find((item) => /^https?:/i.test(item.href) && (DEALER_LOGIN_TEXT.test(item.text) || DEALER_LOGIN_PATH.test(pathOf(item.href))));
      if (link) dealerPortal = { quote: (link.text || pathOf(link.href)).slice(0, 300), url: page.url };
    }
  }
  const hits = (list: readonly SignalPattern[]) => list.flatMap((signal) => found.get(signal.key) ?? []);
  const own = hits(offer);
  const repeats = (hit: (typeof own)[number]) => own.some((item) => item.url === hit.url && item.line === hit.line && hit.start < item.end && item.start < hit.end);
  const signals = [...own, ...hits(SIGNALS).filter((hit) => !repeats(hit))].map(({ key, claim, quote, url }) => ({ key, claim, quote, url }));
  return { signals, ...(dealerPortal ? { dealerPortal } : {}) };
}

// ---- Where the company is ---------------------------------------------------------------------------------------------------------

/** The state of an Indian PIN code, for the regions the finder knows by PIN (other states come from their names). */
export function pinState(pin: string): string | undefined {
  if (pin.startsWith("403")) return "Goa"; // inside Maharashtra's 40-44, but Goa's own
  const prefix = Number(pin.slice(0, 2));
  if (prefix === 49) return "Chhattisgarh";
  if (prefix >= 45 && prefix <= 48) return "Madhya Pradesh";
  if (prefix >= 40 && prefix <= 44) return "Maharashtra";
  if (prefix >= 75 && prefix <= 77) return "Odisha";
  return undefined;
}

const STATES: [string, RegExp][] = [
  ["Chhattisgarh", /\b(chhattisgarh|chattisgarh|chhatisgarh)\b|\(\s*c\.?\s?g\.?\s*\)/i], ["Madhya Pradesh", /\bmadhya pradesh\b|\(\s*m\.?\s?p\.?\s*\)/i], ["Maharashtra", /\bmaharashtra\b|\(\s*m\.?\s?s\.?\s*\)/i], ["Odisha", /\b(odisha|orissa)\b/i],
  ["Gujarat", /\bgujarat\b/i], ["Rajasthan", /\brajasthan\b/i], ["Uttar Pradesh", /\buttar pradesh\b|\(\s*u\.?\s?p\.?\s*\)/i], ["Bihar", /\bbihar\b/i], ["Jharkhand", /\bjharkhand\b/i], ["West Bengal", /\bwest bengal\b/i],
  ["Telangana", /\btelangana\b/i], ["Andhra Pradesh", /\bandhra pradesh\b/i], ["Karnataka", /\bkarnataka\b/i], ["Tamil Nadu", /\btamil ?nadu\b/i], ["Kerala", /\bkerala\b/i], ["Punjab", /\bpunjab\b/i],
  ["Haryana", /\bharyana\b/i], ["Delhi", /\b(new )?delhi\b/i], ["Goa", /\bgoa\b/i], ["Assam", /\bassam\b/i], ["Uttarakhand", /\buttarakhand\b/i], ["Himachal Pradesh", /\bhimachal pradesh\b/i], ["Jammu and Kashmir", /\bjammu (and|&) kashmir\b/i],
];
/** Common cities, each with its state (and other spellings). Names that are also common words or surnames are left out. */
const CITIES: [string, string, ...string[]][] = [
  ...["Raipur", "Bhilai", "Durg", "Bilaspur", "Korba", "Rajnandgaon", "Raigarh", "Jagdalpur", "Ambikapur", "Dhamtari", "Mahasamund", "Kawardha", "Janjgir", "Kanker", "Bemetara", "Balod"].map((city): [string, string] => [city, "Chhattisgarh"]),
  ...["Indore", "Bhopal", "Jabalpur", "Gwalior", "Ujjain", "Dewas", "Satna", "Ratlam", "Rewa", "Katni", "Singrauli", "Burhanpur", "Khandwa", "Khargone", "Chhindwara", "Morena", "Bhind", "Shivpuri", "Vidisha", "Mandsaur", "Neemuch", "Pithampur", "Itarsi", "Betul", "Seoni", "Balaghat", "Damoh", "Chhatarpur", "Shahdol"].map((city): [string, string] => [city, "Madhya Pradesh"]),
  ["Narmadapuram", "Madhya Pradesh", "Hoshangabad"],
  ...["Pune", "Nagpur", "Thane", "Navi Mumbai", "Solapur", "Kolhapur", "Amravati", "Akola", "Jalgaon", "Latur", "Nanded", "Sangli", "Satara", "Chandrapur", "Wardha", "Yavatmal", "Bhiwandi", "Vasai", "Dhule", "Malegaon", "Gondia", "Bhandara"].map((city): [string, string] => [city, "Maharashtra"]),
  ["Mumbai", "Maharashtra", "Bombay"], ["Nashik", "Maharashtra", "Nasik"], ["Chhatrapati Sambhajinagar", "Maharashtra", "Aurangabad"], ["Ahilyanagar", "Maharashtra", "Ahmednagar"], ["Pimpri-Chinchwad", "Maharashtra", "Pimpri", "Chinchwad"],
  ...["Cuttack", "Rourkela", "Sambalpur", "Jharsuguda", "Angul", "Bargarh", "Jajpur", "Bhadrak", "Baripada"].map((city): [string, string] => [city, "Odisha"]),
  ["Bhubaneswar", "Odisha", "Bhubaneshwar"], ["Berhampur", "Odisha", "Brahmapur"], ["Balasore", "Odisha", "Baleswar"],
  ["New Delhi", "Delhi"], ["Kolkata", "West Bengal", "Calcutta"], ["Chennai", "Tamil Nadu", "Madras"], ["Bengaluru", "Karnataka", "Bangalore"], ["Hyderabad", "Telangana"], ["Secunderabad", "Telangana"],
  ["Ahmedabad", "Gujarat"], ["Surat", "Gujarat"], ["Vadodara", "Gujarat", "Baroda"], ["Rajkot", "Gujarat"], ["Jaipur", "Rajasthan"], ["Jodhpur", "Rajasthan"], ["Udaipur", "Rajasthan"], ["Lucknow", "Uttar Pradesh"], ["Kanpur", "Uttar Pradesh"],
  ["Noida", "Uttar Pradesh"], ["Ghaziabad", "Uttar Pradesh"], ["Agra", "Uttar Pradesh"], ["Varanasi", "Uttar Pradesh"], ["Gurugram", "Haryana", "Gurgaon"], ["Faridabad", "Haryana"], ["Ludhiana", "Punjab"], ["Amritsar", "Punjab"], ["Chandigarh", "Chandigarh"],
  ["Patna", "Bihar"], ["Ranchi", "Jharkhand"], ["Jamshedpur", "Jharkhand"], ["Coimbatore", "Tamil Nadu"], ["Kochi", "Kerala", "Cochin"], ["Visakhapatnam", "Andhra Pradesh", "Vizag"], ["Vijayawada", "Andhra Pradesh"], ["Guwahati", "Assam"], ["Dehradun", "Uttarakhand"],
];
/** Every city name and spelling in one pattern (each line is scanned once), and the city and state each spelling stands for. */
const cityKey = (name: string) => name.toLowerCase().replace(/[-\s]+/g, "");
const CITY_BY_KEY = new Map(CITIES.flatMap(([city, state, ...aliases]) => [city, ...aliases].map((name) => [cityKey(name), { city, state }] as const)));
const ANY_CITY = new RegExp(`\\b(${CITIES.flatMap(([city, , ...aliases]) => [city, ...aliases]).map((name) => name.replace(/[-\s]/g, "[-\\s]?")).join("|")})\\b`, "gi");
const citiesIn = (text: string) => [...text.matchAll(ANY_CITY)].flatMap((match) => CITY_BY_KEY.get(cityKey(match[1]!)) ?? []);
/** A six-digit PIN (not part of a longer number), or "PIN 492 001" written with a space. */
const PIN = /(?<![\d+])(?<!\d[.,/])([1-8]\d{5})(?!\d)(?![.,/]\d)|\bpin(?:\s?code)?\s*[:.-]?\s*([1-8]\d{2}\s\d{3})\b/gi;
/** A line with an address on it: an address word near the number, or "City - 492001". */
const ADDRESS_CUE = /\b(pin|pincode|p\.?o|road|rd|nagar|marg|street|colony|sector|plot|near|opp|area|district|dist|city|india|address|chowk|bazar|bazaar|market|industrial|estate|phase|mandi|ward|tehsil|village|post|block|floor|complex|building|lane|highway|gidc|midc)\b|[-–]\s?[1-8]\d{5}\b/i;
const ADDRESS_WORDS = new Set(["road", "nagar", "marg", "street", "colony", "sector", "area", "phase", "estate", "india", "pin", "code", "pincode", "district", "dist", "near", "opp", "plot", "block", "floor", "tehsil", "village", "post", "market", "chowk", "complex", "building", "lane", "highway", "industrial", "office", "address"]);

const stateNamed = (text: string) => STATES.find(([, pattern]) => pattern.test(text))?.[0];
const cityIn = (text: string, state?: string) => citiesIn(text).find((item) => !state || item.state === state)?.city;
/** The capitalised word or two right before a PIN ("Shankar Nagar, Raipur - 492007" gives "Raipur"), when it is not an address word. */
function wordBeforePin(line: string, index: number): string | undefined {
  const match = /([A-Z][A-Za-z]{2,}(?:[ -][A-Z][A-Za-z]{2,})?)\s*(?:\([^)]{1,15}\))?\s*[-–,:]?\s*(?:pin(?:\s?code)?\s*[-:.]?\s*)?$/i.exec(line.slice(Math.max(0, index - 60), index));
  const name = match?.[1];
  if (!name || !/^[A-Z]/.test(name)) return undefined;
  const last = name.toLowerCase().split(/[ -]/).pop()!;
  return ADDRESS_WORDS.has(last) || stateNamed(name) ? undefined : name;
}

/** City, state (region) and whether this is an Indian business; contact pages first, then the order the pages were read. */
export function locate(pages: readonly ParsedPage[]): { city?: string; region?: string; states: string[]; indian: boolean } {
  const ordered = [...pages].sort((a, b) => Number(/contact|reach|enquir|inquir/i.test(pathOf(b.url))) - Number(/contact|reach|enquir|inquir/i.test(pathOf(a.url))));
  const states = new Set<string>();
  const stateCount = new Map<string, number>();
  const cityCount = new Map<string, number>();
  let city: string | undefined, region: string | undefined, indian = false;
  for (const page of ordered) {
    for (const line of page.lines) {
      for (const [name, pattern] of STATES) if (pattern.test(line)) { states.add(name); stateCount.set(name, (stateCount.get(name) ?? 0) + 1); }
      const named = citiesIn(line);
      for (const item of named) cityCount.set(item.city, (cityCount.get(item.city) ?? 0) + 1);
      if (!ADDRESS_CUE.test(line) && !stateNamed(line) && !named.length) continue;
      for (const match of line.matchAll(PIN)) {
        const pin = (match[1] ?? match[2] ?? "").replace(/\s/g, "");
        const state = pinState(pin) ?? stateNamed(line) ?? named[0]?.state;
        indian = true;
        if (state) states.add(state);
        if (!region && state) { region = state; city = cityIn(line, state) ?? wordBeforePin(line, match.index ?? 0); }
      }
    }
  }
  const most = (counts: Map<string, number>, keep: (name: string) => boolean = () => true) => [...counts].filter(([name]) => keep(name)).sort((a, b) => b[1] - a[1])[0]?.[0];
  region ??= most(stateCount);
  city ??= most(cityCount, (name) => !region || CITIES.find(([known]) => known === name)?.[1] === region);
  if (city && !region) region = CITIES.find(([known]) => known === city)?.[1];
  if (region) states.add(region);
  return { ...(city ? { city } : {}), ...(region ? { region } : {}), states: [...states], indian: indian || states.size > 0 };
}

// ---- Category ----------------------------------------------------------------------------------------------------------------------

const TRADE_WORDS = new Set(["dealer", "dealers", "distributor", "distributors", "manufacturer", "manufacturers", "supplier", "suppliers", "company", "companies", "shop", "shops", "store", "stores", "wholesale", "wholesaler", "wholesalers", "retail", "retailer", "retailers", "trader", "traders", "and", "the", "for", "with", "in", "of"]);
/** The run's category that the pages talk about most (its own words, not trade words like "dealer"), or none when none is mentioned. */
export function guessCategory(pages: readonly ParsedPage[], categories: readonly string[]): string | undefined {
  const text = pages.flatMap((page) => [page.title, page.siteName, ...page.lines.slice(0, 400)]).join("\n").toLowerCase();
  let best: { category: string; score: number } | undefined;
  for (const category of categories) {
    const words = category.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    const own = words.filter((word) => !TRADE_WORDS.has(word));
    const terms = own.length ? own : [category.toLowerCase().trim()];
    const score = terms.reduce((total, term) => {
      const stem = term.replace(/(es|s)$/, "");
      const pattern = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`, "g");
      return total + (text.match(pattern)?.length ?? 0);
    }, 0);
    if (score > 0 && (!best || score > best.score)) best = { category, score };
  }
  return best?.category.slice(0, 200);
}

// ---- Is this a company's own site? ----------------------------------------------------------------------------------------------

/** Why these pages are not one company's own website, or undefined when they are. `hit` is the search result that led here. */
export function notACompany(pages: readonly ParsedPage[], routes: readonly FinderRoute[], hit?: { url: string; title: string }): string | undefined {
  const home = pages[0];
  if (!home) return "nothing could be read";
  const host = siteHost(home.url);
  const hitHost = hit ? siteHost(hit.url) : host;
  if (isNotCompanyHost(host) || isNotCompanyHost(hitHost)) return "a directory or marketplace, not the company's own site";
  if (under(host, MARKET_RESEARCH) || LISTICLE.test(hit?.title ?? "") || LISTICLE.test(home.title)) return "a market-research or listicle page";
  if (under(host, PUBLISHERS)) return "a news or blog site";
  const ownLinks = home.links.filter((link) => /^https?:/i.test(link.href) && siteHost(link.href) === host);
  const articleLinks = ownLinks.filter((link) => ARTICLE_PATH.test(pathOf(link.href))).length;
  const articleHit = Boolean(hit && ARTICLE_PATH.test(pathOf(hit.url)));
  if (home.ogType === "article" || home.jsonLdTypes.some((type) => ARTICLE_TYPES.has(type)) || (articleLinks >= 8 && articleLinks >= ownLinks.length * 0.4) || (articleHit && PUBLISHER_NAME.test(`${home.siteName} ${home.title}`))) return "a news, blog or article site";
  const presence = routes.length > 0 || ownLinks.some((link) => kindOf(link) !== undefined) || pages.some((page) => page.lines.some((line) => BUSINESS_WORDS.test(line)));
  return presence ? undefined : "no contact, about or product pages";
}

/**
 * Everything the finder keeps about one site, from its pages (home first). `categories` are the run's (its plan's, then its offer's
 * industries) and `signals` its offer's look-for phrases (offerSignals), quoted ahead of the built-in ones.
 */
export function siteFacts(input: { pages: readonly ParsedPage[]; hit?: { url: string; title: string }; categories: readonly string[]; signals?: readonly SignalPattern[] }): SiteFacts {
  const home = input.pages[0]!;
  const finalUrl = new URL(home.url);
  const domain = siteHost(home.url);
  const routes = contactRoutes(input.pages);
  const { signals, dealerPortal } = siteSignals(input.pages, input.signals);
  const place = locate(input.pages);
  const category = guessCategory(input.pages, input.categories);
  const notCompany = notACompany(input.pages, routes, input.hit);
  const companyName = guessCompany(home.siteName || home.title || input.hit?.title || "", domain).slice(0, 200) || domain;
  const indian = place.indian || routes.some((route) => route.value.startsWith("+91")) || /\.in$/.test(domain);
  return {
    domain, website: `${finalUrl.protocol}//${finalUrl.host}/`, companyName, routes, signals, ...(dealerPortal ? { dealerPortal } : {}),
    ...(place.city ? { city: place.city.slice(0, 120) } : {}), ...(place.region ? { region: place.region } : {}), ...(indian ? { country: "India" } : {}), states: place.states,
    ...(category ? { category } : {}), ...(notCompany ? { notCompany } : {}),
  };
}
