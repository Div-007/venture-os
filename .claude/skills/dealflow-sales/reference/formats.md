# What every save carries (the dealflow-sales tools)

Everything is saved with structured tools, not notes. Keep quotes short (under 25 words) and always with the URL.

## `save_verdict` (one lead) / `save_verdicts` (up to 25)

- `evidence` [{ claim, quote (verbatim), url, seenAt }] — first.
- `gates` [{ gate, result: pass | fail | unclear, note }] — every gate of the lead's offer packet (`get_offer`), in order, by its
  code and rule ("G1 office in the four states"). A failed gate whose `ifFails` is reject means reject; one whose `ifFails` is
  hold means hold, with the gate's question as the open question.
- `scores` { fit, need, access, ability, timing } 1 to 3 each — only when every gate passes.
- `against` — "May <the strongest reason not to contact> …" with its evidence.
- `offer` — the offer by name; leave it out to use the lead's own offer (`get_lead` shows it). A lead with no offer takes the one
  you name; naming another offer than the lead's is refused. `offerFit` — why it fits that offer's packet or not.
- `signal`, `signalSeenAt` — the quoted signal to open with and when it was seen (needed to recommend).
- `contactRoute` — the published business route with its URL, or "none seen". `openQuestion` — what a person should check.
- `decision` recommend | hold | reject, `confidence` low | medium | high, `summary` — decided last. Low confidence is a hold.

Stage after a verdict on a lead nobody contacted: recommend (medium/high) → approved for contact; hold or low confidence →
researched and flagged for a person; reject → disqualified "Not a fit". A failed gate cannot be a recommendation.

## `review_draft`

`result` pass | fail, `issues` (each exact fix; required on fail), `notes`. Checks, against the lead's offer packet (`get_offer`;
`list_drafts` shows each lead's offer): signal matches the source | asks not tells | the offer's proof words only, no claim to avoid |
no price beyond the offer's price boundary, no date or number | no link or attachment (except one wa.me line on emails) | one CTA |
the offer's message rules (length, structure) | channel, language and venture settings | tone. Never rewrite the draft.

## `propose_offer`

`ventureId`, `offer` (an existing offer's name for its next version; leave it out for a new offer), `name`, `change` (what changed
and why, for the approver) and the WHOLE `packet` (start from `get_offer` with `proposalPackets` true; never a patch):
`summary` (one line: what is sold, to whom); `whoFor` { description, industries, customerTypes, places, companySizes, buyerRoles };
`gates` [{ code like G1, rule, ifFails: reject | hold, note }]; `signals` { lookFor [{ phrase, meaning }], searchWords, negatives };
`exclusions`; `say` { valueProposition, pitchAngles, proofWords, approvedClaims, claimsToAvoid }; `messages`; `price`; `scoring`;
`notes`. Only what the owner said or the approved packet holds: never invent claims. A venture head approves it as a whole.

## `add_leads`, `plan_find_run`, `find_leads`, `update_lead`

`offer` names the offer (case doesn't matter). A venture with several active offers needs it on `add_leads` and `plan_find_run`
(with one, it is the default). `find_leads` takes `offer` (or `none`); `update_lead` with `offer` moves a lead to another offer.

## `propose_play`

`name`, `offer` (the offer's name; it fills `offerName`), `audience` (who, where, which signal; from the offer's packet), `batchSize`, `steps` [{ day, channel, action }]
(for example day 0 email first message; day 4 one follow-up; stop on any reply), `hypothesis`, `metric`, `stopRule`.

## `log_reply`

`replyType` is one of: interested, send_details, price_first, not_now, wrong_person, has_system, opt_out, unclear, hostile (silence is
not logged). `body` is their words, copied short. The app sets the stage, next action and do-not-contact list.

## `daybreak` and `weekly_report` (read only)

`daybreak`: `counts`, the lists (`followUpsDue` with `firstTouch`, `needsContacts` with `enrichPending`, `staleVerdicts` with
`claudeCanRejudge`, `callsToday` with `numbers`, `repliesWaiting` with `waitingHours` and `overPromise`), `forYouInTheApp`,
`sentToday`, and `then` (the plan, in order; at most 25 per call). `weekly_report`: `funnel`, `sources`, `plays`, `cities`,
`replyTypes`, `speed`, `calibration` (`grid` rows carry `n` and `small`), `winsLosses`, `stuck`. Rates read "40% (4 of 10)" or
"too few to tell (2 of 3)".

## Results always carry

`say` (one or two plain sentences for the person) and `next` (up to three options, the first is the suggestion). Show them, then end on
one plain next step.
