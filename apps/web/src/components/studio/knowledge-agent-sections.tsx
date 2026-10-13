"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Skill, VentureContext } from "@venture-studio/contracts";
import { describeError } from "@/lib/errors";
import { createLiveSkill, createLiveVentureContext, createLiveWorkspaceContext, deleteLiveSkill, deleteLiveVentureContext, getLiveSkill, getLiveVentureContext, listLiveSkills, listLiveVentureContext, listLiveWorkspaceContext, updateLiveSkill, updateLiveVentureContext, type loadLiveSession } from "@/lib/studio-api";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { BookOpenText, Edit, FileText, Plus, Sparkles, Upload } from "@/components/ui/icons";
import { ActionLabel, Badge, DetailDrawer, Field, filterControl, inputClass, Notice, Panel, primaryClass, secondaryClass, SkeletonRows } from "@/components/studio/primitives";
import { MarkdownBody } from "@/components/studio/knowledge-markdown";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
const TEXT_MAX = 200_000;
const errorText = (cause: unknown, fallback: string) => describeError(cause, fallback);
const day = (iso: string) => new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
const words = (characters: number) => Math.max(1, Math.round(characters / 6)).toLocaleString();
/** A file's first top-level heading, or else its name ("voice_and_rules.md" → "Voice and rules"). */
const fileTitle = (name: string, text = "") => {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (heading) return heading.slice(0, 200);
  const plain = name.replace(/\.(md|markdown|txt)$/i, "").replace(/[_-]+/g, " ").trim();
  return plain ? `${plain[0]!.toUpperCase()}${plain.slice(1)}`.slice(0, 200) : "Untitled";
};

/** YAML front matter at the top of a skill file (name and description, as in Claude skill files), and the text after it. */
function frontMatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  // A horizontal rule at the top isn't front matter: the block must start with a "key: value" line.
  if (!match || !/^[A-Za-z_-]+:/.test(match[1]!)) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const found = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[index]!);
    if (!found) continue;
    let value = found[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      // A block value: the indented lines below it, folded into one line (">") or kept as lines ("|").
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]!) || !lines[index + 1]!.trim())) block.push(lines[++index]!.trim());
      value = block.filter(Boolean).join(value.startsWith(">") ? " " : "\n");
    }
    fields[found[1]!.toLowerCase()] = value.replace(/^["']|["']$/g, "");
  }
  return { fields, body: text.slice(match[0].length) };
}

function MarkdownEditor({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  return <div>
    <div className="mb-1.5 flex items-center justify-between gap-3"><span className="text-xs font-semibold text-neutral-600">{label}</span><SlidingTabs fitContent label={`${label} view`} className="!p-0.5 bg-neutral-100 shadow-none" active={mode} onChange={(key) => setMode(key as "write" | "preview")} tabs={[{ key: "write", label: "Write" }, { key: "preview", label: "Preview" }]} /></div>
    {mode === "write"
      ? <textarea aria-label={label} required maxLength={TEXT_MAX} value={value} onChange={(event) => onChange(event.target.value)} className={`${inputClass} min-h-[45vh] py-3 font-mono text-[13px] leading-6`} placeholder={"# Heading\n\nWrite in Markdown…"} />
      : <div className="min-h-[45vh] rounded-xl border border-neutral-200 p-4 text-sm">{value.trim() ? <MarkdownBody markdown={value} view="rendered" /> : <p className="text-neutral-400">Nothing to preview yet.</p>}</div>}
    <p className="mt-1 text-[11px] text-neutral-400 tabular-nums">{value.length.toLocaleString()} / {TEXT_MAX.toLocaleString()} characters</p>
  </div>;
}

/** Remove asks twice: the second click within a few seconds confirms. */
function RemoveButton({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(false), 4000); return () => window.clearTimeout(timer); }, [armed]);
  return <button type="button" disabled={busy} onClick={() => { if (armed) onConfirm(); else setArmed(true); }} className={clsx(secondaryClass, armed && "!border-red-200 !bg-red-50 !text-red-700")}>{armed ? "Click again to remove" : "Remove"}</button>;
}

