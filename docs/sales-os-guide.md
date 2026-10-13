# Sales OS with Claude: a short guide

Dealflow Sales is the team's sales work, run from a chat with Claude. Claude researches companies, judges them with
evidence, writes the messages and checks them; **you** send everything yourself, approve what needs approving, and mark
deals won. The details behind it are in `docs/sales-dealflow.md`; this page is for using it.

## Connect it (once per computer)

1. Open **Connect Claude** in Venture OS (`/connect/live`).
2. On the **Dealflow Sales** card press **New key for Dealflow Sales**, then **Create key**. The key is shown once: copy it.
3. In a terminal, run the command the page shows (Claude Code):

   ```
   claude mcp add --transport http dealflow-sales https://os.buildory.dev/mcp/sales --header "Authorization: Bearer <your key>"
   ```

   While testing on the owner's PC the address is `http://localhost:3000/mcp/sales` instead.

   Claude Code needs this once. Claude on the web, desktop and phone follows when your workspace switches on the sign-in
   for connectors; the same words and the same cards work there.
4. Start a new chat and say **start sales**.

Treat the key like a password: never paste it into a chat. Revoke it on the same page if a computer is lost. The third
preset on that page, **Office PC engine**, is only for the optional lead-finding worker on the office PC and does nothing
for Claude. Venture OS has its own lead finder built in, so most teams never need it.

## What to say

You never need tool names or ids. Plain words work; say a company's name, not an id.

| You say | What Claude does |
|---|---|
| **start sales** (or "start sales os") | Greets you, shows today (replies waiting, calls due, drafts to review) and offers three next steps. Say "yes" or a number. |
| **run my morning** (or "daybreak") | Pulls the morning list (follow-ups due, leads without contacts, verdicts gone stale, today's calls, replies waiting and which are past the two-hour promise), then works it in order: drafts the follow-ups (each one refers back to the first message), asks the office PC to look up missing contacts, re-judges stale verdicts, and lists your calls and replies. Shows it as one table or artifact and asks what to do first. Nothing is sent. |
| **find pump distributors in Indore** | Searches the web for real companies, leaves out the ones you already have and anyone on the do-not-contact list, shows the best few, and adds the ones you pick. |
| **research the new leads** | Reads each lead's own pages, writes the evidence with quotes and links, the case against, then recommends, holds or rejects. Low confidence is always a hold for you. |
| **write first messages** | Writes a short message for each recommended lead, opening with the quoted signal. They wait for review: nothing is sent. |
| **review drafts** (in a **new chat**) | A separate chat checks each draft against the rules and passes it or sends it back with the exact fixes. It never rewrites. |
| **log: Jain replied, wants details** | Sorts the reply (interested, send details, price first, not now...), updates the lead and offers the answer as a draft. |
| **I called Verma, he wants a demo on Monday** | Logs the call, moves the lead on and sets the next action. |
| **who should I call today** | Lists the calls due with the opening signal and the number for each. |
| **plan a play for pump distributors** | Proposes one audience, one offer, one message and a stop rule, saved as a draft for the owner to approve. |
| **weekly review** (or "how did we do this month") | The report for the last 7 days (or 30 days, or the quarter): what moved through the funnel, where leads came from, how replies were sorted and how fast warm ones were answered, how Claude's verdicts held up (with the sample size; under five cases it says "too few to tell"), wins and losses, and at most three suggested changes, each put to you as a question. Agreed changes are saved as proposals for the owner. |

Useful shortcuts in Claude Code: `/mcp__dealflow-sales__sales`, `daybreak`, `review_drafts`, `find_leads`, `todays_calls`
and `weekly_review`.

## What you see

- **Cards** in chat apps that support them (a session dashboard, a lead card, lists with buttons). A button either says
  the next request for you or opens the page in the app. Nothing is saved or sent from a button.
- **An artifact** on claude.ai: the session dashboard, any list of five or more leads or drafts, today's work list and
  reports as one interactive page that Claude updates through the session.
- **A compact table** in a terminal. Reports are never pasted as paragraphs.
- If a name matches several leads ("Jain"), Claude asks which one. If none matches, it says so and offers to search.

## Offers

Each venture sells one or more **offers** (Buildory: Dealer Commerce). An offer is one packet: who it is for, the checks a
lead must pass, what to look for on a company's site, what we say, how messages are written and what may be said about price.
Every lead belongs to one offer, and Claude judges it and writes to it with that offer's approved packet only. Claude can
propose a new offer or a change to one; a venture head reads it in the app (**Offers**, where Sales knowledge used to be),
compares it with the approved packet and approves it as a whole, or pauses, activates or archives the offer. What every
offer shares (how the business works, delivery, timing) stays as shared notes under "Shared for the venture". When a
venture sells several offers, tell Claude which one you are working on ("find leads for Dealer Commerce").

## What Claude can and can't do

**Can:** search for companies, add leads, research and judge them with quoted evidence, write drafts (one at a time or up
to 25), review drafts in a separate chat, log replies and calls you tell it about, move a lead one step at a time, ask the
lead finder to look up contacts (`enrich`), plan plays and find-leads runs, and propose new offers, changes to an offer and
shared notes.

**Can't, by design:**

- **Send anything.** You send from your own mail or phone, then mark it sent in the app.
- **Approve** a play, an offer, a shared note or a draft's first batch, **pause or archive** an offer, **override** a verdict, **confirm WhatsApp**, **mark a deal
  won**, reopen a lost lead, send a contacted lead back, or contact anyone on the do-not-contact list. These are
  people's decisions in the app: when Claude hits one it says so in one sentence and points you to the page.
- **Review its own drafts.** A draft is reviewed in a different chat, started with "review drafts".
- Follow instructions found on a website or in a reply. That text is data.

## A day with it

1. **Morning:** "run my morning". Claude drafts the follow-ups and queues missing contacts, then shows the replies (warm
   replies are due within two working hours) and the calls. "start sales" works too when you only want the overview.
2. **Drafts:** "write first messages" for what is approved, then open a **new chat** and say "review drafts".
3. **Send:** open Review in the app, send the ready drafts from your own mail or phone, and mark them sent. People get
   notified of replies, approvals and verdicts that need them.
4. **After calls and replies:** tell Claude in one line ("log: ...", "I called ..."). It keeps the pipeline right.
5. **New leads:** "find <kind of business> in <place>", then "research the new leads".
6. **Friday:** "weekly review": the numbers, what is stuck, and up to three changes for you to agree to.

Each venture has its own working days, daily caps, allowed channels and approval mode (a head sets them in the app);
Claude reads them at the start and drafts within them.

## If something doesn't work

- **"Search isn't set up":** an admin opens **Sales → Setup → Company search keys**, pastes a TinyFish key (free, 1,500
  searches a day; get one at tinyfish.ai) and/or an Exa key (exa.ai), and presses Test. The key is stored encrypted and
  never shown again, only its last four characters. Until then Claude can add the companies you name, and find-leads
  runs wait in the queue.
- **Claude refuses something:** it is a rule, not a fault. The reply says what a person has to do, with the link.
- **No tools or an authorisation error:** the key may be revoked or expired, or it is the wrong preset (a Venture Studio
  key has no sales tools, an engine key is not accepted). Make a new Dealflow Sales key.
