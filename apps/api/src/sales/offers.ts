// Offers (packages/contracts/src/sales-offers.ts): each venture sells one or more offers, each one packet. An offer lives in two collections:
// `sales_offers` holds one document per offer (its name, state and the id of its approved version) and `sales_offer_versions` holds every
// version of its packet (draft, approved, archived). Claude judges a lead, and the lead finder searches, with the offer's approved packet.
// See docs/sales-offers.md.
import type { ClientSession, Document } from "mongodb";
import { EXIT_STAGES, WON_STAGES, offerPacketSchema, type OfferPacket } from "@venture-studio/contracts";
import type { AppDb, AppDocument } from "../db.js";
import { AppError } from "../errors.js";
import { canSeeVenture, notFound } from "./access.js";
import type { SalesCtx } from "./ctx.js";
import { present } from "./present.js";

export const OFFERS = "sales_offers";
export const OFFER_VERSIONS = "sales_offer_versions";
/** Offer names compare without case, matching the unique index on { workspaceId, ventureId, name } (indexes.ts). */
export const OFFER_NAME_COLLATION = { locale: "en", strength: 2 } as const;

/** Brain kinds that now live in offers: new proposals of them are refused, and so is approving an old draft of one. */
export const LEGACY_BRAIN_KINDS: ReadonlySet<string> = new Set(["offer", "target_profile", "message_rules"]);
export const LEGACY_KIND_REFUSAL = "Offers, target profiles and message rules now live in offers, one packet per offer: propose a new offer or a new version of one (Offers in the app; Claude uses propose_offer). The brain keeps the venture's shared notes and settings.";

const CLOSED_STAGES = [...EXIT_STAGES, ...WON_STAGES, "won"];

export type ApprovedOffer = { offer: AppDocument; version: AppDocument; packet: OfferPacket };

/** The offer with its approved packet, or null when the offer doesn't exist in this workspace or has no approved version yet. */
export async function approvedOffer(db: AppDb, workspaceId: string, offerId: string): Promise<ApprovedOffer | null> {
  const offer = await db.collection(OFFERS).findOne({ _id: offerId, workspaceId });
  if (!offer || typeof offer.approvedVersionId !== "string") return null;
  const version = await db.collection(OFFER_VERSIONS).findOne({ _id: offer.approvedVersionId, workspaceId, offerId, status: "approved" });
  if (!version) return null;
  const parsed = offerPacketSchema.safeParse(version.packet);
  return parsed.success ? { offer, version, packet: parsed.data } : null;
}

/** The venture's offers that new leads, verdicts and find runs may use: active ones with an approved version. */
export async function usableOffers(db: AppDb, workspaceId: string, ventureId: string): Promise<AppDocument[]> {
  return db.collection(OFFERS).find({ workspaceId, ventureId, state: "active", approvedVersionId: { $type: "string" } }).sort({ name: 1 }).toArray();
}

/** The offer a new lead gets when none is named: the venture's only usable offer, else none (a person or Claude picks). */
export async function defaultOfferId(db: AppDb, workspaceId: string, ventureId: string): Promise<string | undefined> {
  const usable = await usableOffers(db, workspaceId, ventureId);
  return usable.length === 1 ? String(usable[0]!._id) : undefined;
}

/** A Mongo clause for the leads of one offer (`none`: the leads with no offer); empty without a filter. `field` is "lead.offerId" after a lookup. */
export const offerClause = (offerId: string | undefined, field = "offerId"): Document => (!offerId ? {} : { [field]: offerId === "none" ? null : offerId });

// ---- Loading, with the access rules ---------------------------------------------------------------------------------------

/** An offer the actor can open (any state), or 404: another workspace, or a venture that isn't theirs, look the same. */
export async function loadOffer(ctx: SalesCtx, id: string, session?: ClientSession): Promise<AppDocument> {
  const offer = await ctx.db.collection(OFFERS).findOne({ _id: id, workspaceId: ctx.workspaceId }, { session });
  if (!offer || !canSeeVenture(ctx.actor, offer.ventureId)) throw notFound("Offer");
  return offer;
}

