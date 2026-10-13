"use client";

import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, ChevronDown } from "@/components/ui/icons";
import { prefersReducedMotion } from "@/lib/motion";

type Choice = { value: string; label: ReactNode; text: string; disabled: boolean };
type SelectChange = { target: { value: string }; currentTarget: { value: string } };
type Props = {
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onChange?: (event: SelectChange) => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
};

function optionText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(optionText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return optionText(node.props.children);
  return "";
}

function choicesFrom(children: ReactNode): Choice[] {
  return Children.toArray(children).flatMap((node): Choice[] => {
    if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>(node)) return [];
    if (node.type === Fragment) return choicesFrom(node.props.children);
    if (node.type !== "option") return [];
    const text = optionText(node.props.children);
    return [{ value: String(node.props.value ?? text), label: node.props.children, text, disabled: Boolean(node.props.disabled) }];
  });
}

/** A site-styled, single-choice select. The native required control remains for form validation. */
export function Select({ children, value, defaultValue, onChange, className, disabled, required, id, name, "aria-label": ariaLabel }: Props) {
  const choices = choicesFrom(children);
  const [internalValue, setInternalValue] = useState(defaultValue ?? choices[0]?.value ?? "");
  const selectedValue = value ?? internalValue;
  const selected = choices.find((choice) => choice.value === selectedValue);
  const [open, setOpen] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 180, maxHeight: 280 });
  const [above, setAbove] = useState(false);
  // Pointer opens and closes animate; keyboard-driven ones stay instant.
  const [motion, setMotion] = useState<"none" | "open" | "closing">("none");
  const closeTimer = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listId = useId().replaceAll(":", "");

  function show(fromKeyboard = false) {
    if (disabled || !trigger.current) return;
    window.clearTimeout(closeTimer.current);
    setMotion(fromKeyboard ? "none" : "open");
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width, 180));
    const desiredHeight = Math.min(280, choices.length * 38 + 8);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const placeAbove = below < Math.min(desiredHeight, 160) && above > below;
    const maxHeight = Math.max(80, Math.min(desiredHeight, placeAbove ? above : below));
    setPosition({ top: placeAbove ? rect.top - maxHeight - 4 : rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, maxHeight });
    setAbove(placeAbove);
    setPortalHost(trigger.current.closest<HTMLDialogElement>("dialog[open]") ?? document.body);
    setHighlighted(Math.max(0, choices.findIndex((choice) => choice.value === selectedValue)));
    setOpen(true);
  }

  function hide(animate: boolean) {
    window.clearTimeout(closeTimer.current);
    if (!animate || prefersReducedMotion()) { setOpen(false); return; }
    setMotion("closing");
    closeTimer.current = window.setTimeout(() => setOpen(false), 100);
  }
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  function choose(choice: Choice, fromKeyboard = false) {
    if (choice.disabled) return;
    const target = { value: choice.value };
    onChange?.({ target, currentTarget: target });
    if (value === undefined) setInternalValue(target.value);
    hide(!fromKeyboard);
    trigger.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") { if (open) { event.preventDefault(); event.stopPropagation(); hide(false); } return; }
    if (event.key === "Tab") { hide(false); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) show(true); else if (choices[highlighted]) choose(choices[highlighted], true);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(true); return; }
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const start = event.key === "Home" ? -1 : event.key === "End" ? choices.length : highlighted;
      for (let offset = 1; offset <= choices.length; offset++) {
        const index = event.key === "Home" ? offset - 1 : event.key === "End" ? choices.length - offset : (start + direction * offset + choices.length * 2) % choices.length;
        if (!choices[index]?.disabled) { setHighlighted(index); break; }
      }
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const match = choices.findIndex((choice) => !choice.disabled && choice.text.toLowerCase().startsWith(event.key.toLowerCase()));
      if (match >= 0) { event.preventDefault(); if (!open) show(true); setHighlighted(match); }
    }
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (trigger.current?.contains(event.target) || menu.current?.contains(event.target))) return;
      hide(true);
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      hide(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("pointerdown", onPointerDown, true); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const list = menu.current;
    const item = list?.querySelector<HTMLElement>(`[data-choice-index="${highlighted}"]`);
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [highlighted, open]);

  return <span className={className?.includes("w-full") ? "relative block w-full min-w-0" : "relative inline-flex min-w-0"}>
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open && motion !== "closing"} aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${highlighted}` : undefined} aria-required={required || undefined} disabled={disabled} onClick={() => open && motion !== "closing" ? hide(true) : show()} onKeyDown={onKeyDown}
      className={clsx("relative flex min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-50", className)} style={{ paddingRight: "2.25rem" }}>
      <span className="min-w-0 flex-1 truncate">{selected?.label ?? "Select…"}</span><ChevronDown size={15} aria-hidden="true" className={clsx("pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 transition-transform duration-150", open && "rotate-180")} />
    </button>
    {(required || name) && <select aria-hidden="true" tabIndex={-1} name={name} required={required} value={selectedValue} onChange={() => {}} onInvalid={(event) => { event.preventDefault(); show(); trigger.current?.focus(); }} className="pointer-events-none absolute h-px w-px opacity-0">{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.text}</option>)}</select>}
    {open && portalHost && createPortal(<div ref={menu} id={listId} role="listbox" aria-label={ariaLabel ?? "Options"} data-side={above ? "top" : "bottom"} data-align="left" data-state={motion === "closing" ? "closing" : undefined} className={clsx("thin-scroll fixed z-[120] overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 text-neutral-800 shadow-e4", motion !== "none" && "vso-enter-popover")} style={position}>
      {choices.map((choice, index) => <div key={`${choice.value}-${index}`} id={`${listId}-${index}`} data-choice-index={index} role="option" aria-selected={choice.value === selectedValue} aria-disabled={choice.disabled || undefined} onMouseEnter={() => !choice.disabled && setHighlighted(index)} onClick={() => choose(choice)} className={clsx("flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium", choice.disabled ? "cursor-not-allowed opacity-40" : index === highlighted ? "bg-primary-50 text-primary-800" : "hover:bg-neutral-100", choice.value === selectedValue && "font-semibold")}><span className="min-w-0 flex-1 truncate">{choice.label}</span>{choice.value === selectedValue && <Check size={14} aria-hidden="true" className="shrink-0 text-primary-700" />}</div>)}
    </div>, portalHost)}
  </span>;
}
