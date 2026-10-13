# Plan a play (a campaign for one venture)

A play is one audience + one offer + one template + one sequence, run as a batch and judged on results. The owner approves a
play once in the app; after that the batch runs lead by lead.

1. Pick the offer the play sells and read its packet (`get_offer`: who it is for, gates, signals, message rules, price), the
   venture's shared notes (`get_brain`) and settings, and the last results: `list_plays` (read
   existing plays so you don't repeat a failed one) and `sales_overview` / `find_leads` by stage to see what happened to earlier
   batches.
2. Propose **one** play:
   - the audience slice with the strongest signal you can actually find (a signal people show on their own site or public pages,
     not a category guess);
   - batch size from the motion: high-touch 5-20 leads, one message version, judged by how far each account moves (reply, call,
     proposal); volume 50-200 leads, optionally two variants, but treat differences as hints until each variant has about 500 sends;
   - the sequence from the venture's message rules and settings (default: first message day 0, one follow-up after the follow-up
     days, stop on any reply from anyone at that company, opt-out ends everything);
   - for a new audience or play, say that a person reads every message of its first batch before it goes out;
   - one metric and a stop rule (for example: pause if fewer than 1 qualified reply per 25 sends).
   Respect client capacity and the venture's daily caps: don't plan more conversations than can be served.
3. Show the play in under 12 lines (a small table) and ask "Save this play for the owner to approve?" On yes, `propose_play`
   (`offer` by name, audience, hypothesis, metric, stop rule, batch size, steps). It is saved as a draft: say the owner approves it in the app.
4. Next step: find or pick the leads for it (`steps/find-leads.md`; `plan_find_run` can take the play by name).
