// Per-venture sales settings: what used to be constants (working days, blackout dates, follow-up and reply timing, the approval rule)
// plus the daily caps and allowed channels. Stored in `sales_settings` keyed by venture; a venture without a saved row uses the defaults.
import { salesSettingsSchema, type SalesSettings } from "@venture-studio/contracts";
import type { AppDb } from "../db.js";
import { workCalendar, type WorkCalendar } from "./workdays.js";

export type { SalesSettings };
export const DEFAULT_SETTINGS: SalesSettings = salesSettingsSchema.parse({});

/** The venture's saved settings merged over the defaults (an unreadable row reads as the defaults). */
export async function loadSettings(db: AppDb, workspaceId: string, ventureId: string): Promise<SalesSettings> {
  const stored = await db.collection("sales_settings").findOne({ _id: ventureId, workspaceId });
  if (!stored) return DEFAULT_SETTINGS;
  const parsed = salesSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export const calendarOf = (settings: SalesSettings): WorkCalendar => workCalendar(settings);
