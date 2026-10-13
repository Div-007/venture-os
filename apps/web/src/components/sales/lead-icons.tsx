"use client";
import { forwardRef } from "react";
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import { CalendarClockIcon, Delete02Icon, Flag01Icon, Globe02Icon, LockIcon, NotebookPenIcon, Package01Icon, PhoneIcon, Task01Icon } from "@hugeicons/core-free-icons";

// Icons the shared set (components/ui/icons.tsx) does not export yet; same wrapper and stroke weight.
type IconProps = Omit<HugeiconsIconProps, "icon">;
function icon(svg: IconSvgElement) {
  return forwardRef<SVGSVGElement, IconProps>(function SalesIcon({ strokeWidth = 1.8, ...props }, ref) {
    return <HugeiconsIcon ref={ref} icon={svg} strokeWidth={strokeWidth} {...props} />;
  });
}

export const Phone = icon(PhoneIcon);
export const Trash2 = icon(Delete02Icon);
export const Lock = icon(LockIcon);
export const NotebookPen = icon(NotebookPenIcon);
export const CalendarClock = icon(CalendarClockIcon);
export const Flag = icon(Flag01Icon);
export const Globe = icon(Globe02Icon);
export const ClipboardCheck = icon(Task01Icon);
/** An offer: what a venture sells. */
export const Package = icon(Package01Icon);
