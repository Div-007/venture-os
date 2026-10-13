# Sales offers: one packet per offer

A venture sells one or more **offers**. Buildory, for example, sells Dealer Commerce (catalog-to-order systems for dealer-led
suppliers) and could add a startup tech-partner offer. Each offer is one **packet**: who it is for, the gates a lead must pass,
the signals the lead finder looks for, what we say, the message rules and the price boundary. Every lead belongs to an offer. Claude
judges it against that offer's approved packet (plus the venture's shared notes), and the lead finder searches with it.

Contracts: `packages/contracts/src/sales-offers.ts` (packet, versions, offer), plus `offerId` on leads, verdicts, plays, find
runs, the lead list filter and facets, and the bulk "offer" action in `packages/contracts/src/sales.ts`.

## Data

- `sales_offers`: one document per offer: `{ _id, workspaceId, ventureId, name, state: active | paused | archived,
  approvedVersionId?, createdBy, createdAt, updatedAt }`. An offer with no approved version shows as **Draft** and can't be used.
- `sales_offer_versions`: every version of a packet: `{ _id, offerId, workspaceId, ventureId, version, status: draft | approved |
  archived, name, packet, change, proposedBy, via: app | claude | import, approvedBy?, approvedAt?, archivedAt?, archivedBy?,
  createdAt, updatedAt }`.
- **Approving a draft version** (a venture head or admin, in the app, never Claude) does three things in one `atomic` step:
  archives the version approved before, sets `offer.approvedVersionId`, and copies the version's name to the offer.
- **Shared notes** stay in `sales_brain_items`, kind `notes` (and `venture_settings`): background every offer of the venture uses.
  The kinds `offer`, `target_profile` and `message_rules` are legacy: the migration moves them into offers, and new proposals of
  those kinds are refused with a pointer to offers.
- **Leads** (`opportunities.offerId`): the offer the lead is pursued for. A new lead with no offer named gets the venture's only
  usable offer (active, with an approved version), if there is exactly one. The offer must belong to the lead's venture, and must
  not be archived.
- **Verdicts** store `offerId`, defaulting to the lead's offer. A verdict for a lead with no offer sets the lead's offer. A verdict
  naming a different offer than the lead's is refused: change the lead's offer first.
- **Plays** store `offerId` (its name fills `offerName`). **Find runs** store `offerId`; with none named, the venture's only usable
  offer. **Bulk** `{ action: "offer", offerId }` moves leads to an offer.

## API (`/v1/sales`, session or dev header; Claude through the connector)

| Method | Path | Who / what |
|---|---|---|
| GET | `/offers?ventureId` | anyone who can open the venture: `Offer[]` (approved version, proposals, counts) |
| GET | `/offers/:id` | one `Offer`, plus `history` (archived versions, newest first, up to 20) |
| POST | `/offers` | a writer in the venture, or Claude: a new offer (with a draft v1), or with `offerId`, a new draft version → 201 the version |
| PATCH | `/offers/versions/:versionId` | edit a draft: its proposer or a venture head |
| POST | `/offers/versions/:versionId/approve` | a venture head or admin, app only (never Claude) |
| POST | `/offers/versions/:versionId/discard` | archive a draft: its proposer or a venture head |
| POST | `/offers/:id/state` | `{ state }` active, paused or archived: a venture head or admin, app only |

The lead list takes `offerId` (an id, or `none`); the facets add `offers: [{ value: id, name, count }]` and `notSet.offers`. The
overview and reports take an optional `offerId` filter. CSV export adds an "Offer" column, and import maps an "Offer" column by
name.

## Claude (the Dealflow Sales connector)

- `list_offers` (venture): name, state, summary, approved version, counts, pending proposals.
- `get_offer` (`offer` name or `offerId`): the full approved packet, the proposals waiting, and the titles of the shared notes.
- `propose_offer` (`ventureId`, `offer` = an existing offer's name for a new version or leave out for a new one, `name`, `packet`,
  `change`, `sessionId`): a draft that a venture head approves in the app.
- `get_brain`: the shared notes, plus the venture's offers by name ("judge with get_offer").
- `propose_brain_change`: shared notes only; offer kinds point to `propose_offer`.
- `start_sales`: `offers` with name, state, summary and lead counts; the guidance names the offer to work on.
- `find_leads`, `add_leads`, `update_lead`, `plan_find_run`, `save_verdict(s)`: an `offer` (name) parameter. A venture with
  several usable offers must name one for `add_leads` and `plan_find_run`.
- `get_lead`, `list_drafts` and the review show each lead's offer name.

## The lead finder

A find run's offer drives the search (`apps/api/src/sales/finder`):
- **No searches in the plan:** the categories default to the packet's industries and the places to its places.
- **Search words:** taken from `signals.searchWords`, falling back to "dealer enquiry", "manufacturer" and "distributor" when there
  are none.
- **Before any page is read:** results whose title or snippet matches `signals.negatives` are dropped.
- **On each page:** it looks for the packet's `signals.lookFor` phrases (quoted verbatim, preferred over the built-in dealer
  patterns), and guesses the category from the plan and the packet's industries.
- **New leads** get the run's `offerId`.

A run without an offer works as before, and its leads get the venture's only usable offer when there is one.

## Screens

- **Sales knowledge** becomes **Offers**: one card per offer (state, summary, leads, proposals waiting), "New offer", and a
  "Shared for the venture" section holding the notes.
- **Offer page:** the packet as readable sections (Who it's for, Gates, Signals, What we say, Messages, Price, Scoring, Notes).
  From there you can propose a change (a structured editor), compare a proposal with the approved packet, approve it as a whole,
  and pause, activate or archive the offer.
- **Leads:** an Offer filter, an offer chip on each row when the venture has more than one offer, the offer in the lead drawer
  (changeable), and "Move to offer" in the bulk bar.
- **Find leads, Plays and Sales setup:** Find leads and Plays pick the offer, and Sales setup checks that the venture has an
  approved offer.

## Migration (`apps/api/scripts/migrate-offers.ts`, dev database guards, backup first, `--dry-run`, safe to run twice)

For each venture with approved items of the legacy kinds (offer, target_profile, message_rules), it creates one offer:
- **The offer:** named after the approved offer item (Buildory: "Dealer Commerce").
- **v1, approved:** mapped mechanically from the approved items, keeping their approval.
  - The offer item gives `summary` and `say.*`.
  - The batch-1 target profile gives `whoFor` lists, the gates G1 to G9, `signals.lookFor` and the exclusions.
  - The message rules give `messages`; the rubric gives `scoring`.
  - The other target profiles' text goes into `notes`, trimmed to fit.
- **v2, draft by Claude:** from `apps/api/scripts/offer-packets/buildory-dealer-commerce-v2.json`, for Buildory.
- **The legacy items:** the approved legacy-kind items and the rubric note are archived with `replacedBy` = the v1 id. Draft brain
  proposals of the legacy kinds, and the drafted rubric proposal, are discarded, because v2 carries them.
- **Every link:** every lead of the venture (deleted ones included), every verdict, play and find run gets the offer's id.
