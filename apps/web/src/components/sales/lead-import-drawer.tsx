"use client";
import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { IMPORT_MAX_CHARS, IMPORT_MAX_ROWS, type ImportField, type ImportMapping } from "@venture-studio/contracts";
import { AlertTriangle, ChevronDown, CircleCheck, FileText, Info, Upload } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ActionLabel, Badge, DetailDrawer, Field, inputClass, Notice, primaryClass, secondaryClass } from "@/components/studio/primitives";
import { describeError } from "@/lib/errors";
import { commitImport, previewImport, type ImportPreview, type ImportResult } from "@/lib/sales-api";
import { useSalesShell } from "@/components/sales/sales-context";
import { number, plural, when } from "@/components/sales/sales-ui";

const FIELD_LABELS: Record<ImportField, string> = {
  company: "Company", contactName: "Contact person", website: "Website", category: "Industry", city: "City", region: "State", country: "Country", phone: "Phone", email: "Email", source: "Source", tags: "Tags", value: "Deal value", offer: "Offer",
};
/** Shown first; the rest sit behind "More columns" unless the file already fills them. */
const MAIN_FIELDS: ImportField[] = ["company", "phone", "email", "city", "website"];
const OTHER_FIELDS: ImportField[] = ["contactName", "category", "region", "country", "source", "tags", "value", "offer"];
const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" }> = {
  ok: { label: "Ready", tone: "green" }, duplicate: { label: "Already here", tone: "amber" }, invalid: { label: "Needs fixing", tone: "red" }, do_not_contact: { label: "Do not contact", tone: "neutral" },
};
const ISSUES_SHOWN = 6;
/** What a decoder puts where it could not read a character. */
const REPLACEMENT = "\ufffd";
type Encoding = "UTF-8" | "UTF-16" | "Windows-1252";
type CsvFile = { name: string; text: string; encoding: Encoding; unreadable: boolean };

/**
 * Reads a CSV the way spreadsheets save it: UTF-8 (with or without a byte order mark), UTF-16 (Excel's "Unicode Text", with a byte
 * order mark or plainly every other byte zero) or, when the bytes are not valid UTF-8, Windows-1252 (older Excel's plain "CSV").
 * `unreadable`: some characters still could not be read (they show as U+FFFD).
 */
async function readCsvFile(file: File): Promise<CsvFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decode = (label: string, fatal = false) => new TextDecoder(label, { fatal }).decode(bytes);
  let text: string;
  let encoding: Encoding;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length >= 4 && bytes[0] !== 0 && bytes[1] === 0 && bytes[2] !== 0 && bytes[3] === 0)) { text = decode("utf-16le"); encoding = "UTF-16"; }
  else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes.length >= 4 && bytes[0] === 0 && bytes[1] !== 0 && bytes[2] === 0 && bytes[3] !== 0)) { text = decode("utf-16be"); encoding = "UTF-16"; }
  else {
    try { text = decode("utf-8", true); encoding = "UTF-8"; }
    catch { text = decode("windows-1252"); encoding = "Windows-1252"; }
  }
  // A UTF-16 decoder keeps a byte order mark it was not told to skip; the API reads one at the start anyway, so drop it here.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { name: file.name, text, encoding, unreadable: text.includes(REPLACEMENT) };
}

function CountTile({ label, value, tone, note }: { label: string; value: number; tone: "green" | "amber" | "red" | "neutral"; note: string }) {
  const tones = { green: "text-primary-800", amber: "text-warning-text", red: "text-danger-text", neutral: "text-neutral-700" };
  return <div className="min-w-0 rounded-2xl border border-neutral-100 bg-neutral-50 px-3.5 py-3">
    <p className={clsx("text-xl font-extrabold leading-7 tnum", value ? tones[tone] : "text-neutral-300")}>{number(value)}</p>
    <p className="text-[13px] font-semibold leading-5 text-neutral-700">{label}</p>
    <p className="text-xs leading-5 text-neutral-500">{note}</p>
  </div>;
}

/**
 * Import a CSV of leads in three short steps inside one drawer: choose the file (and the venture, in All ventures), check what the
 * import would do (columns matched from the header, each one changeable; rows that are already leads, broken or on the do-not-contact
 * list are flagged), then import. Leads come in as Identified and owned by the person importing. Full screen on phones.
 */
