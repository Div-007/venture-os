"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiMagicIcon,
  Mic01Icon,
  SentIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
  Copy01Icon,
  ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/ui/page-header";
import { Anim } from "@/components/ui/anim";
import { aiPrompts } from "@/lib/mock-modules";

type Msg = { from: "you" | "ai"; text: string; card?: boolean };

const canned: Msg = {
  from: "ai",
  text: "Haan — current projection mein next month cash positive rahega, but week 3 mein ek gap aa sakta hai. Sources: 3 invoices · 2 POs · payroll schedule · Confidence: High ●●●○",
  card: true,
};

export function AiChatScreen() {
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "you", text: "kya cash flow next month safe hai?" },
    canned,
  ]);
  const [input, setInput] = useState("");

  const send = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setMsgs((m) => [...m, { from: "you", text: t }, canned]);
    setInput("");
  };

  return (
    <div className="mx-auto flex h-full max-w-[900px] flex-col p-6">
      <PageHeader
        title="AI Business Advisor"
        subtitle="Context: Delhi HQ · September 2026 — ask in Hindi or English"
      />

      <Anim delay={70} className="mb-4 flex flex-wrap gap-2">
        {aiPrompts.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => send(p)}
            className="rounded-full bg-white px-3.5 py-2 text-[12px] font-semibold text-neutral-600 transition-[background-color,transform] duration-150 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.97]"
          >
            {p}
          </button>
        ))}
      </Anim>

      {/* thread */}
      <Anim delay={130} className="thin-scroll flex-1 space-y-4 overflow-y-auto rounded-2xl bg-white p-5">
        {msgs.map((m, i) =>
          m.from === "you" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[75%] rounded-2xl rounded-br-md bg-primary-700 px-4 py-2.5 text-[13px] font-medium text-white">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="max-w-[80%]">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ai-surface text-ai">
                  <HugeiconsIcon icon={AiMagicIcon} size={14} strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                  <div className="rounded-2xl rounded-tl-md bg-ai-surface/60 px-4 py-3 text-[13px] font-medium leading-relaxed text-neutral-800">
                    {m.text}
                    {m.card && (
                      <div className="mt-3 rounded-xl bg-white p-3.5">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-400">Cash position</p>
                        <p className="mt-1.5 text-[12.5px] font-semibold leading-relaxed text-neutral-700 tnum">
                          Cash on hand ₹8.2L · Receivables ₹6.4L · Payables ₹9.1L → projected low ₹5.5L on ~12 Oct
                        </p>
                        <a href="/finance?tab=cash-flow" className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-bold text-primary-600 hover:text-primary-700">
                          View cash flow chart
                          <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                        </a>
                      </div>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1 pl-1">
                    {[ThumbsUpIcon, ThumbsDownIcon, Copy01Icon].map((ic, j) => (
                      <button key={j} type="button" className="grid h-6 w-6 place-items-center rounded-md text-neutral-300 transition-colors hover:bg-neutral-100 hover:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
                        <HugeiconsIcon icon={ic} size={13} strokeWidth={1.5} />
                      </button>
                    ))}
                    <a href="/finance" className="ml-1 text-[10.5px] font-bold text-primary-600 hover:text-primary-700">
                      Open in Finance →
                    </a>
                  </div>
                </div>
              </div>
            </div>
          )
        )}
      </Anim>

      {/* composer */}
      <Anim delay={180} className="mt-4">
        <div className="flex h-12 items-center gap-2 rounded-full bg-white pl-5 pr-1.5 focus-within:ring-2 focus-within:ring-primary-600/25">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
            placeholder="Type or speak 🎤 (Hindi/English)…"
            className="w-full bg-transparent text-[13px] font-medium text-neutral-800 placeholder:text-neutral-400 focus:outline-none"
          />
          <button type="button" aria-label="Voice input" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
            <HugeiconsIcon icon={Mic01Icon} size={17} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={() => send(input)}
            aria-label="Send"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-700 text-white transition-[background-color,transform] duration-150 hover:bg-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 active:scale-[0.94]"
          >
            <HugeiconsIcon icon={SentIcon} size={16} strokeWidth={1.75} />
          </button>
        </div>
      </Anim>
    </div>
  );
}
