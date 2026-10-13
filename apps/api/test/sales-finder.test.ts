import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after } from "node:test";
import { FINDER_SYSTEM, finderStatusSchema, offerPacketSchema, successEnvelope } from "@venture-studio/contracts";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { AppDb } from "../src/db.js";
import { connectDatabase, type Database } from "../src/db.js";
import { ensureIndexes } from "../src/indexes.js";
import { LocalObjectStore } from "../src/storage.js";
import { STALE_CLAIM_MS } from "../src/sales/engine.js";
import { contactRoutes, locate, notACompany, offerSignals, phrasePattern, pickPages, pinState, quoteAround, siteFacts, siteSignals } from "../src/sales/finder/extract.js";
import { checkUrl, createReader, isPublicAddress, looksLikeChallenge, safeAddress, type FetchImpl, type LookupImpl } from "../src/sales/finder/fetch.js";
import { parseHtml } from "../src/sales/finder/html.js";
import { buildQueries, countryOf, negativesOf, searchSites, searchStats, type SearchFn } from "../src/sales/finder/plan.js";
import { OFFERS, OFFER_VERSIONS } from "../src/sales/offers.js";
import { RobotsCache, parseRobots, robotsAllows } from "../src/sales/finder/robots.js";
import { FINDER_WORKER, NO_KEY_NOTE, createFinder, finderEnabled } from "../src/sales/finder/runner.js";

// The built-in lead finder (src/sales/finder): robots.txt, the SSRF guard, what is read from a company's own pages, the planner, and whole
// runs worked through the real lead rules on a throwaway database. No real network: every page, DNS answer and search result is a fake.

// ---- A tiny fake web --------------------------------------------------------------------------------------------------------------

type FakePage = { body: string; status?: number; headers?: Record<string, string> };
const html = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
/** A fake network: pages by exact URL (anything else is a 404), every request logged with its headers. */
function fakeWeb(pages: Record<string, FakePage | (() => FakePage | Promise<FakePage>)>) {
  const requests: { url: string; headers: Record<string, string>; address: string }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, address: init.address.address });
    const entry = pages[url];
    const page = typeof entry === "function" ? await entry() : entry;
    if (!page) return new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(page.body, { status: page.status ?? 200, headers: page.headers ?? { "content-type": url.endsWith("/robots.txt") ? "text/plain" : "text/html; charset=utf-8" } });
  };
  const hosts = () => new Set(requests.map((request) => new URL(request.url).hostname));
  return { fetchImpl, requests, hosts, asked: (prefix: string) => requests.filter((request) => request.url.startsWith(prefix)).map((request) => request.url) };
}
/** Every name is public (93.184.216.34) except the internal ones, which resolve to a private address. */
const lookupImpl: LookupImpl = async (hostname) => hostname.startsWith("internal.") ? [{ address: "10.0.0.7", family: 4 }] : hostname.startsWith("mixed.") ? [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.9", family: 4 }] : [{ address: "93.184.216.34", family: 4 }];
const ORIGIN = "http://localhost:3000";

// A company site with a dealer page, a contact page with a form, a footer address in Raipur and a dealer login link.
const GOOD = "https://www.goodpumps.example";
const goodSite: Record<string, FakePage> = {
  [`${GOOD}/`]: { body: html(
    `<nav><a href="/about-us">About Us</a> <a href="/products">Products</a> <a href="/become-a-dealer">Become a Dealer</a> <a href="/contact">Contact</a> <a href="https://portal.goodpumps.example/dealer-login">Dealer Login</a> <a href="/login">Login</a></nav>
     <h1>Submersible pumps &amp; motors for farms</h1><p>We manufacture pumps in Raipur since 1998. Download our product catalogue for the full range.</p>
     <footer><address>Plot 12, Urla Industrial Area, Raipur - 493221 (C.G.)</address><a href="tel:+91-98270-12345">Call us</a> <a href="https://wa.me/919827012345">WhatsApp</a></footer>
     <noscript>Enable JavaScript to see our dealer network</noscript><script>document.write("Become a dealer of the script")</script>`,
    `<title>Good Pumps | Submersible pump makers in Raipur</title><meta property="og:site_name" content="Good Pumps Pvt Ltd"><style>.dealer-network{}</style>`) },
  [`${GOOD}/become-a-dealer`]: { body: html("<h2>Dealers</h2><p>Dealers wanted across Chhattisgarh and Odisha. Become a dealer of Good Pumps and grow your business with our support team, marketing kits, training for your staff and fast delivery to your district every week of the year.</p>") },
  [`${GOOD}/contact`]: { body: html(`<p>Email: <a href="mailto:sales@goodpumps.example?subject=Enquiry">sales@goodpumps.example</a></p><p>Mobile: 98270 12345</p><p>GSTIN: 22AAACG1234A1Z5</p>
     <form action="/send" method="post"><input name="name"><input name="phone"><textarea name="message"></textarea><button>Send</button></form>`) },
  [`${GOOD}/about-us`]: { body: html("<p>Good Pumps makes submersible pumps and monoblock pumps for farmers and contractors.</p>") },
  [`${GOOD}/products`]: { body: html("<ul><li>Submersible pumps</li><li>Openwell pumps</li><li>Price list on request: call for price.</li></ul>") },
};
const parsedGood = () => [`${GOOD}/`, `${GOOD}/contact`, `${GOOD}/about-us`, `${GOOD}/become-a-dealer`, `${GOOD}/products`].map((url) => parseHtml(goodSite[url]!.body, url));

// ---- robots.txt ---------------------------------------------------------------------------------------------------------------------

test("robots.txt: the group naming the finder wins over '*', the longest rule decides (Allow on a tie), with * and $", () => {
  const named = parseRobots(["# rules", "User-agent: Googlebot", "Disallow: /", "", "User-agent: *", "Disallow: /", "", "User-agent: VentureStudioLeadFinder/1.0", "User-agent: OtherBot", "Disallow: /dealers", "Allow: /dealers/become", "Crawl-delay: 8"].join("\n"));
  assert.equal(robotsAllows(named, "/dealers/list"), false);
  assert.equal(robotsAllows(named, "/dealers/become-a-dealer"), true);
  assert.equal(robotsAllows(named, "/products"), true, "the '*' group does not apply once a group names the finder");
  assert.equal(named.crawlDelayMs, 8_000);
  const star = parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/open$\nDisallow: /*.pdf$\nDisallow: /tmp*/x\nAllow: /same\nDisallow: /same\nDisallow:\n");
  assert.equal(robotsAllows(star, "/private/x"), false);
  assert.equal(robotsAllows(star, "/private/open"), true);
  assert.equal(robotsAllows(star, "/private/open/more"), false, "$ ends the match");
  assert.equal(robotsAllows(star, "/files/list.pdf"), false);
  assert.equal(robotsAllows(star, "/files/list.pdf?page=2"), true);
  assert.equal(robotsAllows(star, "/tmp-files/x"), false);
  assert.equal(robotsAllows(star, "/same"), true, "Allow wins a tie");
  assert.equal(robotsAllows(star, "/robots.txt"), true);
  assert.equal(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "/anything"), true, "an empty Disallow allows everything");
  assert.equal(robotsAllows(parseRobots("Disallow: /\nUser-agent: Googlebot\nDisallow: /"), "/x"), true, "rules outside a group, or for other bots, do not apply");
  // A pattern full of stars stays fast on a long path.
  const started = Date.now();
  assert.equal(robotsAllows(parseRobots(`User-agent: *\nDisallow: /${"a*".repeat(40)}b$`), `/${"a".repeat(1_900)}`), true);
  assert.ok(Date.now() - started < 500);
});

test("robots.txt cache: fetched once per site, 4xx means no rules, 5xx or no answer closes the site until the next run", async () => {
  const answers: Record<string, { status: number; text: string } | { failed: string }> = {
    "https://a.example/robots.txt": { status: 200, text: "User-agent: *\nDisallow: /secret" }, "https://b.example/robots.txt": { status: 404, text: "" },
    "https://c.example/robots.txt": { status: 503, text: "" }, "https://d.example/robots.txt": { failed: "it took longer than 15 seconds to answer" }, "https://e.example/robots.txt": { status: 429, text: "" },
  };
  const asked: string[] = [];
  const cache = new RobotsCache(async (url) => { asked.push(url); return answers[url]!; });
  const signal = new AbortController().signal;
  const check = (url: string) => cache.check(new URL(url), signal);
  assert.equal((await check("https://a.example/products")).allowed, true);
  assert.equal((await check("https://a.example/secret/list")).allowed, false);
  assert.equal((await check("https://b.example/anything")).allowed, true);
  assert.equal((await check("https://c.example/")).allowed, false);
  assert.equal((await check("https://d.example/")).allowed, false);
  assert.equal((await check("https://e.example/")).allowed, false);
  await check("https://a.example/other");
  await check("https://c.example/again");
  assert.equal(asked.filter((url) => url.startsWith("https://a.example")).length, 1, "kept for 24 hours");
  assert.equal(asked.filter((url) => url.startsWith("https://c.example")).length, 1, "a site that did not answer stays closed this run");
  cache.newRun();
  await check("https://c.example/");
  await check("https://a.example/");
  assert.equal(asked.filter((url) => url.startsWith("https://c.example")).length, 2, "asked again on the next run");
  assert.equal(asked.filter((url) => url.startsWith("https://a.example")).length, 1);
});

