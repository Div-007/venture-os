"use client";

import { Suspense, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Upload01Icon,
  Folder01Icon,
  FolderUploadIcon,
  File01Icon,
  AiFolder01Icon,
  Search01Icon,
  SignatureIcon,
  Download01Icon,
} from "@hugeicons/core-free-icons";
import clsx from "clsx";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, useTab } from "@/components/ui/tabs";
import { StatusChip, type Tone } from "@/components/ui/status-chip";
import { AlertStrip } from "@/components/ui/alert-strip";
import { Anim } from "@/components/ui/anim";
import { ghostBtn, primaryBtn } from "@/components/ui/btn";
import { folders, smartFolders, documents } from "@/lib/mock-modules";

const tabs = [
  { key: "library", label: "Library" },
  { key: "signatures", label: "Signatures", badge: 5 },
  { key: "shared", label: "Shared with me" },
];

function Inner() {
  const tab = useTab(tabs);
  const [folder, setFolder] = useState("All documents");
  const [sel, setSel] = useState<string>(documents[0].id);
  const [q, setQ] = useState("");
  const doc = documents.find((d) => d.id === sel)!;

  return (
    <div className="mx-auto max-w-[1600px] p-6">
      <PageHeader
        title="Documents"
        subtitle="Library, OCR search and e-signatures"
      >
        <button type="button" className={ghostBtn}>
          <HugeiconsIcon icon={Folder01Icon} size={15} strokeWidth={1.75} />
          New Folder
        </button>
        <button type="button" className={primaryBtn}>
          <HugeiconsIcon icon={Upload01Icon} size={15} strokeWidth={2} />
          Upload
        </button>
      </PageHeader>

      <Anim delay={70} className="mb-5">
        <Tabs tabs={tabs} />
      </Anim>

      {tab === "library" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip
            tone="ai"
            text="✦ OCR is on — search covers scanned text in Hindi + English"
            cta="Try it"
          />
          {/* 3-pane library — §6j */}
          <div className="grid gap-4 lg:grid-cols-12">
            {/* folders */}
            <div className="rounded-2xl bg-white p-3 lg:col-span-3">
              {folders.map((f) => (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => setFolder(f.name)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[12.5px] font-semibold",
                    "transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]",
                    folder === f.name ? "bg-primary-700 text-white" : "text-neutral-600 hover:bg-neutral-100"
                  )}
                >
                  <HugeiconsIcon icon={Folder01Icon} size={16} strokeWidth={1.5} className={folder === f.name ? "text-white/70" : "text-neutral-300"} />
                  <span className="flex-1 truncate text-left">{f.name}</span>
                  <span className={clsx("text-[10px] font-semibold tnum", folder === f.name ? "text-white/60" : "text-neutral-300")}>{f.count}</span>
                </button>
              ))}
              <p className="px-3 pb-1 pt-3 text-[9.5px] font-bold uppercase tracking-[0.09em] text-ai-text">✦ Smart folders</p>
              {smartFolders.map((f) => (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => setFolder(f.name)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[12.5px] font-semibold",
                    "transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.98]",
                    folder === f.name ? "bg-ai-surface text-ai-text" : "text-ai-text/80 hover:bg-ai-surface"
                  )}
                >
                  <HugeiconsIcon icon={AiFolder01Icon} size={16} strokeWidth={1.5} />
                  <span className="flex-1 truncate text-left">{f.name}</span>
                  <span className="text-[10px] font-semibold tnum opacity-60">{f.count}</span>
                </button>
              ))}
            </div>

            {/* files */}
            <div className="rounded-2xl bg-white p-3 lg:col-span-5">
              <div className="mb-2 flex h-9 items-center gap-2 rounded-full bg-neutral-100 px-3.5 focus-within:ring-2 focus-within:ring-primary-600/25">
                <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.5} className="text-neutral-400" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search inside documents…"
                  className="w-full bg-transparent text-[12.5px] font-medium text-neutral-800 placeholder:text-neutral-400 focus:outline-none"
                />
              </div>
              {documents
                .filter((d) => d.name.toLowerCase().includes(q.toLowerCase()))
                .map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSel(d.id)}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left",
                    "transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.99]",
                    sel === d.id ? "bg-primary-50" : "hover:bg-neutral-50"
                  )}
                >
                  <HugeiconsIcon icon={File01Icon} size={18} strokeWidth={1.5} className="shrink-0 text-neutral-300" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-bold text-neutral-900">{d.name}</span>
                    <span className="block truncate text-[11px] font-medium text-neutral-400">{d.meta} · {d.date}</span>
                  </span>
                  <StatusChip label={d.status} tone={d.tone as Tone} />
                </button>
              ))}
            </div>

            {/* preview */}
            <div className="rounded-2xl bg-white p-5 lg:col-span-4">
              <div className="grid h-40 place-items-center rounded-xl bg-neutral-100">
                <div className="text-center">
                  <HugeiconsIcon icon={File01Icon} size={28} strokeWidth={1.25} className="mx-auto text-neutral-300" />
                  <p className="mt-2 text-[11px] font-semibold text-neutral-400">Preview · {doc.name}</p>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <StatusChip label={doc.status} tone={doc.tone as Tone} />
                <button type="button" className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                  <HugeiconsIcon icon={Download01Icon} size={15} strokeWidth={1.5} />
                </button>
              </div>
              <div className="mt-4 rounded-xl bg-neutral-50 p-3.5">
                <p className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-neutral-400">OCR text</p>
                <p className="mt-1.5 text-[12px] font-medium leading-relaxed text-neutral-600">
                  &ldquo;…annual rent ₹45,000 payable monthly, lock-in period 1 year, security deposit 6 months…&rdquo;
                </p>
              </div>
              <div className="mt-3 rounded-xl bg-ai-surface p-3.5">
                <p className="flex items-start gap-2 text-[12px] font-semibold leading-snug text-ai-text">
                  <HugeiconsIcon icon={AiFolder01Icon} size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                  ✦ Summary: 3-yr lease, 1-yr lock-in, deposit ₹2.7L. Renewal due 31 Mar 2027.
                </p>
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-neutral-100 py-2 text-[11.5px] font-bold text-neutral-600 transition-colors hover:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                  <HugeiconsIcon icon={SignatureIcon} size={14} strokeWidth={1.5} />
                  Request signature
                </button>
                <button type="button" className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-neutral-100 py-2 text-[11.5px] font-bold text-neutral-600 transition-colors hover:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                  <HugeiconsIcon icon={FolderUploadIcon} size={14} strokeWidth={1.5} />
                  Share
                </button>
              </div>
            </div>
          </div>
        </Anim>
      )}

      {tab === "signatures" && (
        <Anim delay={130} className="space-y-4">
          <AlertStrip tone="warning" text="5 documents awaiting signature — oldest: vendor-kyc-xyz.pdf (4d)" cta="Send reminders" />
          <div className="rounded-2xl bg-white p-3">
            {documents.filter((d) => d.status !== "Verified").map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-neutral-50">
                <HugeiconsIcon icon={SignatureIcon} size={18} strokeWidth={1.5} className="text-neutral-300" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-bold text-neutral-900">{d.name}</p>
                  <p className="text-[11px] font-medium text-neutral-400">{d.date}</p>
                </div>
                <StatusChip label={d.status} tone={d.tone as Tone} />
                <button type="button" className="rounded-full bg-primary-700 px-3 py-1.5 text-[11px] font-semibold text-white transition-transform duration-150 hover:bg-primary-800 active:scale-[0.96]">
                  Remind
                </button>
              </div>
            ))}
          </div>
        </Anim>
      )}

      {tab === "shared" && (
        <Anim delay={130}>
          <div className="rounded-2xl bg-white p-3">
            {documents.slice(0, 3).map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-neutral-50">
                <HugeiconsIcon icon={File01Icon} size={18} strokeWidth={1.5} className="text-neutral-300" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-bold text-neutral-900">{d.name}</p>
                  <p className="text-[11px] font-medium text-neutral-400">Shared by CA · {d.date}</p>
                </div>
                <StatusChip label="View only" tone="neutral" />
              </div>
            ))}
          </div>
        </Anim>
      )}
    </div>
  );
}

export function DocumentsScreen() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
