// Deal money for Sales: the column/list totals (value and weighted value by currency) and the Overview's pipeline numbers
// (open value, weighted forecast by expected close month, won this month). Money is stored in minor units (paise, cents).
// Weighted value is value x probability, where a lead's own probability beats its stage's default (STAGE_PROBABILITY).
import type { Document } from "mongodb";
import type { z } from "zod";
import { LEGACY_STAGE_MAP, STAGE_PROBABILITY, WON_STAGES, type pipelineValueQuerySchema } from "@venture-studio/contracts";
import { ventureScope } from "./access.js";
import type { SalesCtx } from "./ctx.js";
import { DEFAULT_CALENDAR, localMoment, SALES_TZ } from "./workdays.js";

/** Stage names as stored: the current ones, plus the older names rows not yet migrated can still carry. */
const STORED_STAGE_PROBABILITY: Record<string, number> = { ...STAGE_PROBABILITY, ...Object.fromEntries(Object.entries(LEGACY_STAGE_MAP).map(([old, current]) => [old, STAGE_PROBABILITY[current]])) };
/** Aggregation expression: the lead's own probability, else its stage's default. */
const PROBABILITY: Document = { $ifNull: ["$probability", { $switch: { branches: Object.entries(STORED_STAGE_PROBABILITY).map(([stage, value]) => ({ case: { $eq: ["$stage", stage] }, then: value })), default: 0 } }] };
const CURRENCY: Document = { $toUpper: { $ifNull: ["$currency", "INR"] } };
const WEIGHTED = (when?: Document): Document => ({ $sum: when ? { $cond: [when, { $multiply: ["$valueEstimateMinor", PROBABILITY, 0.01] }, 0] } : { $multiply: ["$valueEstimateMinor", PROBABILITY, 0.01] } });
const whole = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));
/** Money rows are per three-letter currency code; a row stored with anything else (before the code was checked) is left out, never shown or thrown on. */
const validCurrency = (row: { _id: unknown }) => typeof row._id === "string" && /^[A-Z]{3}$/.test(row._id);
const WON_STORED = [...WON_STAGES, ...Object.entries(LEGACY_STAGE_MAP).filter(([, current]) => WON_STAGES.includes(current)).map(([old]) => old)];
const CLOSED_STORED = [...WON_STORED, "lost", "disqualified"];

/** Deal value and weighted value of the leads a filter matches, by currency. Leads without a value count in `count` only. */
export async function leadTotals(ctx: SalesCtx, filter: Document, count: number) {
  const rows = await ctx.db.collection("opportunities").aggregate<{ _id: string; count: number; valueMinor: number; weighted: number }>([
    { $match: { ...filter, valueEstimateMinor: { $gt: 0 } } },
    { $group: { _id: CURRENCY, count: { $sum: 1 }, valueMinor: { $sum: "$valueEstimateMinor" }, weighted: WEIGHTED() } },
    { $sort: { valueMinor: -1, _id: 1 } },
  ], { allowDiskUse: true }).toArray();
  return { count, byCurrency: rows.filter(validCurrency).map((row) => ({ currency: row._id, count: row.count, valueMinor: whole(row.valueMinor), weightedMinor: whole(row.weighted) })) };
}

type Query = z.infer<typeof pipelineValueQuerySchema> & { tz?: string | undefined };
const pad = (value: number) => String(value).padStart(2, "0");

/** The first moment of a calendar month (month is 1 to 12, may run over into the next year) in a time zone. */
function monthStart(year: number, month: number, timeZone: string): Date {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((month - 1) % 12 + 12) % 12 + 1;
  return localMoment(`${y}-${pad(m)}-01`, 0, 0, { ...DEFAULT_CALENDAR, timeZone });
}

/**
 * The pipeline in money: open value and weighted value, the weighted forecast by expected close month (a deal expected in an earlier
 * month that is still open counts in this month), weighted value with no close date, and what was won this month. One row per currency.
 */
