"use client";
import { useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { offerProposalInputSchema, type Offer, type OfferGate, type OfferPacket, type OfferVersion } from "@venture-studio/contracts";
import { ChevronDown, Plus, Sparkles, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, Badge, DetailDrawer, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { proposeOffer, updateOfferDraft } from "@/lib/sales-api";
import { ChipsField } from "./chips-field";
import { EMPTY_PACKET, SECTIONS, sectionSummary, type SectionKey } from "./offer-model";
import { useSalesShell } from "./sales-context";

/** A new offer (empty), a change to an offer (prefilled with the version it starts from, if any), or a pending proposal to edit. */
export type OfferEditorTarget = { mode: "new" } | { mode: "propose"; offer: Offer; from?: OfferVersion | undefined } | { mode: "edit"; offer: Offer; version: OfferVersion };

// ---- The form: the packet flattened into one level, with stable keys for rows that can be added, removed and moved. ----

let rowSeq = 0;
const newKey = () => `row-${++rowSeq}`;
type Line = { key: string; text: string };
type GateRow = OfferGate & { key: string };
type SignalRow = { key: string; phrase: string; meaning: string };
type Form = {
  name: string; change: string; summary: string;
  description: string; industries: string[]; customerTypes: string[]; places: string[]; companySizes: Line[]; buyerRoles: Line[];
  gates: GateRow[]; exclusions: Line[];
  lookFor: SignalRow[]; searchWords: string[]; negatives: string[];
  valueProposition: string; pitchAngles: Line[]; proofWords: string; approvedClaims: Line[]; claimsToAvoid: Line[];
  messages: string; price: string; scoring: string; notes: string;
};
type LineKey = "companySizes" | "buyerRoles" | "exclusions" | "pitchAngles" | "approvedClaims" | "claimsToAvoid";

const lines = (items: readonly string[]): Line[] => items.map((text) => ({ key: newKey(), text }));
function toForm(name: string, packet: OfferPacket, change: string): Form {
  return {
    name, change, summary: packet.summary,
    description: packet.whoFor.description, industries: [...packet.whoFor.industries], customerTypes: [...packet.whoFor.customerTypes], places: [...packet.whoFor.places], companySizes: lines(packet.whoFor.companySizes), buyerRoles: lines(packet.whoFor.buyerRoles),
    gates: packet.gates.map((gate) => ({ ...gate, key: newKey() })), exclusions: lines(packet.exclusions),
    lookFor: packet.signals.lookFor.map((entry) => ({ ...entry, key: newKey() })), searchWords: [...packet.signals.searchWords], negatives: [...packet.signals.negatives],
    valueProposition: packet.say.valueProposition, pitchAngles: lines(packet.say.pitchAngles), proofWords: packet.say.proofWords, approvedClaims: lines(packet.say.approvedClaims), claimsToAvoid: lines(packet.say.claimsToAvoid),
    messages: packet.messages, price: packet.price, scoring: packet.scoring, notes: packet.notes,
  };
}

/** Rows a person left blank are dropped; `rows` maps each kept item back to the row it came from, so errors land on the right row. */
function toPacket(form: Form): { packet: OfferPacket; rows: Record<string, number[]> } {
  const rows: Record<string, number[]> = {};
  const keep = <T,>(name: string, items: readonly T[], blank: (item: T) => boolean): T[] => {
    const kept: T[] = []; const map: number[] = [];
    items.forEach((item, index) => { if (!blank(item)) { kept.push(item); map.push(index); } });
    rows[name] = map;
    return kept;
  };
  const text = (name: LineKey) => keep(name, form[name], (line) => !line.text.trim()).map((line) => line.text.trim());
  return {
    rows,
    packet: {
      summary: form.summary,
      whoFor: { description: form.description, industries: form.industries, customerTypes: form.customerTypes, places: form.places, companySizes: text("companySizes"), buyerRoles: text("buyerRoles") },
      gates: keep("gates", form.gates, (gate) => !gate.code.trim() && !gate.rule.trim() && !gate.note.trim()).map(({ code, rule, ifFails, note }) => ({ code: code.trim(), rule, ifFails, note })),
      signals: { lookFor: keep("lookFor", form.lookFor, (entry) => !entry.phrase.trim() && !entry.meaning.trim()).map(({ phrase, meaning }) => ({ phrase, meaning })), searchWords: form.searchWords, negatives: form.negatives },
      exclusions: text("exclusions"),
      say: { valueProposition: form.valueProposition, pitchAngles: text("pitchAngles"), proofWords: form.proofWords, approvedClaims: text("approvedClaims"), claimsToAvoid: text("claimsToAvoid") },
      messages: form.messages, price: form.price, scoring: form.scoring, notes: form.notes,
    },
  };
}
/** What the form would save, as text: `withChange` adds the "what changed" line (dirty checks), without it only name and packet count. */
const fingerprint = (form: Form, withChange = true) => JSON.stringify([form.name.trim(), withChange ? form.change.trim() : "", toPacket(form).packet]);

// ---- Errors: the contract schema decides; its issues become short sentences on the field they belong to. ----

type Errors = Record<string, string>;
type Issue = { code: string; path: PropertyKey[]; message: string; origin?: string; minimum?: number | bigint; maximum?: number | bigint };
const SECTION_OF: Record<string, SectionKey | "basics"> = {
  name: "basics", summary: "basics", change: "basics",
  description: "whoFor", industries: "whoFor", customerTypes: "whoFor", places: "whoFor", companySizes: "whoFor", buyerRoles: "whoFor",
  gates: "gates", exclusions: "gates", lookFor: "signals", searchWords: "signals", negatives: "signals",
  valueProposition: "say", pitchAngles: "say", proofWords: "say", approvedClaims: "say", claimsToAvoid: "say",
  messages: "messages", price: "price", scoring: "scoring", notes: "notes",
};
const REQUIRED: Record<string, string> = { name: "Give the offer a name.", summary: "Say in one line what is sold, and to whom.", code: "A short code, such as G1.", rule: "Write what must be true.", phrase: "The words to look for.", meaning: "What finding it means for this offer." };
const CHIP_FIELDS = new Set(["industries", "customerTypes", "places", "searchWords", "negatives"]);

/** "packet.whoFor.companySizes.2" → the form's "companySizes.<row>"; chip lists keep their errors on the whole field. */
function errorKey(path: PropertyKey[], rows: Record<string, number[]>): string {
  const parts = path.map(String);
  if (parts[0] !== "packet") return parts[0] ?? "";
  const rest = parts.slice(1);
  const inner = rest[0] === "whoFor" || rest[0] === "say" || rest[0] === "signals" ? rest.slice(1) : rest;
  const [field = "", index, leaf] = inner;
  if (CHIP_FIELDS.has(field) || index === undefined) return field;
  const row = rows[field]?.[Number(index)] ?? Number(index);
  return [field, row, leaf].filter((part) => part !== undefined).join(".");
}
function friendly(issue: Issue): string {
  const leaf = String(issue.path.at(-1) ?? "");
  if (issue.code === "too_small") return issue.origin === "array" ? `Add at least ${issue.minimum}.` : REQUIRED[leaf] ?? "Write something here, or remove it.";
  if (issue.code === "too_big") return issue.origin === "array" ? `Up to ${issue.maximum} here.` : `Keep it under ${Number(issue.maximum).toLocaleString("en-IN")} characters.`;
  if (issue.code === "invalid_format" && leaf === "code") return "A short code such as G1: letters, digits and dashes only.";
  return issue.message;
}

// ---- Small form pieces ----

const fieldLabel = "mb-1.5 block text-xs font-semibold text-neutral-600";
const hintClass = "font-normal text-neutral-400";
const iconButton = "grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-400 transition-[background-color,color] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:pointer-events-none disabled:opacity-30";
const addButton = "inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600";

function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  return message ? <p id={id} className="mt-1 text-xs font-semibold text-danger-text">{message}</p> : null;
}
const invalid = (message: string | undefined, id: string) => message ? { "aria-invalid": true as const, "aria-describedby": id } : {};

/** A labelled text box (one line, or a text area with a character count when it can hold a lot). */
function TextField({ label, hint, value, onChange, max, rows = 0, placeholder, error, mono = false }: {
  label: string; hint?: string; value: string; onChange: (value: string) => void; max: number; rows?: number; placeholder?: string; error?: string | undefined; mono?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return <div>
    <label htmlFor={id} className={fieldLabel}>{label}{hint && <span className={hintClass}> · {hint}</span>}</label>
    {rows
      ? <textarea id={id} rows={rows} maxLength={max} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} {...invalid(error, errorId)} style={{ minHeight: `${rows * 1.5 + 1.35}rem` }} className={clsx(inputClass, "max-h-[60dvh] py-2.5 leading-6 [field-sizing:content]", mono && "font-mono text-[13px]", error && "!border-danger")} />
      : <input id={id} maxLength={max} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} {...invalid(error, errorId)} className={clsx(inputClass, error && "!border-danger")} />}
    <div className="flex items-start justify-between gap-3"><FieldError id={errorId} message={error} />{rows > 0 && max >= 2_000 && <p className="ml-auto mt-1 text-[11px] tabular-nums text-neutral-400">{value.length.toLocaleString("en-IN")} / {max.toLocaleString("en-IN")}</p>}</div>
  </div>;
}

