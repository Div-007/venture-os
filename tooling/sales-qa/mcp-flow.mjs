// Drives the Venture OS hosted MCP connector the way Claude would, over HTTP through the web app's /mcp route.
// Creates a short-lived personal access token for a dev user, runs the sales workflow with the tools (work session,
// then a separate review session), checks the safety refusals, then deletes the QA lead and revokes the token.
// Dev database only; the token is never printed.
//
//   node tooling/sales-qa/mcp-flow.mjs [--base http://localhost:3000]
const argv = process.argv.slice(2);
const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://localhost:3000";
const USER = "user-adarsh", HEAD = "user-adarsh"; // a venture head of Buildory
const run = Date.now().toString(36);
let failed = 0, total = 0, rpcId = 0;
function check(name, ok, detail = "") { total++; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${String(detail).slice(0, 300)}` : ""}`); return ok; }
async function api(user, method, path, body) {
  const response = await fetch(`${base}/v1${path}`, { method, headers: { "x-dev-user-id": user, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// The API restarts while it is being edited (tsx watch); give it a few tries.
let created; for (let attempt = 0; attempt < 6; attempt++) { created = await api(USER, "POST", "/pats", { name: `QA MCP flow ${run}`, scopes: ["ventures:read", "sales:read", "sales:write"], expiresInDays: 1 }); if (created.status < 500) break; await new Promise((resolve) => setTimeout(resolve, 3000)); }
const token = created.body?.data?.token, patId = created.body?.data?.pat?.id;
if (!check("dev access token created", !!token, `${created.status} ${JSON.stringify(created.body?.error ?? {})}`)) process.exit(1);

async function rpc(method, params) {
  const response = await fetch(`${base}/mcp/sales`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await response.text();
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop() ?? "null");
  return json;
}
async function tool(name, args) {
  const reply = await rpc("tools/call", { name, arguments: args });
  const content = reply?.result?.content?.[0]?.text ?? "";
  let data = null; try { data = JSON.parse(content); } catch { /* plain text */ }
  return { error: reply?.error?.message ?? (reply?.result?.isError ? content : null), data, text: content };
}

let leadId;
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vso-qa", version: "1" } });
  check("connector initializes", !!init?.result?.serverInfo, JSON.stringify(init?.error ?? init));
  const list = await rpc("tools/list", {});
  const names = new Set((list?.result?.tools ?? []).map((item) => item.name));
  check("sales tools are listed", ["start_sales", "find_leads", "get_lead", "save_verdict", "save_draft", "review_draft", "log_reply", "log_call", "list_offers", "get_offer", "propose_offer"].every((name) => names.has(name)), [...names].join(","));
  // The Venture Studio connector (/mcp) must not carry sales or the retired deal tools.
  const studio = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9999, method: "tools/list", params: {} }) }).then((r) => r.text());
  const studioJson = studio.trim().startsWith("{") ? JSON.parse(studio) : JSON.parse(studio.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop() ?? "null");
  const studioNames = (studioJson?.result?.tools ?? []).map((item) => item.name);
  check("Venture Studio connector has no sales or deal tools", !studioNames.some((name) => /^(start_sales|find_leads|save_verdict|save_draft|list_deals|add_deal|update_deal)$/.test(name)), studioNames.join(","));
  check("no send/approve/veto/override tools", ![...names].some((name) => /send|approve|veto|override|discard|mark_sent/.test(name)), [...names].filter((name) => /send|approve|veto|override/.test(name)).join(","));

  const work = await tool("start_sales", { mode: "work", timezone: "Asia/Kolkata" });
  const workSession = work.data?.sessionId;
  check("start_sales (work) returns a session and today's counts", !!workSession && !!work.data?.today, work.error ?? work.text.slice(0, 200));

  const found = await tool("find_leads", { q: "jain", limit: 5 });
  check("find_leads works", !found.error && /jain/i.test(found.text), found.error ?? found.text.slice(0, 200));

  const added = await tool("add_leads", { sessionId: workSession, ventureId: "venture-buildory", leads: [{ companyName: `QA MCP Lead ${run}`, city: "Raipur", category: "QA test record", source: "https://example.invalid/qa-listing", website: `https://qa-${run}.example.invalid`,
    observedSignal: "QA: dealer enquiry form on their site", contactRoutes: [{ kind: "phone", value: "+91 90000 00002", sourceUrl: `https://qa-${run}.example.invalid/contact` }] }] });
  leadId = added.data?.created?.[0]?.id ?? added.data?.added?.[0]?.id ?? added.data?.leads?.[0]?.id ?? added.text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
  check("add_leads creates the lead", !added.error && !!leadId, added.error ?? added.text.slice(0, 300));
  const offered = await tool("get_lead", { leadId });
  check("the lead gets the venture's offer (Dealer Commerce)", /Dealer Commerce/.test(offered.text), offered.error ?? offered.text.slice(0, 200));
  const packet = await tool("get_offer", { offer: "Dealer Commerce", ventureId: "venture-buildory" });
  check("get_offer returns the approved packet", !packet.error && !!packet.data?.packet?.gates?.length, packet.error ?? packet.text.slice(0, 200));

  const verdict = await tool("save_verdict", { leadId, sessionId: workSession, decision: "recommend", confidence: "medium", offer: "Dealer Commerce", offerFit: "QA: has dealers to serve",
    evidence: [{ claim: "Takes dealer enquiries", quote: "Become a dealer", url: `https://qa-${run}.example.invalid/dealers` }], against: "May already use a dealer app; QA record.",
    signal: "\"Become a dealer\" form on their site", summary: "QA verdict through the connector" });
  check("save_verdict (recommend) moves the lead to ready to contact", !verdict.error && verdict.data?.stage === "approved_for_contact", verdict.error ?? verdict.text.slice(0, 300));

  const draft = await tool("save_draft", { leadId, sessionId: workSession, channel: "email", purpose: "first_touch", subject: "QA connector draft", body: "QA body written through the connector. Prefer WhatsApp? Reply here and we will message you." });
  const draftId = draft.data?.draftId ?? draft.data?.id;
  check("save_draft creates a draft for review", !draft.error && !!draftId, draft.error ?? draft.text.slice(0, 300));

  const selfReview = await tool("review_draft", { draftId, sessionId: workSession, result: "pass" });
  check("the writing session cannot review its own draft", !!selfReview.error, selfReview.text.slice(0, 200));

  const review = await tool("start_sales", { mode: "review", timezone: "Asia/Kolkata" });
  const reviewSession = review.data?.sessionId;
  const reviewed = await tool("review_draft", { draftId, sessionId: reviewSession, result: "pass", notes: "QA review from a separate session" });
  check("a separate review session can pass it", !reviewed.error, reviewed.error ?? reviewed.text.slice(0, 300));
  const reviewWrites = await tool("save_draft", { leadId, sessionId: reviewSession, channel: "email", purpose: "follow_up", subject: "x", body: "x" });
  check("a review session cannot write drafts", !!reviewWrites.error, reviewWrites.text.slice(0, 200));

  const detail = await api(USER, "GET", `/sales/leads/${leadId}`);
  check("draft is ready to send in the app (a person sends it)", detail.body?.data?.drafts?.find((item) => item.id === draftId)?.status === "ready", JSON.stringify(detail.body?.data?.drafts?.map((item) => item.status)));

  const callLog = await tool("log_call", { leadId, sessionId: workSession, outcome: "no_answer", note: "QA call through the connector" });
  check("log_call works and moves the lead to contacted", !callLog.error && (callLog.data?.stage === "contacted" || /contacted/i.test(callLog.text)), callLog.error ?? callLog.text.slice(0, 200));

  const stageJump = await tool("update_lead", { leadId, sessionId: workSession, stage: "approved_for_contact" });
  check("Claude cannot approve a lead for contact by itself", !!stageJump.error, stageJump.text.slice(0, 200));
} catch (error) {
  check("connector flow ran to the end", false, error.message);
} finally {
  if (leadId) await api(HEAD, "DELETE", `/sales/leads/${leadId}`);
  if (patId) await api(USER, "POST", `/pats/${patId}/revoke`, {});
}
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
