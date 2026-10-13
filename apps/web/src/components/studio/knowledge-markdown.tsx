"use client";

import ReactMarkdown from "react-markdown";
import { SlidingTabs, useTabMotion } from "@/components/ui/sliding-tabs";
import remarkGfm from "remark-gfm";

export type MarkdownView = "rendered" | "raw";

const VIEW_TABS = [{ key: "rendered", label: "Rendered" }, { key: "raw", label: "Raw" }];
export function MarkdownViewToggle({ value, onChange }: { value: MarkdownView; onChange: (value: MarkdownView) => void }) {
  return <SlidingTabs fitContent tone="dark" label="Markdown view" className="shrink-0 !p-0.5" active={value} onChange={(key) => onChange(key as MarkdownView)} tabs={VIEW_TABS} />;
}

/**
 * `noImages` shows images as links instead of loading them: for text that reaches people without review (task details
 * written through Claude), so it can't make a reader's browser call out to another site. `compact` sizes headings for a drawer.
 */
export function MarkdownBody({ markdown, view, noImages = false, compact = false }: { markdown: string; view: MarkdownView; noImages?: boolean; compact?: boolean }) {
  const motion = useTabMotion(view, ["rendered", "raw"]);
  if (view === "raw") return <pre key="raw" style={motion.style} className="vso-tab-enter whitespace-pre-wrap break-words font-mono text-sm leading-7 text-neutral-800">{markdown}</pre>;
  return <div key="rendered" style={motion.style} className={`vso-tab-enter knowledge-markdown text-neutral-800${compact ? " knowledge-markdown-compact" : ""}`}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ src, alt }) => noImages
      ? (typeof src === "string" && src ? <a href={src} target="_blank" rel="noopener noreferrer">Image: {alt || "open"}</a> : <span>{alt}</span>)
      // Markdown sources can contain arbitrary image URLs and have no known dimensions.
      // eslint-disable-next-line @next/next/no-img-element
      : <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />,
  }}>{markdown}</ReactMarkdown></div>;
}