const readFiles = (files: FileList) => Promise.all(Array.from(files).map(async (file) => ({ name: file.name, text: await file.text(), size: file.size })));

const WORKSPACE = "workspace";

/**
 * Context Claude reads in full before working on a venture: the workspace's files (read first, for every venture) and
 * each venture's own. Shows one at a time; a venture's view also lists the workspace files it starts with. Admins and
 * the venture's head edit a venture's; admins and people who share knowledge with every venture edit the workspace's.
 */
export function VentureContextPanel({ session, ventureId: scope, nameOf }: { session: Session; ventureId: string; nameOf: (id: string) => string }) {
  const ventures = session.hierarchy.ventures;
  const [choice, setChoice] = useState({ value: "", scope });
  const chosen = choice.scope === scope ? choice.value : "";
  // With the venture switcher on one venture, it's that venture or the workspace; otherwise any venture, or the workspace.
  const choices = scope ? ventures.filter((item) => item.id === scope) : ventures;
  const target = chosen === WORKSPACE ? WORKSPACE : scope || (ventures.some((item) => item.id === chosen) ? chosen : ventures[0]?.id ?? WORKSPACE);
  const isWorkspace = target === WORKSPACE;
  const venture = isWorkspace ? undefined : ventures.find((item) => item.id === target);
  const [data, setData] = useState<{ key: string; items: VentureContext[]; canEdit: boolean; canEditWorkspace: boolean; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<VentureContext | null>(null);
  const [editing, setEditing] = useState<{ id?: string; workspace: boolean; title: string; markdown: string; original: string } | null>(null);
  const [busy, setBusy] = useState("");
  const uploader = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    const load = isWorkspace ? listLiveWorkspaceContext().then((page) => ({ items: page.items, canEdit: page.canEdit, canEditWorkspace: page.canEdit })) : listLiveVentureContext(target).then((page) => ({ items: page.items, canEdit: page.canEdit, canEditWorkspace: Boolean(page.canEditWorkspace) }));
    queueMicrotask(() => load.then((page) => { if (active) setData({ key: target, ...page, error: "" }); })
      .catch((cause: unknown) => { if (active) setData({ key: target, items: [], canEdit: false, canEditWorkspace: false, error: errorText(cause, isWorkspace ? "Couldn't load the workspace context." : "Couldn't load this venture's context.") }); }));
    return () => { active = false; };
  }, [target, isWorkspace, revision]);
  const current = data?.key === target ? data : null;
  // A venture's list starts with the workspace's files; they're shown apart, since they're edited in one place for all.
  const inherited = isWorkspace ? [] : current?.items.filter((item) => !item.ventureId) ?? [];
  const own = isWorkspace ? current?.items ?? [] : current?.items.filter((item) => item.ventureId) ?? [];
  const total = (current?.items ?? []).reduce((sum, item) => sum + item.characters, 0);
  const canEditItem = (item: VentureContext) => Boolean(current && (item.ventureId ? current.canEdit : current.canEditWorkspace));
  const contextLabel = (item: { ventureId?: string }) => item.ventureId ? `${ventures.find((entry) => entry.id === item.ventureId)?.name ?? "Venture"} context` : "Workspace context · read first for every venture";

  async function openItem(item: VentureContext) {
    setBusy(`open:${item.id}`); setError("");
    try { setOpen(await getLiveVentureContext(item.id)); }
    catch (cause) { setError(errorText(cause, "Couldn't open this file.")); }
    finally { setBusy(""); }
  }
  const createIn = (workspace: boolean, input: { title: string; markdown: string }) => workspace ? createLiveWorkspaceContext(input) : createLiveVentureContext(target, input);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy("save"); setError("");
    try {
      const saved = editing.id ? await updateLiveVentureContext(editing.id, { title: editing.title, markdown: editing.markdown }) : await createIn(editing.workspace, { title: editing.title, markdown: editing.markdown });
      setEditing(null); setOpen(saved); setRevision((value) => value + 1);
      setResult(editing.id ? "Saved. Claude reads the new version from now on." : editing.workspace ? "Added. Claude reads it first, for every venture." : "Added. Claude reads it with the rest of this venture's context.");
    } catch (cause) { setError(errorText(cause, "Couldn't save this file.")); }
    finally { setBusy(""); }
  }
  async function remove(item: VentureContext) {
    setBusy("remove"); setError("");
    try { await deleteLiveVentureContext(item.id); setOpen(null); setRevision((value) => value + 1); setResult(`Removed "${item.title}".`); }
    catch (cause) { setError(errorText(cause, "Couldn't remove this file.")); }
    finally { setBusy(""); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy("upload"); setError(""); setResult("");
    let added = 0;
    let current = "";
    try {
      const chosenFiles = (await readFiles(files)).filter((file) => file.text.trim());
      const tooLong = chosenFiles.find((file) => file.text.length > TEXT_MAX);
      if (tooLong) throw new Error(`${tooLong.name} is longer than ${TEXT_MAX.toLocaleString()} characters; split it into smaller files. Nothing was added.`);
      for (const file of chosenFiles) {
        current = file.name;
        await createIn(isWorkspace, { title: fileTitle(file.name, file.text), markdown: file.text });
        added += 1;
      }
      setResult(added ? `Added ${added} file${added === 1 ? "" : "s"} to ${isWorkspace ? "the workspace context, read first for every venture" : `${venture?.name ?? "this venture"}'s context`}.` : "Those files were empty.");
    } catch (cause) { setError(`${current ? `${current}: ` : ""}${errorText(cause, "Couldn't add those files.")}`); if (added) setResult(`Added ${added} file${added === 1 ? "" : "s"} before the problem.`); }
    finally { setBusy(""); setRevision((value) => value + 1); }
  }

  const card = (item: VentureContext, shared = false) => <li key={item.id}><button type="button" onClick={() => void openItem(item)} disabled={busy === `open:${item.id}`} className={clsx("flex h-full w-full items-start gap-3 rounded-xl border p-4 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]", shared ? "border-dashed border-neutral-200 bg-neutral-50/60 hover:border-primary-200" : "border-neutral-100 bg-white hover:border-primary-200 hover:bg-primary-50/30")}>
    <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-lg", shared ? "bg-neutral-100 text-neutral-500" : "bg-primary-50 text-primary-700")}><FileText size={17} /></span>
    <span className="min-w-0"><span className="block truncate text-sm font-semibold text-neutral-900">{item.title}</span><span className="mt-0.5 block text-xs text-neutral-500">About {words(item.characters)} words · updated {day(item.updatedAt)} by {nameOf(item.updatedBy)}</span></span>
  </button></li>;

  return <>
    <Panel className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h2 className="text-sm font-bold text-neutral-900">{isWorkspace ? "Workspace context" : "Venture context"}</h2>
          <p className="mt-1 text-xs leading-5 text-neutral-500">{isWorkspace
            ? "What holds for every venture: how the studio works, shared rules, and voice. Claude reads these first, before any venture's own files."
            : <>What {venture?.name ?? "this venture"} is, its goals, customers, rules, voice, and current priorities. Claude asks which venture you&apos;re working on, then reads all of this before doing anything.</>}</p>
        </div>
        {current?.canEdit && <div className="flex flex-wrap gap-2">
          <input ref={uploader} type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { void upload(event.target.files); event.target.value = ""; }} />
          <button type="button" disabled={!!busy} onClick={() => uploader.current?.click()} className={secondaryClass}><Upload size={15} /><ActionLabel busy={busy === "upload"} busyText="Adding…" idle="Upload .md files" /></button>
          <button type="button" disabled={!!busy} onClick={() => setEditing({ workspace: isWorkspace, title: "", markdown: "", original: "" })} className={primaryClass}><Plus size={15} />New file</button>
        </div>}
      </div>
      <div className="mb-4 max-w-xs"><Field label="Context for"><Select className={inputClass} value={target} onChange={(event) => setChoice({ value: event.target.value, scope })}>
        <option value={WORKSPACE}>Workspace (every venture)</option>
        {choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </Select></Field></div>
      <Notice tone="error" message={error || current?.error || ""} onDismiss={() => setError("")} className="pb-4" />
      <Notice tone="success" message={result} onDismiss={() => setResult("")} autoDismissMs={6000} className="pb-4" />
      {!current ? <SkeletonRows rows={3} label="Loading context" className="!p-0" /> : <>
        {inherited.length > 0 && <div className="mb-5">
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[.12em] text-neutral-400">From the workspace <span className="font-semibold normal-case tracking-normal">· read first, for every venture</span></h3>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{inherited.map((item) => card(item, true))}</ul>
          {own.length > 0 && <h3 className="mb-2 mt-5 text-[11px] font-bold uppercase tracking-[.12em] text-neutral-400">{venture?.name ?? "This venture"}&apos;s own</h3>}
        </div>}
        {!own.length ? !current.error && <EmptyState variant="compact" icon={BookOpenText}
            title={isWorkspace ? "No workspace context yet" : inherited.length ? `Nothing just for ${venture?.name ?? "this venture"} yet` : "No context yet"}
            body={current.canEdit ? (isWorkspace ? "Write the first file, or upload Markdown files you already have. Every venture's context starts with these." : "Write the first file, or upload Markdown files you already have.") : isWorkspace ? "Admins and people who share knowledge with every venture add it." : "Admins and this venture's head add it."} />
          : <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{own.map((item) => card(item))}</ul>}
        {current.items.length > 0 && <p className="mt-4 text-xs text-neutral-500">{current.items.length} file{current.items.length === 1 ? "" : "s"}{inherited.length ? `, ${inherited.length} from the workspace` : ""} · about {words(total)} words Claude reads before starting{isWorkspace ? " on any venture" : ""}.</p>}
      </>}
    </Panel>
    {open && !editing && <DetailDrawer title={open.title} subtitle={`${contextLabel(open)} · updated ${day(open.updatedAt)} by ${nameOf(open.updatedBy)}`} onClose={() => setOpen(null)}>
      <div className="text-sm"><MarkdownBody markdown={open.markdown ?? ""} view="rendered" /></div>
      {canEditItem(open) && <div className="mt-6 flex flex-wrap gap-2 border-t border-neutral-100 pt-4"><button type="button" onClick={() => setEditing({ id: open.id, workspace: !open.ventureId, title: open.title, markdown: open.markdown ?? "", original: `${open.title}\n${open.markdown ?? ""}` })} className={primaryClass}><Edit size={15} />Edit</button><RemoveButton busy={busy === "remove"} onConfirm={() => void remove(open)} /></div>}
    </DetailDrawer>}
    {editing && <DetailDrawer title={editing.id ? "Edit context file" : "New context file"} subtitle={editing.workspace ? "Workspace context · read first for every venture" : `${venture?.name ?? "Venture"} context`} dirty={`${editing.title}\n${editing.markdown}` !== editing.original && busy !== "save"} onClose={() => setEditing(null)}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Title"><input required maxLength={200} value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} className={inputClass} placeholder={editing.workspace ? "For example: How the studio works" : "For example: Customers and pricing"} /></Field>
        <MarkdownEditor label="Text" value={editing.markdown} onChange={(markdown) => setEditing({ ...editing, markdown })} />
        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        <div className="flex flex-wrap gap-2"><button disabled={busy === "save"} className={primaryClass}><ActionLabel busy={busy === "save"} idle={editing.id ? "Save" : "Add to context"} /></button><button type="button" onClick={() => setEditing(null)} className={secondaryClass}>Cancel</button></div>
      </form>
    </DetailDrawer>}
  </>;
}

type SkillDraft = { id?: string; title: string; description: string; markdown: string; scope: string; original: string };

/** Skills: instructions for particular kinds of work. Workspace skills reach every venture; a venture's own only that venture. */
export function SkillsPanel({ session, ventureId: scope, nameOf, initialSkillId }: { session: Session; ventureId: string; nameOf: (id: string) => string; initialSkillId?: string }) {
  const ventures = session.hierarchy.ventures;
  const role = session.membership.role;
  // Mirrors the API: workspace skills need the share-with-all-ventures permission; a venture's need its lead.
  const sharer = role === "admin" || ((role === "venture_head" || role === "contributor") && session.membership.canShareKnowledge === true);
  const leads = (id: string) => role === "admin" || (role === "venture_head" && session.membership.ventureIds.includes(id));
  const writable = [...(sharer ? [{ value: "", label: "Every venture" }] : []), ...ventures.filter((venture) => leads(venture.id)).map((venture) => ({ value: venture.id, label: venture.name }))];
  const canCreate = scope ? leads(scope) : writable.length > 0;
  const ventureName = (id?: string) => id ? ventures.find((venture) => venture.id === id)?.name ?? "One venture" : "Every venture";
  const [items, setItems] = useState<{ key: string; list: Skill[]; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<Skill | null>(null);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [mode, setMode] = useState<"write" | "upload">("write");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const uploader = useRef<HTMLInputElement>(null);
  const deepLinked = useRef(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => listLiveSkills(scope || undefined).then((list) => { if (active) setItems({ key: scope, list, error: "" }); })
      .catch((cause: unknown) => { if (active) setItems({ key: scope, list: [], error: errorText(cause, "Couldn't load skills.") }); }));
    return () => { active = false; };
  }, [scope, revision]);
  useEffect(() => {
    if (!initialSkillId || deepLinked.current) return;
    deepLinked.current = true;
    queueMicrotask(() => getLiveSkill(initialSkillId).then(setOpen).catch((cause: unknown) => setError(errorText(cause, "Couldn't open that skill."))));
  }, [initialSkillId]);
  const current = items?.key === scope ? items : null;
  const shown = (current?.list ?? []).filter((skill) => scope || filter === "all" || (filter === "workspace" ? !skill.ventureId : skill.ventureId === filter));
  // In a venture's space a new skill belongs to it (shown, not chosen); it can be moved later.
  const newDraft = (): SkillDraft => ({ title: "", description: "", markdown: "", scope: scope || (writable[0]?.value ?? ""), original: "" });

  async function openSkill(skill: Skill) {
    setBusy(`open:${skill.id}`); setError("");
    try { setOpen(await getLiveSkill(skill.id)); }
    catch (cause) { setError(errorText(cause, "Couldn't open this skill.")); }
    finally { setBusy(""); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy("save"); setError("");
    try {
      const saved = draft.id
        ? await updateLiveSkill(draft.id, { title: draft.title, description: draft.description, markdown: draft.markdown, ventureId: draft.scope || null })
        : await createLiveSkill({ title: draft.title, description: draft.description, markdown: draft.markdown, ...(draft.scope ? { ventureId: draft.scope } : {}) });
      setDraft(null); setOpen(saved); setRevision((value) => value + 1);
      setResult(draft.id ? "Saved." : `Added "${saved.title}" for ${ventureName(saved.ventureId).toLowerCase() === "every venture" ? "every venture" : ventureName(saved.ventureId)}.`);
    } catch (cause) { setError(errorText(cause, "Couldn't save this skill.")); }
    finally { setBusy(""); }
  }
  async function uploadSkills(files: FileList | null) {
    if (!files?.length || !draft) return;
    setBusy("upload"); setError("");
    let added = 0;
    let current = "";
    try {
      const chosen = (await readFiles(files)).map((file) => ({ ...file, ...frontMatter(file.text) })).filter((file) => file.body.trim());
      const tooLong = chosen.find((file) => file.body.length > TEXT_MAX);
      if (tooLong) throw new Error(`${tooLong.name} is longer than ${TEXT_MAX.toLocaleString()} characters. Nothing was added.`);
      for (const { fields, body, ...file } of chosen) {
        current = file.name;
        const title = (fields.name || fileTitle(file.name, body)).slice(0, 200);
        // Claude skill files carry a description; otherwise the first plain line says what it's for.
        const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
        const description = (fields.description || firstLine || `Instructions for ${title}`).slice(0, 500);
        await createLiveSkill({ title, description, markdown: body, ...(draft.scope ? { ventureId: draft.scope } : {}) });
        added += 1;
      }
      setDraft(null); setResult(added ? `Added ${added} skill${added === 1 ? "" : "s"} for ${ventureName(draft.scope || undefined) === "Every venture" ? "every venture" : ventureName(draft.scope)}.` : "Those files were empty.");
    } catch (cause) { setError(`${current ? `${current}: ` : ""}${errorText(cause, "Couldn't add those skills.")}`); if (added) setResult(`Added ${added} skill${added === 1 ? "" : "s"} before the problem.`); }
    finally { setBusy(""); setRevision((value) => value + 1); }
  }
  async function remove(skill: Skill) {
    setBusy("remove"); setError("");
    try { await deleteLiveSkill(skill.id); setOpen(null); setRevision((value) => value + 1); setResult(`Removed "${skill.title}".`); }
    catch (cause) { setError(errorText(cause, "Couldn't remove this skill.")); }
    finally { setBusy(""); }
  }

  const scopeField = (value: string, onChange: (value: string) => void, editingId?: string) => {
    // A new skill in a venture's space stays in that venture; moving it is done afterwards, from Edit.
    if (!editingId && scope) return <p className="rounded-xl bg-neutral-50 p-3 text-sm"><span className="block text-xs font-semibold text-neutral-500">Used by</span><span className="font-bold text-neutral-800">{ventureName(value || undefined)}</span></p>;
    return <Field label="Used by"><Select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>{writable.map((option) => <option key={option.value || "workspace"} value={option.value}>{option.label}</option>)}</Select></Field>;
  };

  return <>
    <Panel className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl"><h2 className="text-sm font-bold text-neutral-900">Skills</h2><p className="mt-1 text-xs leading-5 text-neutral-500">Instructions Claude follows for particular kinds of work, like writing a sales email or reviewing a pitch. Workspace skills reach every venture; a venture&apos;s own only that venture.</p></div>
        {canCreate && <button type="button" onClick={() => { setMode("write"); setDraft(newDraft()); }} className={primaryClass}><Plus size={15} />Add skills</button>}
      </div>
      {!scope && <div role="group" aria-label="Show skills for" className="mb-4 flex flex-wrap gap-2">{[{ key: "all", label: "All" }, { key: "workspace", label: "Every venture" }, ...ventures.map((venture) => ({ key: venture.id, label: venture.name }))].map((option) => <button key={option.key} type="button" aria-pressed={filter === option.key} onClick={() => setFilter(option.key)} className={filterControl(filter === option.key)}>{option.label}</button>)}</div>}
      <Notice tone="error" message={error || current?.error || ""} onDismiss={() => setError("")} className="pb-4" />
      <Notice tone="success" message={result} onDismiss={() => setResult("")} autoDismissMs={6000} className="pb-4" />
      {!current ? <SkeletonRows rows={3} label="Loading skills" className="!p-0" />
        : !shown.length ? !current.error && <EmptyState variant="compact" icon={Sparkles} title={current.list.length ? "No skills here" : "No skills yet"} body={canCreate ? "Write one, or upload skill files (.md) you already have." : "Admins and venture heads add them."} />
        : <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{shown.map((skill) => <li key={skill.id}><button type="button" onClick={() => void openSkill(skill)} disabled={busy === `open:${skill.id}`} className="flex h-full w-full flex-col rounded-xl border border-neutral-100 bg-white p-4 text-left transition-[border-color,background-color,transform] duration-150 hover:border-primary-200 hover:bg-primary-50/40 active:scale-[0.99]">
            <span className="flex items-start justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><Sparkles size={15} className="shrink-0 text-primary-600" /><span className="truncate text-sm font-semibold text-neutral-900">{skill.title}</span></span><Badge tone={skill.ventureId ? "blue" : "green"}>{ventureName(skill.ventureId)}</Badge></span>
            <span className="mt-2 line-clamp-2 text-xs leading-5 text-neutral-600">{skill.description}</span>
            <span className="mt-auto pt-2 text-[11px] text-neutral-400">About {words(skill.characters)} words · updated {day(skill.updatedAt)}</span>
          </button></li>)}</ul>}
    </Panel>
    {open && !draft && <DetailDrawer title={open.title} subtitle={`${ventureName(open.ventureId)} · updated ${day(open.updatedAt)} by ${nameOf(open.updatedBy)}`} onClose={() => setOpen(null)}>
      <p className="mb-4 rounded-xl bg-neutral-50 p-3 text-sm text-neutral-700"><span className="block text-xs font-semibold text-neutral-500">Use it when</span>{open.description}</p>
      <div className="text-sm"><MarkdownBody markdown={open.markdown ?? ""} view="rendered" /></div>
      {open.canEdit && <div className="mt-6 flex flex-wrap gap-2 border-t border-neutral-100 pt-4"><button type="button" onClick={() => { setMode("write"); setDraft({ id: open.id, title: open.title, description: open.description, markdown: open.markdown ?? "", scope: open.ventureId ?? "", original: [open.title, open.description, open.markdown, open.ventureId ?? ""].join("\n") }); }} className={primaryClass}><Edit size={15} />Edit</button><RemoveButton busy={busy === "remove"} onConfirm={() => void remove(open)} /></div>}
    </DetailDrawer>}
    {draft && <DetailDrawer title={draft.id ? "Edit skill" : "Add skills"} subtitle={draft.id ? ventureName(open?.ventureId) : "Write one, or upload Markdown skill files"} dirty={[draft.title, draft.description, draft.markdown, draft.scope].join("\n") !== draft.original && !!(draft.title || draft.markdown) && busy !== "save"} onClose={() => setDraft(null)}>
      {!draft.id && <SlidingTabs fitContent label="How to add" className="mb-4 bg-neutral-100 shadow-none" active={mode} onChange={(key) => setMode(key as "write" | "upload")} tabs={[{ key: "write", label: "Write one" }, { key: "upload", label: "Upload files" }]} />}
      {mode === "upload" && !draft.id ? <div className="space-y-4">
        {scopeField(draft.scope, (value) => setDraft({ ...draft, scope: value }))}
        <p className="text-xs leading-5 text-neutral-500">Choose one or more <code>.md</code> files. A Claude skill file&apos;s name and description (the <code>---</code> block at the top) become the skill&apos;s title and when-to-use line; otherwise the file name and its first line are used.</p>
        <input ref={uploader} type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { void uploadSkills(event.target.files); event.target.value = ""; }} />
        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        <button type="button" disabled={busy === "upload"} onClick={() => uploader.current?.click()} className={primaryClass}><Upload size={15} /><ActionLabel busy={busy === "upload"} busyText="Adding…" idle="Choose skill files" /></button>
      </div> : <form onSubmit={save} className="space-y-4">
        <Field label="Title"><input required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className={inputClass} placeholder="For example: Write a sales email" /></Field>
        <Field label="Use it when"><input required maxLength={500} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className={inputClass} placeholder="Someone asks for a first email to a new lead" /></Field>
        {scopeField(draft.scope, (value) => setDraft({ ...draft, scope: value }), draft.id)}
        <MarkdownEditor label="Instructions" value={draft.markdown} onChange={(markdown) => setDraft({ ...draft, markdown })} />
        <Notice tone="error" message={error} onDismiss={() => setError("")} />
        <div className="flex flex-wrap gap-2"><button disabled={busy === "save"} className={primaryClass}><ActionLabel busy={busy === "save"} idle={draft.id ? "Save" : "Add skill"} /></button><button type="button" onClick={() => setDraft(null)} className={secondaryClass}>Cancel</button></div>
      </form>}
    </DetailDrawer>}
  </>;
}
