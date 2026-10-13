"use client";
import { useId, useState } from "react";
import clsx from "clsx";
import { X } from "@/components/ui/icons";

/**
 * A list of short items typed one at a time: Enter or a comma adds one, and pasted lines or comma lists are split. Backspace in the
 * empty box removes the last one. Used by the find-leads plan and the offer editor.
 */
export function ChipsField({ label, hint, placeholder, items, onChange, max, maxLength, error, split = /[,\n]/ }: {
  label: string; hint?: string; placeholder: string; items: string[]; onChange: (items: string[]) => void; max: number; maxLength: number;
  /** Shown under the box, which is then marked invalid. */
  error?: string | undefined;
  /** What separates items when typed or pasted (commas and new lines by default). */
  split?: RegExp;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const full = items.length >= max;
  function add(raw: string) {
    const parts = raw.split(split).map((part) => part.trim().slice(0, maxLength)).filter(Boolean);
    if (!parts.length) { setText(""); return; }
    const next = [...items];
    for (const part of parts) if (next.length < max && !next.some((item) => item.toLowerCase() === part.toLowerCase())) next.push(part);
    onChange(next); setText("");
  }
  const splits = (value: string) => new RegExp(split.source).test(value);
  return <div>
    <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-neutral-600">{label}{hint && <span className="font-normal text-neutral-400"> · {hint}</span>}</label>
    <div className={clsx("flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border bg-white px-2.5 py-2 transition-[border-color,box-shadow] duration-150 focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-100", error ? "border-danger" : "border-neutral-200")}>
      {items.map((item) => <span key={item} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg bg-primary-50 py-1 pl-2.5 pr-1 text-xs font-semibold text-primary-800"><span className="min-w-0 [overflow-wrap:anywhere]">{item}</span><button type="button" aria-label={`Remove ${item}`} onClick={() => onChange(items.filter((other) => other !== item))} className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors duration-150 hover:bg-primary-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><X size={11} /></button></span>)}
      <input id={id} value={text} disabled={full} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => { const value = event.target.value; if (splits(value)) add(value); else setText(value); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(text); } else if (event.key === "Backspace" && !text && items.length) onChange(items.slice(0, -1)); }}
        onBlur={() => add(text)} onPaste={(event) => { const pasted = event.clipboardData.getData("text"); if (splits(pasted)) { event.preventDefault(); add(pasted); } }}
        placeholder={full ? `Up to ${max}` : items.length ? "Add another" : placeholder} className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm font-medium text-neutral-800 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed" />
    </div>
    {error && <p id={`${id}-error`} className="mt-1 text-xs font-semibold text-danger-text">{error}</p>}
  </div>;
}
