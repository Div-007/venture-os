"use client";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { createDeliveryWork } from "@/lib/sales-api";

/**
 * "Create delivery work" for a won lead: one call makes the Venture OS task, then a toast links to it.
 * Used on Overview, Pipeline and in the lead drawer. `busyId` is the lead being created for.
 */
export function useDeliveryWork(onCreated?: () => void) {
  const router = useRouter();
  const [busyId, setBusyId] = useState("");
  const create = useCallback(async (leadId: string, company: string) => {
    setBusyId(leadId);
    try {
      const { task } = await createDeliveryWork(leadId);
      toast({ title: "Delivery work created", body: `${company}: ${task.title}`, duration: 9000, action: { label: "Open task", onClick: () => router.push(`/tasks/live?task=${encodeURIComponent(task.id)}`) } });
      onCreated?.();
      return true;
    } catch (cause) {
      toast({ tone: "error", title: "Could not create delivery work", body: describeError(cause, "Try again in a moment.") });
      return false;
    } finally { setBusyId(""); }
  }, [router, onCreated]);
  return { create, busyId };
}
