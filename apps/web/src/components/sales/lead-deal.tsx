"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { Lead, LostReason } from "@venture-studio/contracts";
import { Check } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { updateLead } from "@/lib/sales-api";
import { CURRENCIES, LOST_REASON_LABELS, LOST_REASONS, minorToInput, moneyFull, moneyShort, parseMoney, probabilityOf, STAGE_LABELS, STAGE_PROBABILITY } from "@/components/sales/sales-ui";

const IST = "Asia/Kolkata";
/** The calendar day (in India) of a stored moment, for a date input. */
const dayOf = (iso?: string) => iso ? new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date(iso)) : "";
/** Noon in India on a picked day, so the day never slips with the viewer's time zone. */
const noonOf = (day: string) => `${day}T06:30:00.000Z`;

const dayLabel = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: IST }).format(new Date(iso));

/** The deal in words, for a tile or a details row: value, expected close, chance (and what it is worth in the forecast) and, once lost, why. */
export function dealFacts(lead: Lead) {
  const currency = lead.currency ?? "INR";
  const value = lead.valueEstimateMinor ?? 0;
  const chance = probabilityOf(lead);
  return {
    value, currency, chance,
    valueShort: value ? moneyShort(value, currency) : "",
    valueFull: value ? moneyFull(value, currency) : "",
    chanceNote: lead.probability === undefined ? `${chance}% (${STAGE_LABELS[lead.stage]} default)` : `${chance}%`,
    closes: lead.expectedCloseAt ? dayLabel(lead.expectedCloseAt) : "",
    weightedShort: value ? moneyShort(Math.round(value * chance / 100), currency) : "",
    weightedFull: value ? moneyFull(Math.round(value * chance / 100), currency) : "",
    lostWhy: lead.stage === "lost" && lead.lostReason ? LOST_REASON_LABELS[lead.lostReason] : "",
  };
}

