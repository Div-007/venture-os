import type { SalesReport } from "@venture-studio/contracts";
import { count, days, hours, money, percent, plural, rateWords } from "./report-shared";

// "Copy as text": the report as a few plain lines for pasting into a chat or WhatsApp. Same honest-number rules as the screen.

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
/** "10 Sep – 10 Oct 2026" (the end is shown as the last day the period covers). */
export function periodLabel(report: SalesReport) {
  const from = new Date(report.range.from);
  const to = new Date(new Date(report.range.to).getTime() - 1);
  const short = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
  return from.getFullYear() === to.getFullYear() ? `${short.format(from)} – ${dayFormat.format(to)}` : `${dayFormat.format(from)} – ${dayFormat.format(to)}`;
}

export function reportText(report: SalesReport, context: { ventureName: string; whose: string }) {
  const { funnel, activity, calibration, winsLosses, stageAging } = report;
  const lines: string[] = [];
  lines.push(`Sales report · ${context.ventureName} · ${periodLabel(report)} · ${context.whose}`);
  const steps = funnel.stages.map((stage, index) => `${stage.label} ${count(stage.leads)}${index > 0 && percent(stage.conversion) ? ` (${percent(stage.conversion)})` : ""}`);
  lines.push(funnel.active ? `Funnel: ${count(funnel.active)} leads moved. ${steps.join(" → ")}${funnel.closed.lost + funnel.closed.disqualified ? `; closed ${count(funnel.closed.lost)} lost, ${count(funnel.closed.disqualified)} not a fit` : ""}` : "Funnel: no leads moved in this period.");
  lines.push(`Activity: ${plural(activity.totals.calls, "call", "calls")}, ${plural(activity.totals.messages, "message", "messages")}, ${plural(activity.totals.replies, "reply", "replies")} received`);
  const answer = activity.firstResponse.medianHours;
  lines.push(`Speed: median time to answer a reply ${answer.value !== null ? hours(answer.value) : answer.n ? `too few to tell (n ${answer.n})` : "no replies answered yet"}; warm replies answered within ${activity.sla.hours} working hours: ${rateWords(activity.sla.rate)}${activity.firstResponse.unanswered ? `; ${count(activity.firstResponse.unanswered)} replies not answered yet` : ""}`);
  const stuck = stageAging.groups.filter((group) => group.key !== "new" && group.open > 0).map((group) => `${group.label.toLowerCase()} ${count(group.open)}${group.medianDays.value !== null ? ` (median ${days(group.medianDays.value)})` : ""}`);
  if (stuck.length) lines.push(`Open deals waiting: ${stuck.join(", ")}`);
  lines.push(calibration.verdicts
    ? `Claude: ${count(calibration.verdicts)} verdicts; when it said go, replied or booked: ${rateWords(calibration.precision.rate)}; ${count(calibration.overrides.count)} overridden by a person`
    : "Claude: no verdicts in this period.");
  const value = winsLosses.won.value.map((row) => money(row.minor, row.currency)).join(" + ");
  const reasons = winsLosses.lost.reasons.slice(0, 3).map((row) => `${row.label.toLowerCase()} ${row.count}`).join(", ");
  lines.push(`Won ${count(winsLosses.won.count)}${value ? ` (${value})` : ""} · lost ${count(winsLosses.lost.count)}${reasons ? ` (${reasons})` : ""} · not a fit ${count(winsLosses.disqualified.count)}`);
  lines.push(`Numbers under 5 cases are not shown as percentages; under 30 they are a small sample.`);
  return lines.join("\n");
}
