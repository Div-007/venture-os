"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { SlidingTabs } from "./sliding-tabs";

export type TabDef = { key: string; label: string; badge?: number };

function TabsInner({
  tabs,
  param = "tab",
  onChange,
}: {
  tabs: TabDef[];
  param?: string;
  onChange?: (key: string) => void;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const requested = sp.get(param);
  const active = tabs.some((tab) => tab.key === requested) ? requested! : tabs[0].key;

  return (
    <SlidingTabs tabs={tabs} active={active} label={`${param} sections`} className="bg-neutral-100"
      onChange={(key) => {
        onChange?.(key);
        const q = new URLSearchParams(sp.toString());
        q.set(param, key);
        router.replace(`?${q.toString()}`, { scroll: false });
      }} />
  );
}

export function Tabs(props: {
  tabs: TabDef[];
  param?: string;
  onChange?: (key: string) => void;
}) {
  return (
    <Suspense>
      <TabsInner {...props} />
    </Suspense>
  );
}

/** Client-side active-tab reader for page bodies. */
export function useTab(tabs: TabDef[], param = "tab") {
  const sp = useSearchParams();
  return sp.get(param) ?? tabs[0].key;
}
