"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Draft, Play } from "@venture-studio/contracts";
import { ArrowLeft, ArrowUpRight, Check, CircleAlert, CircleCheck, Clock3, Copy, Edit, Info, Mail, ShieldCheck, Sparkles, X, type Icon } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { ActionLabel, Badge, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { approveDraft, discardDraft, markDraftSent, updateDraft, vetoDraft, type ReviewDraft, type SalesSettingsView } from "@/lib/sales-api";
import { Phone, Trash, UserX, Whatsapp } from "./draft-icons";
import { approvalOf, canApprove, canEditLead, canWriteIn, ChannelTile, copyText, CHANNEL_LABEL, kickerClass, linkedinHref, mailtoHref, OPT_IN_LABEL, PURPOSE_LABEL, routeOf, shortSession, stamp, telHref, waDigits, waHref, wordCount } from "./draft-shared";
import { useSalesShell } from "./sales-context";
import { StageChip, VerdictChip, when } from "./sales-ui";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
export const DRAFT_STATUS: Record<Draft["status"], { label: string; tone: Tone }> = {
  draft: { label: "Not submitted", tone: "neutral" }, in_review: { label: "To review", tone: "blue" }, ready: { label: "Ready to send", tone: "green" },
  needs_changes: { label: "Needs changes", tone: "amber" }, sent: { label: "Sent", tone: "purple" }, vetoed: { label: "Vetoed", tone: "red" }, discarded: { label: "Discarded", tone: "neutral" },
};

export type DraftChange = { kind: "edited" | "approved" | "sent" | "closed"; draft: Draft };

/** The right-hand pane of Review: one draft, Claude's review of it, and what a person can do next. */
export function DraftReader({ draft, play, settings, editNonce, onBack, onChanged }: { draft: ReviewDraft; play?: Play; settings?: SalesSettingsView; editNonce: number; onBack: () => void; onChanged: (change: DraftChange) => void }) {
  const { session, openLead, refresh, personName, ventureName } = useSalesShell();
  const lead = draft.lead;
  // What this person may do here, as the API decides it: any writer in the venture vetoes and copies; the lead's owner, a venture head
  // or an admin edits, sends and discards (the draft's author may discard too). Learners only read.
  const writer = canWriteIn(session, draft.ventureId);
  const editor = canEditLead(session, lead);
  const mayDiscard = editor || (writer && draft.authorId === session?.user.id);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);
  const [confirm, setConfirm] = useState<"sent" | "veto" | "discard" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Nothing is sent to, or opened for, a company on the do-not-contact list.
  const doNotContact = lead.doNotContact;

  const open = !["sent", "vetoed", "discarded"].includes(draft.status);
  const isEmail = draft.channel === "email";
  const isCallOpener = draft.channel === "call_opener";
  const approval = approvalOf(draft, play, settings);
  const mayApprove = approval.needed && canApprove(session, draft, approval.reason);
  const whatsappLocked = draft.channel === "whatsapp" && !lead.whatsappOptIn;
  const sendable = draft.status === "ready" && !approval.needed && !isCallOpener && !doNotContact;
  const approver = approval.reason === "every_message" ? "the lead's owner or a venture head" : "a venture head";
  /** Why Mark sent is off, said next to it (a tooltip alone is not seen on a phone). */
  const sendBlocked = draft.status !== "ready" || isCallOpener ? "" : doNotContact ? "On the do-not-contact list" : whatsappLocked ? "They have not opted in to WhatsApp" : approval.needed ? (mayApprove ? "Approve it first" : `Waits for ${approver} to approve it`) : "";
  const emailRoute = routeOf(lead.contactRoutes, "email");
  const emailLink = emailRoute ? mailtoHref(emailRoute.value, draft.subject ?? "", draft.body) : "";
  const phoneRoute = routeOf(lead.contactRoutes, "whatsapp", "phone");
  const phoneLink = phoneRoute ? telHref(phoneRoute.value) : "";
  const linkedinRoute = routeOf(lead.contactRoutes, "linkedin");
  const linkedinLink = linkedinRoute ? linkedinHref(linkedinRoute.value) : "";
  const digits = phoneRoute ? waDigits(phoneRoute.value) : "";
  const fullText = isEmail && draft.subject ? `Subject: ${draft.subject}\n\n${draft.body}` : draft.body;
  const toLine = isEmail ? emailRoute?.value : draft.channel === "whatsapp" ? phoneRoute?.value : draft.channel === "linkedin" ? linkedinRoute?.value : phoneRoute?.value;
  const status: { label: string; tone: Tone } = approval.needed ? { label: "To approve", tone: "blue" } : DRAFT_STATUS[draft.status];

  const startEdit = useCallback(() => { setSubject(draft.subject ?? ""); setBody(draft.body); setConfirm(null); setError(""); setEditing(true); }, [draft.subject, draft.body]);
  const seenNonce = useRef(editNonce);
  useEffect(() => {
    if (editNonce === seenNonce.current) return;
    seenNonce.current = editNonce;
    if (editor && ["draft", "in_review", "ready", "needs_changes"].includes(draft.status)) queueMicrotask(startEdit);
  }, [editNonce, editor, draft.status, startEdit]);
  // One request id for marking this draft sent, made when the confirm opens and kept for retries, so a retry after a lost answer
  // repeats the first one instead of logging the message twice.
  const sentRequestId = useRef("");

  async function run<T>(name: string, action: () => Promise<T>, done: (result: T) => void) {
    setBusy(name); setError("");
    try { done(await action()); }
    catch (cause) { setError(describeError(cause, "That did not work. Try again.")); }
    finally { setBusy(""); }
  }

  function save() {
    const text = body.trim();
    if (!text) { setError("Write the message first."); return; }
    const change: { subject?: string; body?: string } = {};
    if (text !== draft.body) change.body = text;
    if (isEmail && subject.trim() !== (draft.subject ?? "")) change.subject = subject.trim();
    if (!change.body && change.subject === undefined) { setEditing(false); return; }
    void run("save", () => updateDraft(draft.id, change), (updated) => {
      setEditing(false);
      toast({ title: "Saved. It goes back to review.", body: lead.companyName });
      onChanged({ kind: "edited", draft: updated }); refresh();
    });
  }
  const approve = () => void run("approve", () => approveDraft(draft.id), (updated) => { toast({ title: "Approved", body: `${lead.companyName}. You can send it now.` }); onChanged({ kind: "approved", draft: updated }); refresh(); });
  function confirmSent() {
    if (!sentRequestId.current) sentRequestId.current = crypto.randomUUID();
    setConfirm("sent"); setError("");
  }
  const markSent = () => void run("sent", () => markDraftSent(draft.id, { sentVia: "manual", requestId: sentRequestId.current || (sentRequestId.current = crypto.randomUUID()) }), (result) => {
    setConfirm(null);
    toast({ title: "Marked as sent", body: result.lead.followUpDueAt ? `${lead.companyName}. Follow-up due ${when(result.lead.followUpDueAt)}.` : lead.companyName });
    onChanged({ kind: "sent", draft: result.draft }); refresh();
  });
  function veto() {
    if (reason.trim().length < 3) { setError("Say why in a few words, so Claude and the team learn from it."); return; }
    void run("veto", () => vetoDraft(draft.id, { reason: reason.trim() }), (updated) => { setConfirm(null); setReason(""); toast({ title: "Vetoed", body: lead.companyName }); onChanged({ kind: "closed", draft: updated }); refresh(); });
  }
  const discard = () => void run("discard", () => discardDraft(draft.id), (updated) => { setConfirm(null); toast({ title: "Discarded", body: lead.companyName }); onChanged({ kind: "closed", draft: updated }); refresh(); });

  const openButton = !sendable || !editor ? null
    : isEmail ? (emailLink
      ? <a href={emailLink} onClick={() => void copyText(fullText, "Copied. Your mail app is opening.")} className={primaryClass}><Mail size={16} />Copy and open mail app</a>
      : <button type="button" disabled className={primaryClass}><Mail size={16} />{emailRoute ? "Email address is not usable" : "No email on file"}</button>)
      : draft.channel === "whatsapp" ? (!whatsappLocked && digits
        ? <a href={waHref(digits, draft.body)} target="_blank" rel="noopener noreferrer" className={primaryClass}><Whatsapp size={16} />Open WhatsApp</a>
        : <button type="button" disabled className={primaryClass}><Whatsapp size={16} />Open WhatsApp</button>)
        : draft.channel === "linkedin" ? (linkedinLink
          ? <a href={linkedinLink} target="_blank" rel="noopener noreferrer" onClick={() => void copyText(fullText, "Copied. Paste it into LinkedIn.")} className={primaryClass}><ArrowUpRight size={16} />Copy and open LinkedIn</a>
          : <button type="button" onClick={() => void copyText(fullText)} className={primaryClass}><Copy size={16} />Copy text</button>)
          : null;

  return <article className="vso-fade-enter min-w-0">
    <div className="flex flex-wrap items-start gap-3 border-b border-neutral-100 px-4 py-4 sm:px-5">
      <button type="button" onClick={onBack} aria-label="Back to the list" className="-ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.95] lg:hidden"><ArrowLeft size={18} /></button>
      <ChannelTile channel={draft.channel} size={40} className="max-sm:hidden" />
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-extrabold tracking-[-.02em] text-neutral-900 [overflow-wrap:anywhere]">{lead.companyName}{lead.city ? <span className="font-semibold text-neutral-400"> · {lead.city}</span> : null}</h2>
        <p className="mt-0.5 text-xs font-medium text-neutral-500">{PURPOSE_LABEL[draft.purpose]} by {CHANNEL_LABEL[draft.channel].toLowerCase()}{lead.contactName ? ` · for ${lead.contactName}` : ""}</p>
      </div>
      <Badge tone={status.tone}>{status.label}</Badge>
    </div>

    <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-4">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
          <span>To <b className="font-semibold text-neutral-800 [overflow-wrap:anywhere]">{toLine || (isCallOpener ? "a phone call" : "no route on file")}</b></span>
          <span>Written by <b className="font-semibold text-neutral-800">{draft.authorVia === "claude" ? `Claude, for ${personName(draft.authorId)}` : personName(draft.authorId)}</b></span>
          <span>{stamp(draft.createdAt)}</span>
        </p>

        {editing ? <form onSubmit={(event) => { event.preventDefault(); save(); }} className="space-y-3 rounded-2xl border border-primary-300 bg-white p-4 ring-2 ring-primary-100">
          {isEmail && <Field label="Subject"><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} className={inputClass} /></Field>}
          <Field label="Message"><textarea value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); save(); } }} maxLength={5000} autoFocus rows={10} className={clsx(inputClass, "min-h-48 py-3 leading-7")} /></Field>
          <p className="text-xs text-neutral-500">{wordCount(body)} words. Saving sends it back for Claude to review again, and clears any approval.</p>
          <div className="flex flex-wrap gap-2"><button type="submit" disabled={busy === "save"} className={primaryClass}><ActionLabel busy={busy === "save"} idle="Save and send back to review" /></button><button type="button" onClick={() => setEditing(false)} className={secondaryClass}>Cancel</button></div>
        </form> : <DraftMessage draft={draft} />}

        <Notice tone="error" message={error} onDismiss={() => setError("")} />


        {draft.status === "sent" && <Callout tone="green" icon={CircleCheck} title="Sent">{draft.sentBy ? `${personName(draft.sentBy)} sent this` : "Sent"}{draft.sentAt ? ` on ${stamp(draft.sentAt)}` : ""} from their own {isEmail ? "mail app" : "phone"}. Dealflow only records it.</Callout>}
        {draft.status === "vetoed" && <Callout tone="red" icon={X} title="Vetoed">{draft.veto ? `${personName(draft.veto.by)}: ${draft.veto.reason}` : "A person vetoed this draft."}</Callout>}

        {writer && open && !editing && <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {mayApprove && <button type="button" onClick={approve} disabled={busy === "approve"} className={primaryClass}><ActionLabel busy={busy === "approve"} busyText="Approving…" idle={<><Check size={16} />Approve this message</>} /></button>}
            {openButton}
            {editor && draft.status === "ready" && !isCallOpener && <button type="button" disabled={!sendable || whatsappLocked} onClick={confirmSent} title={sendBlocked || undefined} aria-describedby={sendBlocked ? `send-blocked-${draft.id}` : undefined} className={secondaryClass}><Check size={16} />Mark sent</button>}
            {editor && draft.status === "needs_changes" && <button type="button" onClick={startEdit} className={primaryClass}><Edit size={16} />Edit</button>}
            {editor && draft.status !== "needs_changes" && <button type="button" onClick={startEdit} className={secondaryClass}><Edit size={16} />Edit<kbd className="ml-1 rounded border border-neutral-200 px-1 font-mono text-[10px] font-medium text-neutral-400 max-lg:hidden">e</kbd></button>}
            <button type="button" onClick={() => void copyText(fullText)} className={secondaryClass}><Copy size={16} />Copy text</button>
            <span className="ml-auto flex gap-2">
              <button type="button" onClick={() => { setConfirm(confirm === "veto" ? null : "veto"); setError(""); }} className={clsx(secondaryClass, "!text-danger-text")}><X size={16} />Veto</button>
              {mayDiscard && <button type="button" onClick={() => { setConfirm(confirm === "discard" ? null : "discard"); setError(""); }} aria-label="Discard" className={clsx(secondaryClass, "!px-3 !text-danger-text")}><Trash size={16} /><span className="max-sm:sr-only">Discard</span></button>}
            </span>
          </div>
          {editor && sendBlocked && !doNotContact && !whatsappLocked && <p id={`send-blocked-${draft.id}`} className="flex items-center gap-2 text-xs font-medium text-neutral-500"><ShieldCheck size={14} className="shrink-0 text-primary-600" aria-hidden="true" />Mark sent: {sendBlocked.charAt(0).toLowerCase() + sendBlocked.slice(1)}.</p>}
          {!editor && <p className="flex items-center gap-2 text-xs text-neutral-500"><Info size={14} className="shrink-0" aria-hidden="true" />Only the lead&apos;s owner or a venture head can {mayDiscard ? "edit or send" : "edit, send or discard"} this draft.</p>}

          {confirm === "sent" && <div role="alertdialog" aria-label="Confirm sent" className="vso-fade-enter rounded-2xl border border-primary-200 bg-primary-50 p-4">
            <p className="text-sm font-bold text-primary-900">Did you send it from your own {isEmail ? "mail app" : draft.channel === "whatsapp" ? "WhatsApp" : "account"}?</p>
            <p className="mt-1 text-xs leading-5 text-primary-800">Dealflow does not send anything by itself. This only records that you did, moves {lead.companyName} to Contacted and starts the follow-up clock.</p>
            <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={markSent} disabled={busy === "sent"} className={primaryClass}><ActionLabel busy={busy === "sent"} idle="Yes, I sent it" /></button><button type="button" onClick={() => setConfirm(null)} className={secondaryClass}>Not yet</button></div>
          </div>}
          {confirm === "veto" && <form onSubmit={(event) => { event.preventDefault(); veto(); }} className="vso-fade-enter rounded-2xl border border-danger-surface bg-danger-surface p-4">
            <Field label="Why veto it?"><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={2} autoFocus placeholder="For example: wrong person to write to, or the claim is not true." className={clsx(inputClass, "py-3")} /></Field>
            <div className="mt-3 flex flex-wrap gap-2"><button type="submit" disabled={busy === "veto"} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50"><ActionLabel busy={busy === "veto"} busyText="Vetoing…" idle="Veto this draft" /></button><button type="button" onClick={() => setConfirm(null)} className={secondaryClass}>Cancel</button></div>
          </form>}
          {confirm === "discard" && <div role="alertdialog" aria-label="Confirm discard" className="vso-fade-enter rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
            <p className="text-sm font-bold text-neutral-900">Discard this draft?</p>
            <p className="mt-1 text-xs leading-5 text-neutral-500">It is removed from the queue. Claude can write a new one.</p>
            <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={discard} disabled={busy === "discard"} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-50"><ActionLabel busy={busy === "discard"} busyText="Discarding…" idle="Discard" /></button><button type="button" onClick={() => setConfirm(null)} className={secondaryClass}>Keep it</button></div>
          </div>}
        </div>}
        {!editing && open && <div className="space-y-3">
          {doNotContact && <Callout tone="red" icon={UserX} title="On the do-not-contact list">{lead.companyName} asked not to be contacted, or matched the list. Nothing can be sent or opened for them, on any channel. Discard this draft.</Callout>}
          {whatsappLocked && !doNotContact && <Callout tone="amber" icon={Whatsapp} title="WhatsApp stays locked until they opt in">{lead.companyName} has not said yes to WhatsApp, so this cannot be sent or opened. They opt in when they message us, or say yes on a call or by email. Until then, start with a call, or an email that ends &ldquo;Prefer WhatsApp?&rdquo;.{editor && !doNotContact && <WorkspaceLink href={`/sales/live/calls?call=${encodeURIComponent(lead.id)}`} className="mt-2 inline-flex items-center gap-1.5 font-semibold underline underline-offset-2"><Phone size={14} />Call instead</WorkspaceLink>}</Callout>}
          {isCallOpener && <Callout tone="blue" icon={Phone} title="This is a script for a call, not a message">Claude shows it in call mode while you speak to them. There is nothing to send.{editor && !doNotContact && <WorkspaceLink href={`/sales/live/calls?call=${encodeURIComponent(lead.id)}`} className="mt-2 inline-flex items-center gap-1.5 font-semibold underline underline-offset-2"><Phone size={14} />Start the call</WorkspaceLink>}</Callout>}
          {approval.reason === "first_batch" && <Callout tone="blue" icon={ShieldCheck} title="A person reads the first messages of this play">{play?.name ? `${play.name} is` : "Its play is"} still in its first batch, so someone reads each message and approves it before it goes out. Claude&apos;s review passed; {mayApprove ? "this part is yours." : "a venture head approves it next."}</Callout>}
          {approval.reason === "every_message" && <Callout tone="blue" icon={ShieldCheck} title="A person reads every message first">{ventureName(draft.ventureId)} has a person approve each message before it goes out (its sales settings). Claude&apos;s review passed; {mayApprove ? "this part is yours." : "the lead's owner or a venture head approves it next."}</Callout>}
          {(draft.status === "in_review" || draft.status === "draft") && <Callout tone="blue" icon={Clock3} title={draft.status === "draft" ? "Not submitted for review yet" : "Waiting for Claude's review"}>{draft.status === "draft" ? "Edit it and save to send it for review." : "In Claude, say \"review the drafts\". A different session from the one that wrote it checks it against the message rules."}</Callout>}
          {draft.status === "needs_changes" && <Callout tone="amber" icon={CircleAlert} title="Claude asked for changes">{editor ? "Fix the points on the right, or ask Claude to fix them. Saving sends it back to review." : "The lead's owner or a venture head fixes the points on the right."}</Callout>}
        </div>}
        {!writer && open && <p className="flex items-center gap-2 text-xs text-neutral-500"><Info size={14} />You can read drafts. A contributor or venture head edits and sends them.</p>}
      </div>

      <aside className="min-w-0 space-y-5 xl:border-l xl:border-neutral-100 xl:pl-5">
        <div className="space-y-2">
          <span className={kickerClass}>Lead</span>
          <div className="space-y-2 rounded-2xl bg-neutral-50 p-3.5">
            <button type="button" onClick={() => openLead(lead.id)} className="group flex w-full items-start justify-between gap-2 text-left"><span className="min-w-0"><span className="block text-sm font-bold text-neutral-900 [overflow-wrap:anywhere] group-hover:underline">{lead.companyName}</span><span className="block text-xs text-neutral-500">{[lead.contactName, lead.city].filter(Boolean).join(" · ") || "No contact name yet"}</span></span><ArrowUpRight size={15} className="mt-0.5 shrink-0 text-neutral-400" aria-hidden="true" /></button>
            <div className="flex flex-wrap gap-1.5"><StageChip stage={lead.stage} /><VerdictChip verdict={lead.verdict} /></div>
            {lead.observedSignal && <p className="border-l-2 border-primary-300 pl-2.5 text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">&ldquo;{lead.observedSignal}&rdquo;</p>}
            {lead.verdict?.summary && <p className="text-xs leading-5 text-neutral-600">{lead.verdict.summary}</p>}
            {lead.whatsappOptIn && <p className="flex items-center gap-1.5 text-xs font-semibold text-success-text"><Whatsapp size={13} />WhatsApp OK: {OPT_IN_LABEL[lead.whatsappOptIn.how].toLowerCase()}, {stamp(lead.whatsappOptIn.at)}</p>}
            <p className="text-xs text-neutral-500">Owner <b className="font-semibold text-neutral-700">{personName(lead.ownerId)}</b></p>
          </div>
        </div>
        <ReviewCard draft={draft} />
        {draft.personApproval && <p className="flex items-start gap-2 text-xs leading-5 text-neutral-600"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-success-text" />Approved by {personName(draft.personApproval.by)}, {stamp(draft.personApproval.at)}</p>}
        {isCallOpener && phoneRoute && phoneLink && editor && !doNotContact && <a href={phoneLink} className={clsx(secondaryClass, "w-full")}><Phone size={16} />Call {phoneRoute.value}</a>}
      </aside>
    </div>
  </article>;
}

