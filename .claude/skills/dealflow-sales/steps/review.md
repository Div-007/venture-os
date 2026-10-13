# Review drafts (quality check)

Run this in a chat that did not write the drafts. If you wrote a draft in this chat, say so and skip it.

1. `start_sales` with mode **review** (a fresh chat), then `list_drafts` with status `in_review` and your `sessionId`. Skip any
   draft marked `yours`. Show the waiting drafts as a compact table (company, offer, channel, purpose, words).
2. For each draft read three things only: the draft, the lead's verdict with its quotes (`get_lead`), and the lead's offer packet
   (`get_offer`: its message rules, approved claims and proof words, claims to avoid, price boundary). Open the signal's URL if
   the quote looks doubtful.
3. Check, in order (any miss = fail):
   - the opening signal is really on the lead's page and matches the verdict quote;
   - it asks a question and does not tell them they have a problem;
   - proof uses only the offer's approved words, no claim the offer lists to avoid, no client name, no "live / delivered / in use" claims;
   - no price, date, timeline, number, result, link or attachment (except one wa.me line at the end of an email);
   - exactly one call to action;
   - length and language fit the channel; it reads like a person, not an advert;
   - the lead has not opted out, is not rejected, and this is not a second follow-up;
   - the channel is allowed (WhatsApp only with opt-in) and the venture's settings are respected.
4. `review_draft` (name the lead by `company`, or pass the id): `pass`, or `fail` with each exact fix in `issues`. **Do not rewrite
   the draft yourself**: the writing chat applies the fixes (`revise_draft`) and the draft is reviewed again in a new chat.
5. Report: passed (ready for the person to send from their own mail or phone), sent back with fixes, and anything that needs
   the owner. If the venture's approval mode is "a person reads every message", or the draft belongs to the first batch of a
   play, say each passed draft still needs a person to read it in the app.