/** One version of an offer's packet the actor can open, or 404. */
export async function loadOfferVersion(ctx: SalesCtx, id: string): Promise<AppDocument> {
  const version = await ctx.db.collection(OFFER_VERSIONS).findOne({ _id: id, workspaceId: ctx.workspaceId });
  if (!version || !canSeeVenture(ctx.actor, version.ventureId)) throw notFound("Offer version");
  return version;
}

/** Another offer of the venture with this name (any case), if there is one. */
export async function offerNamed(db: AppDb, workspaceId: string, ventureId: unknown, name: string, except?: unknown): Promise<AppDocument | null> {
  return db.collection(OFFERS).findOne({ workspaceId, ventureId, name, ...(except ? { _id: { $ne: String(except) } } : {}) }, { collation: OFFER_NAME_COLLATION });
}

// ---- Checks for the records that name an offer ----------------------------------------------------------------------------

/** The offer a lead or a play names: one of the same venture, and not archived; 400 otherwise. Returns the offer. */
export async function assertVentureOffer(ctx: Pick<SalesCtx, "db" | "workspaceId">, ventureId: unknown, offerId: string, session?: ClientSession): Promise<AppDocument> {
  const offer = await ctx.db.collection(OFFERS).findOne({ _id: offerId, workspaceId: ctx.workspaceId }, { session, projection: { ventureId: 1, name: 1, state: 1, approvedVersionId: 1 } });
  if (!offer || offer.ventureId !== ventureId) throw new AppError(400, "BAD_REQUEST", "That offer does not belong to this venture");
  if (offer.state === "archived") throw new AppError(400, "BAD_REQUEST", `The offer "${String(offer.name)}" is archived: pick an active offer`);
  return offer;
}

/** The offer a find run searches with: one of the venture that is active and has an approved packet. */
export async function assertUsableOffer(ctx: Pick<SalesCtx, "db" | "workspaceId">, ventureId: unknown, offerId: string): Promise<AppDocument> {
  const offer = await assertVentureOffer(ctx, ventureId, offerId);
  if (typeof offer.approvedVersionId !== "string") throw new AppError(409, "CONFLICT", `The offer "${String(offer.name)}" has no approved packet yet: a venture head approves one in the app before it is used`);
  if (offer.state !== "active") throw new AppError(409, "CONFLICT", `The offer "${String(offer.name)}" is paused: a venture head activates it in the app before it is used`);
  return offer;
}

/**
 * The offer a verdict is judged against: the one it names (which must be the lead's own offer when the lead has one), else the lead's,
 * else the venture's only usable offer. That offer needs an approved packet and must not be archived. `setOnLead` says the lead had no
 * offer and takes this one. No offer at all (a venture without offers) leaves the verdict as before: its free-text `offer` only.
 */
export async function verdictOffer(ctx: SalesCtx, lead: AppDocument, named: string | undefined): Promise<{ offerId?: string; setOnLead: boolean }> {
  const current = typeof lead.offerId === "string" ? lead.offerId : undefined;
  if (named && current && named !== current) {
    const names = new Map((await ctx.db.collection(OFFERS).find({ _id: { $in: [named, current] }, workspaceId: ctx.workspaceId }, { projection: { name: 1 } }).toArray()).map((row) => [String(row._id), String(row.name)]));
    throw new AppError(409, "CONFLICT", `This lead is pursued for ${names.has(current) ? `"${names.get(current)}"` : "another offer"}, not ${names.has(named) ? `"${names.get(named)}"` : "that one"}: change the lead's offer first, then judge it against the new one`);
  }
  const offerId = named ?? current ?? await defaultOfferId(ctx.db, ctx.workspaceId, String(lead.ventureId));
  if (!offerId) return { setOnLead: false };
  const offer = await ctx.db.collection(OFFERS).findOne({ _id: offerId, workspaceId: ctx.workspaceId }, { projection: { ventureId: 1, name: 1, state: 1, approvedVersionId: 1 } });
  if (!offer || offer.ventureId !== lead.ventureId) throw new AppError(400, "BAD_REQUEST", "That offer does not belong to this lead's venture");
  if (offer.state === "archived") throw new AppError(409, "CONFLICT", `The offer "${String(offer.name)}" is archived: move the lead to an active offer before judging it`);
  if (typeof offer.approvedVersionId !== "string") throw new AppError(409, "CONFLICT", `The offer "${String(offer.name)}" has no approved packet yet: a venture head approves one in the app before leads are judged against it`);
  return { offerId, setOnLead: !current };
}