// ---- The SSRF guard -------------------------------------------------------------------------------------------------------------

test("SSRF guard: private, loopback, link-local, CGNAT, multicast, reserved and mapped IPv6 addresses are refused", async () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:93.184.216.34", "[2606:4700::1]"]) assert.equal(isPublicAddress(address), true, address);
  for (const address of ["127.0.0.1", "127.8.9.1", "10.1.2.3", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "239.1.1.1", "255.255.255.255", "240.0.0.1", "198.18.0.1", "192.0.2.10",
    "::1", "::", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::a00:1", "2002:0a00:0001::1", "2001:db8::1", "2001::1", "not-an-ip"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(typeof checkUrl("ftp://files.example/x"), "string");
  assert.equal(typeof checkUrl("http://shop.example:8080/"), "string");
  assert.equal(typeof checkUrl("https://user:secret@shop.example/"), "string");
  assert.equal(typeof checkUrl("javascript:alert(1)"), "string");
  assert.ok(checkUrl("https://shop.example:443/a#b") instanceof URL);
  assert.ok(checkUrl("http://shop.example:80/") instanceof URL);
  assert.equal(typeof await safeAddress("internal.example", lookupImpl), "string");
  assert.equal(typeof await safeAddress("mixed.example", lookupImpl), "string", "one private answer among public ones is refused");
  assert.equal(typeof await safeAddress("localhost", lookupImpl), "string");
  assert.equal(typeof await safeAddress("[::1]", lookupImpl), "string");
  assert.equal(typeof await safeAddress("127.0.0.1", lookupImpl), "string");
  assert.deepEqual(await safeAddress("shop.example", lookupImpl), { address: "93.184.216.34", family: 4 });
});

test("the reader: redirects to private hosts are refused on every hop, robots.txt is obeyed, and challenges, refusals and non-HTML are reported", async () => {
  const web = fakeWeb({
    "https://hop.example/": { body: "", status: 302, headers: { location: "http://internal.example/admin" } },
    "https://loop.example/": { body: "", status: 301, headers: { location: "http://127.0.0.1/" } },
    "https://mapped.example/": { body: "", status: 307, headers: { location: "http://[::ffff:10.0.0.1]/" } },
    "https://chain.example/": { body: "", status: 302, headers: { location: "/1" } }, "https://chain.example/1": { body: "", status: 302, headers: { location: "/2" } },
    "https://chain.example/2": { body: "", status: 302, headers: { location: "/3" } }, "https://chain.example/3": { body: "", status: 302, headers: { location: "/4" } },
    "https://moved.example/": { body: "", status: 301, headers: { location: "https://www.moved.example/" } }, "https://www.moved.example/": { body: html("<p>Moved here</p>") },
    "https://closed.example/robots.txt": { body: "User-agent: *\nDisallow: /" },
    "https://captcha.example/": { body: html("<p>Please complete the security check</p><div class=\"g-recaptcha\"></div>", "<title>Just a moment...</title>") },
    "https://blocked.example/": { body: "Forbidden", status: 403, headers: { "content-type": "text/html" } },
    "https://pdf.example/": { body: "%PDF-1.4", headers: { "content-type": "application/pdf" } },
    "https://big.example/": { body: html(`<p>${"word ".repeat(400_000)}</p>`) },
  });
  const reader = createReader({ origin: ORIGIN, fetchImpl: web.fetchImpl, lookupImpl, hostGapMs: 0 });
  const signal = new AbortController().signal;
  const read = (url: string) => reader.read(url, signal, { home: true });
  for (const url of ["https://hop.example/", "https://loop.example/", "https://mapped.example/"]) assert.equal((await read(url) as { failed?: string }).failed, "unsafe", url);
  assert.ok(![...web.hosts()].some((host) => host === "internal.example" || host === "127.0.0.1" || host.includes("ffff")), "nothing is sent to a private address");
  assert.equal((await read("https://internal.example/") as { failed?: string }).failed, "unsafe");
  assert.equal((await read("http://localhost/") as { failed?: string }).failed, "unsafe");
  assert.match((await read("https://chain.example/") as { detail?: string }).detail ?? "", /more than 3 times/);
  const moved = await read("https://moved.example/");
  assert.ok("page" in moved && moved.page.finalUrl === "https://www.moved.example/");
  assert.equal((await read("https://closed.example/") as { failed?: string }).failed, "robots");
  assert.deepEqual(web.asked("https://closed.example"), ["https://closed.example/robots.txt"], "a page robots.txt closes is never asked for");
  assert.equal((await read("https://captcha.example/") as { failed?: string }).failed, "challenge");
  const refused = await read("https://blocked.example/") as { failed?: string; status?: number };
  assert.deepEqual([refused.failed, refused.status], ["blocked", 403]);
  assert.equal((await reader.read("https://blocked.example/", signal) as { failed?: string }).failed, "http", "a 403 below the home page just skips that page");
  assert.equal((await read("https://pdf.example/") as { failed?: string }).failed, "not_html");
  const big = await read("https://big.example/");
  assert.ok("page" in big && big.page.truncated && big.page.html.length <= 1_500_000);
  // Every request says who it is, with the app's address; no cookie is ever sent.
  assert.ok(web.requests.every((request) => request.headers["user-agent"] === `VentureStudioLeadFinder/1.0 (+${ORIGIN})` && !("cookie" in request.headers)));
  assert.ok(web.requests.every((request) => request.address === "93.184.216.34"), "connections go to the address that was checked");
  // A CAPTCHA on a contact form is not a challenge page; a Cloudflare challenge is.
  assert.equal(looksLikeChallenge(html(`<p>${"Our office address and phone numbers. ".repeat(60)}</p><form><textarea></textarea><div class="g-recaptcha"></div></form>`)), false);
  assert.equal(looksLikeChallenge(html("<script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1\"></script>")), true);
});

test("the reader waits between requests to one host", async () => {
  const at: number[] = [];
  const reader = createReader({ origin: ORIGIN, lookupImpl, hostGapMs: 120, fetchImpl: async (url) => { at.push(Date.now()); return new Response(url.endsWith("robots.txt") ? "" : html("<p>hi</p>"), { status: url.endsWith("robots.txt") ? 404 : 200, headers: { "content-type": "text/html" } }); } });
  const signal = new AbortController().signal;
  await Promise.all([reader.read("https://slow.example/a", signal), reader.read("https://slow.example/b", signal)]);
  assert.equal(at.length, 3); // robots.txt, then the two pages
  for (let index = 1; index < at.length; index++) assert.ok(at[index]! - at[index - 1]! >= 110, `request ${index} came ${at[index]! - at[index - 1]!} ms after the one before`);
});

// ---- What a company's pages say ---------------------------------------------------------------------------------------------------

test("extraction: verbatim dealer quotes with their page, published routes, PIN to state, the dealer login flag, and nothing from scripts", () => {
  const pages = parsedGood();
  const home = pages[0]!;
  assert.equal(home.title, "Good Pumps | Submersible pump makers in Raipur");
  assert.equal(home.siteName, "Good Pumps Pvt Ltd");
  assert.ok(home.lines.includes("Submersible pumps & motors for farms"), "entities decoded");
  assert.ok(!home.lines.some((line) => /script|dealer network|\.dealer-network/i.test(line)), "script, style and noscript are not text");
  assert.deepEqual(pickPages(home), [`${GOOD}/contact`, `${GOOD}/about-us`, `${GOOD}/become-a-dealer`, `${GOOD}/products`], "never the login page or another host");
  const { signals, dealerPortal } = siteSignals(pages);
  const dealer = signals.find((signal) => signal.key === "dealer_wanted")!;
  assert.equal(dealer.url, `${GOOD}/become-a-dealer`, "a sentence on the dealer page beats the menu link");
  assert.ok(dealer.quote.split(" ").length <= 25);
  assert.ok(pages[3]!.lines.some((line) => line.includes(dealer.quote)), "the quote is word for word from the page");
  assert.match(dealer.quote, /^Dealers wanted across Chhattisgarh/);
  assert.equal(signals[0]!.key, "dealer_wanted", "the strongest signal comes first");
  assert.ok(signals.some((signal) => signal.key === "catalogue" && signal.url === `${GOOD}/`));
  assert.ok(signals.some((signal) => signal.key === "price_list") && signals.some((signal) => signal.key === "price_on_request"));
  assert.ok(!signals.some((signal) => signal.key === "dealer_network"), "noscript text is not read");
  assert.ok(dealerPortal && /Dealer Login/.test(dealerPortal.quote) && dealerPortal.url === `${GOOD}/`);
  const routes = contactRoutes(pages);
  assert.deepEqual(routes.map((route) => [route.kind, route.value, route.sourceUrl]), [
    ["phone", "+919827012345", `${GOOD}/`], ["whatsapp", "+919827012345", `${GOOD}/`], ["email", "sales@goodpumps.example", `${GOOD}/contact`], ["website_form", `${GOOD}/contact`, `${GOOD}/contact`],
  ]);
  assert.deepEqual(locate(pages), { city: "Raipur", region: "Chhattisgarh", states: ["Chhattisgarh", "Odisha"], indian: true });
  const facts = siteFacts({ pages, hit: { url: `${GOOD}/products/submersible`, title: "Good Pumps" }, categories: ["valves", "pumps"] });
  assert.deepEqual([facts.domain, facts.website, facts.companyName, facts.category, facts.country, facts.notCompany], ["goodpumps.example", `${GOOD}/`, "Good Pumps Pvt Ltd", "pumps", "India", undefined]);
  assert.ok(!JSON.stringify(facts).includes("22AAACG1234A1Z5"), "no GSTIN is kept");
});

test("reading a page takes time in step with its size: broken or hostile HTML never stalls the API", () => {
  // Each of these took minutes at 1.5 MB when a tag pattern rescanned the rest of the page from every tag it could not close.
  const SIZE = 1_500_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const hostile: Record<string, string> = {
    "unclosed links": fill("<a>"), "links without >": fill("<a "), "unclosed forms": fill("<form>"), "unclosed comments": fill("<!--"), "unclosed scripts": fill("<script><style><svg>"),
    "unclosed titles": fill("<title>"), "bare <": fill("<"), "blocks without >": fill("<p "), "metas without >": fill("<meta "), "bases without >": fill("<base "),
    "unclosed JSON-LD": fill('<script type="application/ld+json">'), "inputs in a form": `<form>${fill("<input ")}</form>`, "names in one input": `<form><input ${fill("name=x")}></form>`,
  };
  for (const [name, body] of Object.entries(hostile)) {
    const started = performance.now();
    parseHtml(body, "https://hostile.example/");
    assert.ok(performance.now() - started < 3_000, `${name} read in ${Math.round(performance.now() - started)} ms`);
  }
  // The bot-check test runs on every page fetched, before it is read: the same shapes, with "captcha" in them so every part of it runs.
  for (const [name, body] of Object.entries({ ...hostile, "unclosed titles with captcha": `captcha ${fill("<title ")}`, "unclosed scripts with captcha": `captcha ${fill("<script ")}` })) {
    const started = performance.now();
    looksLikeChallenge(body);
    assert.ok(performance.now() - started < 3_000, `bot check on ${name} took ${Math.round(performance.now() - started)} ms`);
  }
  // The same tags as before on well-formed parts: a link after unclosed ones, an enquiry field, a login, comments and scripts gone.
  const mixed = parseHtml(`<title>Acme</title><!-- x --><script>"<a href='/no'>"</script><a href="/contact">Contact us</a><a broken<form><input name="customer_email"></form><form><input type=password></form>`, "https://acme.example/");
  assert.deepEqual([mixed.title, mixed.links.map((link) => link.href), mixed.forms], ["Acme", ["https://acme.example/contact"], { count: 2, enquiry: true, login: true }]);
});

test("extraction: PIN prefixes, visible numbers and emails, quote windows, and pages that are not a company's own site", () => {
  const page = (body: string, url = "https://shop.example/", head = "") => parseHtml(html(body, head), url);
  for (const [pin, state] of [["492001", "Chhattisgarh"], ["452001", "Madhya Pradesh"], ["462016", "Madhya Pradesh"], ["440001", "Maharashtra"], ["411001", "Maharashtra"], ["403001", "Goa"], ["751001", "Odisha"], ["768001", "Odisha"], ["110001", undefined]] as const) assert.equal(pinState(pin), state, pin);
  assert.deepEqual(locate([page("<p>Shop 4, MG Road, Indore 452001</p>")]), { city: "Indore", region: "Madhya Pradesh", states: ["Madhya Pradesh"], indian: true });
  assert.equal(locate([page("<p>Near Bus Stand, Sambalpur - 768001, Odisha</p>")]).region, "Odisha");
  assert.equal(locate([page("<p>Industrial Estate, Kolhapur, PIN: 416 003</p>")]).city, "Kolhapur");
  assert.deepEqual(locate([page("<p>We supply dealers in Gujarat and Rajasthan.</p><p>Head office: Ahmedabad</p>")]).states.sort(), ["Gujarat", "Rajasthan"]);
  assert.equal(locate([page("<p>Order 492001 shipped in 2026</p>")]).region, undefined, "a number without an address is not a PIN");
  const routes = contactRoutes([page("<p>Call: 098270 12345 / 0771-4012345</p><p>Fax: 0771-4099999</p><p>A/c No 123456789012, IFSC SBIN0001234</p><p>Write to info@shop.example or logo@2x.png or name@example.com</p><p>Order no 7712345678</p><a href=\"https://api.whatsapp.com/send?phone=919999988888\">Chat</a>")]);
  assert.deepEqual(routes.map((route) => `${route.kind}:${route.value}`), ["whatsapp:+919999988888", "phone:+919827012345", "phone:+917714012345", "email:info@shop.example"], "no fax, bank, order number or placeholder email");
  const long = "one two three four five six seven eight nine ten eleven twelve become a dealer thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix";
  const quote = quoteAround(long, long.indexOf("become"));
  assert.equal(quote.split(" ").length, 25);
  assert.ok(long.includes(quote) && quote.includes("become a dealer"));
  assert.ok(quoteAround("Become a dealer today", 0) === "Become a dealer today");
  // Not a company's own site: directories and marketplaces, news and article pages, listicles and market research, or nothing about a business.
  const listed = page("<p>Shakti Pumps, Raipur. Contact supplier</p>", "https://www.indiamart.com/shakti-pumps/");
  assert.match(notACompany([listed], []) ?? "", /directory/);
  assert.match(notACompany([page("<p>Business listing for pumps. Contact us</p>", "https://idbf.in/company/x")], []) ?? "", /directory/);
  const news = page("<p>Pump makers in Raipur expand. Contact us. About us</p>", "https://dailynews.example/", '<title>Daily News</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsMediaOrganization","name":"Daily News"}</script>');
  assert.match(notACompany([news], [], { url: "https://dailynews.example/2026/10/pump-makers", title: "Pump makers expand" }) ?? "", /news, blog or article/);
  assert.match(notACompany([page("<p>Our products. Contact us.</p>", "https://blog.example/", '<meta property="og:type" content="article">')], []) ?? "", /article/);
  assert.match(notACompany([page("<p>The best pump companies, ranked. Contact us.</p>", "https://ranker.example/")], [], { url: "https://ranker.example/top-10-pump-manufacturers", title: "Top 10 Pump Manufacturers in India (2026)" }) ?? "", /listicle/);
  assert.match(notACompany([page("<p>India pump market size and share</p>", "https://www.mordorintelligence.com/x")], []) ?? "", /market-research/);
  assert.match(notACompany([page("<p>Welcome</p><p>Coming soon</p>", "https://parked.example/")], []) ?? "", /no contact, about or product/);
  assert.equal(notACompany(parsedGood(), contactRoutes(parsedGood()), { url: `${GOOD}/blog/how-to-choose-a-pump`, title: "How to choose a pump" }), undefined, "a company's own blog post still leads to the company");
});

// ---- The planner --------------------------------------------------------------------------------------------------------------

test("planner: the plan's searches as given, else categories x places x business words (most specific first, capped), else the request", async () => {
  assert.deepEqual(buildQueries({ request: "ignored", plan: { searches: ["pump dealer raipur", "Pump  dealer Raipur", "valve distributor indore"], categories: ["x"], places: ["y"] } }), ["pump dealer raipur", "valve distributor indore"]);
  const pairs = buildQueries({ request: "r", plan: { categories: ["pumps", "pipes"], places: ["Raipur", "Indore"] } });
  assert.deepEqual(pairs.slice(0, 4), ["pumps dealer enquiry Raipur", "pumps dealer enquiry Indore", "pipes dealer enquiry Raipur", "pipes dealer enquiry Indore"]);
  assert.equal(pairs.length, 12);
  assert.ok(pairs.includes("pipes distributor Indore") && pairs.includes("pumps manufacturer Raipur"));
  const many = buildQueries({ request: "r", plan: { categories: ["a1", "a2", "a3", "a4", "a5"], places: ["p1", "p2", "p3", "p4", "p5"] } });
  assert.equal(many.length, 40);
  assert.ok(many.slice(0, 25).every((query) => query.includes("dealer enquiry")), "every pair's first query comes before any pair's second");
  assert.deepEqual(buildQueries({ request: "Tractor spare part dealers in Bilaspur", plan: { places: [], categories: [], searches: [] } }), ["Tractor spare part dealers in Bilaspur"]);
  assert.deepEqual(buildQueries({ request: "Agri input shops. Skip big chains.", plan: { places: ["Durg"] } }), ["Agri input shops. Durg"]);
  assert.deepEqual(buildQueries({ request: "Valve makers", plan: { categories: ["valves"] } }), ["valves dealer enquiry", "valves manufacturer", "valves distributor"]);
  assert.equal(countryOf({ request: "Wedding videographers", plan: { places: ["London", "Manchester"] } }), "GB");
  assert.equal(countryOf({ request: "Pump dealers in Raipur" }), "IN");

  // The search loop: hits merged by domain, directories dropped, Exa asked only when TinyFish found nothing new, every call counted first.
  let reserved = 0;
  const usedUp = { tinyfish: false, exa: false };
  // The counter: the first update makes sure the period's row exists, the second counts a call only while it is under the limit
  // (a used-up engine matches nothing). Only the counting update is a reservation.
  const db = { collection: () => ({ updateOne: async (filter: { _id: string; calls?: unknown }) => { if (filter.calls === undefined) return { matchedCount: 1 }; reserved++; return { matchedCount: usedUp[filter._id.includes(":exa:") ? "exa" : "tinyfish"] ? 0 : 1 }; } }) } as unknown as AppDb;
  const asked: string[] = [];
  const search: SearchFn = async (engine, _key, query) => {
    asked.push(`${engine}:${query}`);
    if (engine === "tinyfish" && query === "q1") return [{ url: "https://www.a.example/x", title: "A", snippet: "", engine }, { url: "https://a.example/y", title: "A again", snippet: "", engine }, { url: "https://www.indiamart.com/a", title: "A on a directory", snippet: "", engine }, { url: "https://idbf.in/b", title: "B listing", snippet: "", engine }];
    if (engine === "tinyfish" && query === "q2") return [{ url: "https://a.example/", title: "A", snippet: "", engine }];
    if (engine === "exa" && query === "q2") return [{ url: "https://b.example/", title: "B", snippet: "", engine }];
    return [];
  };
  const stats = searchStats();
  const batches = [];
  for await (const batch of searchSites({ db, workspaceId: "w", keys: { tinyfishKey: "t", exaKey: "e" }, queries: ["q1", "q2", "q3"], country: "IN", search, signal: new AbortController().signal, seen: new Set(), stats })) batches.push(batch);
  assert.deepEqual(batches.map((batch) => batch.sites.map((site) => site.domain)), [["a.example"], ["b.example"], []]);
  assert.deepEqual(asked, ["tinyfish:q1", "tinyfish:q2", "exa:q2", "tinyfish:q3", "exa:q3"]);
  assert.equal(reserved, 5);
  // A used-up allowance stops that engine; a refused key stops it for the run.
  usedUp.tinyfish = true;
  const capped = searchStats();
  const failing: SearchFn = async () => { throw new Error("Exa refused the request: its key was rejected or its quota is used up"); };
  const none = [];
  for await (const batch of searchSites({ db, workspaceId: "w", keys: { tinyfishKey: "t", exaKey: "e" }, queries: ["q1", "q2"], country: "IN", search: failing, signal: new AbortController().signal, seen: new Set(), stats: capped })) none.push(batch);
  assert.ok(capped.capped.has("tinyfish"));
  assert.equal(capped.calls, 1, "after the refusal nothing else is called");
  assert.equal(none.length, 1);
});

// ---- Searching for an offer -------------------------------------------------------------------------------------------------------

/** Offer packets as the offers code stores them (sales-offers.ts): a dealer-commerce one and a startup tech-partner one. */
const dealerPacket = offerPacketSchema.parse({
  summary: "Catalog-to-order systems for dealer-led suppliers",
  whoFor: { industries: ["pumps", "pipes", "valves", "motors", "cables", "fans", "switches"], places: ["Raipur", "Indore", "Nagpur", "Bhopal", "Durg", "Bilaspur"] },
  signals: { lookFor: [{ phrase: "dealer enquiry", meaning: "Dealers write in by phone: the catalog-to-order pitch fits" }], searchWords: ["dealership enquiry", "OEM"] },
  say: {},
});
const startupPacket = offerPacketSchema.parse({
  summary: "A tech partner that builds and runs the product for seed-stage startups",
  whoFor: { industries: ["SaaS startups", "fintech startups"], places: ["Bengaluru"] },
  signals: {
    lookFor: [{ phrase: "we are hiring", meaning: "Hiring now: the team is growing faster than it can build" }, { phrase: "building our MVP", meaning: "Still building the first version of its product" }, { phrase: "seed funded", meaning: "Has seed money to spend on building" }],
    searchWords: ["seed funded", "founders"], negatives: ["web development agency", "IT outsourcing"],
  },
  say: {},
});

test("planner with an offer: the packet's first industries and places stand in for an empty plan, its search words replace the built-in ones, and what the person typed wins", () => {
  const empty = { request: "Dealer-led suppliers", plan: { places: [], categories: [], searches: [] } };
  const queries = buildQueries(empty, dealerPacket);
  assert.equal(queries.length, 40);
  assert.deepEqual(queries.slice(0, 3), ["pumps dealership enquiry Raipur", "pumps dealership enquiry Indore", "pumps dealership enquiry Nagpur"]);
  assert.ok(queries.slice(0, 25).every((query) => query.includes("dealership enquiry")) && queries.slice(25).every((query) => query.includes(" OEM ")), "every pair's first search word before any pair's second");
  assert.ok(!queries.some((query) => /fans|switches|Bilaspur|dealer enquiry|manufacturer|distributor/.test(query)), "only the packet's first 5 industries and places, and only its own words");
  // What the person typed wins, field by field; the packet fills in the rest.
  const typed = buildQueries({ request: "r", plan: { categories: ["tractor parts"], places: [] } }, dealerPacket);
  assert.deepEqual(typed.slice(0, 2), ["tractor parts dealership enquiry Raipur", "tractor parts dealership enquiry Indore"]);
  assert.equal(typed.length, 10);
  const placed = buildQueries({ request: "r", plan: { places: ["Korba"] } }, dealerPacket);
  assert.deepEqual(placed.slice(0, 5), ["pumps dealership enquiry Korba", "pipes dealership enquiry Korba", "valves dealership enquiry Korba", "motors dealership enquiry Korba", "cables dealership enquiry Korba"]);
  assert.deepEqual(buildQueries({ request: "r", plan: { searches: ["borewell pumps raipur"], categories: [], places: [] } }, dealerPacket), ["borewell pumps raipur"], "the plan's own searches as given");
  // No search words in the packet: the built-in business words.
  const wordless = { ...dealerPacket, signals: { ...dealerPacket.signals, searchWords: [] } };
  assert.deepEqual(buildQueries({ request: "r", plan: { categories: ["pumps"], places: ["Raipur"] } }, wordless), ["pumps dealer enquiry Raipur", "pumps manufacturer Raipur", "pumps distributor Raipur"]);
  // A packet with no industries or places leaves the plan as it was.
  const bare = { ...dealerPacket, whoFor: { ...dealerPacket.whoFor, industries: [], places: [] } };
  assert.deepEqual(buildQueries({ request: "Valve makers", plan: {} }, bare), ["Valve makers"]);
  assert.deepEqual(buildQueries(empty, startupPacket), ["SaaS startups seed funded Bengaluru", "fintech startups seed funded Bengaluru", "SaaS startups founders Bengaluru", "fintech startups founders Bengaluru"]);
  // The country follows the run's places: the plan's, else the packet's.
  const abroad = { ...startupPacket, whoFor: { ...startupPacket.whoFor, places: ["London", "Manchester"] } };
  assert.equal(countryOf({ request: "Startups" }, abroad), "GB");
  assert.equal(countryOf({ request: "Startups", plan: { places: ["Pune"] } }, abroad), "IN");
});

test("negatives: a search result whose title or snippet names one (any case, spacing or plural) rules its site out before any page is read", async () => {
  const negatives = negativesOf(startupPacket)!;
  for (const text of ["A Web-Development Agency in Bengaluru", "web development agencies", "IT OUTSOURCING partner"]) assert.ok(negatives.test(text), text);
  for (const text of ["We build our own web app", "an outsourcing-free team", "development agency"]) assert.ok(!negatives.test(text), text);
  assert.equal(negativesOf(dealerPacket), undefined, "a packet with no negatives rules nothing out");
  const db = { collection: () => ({ updateOne: async () => ({ matchedCount: 1 }) }) } as unknown as AppDb;
  const asked: string[] = [];
  const hit = (url: string, title: string, snippet = "") => ({ url, title, snippet, engine: "tinyfish" as const });
  const search: SearchFn = async (engine, _key, query) => {
    asked.push(`${engine}:${query}`);
    if (engine === "tinyfish" && query === "q1") return [hit("https://ledgerly.example/", "Ledgerly", "Seed-funded bookkeeping startup"), hit("https://pixel.example/", "PixelCraft", "A web development agency for startups"), hit("https://twice.example/a", "Twice", "Payments startup"), hit("https://twice.example/b", "Twice", "We also do IT outsourcing")];
    if (engine === "tinyfish" && query === "q2") return [hit("https://bodyshop.example/", "IT Outsourcing Services | Bengaluru")];
    if (engine === "exa" && query === "q2") return [{ ...hit("https://tallyho.example/", "Tallyho"), engine }];
    return [hit("https://pixel.example/", "PixelCraft"), hit("https://ledgerly.example/", "Ledgerly")];
  };
  const batches = [];
  for await (const batch of searchSites({ db, workspaceId: "w", keys: { tinyfishKey: "t", exaKey: "e" }, queries: ["q1", "q2", "q3"], country: "IN", search, signal: new AbortController().signal, seen: new Set(), stats: searchStats(), negatives })) batches.push(batch);
  assert.deepEqual(batches.map((batch) => batch.sites.map((site) => site.domain)), [["ledgerly.example"], ["tallyho.example"], []]);
  assert.deepEqual(batches.map((batch) => batch.ruledOut.map((site) => site.domain)), [["pixel.example", "twice.example"], ["bodyshop.example"], []], "a second result naming a negative rules its site out too; a ruled-out site is not found again");
  assert.deepEqual(asked, ["tinyfish:q1", "tinyfish:q2", "exa:q2", "tinyfish:q3", "exa:q3"], "Exa is asked when TinyFish found only ruled-out sites");
});

test("offer signals: the packet's phrases are found in any case, with hyphens or spaces, plurals and enquiry or inquiry, quoted word for word ahead of the built-in ones", () => {
  const page = (body: string, url: string) => parseHtml(html(body), url);
  assert.ok(phrasePattern("e-commerce")!.test("Order from our E Commerce store") && phrasePattern("e-commerce")!.test("ecommerce") && !phrasePattern("e-commerce")!.test("recommerce"));
  assert.ok(phrasePattern("company")!.test("Group companies") && !phrasePattern("company")!.test("accompany"));
  assert.ok(phrasePattern("OEM supplier")!.test("We are OEMs suppliers to tractor makers"));
  assert.equal(phrasePattern(" - "), null);
  const lookFor = offerSignals([{ phrase: "dealer enquiry", meaning: "Dealers write in by phone: the catalog-to-order pitch fits" }, { phrase: "price lists", meaning: "Sends price lists by hand" }, { phrase: "e-commerce", meaning: "Already sells online" }]);
  const pages = [
    page("<nav><a href=\"/dealer\">Home</a> Products Dealer Inquiry</nav><p>We welcome Dealer-Inquiries from every district of Chhattisgarh and Odisha, so call our sales office for the terms.</p><p>GSTIN 22AAACG1234A1Z5, our price list for 2026.</p>", "https://maker.example/"),
    page("<p>Download the Price-List for 2026 and WhatsApp us for the best price.</p><p>Order from our E Commerce store any time.</p>", "https://maker.example/products"),
  ];
  const { signals } = siteSignals(pages, lookFor);
  assert.deepEqual(signals.slice(0, 3).map((signal) => [signal.key, signal.claim, signal.url]), [
    ["offer_1", "Dealers write in by phone: the catalog-to-order pitch fits", "https://maker.example/"], ["offer_2", "Sends price lists by hand", "https://maker.example/products"], ["offer_3", "Already sells online", "https://maker.example/products"],
  ], "the packet's signals first, in its order");
  assert.match(signals[0]!.quote, /^We welcome Dealer-Inquiries from every district/, "a sentence beats the menu line");
  assert.equal(signals[1]!.quote, "Download the Price-List for 2026 and WhatsApp us for the best price.", "never the line with a GSTIN on it");
  for (const signal of signals) assert.ok(signal.quote.split(" ").length <= 25 && pages.some((item) => item.url === signal.url && item.lines.some((line) => line.includes(signal.quote))), `${signal.key} is quoted word for word from its page`);
  // The built-in signals still count after them, unless they matched the very words an offer signal quotes.
  assert.ok(signals.some((signal) => signal.key === "price_on_request" && signal.url === "https://maker.example/products"), "other words on the same line are another signal");
  assert.ok(signals.some((signal) => signal.key === "dealer_enquiry" && signal.quote.includes("Dealer Inquiry")));
  const same = siteSignals([page("<p>We welcome dealer enquiries from every district, call our office.</p>", "https://twin.example/")], lookFor).signals;
  assert.deepEqual(same.map((signal) => signal.key), ["offer_1"], "the built-in dealer enquiry that matched the same words is left out");
  assert.deepEqual(siteSignals([page("<p>We welcome dealer enquiries from every district, call our office.</p>", "https://twin.example/")]).signals.map((signal) => signal.key), ["dealer_enquiry"], "without an offer, as before");
  assert.deepEqual(siteSignals([page("<p>Request a quote for your plant.</p><p>Request quotation</p>", "https://quote.example/")]).signals.map((signal) => [signal.key, signal.quote]), [["request_quote", "Request a quote for your plant."]]);
});

test("offer signals: a startup packet's phrases find what the dealer signals miss, and its industries guess the category", () => {
  const page = (body: string, url: string, title = "") => parseHtml(html(body, title ? `<title>${title}</title>` : ""), url);
  const pages = [
    page("<h1>Bookkeeping for small shops</h1><p>Ledgerly is a seed-funded SaaS startup from Bengaluru: we are building our MVP with forty pilot shops this year.</p>", "https://ledgerly.example/", "Ledgerly"),
    page("<p>We are hiring engineers and designers who want to build tools for small shops.</p><p>Our team of six</p>", "https://ledgerly.example/about"),
  ];
  assert.deepEqual(siteSignals(pages).signals, [], "nothing here is a dealer signal");
  const facts = siteFacts({ pages, categories: ["accounting software", ...startupPacket.whoFor.industries], signals: offerSignals(startupPacket.signals.lookFor) });
  assert.deepEqual(facts.signals.map((signal) => [signal.claim, signal.quote, signal.url]), [
    ["Hiring now: the team is growing faster than it can build", "We are hiring engineers and designers who want to build tools for small shops.", "https://ledgerly.example/about"],
    ["Still building the first version of its product", "Ledgerly is a seed-funded SaaS startup from Bengaluru: we are building our MVP with forty pilot shops this year.", "https://ledgerly.example/"],
    ["Has seed money to spend on building", "Ledgerly is a seed-funded SaaS startup from Bengaluru: we are building our MVP with forty pilot shops this year.", "https://ledgerly.example/"],
  ]);
  assert.equal(facts.category, "SaaS startups");
});

// ---- Whole runs through the real app, on a throwaway database -------------------------------------------------------------------

const mongoUrl = process.env.TEST_MONGODB_URI;
const skip = { skip: !mongoUrl };
const suffix = randomUUID().slice(0, 6);
type Reply = { status: number; body: any; data: any };
type Env = { database: Database; config: AppConfig; server: Server; app: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>; run: (extra?: Record<string, unknown>) => Promise<string> };
let env: Promise<Env> | undefined;
let counter = 0;

async function setup(): Promise<Env> {
  const dbName = `vso_test_finder_${suffix}`;
  assert.match(dbName, /^vso_test_finder_/);
  const config = loadConfig({
    NODE_ENV: "test", APP_MODE: "local", ALLOW_DEV_AUTH: "true", PORT: "4000", APP_ORIGIN: ORIGIN, API_ORIGIN: "http://127.0.0.1:4000",
    MONGODB_URI: mongoUrl!, MONGODB_DB: dbName, BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters", TINYFISH_API_KEY: "tf-test-key-not-real-123",
  });
  const database = await connectDatabase(config);
  const db = database.db;
  await ensureIndexes(db);
  const now = new Date();
  await db.collection("workspaces").insertOne({ _id: "workspace-a", name: "A", slug: "a", createdAt: now });
  await db.collection("ventures").insertOne({ _id: "venture-a", workspaceId: "workspace-a", name: "Alpha", status: "active", createdAt: now });
  await db.collection("pipelines").insertOne({ _id: "pipeline-a", workspaceId: "workspace-a", ventureId: "venture-a", name: "Alpha leads", offerName: "O", status: "active", createdAt: now, updatedAt: now });
  const people: [string, string, string[]][] = [["admin", "admin", []], ["head", "venture_head", ["venture-a"]], ["contrib", "contributor", ["venture-a"]], ["learner", "learner", ["venture-a"]]];
  await db.collection("users").insertMany(people.map(([handle]) => ({ _id: `user-${handle}`, workspaceId: "workspace-a", email: `${handle}@example.invalid`, name: handle, handle, status: "active", createdAt: now, updatedAt: now })));
  await db.collection("memberships").insertMany(people.map(([handle, role, ventureIds]) => ({ _id: `membership-${handle}`, workspaceId: "workspace-a", userId: `user-${handle}`, role, ventureIds, groupIds: [], status: "active", createdAt: now, updatedAt: now })));
  const { app } = createApp(database, config, createAuth(database.native, config), new LocalObjectStore(config));
  const server = createServer(app).listen(0);
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    database, config, server,
    app: async (who, method, path, body) => { const response = await fetch(`${origin}/v1${path}`, { method, headers: { "content-type": "application/json", "x-dev-user-id": `user-${who}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const json = await response.json().catch(() => null) as any; return { status: response.status, body: json, data: json?.data }; },
    run: async (extra = {}) => {
      const id = `run-${++counter}-${suffix}`;
      const when = new Date(Date.now() - 60_000 + counter);
      await db.collection("sales_find_runs").insertOne({ _id: id, workspaceId: "workspace-a", ventureId: "venture-a", kind: "find", request: "Pump dealers in Chhattisgarh", plan: { places: ["Raipur"], categories: ["pumps"], searches: ["pump dealer raipur"], limit: 50 }, status: "queued", createdBy: "user-contrib", createdVia: "app", createdAt: when, updatedAt: when, ...extra });
      return id;
    },
  };
}
const getEnv = () => (env ??= setup());
after(async () => {
  if (!env) return;
  const { server, database } = await env;
  server.close();
  await once(server, "close");
  await database.native.dropDatabase();
  await database.client.close();
});
const expectStatus = (reply: Reply, status: number) => { assert.equal(reply.status, status, JSON.stringify(reply.body)); return reply; };
const hitsFor = (urls: [string, string][]): SearchFn => async (engine) => urls.map(([url, title]) => ({ url, title, snippet: "", engine }));

test("a find run: company sites become leads with evidence and routes; duplicates, do-not-contact, robots-closed and news sites are skipped", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  // Already a lead (same domain), and on the do-not-contact list by company name and by email.
  expectStatus(await e.app("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: "Known Pumps", ownerId: "user-contrib", website: "https://dupsite.example" }), 201);
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "company", value: "Blocked Pumps Pvt Ltd", reason: "Asked not to be contacted" }), 201);
  expectStatus(await e.app("admin", "POST", "/sales/suppression", { kind: "email", value: "owner@namesake.example" }), 201);
  const web = fakeWeb({
    ...goodSite,
    "https://closed.example/robots.txt": { body: "User-agent: *\nDisallow: /" }, "https://closed.example/": { body: html("<p>Pumps. Contact us.</p>") },
    "https://dailynews.example/": { body: html("<p>Latest news. About us. Contact us.</p>", '<title>Daily News</title><script type="application/ld+json">{"@type":"NewsMediaOrganization"}</script>') },
    "https://namesake.example/": { body: html('<p>Namesake Traders sell pumps. <a href="/contact-us">Contact</a></p>', "<title>Namesake Traders</title>") },
    "https://namesake.example/contact-us": { body: html("<p>Write to owner@namesake.example</p>") },
    "https://dupsite.example/": { body: html("<p>Should never be read</p>") }, "https://blockedpumps.example/": { body: html("<p>Should never be read</p>") },
  });
  const logs: Record<string, unknown>[] = [];
  const finder = createFinder({ database: e.database, env: e.config, fetchImpl: web.fetchImpl, lookupImpl, hostGapMs: 0, workerId: "test-worker", log: (line) => logs.push(line), search: hitsFor([
    [`${GOOD}/products/submersible`, "Good Pumps | Submersible pumps"], ["https://www.indiamart.com/good-pumps/", "Good Pumps on IndiaMART"], ["https://dupsite.example/", "Known Pumps"],
    ["https://blockedpumps.example/", "Blocked Pumps | Raipur"], ["https://closed.example/", "Closed Pumps"], ["https://dailynews.example/2026/10/pump-makers", "Pump makers expand"], ["https://namesake.example/", "Namesake Traders"],
  ]) });
  const id = await e.run();
  const result = await finder.runOnce();
  assert.ok(result);
  assert.deepEqual([result.runId, result.status, result.found, result.added, result.skipped], [id, "done", 6, 1, 5], result.note);
  assert.match(result.note, /1 already in Dealflow/);
  assert.match(result.note, /2 on the do-not-contact list/);
  assert.match(result.note, /1 closed to crawlers by robots\.txt/);
  assert.match(result.note, /1 not a company's own site/);

  const lead = (await db.collection("opportunities").findOne({ "externalRef.system": FINDER_SYSTEM, "externalRef.id": "goodpumps.example" }))!;
  assert.ok(lead, "the company was added");
  assert.deepEqual([lead.companyName, lead.website, lead.city, lead.region, lead.country, lead.category, lead.ownerId, lead.pipelineId, lead.stage, lead.source], ["Good Pumps Pvt Ltd", `${GOOD}/`, "Raipur", "Chhattisgarh", "India", "pumps", "user-contrib", "pipeline-a", "identified", `${GOOD}/products/submersible`]);
  assert.ok(lead.tags.includes("finder") && lead.tags.includes("dealer-login-seen") && !lead.tags.includes("engine"));
  assert.deepEqual(lead.contactRoutes.map((route: any) => route.kind).sort(), ["email", "phone", "website_form", "whatsapp"]);
  assert.ok(lead.contactRoutes.every((route: any) => route.sourceUrl?.startsWith(GOOD) && route.publishedByCompany === true));
  assert.match(lead.observedSignal, /^"Dealers wanted across Chhattisgarh .*" \(https:\/\/www\.goodpumps\.example\/become-a-dealer\)$/);
  const note = (await db.collection("sales_activities").findOne({ leadId: lead._id, kind: "note" }))!;
  assert.equal(note.via, "import");
  assert.match(note.body, /^Found by the built-in lead finder/);
  assert.match(note.body, /- Invites new dealers or distributors: "Dealers wanted across Chhattisgarh[^"]*" \(https:\/\/www\.goodpumps\.example\/become-a-dealer, seen \d{4}-\d{2}-\d{2}\)/);
  assert.match(note.body, /dealer login or dealer portal/);
  assert.equal(await db.collection("opportunities").countDocuments({ "externalRef.system": FINDER_SYSTEM }), 1, "nothing else was added");
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.lead.create", channel: "engine", objectId: lead._id, actorId: "user-contrib" }));
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.finder.claim", objectId: id, "metadata.workerId": "test-worker" }));
  const run = (await db.collection("sales_find_runs").findOne({ _id: id }))!;
  assert.deepEqual([run.status, run.claimedBy, run.workerId, run.results.found, run.results.added, run.results.skipped, Boolean(run.finishedAt)], ["done", FINDER_WORKER, "test-worker", 6, 1, 5, true]);
  // What was never asked for: the duplicate and the do-not-contact company (not even robots.txt), the page robots.txt closes, the directory.
  assert.deepEqual(web.asked("https://dupsite.example"), []);
  assert.deepEqual(web.asked("https://blockedpumps.example"), []);
  assert.deepEqual(web.asked("https://closed.example"), ["https://closed.example/robots.txt"]);
  assert.ok(!web.hosts().has("www.indiamart.com") && !web.hosts().has("portal.goodpumps.example"));
  assert.ok(!web.asked(`${GOOD}/login`).length, "never a login page");
  // One log line for the run, with counts only.
  const line = logs.find((entry) => entry.event === "sales.finder.run")!;
  assert.deepEqual([line.runId, line.status, line.added], [id, "done", 1]);
  assert.ok(!JSON.stringify(logs).includes("tf-test-key") && !JSON.stringify(logs).includes("Dealers wanted"), "no key and no page text in the logs");

  // The same domain in a later run is a duplicate without being read again.
  const again = await e.run();
  const second = createFinder({ database: e.database, env: e.config, fetchImpl: web.fetchImpl, lookupImpl, hostGapMs: 0, log: () => undefined, search: hitsFor([[`${GOOD}/`, "Good Pumps"]]) });
  const before = web.requests.length;
  const repeat = await second.runOnce();
  assert.deepEqual([repeat?.runId, repeat?.status, repeat?.added, repeat?.skipped], [again, "done", 0, 1]);
  assert.equal(web.requests.length, before);
});

test("the finder status: on, search ready and the engines (never a key), the run it is on and its last run", skip, async () => {
  const e = await getEnv();
  const reply = expectStatus(await e.app("learner", "GET", "/sales/finder/status"), 200);
  const status = successEnvelope(finderStatusSchema).parse(reply.body).data.builtIn;
  assert.deepEqual([status.on, status.searchReady, status.engines], [false, true, ["tinyfish"]]); // the test server never runs the loop
  assert.equal(status.lastRun?.status, "done");
  assert.equal(status.running, undefined);
  assert.ok(!JSON.stringify(reply.body).includes("tf-test-key"));
  assert.equal(finderEnabled({ SALES_FINDER: "on", NODE_ENV: "development" }), true);
  assert.equal(finderEnabled({ SALES_FINDER: "off", NODE_ENV: "development" }), false);
  assert.equal(finderEnabled({ SALES_FINDER: "on", NODE_ENV: "test" }), false);
  assert.equal(loadConfig({}).SALES_FINDER, "on");
});

test("a run cancelled while it works stops at once, and what it added stays", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const id = await e.run({ plan: { places: [], categories: [], searches: ["many pump sites"], limit: 50 } });
  const sites = Array.from({ length: 8 }, (_, index) => `https://site${index}-${suffix}.example`);
  const web = fakeWeb(Object.fromEntries(sites.map((site, index) => [`${site}/`, index === 0
    ? async () => { await db.collection("sales_find_runs").updateOne({ _id: id }, { $set: { status: "cancelled", cancelledBy: "user-contrib" } }); return { body: html("<p>Pumps for sale. Contact us.</p>") }; }
    : { body: html("<p>Pumps for sale. Contact us.</p>") }])));
  const finder = createFinder({ database: e.database, env: e.config, fetchImpl: web.fetchImpl, lookupImpl, hostGapMs: 0, log: () => undefined, search: hitsFor(sites.map((site, index) => [`${site}/`, `Site ${index}`])) });
  const result = await finder.runOnce();
  assert.equal(result?.status, "cancelled");
  const run = (await db.collection("sales_find_runs").findOne({ _id: id }))!;
  assert.deepEqual([run.status, run.results], ["cancelled", undefined]);
  for (const site of sites.slice(4)) assert.deepEqual(web.asked(site), [], `${site} was not read after the cancel`);
});

test("an enrich run fills in the routes and place a lead's own website publishes", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const lead = expectStatus(await e.app("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Enrich Me ${suffix}`, ownerId: "user-contrib", website: "enrichme.example" }), 201).data;
  const run = expectStatus(await e.app("contrib", "POST", `/sales/leads/${lead.id}/enrich`, {}), 201).data;
  const web = fakeWeb({
    "https://enrichme.example/": { body: html('<p>Pipes and fittings. <a href="/contact">Contact us</a> <a href="tel:07714012345">0771 4012345</a></p><p>Become our dealer: apply today for the best margins in the region.</p>') },
    "https://enrichme.example/contact": { body: html("<p>Ring Road No. 1, Telibandha, Raipur, Chhattisgarh 492006</p><p>Email: hello@enrichme.example</p>") },
  });
  // No search key at all: an enrich run only reads the lead's own website, so it is worked anyway.
  const finder = createFinder({ database: e.database, env: { APP_ORIGIN: ORIGIN, BETTER_AUTH_SECRET: e.config.BETTER_AUTH_SECRET }, fetchImpl: web.fetchImpl, lookupImpl, hostGapMs: 0, log: () => undefined, search: async () => { throw new Error("an enrich run never searches"); } });
  const result = await finder.runOnce();
  assert.deepEqual([result?.runId, result?.kind, result?.status, result?.found, result?.added], [run.id, "enrich", "done", 1, 1], result?.note);
  const stored = (await db.collection("opportunities").findOne({ _id: lead.id }))!;
  assert.deepEqual(stored.contactRoutes.map((route: any) => `${route.kind}:${route.value}`).sort(), ["email:hello@enrichme.example", "phone:+917714012345"]);
  assert.deepEqual([stored.city, stored.region, stored.website], ["Raipur", "Chhattisgarh", "enrichme.example"]);
  assert.match(stored.observedSignal, /Become our dealer/);
  const note = await db.collection("sales_activities").findOne({ leadId: lead.id, kind: "note", body: /Enriched by the built-in lead finder/ });
  assert.ok(note && /Added 2 contact routes/.test(note.body));
  assert.equal((await db.collection("sales_find_runs").findOne({ _id: run.id }))?.status, "done");
});

test("without a search key runs stay queued with a note; a planner who can no longer work the run fails it; a stale claim is taken over", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const queued = await e.run();
  const keyless = createFinder({ database: e.database, env: { APP_ORIGIN: ORIGIN, BETTER_AUTH_SECRET: e.config.BETTER_AUTH_SECRET }, fetchImpl: async () => { throw new Error("no request without a key"); }, lookupImpl, log: () => undefined });
  assert.equal(await keyless.runOnce(), null);
  const waiting = (await db.collection("sales_find_runs").findOne({ _id: queued }))!;
  assert.deepEqual([waiting.status, waiting.note, waiting.claimedBy], ["queued", NO_KEY_NOTE, undefined]);
  await db.collection("sales_find_runs").updateOne({ _id: queued }, { $set: { status: "cancelled" } });

  // A learner's run (planned before their role changed), held by an office PC that stopped sending heartbeats 20 minutes ago.
  const stale = await e.run({ createdBy: "user-learner", status: "running", claimedBy: "some-pat", workerId: "office-pc", heartbeatAt: new Date(Date.now() - STALE_CLAIM_MS - 5 * 60_000) });
  const finder = createFinder({ database: e.database, env: e.config, fetchImpl: async () => { throw new Error("nothing is read for a run nobody may work"); }, lookupImpl, hostGapMs: 0, workerId: "test-worker", log: () => undefined, search: async () => [] });
  const failed = await finder.runOnce();
  assert.deepEqual([failed?.runId, failed?.status], [stale, "failed"]);
  const run = (await db.collection("sales_find_runs").findOne({ _id: stale }))!;
  assert.deepEqual([run.status, run.claimedBy, run.workerId], ["failed", FINDER_WORKER, "test-worker"]);
  assert.match(run.results.note, /can no longer work it/);
  assert.ok(await db.collection("audit_events").findOne({ action: "sales.finder.claim", objectId: stale, "metadata.takeover": true, "metadata.previousWorker": "office-pc" }));
  // A fresh claim by another worker is left alone.
  await e.run({ status: "running", claimedBy: "some-pat", workerId: "office-pc", heartbeatAt: new Date() });
  assert.equal(await finder.runOnce(), null);
});

// ---- Runs that search for an offer (these come last: they add offers to the venture) -----------------------------------------------

/** An offer as the offers code stores it (docs/sales-offers.md, "Data"): the offer, and its version 1 approved unless `approved` is false. */
async function insertOffer(db: AppDb, name: string, packet: unknown, options: { state?: "active" | "paused" | "archived"; approved?: boolean } = {}): Promise<string> {
  const now = new Date();
  const offerId = `offer-${randomUUID().slice(0, 8)}`;
  const versionId = `${offerId}-v1`;
  const approved = options.approved ?? true;
  await db.collection(OFFER_VERSIONS).insertOne({
    _id: versionId, offerId, workspaceId: "workspace-a", ventureId: "venture-a", version: 1, status: approved ? "approved" : "draft", name, packet, change: "First version", proposedBy: "user-head", via: "app",
    ...(approved ? { approvedBy: "user-head", approvedAt: now } : {}), createdAt: now, updatedAt: now,
  });
  await db.collection(OFFERS).insertOne({ _id: offerId, workspaceId: "workspace-a", ventureId: "venture-a", name, state: options.state ?? "active", ...(approved ? { approvedVersionId: versionId } : {}), createdBy: "user-head", createdAt: now, updatedAt: now });
  return offerId;
}

test("a run for an offer: its packet's industries, places and search words make the searches, its negatives rule results out unread, its phrases are quoted, and the leads get the offer", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const offerId = await insertOffer(db, "Startup Build Partner", startupPacket);
  const LEDGERLY = "https://www.ledgerly.example";
  let progress = "";
  const web = fakeWeb({
    [`${LEDGERLY}/`]: async () => {
      progress = String((await db.collection("sales_find_runs").findOne({ offerId, status: "running" }))?.note ?? "");
      return { body: html(`<nav><a href="/about">About us</a> <a href="/careers">Careers</a> <a href="/contact">Contact</a></nav><h1>Bookkeeping for small shops</h1>
        <p>Ledgerly is a seed-funded SaaS startup from Bengaluru, Karnataka: we are building our MVP with forty pilot shops this year.</p>`, "<title>Ledgerly</title>") };
    },
    [`${LEDGERLY}/about`]: { body: html("<p>We are hiring engineers and designers who want to build tools for small shops.</p>") },
    [`${LEDGERLY}/contact`]: { body: html("<p>Write to hello@ledgerly.example</p><p>Request a quote for teams of fifty or more.</p>") },
    "https://pixelcraft.example/": { body: html("<p>Should never be read</p>") }, "https://bodyshop.example/": { body: html("<p>Should never be read</p>") },
  });
  const asked: string[] = [];
  const finder = createFinder({ database: e.database, env: e.config, fetchImpl: web.fetchImpl, lookupImpl, hostGapMs: 0, log: () => undefined, search: async (engine, _key, query) => {
    asked.push(query);
    return [
      { url: `${LEDGERLY}/`, title: "Ledgerly | Bookkeeping for small shops", snippet: "A seed funded startup in Bengaluru", engine },
      { url: "https://pixelcraft.example/", title: "PixelCraft", snippet: "The web-development agency for startups", engine },
      { url: "https://bodyshop.example/services", title: "IT Outsourcing Services | Bengaluru", snippet: "", engine },
    ];
  } });
  // No searches, categories or places in the plan: the packet's own.
  const id = await e.run({ offerId, request: "Seed-stage startups that need a tech partner", plan: { places: [], categories: [], searches: [], limit: 50 } });
  const result = await finder.runOnce();
  assert.deepEqual([result?.runId, result?.status, result?.found, result?.added, result?.skipped], [id, "done", 3, 1, 2], result?.note);
  assert.deepEqual(asked, ["SaaS startups seed funded Bengaluru", "fintech startups seed funded Bengaluru", "SaaS startups founders Bengaluru", "fintech startups founders Bengaluru"]);
  assert.match(result!.note, /^Searched for Startup Build Partner\. Looked at 3 company sites and read 1: added 1 lead\. Skipped: 2 ruled out by the offer's negative words\./);
  assert.match(progress, /^Searching for Startup Build Partner: SaaS startups seed funded Bengaluru \(1 of 4\), 0 sites read$/);
  assert.deepEqual(web.asked("https://pixelcraft.example"), [], "a ruled-out site is never asked for, not even its robots.txt");
  assert.deepEqual(web.asked("https://bodyshop.example"), []);

  const lead = (await db.collection("opportunities").findOne({ "externalRef.system": FINDER_SYSTEM, "externalRef.id": "ledgerly.example" }))!;
  assert.deepEqual([lead.offerId, lead.companyName, lead.category, lead.region], [offerId, "Ledgerly", "SaaS startups", "Karnataka"]);
  assert.equal(lead.observedSignal, `"We are hiring engineers and designers who want to build tools for small shops." (${LEDGERLY}/about)`, "the packet's signal beats the built-in request-a-quote one");
  const note = (await db.collection("sales_activities").findOne({ leadId: lead._id, kind: "note" }))!;
  const lines = note.body.split("\n").slice(1);
  assert.match(lines[0], /^- Hiring now: the team is growing faster than it can build: "We are hiring engineers and designers who want to build tools for small shops\." \(https:\/\/www\.ledgerly\.example\/about, seen \d{4}-\d{2}-\d{2}\)$/);
  assert.match(lines[1], /^- Still building the first version of its product: "Ledgerly is a seed-funded SaaS startup from Bengaluru, Karnataka: we are building our MVP with forty pilot shops this year\." \(https:\/\/www\.ledgerly\.example\/,/);
  assert.match(lines[2], /^- Has seed money to spend on building: "Ledgerly is a seed-funded/);
  assert.match(lines[3], /^- Asks buyers to request a quote: "Request a quote for teams of fifty or more\." \(https:\/\/www\.ledgerly\.example\/contact,/, "the built-in signals still count, after the offer's");
  const run = (await db.collection("sales_find_runs").findOne({ _id: id }))!;
  assert.deepEqual([run.status, run.results.found, run.results.added, run.results.skipped], ["done", 3, 1, 2]);
  assert.match(run.note, /^Searched for Startup Build Partner\./);

  // A run with no offer searches as before and names none; its lead gets the venture's only usable offer from the lead rules.
  const plain = fakeWeb({ "https://plainpumps.example/": { body: html("<p>Pumps for sale. Write to sales@plainpumps.example</p>", "<title>Plain Pumps</title>") } });
  const before = createFinder({ database: e.database, env: e.config, fetchImpl: plain.fetchImpl, lookupImpl, hostGapMs: 0, log: () => undefined, search: hitsFor([["https://plainpumps.example/", "Plain Pumps"]]) });
  const unnamed = await e.run();
  const old = await before.runOnce();
  assert.deepEqual([old?.runId, old?.status, old?.added], [unnamed, "done", 1], old?.note);
  assert.match(old!.note, /^Looked at 1 company site and read 1: added 1 lead\./);
  assert.equal((await db.collection("opportunities").findOne({ "externalRef.id": "plainpumps.example" }))?.offerId, offerId);
});

test("a find run whose offer is paused or has no approved version fails with a note; an enrich run for a paused offer still fills in contacts", skip, async () => {
  const e = await getEnv();
  const db = e.database.db;
  const paused = await insertOffer(db, "Dealer Commerce", dealerPacket, { state: "paused" });
  const draft = await insertOffer(db, "Spare Parts Portal", dealerPacket, { approved: false });
  const finder = createFinder({ database: e.database, env: e.config, fetchImpl: async () => { throw new Error("nothing is read for a run whose offer can't be used"); }, lookupImpl, hostGapMs: 0, log: () => undefined, search: async () => { throw new Error("nothing is searched for a run whose offer can't be used"); } });
  for (const [offerId, name] of [[paused, "Dealer Commerce"], [draft, "Spare Parts Portal"]] as const) {
    const id = await e.run({ offerId });
    const result = await finder.runOnce();
    const note = `The offer ${name} is paused or has no approved version: plan the run again`;
    assert.deepEqual([result?.runId, result?.status, result?.found, result?.note], [id, "failed", 0, note]);
    const run = (await db.collection("sales_find_runs").findOne({ _id: id }))!;
    assert.deepEqual([run.status, run.results.note, run.note], ["failed", note, note]);
  }
  assert.equal(await db.collection("opportunities").countDocuments({ offerId: { $in: [paused, draft] } }), 0);

  // An enrich run only reads a lead's own site: it works for a paused offer, and quotes that offer's approved packet.
  const lead = expectStatus(await e.app("contrib", "POST", "/sales/leads", { pipelineId: "pipeline-a", companyName: `Dealer Site ${suffix}`, ownerId: "user-contrib", website: "dealersite.example" }), 201).data;
  const web = fakeWeb({ "https://dealersite.example/": { body: html("<p>We welcome dealer enquiries from Raipur and Durg, call 98270 55555 today.</p><p>Pumps, pipes and fittings. Contact us.</p>") } });
  const enricher = createFinder({ database: e.database, env: e.config, fetchImpl: web.fetchImpl, lookupImpl, hostGapMs: 0, log: () => undefined, search: async () => { throw new Error("an enrich run never searches"); } });
  const id = await e.run({ kind: "enrich", offerId: paused, leadIds: [lead.id], request: "Fill in the contacts" });
  const result = await enricher.runOnce();
  assert.deepEqual([result?.runId, result?.kind, result?.status, result?.added], [id, "enrich", "done", 1], result?.note);
  assert.match(result!.note, /^Looked up leads for Dealer Commerce\. Looked at 1 lead and read 1 website: filled in 1\./);
  const stored = (await db.collection("opportunities").findOne({ _id: lead.id }))!;
  assert.deepEqual(stored.contactRoutes.map((route: any) => `${route.kind}:${route.value}`), ["phone:+919827055555"]);
  assert.equal(stored.category, "pumps", "the plan's categories, then the packet's industries");
  assert.match(stored.observedSignal, /^"We welcome dealer enquiries from Raipur and Durg, call 98270 55555 today\." \(https:\/\/dealersite\.example\/\)$/);
  const note = (await db.collection("sales_activities").findOne({ leadId: lead.id, kind: "note", body: /Enriched by the built-in lead finder/ }))!;
  assert.match(note.body, /- Dealers write in by phone: the catalog-to-order pitch fits: "We welcome dealer enquiries/);
  assert.ok(!note.body.includes("Takes dealer enquiries"), "the built-in dealer enquiry signal on the same words is left out");
});
