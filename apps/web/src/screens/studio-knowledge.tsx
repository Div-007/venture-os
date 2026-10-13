"use client";

import { Select } from "@/components/ui/select";
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Copy, Download, FilePlus2, FileText, Search } from "@/components/ui/icons";
import { KnowledgeDocumentTile } from "@/components/studio/knowledge-document-tile";
import { KnowledgeFileIcon } from "@/components/studio/knowledge-file-icon";
import { KnowledgeUploadDialog } from "@/components/studio/knowledge-upload-dialog";
import clsx from "clsx";
import { useStudio } from "@/lib/studio-store";
import { displayDate, personName, type Knowledge, ventureName } from "@/lib/studio-demo";
import { Badge, DetailDrawer, Empty, Field, inputClass, PageFrame, PageTitle, Panel, PanelHead, primaryClass, secondaryClass } from "@/components/studio/primitives";

const evidenceClasses: Knowledge["evidenceClass"][] = ["Verified fact", "Founder-reported", "Approved decision", "Planning assumption", "Hypothesis", "Open question", "Historical"];
const makeDoc = (ventureId: string, ownerId: string): Knowledge => ({ id: `doc-${Date.now()}`, ventureId, title: "", body: "# New note\n\n", ownerId, evidenceClass: "Planning assumption", sensitivity: "Team", source: "", version: 1, reviewedAt: new Date().toISOString().slice(0, 10), tags: [], relatedIds: [], history: [] });
const download = (filename: string, content: string) => { const href = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = href; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); };
type DemoFile = { id: string; name: string; ventureId: string; contentType: string; size: number; createdAt: string; url: string };

function DemoFileReader({ file, venture, onBack }: { file: DemoFile; venture: string; onBack: () => void }) {
  const preview = file.contentType === "application/pdf" || file.contentType.startsWith("text/") ? <iframe src={file.url} title={`Preview of ${file.name}`} className="h-[min(70vh,800px)] w-full rounded-xl border border-neutral-200 bg-white" />
    : file.contentType.startsWith("image/") ? <Image src={file.url} alt={file.name} width={1200} height={900} unoptimized className="mx-auto max-h-[70vh] w-auto max-w-full rounded-xl object-contain" />
    : file.contentType.startsWith("video/") ? <video src={file.url} controls className="max-h-[70vh] w-full rounded-xl bg-black" />
    : file.contentType.startsWith("audio/") ? <audio src={file.url} controls className="w-full" />
    : <p className="text-sm text-neutral-500">A browser preview is not available for this file type. You can download it below.</p>;
  return <Panel className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3"><button type="button" onClick={onBack} className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-50"><ArrowLeft size={17} />Back to library</button><a href={file.url} download={file.name} className={secondaryClass}><Download size={15} />Download</a></div><article className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-9 sm:py-10"><div className="mb-4 flex h-20 w-20 items-center justify-center"><KnowledgeFileIcon name={file.name} contentType={file.contentType} className="max-h-20 max-w-20" /></div><h2 className="break-words text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">{file.name}</h2><p className="mt-2 text-sm text-neutral-500">{venture} · {(file.size / 1024).toFixed(1)} KB · Demo file in this browser tab</p><div className="mt-7">{preview}</div></article></Panel>;
}

