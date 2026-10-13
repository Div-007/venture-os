# Research and judge a lead

One lead, or a batch ("research the new leads"). For a batch take leads from `find_leads` (venture, `offer`, verdict `none`,
sort `relevance`): one offer per batch, and skip any that already have a verdict. Read the leads' offer first with
`get_offer` (who it is for, the gates with what a failure means, the signals, the exclusions and the scoring), the venture's
shared notes with `get_brain`, and the venture settings line from `start_sales`. A lead is judged against its own offer:
`get_lead` shows which.

## Research (depth depends on the venture's motion)

- **High-touch:** `get_lead` for what is known, then read the home, about, products, dealer/partner and contact pages with
  your web fetch (it keeps link targets). Use your own web search only to confirm facts, always with the URL. Find: what
  they sell and to whom, how they sell (dealers, distributors, direct, online), the strongest signal for our offer, a
  why-now trigger, the likely decision-maker role, and the published business contact route.
- **Volume:** the lead's facts and at most one page; identity, one signal, one fit reason, contact route. Go deep only when
  the lead scores in the top band or replies later.

Contact routes often hide in link targets (`mailto:`, `tel:`, `wa.me`) that page text does not show. If the text shows no
route, fetch the contact page yourself before calling the contact gate unclear. A site line like "send us your requirements"
next to a WhatsApp link counts as an invitation to WhatsApp. Add routes you found with `update_lead` (`addContactRoutes`,
each with its source page). Write "none seen" for anything you did not see. Quotes are short and come with their URL.

## Judge, in this order

1. **Evidence first:** every claim with a verbatim quote and the URL (`evidence`).
2. **Gates** from the offer's packet, in order, each pass / fail / unclear with a quote. A failed gate whose `ifFails` is
   reject = reject; one whose `ifFails` is hold = hold with its question. Unclear on a deciding gate = hold with a question.
   Then the packet's exclusions.
3. **Scores** (1 to 3 each, as the packet's scoring says) only if every gate passes. A score sorts; it never overrides a gate.
4. **Against:** the strongest honest reason NOT to contact this lead, starting "May…", with evidence.
5. **Decide last:** recommend / hold / reject with confidence. Low confidence, a national brand, a possible rival of a
   reference client or conflicting evidence = hold, with the open question.
6. The **signal to open with** (quoted, with the date seen) and the contact route. A recent trigger beats an old one.

Save with `save_verdict` (name the lead by `company`; leave `offer` out: it is the lead's own offer); for the volume motion
`save_verdicts` takes up to 25 and reports per lead. A lead with no offer yet takes the one you name. If a lead clearly fits
another offer of the venture better, don't judge it against that one: say so, and move it only when the person agrees
(`update_lead` with `offer`). Recommend (medium or high) moves a lead nobody contacted to approved for contact; hold or low confidence leaves
it researched and flags it for a person; reject disqualifies it as "Not a fit". You cannot override a verdict, and a
verdict a person set or overrode is not replaced: tell them what you found instead.

For a batch, report a compact table (company, verdict, confidence, one reason) and the count left. Ask before judging more
than 10 in one go.
