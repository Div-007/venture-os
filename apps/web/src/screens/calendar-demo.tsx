"use client";

import { Calendar } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageFrame, PageTitle, Panel } from "@/components/studio/primitives";

/** The sample-data prototype has no calendar data; the calendar lives in the connected workspace. */
export function CalendarDemoNotice() {
  return <PageFrame><PageTitle title="Calendar" description="Personal and venture calendars with invitations, repeats, and reminders." /><Panel><EmptyState variant="card" icon={Calendar} tone="green" title="The calendar uses your real workspace" body="Open the connected workspace to see your events, invitations, and work on a calendar." action={{ label: "Open the calendar", href: "/calendar/live" }} /></Panel></PageFrame>;
}
