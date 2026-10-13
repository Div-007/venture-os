export function reminderTransition(reminder: { repeatMinutes: number | null; sequence: number }, task: { startedAt?: Date; completedAt?: Date; status?: string } | null, now: Date) {
  if (task?.startedAt || task?.completedAt || task?.status === "done" || task?.status === "cancelled") return { state: "completed" as const, reason: "task_terminal" as const, shouldDeliver: false, nextAt: null, nextSequence: reminder.sequence };
  if (reminder.repeatMinutes) return { state: "scheduled" as const, reason: "repeating" as const, shouldDeliver: true, nextAt: new Date(now.getTime() + reminder.repeatMinutes * 60_000), nextSequence: reminder.sequence + 1 };
  return { state: "completed" as const, reason: "delivered" as const, shouldDeliver: true, nextAt: null, nextSequence: reminder.sequence };
}