function DraftMessage({ draft }: { draft: ReviewDraft }) {
  const words = wordCount(draft.body);
  const text = <p className="whitespace-pre-wrap text-sm leading-7 text-neutral-800 [overflow-wrap:anywhere]">{draft.body}</p>;
  const foot = <p className="text-[11px] font-medium text-neutral-400">{words} words · {CHANNEL_LABEL[draft.channel]} · {PURPOSE_LABEL[draft.purpose]}</p>;
  if (draft.channel === "whatsapp") return <div className="space-y-2 rounded-2xl bg-neutral-50 p-3 sm:p-4"><div className="ml-auto w-fit max-w-[92%] rounded-2xl rounded-br-md border border-primary-200 bg-primary-100 px-4 py-3 sm:max-w-[85%]">{text}</div><div className="text-right">{foot}</div></div>;
  if (draft.channel === "call_opener") return <div className="space-y-2 rounded-2xl border border-primary-200 bg-primary-50 p-4"><span className="flex items-center gap-2 text-xs font-bold text-primary-800"><Sparkles size={14} />Say this on the call</span>{text}{foot}</div>;
  return <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
    {draft.channel === "email" && <div className="border-b border-neutral-100 px-4 py-3"><span className={kickerClass}>Subject</span><p className="mt-0.5 text-sm font-bold text-neutral-900 [overflow-wrap:anywhere]">{draft.subject || "(no subject)"}</p></div>}
    <div className="px-4 py-4">{text}</div>
    <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-2">{foot}</div>
  </div>;
}

