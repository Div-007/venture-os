"use client";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { ContactRoute, Lead } from "@venture-studio/contracts";
import { Check, Edit, LinkIcon, Mail, MessageCircle, Users, type Icon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { WorkspaceLink } from "@/components/shell/workspace-link";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Badge, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { deleteLead, updateLead } from "@/lib/sales-api";
import type { SalesMember } from "@/components/sales/overview-context";
import { dealFacts } from "@/components/sales/lead-deal";
import { LeadOwnership } from "@/components/sales/lead-manage";
import { offerChip, offerHref, openOffers, useVentureOffers } from "@/components/sales/offer-model";
import { useSalesShell } from "@/components/sales/sales-context";
import { hostOf, isDialable, isPlainEmail, Lock, mailHref, Phone, phoneOf, safeUrl, telHref, emailOf } from "@/components/sales/sales-ui";

const sectionLabel = "text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400";
const dangerButton = "inline-flex min-h-10 items-center justify-center rounded-xl bg-danger px-4 text-sm font-semibold text-white transition-[transform,opacity] duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger active:scale-[0.97] disabled:opacity-50";
const ROUTE_ICON: Record<ContactRoute["kind"], Icon> = { email: Mail, phone: Phone, whatsapp: MessageCircle, linkedin: Users, website_form: LinkIcon, other: LinkIcon };
const ROUTE_NAME: Record<ContactRoute["kind"], string> = { email: "Email", phone: "Phone", whatsapp: "WhatsApp", linkedin: "LinkedIn", website_form: "Website form", other: "Other" };

type Patch = Parameters<typeof updateLead>[1];
type Built = { patch: Patch } | { error: string };
type Spec = { key: string; label: string; get: (lead: Lead) => string; kind?: "text" | "tel" | "email" | "area"; placeholder?: string; full?: boolean; max?: number; required?: boolean };

function Group({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return <section aria-label={title} className="border-t border-neutral-100 pt-5 first:border-t-0 first:pt-0">
    <div className="mb-3 flex min-h-8 items-center justify-between gap-3"><h3 className={sectionLabel}>{title}</h3>{aside}</div>
    {children}
  </section>;
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-label={label} className="-mr-1 inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"><Edit size={13} />Edit</button>;
}

function RouteRow({ route, blocked }: { route: ContactRoute; blocked: boolean }) {
  const RouteIcon = ROUTE_ICON[route.kind];
  const href = blocked ? undefined : route.kind === "phone" ? telHref(route.value) : route.kind === "email" ? mailHref(route.value) : route.kind === "whatsapp" ? undefined : safeUrl(route.value);
  const source = safeUrl(route.sourceUrl);
  return <li className="flex items-start gap-2.5 text-sm">
    <span aria-hidden="true" className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-neutral-100 text-neutral-500"><RouteIcon size={14} /></span>
    <span className="min-w-0 flex-1">
      {href ? <a href={href} {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})} className="inline-flex min-h-8 items-center font-semibold text-neutral-800 underline-offset-2 [overflow-wrap:anywhere] hover:text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">{route.value}</a> : <span className="font-semibold text-neutral-800 [overflow-wrap:anywhere]">{route.value}</span>}
      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] font-medium text-neutral-400"><span>{route.label || ROUTE_NAME[route.kind]}</span>{source && <a href={source} target="_blank" rel="noopener noreferrer" className="text-primary-700 hover:underline">from {hostOf(source)}</a>}{!route.publishedByCompany && <Badge tone="amber">Not published by the company</Badge>}</span>
    </span>
  </li>;
}

/**
 * A group of fields that reads as plain facts and only turns into inputs when a person chooses Edit. Save sends just what changed;
 * Cancel puts everything back. `build` turns the changed fields into an update (the default sends each as it is).
 */