/** Sentences, one per row: add a row, write it, remove it. Blank rows are dropped on save. */
function LineList({ label, hint, items, onChange, max, maxLength, placeholder, addLabel, errors, name }: {
  label: string; hint?: string; items: Line[]; onChange: (items: Line[]) => void; max: number; maxLength: number; placeholder: string; addLabel: string; errors: Errors; name: LineKey;
}) {
  const id = useId();
  const [focusKey, setFocusKey] = useState("");
  const add = () => { const key = newKey(); setFocusKey(key); onChange([...items, { key, text: "" }]); };
  return <fieldset className="min-w-0">
    <legend className={fieldLabel}>{label}{hint && <span className={hintClass}> · {hint}</span>}</legend>
    {items.length > 0 && <ul className="space-y-2">{items.map((line, index) => {
      const error = errors[`${name}.${index}`];
      const errorId = `${id}-${line.key}-error`;
      return <li key={line.key}>
        <div className="flex items-start gap-1.5">
          <textarea rows={1} autoFocus={line.key === focusKey} aria-label={`${label}, row ${index + 1}`} maxLength={maxLength} value={line.text} placeholder={placeholder} {...invalid(error, errorId)}
            onChange={(event) => onChange(items.map((item) => item.key === line.key ? { ...item, text: event.target.value } : item))}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (items.length < max) add(); } }}
            className={clsx(inputClass, "resize-none py-2.5 leading-6 [field-sizing:content]", error && "!border-danger")} />
          <button type="button" aria-label={`Remove ${label.toLowerCase()}, row ${index + 1}`} onClick={() => onChange(items.filter((item) => item.key !== line.key))} className={clsx(iconButton, "mt-1")}><X size={15} /></button>
        </div>
        <FieldError id={errorId} message={error} />
      </li>;
    })}</ul>}
    {items.length < max ? <button type="button" onClick={add} className={clsx(addButton, items.length > 0 && "mt-1.5")}><Plus size={13} aria-hidden="true" />{addLabel}</button> : <p className="mt-1.5 text-[11px] text-neutral-400">Up to {max}.</p>}
    <FieldError id={`${id}-error`} message={errors[name]} />
  </fieldset>;
}

