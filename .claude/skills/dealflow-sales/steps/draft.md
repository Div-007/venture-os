# Draft a message

Only for a lead whose latest verdict says recommend (or an answer to a reply the lead sent).

1. `get_lead` (company): the verdict, the signal to open with, the published contact route, the timeline (what was already
   sent, any reply). Never draft a second follow-up, and never draft to a lead that opted out, is closed or is waiting for a
   person's decision (the tool refuses those).
2. From the lead's offer packet (`get_offer`) take the message rules, the template the verdict named, the approved claims and
   proof words, the claims to avoid and the price boundary (`get_brain` has the venture's shared notes). If something you need
   is missing, say what is missing instead of inventing wording. Respect the venture settings line: only allowed channels,
   daily caps, and the language/send window.
3. Channel: the first allowed channel the lead publishes (default email; WhatsApp only when the lead opted in, and only a person
   records that; LinkedIn is always sent by hand). Email may end with one `wa.me` line to invite a WhatsApp reply.
4. Write from the template: line 1 is the observed signal (it must match the verdict's quote); then a question; then what we do
   in one plain sentence; then proof only in the approved words; then one call to action. No price, no links (except the one
   wa.me line on an email), no attachments. Personalise only from the evidence. Keep to the channel's length (Buildory: email
   about 100 words, WhatsApp about 60).
5. `save_draft` (name the lead by `company`; channel, subject, body). For many leads `save_drafts` (up to 25, partial success
   per lead). Tell the person the word count and that it needs a review in a **new chat** ("review drafts") before it goes
   out. Do not review it yourself.

A **reply** draft (`purpose` reply) answers the lead's latest message; no id is needed. Warm replies are due within the
venture's reply window: say so. A follow-up is the one allowed per lead, after the venture's follow-up days.

For a play with two variants, draft each lead in its assigned variant and put "variant A" or "variant B" at the start of the
subject line (the person removes it when sending).
