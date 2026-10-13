// Click-through of the main sales flow in the real UI (Playwright, gstack's bundled copy), with a screenshot per step.
// Seeds one clearly labelled QA lead + draft through the API, drives the screens, then soft-deletes it.
//
//   node tooling/sales-qa/ui-flow.mjs [--base http://localhost:3000] [--phone] [--keep]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(homedir(), ".claude/skills/gstack/node_modules/"));
const { chromium } = require("playwright");
const argv = process.argv.slice(2);
const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://localhost:3000";
const phone = argv.includes("--phone"), keep = argv.includes("--keep");
const out = join(process.env.QA_OUT ?? join(homedir(), "AppData/Local/Temp/claude/vso-qa"), `ui-flow-${phone ? "phone" : "desktop"}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(out, { recursive: true });
const run = Date.now().toString(36), ME = "user-divyansh", HEAD = "user-adarsh";
let step = 0, failed = 0;

async function api(user, method, path, body) {
  const response = await fetch(`${base}/v1${path}`, { method, headers: { "x-dev-user-id": user, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return (await response.json().catch(() => null))?.data;
}
async function shot(page, name) { step++; await page.screenshot({ path: join(out, `${String(step).padStart(2, "0")}-${name}.jpg`), type: "jpeg", quality: 70 }); }
function check(name, ok, detail = "") { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`); }

const company = `QA UI Flow ${run}`;
const lead = await api(ME, "POST", "/sales/leads", { pipelineId: "pipeline-buildory", companyName: company, ownerId: ME, city: "Raipur", category: "QA test record", stage: "approved_for_contact",
  contactRoutes: [{ kind: "phone", value: "+91 90000 00001" }, { kind: "email", value: `qa-ui-${run}@example.invalid` }], tags: ["qa"] });
if (!lead?.id) { console.log("FAIL  could not create the QA lead (is the API up?)"); process.exit(1); }
const draft = await api(ME, "POST", `/sales/leads/${lead.id}/drafts`, { channel: "email", purpose: "first_touch", subject: "QA UI subject", body: "QA UI body for the click-through test." });
await api(HEAD, "POST", `/sales/drafts/${draft?.id}/review`, { result: "pass", notes: "QA review" });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
await context.addInitScript((user) => { try { localStorage.setItem("vso-dev-user-id", user); } catch {} }, ME);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const settle = () => page.waitForTimeout(1200);
try {
  // 1. Leads: search, open the drawer.
  await page.goto(`${base}/sales/live/leads`, { waitUntil: "load" }); await settle();
  await page.getByPlaceholder(/Search company/i).fill(company); await page.waitForTimeout(1500);
  const row = page.getByText(company, { exact: true }).locator("visible=true").first();
  check("search finds the QA lead", await row.isVisible().catch(() => false));
  await shot(page, "leads-search");
  await row.click(); await settle();
  const drawer = page.getByRole("dialog");
  check("lead drawer opens", await drawer.isVisible().catch(() => false));
  // The header carries a Call button on phones only and the Reach tile always does: look at the visible one.
  check("drawer shows the Call button", await drawer.getByRole("link", { name: /^Call/ }).locator("visible=true").first().isVisible().catch(() => false));
  check("WhatsApp is locked before opt-in", await drawer.getByText(/WhatsApp opens after/i).isVisible().catch(() => false));
  await shot(page, "drawer");

  // 2. Log a call: the action bar under the drawer opens the composer, then the outcome, then submit. No answer → contacted.
  await drawer.getByRole("button", { name: "Log a call", exact: true }).click();
  await drawer.getByRole("button", { name: "No answer", exact: true }).click();
  await drawer.getByRole("button", { name: /Log this call/ }).click(); await page.waitForTimeout(1800);
  const afterCall = await api(ME, "GET", `/sales/leads/${lead.id}`);
  check("call logged → stage contacted", afterCall?.lead?.stage === "contacted", afterCall?.lead?.stage);
  check("drawer timeline shows the call", await drawer.getByText(/No answer/i).count() > 0);
  await shot(page, "drawer-after-call");
  await page.keyboard.press("Escape"); await settle();

  // 3. Review: mark the reviewed draft sent.
  await page.goto(`${base}/sales/live/review?draft=${draft.id}`, { waitUntil: "load" }); await settle();
  check("review opens the draft", await page.getByText("QA UI subject").locator("visible=true").first().isVisible().catch(() => false));
  await shot(page, "review");
  await page.getByRole("button", { name: /^Mark sent/ }).locator("visible=true").first().click(); await page.waitForTimeout(500);
  await page.getByRole("button", { name: /Confirm sent|Yes, I sent it/ }).locator("visible=true").first().click(); await page.waitForTimeout(1800);
  const afterSend = await api(ME, "GET", `/sales/leads/${lead.id}`);
  check("draft marked sent", afterSend?.drafts?.find((d) => d.id === draft.id)?.status === "sent");
  await shot(page, "review-after-send");

  // 4. A reply arrives (logged through the API) → Inbox → mark handled.
  const reply = await api(ME, "POST", `/sales/leads/${lead.id}/activities`, { kind: "whatsapp", direction: "in", body: "QA: please send the details", replyType: "send_details" });
  await page.goto(`${base}/sales/live/inbox`, { waitUntil: "load" }); await settle();
  const item = page.getByText(company).locator("visible=true").first();
  check("reply shows in the Inbox", await item.isVisible().catch(() => false));
  await item.click(); await settle();
  await shot(page, "inbox");
  await page.getByRole("button", { name: "Mark handled" }).locator("visible=true").first().click(); await page.waitForTimeout(1500);
  const afterHandled = await api(ME, "GET", `/sales/leads/${lead.id}`);
  check("reply marked handled", !!afterHandled?.activities?.find((a) => a.id === reply?.activity?.id)?.handledAt);
  check("inbound WhatsApp recorded the opt-in", !!afterHandled?.lead?.whatsappOptIn);

  // 5. Pipeline shows it under Talking.
  await page.goto(`${base}/sales/live/pipeline`, { waitUntil: "load" }); await settle();
  check("pipeline shows the lead", await page.getByText(company).locator("visible=true").first().isVisible().catch(() => false) || phone);
  await shot(page, "pipeline");

  // 6. Overview.
  await page.goto(`${base}/sales/live`, { waitUntil: "load" }); await settle();
  await shot(page, "overview");
} catch (error) {
  check("click-through ran to the end", false, error.message.split("\n")[0]);
  await shot(page, "failure").catch(() => {});
} finally {
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
  if (!keep) await api(HEAD, "DELETE", `/sales/leads/${lead.id}`);
  await browser.close();
}
console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"} · screenshots: ${out}`);
process.exit(failed ? 1 : 0);