function ReviewCard({ draft }: { draft: ReviewDraft }) {
  const { personName } = useSalesShell();
  const review = draft.review;
  return <div className="space-y-2">
    <span className={kickerClass}>Claude&apos;s review</span>
    {!review ? <p className="rounded-2xl bg-neutral-50 p-3.5 text-xs leading-5 text-neutral-500">Not reviewed yet. In Claude, say &ldquo;review the drafts&rdquo;. A different session from the one that wrote it does the check.</p>
      : <div className="space-y-2.5 rounded-2xl bg-neutral-50 p-3.5">
        <div className="flex items-center gap-2"><span className={clsx("grid h-6 w-6 place-items-center rounded-lg", review.result === "pass" ? "bg-success-surface text-success-text" : "bg-warning-surface text-warning-text")}>{review.result === "pass" ? <Check size={14} /> : <CircleAlert size={14} />}</span><b className="text-sm text-neutral-900">{review.result === "pass" ? "Passed" : "Needs changes"}</b></div>
        {review.issues.length > 0 && <ul className="space-y-1.5">{review.issues.map((issue, index) => <li key={`${index}-${issue}`} className="flex items-start gap-2 text-xs leading-5 text-neutral-700"><CircleAlert size={13} className="mt-1 shrink-0 text-warning-text" aria-hidden="true" /><span className="[overflow-wrap:anywhere]">{issue}</span></li>)}</ul>}
        {review.notes && <p className="text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">{review.notes}</p>}
        {review.result === "pass" && review.issues.length === 0 && !review.notes && <p className="text-xs leading-5 text-neutral-500">No issues found against the message rules.</p>}
        <p className="text-[11px] leading-4 text-neutral-400">{review.via === "claude" ? `Claude, for ${personName(review.by)}` : personName(review.by)} · {stamp(review.at)}{draft.authorSessionId && review.sessionId ? ` · written in session ${shortSession(draft.authorSessionId)}, reviewed in session ${shortSession(review.sessionId)}` : ""}</p>
      </div>}
  </div>;
}

function Callout({ tone, icon: CalloutIcon, title, children }: { tone: "amber" | "blue" | "green" | "red"; icon: Icon; title: string; children: React.ReactNode }) {
  const tones = { amber: "bg-warning-surface text-warning-text", blue: "bg-primary-50 text-primary-800", green: "bg-success-surface text-success-text", red: "bg-danger-surface text-danger-text" };
  return <div role="note" className={clsx("flex items-start gap-3 rounded-2xl p-3.5", tones[tone])}><CalloutIcon size={17} className="mt-0.5 shrink-0" aria-hidden="true" /><div className="min-w-0 text-xs leading-5"><p className="text-[13px] font-bold">{title}</p><div className="mt-0.5 opacity-90">{children}</div></div></div>;
}