/** The deal form: what it is worth, when it should close, how likely it is (the stage's default unless a person says otherwise) and, once lost, why. Shown only when a person chose Edit. */
export function LeadDeal({ lead, onSaved, onCancel, onDirty }: { lead: Lead; onSaved: () => void; onCancel: () => void; onDirty: (key: string, dirty: boolean) => void }) {
  const saved = { value: minorToInput(lead.valueEstimateMinor), currency: lead.currency ?? "INR", close: dayOf(lead.expectedCloseAt), probability: lead.probability === undefined ? "" : String(lead.probability), lostReason: lead.lostReason ?? "" };
  const [value, setValue] = useState(saved.value);
  const [currency, setCurrency] = useState(saved.currency);
  const [close, setClose] = useState(saved.close);
  const [probability, setProbability] = useState(saved.probability);
  const [lostReason, setLostReason] = useState<LostReason | "">(saved.lostReason as LostReason | "");
  // A value the server changed (a stage move, another edit) replaces the matching field; what is being typed elsewhere stays.
  const [base, setBase] = useState(saved);
  if (JSON.stringify(base) !== JSON.stringify(saved)) {
    if (base.value !== saved.value) setValue(saved.value);
    if (base.currency !== saved.currency) setCurrency(saved.currency);
    if (base.close !== saved.close) setClose(saved.close);
    if (base.probability !== saved.probability) setProbability(saved.probability);
    if (base.lostReason !== saved.lostReason) setLostReason(saved.lostReason as LostReason | "");
    setBase(saved);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lost = lead.stage === "lost";
  const minor = parseMoney(value);
  const chance = probability.trim() === "" ? undefined : Number(probability);
  const chanceValid = chance === undefined || (Number.isInteger(chance) && chance >= 0 && chance <= 100);
  const dirty = value.trim() !== saved.value || currency !== saved.currency || close !== saved.close || probability.trim() !== saved.probability || (lost && lostReason !== saved.lostReason);
  useEffect(() => { onDirty("deal", dirty); return () => onDirty("deal", false); }, [dirty, onDirty]);

  const stageChance = STAGE_PROBABILITY[lead.stage];
  const shownChance = chance !== undefined && chanceValid ? chance : stageChance;
  const worth = (value.trim() === "" ? lead.valueEstimateMinor : minor) ?? 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (value.trim() !== "" && minor === null) { setError("Enter the value as a plain amount, like 1250000."); return; }
    if (!chanceValid) { setError("The chance is a whole number from 0 to 100."); return; }
    setBusy(true); setError("");
    try {
      await updateLead(lead.id, {
        valueEstimateMinor: value.trim() === "" ? 0 : minor ?? 0, currency, expectedCloseAt: close ? noonOf(close) : null, probability: chance === undefined ? null : chance,
        ...(lost && lostReason ? { lostReason } : {}),
      });
      toast({ title: "Deal saved", body: `${lead.companyName}: ${value.trim() === "" ? "no value yet" : moneyShort(minor ?? 0, currency)}` });
      onSaved(); onCancel();
    } catch (cause) { setError(describeError(cause, "Could not save the deal.")); }
    finally { setBusy(false); }
  }

  return <form onSubmit={save} className="grid grid-cols-1 gap-3">
    <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-3">
      <Field label="Deal value"><input autoFocus inputMode="decimal" className={inputClass} value={value} onChange={(event) => setValue(event.target.value)} placeholder="1250000" aria-describedby="deal-value-hint" /></Field>
      <Field label="Currency"><Select aria-label="Currency" className={inputClass} value={currency} onChange={(event) => setCurrency(event.target.value)}>{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</Select></Field>
    </div>
    {minor ? <p id="deal-value-hint" className="-mt-1 text-xs font-medium text-neutral-500" title={moneyFull(minor, currency)}>{moneyFull(minor, currency)}</p> : <p id="deal-value-hint" className="-mt-1 text-xs font-medium text-neutral-400">The total we expect to bill, in whole currency units.</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Expected to close"><input type="date" className={inputClass} value={close} onChange={(event) => setClose(event.target.value)} /></Field>
      <Field label="Chance it closes (%)"><input inputMode="numeric" className={inputClass} value={probability} onChange={(event) => setProbability(event.target.value.replace(/[^\d]/g, "").slice(0, 3))} placeholder={String(stageChance)} aria-describedby="deal-chance-hint" /></Field>
    </div>
    <p id="deal-chance-hint" className="-mt-1 text-xs leading-5 text-neutral-500">
      {probability.trim() === "" ? <>Using the <strong className="font-semibold text-neutral-700">{STAGE_LABELS[lead.stage]}</strong> default of {stageChance}%. Type a number to override it.</> : <>Your number replaces the {stageChance}% default. <button type="button" onClick={() => setProbability("")} className="font-semibold text-primary-700 hover:underline">Use the stage default</button></>}
      {worth > 0 && <> Counts as <strong className="font-semibold text-neutral-700" title={moneyFull(Math.round(worth * shownChance / 100), currency)}>{moneyShort(Math.round(worth * shownChance / 100), currency)}</strong> in the forecast.</>}
    </p>
    {lost && <Field label="Why it was lost"><Select aria-label="Why it was lost" className={inputClass} value={lostReason} onChange={(event) => setLostReason(event.target.value as LostReason)}><option value="" disabled>Pick one</option>{LOST_REASONS.map((reason) => <option key={reason} value={reason}>{LOST_REASON_LABELS[reason]}</option>)}</Select></Field>}
    <Notice tone="error" message={error} onDismiss={() => setError("")} />
    <div className="flex flex-wrap gap-2">
      <button disabled={!dirty || busy} className={clsx(primaryClass, "flex-1 sm:flex-none")}><ActionLabel busy={busy} idle={<><Check size={15} />Save deal</>} /></button>
      <button type="button" onClick={onCancel} className={clsx(secondaryClass, "flex-1 sm:flex-none")}>Cancel</button>
    </div>
  </form>;
}
