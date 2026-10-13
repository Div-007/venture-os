"use client";
import { useState } from "react";
import clsx from "clsx";
import type { Play } from "@venture-studio/contracts";
import { Plus, X } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { ActionLabel, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createPlay, updatePlay } from "@/lib/sales-api";
import { ChannelTile, kickerClass, writableVentures } from "./draft-shared";
import { offerIsUsable, openOffers, useVentureOffers } from "./offer-model";
import { useSalesShell } from "./sales-context";

export type PlayStep = Play["steps"][number];
const STEP_CHANNELS: PlayStep["channel"][] = ["call", "email", "whatsapp", "linkedin"];
const STEP_LABEL: Record<PlayStep["channel"], string> = { call: "Call", email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn" };
export const MOTION_LABEL: Record<Play["motion"], string> = { high_touch: "Personal touch", volume: "Volume" };
const MOTION_HELP: Record<Play["motion"], string> = { high_touch: "Calls and messages written for each company. Fewer leads, more care.", volume: "Templates to many companies. Needs approved wording, and a person still reads the first batch." };

const STARTER_STEPS: PlayStep[] = [
  { day: 0, channel: "call", action: "Short opener from the call guide. Ask how they handle it today. If they say yes to WhatsApp, record it." },
  { day: 0, channel: "email", action: "Open with their own signal, ask one question, one ask (a 20-minute call). End with \"Prefer WhatsApp?\" and the link." },
  { day: 4, channel: "email", action: "One follow-up that adds a useful line tied to their signal. Then stop." },
];
const STOP_HINT = "Stop the moment anyone at the company replies, or says no. After one follow-up and 4 more working days of silence, close it as no response.";

type Draft = { name: string; ventureId: string; motion: Play["motion"]; offerId: string; offerName: string; audience: string; hypothesis: string; metric: string; stopRule: string; batchSize: string; steps: PlayStep[] };
const fromPlay = (play: Play | undefined, ventureId: string): Draft => ({
  name: play?.name ?? "", ventureId: play?.ventureId ?? ventureId, motion: play?.motion ?? "high_touch", offerId: play?.offerId ?? "", offerName: play?.offerName ?? "", audience: play?.audience ?? "", hypothesis: play?.hypothesis ?? "",
  metric: play?.metric ?? "", stopRule: play?.stopRule ?? "", batchSize: String(play?.batchSize ?? 10), steps: play?.steps.map((step) => ({ ...step })) ?? [],
});

/** Drawer to propose a new play, or edit one. A new play waits for a venture head to approve it. */
export function PlayForm({ play, onClose, onSaved }: { play?: Play; onClose: () => void; onSaved: (play: Play) => void }) {
  const { session, ventureId, ventureName, refreshKey } = useSalesShell();
  const ventures = writableVentures(session);
  const [initial] = useState(() => fromPlay(play, ventureId || (ventures.length === 1 ? ventures[0]!.id : "")));
  const [form, setForm] = useState(initial);
  // The play sells one of the venture's offers (not archived; the play's own stays listed). A new play starts on the only usable one.
  const offers = useVentureOffers(form.ventureId, refreshKey);
  const offerChoices = offers ? openOffers(offers.filter((offer) => offer.state !== "archived" || offer.id === play?.offerId)) : [];
  const usable = (offers ?? []).filter(offerIsUsable);
  const offerId = form.offerId || (!play && usable.length === 1 ? usable[0]!.id : "");
  const pickOffers = offers !== null && (offerChoices.length > 0 || !!form.offerId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setStep = (index: number, change: Partial<PlayStep>) => set("steps", form.steps.map((step, at) => at === index ? { ...step, ...change } : step));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const batchSize = Number(form.batchSize);
    if (!form.name.trim()) { setError("Give the play a name."); return; }
    if (!form.ventureId) { setError("Choose which venture this play is for."); return; }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) { setError("The batch size is a whole number from 1 to 500."); return; }
    if (form.steps.some((step) => !step.action.trim())) { setError("Every step needs a line saying what to do."); return; }
    const offer = offerId ? offers?.find((item) => item.id === offerId) : undefined;
    const fields = { name: form.name.trim(), motion: form.motion, ...(offer ? { offerId: offer.id, offerName: offer.name } : { offerName: form.offerName.trim() }), audience: form.audience.trim(), hypothesis: form.hypothesis.trim(), metric: form.metric.trim(), stopRule: form.stopRule.trim(), batchSize, steps: form.steps.map((step) => ({ ...step, action: step.action.trim() })) };
    setBusy(true); setError("");
    try {
      const saved = play ? await updatePlay(play.id, fields) : await createPlay({ ventureId: form.ventureId, ...fields });
      toast({ title: play ? "Play saved" : "Play proposed", body: play ? saved.name : `${saved.name}. A venture head approves it before it starts.` });
      onSaved(saved); onClose();
    } catch (cause) { setError(describeError(cause, "Could not save the play. Try again.")); }
    finally { setBusy(false); }
  }

  return <DetailDrawer title={play ? "Edit play" : "New play"} subtitle={play ? ventureName(play.ventureId) : "A short campaign: who, which steps, when to stop."} dirty={dirty} onClose={onClose}>
    <form onSubmit={submit} className="space-y-5">
      {!play && (ventureId
        ? <div aria-label="Play destination" className="rounded-xl border border-neutral-200 bg-neutral-50 p-3"><span className="block text-xs font-semibold text-neutral-500">Venture · fixed to the venture you picked</span><span className="mt-1 block text-sm font-bold text-neutral-800">{ventureName(ventureId)}</span></div>
        : <Field label="Venture"><Select required className={inputClass} value={form.ventureId} onChange={(event) => setForm((current) => ({ ...current, ventureId: event.target.value, offerId: "" }))}><option value="">Choose a venture</option>{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>)}
      <Field label="Name"><input required maxLength={120} value={form.name} onChange={(event) => set("name", event.target.value)} placeholder="Dealer growth, batch 1" className={inputClass} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Style"><Select className={inputClass} value={form.motion} onChange={(event) => set("motion", event.target.value as Play["motion"])}><option value="high_touch">Personal touch</option><option value="volume">Volume</option></Select></Field>
        {pickOffers
          ? <Field label="Offer"><Select className={inputClass} value={offerId} onChange={(event) => set("offerId", event.target.value)}>{!play?.offerId && <option value="">Choose an offer</option>}{offerChoices.map((offer) => <option key={offer.id} value={offer.id}>{offer.name}{offerIsUsable(offer) ? "" : offer.approved ? ` (${offer.state})` : " (draft)"}</option>)}</Select></Field>
          : <Field label="Offer"><input maxLength={200} value={form.offerName} disabled={offers === null && !!form.ventureId} onChange={(event) => set("offerName", event.target.value)} placeholder={offers === null && form.ventureId ? "Loading the offers…" : "Dealer catalogue and orders"} className={inputClass} /></Field>}
      </div>
      <p className="-mt-2 text-xs leading-5 text-neutral-500">{MOTION_HELP[form.motion]}</p>
      <Field label="Who is it for?"><textarea maxLength={2000} rows={3} value={form.audience} onChange={(event) => set("audience", event.target.value)} placeholder="Pipe and pump distributors in Chhattisgarh and Madhya Pradesh that sell through dealers." className={clsx(inputClass, "py-3")} /></Field>
      <Field label="What do you expect to happen?"><textarea maxLength={1000} rows={2} value={form.hypothesis} onChange={(event) => set("hypothesis", event.target.value)} placeholder="Owner-led distributors with a visible dealer signal book a call in at least 1 of 12 contacts." className={clsx(inputClass, "py-3")} /></Field>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
        <Field label="How will you measure it?"><input maxLength={300} value={form.metric} onChange={(event) => set("metric", event.target.value)} placeholder="Calls booked per 12 contacts" className={inputClass} /></Field>
        <Field label="First batch"><input type="number" inputMode="numeric" min={1} max={500} value={form.batchSize} onChange={(event) => set("batchSize", event.target.value)} className={inputClass} /></Field>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><span className={kickerClass}>Steps</span>{form.steps.length === 0 && <button type="button" onClick={() => set("steps", STARTER_STEPS.map((step) => ({ ...step })))} className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 transition-colors duration-150 hover:bg-primary-50">Start from a usual sequence</button>}</div>
        {form.steps.length === 0 && <p className="rounded-xl bg-neutral-50 p-3 text-xs leading-5 text-neutral-500">No steps yet. Add the first one: for most Indian buyers that is a call, or an email that ends &ldquo;Prefer WhatsApp?&rdquo;. WhatsApp comes after they say yes.</p>}
        <ol className="space-y-3">{form.steps.map((step, index) => <li key={index} className="space-y-2.5 rounded-2xl border border-neutral-200 p-3">
          <div className="flex items-center gap-2">
            <ChannelTile channel={step.channel} size={32} />
            <label className="flex items-center gap-1.5 text-xs font-semibold text-neutral-500">Day<input type="number" inputMode="numeric" min={0} max={60} aria-label={`Step ${index + 1} day`} value={step.day} onChange={(event) => setStep(index, { day: Math.min(60, Math.max(0, Math.round(Number(event.target.value) || 0))) })} className={clsx(inputClass, "!min-h-9 !w-16 !px-2 text-center")} /></label>
            <div className="min-w-0 flex-1"><Select aria-label={`Step ${index + 1} channel`} className={clsx(inputClass, "!min-h-9")} value={step.channel} onChange={(event) => setStep(index, { channel: event.target.value as PlayStep["channel"] })}>{STEP_CHANNELS.map((channel) => <option key={channel} value={channel}>{STEP_LABEL[channel]}</option>)}</Select></div>
            <button type="button" onClick={() => set("steps", form.steps.filter((_, at) => at !== index))} aria-label={`Remove step ${index + 1}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-400 transition-[background-color,color] duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={15} /></button>
          </div>
          <textarea aria-label={`Step ${index + 1} action`} maxLength={300} rows={2} value={step.action} onChange={(event) => setStep(index, { action: event.target.value })} placeholder="What happens at this step" className={clsx(inputClass, "py-2.5 text-[13px]")} />
        </li>)}</ol>
        {form.steps.length < 10 && <button type="button" onClick={() => set("steps", [...form.steps, { day: form.steps.at(-1)?.day ?? 0, channel: "email", action: "" }])} className={secondaryClass}><Plus size={15} />Add a step</button>}
        <p className="text-xs leading-5 text-neutral-500">Days count working days (Monday to Saturday). Festival days are skipped by the app.</p>
      </div>

      <Field label="When does it stop?"><textarea maxLength={500} rows={2} value={form.stopRule} onChange={(event) => set("stopRule", event.target.value)} placeholder={STOP_HINT} className={clsx(inputClass, "py-3")} /></Field>
      <p className="text-xs leading-5 text-neutral-500">Whatever you write here, the app also stops on any reply and never contacts anyone who opted out.</p>

      <Notice tone="error" message={error} onDismiss={() => setError("")} />
      <div className="flex flex-wrap gap-2"><button disabled={busy} className={primaryClass}><ActionLabel busy={busy} busyText="Saving…" idle={play ? "Save play" : "Propose play"} /></button><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button></div>
    </form>
  </DetailDrawer>;
}
