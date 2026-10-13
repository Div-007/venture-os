"use client";
import { describeError } from "@/lib/errors";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { DetailDrawer, Field, inputClass, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { createLiveVenture } from "@/lib/studio-api";

type Venture = Awaited<ReturnType<typeof createLiveVenture>>;

/** Admin-only workspace venture creation; the server enforces the role. Portaled so a transformed sidebar cannot clip it. */
export function CreateVentureDrawer({ workspaceName, ownerId, onClose, onCreated }: { workspaceName: string; ownerId: string; onClose: () => void; onCreated: (venture: Venture) => void }) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  // Focus after DetailDrawer records the opener (child effects run first); autoFocus would make the drawer restore focus to this input instead.
  useEffect(() => { nameInput.current?.focus(); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const venture = await createLiveVenture({ name: name.trim(), ownerId, goal30Day: goal.trim() });
      window.dispatchEvent(new Event("venture:hierarchy-changed"));
      onCreated(venture);
    } catch (cause) {
      setError(describeError(cause, "Could not create the venture."));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(<DetailDrawer title="Create venture" subtitle={`Destination · ${workspaceName}`} onClose={onClose}><form onSubmit={create} className="space-y-5"><Field label="Venture name"><input ref={nameInput} required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className={inputClass} placeholder="Venture name" /></Field><Field label="30-day goal"><textarea maxLength={500} value={goal} onChange={(event) => setGoal(event.target.value)} className={`${inputClass} min-h-28 py-3`} placeholder="What should this venture prove next?" /></Field><p className="text-xs text-neutral-500">The venture will be created in your current workspace.</p>{error && <p role="alert" className="text-sm text-danger-text">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button><button type="submit" disabled={busy || !name.trim()} className={primaryClass}>{busy ? "Creating…" : "Create venture"}</button></div></form></DetailDrawer>, document.body);
}
