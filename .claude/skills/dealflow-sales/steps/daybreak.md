# Daybreak: run my morning

The morning routine ("run my morning", "daybreak", or a scheduled morning run). Claude does the prep work; the person sends,
approves and calls. Nothing is sent, approved or confirmed in this step.

1. Call **`daybreak`** (owner `me` by default; `all` for a venture head covering the team; a `ventureId` for one venture).
   It returns the morning list (follow-ups due with the first message each refers back to, leads without contacts, stale
   verdicts, today's calls with their numbers, replies waiting and which are past the reply promise, drafts and verdicts
   waiting for a person, today's sends against the daily caps), `say` (one line) and `then` (the plan, in order).
2. Work the `then` plan in order, at most 25 leads per call:
   1. No `sessionId` in this chat yet: call `start_sales` (mode `work`) once and keep it.
   2. **Follow-ups:** read each lead's offer packet (`get_offer`: its message rules), then one `save_drafts` call (purpose `follow_up`) for the leads under
      `followUpsDue`. Each follow-up refers back to that lead's `firstTouch` text in one short line (what we asked, not a
      repeat), adds no new pitch, no price and no link, and ends with one easy question. Same channel as the first touch;
      after a call, an email if the lead publishes an email, otherwise a `call_opener`. WhatsApp only with opt-in. One
      follow-up per lead, ever (`steps/draft.md`). The drafts then wait for review in a separate chat.
   3. **Contacts:** one `enrich_lead` call with the leads under `needsContacts` whose `enrichPending` is false. It only queues
      a run; the lead finder built into Venture OS works it (it reads each company's own pages politely).
   4. **Stale verdicts:** only where `claudeCanRejudge` is true, follow `steps/research-and-judge.md` and save with
      `save_verdicts`: fresh quotes, today's date, the case against, decide last; if the signal is gone, hold or reject. A
      verdict a person set stays: tell them.
   5. **Calls and replies:** list them for the person (company, why, the number or what they said, hours waiting; replies
      past the promise first). Drafts to approve and verdicts to decide are theirs in the app: list them with links.
3. If a list says "showing 25 of N", do that batch and call `daybreak` again for the next one. Report honest counts: what was
   drafted, queued and re-judged, what was refused and why (the batch results say per lead).
4. Show the summary as ONE artifact on claude.ai (counts as tiles; calls, replies and approvals as tables with links) or a
   compact text table in a terminal, never as prose. Then ask what to do first, with the replies over the promise as the
   suggestion ("Shall we answer Beta Valves first? They have waited 3 days.").
5. Remind the person, in one line, that the new drafts need a review in a new chat ("review drafts") before they send them.
