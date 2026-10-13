# Problem statement

**Team Buildory · AlgoStorm 2.0 · Venture Studio OS ("Venture OS")** · Last updated 13 October 2026

> Small teams now run their businesses through AI, but every person's AI knows a different version of the business. Venture OS gives the whole team one shared, permissioned memory per business, read by each person's own Claude, and lets that AI run the work while people keep every decision.

---

## 1. The problem

Small, ambitious teams increasingly do their work *through* an AI assistant: researching companies, planning, making decisions and writing sales messages. We are one of those teams: four people running three businesses at the same time, almost entirely through Claude.

An AI only knows what it is told (its **context**). In a team, each person tells it something different:

1. **Separate chats, separate truths.** Every teammate keeps their own chats, each holding its own picture of the business. Asked the same question ("Who do we sell to?"), two teammates' AIs give two different answers, and the work comes out different every time.
2. **Missing know-how.** Teammates lack the steps, rules and past decisions that live only in the founder's head, so their AI fills the gaps with confident guesses.
3. **Shared files go stale.** Our first fix was writing everything into Markdown instruction files in one shared Git folder. Output improved, but every change meant *update, push, everyone pulls again*. Miss one update and someone works from old instructions; with more files there is no single truth.
4. **Files cannot run the work.** Assigning tasks, checking that work is really done, following up and keeping everyone informed across several businesses still lived in one person's head.
5. **Sales is the sharpest case.** Researching and judging leads with AI produces confident claims without proof, inconsistent judgements between people, and a risk of messages going out that nobody checked.

**The core problem is context, not intelligence:** the AI is capable, but every person feeds it a different, partial and outdated picture, and nothing connects that AI to the team's actual work.

## 2. Who has this problem

- **Primary users:** small teams (2–20 people) that work through AI and run **more than one thing at once**: venture studios, founders with a startup and a side business, family businesses with several units (a shop, a godown, a distributorship), agencies with many clients.
- **Also:** any single business, once more than one person works with AI.
- **Not our target:** large enterprises, which already buy point solutions (enterprise search, sales-research platforms) with large budgets.

## 3. Evidence that it is common

| Signal | Number | Source |
|---|---|---|
| US business owners who currently own more than one business | **1 in 3** | NORC at the University of Chicago, entrepreneurship survey brief, 2023 |
| Knowledge workers who use AI at work (31,000 surveyed, 31 countries) | **3 in 4** | Microsoft and LinkedIn, 2024 Work Trend Index, May 2024 |
| AI users who bring their own AI tools to work | **78%** | Same report |
| US small businesses using generative AI | **58%** (40% in 2024) | US Chamber of Commerce, Empowering Small Business report, Aug 2025 |
| DPIIT-recognised startups in India (mostly small teams) | **2.23 lakh** | Inc42, as of 31 March 2026 |

When most people bring their own AI, **every person's AI starts from zero**, with a different picture of the company.

## 4. Why existing options fall short

| Option | What it does | Gap for small multi-venture teams |
|---|---|---|
| Shared docs and wikis with built-in AI | Documents with an assistant | Knowledge is not separated per venture with roles; the AI does not run tasks or sales under rules |
| Enterprise knowledge search (e.g. Glean, valued at $7.2B in 2025) | Searches a large company's apps | Built and priced for big companies; searches, does not do the work |
| AI sales research platforms (e.g. Clay, valued at $3.1B in Aug 2025) | Lead research for growth teams | No team memory; no proof-backed verdicts with a separate review and a human sender |
| Personal AI memory (ChatGPT / Claude) | One person's assistant remembers that person | Not shared across a team, no permissions, no per-venture separation |
| Markdown files in Git or a shared drive (what we tried) | Shared instructions | Updated by hand (push/pull), go stale, cannot assign or check work |

Big companies buy the pieces. Small teams can't, and they need the whole thing working with the AI they already use.

## 5. Why now

The **Model Context Protocol (MCP)**, released by Anthropic in November 2024, became the common standard for connecting AI assistants to tools and data during 2025 (OpenAI adopted it in March 2025, Google DeepMind in April 2025, and it moved to the Linux Foundation's Agentic AI Foundation in December 2025). For the first time, a team can keep its knowledge in one place and have **each person's own AI read it live, with that person's permissions**, instead of copying files into chats.

## 6. Our solution: Venture OS

A self-hosted team workspace (`Workspace → Ventures → Groups → Channels`) that is also an MCP server for the team's own Claude.

1. **One memory per venture.** Venture context, skills (how we do each task), decisions and knowledge documents live in one place, always current, separated per venture and gated by role.
2. **Read by everyone's Claude through MCP.** Each person connects their own Claude with a personal, scoped, revocable token. Claude reads the venture's context first and can only see and change what that person can.
3. **The AI runs the work.** From one line in chat, Claude can create and assign tasks with an outcome, a definition of done and the proof required, review submitted evidence (never on its own owner's work), set reminders, ask teammates for information, post in channels and send direct messages. Messages it posts are labelled *"via Claude"*, and every write it makes is audited.
4. **Sales with proof (Dealflow).** Claude researches and judges leads against the venture's offer (recommend, hold or reject), attaching a verbatim quote and source URL to every claim; drafts are reviewed in a separate Claude session; **a person always sends** (the app records sends, it does not send). Offers, shared sales notes ("brain") and campaign plays are proposals that a venture head approves in the app.
5. **People stay in control.** Claude does the work; people make the decisions. Access is per venture and per role, sensitive actions need approval, and changes are logged.

## 7. Design principles

- **Claude does the work, people decide.** No message is sent by the system on its own; approvals stay with people.
- **Evidence or nothing.** A sales verdict without a quote and a URL is not a verdict.
- **Least privilege.** The AI acts only as the signed-in person, through the same permission checks as the app.
- **One source of truth.** Knowledge is written once and read live, never copied into chats.
- **Trust inside the team.** If a team can't share context with its own members, the problem is trust, not the AI; the product makes sharing safe with per-venture, per-role access and logs.

## 8. Scope of this submission

This repository contains the working product: web app, API, background worker, shared contracts and domain logic, the two MCP servers (team workspace at `/mcp`, sales at `/mcp/sales`) and a self-hosted deployment. See [README.md](README.md) for the feature list, architecture and how to run and test it.

**Next layers (not in this repository yet):** outbound channel accounts (email, WhatsApp, Instagram, LinkedIn) per venture and person, and a marketing layer.

## 9. How we measure success

- The same question asked by different teammates gets the **same answer**, grounded in the venture's memory.
- Time from "one line in chat" to an assigned, tracked task with a definition of done and required proof.
- Share of sales verdicts that carry a quote and source link (target: 100%), and share of outbound messages sent by a person (target: 100%).
- Fewer "which file is current?" moments: zero manual push/pull of instructions.

## 10. Team

| Name | Role |
|---|---|
| Divyansh | Product manager |
| Adarsh | CTO |
| Ashutosh | Market |
| Jitin | Growth |
