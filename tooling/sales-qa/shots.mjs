// Screenshot + health pass over the Venture OS Sales (Dealflow) pages on the local dev server.
// Uses gstack's bundled Playwright and its cached Chromium (no downloads).
//
//   node tooling/sales-qa/shots.mjs [--base http://localhost:3000] [--out <dir>] [--as user-divyansh] [--only leads,review] [--variants desktop-light,phone-dark]
//
// Writes one JPEG per page and variant plus report.json / report.md (console errors, failed API calls,
// horizontal overflow, small tap targets on phones, Next.js error overlays).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(homedir(), ".claude/skills/gstack/node_modules/"));
const { chromium } = require("playwright");

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]?.startsWith("--") || all[index + 1] === undefined ? "true" : all[index + 1]]] : pairs), []));
const base = args.base ?? "http://localhost:3000";
const api = args.api ?? "http://localhost:4000";
const as = args.as ?? "user-divyansh";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = args.out ?? join(process.env.QA_OUT ?? join(homedir(), "AppData/Local/Temp/claude/vso-qa"), `${stamp}-${as}`);
mkdirSync(out, { recursive: true });

const VARIANTS = {
  "desktop-light": { viewport: { width: 1440, height: 900 }, dark: false, mobile: false },
  "desktop-dark": { viewport: { width: 1440, height: 900 }, dark: true, mobile: false },
  "phone-light": { viewport: { width: 390, height: 844 }, dark: false, mobile: true },
  "phone-dark": { viewport: { width: 390, height: 844 }, dark: true, mobile: true },
};
const variants = (args.variants ?? Object.keys(VARIANTS).join(",")).split(",").filter((name) => VARIANTS[name]);

async function firstLeadId() {
  try {
    const response = await fetch(`${api}/v1/sales/leads?limit=1&sort=relevance`, { headers: { "x-dev-user-id": as } });
    const body = await response.json();
    return body?.data?.items?.[0]?.id;
  } catch { return undefined; }
}

const leadId = await firstLeadId();
let PAGES = [
  ["overview", "/sales/live"], ["leads", "/sales/live/leads"], ["lead-drawer", leadId ? `/sales/live/leads?lead=${leadId}` : null],
  ["review", "/sales/live/review"], ["inbox", "/sales/live/inbox"], ["pipeline", "/sales/live/pipeline"], ["plays", "/sales/live/plays"],
  ["brain", "/sales/live/brain?venture=venture-buildory"], ["calls", "/sales/live/calls"], ["find", "/sales/live/find"], ["do-not-contact", "/sales/live/do-not-contact"], ["reports", "/sales/live/reports"], ["setup", "/sales/live/setup?venture=venture-edithood"],
].filter(([, path]) => path);
if (args.only) { const only = new Set(args.only.split(",")); PAGES = PAGES.filter(([name]) => only.has(name)); }

