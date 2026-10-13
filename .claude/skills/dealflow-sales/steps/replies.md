# Replies, calls and what happened

1. Name the lead by company (every tool accepts it); if several match, ask which. `get_lead` shows its timeline.
2. A person says they sent something: they mark it sent in the app (you can't). Remind them the one follow-up is due after the
   venture's follow-up days.
3. Sort a reply into one type with `log_reply` (channel, their words in `body` copied short, `replyType`):

| Type | Looks like | The app does, then you |
|---|---|---|
| interested | "yes, tell me", "how does it work", "call me" | next action to book the call (2 working hours); draft two call slots |
| send_details | "send brochure / details" | next action "Send details"; draft a short summary and the call offer, no attachment |
| price_first | "how much?" | next action; draft the approved price wording only (the lead's offer packet: `get_offer`), then the call offer |
| not_now | "later", "after the season" | check-back in 30 days; thinking if it was at replied; nothing to send unless asked |
| wrong_person | "talk to the owner" | next action "Find the right person"; draft a short note asking who and the right route |
| has_system | names a tool | ask what it does badly; if fully covered, set the lead lost "has system" (`update_lead`) |
| opt_out / hostile | "stop", "how did you get my number" | closed and on the do-not-contact list; nothing more is written. A person may apologise by hand |
| unclear | emoji, off-topic | clarify once, then treat it as silence |

   **Silence** is not a reply: don't log it. The follow-up date tracks it; after the one follow-up the person sets the lead lost
   ("no response").
4. A WhatsApp message from the lead does not switch WhatsApp on by itself: a person confirms it in the app (the Inbox, or Confirm
   WhatsApp on the lead). Until then answer by email. Same for "yes to WhatsApp" on a call.
5. Draft the answer with `save_draft` (purpose `reply`, no id needed) from the approved wording, and say it needs a review in a new
   chat. Warm replies are due within the venture's reply window.
6. After a call the person tells you how it went: `log_call` (outcome: interested_book, send_details, call_back, no_answer, busy,
   not_interested, wrong_person, wrong_number, yes_whatsapp) with what they learned in `note`: their process, the problem in
   their words, who decides, the next step with a date. Offer a summary draft to send within 24 hours. `update_lead` sets a
   next action, value and currency, or a stage one step forward. Winning a deal is the person's decision in the app.