/** The gates: code, rule, what happens when it fails, and a note. Rows can be added, removed and moved up or down. */
function GatesEditor({ gates, onChange, errors }: { gates: GateRow[]; onChange: (gates: GateRow[]) => void; errors: Errors }) {
  const id = useId();
  const [focusKey, setFocusKey] = useState("");
  const update = (key: string, change: Partial<OfferGate>) => onChange(gates.map((gate) => gate.key === key ? { ...gate, ...change } : gate));
  const move = (index: number, by: -1 | 1) => { const next = [...gates]; const [gate] = next.splice(index, 1); next.splice(index + by, 0, gate!); onChange(next); };
  const add = () => { const key = newKey(); setFocusKey(key); onChange([...gates, { key, code: `G${gates.length + 1}`, rule: "", ifFails: "reject", note: "" }]); };
  return <fieldset className="min-w-0">
    <legend className={fieldLabel}>Gates <span className={hintClass}>· every gate must pass; up to 20</span></legend>
    {gates.length === 0 && <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-500">No gates yet. A gate is one thing that must be true of a lead, such as &ldquo;sells through dealers&rdquo;. When it fails, the lead is rejected or held with a question.</p>}
    <ol className="space-y-2.5">{gates.map((gate, index) => {
      const err = (field: string) => errors[`gates.${index}.${field}`];
      const ids = { code: `${id}-${gate.key}-code`, rule: `${id}-${gate.key}-rule`, note: `${id}-${gate.key}-note` };
      return <li key={gate.key} className="space-y-2 rounded-2xl border border-neutral-200 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label={`Gate ${index + 1} code`} autoFocus={gate.key === focusKey} maxLength={12} value={gate.code} onChange={(event) => update(gate.key, { code: event.target.value })} placeholder={`G${index + 1}`} {...invalid(err("code"), `${ids.code}-error`)} className={clsx(inputClass, "!min-h-9 !w-20 !px-2.5 font-mono text-[13px]", err("code") && "!border-danger")} />
          <div className="min-w-[10rem] flex-1 sm:max-w-[13rem]"><Select aria-label={`Gate ${index + 1}: what happens when it fails`} className={clsx(inputClass, "!min-h-9")} value={gate.ifFails} onChange={(event) => update(gate.key, { ifFails: event.target.value as OfferGate["ifFails"] })}><option value="reject">Reject if it fails</option><option value="hold">Hold if it fails</option></Select></div>
          <span className="ml-auto flex items-center">
            <button type="button" aria-label={`Move gate ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} className={iconButton}><ChevronDown size={16} className="rotate-180" /></button>
            <button type="button" aria-label={`Move gate ${index + 1} down`} disabled={index === gates.length - 1} onClick={() => move(index, 1)} className={iconButton}><ChevronDown size={16} /></button>
            <button type="button" aria-label={`Remove gate ${index + 1}`} onClick={() => onChange(gates.filter((item) => item.key !== gate.key))} className={iconButton}><X size={15} /></button>
          </span>
        </div>
        <FieldError id={`${ids.code}-error`} message={err("code")} />
        <textarea aria-label={`Gate ${index + 1} rule`} rows={2} maxLength={500} value={gate.rule} onChange={(event) => update(gate.key, { rule: event.target.value })} placeholder="What must be true, e.g. They sell through dealers or distributors." {...invalid(err("rule"), `${ids.rule}-error`)} className={clsx(inputClass, "py-2.5 text-[13px] leading-6", err("rule") && "!border-danger")} />
        <FieldError id={`${ids.rule}-error`} message={err("rule")} />
        <input aria-label={`Gate ${index + 1} note`} maxLength={500} value={gate.note} onChange={(event) => update(gate.key, { note: event.target.value })} placeholder="Note (optional): how to check it, or an example" {...invalid(err("note"), `${ids.note}-error`)} className={clsx(inputClass, "!min-h-10 text-[13px]", err("note") && "!border-danger")} />
        <FieldError id={`${ids.note}-error`} message={err("note")} />
      </li>;
    })}</ol>
    {gates.length < 20 && <button type="button" onClick={add} className={clsx(secondaryClass, "mt-2.5 !min-h-9 !px-3 !text-xs")}><Plus size={14} aria-hidden="true" />Add a gate</button>}
    <FieldError id={`${id}-error`} message={errors.gates} />
  </fieldset>;
}

/** Phrases the finder looks for on a company's own pages, each with what it means. */
function LookForEditor({ rows, onChange, errors }: { rows: SignalRow[]; onChange: (rows: SignalRow[]) => void; errors: Errors }) {
  const id = useId();
  const [focusKey, setFocusKey] = useState("");
  const update = (key: string, change: Partial<SignalRow>) => onChange(rows.map((row) => row.key === key ? { ...row, ...change } : row));
  const add = () => { const key = newKey(); setFocusKey(key); onChange([...rows, { key, phrase: "", meaning: "" }]); };
  return <fieldset className="min-w-0">
    <legend className={fieldLabel}>Look for on their pages <span className={hintClass}>· the finder quotes them; up to 40</span></legend>
    <ul className="space-y-2">{rows.map((row, index) => {
      const err = (field: string) => errors[`lookFor.${index}.${field}`];
      return <li key={row.key} className="grid gap-2 rounded-xl border border-neutral-200 p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_2.25rem] sm:items-start">
        <div className="flex items-start gap-1.5 sm:contents">
          <div className="min-w-0 flex-1"><input aria-label={`Phrase ${index + 1}`} autoFocus={row.key === focusKey} maxLength={80} value={row.phrase} onChange={(event) => update(row.key, { phrase: event.target.value })} placeholder="become a dealer" {...invalid(err("phrase"), `${id}-${row.key}-p`)} className={clsx(inputClass, "!min-h-10 text-[13px]", err("phrase") && "!border-danger")} /><FieldError id={`${id}-${row.key}-p`} message={err("phrase")} /></div>
          <button type="button" aria-label={`Remove phrase ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.key !== row.key))} className={clsx(iconButton, "sm:order-last")}><X size={15} /></button>
        </div>
        <div className="min-w-0"><textarea rows={1} aria-label={`What phrase ${index + 1} means`} maxLength={200} value={row.meaning} onChange={(event) => update(row.key, { meaning: event.target.value })} placeholder="They recruit dealers: catalog orders matter" {...invalid(err("meaning"), `${id}-${row.key}-m`)} className={clsx(inputClass, "!min-h-10 resize-none py-2 text-[13px] leading-6 [field-sizing:content]", err("meaning") && "!border-danger")} /><FieldError id={`${id}-${row.key}-m`} message={err("meaning")} /></div>
      </li>;
    })}</ul>
    {rows.length < 40 && <button type="button" onClick={add} className={clsx(addButton, rows.length > 0 && "mt-1.5")}><Plus size={13} aria-hidden="true" />Add a phrase</button>}
    <FieldError id={`${id}-error`} message={errors.lookFor} />
  </fieldset>;
}