export function LeadImportDrawer({ onClose }: { onClose: () => void }) {
  const { session, ventureId, ventureName, refresh } = useSalesShell();
  const ventures = useMemo(() => (session?.hierarchy.ventures ?? []).filter((venture) => session?.membership.role === "admin" || session?.membership.ventureIds.includes(venture.id)), [session]);
  const [picked, setPicked] = useState(ventures.length === 1 ? ventures[0]!.id : "");
  const destination = ventureId || picked;
  const [file, setFile] = useState<CsvFile | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importDuplicates, setImportDuplicates] = useState(false);
  const [moreColumns, setMoreColumns] = useState(false);
  const [allIssues, setAllIssues] = useState(false);
  const [busy, setBusy] = useState<"" | "reading" | "checking" | "importing">("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  async function check(text: string, venture: string, mapping: ImportMapping | undefined, header: boolean) {
    const ticket = ++run.current;
    setBusy("checking"); setError("");
    try {
      const next = await previewImport({ ventureId: venture, csv: text, hasHeader: header, ...(mapping ? { mapping } : {}) });
      if (ticket !== run.current) return;
      setPreview(next);
    } catch (cause) { if (ticket === run.current) setError(describeError(cause, "Could not read the file. Check it is a CSV and try again.")); }
    finally { if (ticket === run.current) setBusy(""); }
  }

  async function choose(chosen: File | undefined) {
    if (!chosen) return;
    setError(""); setPreview(null); setResult(null); setAllIssues(false); setImportDuplicates(false);
    const tooBig = `${chosen.name} is larger than 5 MB. Split it into smaller files.`;
    // UTF-16 files are about twice the size of the same text in UTF-8: the 5 MB is checked on the text itself below.
    if (chosen.size > IMPORT_MAX_CHARS * 2) { setError(tooBig); return; }
    if (!/\.(csv|txt|tsv)$/i.test(chosen.name) && !/csv|text/.test(chosen.type)) { setError(`${chosen.name} is not a CSV. In your spreadsheet, choose File > Download (or Save as) > CSV.`); return; }
    setBusy("reading");
    try {
      const read = await readCsvFile(chosen);
      if (new TextEncoder().encode(read.text).length > IMPORT_MAX_CHARS) { setBusy(""); setError(tooBig); return; }
      if (read.text.includes("\u0000")) { setBusy(""); setError(`${chosen.name} is not a text file. In your spreadsheet, choose File > Download (or Save as) > CSV.`); return; }
      setFile(read);
      setBusy("");
      if (destination) await check(read.text, destination, undefined, hasHeader);
    } catch { setBusy(""); setError("Could not read that file."); }
  }

  function remap(field: ImportField, value: string) {
    if (!file || !preview) return;
    const mapping: ImportMapping = { ...preview.mapping, [field]: value === "" ? null : Number(value) };
    setPreview({ ...preview, mapping });
    void check(file.text, destination, mapping, hasHeader);
  }

  async function commit() {
    if (!file || !preview) return;
    setBusy("importing"); setError("");
    try {
      const done = await commitImport({ ventureId: destination, csv: file.text, hasHeader, mapping: preview.mapping, importDuplicates });
      setResult(done);
      if (done.alreadyImported) toast({ tone: "info", title: "Already imported", body: "This file was imported before: nothing was created again." });
      else { toast({ title: `Imported ${plural(done.created, "lead")}`, body: `Into ${ventureName(destination)}, as Identified and owned by you.` }); refresh(); }
    } catch (cause) { setError(describeError(cause, "Could not import the leads. Nothing was created; try again.")); }
    finally { setBusy(""); }
  }

  function reset() { run.current++; setFile(null); setPreview(null); setResult(null); setError(""); setBusy(""); setAllIssues(false); setImportDuplicates(false); }

  const counts = preview?.counts;
  const importing = counts ? counts.ok + (importDuplicates ? counts.duplicate : 0) : 0;
  const missingCompany = !!preview?.missing.includes("company");
  const issues = preview?.issues ?? [];
  const shownIssues = allIssues ? issues : issues.slice(0, ISSUES_SHOWN);
  const columnOptions = (preview?.columns ?? []).map((name, index) => ({ value: String(index), label: name }));
  const mappedOthers = OTHER_FIELDS.filter((field) => typeof preview?.mapping[field] === "number");
  const unmappedOthers = OTHER_FIELDS.filter((field) => typeof preview?.mapping[field] !== "number");
  const fieldRow = (field: ImportField) => {
    const value = preview?.mapping[field];
    return <div key={field} className="flex min-h-11 items-center justify-between gap-3 py-1">
      <span className="min-w-0 text-sm font-semibold text-neutral-700">{FIELD_LABELS[field]}{field === "company" && <span className="ml-1 text-xs font-medium text-neutral-400">needed</span>}</span>
      <div className="w-44 shrink-0 sm:w-60"><Select aria-label={`Column for ${FIELD_LABELS[field]}`} className={clsx(inputClass, "!min-h-10", field === "company" && missingCompany && "!border-danger-text")} value={typeof value === "number" ? String(value) : ""} onChange={(event) => remap(field, event.target.value)}>
        <option value="">Not in the file</option>{columnOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select></div>
    </div>;
  };

  let body: React.ReactNode;
  let footer: React.ReactNode = null;
  if (result?.alreadyImported) {
    const before = result.alreadyImported;
    body = <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
      <p className="flex items-center gap-2 text-lg font-extrabold text-neutral-800"><Info size={20} className="shrink-0 text-primary-700" />Already imported</p>
      <p className="mt-1 text-sm leading-6 text-neutral-700">This file was imported into {ventureName(destination)} before ({when(before.at)}), with {plural(before.created, "new lead")}. Nothing was created again. To add rows that were skipped then, import a file with just those rows.</p>
    </div>;
    footer = <div className="flex flex-wrap gap-2"><button type="button" onClick={onClose} className={clsx(primaryClass, "flex-1 sm:flex-none")}>See the leads</button><button type="button" onClick={reset} className={secondaryClass}>Import another file</button></div>;
  } else if (result) {
    const skipped: [number, string][] = [[result.duplicates, "already in this venture (or deleted earlier)"], [result.invalid, "had problems"], [result.doNotContact, "on the do-not-contact list"]];
    body = <div className="grid gap-4">
      <div className="rounded-2xl border border-primary-100 bg-primary-50 p-4">
        <p className="flex items-center gap-2 text-lg font-extrabold text-primary-800"><CircleCheck size={20} />{plural(result.created, "lead")} imported</p>
        <p className="mt-1 text-sm leading-6 text-neutral-700">{result.created === 1 ? "It is" : "They are"} in {ventureName(destination)} as Identified, owned by you. Claude can research {result.created === 1 ? "it" : "them"} from the Leads list.</p>
      </div>
      {skipped.some(([count]) => count > 0) && <ul className="grid gap-1.5 text-sm text-neutral-600">{skipped.filter(([count]) => count > 0).map(([count, why]) => <li key={why}><strong className="font-semibold text-neutral-800 tnum">{number(count)}</strong> skipped: {why}</li>)}</ul>}
    </div>;
    footer = <div className="flex flex-wrap gap-2"><button type="button" onClick={onClose} className={clsx(primaryClass, "flex-1 sm:flex-none")}>See the leads</button><button type="button" onClick={reset} className={secondaryClass}>Import another file</button></div>;
  } else {
    body = <div className="grid gap-5">
      {!ventureId && <Field label="Venture"><Select required aria-label="Venture" className={inputClass} value={picked} onChange={(event) => { setPicked(event.target.value); setPreview(null); if (file && event.target.value) void check(file.text, event.target.value, undefined, hasHeader); }}><option value="">Choose a venture</option>{ventures.map((venture) => <option key={venture.id} value={venture.id}>{venture.name}</option>)}</Select></Field>}
      {file
        ? <div className="flex items-center gap-3 rounded-2xl border border-neutral-100 bg-neutral-50 p-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-primary-700"><FileText size={18} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-neutral-800">{file.name}</span><span className="block text-xs text-neutral-500 tnum">{preview ? `${plural(preview.total, "row")}${preview.delimiter !== "," ? ` · split by ${preview.delimiter === "\t" ? "tabs" : `“${preview.delimiter}”`}` : ""}${file.encoding !== "UTF-8" ? ` · read as ${file.encoding}` : ""}` : busy === "checking" ? "Reading…" : destination ? "" : "Choose the venture first"}</span></span>
          <button type="button" onClick={() => { reset(); requestAnimationFrame(() => picker.current?.click()); }} className={clsx(secondaryClass, "!min-h-10 shrink-0 !px-3 !text-xs")}>Change file</button>
        </div>
        : <label onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void choose(event.dataTransfer.files[0]); }} className={clsx("grid cursor-pointer place-items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-9 text-center transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary-600", dragging ? "border-primary-400 bg-primary-50" : "border-neutral-200 hover:border-primary-300 hover:bg-neutral-50")}>
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-primary-50 text-primary-700"><Upload size={20} /></span>
          <span className="text-sm font-bold text-neutral-800">{busy === "reading" ? "Reading the file…" : "Choose a CSV file"}</span>
          <span className="max-w-sm text-xs leading-5 text-neutral-500">Or drop it here. Up to {number(IMPORT_MAX_ROWS)} rows and 5 MB. From Excel or Google Sheets: File &gt; Download &gt; CSV.</span>
          <input ref={picker} type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
        </label>}
      {file?.unreadable && <p role="status" className="flex items-start gap-2 rounded-xl bg-warning-surface px-3 py-2.5 text-sm leading-5 text-warning-text"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><span>Some characters in this file could not be read and show as “{REPLACEMENT}”. Check the names below; to fix them, save the file from your spreadsheet as <strong className="font-semibold">CSV UTF-8</strong> and choose it again.</span></p>}
      {error && <Notice tone="error" message={error} onDismiss={() => setError("")} />}

      {preview && counts && <>
        <section aria-label="What the import will do" className={clsx("grid grid-cols-2 gap-2.5 transition-opacity duration-150 sm:grid-cols-4", busy === "checking" && "opacity-60")}>
          <CountTile label="Ready" value={counts.ok} tone="green" note="New leads" />
          <CountTile label="Already here" value={counts.duplicate} tone="amber" note="Skipped unless you say" />
          <CountTile label="Need fixing" value={counts.invalid} tone="red" note="Skipped" />
          <CountTile label="Do not contact" value={counts.doNotContact} tone="neutral" note="Never imported" />
        </section>

        <section aria-label="Columns" className="grid gap-1">
          <div className="flex items-baseline justify-between gap-2"><h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400">Columns</h3>{preview.guessed && <span className="text-xs text-neutral-500">Matched from the header. Change any that are wrong.</span>}</div>
          {missingCompany && <p className="rounded-xl bg-danger-surface px-3 py-2 text-sm font-semibold text-danger-text">Pick the column that holds the company name.</p>}
          <div className="divide-y divide-neutral-100">{[...MAIN_FIELDS, ...mappedOthers].map(fieldRow)}</div>
          {unmappedOthers.length > 0 && <div data-open={moreColumns} className="vso-collapse"><div><div className="divide-y divide-neutral-100 border-t border-neutral-100">{unmappedOthers.map(fieldRow)}</div></div></div>}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {unmappedOthers.length > 0 ? <button type="button" aria-expanded={moreColumns} onClick={() => setMoreColumns((open) => !open)} className="inline-flex min-h-10 items-center gap-1 rounded-lg text-xs font-semibold text-primary-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"><ChevronDown size={14} className={clsx("transition-transform duration-150", moreColumns && "rotate-180")} />{moreColumns ? "Fewer columns" : `More columns (${unmappedOthers.length})`}</button> : <span />}
            <label className="inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-neutral-600"><input type="checkbox" checked={hasHeader} onChange={(event) => { setHasHeader(event.target.checked); void check(file!.text, destination, preview.mapping, event.target.checked); }} className="h-4 w-4 accent-[var(--color-primary-700)]" />First row is the header</label>
          </div>
        </section>

        {issues.length > 0 && <section aria-label="Rows to look at" className="grid gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-neutral-400">Rows to look at</h3>
          <ul className="grid gap-1.5">{shownIssues.map((row) => <li key={row.row} className="rounded-xl border border-neutral-100 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-semibold text-neutral-400 tnum">Row {row.row}</span><span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-800">{row.values.company || "No company"}</span><Badge tone={STATUS[row.status]!.tone}>{STATUS[row.status]!.label}</Badge></div>
            {row.problems[0] && <p className="mt-0.5 text-xs leading-5 text-neutral-500 [overflow-wrap:anywhere]">{row.problems.join(" · ")}</p>}
          </li>)}</ul>
          {issues.length > ISSUES_SHOWN && <button type="button" onClick={() => setAllIssues((open) => !open)} className="justify-self-start text-xs font-semibold text-primary-700 hover:underline">{allIssues ? "Show fewer" : `Show all ${number(issues.length)}${preview.issuesTruncated ? " (the first 200)" : ""}`}</button>}
        </section>}

        {counts.duplicate > 0 && <label className="flex items-start gap-2.5 rounded-xl border border-neutral-100 p-3 text-sm leading-5 text-neutral-700"><input type="checkbox" checked={importDuplicates} onChange={(event) => setImportDuplicates(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary-700)]" /><span>Import the {plural(counts.duplicate, "row")} marked “Already here” too <span className="block text-xs text-neutral-500">Only if they really are different businesses.</span></span></label>}
      </>}
    </div>;
    if (preview) footer = <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={!!busy || importing === 0 || missingCompany} onClick={() => void commit()} className={clsx(primaryClass, "flex-1 sm:flex-none")}><ActionLabel busy={busy === "importing"} busyText="Importing…" idle={importing ? `Import ${plural(importing, "lead")}` : "Nothing to import"} /></button>
      <button type="button" onClick={onClose} className={secondaryClass}>Cancel</button>
      {busy === "checking" && <span role="status" className="text-xs font-semibold text-neutral-500">Checking…</span>}
    </div>;
  }

  return <DetailDrawer title="Import leads" subtitle={ventureId ? `Into ${ventureName(ventureId)}` : "From a CSV file"} onClose={onClose} dirty={!!file && !result} footer={footer}>{body}</DetailDrawer>;
}
