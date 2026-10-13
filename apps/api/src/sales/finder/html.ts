// What the built-in lead finder reads from one HTML page, without running anything on it: the title and og:site_name, the visible text
// (scripts, styles and noscript removed, entities decoded) as lines, the links with their text and absolute address (web, mailto:, tel:
// and WhatsApp), and whether it has an enquiry form or a login form. Page text is data, never instructions.
import { clean } from "../../mcp/format.js";

export type PageLink = { href: string; text: string };
export type ParsedPage = {
  url: string; title: string; siteName: string; ogType: string; jsonLdTypes: string[];
  lines: string[]; links: PageLink[]; forms: { count: number; enquiry: boolean; login: boolean };
};

const MAX_LINES = 5_000;
const MAX_LINKS = 1_000;
/** Lines longer than this are cut at sentence ends, so contact details inside one huge block of text can still be found. */
const LONG_LINE = 1_500;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷", rarr: "→", larr: "←", laquo: "«", raquo: "»",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", shy: "", zwj: "", zwnj: "", frac12: "½", frac14: "¼", frac34: "¾", plusmn: "±", micro: "µ", acute: "´",
};

/** HTML character references (named, decimal and hex) as the characters they stand for; unknown ones stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? match;
  });
}

// Page HTML comes from any website, so every scan below runs in time linear in the page. A pattern like /<a\b[^>]*>[\s\S]*?<\/a>/g scans
// to the end of the page from each tag it cannot close, and a page of unclosed tags then takes minutes in the API process. The helpers
// below find the same tags as those patterns, but stop as soon as nothing later could match.

/**
 * Replaces each `pattern` match with `by`, where `pattern` is a tag ending in `[^>]*>`. Such a tag can only fail where no ">" follows,
 * and then it rescans to the end from every "<": past the last ">" nothing is tried.
 */
export function replaceTags(html: string, pattern: RegExp, by: string): string {
  const end = html.lastIndexOf(">") + 1;
  return html.slice(0, end).replace(pattern, by) + html.slice(end);
}

/** Every `pattern` match (a tag ending in `[^>]*>`), searched only up to the last ">" for the same reason. */
const matchTags = (html: string, pattern: RegExp) => [...html.slice(0, html.lastIndexOf(">") + 1).matchAll(pattern)];

type Element = { attrs: string; inner: string; start: number; end: number };

/**
 * Each `<tag ...>inner</tag>`, in order, as /<tag\b([^>]*)>([\s\S]*?)<\/tag\s*>/gi finds them. When a tag has no ">" or no closing tag
 * after it, no later one can have one either, so the search stops there instead of trying the rest of the page again.
 */
function* elements(html: string, tag: string, keep: (attrs: string) => boolean = () => true): Generator<Element> {
  const open = new RegExp(`<${tag}\\b`, "gi");
  const close = new RegExp(`<\\/${tag}\\s*>`, "gi");
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const gt = html.indexOf(">", open.lastIndex);
    if (gt < 0) return;
    const attrs = html.slice(open.lastIndex, gt);
    // A tag the caller skips: any tag that starts inside its attributes ends at the same ">", with a part of the same attributes.
    if (!keep(attrs)) { open.lastIndex = gt + 1; continue; }
    close.lastIndex = gt + 1;
    const closing = close.exec(html);
    if (!closing) return;
    yield { attrs, inner: html.slice(gt + 1, closing.index), start: match.index, end: close.lastIndex };
    open.lastIndex = close.lastIndex;
  }
}

/** `html` without its comments, as html.replace(/<!--[\s\S]*?-->/g, " "): an unclosed comment means no later one closes either. */
function withoutComments(html: string): string {
  let out = "", from = 0;
  for (let start = html.indexOf("<!--"); start >= 0; start = html.indexOf("<!--", from)) {
    const end = html.indexOf("-->", start + 4);
    if (end < 0) break;
    out += `${html.slice(from, start)} `;
    from = end + 3;
  }
  return out + html.slice(from);
}

/**
 * `html` without each `<name ...>...</name>` of the given names (the closing tag must name the same one), each replaced by a space, as
 * /<(script|style|...)\b[\s\S]*?<\/\1\s*>/gi does: a name with no closing tag left is not looked for again.
 */
export function withoutElements(html: string, names: readonly string[]): string {
  const open = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const unclosed = new Set<string>();
  let out = "", from = 0;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const name = match[1]!.toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`<\\/${name}\\s*>`, "gi");
    close.lastIndex = open.lastIndex;
    const closing = close.exec(html);
    if (!closing) { unclosed.add(name); continue; }
    out += `${html.slice(from, match.index)} `;
    from = open.lastIndex = close.lastIndex;
  }
  return out + html.slice(from);
}

/** `html` without its first `<title>...</title>`, as html.replace(/<title\b[\s\S]*?<\/title\s*>/i, " "). */
function withoutFirstTitle(html: string): string {
  const open = /<title\b/gi;
  const match = open.exec(html);
  if (!match) return html;
  const close = /<\/title\s*>/gi;
  close.lastIndex = open.lastIndex;
  const closing = close.exec(html);
  return closing ? `${html.slice(0, match.index)} ${html.slice(close.lastIndex)}` : html;
}

/** The attributes of each <input> tag, as the pattern `<input\b[^>]*` reads them (to the end when no ">" follows). */
function inputTags(html: string): string[] {
  const found: string[] = [];
  const open = /<input\b/gi;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const gt = html.indexOf(">", open.lastIndex);
    found.push(html.slice(open.lastIndex, gt < 0 ? html.length : gt));
    if (gt < 0) break;
    // An <input that starts inside these attributes reads a part of them: nothing new.
    open.lastIndex = gt + 1;
  }
  return found;
}