function FieldsGroup({ id, title, lead, specs, canEdit, build, view, empty = "Nothing recorded yet.", onSaved, onDirty }: {
  id: string; title: string; lead: Lead; specs: readonly Spec[]; canEdit: boolean; build?: (changed: Record<string, string>, lead: Lead) => Built;
  view?: (lead: Lead) => React.ReactNode; empty?: string; onSaved: () => void; onDirty: (key: string, dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const saved = useMemo(() => Object.fromEntries(specs.map((spec) => [spec.key, spec.get(lead)])), [specs, lead]);
  const [values, setValues] = useState<Record<string, string>>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = Object.fromEntries(specs.filter((spec) => (values[spec.key] ?? "").trim() !== (saved[spec.key] ?? "").trim()).map((spec) => [spec.key, (values[spec.key] ?? "").trim()]));
  const dirty = editing && Object.keys(changed).length > 0;
  useEffect(() => { onDirty(id, dirty); return () => onDirty(id, false); }, [id, dirty, onDirty]);

  function open() { setValues(saved); setError(""); setEditing(true); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const missing = specs.find((spec) => spec.required && !(values[spec.key] ?? "").trim());
    if (missing) { setError(`${missing.label} cannot be empty.`); return; }
    const built: Built = build ? build(changed, lead) : { patch: changed as Patch };
    if ("error" in built) { setError(built.error); return; }
    setBusy(true); setError("");
    try { await updateLead(lead.id, built.patch); toast({ title: `${title} saved`, body: lead.companyName }); setEditing(false); onSaved(); }
    catch (cause) { setError(describeError(cause, "Could not save the change.")); }
    finally { setBusy(false); }
  }

  const facts = specs.filter((spec) => saved[spec.key]);
  const body = view ? view(lead) : facts.length
    ? <dl className="grid grid-cols-1 gap-x-5 gap-y-2.5 text-sm sm:grid-cols-2">{facts.map((spec) => <div key={spec.key} className={clsx("min-w-0", (spec.full || spec.kind === "area") && "sm:col-span-2")}><dt className="text-xs font-semibold text-neutral-500">{spec.label}</dt><dd className="font-medium leading-6 text-neutral-800 [overflow-wrap:anywhere]">{saved[spec.key]}</dd></div>)}</dl>
    : <p className="text-sm text-neutral-500">{empty}</p>;

  return <Group title={title} aside={canEdit && !editing ? <EditButton label={`Edit ${title.toLowerCase()}`} onClick={open} /> : undefined}>
    {!editing ? body : <form onSubmit={save} className="vso-fade-enter grid grid-cols-1 gap-3 sm:grid-cols-2">
      {specs.map((spec) => <div key={spec.key} className={clsx((spec.full || spec.kind === "area") && "sm:col-span-2")}>
        <Field label={spec.label}>
          {spec.kind === "area"
            ? <textarea rows={3} maxLength={spec.max ?? 2000} className={`${inputClass} py-2.5`} value={values[spec.key] ?? ""} onChange={(event) => setValues({ ...values, [spec.key]: event.target.value })} placeholder={spec.placeholder} />
            : <input type={spec.kind === "tel" ? "tel" : spec.kind === "email" ? "email" : "text"} maxLength={spec.max ?? 320} className={inputClass} value={values[spec.key] ?? ""} onChange={(event) => setValues({ ...values, [spec.key]: event.target.value })} placeholder={spec.placeholder} />}
        </Field>
      </div>)}
      <div className="sm:col-span-2"><Notice tone="error" message={error} onDismiss={() => setError("")} /></div>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button disabled={!dirty || busy} className={clsx(primaryClass, "flex-1 sm:flex-none")}><ActionLabel busy={busy} idle={<><Check size={15} />Save</>} /></button>
        <button type="button" onClick={() => { setEditing(false); setError(""); }} className={clsx(secondaryClass, "flex-1 sm:flex-none")}>Cancel</button>
      </div>
    </form>}
  </Group>;
}

const COMPANY: readonly Spec[] = [
  { key: "companyName", label: "Company", get: (lead) => lead.companyName, required: true, full: true, max: 200 },
  { key: "website", label: "Website", get: (lead) => lead.website ?? "", placeholder: "example.com", max: 500 },
  { key: "category", label: "Industry", get: (lead) => lead.category ?? "", max: 200 },
  { key: "city", label: "City", get: (lead) => lead.city ?? "", max: 120 },
  { key: "region", label: "State", get: (lead) => lead.region ?? "", max: 120 },
  { key: "country", label: "Country", get: (lead) => lead.country ?? "", max: 80 },
];
function companyPatch(changed: Record<string, string>): Built {
  if (changed.website && /^[a-z][a-z0-9+.-]*:/i.test(changed.website) && !/^https?:\/\//i.test(changed.website)) return { error: "The website must be a web address, like example.com." };
  return { patch: changed as Patch };
}

const CONTACT: readonly Spec[] = [
  { key: "contactName", label: "Contact person", get: (lead) => lead.contactName, full: true, max: 200 },
  { key: "phone", label: "Phone", get: (lead) => phoneOf(lead) ?? "", kind: "tel", placeholder: "Published business number", max: 40 },
  { key: "email", label: "Email", get: (lead) => emailOf(lead) ?? "", kind: "email", placeholder: "Published business email", max: 320 },
];
/** Phone and email edit the first route of their kind; every other route (WhatsApp, LinkedIn, a form) stays as it is. */
function contactPatch(changed: Record<string, string>, lead: Lead): Built {
  const patch: Patch = {};
  if ("contactName" in changed) patch.contactName = changed.contactName;
  if ("phone" in changed || "email" in changed) {
    const routes = [...lead.contactRoutes];
    const swap = (kind: "phone" | "email", value: string): string | undefined => {
      if (value && !(kind === "phone" ? isDialable(value) : isPlainEmail(value))) return kind === "phone" ? "The phone number needs digits only (a + and spaces are fine)." : "The email must be one plain address, like name@company.in.";
      const index = routes.findIndex((route) => route.kind === kind && (kind === "phone" ? isDialable(route.value) : isPlainEmail(route.value)));
      if (!value) { if (index >= 0) routes.splice(index, 1); }
      else if (index >= 0) routes[index] = { ...routes[index]!, value };
      else routes.push({ kind, value, publishedByCompany: true });
      return undefined;
    };
    for (const kind of ["phone", "email"] as const) {
      if (kind in changed) { const problem = swap(kind, changed[kind]!); if (problem) return { error: problem }; }
    }
    patch.contactRoutes = routes;
  }
  return { patch };
}

const ABOUT: readonly Spec[] = [
  { key: "source", label: "Where it came from", get: (lead) => lead.source, full: true, placeholder: "Link or note", max: 500 },
  { key: "tags", label: "Tags", get: (lead) => lead.tags.join(", "), full: true, placeholder: "Separate with commas", max: 800 },
  { key: "observedSignal", label: "What we saw", get: (lead) => lead.observedSignal, kind: "area", placeholder: "The line or fact that made this company worth a look." },
  { key: "fitReason", label: "Why they might fit", get: (lead) => lead.fitReason, kind: "area" },
];
function aboutPatch(changed: Record<string, string>): Built {
  const { tags, ...rest } = changed;
  const patch: Patch = { ...rest };
  if (tags !== undefined) {
    const list = [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))];
    if (list.length > 20) return { error: "Use up to 20 tags." };
    if (list.some((tag) => tag.length > 40)) return { error: "Each tag can be up to 40 characters." };
    patch.tags = list;
  }
  return { patch };
}
function aboutView(lead: Lead) {
  const source = safeUrl(lead.source);
  const any = lead.source || lead.tags.length || lead.observedSignal || lead.fitReason;
  if (!any) return <p className="text-sm text-neutral-500">Nothing recorded yet.</p>;
  return <dl className="grid grid-cols-1 gap-3 text-sm leading-6">
    {lead.observedSignal && <div><dt className="text-xs font-semibold text-neutral-500">What we saw</dt><dd className="text-neutral-700">{lead.observedSignal}</dd></div>}
    {lead.fitReason && <div><dt className="text-xs font-semibold text-neutral-500">Why they might fit</dt><dd className="text-neutral-700">{lead.fitReason}</dd></div>}
    {lead.source && <div><dt className="text-xs font-semibold text-neutral-500">Where it came from</dt><dd className="text-neutral-700 [overflow-wrap:anywhere]">{source ? <a href={source} target="_blank" rel="noopener noreferrer" className="text-primary-700 hover:underline">{hostOf(source)}</a> : lead.source}</dd></div>}
    {lead.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{lead.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>}
  </dl>;
}

function contactView(lead: Lead) {
  const blocked = lead.doNotContact;
  if (!lead.contactName && !lead.contactRoutes.length) return <p className="text-sm text-neutral-500">No contact person or route yet. Claude finds routes while researching.</p>;
  return <div className="grid gap-3">
    {blocked && <p className="flex items-start gap-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold leading-5 text-danger-text"><Lock size={16} className="mt-0.5 shrink-0" />On the do-not-contact list. Calling, email and WhatsApp are switched off.</p>}
    {lead.contactName && <p className="text-sm text-neutral-500">Contact person: <strong className="font-semibold text-neutral-800">{lead.contactName}</strong></p>}
    {lead.contactRoutes.length > 0 && <ul className="grid grid-cols-1 gap-2.5">{lead.contactRoutes.map((route) => <RouteRow key={`${route.kind}-${route.value}`} route={route} blocked={blocked} />)}</ul>}
  </div>;
}

function DealGroup({ lead, canEdit, editing, onEdit }: { lead: Lead; canEdit: boolean; editing: boolean; onEdit: () => void }) {
  const facts = dealFacts(lead);
  return <Group title="Deal" aside={canEdit && !editing ? <EditButton label="Edit the deal" onClick={onEdit} /> : undefined}>
    {editing ? <p className="text-sm text-neutral-500">Editing in the Deal tile above.</p> : <dl className="grid grid-cols-1 gap-x-5 gap-y-2.5 text-sm sm:grid-cols-2">
      <div><dt className="text-xs font-semibold text-neutral-500">Value</dt><dd className="font-medium text-neutral-800" title={facts.valueFull}>{facts.value ? facts.valueFull : "No value yet"}</dd></div>
      <div><dt className="text-xs font-semibold text-neutral-500">Expected to close</dt><dd className="font-medium text-neutral-800">{facts.closes || "No date"}</dd></div>
      <div><dt className="text-xs font-semibold text-neutral-500">Chance</dt><dd className="font-medium text-neutral-800">{facts.chanceNote}</dd></div>
      {facts.lostWhy && <div><dt className="text-xs font-semibold text-neutral-500">Why it was lost</dt><dd className="font-medium text-neutral-800">{facts.lostWhy}</dd></div>}
    </dl>}
  </Group>;
}

/**
 * The offer the lead is pursued for: Claude judges it, and writes to it, with that offer's approved packet. An editor moves it to another
 * of the venture's offers that is not archived (an offer cannot be cleared, only changed).
 */
function OfferGroup({ lead, canEdit, onSaved, onDirty }: { lead: Lead; canEdit: boolean; onSaved: () => void; onDirty: (key: string, dirty: boolean) => void }) {
  const { refreshKey } = useSalesShell();
  const offers = useVentureOffers(lead.ventureId, refreshKey);
  const current = lead.offerId ? offers?.find((offer) => offer.id === lead.offerId) : undefined;
  const choices = openOffers(offers ?? []);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState(lead.offerId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = editing && pick !== (lead.offerId ?? "");
  useEffect(() => { onDirty("offer", dirty); return () => onDirty("offer", false); }, [dirty, onDirty]);
  const picked = choices.find((offer) => offer.id === pick);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!picked) return;
    setBusy(true); setError("");
    try { await updateLead(lead.id, { offerId: picked.id }); toast({ title: "Offer changed", body: `${lead.companyName}: ${picked.name}` }); setEditing(false); onSaved(); }
    catch (cause) { setError(describeError(cause, "Could not change the offer.")); }
    finally { setBusy(false); }
  }

  const chip = current ? offerChip(current) : null;
  const canChange = canEdit && offers !== null && (choices.length > 1 || (choices.length === 1 && choices[0]!.id !== lead.offerId));
  return <Group title="Offer" aside={canChange && !editing ? <EditButton label="Change the offer" onClick={() => { setPick(lead.offerId ?? ""); setError(""); setEditing(true); }} /> : undefined}>
    {!editing
      ? offers === null ? <span className="vso-skeleton block h-4 w-40" />
        : current ? <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm">
          <span className="font-semibold text-neutral-800 [overflow-wrap:anywhere]">{current.name}</span>
          {chip && chip.label !== "Active" && <Badge tone={chip.tone}>{chip.label}</Badge>}
          <WorkspaceLink href={offerHref(lead.ventureId, current.id)} className="inline-flex min-h-8 items-center text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">Open the offer</WorkspaceLink>
        </div>
          : <p className="text-sm leading-6 text-neutral-500">{lead.offerId ? "Its offer could not be found." : choices.length ? "No offer yet. Pick the one this lead is pursued for: Claude judges it against that offer's packet." : "No offer yet. The venture has no offers to choose from."}</p>
      : <form onSubmit={save} className="vso-fade-enter grid grid-cols-1 gap-3">
        <Field label="Pursued for"><Select aria-label="Offer" className={inputClass} value={pick} onChange={(event) => setPick(event.target.value)}>{!lead.offerId && <option value="">Choose an offer</option>}{choices.map((offer) => { const state = offerChip(offer); return <option key={offer.id} value={offer.id}>{offer.name}{state.label === "Active" ? "" : ` (${state.label.toLowerCase()})`}</option>; })}</Select></Field>
        {lead.verdict && dirty && <p className="rounded-xl bg-warning-surface p-3 text-xs leading-5 text-warning-text">Claude&apos;s verdict was made against {current ? current.name : "the old offer"}. Ask Claude to judge this lead again for {picked?.name ?? "the new one"}.</p>}
        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        <div className="flex flex-wrap gap-2">
          <button disabled={!dirty || busy || !picked} className={clsx(primaryClass, "flex-1 sm:flex-none")}><ActionLabel busy={busy} idle={<><Check size={15} />Save</>} /></button>
          <button type="button" onClick={() => { setEditing(false); setError(""); }} className={clsx(secondaryClass, "flex-1 sm:flex-none")}>Cancel</button>
        </div>
      </form>}
  </Group>;
}

function DangerZone({ lead, onDeleted }: { lead: Lead; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true); setError("");
    try { await deleteLead(lead.id); toast({ title: "Lead deleted", body: lead.companyName }); onDeleted(); }
    catch (cause) { setError(describeError(cause, "Could not delete this lead.")); setBusy(false); }
  }
  return <Group title="Danger zone">
    {!confirm
      ? <button type="button" onClick={() => setConfirm(true)} className={clsx(secondaryClass, "!text-danger-text")}>Delete this lead</button>
      : <div className="vso-fade-enter grid gap-3 rounded-xl bg-danger-surface p-3"><p className="text-sm font-semibold leading-5 text-danger-text">Delete {lead.companyName}? It disappears from every list. Its history is kept.</p><Notice tone="error" message={error} onDismiss={() => setError("")} /><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void remove()} className={dangerButton}>{busy ? "Deleting…" : "Delete lead"}</button><button type="button" onClick={() => { setConfirm(false); setError(""); }} className={secondaryClass}>Keep it</button></div></div>}
  </Group>;
}

