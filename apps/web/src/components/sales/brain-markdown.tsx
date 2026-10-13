"use client";
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import { safeHttp } from "./draft-shared";

// Renders a knowledge item for reading. The item has its own title, so the body's headings must not compete with it:
// "#" and "##" become small uppercase labels, "###" a 13px semibold line, and "**Key:** value" lines become tidy rows.

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const Strong = ({ children }: { children?: ReactNode }) => <strong className="font-semibold text-neutral-900">{children}</strong>;

/** "**Label:** value" or "**Label**: value" at the start of a block. `rest` is empty for a lone "**Label**". */
function leadingLabel(children: ReactNode): { label: string; rest: ReactNode[]; alone: boolean } | null {
  const parts = Children.toArray(children);
  const first = parts[0];
  if (!isValidElement<{ children?: ReactNode }>(first) || first.type !== Strong) return null;
  const raw = textOf(first.props.children).trim();
  if (!raw || raw.length > 56) return null;
  const next = parts[1];
  const colonInside = raw.endsWith(":");
  const colonAfter = typeof next === "string" && /^\s*:/.test(next);
  const label = raw.replace(/:$/, "");
  const rest = colonAfter ? [(next as string).replace(/^\s*:\s*/, ""), ...parts.slice(2)] : parts.slice(1);
  const empty = rest.every((part) => typeof part === "string" && !part.trim());
  if (empty) return { label, rest: [], alone: true };
  return colonInside || colonAfter ? { label, rest, alone: false } : null;
}

/**
 * Plain-text drafts often run as one block: "WHO: ... SEGMENTS: ... EVIDENCE: ...". When a paragraph holds two or more
 * ALL-CAPS labels followed by a colon (or one label in a long paragraph), each becomes its own row.
 */
function splitCapsLabels(text: string): { lead: string; rows: { label: string; text: string }[] } | null {
  const labels = [...text.matchAll(/(?:^|(?<=[.!?)\s]))([A-Z][A-Z0-9 &/'+-]{1,30}):\s/g)].filter((match) => /[A-Z]{2}/.test(match[1]!));
  if (labels.length < 2 && !(labels.length === 1 && text.length > 240)) return null;
  const rows = labels.map((match, index) => ({ label: match[1]!.trim(), text: text.slice(match.index! + match[0].length, labels[index + 1]?.index ?? text.length).trim() }));
  return { lead: text.slice(0, labels[0]!.index).trim(), rows };
}

const row = "grid gap-x-4 gap-y-0.5 border-b border-neutral-100 py-2 last:border-b-0 sm:grid-cols-[9.5rem_minmax(0,1fr)]";
const labelClass = "text-[12.5px] font-semibold leading-6 text-neutral-500";
const valueClass = "min-w-0 text-[14px] leading-6 text-neutral-800 [overflow-wrap:anywhere]";
const sectionLabel = "mb-2 mt-7 border-t border-neutral-100 pt-4 text-[11px] font-bold uppercase tracking-[.08em] text-neutral-500 first:mt-0 first:border-0 first:pt-0";

const components: Components = {
  h1: ({ children }) => <h3 className={sectionLabel}>{children}</h3>,
  h2: ({ children }) => <h3 className={sectionLabel}>{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-5 text-[13px] font-semibold text-neutral-900 first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mb-1 mt-4 text-[12.5px] font-semibold text-neutral-700 first:mt-0">{children}</h5>,
  h5: ({ children }) => <h5 className="mb-1 mt-4 text-[12.5px] font-semibold text-neutral-700 first:mt-0">{children}</h5>,
  h6: ({ children }) => <h5 className="mb-1 mt-4 text-[12.5px] font-semibold text-neutral-700 first:mt-0">{children}</h5>,
  p: ({ children }) => {
    const only = Children.toArray(children);
    const caps = only.length === 1 && typeof only[0] === "string" ? splitCapsLabels(only[0]) : null;
    if (caps) return <div className="mb-3">{caps.lead && <p className="mb-2 text-[14px] leading-[1.7] text-neutral-700 [overflow-wrap:anywhere]">{caps.lead}</p>}{caps.rows.map((entry, index) => <div key={index} className={row}><div className="text-[11px] font-bold uppercase leading-6 tracking-[.06em] text-neutral-500">{entry.label}</div><div className={valueClass}>{entry.text}</div></div>)}</div>;
    const lead = leadingLabel(children);
    if (lead?.alone) return <p className="mb-1.5 mt-4 text-[13px] font-semibold text-neutral-900 first:mt-0">{lead.label}</p>;
    if (lead) return <div className={row}><div className={labelClass}>{lead.label}</div><div className={valueClass}>{lead.rest}</div></div>;
    return <p className="mb-3 text-[14px] leading-[1.7] text-neutral-700 [overflow-wrap:anywhere]">{children}</p>;
  },
  strong: Strong,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 text-[14px] leading-[1.65] text-neutral-700 marker:text-neutral-300 [&_ol]:mb-0 [&_ol]:mt-1 [&_ul]:mb-0 [&_ul]:mt-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 text-[14px] leading-[1.65] text-neutral-700 marker:font-semibold marker:text-neutral-400 [&_ol]:mb-0 [&_ol]:mt-1 [&_ul]:mb-0 [&_ul]:mt-1">{children}</ol>,
  li: ({ children }) => {
    const lead = leadingLabel(children);
    if (lead && !lead.alone) return <li className={clsx(row, "-ml-5 list-none border-b-0 py-1")}><div className={labelClass}>{lead.label}</div><div className={valueClass}>{lead.rest}</div></li>;
    return <li className="[overflow-wrap:anywhere] [&>p]:mb-1">{children}</li>;
  },
  blockquote: ({ children }) => <blockquote className="mb-3 border-l-2 border-primary-300 pl-3 text-[14px] leading-[1.7] text-neutral-600 [&>p]:mb-1">{children}</blockquote>,
  hr: () => <hr className="my-5 border-neutral-100" />,
  a: ({ href, children }) => href && safeHttp(href) ? <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-primary-700 underline underline-offset-2 hover:text-primary-800">{children}</a> : <span>{children}</span>,
  code: ({ children, className }) => className ? <code className={className}>{children}</code> : <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12.5px] text-neutral-800">{children}</code>,
  pre: ({ children }) => <pre className="mb-3 overflow-x-auto rounded-xl bg-neutral-50 p-3 font-mono text-[12.5px] leading-6 text-neutral-800">{children}</pre>,
  table: ({ children }) => <div className="mb-3 overflow-x-auto rounded-xl border border-neutral-100"><table className="w-full border-collapse text-left text-[13px]">{children}</table></div>,
  th: ({ children }) => <th className="bg-neutral-50 px-3 py-2 text-[12px] font-semibold text-neutral-600">{children}</th>,
  td: ({ children }) => <td className="border-t border-neutral-100 px-3 py-2 align-top text-neutral-700">{children}</td>,
  img: ({ alt }) => <span className="text-neutral-400">{alt}</span>,
};

/** A knowledge body, compact and with a readable line length. Pass `wide` inside a comparison column. */
export function BrainMarkdown({ markdown, wide = false }: { markdown: string; wide?: boolean }) {
  return <div className={clsx("min-w-0 [&>*:last-child]:mb-0", !wide && "max-w-[72ch]")}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{markdown}</ReactMarkdown>
  </div>;
}