const CONTACT_FIELD = /e-?mail|phone|mobile|contact|enquiry|inquiry|requirement|company/i;
/** Does a name= in these attributes ask for contact details, as /name\s*=\s*["']?[^"'\s>]*(e-?mail|phone|...)/i would say, reading each value once? */
function namesContactField(attrs: string): boolean {
  const name = /name\s*=\s*["']?/gi;
  const value = /[^"'\s>]*/y;
  for (let match = name.exec(attrs); match; match = name.exec(attrs)) {
    value.lastIndex = name.lastIndex;
    const token = value.exec(attrs)![0];
    if (CONTACT_FIELD.test(token)) return true;
    // A "name=" inside this value has a part of it as its own value: already read.
    name.lastIndex += token.length;
  }
  return false;
}

/** One line of text: entities decoded, hidden characters removed, white space collapsed. */
const textOf =(html: string) => clean(decodeEntities(replaceTags(html, /<[^>]*>/g, " "))).replace(/\s+/g, " ").trim();

/** The attributes of one tag ("href", "content"...), lower-cased names, decoded values. */
export function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!(name in found)) found[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
  }
  return found;
}

/** The "@type" values of the page's JSON-LD blocks (NewsArticle, Organization...), read as data only. */
function jsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || types.size >= 20 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) visit(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    for (const type of [record["@type"]].flat()) if (typeof type === "string") types.add(type.slice(0, 60));
    if (record["@graph"]) visit(record["@graph"], depth + 1);
  };
  for (const script of elements(html, "script", (attrs) => /type\s*=\s*["']?application\/ld\+json/i.test(attrs))) {
    try { visit(JSON.parse(script.inner.slice(0, 100_000)), 0); } catch { /* not JSON: ignored */ }
  }
  return [...types];
}

/** A link's absolute address, kept when it is a web page, an email or a phone number; anything else (javascript:, data:...) is dropped. */
function absolute(href: string, base: string): string | undefined {
  const value = href.trim();
  if (!value || value.startsWith("#")) return undefined;
  if (/^(mailto|tel):/i.test(value)) return value.slice(0, 500);
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href.slice(0, 2_000);
  } catch { return undefined; }
}

/** Splits text into lines at block tags; very long lines are cut again at sentence ends. */
function visibleLines(html: string): string[] {
  const block = /<\/?(?:p|div|br|li|ul|ol|dl|dt|dd|h[1-6]|tr|td|th|table|thead|tbody|tfoot|section|article|header|footer|nav|aside|main|address|blockquote|figure|figcaption|pre|hr|form|fieldset|legend|label|option|select|button|summary|details|caption)\b[^>]*>/gi;
  const lines: string[] = [];
  for (const raw of replaceTags(html, block, "\n").split("\n")) {
    const line = textOf(raw);
    if (!line) continue;
    if (line.length <= LONG_LINE) { lines.push(line); continue; }
    let chunk = "";
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (chunk && chunk.length + sentence.length + 1 > LONG_LINE) { lines.push(chunk); chunk = ""; }
      chunk = chunk ? `${chunk} ${sentence}` : sentence.slice(0, LONG_LINE * 2);
    }
    if (chunk) lines.push(chunk);
    if (lines.length >= MAX_LINES) break;
  }
  return lines.slice(0, MAX_LINES);
}

/** Reads one page. `pageUrl` is where it was finally read (after redirects); links are resolved against it or the page's <base>. */
export function parseHtml(html: string, pageUrl: string): ParsedPage {
  const types = jsonLdTypes(html);
  // Nothing that runs or hides is text: scripts, styles, noscript, templates, inline SVG, frames, and comments.
  const stripped = withoutElements(withoutComments(html), ["script", "style", "noscript", "template", "svg", "iframe", "object", "canvas"])
    .replace(/<(script|style|noscript|template)\b[\s\S]*$/i, " ");
  const metas = matchTags(stripped, /<meta\b([^>]*)>/gi).map((match) => attributes(match[1]!));
  const meta = (key: string) => metas.find((item) => (item.property ?? item.name ?? "").toLowerCase() === key)?.content ?? "";
  const baseHref = matchTags(stripped, /<base\b([^>]*)>/gi)[0];
  const base = (baseHref && absolute(attributes(baseHref[1]!).href ?? "", pageUrl)) || pageUrl;
  const links: PageLink[] = [];
  for (const anchor of elements(stripped, "a")) {
    if (links.length >= MAX_LINKS) break;
    const attrs = attributes(anchor.attrs);
    const href = absolute(attrs.href ?? "", base);
    if (!href) continue;
    links.push({ href, text: (textOf(anchor.inner) || clean(attrs["aria-label"] ?? attrs.title ?? "").replace(/\s+/g, " ").trim()).slice(0, 300) });
  }
  let count = 0, enquiry = false, login = false;
  for (const form of elements(stripped, "form")) {
    count++;
    const inputs = inputTags(form.inner);
    const isLogin = inputs.some((attrs) => /type\s*=\s*["']?password/i.test(attrs));
    login ||= isLogin;
    // An enquiry form asks for a message, or for contact details; a login form or a site search box is not one.
    if (!isLogin && (/<textarea\b/i.test(form.inner) || inputs.some(namesContactField))) enquiry = true;
  }
  const title = elements(stripped, "title").next().value;
  return {
    url: pageUrl, title: textOf(title?.inner ?? "").slice(0, 300), siteName: clean(meta("og:site_name") || meta("application-name")).replace(/\s+/g, " ").trim().slice(0, 200),
    ogType: meta("og:type").toLowerCase().slice(0, 40), jsonLdTypes: types, lines: visibleLines(withoutFirstTitle(stripped)), links, forms: { count, enquiry, login },
  };
}
