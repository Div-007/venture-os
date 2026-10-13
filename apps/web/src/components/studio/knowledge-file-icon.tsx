"use client";

import Image from "next/image";
import { HugeiconsIcon } from "@hugeicons/react";
import { File02Icon, FileAudioIcon, FileCodeIcon, FileImageIcon, FilePlayIcon, FileTextIcon } from "@hugeicons/core-free-icons";

export function fileExtension(name: string, contentType?: string) {
  const extension = name.includes(".") ? name.split(".").at(-1)?.toUpperCase() ?? "FILE" : contentType === "text/markdown" ? "MD" : "FILE";
  return extension.slice(0, 8);
}

export function KnowledgeFileIcon({ name, contentType, className = "" }: { name: string; contentType?: string; className?: string }) {
  const extension = fileExtension(name, contentType);
  if (extension === "MD" || extension === "MARKDOWN" || contentType === "text/markdown") return <Image src="/file-icons/markdown.png" width={120} height={120} alt="" className={`h-28 w-28 object-contain ${className}`} />;
  if (extension === "PDF" || contentType === "application/pdf") return <Image src="/file-icons/pdf.webp" width={120} height={120} alt="" className={`h-28 w-28 object-contain ${className}`} />;
  const icon = contentType?.startsWith("image/") || ["PNG", "JPG", "JPEG", "WEBP", "GIF", "SVG"].includes(extension) ? FileImageIcon
    : contentType?.startsWith("video/") || ["MP4", "MOV", "WEBM"].includes(extension) ? FilePlayIcon
    : contentType?.startsWith("audio/") || ["MP3", "M4A", "OGG", "WAV"].includes(extension) ? FileAudioIcon
    : ["TXT", "TEXT"].includes(extension) ? FileTextIcon
    : ["HTML", "CSS", "JS", "TS", "JSON", "XML"].includes(extension) ? FileCodeIcon : File02Icon;
  return <span aria-hidden="true" className="relative grid h-24 w-20 place-items-center rounded-xl border border-primary-200 bg-white text-primary-700 shadow-sm">
    <HugeiconsIcon icon={icon} size={42} strokeWidth={1.4} />
    <span className="absolute -bottom-2 left-1/2 max-w-20 -translate-x-1/2 rounded-md bg-primary-700 px-2 py-0.5 text-[10px] font-extrabold tracking-wide text-white">{extension}</span>
  </span>;
}
