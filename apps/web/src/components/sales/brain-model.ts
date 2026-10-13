import type { BrainItem } from "@venture-studio/contracts";

// Pure helpers for brain items (the shared notes on the Offers page): which proposal replaces which approved item.

export const isApproved = (item: BrainItem) => item.status === "approved";
export const isProposal = (item: BrainItem) => item.status === "draft";
export const sameTitle = (a: BrainItem, b: BrainItem) => a.kind === b.kind && a.title.trim().toLowerCase() === b.title.trim().toLowerCase();

/** Items still in play (archived ones are history). */
export const liveItems = (items: readonly BrainItem[]) => items.filter((item) => item.status !== "archived");

/** The approved item a proposal would replace (same kind and title). */
export const approvedTwin = (item: BrainItem, items: readonly BrainItem[]) => isProposal(item) ? liveItems(items).find((other) => isApproved(other) && sameTitle(other, item)) : undefined;
/** Proposals waiting to replace an approved item. */
export const proposalsFor = (item: BrainItem, items: readonly BrainItem[]) => isApproved(item) ? liveItems(items).filter((other) => isProposal(other) && sameTitle(other, item)) : [];
/** The other approved items a proposal consolidates (its `replaces`, besides its same-title twin): approving it retires them too. */
export const retiredBy = (item: BrainItem, items: readonly BrainItem[]) => isProposal(item) && item.replaces?.length ? liveItems(items).filter((other) => isApproved(other) && item.replaces!.includes(other.id) && !sameTitle(other, item)) : [];
