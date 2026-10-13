# Find leads for a venture or play

Finding is not judging: add candidates here, judge them in `steps/research-and-judge.md`.

1. Decide the venture and the offer (ask once if unclear: `start_sales` says which offer to work on, `list_offers` lists them;
   never mix ventures or offers in one batch). Read the offer's packet (`get_offer`) and write the audience in plain words from
   it: who it is for, the places, the industries, the signals to look for and the negatives that rule a company out. Ask the
   person for the area and the kind of business in one question when they have not said.
2. Check what exists first: `find_leads` (venture, city, `q`), so you never re-add a known, rejected or opted-out company.
3. Search: `search_companies` (query in plain words, e.g. "pump distributors in Indore"; `country`; `ventureId`). It uses
   TinyFish and Exa, leaves out directories, companies already in the pipeline and anyone on the do-not-contact list, and
   stores nothing. Say how many searches you run (each costs). Page through with `page` only when the first page is thin.
   If it says search isn't set up, tell the person an admin adds a TinyFish or Exa key in Sales setup, and meanwhile take
   the companies the person names.
   For a bigger search (many places or kinds of business), offer `plan_find_run` with the `offer`: the lead finder built into
   Venture OS works the run in the background with that offer's packet (its places and industries when you give no searches,
   its search words and negatives, and its look-for phrases quoted from each site), then the company's own pages, respecting
   robots.txt; the leads it adds get the offer. Set `queue` true only when the person asked to run it.
4. Show the best few as a compact table (company, domain, what the page says) and ask which to add.
5. Add the ones picked with `add_leads` (up to 25 per call) and the `offer` they are for (needed when the venture sells
   several active offers): `companyName`, `website` (their own), `city`, `category`,
   `source` (the page you found them on) and `observedSignal` in their words. Contact routes only if the company publishes
   them on its own site or an official listing, each with the page it came from. No personal profiles, no guessed emails.
6. To have the lead finder fill in published contacts and evidence for leads you added: `enrich_lead` (it queues a run;
   check it later with `list_find_runs`).
7. Report: how many found, how many added, how many skipped as known or do-not-contact, then the next step ("Shall I judge
   the first 10?").

Never use LinkedIn, Instagram or any logged-in source, never bypass a block, never guess contacts.
