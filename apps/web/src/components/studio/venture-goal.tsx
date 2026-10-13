"use client";

import { useEffect, useRef, useState } from "react";
import { Edit, Plus, Target } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";

const GOAL_MAX = 500;
const editButton = "inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-primary-700 transition-[background-color,transform] duration-150 hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]";

/** The venture's 30-day goal, with an inline editor when `onSave` is given (the caller decides who may edit). */
export function VentureGoal({ goal, onSave }: { goal: string; onSave?: (goal: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Closing the editor removes the focused field, so focus goes back to the button that opened it.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!editing && returnFocus.current) { returnFocus.current = false; editRef.current?.focus(); }
  }, [editing]);

  const start = () => { setDraft(goal); setError(""); setEditing(true); };
  const close = () => { returnFocus.current = true; setEditing(false); setError(""); };
  const cancel = () => { if (!saving) close(); };
  async function save() {
    if (!onSave || saving) return;
    const next = draft.trim();
    if (next === goal) { close(); return; }
    setSaving(true); setError("");
    try { await onSave(next); close(); }
    catch (cause) { setError(describeError(cause, "Could not save the goal.")); textareaRef.current?.focus(); }
    finally { setSaving(false); }
  }

  if (editing) return <form className="w-full max-w-3xl" aria-busy={saving || undefined}
    onSubmit={(event) => { event.preventDefault(); void save(); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}>
    <label htmlFor="venture-goal" className="text-lg font-bold text-neutral-900">30-day goal</label>
    <textarea ref={textareaRef} id="venture-goal" autoFocus rows={3} maxLength={GOAL_MAX} value={draft} readOnly={saving} placeholder="What should this venture achieve in the next 30 days?"
      aria-describedby={error ? "venture-goal-error" : undefined} aria-invalid={error ? true : undefined}
      onChange={(event) => setDraft(event.target.value)}
      className={`${inputClass} mt-2 resize-y py-2.5 leading-6`} />
    {error && <p id="venture-goal-error" role="alert" className="mt-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="submit" disabled={saving} className={primaryClass}>{saving ? "Saving…" : "Save goal"}</button>
      <button type="button" onClick={cancel} disabled={saving} className={secondaryClass}>Cancel</button>
      <span className="ml-auto text-xs font-medium text-neutral-400">{draft.trim().length}/{GOAL_MAX}</span>
    </div>
  </form>;

  return <div>
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-bold text-neutral-900">30-day goal</h2>
      {onSave && <button ref={editRef} type="button" onClick={start} aria-label={goal ? "Edit 30-day goal" : "Set 30-day goal"} className={editButton}>{goal ? <><Edit size={14} />Edit</> : <><Plus size={14} />Set goal</>}</button>}
    </div>
    {goal
      ? <p className="mt-2 max-w-3xl whitespace-pre-line break-words text-base font-semibold leading-7 text-neutral-700">{goal}</p>
      : <EmptyState variant="compact" icon={Target} title="No 30-day goal yet." body={onSave ? "Set one so everyone knows what this venture is working toward." : undefined} className="mt-2 max-w-3xl" />}
  </div>;
}
