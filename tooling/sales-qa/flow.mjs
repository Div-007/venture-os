// End-to-end sales flow against the RUNNING Venture OS dev API (through the web proxy by default).
// Creates two clearly labelled QA leads, walks the whole flow as different roles, checks every rule,
// then soft-deletes the QA leads and removes their suppression entries. Dev database only.
//
//   node tooling/sales-qa/flow.mjs [--base http://localhost:3000] [--keep]
//
// Exit code 1 when any check fails.
const argv = process.argv.slice(2);
const base = (argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://localhost:3000") + "/v1";
const keep = argv.includes("--keep");
const run = Date.now().toString(36);
const ADMIN = "user-divyansh", HEAD = "user-adarsh", SELLER = "user-abhinav", LEARNER = "user-shubham", OUTSIDER = "user-ashutosh";
const results = [];
let failed = 0;

async function call(user, method, path, body) {
  const response = await fetch(base + path, { method, headers: { "x-dev-user-id": user, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => null);
  return { status: response.status, data: json?.data, error: json?.error, raw: json };
}
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
  return !!ok;
}
const brief = (r) => `${r.status} ${r.error?.code ?? ""} ${r.error?.message ?? ""}`.trim();
const soon = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

const created = { leads: [], suppression: [] };
try {
  // 0. Overview loads for each role.
  for (const user of [ADMIN, HEAD, SELLER, LEARNER]) { const r = await call(user, "GET", "/sales/overview"); check(`overview loads as ${user}`, r.status === 200 && r.data?.counts, brief(r)); }
  const list = await call(ADMIN, "GET", "/sales/leads?limit=5&ventureId=venture-buildory");
  check("lead list pages and counts", list.status === 200 && list.data?.total > 0 && list.data.items.length <= 5, brief(list));
  const search = await call(ADMIN, "GET", "/sales/leads?q=jain&limit=5");
  check("lead search finds Jain", search.status === 200 && search.data?.items?.some((lead) => /jain/i.test(lead.companyName)), brief(search));

  // 1. A seller creates a lead they own.
  const email = `qa-${run}@example.invalid`;
  const lead = await call(SELLER, "POST", "/sales/leads", { pipelineId: "pipeline-buildory", companyName: `QA Flow Test ${run}`, ownerId: SELLER, city: "Raipur", region: "Chhattisgarh", category: "QA test record",
    contactRoutes: [{ kind: "email", value: email, publishedByCompany: true }, { kind: "phone", value: "+91 90000 00000", publishedByCompany: true }], tags: ["qa"] });
  if (!check("seller creates a lead", lead.status === 201 && lead.data?.id, brief(lead))) throw new Error("cannot continue without a lead");
  const id = lead.data.id; created.leads.push(id);
  check("new lead starts identified", lead.data.stage === "identified");

  // 2. Permissions.
  check("learner cannot edit", (await call(LEARNER, "PATCH", `/sales/leads/${id}`, { nextAction: "x" })).status === 403);
  const outsider = await call(OUTSIDER, "GET", `/sales/leads/${id}`);
  check("other venture cannot see it", outsider.status === 404, brief(outsider));
  check("learner can read it", (await call(LEARNER, "GET", `/sales/leads/${id}`)).status === 200);
  check("exit stage needs a reason", (await call(SELLER, "PATCH", `/sales/leads/${id}`, { stage: "lost" })).status === 400);

  // 3. Verdict (saved from the app here; Claude saves the same through MCP).
  const verdict = await call(SELLER, "POST", `/sales/leads/${id}/verdicts`, { decision: "recommend", confidence: "medium", offer: "Dealer Commerce", offerFit: "QA: distributor with dealers",
    evidence: [{ claim: "Has dealers", quote: "Become our dealer", url: "https://example.invalid/dealers" }], against: "QA: could already have a system", summary: "QA verdict" });
  check("verdict saved", verdict.status === 201 || verdict.status === 200, brief(verdict));
  check("recommend (medium) → ready to contact", verdict.data?.lead?.stage === "approved_for_contact", verdict.data?.lead?.stage);

  // 4. Draft → review → send (email).
  const draft = await call(SELLER, "POST", `/sales/leads/${id}/drafts`, { channel: "email", purpose: "first_touch", subject: "QA subject", body: "QA body. Prefer WhatsApp? https://wa.me/910000000000" });
  check("draft created in review", draft.data?.status === "in_review", brief(draft));
  check("cannot send before review", (await call(SELLER, "POST", `/sales/drafts/${draft.data?.id}/sent`, {})).status === 409);
  const review = await call(HEAD, "POST", `/sales/drafts/${draft.data?.id}/review`, { result: "pass", issues: [], notes: "QA review" });
  check("review pass → ready", review.data?.status === "ready", brief(review));
  check("smtp sending is off", (await call(SELLER, "POST", `/sales/drafts/${draft.data?.id}/sent`, { sentVia: "smtp" })).status === 503);
  const sent = await call(SELLER, "POST", `/sales/drafts/${draft.data?.id}/sent`, { sentVia: "manual", requestId: `qa-send-${run}` });
  check("mark sent works", (sent.status === 200 || sent.status === 201) && sent.data?.draft?.status === "sent", brief(sent));
  check("first touch → contacted", sent.data?.lead?.stage === "contacted", sent.data?.lead?.stage);
  check("follow-up scheduled", !!sent.data?.lead?.followUpDueAt);

  // 5. WhatsApp only after opt-in.
  const wa = await call(SELLER, "POST", `/sales/leads/${id}/drafts`, { channel: "whatsapp", purpose: "follow_up", body: "QA WhatsApp follow-up" });
  await call(HEAD, "POST", `/sales/drafts/${wa.data?.id}/review`, { result: "pass" });
  const waBlocked = await call(SELLER, "POST", `/sales/drafts/${wa.data?.id}/sent`, {});
  check("WhatsApp blocked without opt-in", waBlocked.status === 409, brief(waBlocked));

  // 6. Reply → replied, follow-ups discarded, inbox.
  const reply = await call(SELLER, "POST", `/sales/leads/${id}/activities`, { kind: "email", direction: "in", body: "QA: sounds interesting, call me", replyType: "interested", requestId: `qa-reply-${run}` });
  check("reply logged → replied", reply.data?.lead?.stage === "replied", brief(reply));
  const again = await call(SELLER, "POST", `/sales/leads/${id}/activities`, { kind: "email", direction: "in", body: "QA: sounds interesting, call me", replyType: "interested", requestId: `qa-reply-${run}` });
  check("same requestId does not log twice", again.data?.activity?.id === reply.data?.activity?.id, brief(again));
  const detail = await call(SELLER, "GET", `/sales/leads/${id}`);
  check("pending WhatsApp follow-up discarded on reply", detail.data?.drafts?.find((d) => d.id === wa.data?.id)?.status === "discarded");
  check("follow-up cleared on reply", !detail.data?.lead?.followUpDueAt);
  const inbox = await call(SELLER, "GET", "/sales/inbox?handled=false");
  check("reply waits in the inbox", inbox.data?.some((item) => item.activity.id === reply.data?.activity?.id), brief(inbox));
  const handled = await call(SELLER, "POST", `/sales/activities/${reply.data?.activity?.id}/handled`, {});
  check("mark handled", handled.status === 200 && !!handled.data?.handledAt, brief(handled));

  // 7. Call: yes to WhatsApp → opt-in → WhatsApp can be sent.
  const call1 = await call(SELLER, "POST", `/sales/leads/${id}/activities`, { kind: "call", direction: "out", callOutcome: "yes_whatsapp", body: "QA call" });
  check("call 'yes, WhatsApp me' records opt-in", !!call1.data?.lead?.whatsappOptIn, brief(call1));
  const wa2 = await call(SELLER, "POST", `/sales/leads/${id}/drafts`, { channel: "whatsapp", purpose: "reply", body: "QA details on WhatsApp" });
  await call(HEAD, "POST", `/sales/drafts/${wa2.data?.id}/review`, { result: "pass" });
  const waSent = await call(SELLER, "POST", `/sales/drafts/${wa2.data?.id}/sent`, {});
  check("WhatsApp allowed after opt-in", waSent.status === 200 || waSent.status === 201, brief(waSent));

  // 8. Meeting → proposal → won → delivery work.
  check("book discovery call", (await call(SELLER, "POST", `/sales/leads/${id}/activities`, { kind: "call", direction: "out", callOutcome: "interested_book" })).data?.lead?.stage === "discovery_booked");
  check("move to proposal", (await call(SELLER, "PATCH", `/sales/leads/${id}`, { stage: "proposal" })).data?.stage === "proposal");
  const won = await call(SELLER, "PATCH", `/sales/leads/${id}`, { stage: "won" });
  check("legacy 'won' accepted → invoice_contract + wonAt", won.data?.stage === "invoice_contract" && !!won.data?.wonAt, brief(won));
  const overview = await call(HEAD, "GET", "/sales/overview?ventureId=venture-buildory");
  check("won shows in 'won to hand over'", overview.data?.wonToHandOver?.some((card) => card.id === id), brief(overview));
  const work = await call(HEAD, "POST", `/sales/leads/${id}/delivery-work`, {});
  check("create delivery work → task", (work.status === 201 || work.status === 200) && work.data?.task?.id && work.data?.lead?.deliveryTaskId, brief(work));

  // 9. Opt-out on a second lead → disqualified, suppressed everywhere.
  const lead2 = await call(SELLER, "POST", "/sales/leads", { pipelineId: "pipeline-buildory", companyName: `QA Opt-out Test ${run}`, ownerId: SELLER, contactRoutes: [{ kind: "email", value: `optout-${run}@example.invalid` }], tags: ["qa"] });
  created.leads.push(lead2.data?.id);
  await call(SELLER, "POST", `/sales/leads/${lead2.data?.id}/activities`, { kind: "email", direction: "out", body: "QA first touch" });
  const optOut = await call(SELLER, "POST", `/sales/leads/${lead2.data?.id}/activities`, { kind: "email", direction: "in", body: "QA: please stop", replyType: "opt_out" });
  check("opt-out → disqualified + do not contact", optOut.data?.lead?.stage === "disqualified" && optOut.data?.lead?.doNotContact, brief(optOut));
  check("outbound refused after opt-out", (await call(SELLER, "POST", `/sales/leads/${lead2.data?.id}/activities`, { kind: "email", direction: "out", body: "x" })).status === 409);
  const lead3 = await call(SELLER, "POST", "/sales/leads", { pipelineId: "pipeline-buildory", companyName: `QA Same Person ${run}`, ownerId: SELLER, contactRoutes: [{ kind: "email", value: `optout-${run}@example.invalid` }], tags: ["qa"] });
  created.leads.push(lead3.data?.id);
  check("new lead with an opted-out email is flagged", lead3.data?.doNotContact === true, brief(lead3));
  const suppression = await call(ADMIN, "GET", "/sales/suppression");
  // Opt-outs also block the company's own email domain, so collect every entry made from the QA leads.
  for (const entry of suppression.data ?? []) if (String(entry.value).includes(run) || created.leads.includes(entry.leadId)) created.suppression.push(entry.id);
  check("suppression entries created", created.suppression.length > 0);

  // 10. Soft delete hides it.
  if (!keep) {
    check("seller cannot delete after contact", (await call(SELLER, "DELETE", `/sales/leads/${id}`)).status === 403);
    for (const leadId of created.leads.filter(Boolean)) await call(HEAD, "DELETE", `/sales/leads/${leadId}`);
    const gone = await call(ADMIN, "GET", `/sales/leads?q=${encodeURIComponent(`QA Flow Test ${run}`)}`);
    check("deleted lead hidden from the list", gone.data?.total === 0, brief(gone));
    const legacy = await call(ADMIN, "GET", "/opportunities");
    check("deleted lead hidden from older /opportunities", !legacy.data?.some((row) => row.id === id));
  }
} catch (error) {
  check("flow ran to the end", false, error.message);
} finally {
  if (!keep) for (const entry of created.suppression) await call(ADMIN, "DELETE", `/sales/suppression/${entry}`, { reason: "QA test record" });
}
console.log(`\n${results.length - failed}/${results.length} checks passed${keep ? " (QA leads kept)" : ""}`);
process.exit(failed ? 1 : 0);
