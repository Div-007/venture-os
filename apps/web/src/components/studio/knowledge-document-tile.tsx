"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import clsx from "clsx";
import { KnowledgeFileIcon, fileExtension } from "@/components/studio/knowledge-file-icon";
import { Edit } from "@/components/ui/icons";
import { loadLiveImageThumbnail } from "@/lib/studio-api";

function KnowledgeImagePreview({ fileId, name, contentType }: { fileId: string; name: string; contentType: string }) {
  const target = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    if (!window.IntersectionObserver) { queueMicrotask(() => setVisible(true)); return; }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
      if (!entry.isIntersecting) { setImageUrl(null); setLoaded(false); }
    }, { rootMargin: "160px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    loadLiveImageThumbnail(fileId, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setImageUrl(objectUrl);
    }).catch(() => { /* Keep the file-type icon when a thumbnail cannot be generated. */ });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId, visible]);

  return <span ref={target} className="absolute inset-0 flex items-center justify-center">
    {(!visible || !imageUrl || !loaded) && <KnowledgeFileIcon name={name} contentType={contentType} />}{visible && imageUrl && <Image src={imageUrl} alt="" fill sizes="(max-width: 640px) 50vw, 320px" unoptimized onLoad={() => setLoaded(true)} className={clsx("object-contain transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")} />}
  </span>;
}

export function KnowledgeDocumentTile({ title, venture, status, updatedAt, onOpen, onEdit, selected, onSelect, unavailable, contentType, fileName, fileId }: {
  title: string;
  venture: string;
  status: string;
  updatedAt: string;
  onOpen: () => void;
  onEdit?: () => void;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  /** Shown while choosing a context packet for items that cannot be included. */
  unavailable?: string;
  contentType?: string;
  fileName?: string;
  fileId?: string;
}) {
  const displayName = fileName ?? `${title}.md`;
  const displayType = contentType ?? "text/markdown";
  // While choosing a packet, clicking a tile selects it instead of opening it.
  const activate = onSelect ? () => onSelect(!selected) : onOpen;
  return <div className={clsx("group relative min-w-0 transition-opacity duration-200", unavailable && "opacity-45")} title={unavailable}>
    <button type="button" onClick={unavailable ? undefined : activate} aria-disabled={unavailable ? true : undefined} aria-label={onSelect ? `${selected ? "Remove" : "Add"} ${title} ${selected ? "from" : "to"} the context packet` : `Open ${title}`} className={clsx("knowledge-tile block w-full min-w-0 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2", unavailable && "cursor-not-allowed")}>
      <span className={clsx("knowledge-tile-preview relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border bg-neutral-50 p-4 transition-[border-color,box-shadow] duration-200", selected ? "border-primary-500 shadow-[0_0_0_3px_var(--color-primary-100)]" : "border-neutral-200")}>
        {fileId && displayType.startsWith("image/") ? <KnowledgeImagePreview fileId={fileId} name={displayName} contentType={displayType} /> : <KnowledgeFileIcon name={displayName} contentType={displayType} />}
        <span className="absolute bottom-2 right-2 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">{fileExtension(displayName, displayType)}</span>
      </span>
      <span className="mt-2 block line-clamp-2 px-0.5 text-sm font-semibold leading-5 text-neutral-900" title={title}>{title}</span>
      <span className="mt-0.5 block truncate px-0.5 text-xs text-neutral-500">{venture} · {status} · {updatedAt}</span>
    </button>
    {onEdit && <button type="button" onClick={onEdit} aria-label={`Edit ${title}`} title={`Edit ${title}`} className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-700 transition-[opacity,background-color,color,transform] duration-150 hover:bg-primary-50 hover:text-primary-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 active:scale-[0.97] group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0"><Edit size={16} /></button>}
    {onSelect && <label className={clsx("vso-fade-enter absolute left-2 top-2 grid h-8 w-8 cursor-pointer place-items-center rounded-lg border bg-white shadow-sm transition-[border-color,transform] duration-150 active:scale-90", selected ? "border-primary-500" : "border-neutral-200")} title="Include in context packet"><input type="checkbox" checked={Boolean(selected)} onChange={(event) => onSelect(event.target.checked)} aria-label={`Include ${title} in context packet`} className="h-4 w-4 accent-primary-600" /></label>}
  </div>;
}
