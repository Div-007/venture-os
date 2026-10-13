import { StudioApiError } from "@/lib/studio-api";
import { getSalesSettings, type SalesSettingsView } from "@/lib/sales-api";

export type { SalesSettingsInput, SalesSettingsView } from "@/lib/sales-api";

/** What a venture runs on until someone saves settings (the same defaults the API applies). */
export const DEFAULT_SETTINGS = { workingDays: [1, 2, 3, 4, 5, 6], followUpAfterWorkingDays: 4, replySlaHours: 2, dailyCaps: { email: 20, whatsapp: 20 }, approvalMode: "claude_review_enough", timezone: "Asia/Kolkata" } as const;

/** The venture's settings, or `null` when this server has no settings route (an older API): the screen then shows the defaults and no form. */
export async function loadSettingsOrNull(ventureId: string): Promise<SalesSettingsView | null> {
  try { return await getSalesSettings(ventureId); }
  catch (cause) {
    if (cause instanceof StudioApiError && cause.code === "NOT_FOUND" && /route not found/i.test(cause.message)) return null;
    throw cause;
  }
}