/** Offer names by id (any state), for lists and files that show the offer by name. */
export async function offerNames(db: AppDb, workspaceId: string, ids: unknown[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (!wanted.length) return new Map();
  return new Map((await db.collection(OFFERS).find({ _id: { $in: wanted }, workspaceId }, { projection: { name: 1 } }).toArray()).map((row) => [String(row._id), String(row.name)]));
}

// ---- As API JSON ----------------------------------------------------------------------------------------------------------

/** One version as the contract shows it (offerVersionSchema). */
export function versionJson(version: AppDocument): Record<string, unknown> {
  const { _id, offerId, workspaceId, ventureId, version: number, status, name, packet, change, proposedBy, via, approvedBy, approvedAt, archivedAt, archivedBy, createdAt, updatedAt } = version;
  return present({ _id, offerId, workspaceId, ventureId, version: number, status, name, packet, change: change ?? "", proposedBy, via, approvedBy, approvedAt, archivedAt, archivedBy, createdAt, updatedAt });
}

/**
 * Offers as the contract shows them (offerSchema): the approved version (null while there is none), the drafts waiting (newest first)
 * and the counts: live leads, open ones (not won, lost or disqualified) and plays.
 */
export async function offersJson(ctx: Pick<SalesCtx, "db" | "workspaceId">, offers: AppDocument[]): Promise<Record<string, unknown>[]> {
  if (!offers.length) return [];
  const ids = offers.map((offer) => String(offer._id));
  const approvedIds = offers.map((offer) => offer.approvedVersionId).filter((id): id is string => typeof id === "string");
  const [versions, leadRows, playRows] = await Promise.all([
    ctx.db.collection(OFFER_VERSIONS).find({ workspaceId: ctx.workspaceId, $or: [{ _id: { $in: approvedIds } }, { offerId: { $in: ids }, status: "draft" }] }).sort({ version: -1 }).toArray(),
    ctx.db.collection("opportunities").aggregate<{ _id: string; leads: number; open: number }>([
      { $match: { workspaceId: ctx.workspaceId, deletedAt: null, offerId: { $in: ids } } },
      { $group: { _id: "$offerId", leads: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$stage", CLOSED_STAGES] }, 0, 1] } } } },
    ]).toArray(),
    ctx.db.collection("sales_plays").aggregate<{ _id: string; plays: number }>([{ $match: { workspaceId: ctx.workspaceId, offerId: { $in: ids } } }, { $group: { _id: "$offerId", plays: { $sum: 1 } } }]).toArray(),
  ]);
  const leads = new Map(leadRows.map((row) => [String(row._id), row]));
  const plays = new Map(playRows.map((row) => [String(row._id), row.plays]));
  return offers.map((offer) => {
    const id = String(offer._id);
    const approved = versions.find((version) => version._id === offer.approvedVersionId && version.status === "approved");
    return {
      ...present({ _id: offer._id, workspaceId: offer.workspaceId, ventureId: offer.ventureId, name: offer.name, state: offer.state, createdBy: offer.createdBy, createdAt: offer.createdAt, updatedAt: offer.updatedAt }),
      approved: approved ? versionJson(approved) : null,
      proposals: versions.filter((version) => version.offerId === id && version.status === "draft").map(versionJson),
      counts: { leads: leads.get(id)?.leads ?? 0, open: leads.get(id)?.open ?? 0, plays: plays.get(id) ?? 0 },
    };
  });
}

export const offerJson = async (ctx: Pick<SalesCtx, "db" | "workspaceId">, offer: AppDocument) => (await offersJson(ctx, [offer]))[0]!;