export async function pipelineValue(ctx: SalesCtx, query: Query, now = new Date()) {
  const timeZone = query.tz ?? SALES_TZ;
  const local = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(local.find((part) => part.type === "year")?.value);
  const month = Number(local.find((part) => part.type === "month")?.value);
  const key = (offset: number) => { const y = year + Math.floor((month - 1 + offset) / 12); return `${y}-${pad(((month - 1 + offset) % 12) + 1)}`; };
  const months = { current: key(0), next: key(1) };
  const empty = { months, rows: [] as { currency: string; openDeals: number; openValueMinor: number; openWeightedMinor: number; forecastThisMonthMinor: number; forecastNextMonthMinor: number; unscheduledWeightedMinor: number; wonThisMonthDeals: number; wonThisMonthMinor: number }[], openWithoutValue: 0 };
  const scope = ventureScope(ctx.actor, query.ventureId);
  if (!scope) return empty;
  const owner = query.owner === "me" ? ctx.actor.id : query.owner;
  const base: Document = { workspaceId: ctx.workspaceId, deletedAt: null, ...scope, ...(owner ? { ownerId: owner } : {}) };
  const thisStart = monthStart(year, month, timeZone), nextStart = monthStart(year, month + 1, timeZone), afterNext = monthStart(year, month + 2, timeZone);
  const leads = ctx.db.collection("opportunities");
  const valued = { valueEstimateMinor: { $gt: 0 } };
  const [open, won, openWithoutValue] = await Promise.all([
    leads.aggregate<{ _id: string; deals: number; value: number; weighted: number; thisMonth: number; nextMonth: number; unscheduled: number }>([
      { $match: { ...base, ...valued, stage: { $nin: CLOSED_STORED } } },
      { $group: {
        _id: CURRENCY, deals: { $sum: 1 }, value: { $sum: "$valueEstimateMinor" }, weighted: WEIGHTED(),
        thisMonth: WEIGHTED({ $and: [{ $ne: [{ $type: "$expectedCloseAt" }, "missing"] }, { $ne: ["$expectedCloseAt", null] }, { $lt: ["$expectedCloseAt", nextStart] }] }),
        nextMonth: WEIGHTED({ $and: [{ $gte: ["$expectedCloseAt", nextStart] }, { $lt: ["$expectedCloseAt", afterNext] }] }),
        unscheduled: WEIGHTED({ $eq: [{ $ifNull: ["$expectedCloseAt", null] }, null] }),
      } },
    ]).toArray(),
    leads.aggregate<{ _id: string; deals: number; value: number }>([
      { $match: { ...base, ...valued, stage: { $in: WON_STORED }, wonAt: { $gte: thisStart, $lt: nextStart } } },
      { $group: { _id: CURRENCY, deals: { $sum: 1 }, value: { $sum: "$valueEstimateMinor" } } },
    ]).toArray(),
    leads.countDocuments({ ...base, stage: { $nin: CLOSED_STORED }, $or: [{ valueEstimateMinor: null }, { valueEstimateMinor: 0 }] }),
  ]);
  const currencies = [...new Set([...open.filter(validCurrency).map((row) => row._id), ...won.filter(validCurrency).map((row) => row._id)])];
  const rows = currencies.map((currency) => {
    const o = open.find((row) => row._id === currency), w = won.find((row) => row._id === currency);
    return { currency, openDeals: o?.deals ?? 0, openValueMinor: whole(o?.value), openWeightedMinor: whole(o?.weighted), forecastThisMonthMinor: whole(o?.thisMonth), forecastNextMonthMinor: whole(o?.nextMonth), unscheduledWeightedMinor: whole(o?.unscheduled), wonThisMonthDeals: w?.deals ?? 0, wonThisMonthMinor: whole(w?.value) };
  }).sort((a, b) => b.openValueMinor + b.wonThisMonthMinor - (a.openValueMinor + a.wonThisMonthMinor) || a.currency.localeCompare(b.currency));
  return { months, rows, openWithoutValue };
}
