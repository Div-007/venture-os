# Weekly review and suggestions

Read-only except for brain proposals the person agrees to. Present it as a visual report (an artifact on claude.ai, a compact
table in a terminal: tiles or a table for the numbers, a table for sources, plays and the calibration grid), never as prose.

1. Call **`weekly_report`** (range `week` by default; `30d` or `quarter` when asked; owner `all` unless the person wants only
   their own leads; a `ventureId` for one venture). It returns the funnel (what moved and how far), the top sources, plays and
   cities, reply types and call outcomes, reply speed against the venture's promise, Claude's calibration grid (with `n` and
   the small-sample flags), overrides, wins and losses, the leads stuck longest, `say` (the three sentences that matter) and
   `next` (up to three changes, put as questions for the owner).
2. Add `list_plays` for each play's status and results, and `get_lead` for any override or stuck lead you name.
3. Honest numbers: where the report says "too few to tell" (under 5 cases) or "small sample" (under 30), say so plainly and
   never present it as a trend. For high-touch ventures judge plays by account progress (replies, calls, proposals, wins), not
   by rates. Rough outside yardsticks (weak): replies about 3-5% of sends on average and more for small, well-researched lists;
   meetings 0.5-2.5% of sends.
4. Check Claude's own judgement from the calibration grid: of the leads Claude recommended and that were contacted, how many
   replied, by confidence; which verdicts people overrode and what happened to those leads.
5. Offer the `next` questions (at most three, each tied to a number). When the owner agrees to one, save it as a proposal for a
   venture head to approve in the app: a change to who an offer is for, its gates, signals, wording or price with
   `propose_offer` (the whole packet: start from `get_offer` with `proposalPackets`), background shared by every offer with
   `propose_brain_change`, a new play with `propose_play`.
6. The page: numbers, what worked, what is stuck (company names), Claude's hit rate, the suggested changes, next week's play.
