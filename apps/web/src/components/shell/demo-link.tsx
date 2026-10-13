import Link from "next/link";
import type { ComponentProps } from "react";

export default function DemoLink({ href, ...props }: ComponentProps<typeof Link>) {
  const destination = typeof href === "string" && href.startsWith("/") && !href.startsWith("/demo") && !href.includes("/live")
    ? `/demo${href}`
    : href;
  return <Link href={destination} {...props} />;
}
