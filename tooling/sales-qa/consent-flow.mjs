// WhatsApp consent end to end: Claude logs "they said yes to WhatsApp" through the connector (no opt-in yet),
// a person sees the prompt in the lead drawer and confirms it, and only then can a WhatsApp draft be sent.
// Creates a QA lead and a 1-day token for a venture head, cleans both up. Dev database only; the token is never printed.
//
//   node tooling/sales-qa/consent-flow.mjs [--base http://localhost:3000] [--phone]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(homedir(), ".claude/skills/gstack/node_modules/"));
const { chromium } = require("playwright");
const argv = process.argv.slice(2);
const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://localhost:3000";
const phone = argv.includes("--phone");
const USER = "user-adarsh"; // venture head of Buildory: owns the QA lead, holds the token, confirms in the app
const run = Date.now().toString(36);
const out = join(process.env.QA_OUT ?? join(homedir(), "AppData/Local/Temp/claude/vso-qa"), `consent-flow-${phone ? "phone" : "desktop"}-${run}`);
mkdirSync(out, { recursive: true });
let failed = 0, total = 0, rpcId = 0;
function check(name, ok, detail = "") { total++; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${String(detail).slice(0, 300)}` : ""}`); return ok; }
async function api(method, path, body) {
  const response = await fetch(`${base}/v1${path}`, { method, headers: { "x-dev-user-id": USER, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
}

let created; for (let attempt = 0; attempt < 6; attempt++) { created = await api("POST", "/pats", { name: `QA consent ${run}`, scopes: ["ventures:read", "sales:read", "sales:write"], expiresInDays: 1 }); if (created.status < 500) break; await new Promise((resolve) => setTimeout(resolve, 3000)); }
const token = created.body?.data?.token, patId = created.body?.data?.pat?.id;
if (!check("dev access token created", !!token, created.status)) process.exit(1);
async function tool(name, args) {
  const response = await fetch(`${base}/mcp/sales`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }) });
  const text = await response.text();
  const reply = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop() ?? "null");
  const content = reply?.result?.content?.[0]?.text ?? "";
  return { error: reply?.error?.message ?? (reply?.result?.isError ? content : null), text: content };
}

const lead = (await api("POST", "/sales/leads", { pipelineId: "pipeline-buildory", companyName: `QA Consent ${run}`, ownerId: USER, city: "Raipur", category: "QA test record", stage: "approved_for_contact",
  contactRoutes: [{ kind: "phone", value: "+91 90000 00003" }, { kind: "whatsapp", value: "+91 90000 00003" }], tags: ["qa"] })).body?.data;
const browser = await chromium.launch({ headless: true });
try {
  check("QA lead created", !!lead?.id);
  const work = await tool("start_sales", { mode: "work", timezone: "Asia/Kolkata" });
  let workSession; try { workSession = JSON.parse(work.text).sessionId; } catch { workSession = undefined; }
  check("work session started", !!workSession, work.error ?? work.text.slice(0, 120));
  const logged = await tool("log_call", { leadId: lead.id, sessionId: workSession, outcome: "yes_whatsapp", note: "QA: said yes to WhatsApp on the call" });
  check("Claude logs the call", !logged.error, logged.error);
  check("Claude is told a person must confirm", /confirm/i.test(logged.text), logged.text.slice(0, 200));
  let detail = (await api("GET", `/sales/leads/${lead.id}`)).body?.data;
  check("WhatsApp is still closed after Claude's log", !detail?.lead?.whatsappOptIn);

  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
  await context.addInitScript((user) => { try { localStorage.setItem("vso-dev-user-id", user); } catch {} }, USER);
  const page = await context.newPage();
  await page.goto(`${base}/sales/live/leads?lead=${lead.id}`, { waitUntil: "load" }); await page.waitForTimeout(2500);
  const drawer = page.getByRole("dialog");
  const prompt = drawer.getByText(/Claude logged that they said yes to WhatsApp/i);
  check("drawer shows the confirm prompt", await prompt.isVisible().catch(() => false));
  check("timeline marks the call as logged by Claude", await drawer.getByText(/Logged by Claude/i).count() > 0);
  await page.screenshot({ path: join(out, "1-prompt.jpg"), type: "jpeg", quality: 70 });
  await drawer.getByRole("button", { name: /Confirm: they agreed/ }).click(); await page.waitForTimeout(2000);
  await page.screenshot({ path: join(out, "2-confirmed.jpg"), type: "jpeg", quality: 70 });
  detail = (await api("GET", `/sales/leads/${lead.id}`)).body?.data;
  check("a person's confirmation opens WhatsApp", detail?.lead?.whatsappOptIn?.how === "yes_on_call" && detail?.lead?.whatsappOptIn?.by === USER, JSON.stringify(detail?.lead?.whatsappOptIn));
  check("drawer now offers WhatsApp", await drawer.getByRole("link", { name: /WhatsApp/ }).count() > 0);
  await context.close();
} catch (error) {
  check("consent flow ran to the end", false, error.message.split("\n")[0]);
} finally {
  await browser.close();
  if (lead?.id) await api("DELETE", `/sales/leads/${lead.id}`);
  if (patId) await api("POST", `/pats/${patId}/revoke`, {});
}
console.log(`\n${total - failed}/${total} checks passed · screenshots: ${out}`);
process.exit(failed ? 1 : 0);
