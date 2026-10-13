import { forwardRef } from "react";
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import { Call02Icon, CallEnd01Icon, CallMissed01Icon, Delete02Icon, Linkedin01Icon, UserBlock01Icon, WhatsappIcon } from "@hugeicons/core-free-icons";

// Icons the shared set (components/ui/icons.tsx) does not export. Same wrapper, same stroke width.
type IconProps = Omit<HugeiconsIconProps, "icon">;
function icon(svg: IconSvgElement) {
  return forwardRef<SVGSVGElement, IconProps>(function SalesIcon({ strokeWidth = 1.8, ...props }, ref) {
    return <HugeiconsIcon ref={ref} icon={svg} strokeWidth={strokeWidth} {...props} />;
  });
}

export const Phone = icon(Call02Icon);
export const PhoneMissed = icon(CallMissed01Icon);
export const Trash = icon(Delete02Icon);
export const Whatsapp = icon(WhatsappIcon);
export const Linkedin = icon(Linkedin01Icon);
export const PhoneOff = icon(CallEnd01Icon);
export const UserX = icon(UserBlock01Icon);