function DocEditor({ doc, fresh, onClose }: { doc: Knowledge; fresh: boolean; onClose: () => void }) {
  const { data, updateSection, activeVentureId } = useStudio();
  const [draft, setDraft] = useState(doc);
  const [error, setError] = useState("");
  const set = <K extends keyof Knowledge>(key: K, value: Knowledge[K]) => setDraft((item) => ({ ...item, [key]: value }));
  const save = () => {
    if (!draft.title.trim() || !draft.body.trim() || !draft.source.trim()) { setError("Add a title, Markdown body, and source before saving."); return; }
    const updated: Knowledge = fresh ? draft : { ...draft, version: doc.version + 1, history: [...(doc.history ?? []), { version: doc.version, body: doc.body, editedAt: new Date().toISOString() }] };
    updateSection("knowledge", (items) => fresh ? [updated, ...items] : items.map((item) => item.id === updated.id ? updated : item));
    onClose();
  };
  return <DetailDrawer title={fresh ? "New knowledge record" : draft.title} subtitle="Markdown source · evidence metadata" onClose={onClose}><div className="grid gap-4 sm:grid-cols-2"><div className="sm:col-span-2"><Field label="Title"><input className={inputClass} value={draft.title} onChange={(event) => set("title", event.target.value)} placeholder="Descriptive record title" /></Field></div>{activeVentureId && fresh ? <div aria-label="Record destination" className="rounded-xl bg-neutral-50 p-3 text-sm"><span className="block text-xs text-neutral-500">Venture</span><span className="font-semibold">{data.ventures.find((venture) => venture.id === activeVentureId)?.name}</span></div> : <Field label="Venture"><Select className={inputClass} value={draft.ventureId} onChange={(event) => set("ventureId", event.target.value)}>{data.ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}<Field label="Owner"><Select className={inputClass} value={draft.ownerId} onChange={(event) => set("ownerId", event.target.value)}>{data.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Select></Field><Field label="Evidence class"><Select className={inputClass} value={draft.evidenceClass} onChange={(event) => set("evidenceClass", event.target.value as Knowledge["evidenceClass"])}>{evidenceClasses.map((item) => <option key={item}>{item}</option>)}</Select></Field><Field label="Sensitivity"><Select className={inputClass} value={draft.sensitivity} onChange={(event) => set("sensitivity", event.target.value as Knowledge["sensitivity"])}><option>Team</option><option>Venture head</option><option>Founder private</option></Select></Field><div className="sm:col-span-2"><Field label="Source / path"><input className={inputClass} value={draft.source} onChange={(event) => set("source", event.target.value)} placeholder="Source record, document path, or interview" /></Field></div><div className="sm:col-span-2"><Field label="Markdown content"><textarea className={clsx(inputClass, "min-h-64 py-3 font-mono text-sm")} value={draft.body} onChange={(event) => set("body", event.target.value)} /></Field></div><Field label="Tags"><input className={inputClass} value={draft.tags.join(", ")} onChange={(event) => set("tags", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></Field><Field label="Related task / decision IDs"><input className={inputClass} value={draft.relatedIds.join(", ")} onChange={(event) => set("relatedIds", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></Field>{error && <p role="alert" className="sm:col-span-2 rounded-xl bg-danger-surface p-3 text-sm font-semibold text-danger-text">{error}</p>}<div className="sm:col-span-2 flex justify-end gap-2 border-t border-neutral-100 pt-4"><button type="button" onClick={onClose} className={secondaryClass}>Cancel</button><button type="button" onClick={save} className={primaryClass}>Save record</button></div></div></DetailDrawer>;
}

export function KnowledgeScreen() {
  const { data, currentUserId, ready, updateSection, activeVentureId: venture } = useStudio();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [view, setView] = useState<"library" | "search">("library");
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selected, setSelected] = useState<Knowledge | null>(null);
  const [selectedFile, setSelectedFile] = useState<DemoFile | null>(null);
  const [files, setFiles] = useState<DemoFile[]>([]);
  const fileUrls = useRef<string[]>([]);
  const [uploadMode, setUploadMode] = useState<"markdown" | "file" | null>(null);
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [packetMode, setPacketMode] = useState(false);
  const [included, setIncluded] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const person = data.people.find((item) => item.id === currentUserId);
  const accessible = useMemo(() => data.knowledge.filter((doc) => person?.ventureIds.includes(doc.ventureId) && (doc.sensitivity === "Team" || currentUserId === "divyansh" || (doc.sensitivity === "Venture head" && person.role.includes("Venture head")))), [data.knowledge, person, currentUserId]);
  useEffect(() => () => { fileUrls.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  useEffect(() => {
    const id = params.get("doc");
    if (!id) return;
    const found = accessible.find((item) => item.id === id);
    if (found) queueMicrotask(() => { setSelected(found); setView("library"); });
  }, [params, accessible]);

  const docs = accessible.filter((doc) => !venture || doc.ventureId === venture);
  const visibleFiles = files.filter((file) => !venture || file.ventureId === venture);
  const library = [
    ...docs.map((item) => ({ kind: "document" as const, item, date: item.reviewedAt })),
    ...visibleFiles.map((item) => ({ kind: "file" as const, item, date: item.createdAt })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const hits = submittedQuery ? docs.filter((doc) => `${doc.title} ${doc.body} ${doc.tags.join(" ")}`.toLowerCase().includes(submittedQuery.toLowerCase())) : [];
  const packet = accessible.filter((doc) => included.includes(doc.id)).map((doc) => `## ${doc.title}\nRecord: ${doc.id} · ${ventureName(data, doc.ventureId)}\nEvidence: ${doc.evidenceClass} · Sensitivity: ${doc.sensitivity}\nSource: ${doc.source} · Version: ${doc.version} · Reviewed: ${doc.reviewedAt}\n\n${doc.body}`).join("\n\n---\n\n");
  const closeDocument = () => { setSelected(null); setSelectedFile(null); if (params.get("doc")) router.replace(pathname); };

  async function addMarkdown(file: File, markdown: string, ventureId: string) {
    if (!ventureId) throw new Error("Choose a venture for this demo record.");
    const record: Knowledge = { ...makeDoc(ventureId, currentUserId), id: `doc-${crypto.randomUUID()}`, title: file.name.replace(/\.(md|markdown|txt)$/i, ""), body: markdown, source: file.name };
    updateSection("knowledge", (items) => [record, ...items]);
  }

  async function addFile(file: File, ventureId: string, progress: (percent: number, phase: "uploading" | "finalizing") => void) {
    if (!ventureId) throw new Error("Choose a venture for this demo file.");
    await file.arrayBuffer();
    progress(95, "finalizing");
    const url = URL.createObjectURL(file);
    fileUrls.current.push(url);
    setFiles((items) => [{ id: crypto.randomUUID(), name: file.name, ventureId, contentType: file.type, size: file.size, createdAt: new Date().toISOString(), url }, ...items]);
  }

  return <PageFrame>
    <PageTitle title="Knowledge" description="Browse records and files in one library." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setSelected(makeDoc(venture || data.ventures[0]?.id || "", currentUserId)); setFresh(true); setEditing(true); }} className={primaryClass}><FilePlus2 size={16} />New record</button><button type="button" onClick={() => setUploadMode("file")} className={secondaryClass}>Upload file</button></div>} />
    {selectedFile ? <DemoFileReader file={selectedFile} venture={ventureName(data, selectedFile.ventureId)} onBack={() => setSelectedFile(null)} /> : selected ? <Panel className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3"><button type="button" onClick={closeDocument} className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-50"><ArrowLeft size={17} />Back to library</button><button type="button" onClick={() => { setFresh(false); setEditing(true); }} className={secondaryClass}>Edit record</button></div><article className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-9 sm:py-10"><div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary-50 text-primary-700"><FileText size={24} /></div><h2 className="break-words text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">{selected.title}</h2><p className="mt-2 text-sm text-neutral-500">{ventureName(data, selected.ventureId)} · Version {selected.version} · Reviewed {displayDate(selected.reviewedAt)}</p><div className="mt-4 flex flex-wrap gap-2"><Badge tone="purple">{selected.evidenceClass}</Badge><Badge>{selected.sensitivity}</Badge></div><div className="mt-8 border-t border-neutral-100 pt-7"><p className="mb-4 text-xs font-semibold uppercase tracking-wider text-neutral-400">Markdown document</p><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-neutral-700 sm:text-[15px]">{selected.body}</pre></div><div className="mt-8 border-t border-neutral-100 pt-5 text-xs leading-6 text-neutral-500"><p>Owner: {personName(data, selected.ownerId)}</p><p>Source: {selected.source}</p><p>Related records: {selected.relatedIds.join(", ") || "None linked"}</p><button type="button" onClick={() => download(`${selected.id}.md`, selected.body)} className={`${secondaryClass} mt-4`}><Download size={15} />Export Markdown</button>{selected.history?.length ? <div className="mt-5"><p className="font-semibold text-neutral-700">Version history</p>{selected.history.map((version) => <p key={version.version}>v{version.version} · {new Date(version.editedAt).toLocaleString("en-IN")}</p>)}</div> : null}</div></article></Panel> : <>
      <div role="tablist" aria-label="Knowledge sections" className="mb-4 flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-1">{(["library", "search"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => setView(item)} className={clsx("min-h-9 rounded-lg px-4 text-sm font-semibold transition-colors", view === item ? "bg-primary-700 text-white" : "text-neutral-600 hover:bg-neutral-100")}>{item === "search" ? "Evidence search" : "Library"}</button>)}</div>
      {view === "library" && <><div className="mb-4 flex justify-end"><button type="button" onClick={() => { setPacketMode((value) => !value); setIncluded([]); setCopied(false); }} className={secondaryClass}>{packetMode ? "Done selecting" : "Create context packet"}</button></div>{packetMode && <Panel className="mb-4 flex flex-wrap items-center justify-between gap-3 border-primary-200 bg-primary-50 p-4"><p className="text-sm text-neutral-700"><span className="font-semibold">{included.length} record{included.length === 1 ? "" : "s"} selected.</span> Choose thumbnails, then copy or export.</p><div className="flex gap-2"><button type="button" disabled={!packet} onClick={async () => { await navigator.clipboard.writeText(packet); setCopied(true); }} className={secondaryClass}><Copy size={15} />{copied ? "Copied" : "Copy packet"}</button><button type="button" disabled={!packet} onClick={() => download("studio-context-packet.md", packet)} className={secondaryClass}><Download size={15} />Export</button></div></Panel>}<Panel className="p-4 sm:p-5"><div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-neutral-900">Library</h2><span className="text-xs text-neutral-500">{docs.length} records · {visibleFiles.length} files</span></div>{library.length ? <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{library.map((entry) => entry.kind === "document" ? <KnowledgeDocumentTile key={`document-${entry.item.id}`} title={entry.item.title} venture={ventureName(data, entry.item.ventureId)} status={`Record · ${entry.item.evidenceClass}`} updatedAt={displayDate(entry.item.reviewedAt)} onOpen={() => setSelected(entry.item)} selected={included.includes(entry.item.id)} onSelect={packetMode ? (checked) => setIncluded((ids) => checked ? [...ids, entry.item.id] : ids.filter((id) => id !== entry.item.id)) : undefined} /> : <KnowledgeDocumentTile key={`file-${entry.item.id}`} title={entry.item.name} fileName={entry.item.name} contentType={entry.item.contentType} venture={ventureName(data, entry.item.ventureId)} status="File" updatedAt={displayDate(entry.item.createdAt)} onOpen={() => setSelectedFile(entry.item)} />)}</div> : <Empty title={ready ? "Nothing in this library yet" : "Loading knowledge"} body="Create a record or upload a file." />}</Panel></>}
      {view === "search" && <Panel><PanelHead title="Evidence search" /><form onSubmit={(event) => { event.preventDefault(); setSubmittedQuery(searchQuery.trim()); }} className="flex flex-wrap gap-2 border-b border-neutral-100 p-4"><label className="relative min-w-48 flex-1"><span className="sr-only">Search knowledge</span><Search size={16} className="absolute left-3 top-3.5 text-neutral-400" /><input required minLength={2} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search knowledge" className={`${inputClass} pl-9`} /></label><button type="submit" className={primaryClass}>Search</button></form>{!submittedQuery ? <Empty title="Find a source" body="Enter at least two characters." /> : hits.length ? <div className="divide-y divide-neutral-100">{hits.map((doc) => <button key={doc.id} type="button" onClick={() => setSelected(doc)} className="w-full px-5 py-4 text-left hover:bg-neutral-50"><span className="text-sm font-semibold text-neutral-800">{doc.title}</span><span className="mt-2 line-clamp-3 block text-sm leading-6 text-neutral-600">{doc.body.replaceAll("#", "").trim()}</span><span className="mt-2 block text-xs text-neutral-500">{ventureName(data, doc.ventureId)} · {doc.evidenceClass}</span></button>)}</div> : <Empty title="No matching knowledge" body="Try another search." />}</Panel>}
    </>}
    {editing && selected && <DocEditor key={selected.id} doc={selected} fresh={fresh} onClose={() => { setEditing(false); setSelected(null); }} />}
    {uploadMode && <KnowledgeUploadDialog mode={uploadMode} session={{ membership: { role: "contributor", ventureIds: person?.ventureIds ?? [] }, hierarchy: { ventures: data.ventures.filter((item) => person?.ventureIds.includes(item.id)) } }} activeVentureId={venture} onClose={() => setUploadMode(null)} onComplete={() => {}} onMarkdown={addMarkdown} onFile={addFile} demo />}
  </PageFrame>;
}