/** Every field of the lead, in groups, as plain facts until Edit is chosen. */
export function LeadDetails({ lead, canEdit, canReassign, canDelete, members, personName, editingDeal, onEditDeal, onSaved, onDeleted, onDirty }: {
  lead: Lead; canEdit: boolean; canReassign: boolean; canDelete: boolean; members: SalesMember[]; personName: (id: string) => string; editingDeal: boolean; onEditDeal: () => void;
  onSaved: () => void; onDeleted: () => void; onDirty: (key: string, dirty: boolean) => void;
}) {
  return <div className="grid grid-cols-1 gap-5">
    <FieldsGroup id="company" title="Company" lead={lead} specs={COMPANY} canEdit={canEdit} build={companyPatch} onSaved={onSaved} onDirty={onDirty} />
    <FieldsGroup id="contact" title="Contact" lead={lead} specs={CONTACT} canEdit={canEdit} build={contactPatch} view={contactView} onSaved={onSaved} onDirty={onDirty} />
    <DealGroup lead={lead} canEdit={canEdit} editing={editingDeal} onEdit={onEditDeal} />
    <OfferGroup lead={lead} canEdit={canEdit} onSaved={onSaved} onDirty={onDirty} />
    <Group title="Ownership"><LeadOwnership lead={lead} canEdit={canEdit} canReassign={canReassign} members={members} personName={personName} onSaved={onSaved} onDirty={onDirty} /></Group>
    <FieldsGroup id="about" title="About" lead={lead} specs={ABOUT} canEdit={canEdit} build={aboutPatch} view={aboutView} onSaved={onSaved} onDirty={onDirty} />
    {canDelete && <DangerZone lead={lead} onDeleted={onDeleted} />}
  </div>;
}