/** One folding part of the editor: its name, a one-line summary of what it holds, and how many fields need fixing. */
function Part({ title, summary, problems, open, onToggle, children }: { title: string; summary: string; problems: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const id = useId();
  return <section className={clsx("rounded-2xl border bg-white transition-colors duration-150", problems ? "border-danger/40" : "border-neutral-200")}>
    <h3><button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left transition-colors duration-150 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-600">
      <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-neutral-900">{title}</span><span className={clsx("block truncate text-xs", summary === "Not set" ? "text-neutral-400" : "text-neutral-500")}>{summary}</span></span>
      {problems > 0 && <Badge tone="red">{problems} to fix</Badge>}
      <ChevronDown size={16} aria-hidden="true" className={clsx("shrink-0 text-neutral-400 transition-transform duration-150", open && "rotate-180")} />
    </button></h3>
    {open && <div id={id} className="vso-fade-enter space-y-4 border-t border-neutral-100 px-4 pb-4 pt-4">{children}</div>}
  </section>;
}

/**
 * The packet editor in a drawer: name, summary and what changed at the top, then one folding part per section. It checks the packet
 * with the contract schema before saving and marks each field that needs fixing. Nothing changes what Claude uses until a venture head
 * approves the version.
 */
export function OfferEditor({ ventureId, target, onClose, onSaved }: { ventureId: string; target: OfferEditorTarget; onClose: () => void; onSaved: (version: OfferVersion) => void }) {
  const { ventureName } = useSalesShell();
  const [initial] = useState<Form>(() => target.mode === "new" ? toForm("", EMPTY_PACKET, "") : target.mode === "propose" ? toForm(target.offer.name, target.from?.packet ?? EMPTY_PACKET, "") : toForm(target.version.name, target.version.packet, target.version.change));
  const [form, setForm] = useState<Form>(initial);
  const [open, setOpen] = useState<Partial<Record<SectionKey, boolean>>>(() => target.mode === "new" ? { whoFor: true } : {});
  const [errors, setErrors] = useState<Errors>({});
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [start] = useState(() => ({ all: fingerprint(initial), packet: fingerprint(initial, false) }));
  const dirty = fingerprint(form) !== start.all;
  const draft = toPacket(form).packet;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // A field's message goes once the person changes it.
    setErrors((current) => Object.keys(current).some((name) => name === key || name.startsWith(`${String(key)}.`)) ? Object.fromEntries(Object.entries(current).filter(([name]) => name !== key && !name.startsWith(`${String(key)}.`))) : current);
  };
  const problemsIn = (section: SectionKey | "basics") => Object.keys(errors).filter((name) => SECTION_OF[name.split(".")[0]!] === section).length;

  // After a failed check, the first field to fix gets the focus (its part is open by then).
  useEffect(() => {
    if (!attempt) return;
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [attempt]);

  function check(): { ok: true; input: { name: string; packet: OfferPacket; change: string } } | { ok: false } {
    const { packet, rows } = toPacket(form);
    const input = { ventureId, ...(target.mode === "propose" ? { offerId: target.offer.id } : {}), name: form.name, packet, change: form.change };
    const parsed = offerProposalInputSchema.safeParse(input);
    const found: Errors = {};
    if (!parsed.success) for (const issue of parsed.error.issues as Issue[]) { const key = errorKey(issue.path, rows); if (key && !found[key]) found[key] = friendly(issue); }
    // Verdicts name gates by code, so two gates may not share one.
    const seen = new Map<string, number>();
    packet.gates.forEach((gate, index) => {
      const code = gate.code.toLowerCase();
      const row = rows.gates?.[index] ?? index;
      if (code && seen.has(code) && !found[`gates.${row}.code`]) found[`gates.${row}.code`] = `Gate ${seen.get(code)! + 1} already uses ${gate.code}.`;
      else if (code) seen.set(code, row);
    });
    if (Object.keys(found).length || !parsed.success) {
      setErrors(found);
      setOpen((current) => ({ ...current, ...Object.fromEntries(Object.keys(found).map((name) => [SECTION_OF[name.split(".")[0]!], true]).filter(([section]) => section && section !== "basics")) }));
      setError(`Fix the ${Object.keys(found).length === 1 ? "marked field" : `${Object.keys(found).length} marked fields`} first.`);
      setAttempt((value) => value + 1);
      return { ok: false };
    }
    return { ok: true, input: { name: parsed.data.name, packet: parsed.data.packet, change: parsed.data.change } };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const result = check();
    if (!result.ok) return;
    if (target.mode === "propose" && fingerprint(form, false) === start.packet) { setError("Nothing has changed yet. Change a section, then propose it."); return; }
    setErrors({}); setBusy(true);
    try {
      const saved = target.mode === "edit" ? await updateOfferDraft(target.version.id, result.input) : await proposeOffer({ ventureId, ...(target.mode === "propose" ? { offerId: target.offer.id } : {}), ...result.input });
      toast({ title: target.mode === "edit" ? "Proposal saved" : target.mode === "new" ? "Offer proposed" : "Change proposed", body: `${saved.name}, version ${saved.version}. A venture head approves it before Claude uses it.` });
      onSaved(saved); onClose();
    } catch (cause) { setError(describeError(cause, "Could not save. Try again.")); }
    finally { setBusy(false); }
  }

  const title = target.mode === "new" ? "New offer" : target.mode === "propose" ? "Propose a change" : "Edit proposal";
  const subtitle = target.mode === "new" ? ventureName(ventureId) : target.mode === "propose" ? `${target.offer.name} · ${target.from ? `starts from version ${target.from.version}` : "its first version"}` : `${target.offer.name} · version ${target.version.version}, not approved yet`;
  const toggle = (key: SectionKey) => setOpen((current) => ({ ...current, [key]: !current[key] }));
  const part = (key: SectionKey, children: React.ReactNode) => <Part key={key} title={SECTIONS.find((section) => section.key === key)!.label} summary={sectionSummary(draft, key)} problems={problemsIn(key)} open={!!open[key]} onToggle={() => toggle(key)}>{children}</Part>;
  const lineList = (name: LineKey, label: string, props: { hint?: string; max: number; maxLength: number; placeholder: string; addLabel: string }) => <LineList name={name} label={label} items={form[name]} onChange={(items) => set(name, items)} errors={errors} {...props} />;

  return <DetailDrawer title={title} subtitle={subtitle} dirty={dirty && !busy} onClose={onClose}>
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4">
      {target.mode === "new"
        ? <div className="flex items-start gap-3 rounded-2xl bg-ai-surface p-3.5 text-ai-text"><Sparkles size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><p className="min-w-0 text-xs leading-5"><b className="font-semibold">Claude can draft this for you.</b> Tell Claude about the offer and it proposes the packet: who it is for, the gates, the signals and the message rules. A venture head approves it here.</p></div>
        : <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-600">Claude uses only the approved packet. {target.mode === "propose" && target.from ? `Version ${target.from.version} stays in use until a venture head approves this change, as a whole, on the offer page.` : "A venture head approves the whole packet on the offer page."}</p>}

      <div className="space-y-3.5">
        <TextField label="Name" value={form.name} onChange={(value) => set("name", value)} max={120} placeholder="Dealer Commerce" error={errors.name} />
        <TextField label="In one line" hint="what is sold, to whom" value={form.summary} onChange={(value) => set("summary", value)} max={300} rows={2} placeholder="Catalog-to-order systems for dealer-led suppliers." error={errors.summary} />
        <TextField label={target.mode === "new" ? "A note for the approver" : "What changed"} hint={target.mode === "new" ? "optional" : "in a sentence, for the approver"} value={form.change} onChange={(value) => set("change", value)} max={1_000} rows={2} placeholder={target.mode === "new" ? "Why this offer, and what is still open." : "Added gate G10 for national brands; tightened the price line."} error={errors.change} />
      </div>

      <div className="space-y-2.5">
        {part("whoFor", <>
          <TextField label="Who it is for" hint="the buyer, in a few sentences" value={form.description} onChange={(value) => set("description", value)} max={3_000} rows={4} placeholder="Owner-led manufacturers and distributors who sell through a dealer network and take orders by phone or WhatsApp." error={errors.description} />
          <ChipsField label="Industries" hint="up to 40" placeholder="Pipes, pumps, irrigation" items={form.industries} onChange={(items) => set("industries", items)} max={40} maxLength={120} error={errors.industries} />
          <ChipsField label="Customer types" hint="up to 20" placeholder="Manufacturer, distributor" items={form.customerTypes} onChange={(items) => set("customerTypes", items)} max={20} maxLength={120} error={errors.customerTypes} />
          <ChipsField label="Places" hint="cities, states or countries; up to 60" placeholder="Raipur, Madhya Pradesh" items={form.places} onChange={(items) => set("places", items)} max={60} maxLength={120} error={errors.places} />
          {lineList("companySizes", "Company sizes", { max: 20, maxLength: 300, placeholder: "20 to 200 dealers", addLabel: "Add a size" })}
          {lineList("buyerRoles", "Buyer roles", { hint: "who decides", max: 20, maxLength: 300, placeholder: "Owner or managing director", addLabel: "Add a role" })}
        </>)}
        {part("gates", <>
          <GatesEditor gates={form.gates} onChange={(gates) => set("gates", gates)} errors={errors} />
          {lineList("exclusions", "Also not a fit", { hint: "sentences Claude applies when judging", max: 30, maxLength: 500, placeholder: "National brands with their own dealer portal", addLabel: "Add an exclusion" })}
        </>)}
        {part("signals", <>
          <LookForEditor rows={form.lookFor} onChange={(rows) => set("lookFor", rows)} errors={errors} />
          <ChipsField label="Search words" hint="added to each search, most specific first; up to 10" placeholder="dealer enquiry, manufacturer" items={form.searchWords} onChange={(items) => set("searchWords", items)} max={10} maxLength={60} error={errors.searchWords} />
          <ChipsField label="Rule a result out" hint="words that drop a result before any page is read; up to 10" placeholder="pesticide formulations" items={form.negatives} onChange={(items) => set("negatives", items)} max={10} maxLength={60} error={errors.negatives} />
        </>)}
        {part("say", <>
          <TextField label="Value proposition" value={form.valueProposition} onChange={(value) => set("valueProposition", value)} max={3_000} rows={4} placeholder="What changes for the buyer, in their words." error={errors.valueProposition} />
          {lineList("pitchAngles", "Pitch angles", { max: 20, maxLength: 600, placeholder: "Dealers order from a phone catalog instead of calling the office", addLabel: "Add an angle" })}
          <TextField label="Proof words" hint="the proof we may point to" value={form.proofWords} onChange={(value) => set("proofWords", value)} max={500} rows={2} error={errors.proofWords} />
          {lineList("approvedClaims", "Approved claims", { max: 20, maxLength: 500, placeholder: "Live in two weeks for a catalog under 500 items", addLabel: "Add a claim" })}
          {lineList("claimsToAvoid", "Claims to avoid", { max: 30, maxLength: 500, placeholder: "Never promise more sales", addLabel: "Add a claim to avoid" })}
        </>)}
        {part("messages", <TextField label="How messages are written" hint="structure, channels, length, follow-up, review checklist; Markdown works" value={form.messages} onChange={(value) => set("messages", value)} max={12_000} rows={12} mono error={errors.messages} />)}
        {part("price", <TextField label="What may be said about price, and when" value={form.price} onChange={(value) => set("price", value)} max={2_000} rows={4} placeholder="A range only, never a bare number before the written scope." error={errors.price} />)}
        {part("scoring", <TextField label="How leads that pass every gate are sorted" hint="1 to 3 per criterion" value={form.scoring} onChange={(value) => set("scoring", value)} max={3_000} rows={5} error={errors.scoring} />)}
        {part("notes", <TextField label="Anything else Claude should know for this offer" value={form.notes} onChange={(value) => set("notes", value)} max={6_000} rows={6} error={errors.notes} />)}
      </div>

      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className={clsx(primaryClass, "max-sm:flex-1")}><ActionLabel busy={busy} busyText="Saving…" idle={target.mode === "edit" ? "Save proposal" : "Propose for approval"} /></button>
        <button type="button" onClick={onClose} className={clsx(secondaryClass, "max-sm:flex-1")}>Cancel</button>
      </div>
    </form>
  </DetailDrawer>;
}