const browser = await chromium.launch({ headless: true });
const report = [];
for (const variantName of variants) {
  const variant = VARIANTS[variantName];
  const context = await browser.newContext({ viewport: variant.viewport, isMobile: variant.mobile, hasTouch: variant.mobile, deviceScaleFactor: variant.mobile ? 2 : 1, reducedMotion: "reduce", colorScheme: variant.dark ? "dark" : "light" });
  await context.addCookies([{ name: "venture_studio_theme", value: variant.dark ? "dark" : "light", url: base }]);
  await context.addInitScript((user) => { try { window.localStorage.setItem("vso-dev-user-id", user); } catch {} }, as);
  for (const [name, path] of PAGES) {
    const page = await context.newPage();
    const issues = { console: [], pageErrors: [], failedApi: [] };
    page.on("console", (message) => { if (message.type() === "error") issues.console.push(message.text().slice(0, 300)); });
    page.on("pageerror", (error) => issues.pageErrors.push(String(error.message).slice(0, 300)));
    page.on("response", (response) => { const url = response.url(); if (url.includes("/v1/") && response.status() >= 400) issues.failedApi.push(`${response.status()} ${response.request().method()} ${url.replace(base, "")}`); });
    const started = Date.now();
    try {
      await page.goto(base + path, { waitUntil: "load", timeout: 45_000 });
      await page.waitForFunction(() => !document.querySelector(".vso-skeleton, [aria-busy='true'], [role='status'][aria-label^='Loading']"), null, { timeout: 12_000 }).catch(() => issues.console.push("(still loading after 12 s)"));
      await page.waitForTimeout(600);
    } catch (error) { issues.pageErrors.push(`navigation: ${error.message.slice(0, 200)}`); }
    const loadMs = Date.now() - started;
    const checks = await page.evaluate((mobile) => {
      const width = window.innerWidth;
      const overflowX = document.documentElement.scrollWidth - width;
      const wide = [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > width + 2 && getComputedStyle(el).position !== "fixed"; })
        // Inside a container that scrolls or clips sideways (a board, a chip row) is by design.
        .filter((el) => { for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) { const x = getComputedStyle(node).overflowX; if (x === "auto" || x === "scroll" || x === "hidden" || x === "clip") return node.getBoundingClientRect().right > width + 2; } return true; })
        .slice(0, 6).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${[...el.classList].slice(0, 3).join(".")} right=${Math.round(el.getBoundingClientRect().right)}`);
      const small = mobile ? [...document.querySelectorAll("button, a[href], [role='button'], input, select")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32) && getComputedStyle(el).visibility !== "hidden"; })
        .slice(0, 8).map((el) => `${(el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`) : [];
      const overlay = !!document.querySelector("nextjs-portal")?.shadowRoot?.querySelector("[data-nextjs-dialog], [data-issues]");
      const heading = document.querySelector("h1")?.textContent?.trim() ?? "";
      const emptyText = document.body.innerText.length < 40;
      return { overflowX, wide, small, overlay, heading, emptyText };
    }, variant.mobile).catch((error) => ({ error: String(error) }));
    const file = `${name}--${variantName}.jpg`;
    await page.screenshot({ path: join(out, file), fullPage: true, type: "jpeg", quality: 70 }).catch((error) => issues.pageErrors.push(`screenshot: ${error.message.slice(0, 120)}`));
    report.push({ page: name, path, variant: variantName, file, loadMs, ...checks, ...issues });
    await page.close();
    // The API allows 300 reads a minute per person; a page makes up to ~14 calls, so pace the pass.
    await new Promise((resolve) => setTimeout(resolve, Number(args.pause ?? 2500)));
  }
  await context.close();
}
await browser.close();

writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
const lines = [`# Sales screenshot pass (${as}) ${stamp}`, "", "| page | variant | load ms | overflow px | past edge | console | page errors | failed API | overlay | small taps |", "|---|---|---|---|---|---|---|---|---|---|"];
for (const row of report) lines.push(`| ${row.page} | ${row.variant} | ${row.loadMs} | ${row.overflowX ?? "?"} | ${row.wide?.length ?? 0} | ${row.console.length} | ${row.pageErrors.length} | ${row.failedApi.length} | ${row.overlay ? "YES" : ""} | ${row.small?.length ?? 0} |`);
lines.push("", "## Details", "");
for (const row of report) {
  const problems = [...row.pageErrors.map((x) => `page error: ${x}`), ...row.console.map((x) => `console: ${x}`), ...row.failedApi.map((x) => `api: ${x}`), ...(row.overflowX > 1 || row.wide?.length ? [`overflow page=${row.overflowX}px, elements past the screen edge: ${row.wide.join("; ")}`] : []), ...(row.small?.length ? [`small tap targets: ${row.small.join("; ")}`] : []), ...(row.overlay ? ["Next.js error overlay"] : [])];
  if (problems.length) lines.push(`### ${row.page} · ${row.variant}`, ...problems.map((x) => `- ${x}`), "");
}
writeFileSync(join(out, "report.md"), lines.join("\n"));
console.log(lines.slice(0, 4 + report.length).join("\n"));
console.log(`\nshots: ${out}`);
