"use client";

import clsx from "clsx";
import { CheckSquare2, Layers3, LockKeyhole, type Icon } from "@/components/ui/icons";

/** Per venture: every group including later ones, only the ticked groups, or none (venture pages only). */
export type GroupMode = "all" | "pick" | "none";
export type AccessVenture = { id: string; name: string; groups: { id: string; name: string }[] };

const options: { value: GroupMode; label: string; icon: Icon }[] = [
  { value: "all", label: "All groups", icon: Layers3 },
  { value: "pick", label: "Pick groups", icon: CheckSquare2 },
  { value: "none", label: "No groups", icon: LockKeyhole },
];
const checkRow = "flex min-h-10 cursor-pointer items-center gap-2 rounded-xl bg-neutral-50 px-3 text-sm text-neutral-700 transition-colors duration-150 hover:bg-neutral-100 has-[:checked]:bg-primary-50 has-[:checked]:text-primary-800";

/** The mode a saved membership already has in a venture: all-groups ventures are "all"; elsewhere its groups decide. */
export function storedMode(ventureId: string, allGroupVentureIds: string[], groupIds: string[], ventures: AccessVenture[]): GroupMode {
  if (allGroupVentureIds.includes(ventureId)) return "all";
  const groups = ventures.find((venture) => venture.id === ventureId)?.groups ?? [];
  return groups.some((group) => groupIds.includes(group.id)) ? "pick" : "none";
}

/**
 * What to save: the all-groups ventures, and ticked groups only where the venture is on "Pick groups".
 * Groups of ventures this screen can't see (archived ones) are kept exactly as they were.
 */
export function accessPayload(ventureIds: string[], modes: Record<string, GroupMode>, groupIds: string[], ventures: AccessVenture[]) {
  const ventureOf = (groupId: string) => ventures.find((venture) => venture.groups.some((group) => group.id === groupId))?.id;
  return {
    allGroupVentureIds: ventureIds.filter((id) => modes[id] === "all"),
    groupIds: groupIds.filter((groupId) => { const ventureId = ventureOf(groupId); return ventureId === undefined || (ventureIds.includes(ventureId) && modes[ventureId] === "pick"); }),
  };
}

/** The groups a member ends up in for each visible venture, for showing what a save adds or removes. */
export function effectiveGroups(ventureIds: string[], modes: Record<string, GroupMode>, groupIds: string[], ventures: AccessVenture[]) {
  return ventures.filter((venture) => ventureIds.includes(venture.id)).flatMap((venture) => modes[venture.id] === "all" ? venture.groups.map((group) => group.id) : modes[venture.id] === "pick" ? venture.groups.filter((group) => groupIds.includes(group.id)).map((group) => group.id) : []);
}

const listNames = (names: string[]) => names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;

function message(venture: AccessVenture, mode: GroupMode, picked: string[]): { text: string; tone: "good" | "warn" | "plain" } {
  if (mode === "all") return venture.groups.length
    ? { text: `They’ll get every group in ${venture.name}, including groups created later.`, tone: "good" }
    : { text: `${venture.name} has no groups yet. They’ll join each group as it’s created.`, tone: "good" };
  if (mode === "pick") return picked.length
    ? { text: `Only ${listNames(picked)}. New groups in ${venture.name} won’t be added automatically.`, tone: "plain" }
    : { text: `Tick at least one group, or they’ll only see ${venture.name}’s pages.`, tone: "warn" };
  return { text: `They can open ${venture.name}’s pages, but not its tasks, board, or channels, until you add them to a group. New groups won’t be added.`, tone: "plain" };
}

/** One card per chosen venture: choose all groups, specific groups, or none, with a plain sentence saying what that means. */
export function GroupAccessPicker({ ventures, modes, groupIds, onMode, onToggleGroup }: {
  ventures: AccessVenture[];
  modes: Record<string, GroupMode>;
  groupIds: string[];
  onMode: (ventureId: string, mode: GroupMode) => void;
  onToggleGroup: (groupId: string) => void;
}) {
  return <div className="space-y-2.5">{ventures.map((venture) => {
    // Same reading as accessPayload: a venture without a mode saves as no groups.
    const mode = modes[venture.id] ?? "none";
    const picked = venture.groups.filter((group) => groupIds.includes(group.id)).map((group) => group.name);
    const note = message(venture, mode, picked);
    return <div key={venture.id} className="vso-row-enter rounded-xl border border-neutral-200 bg-white p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-neutral-800">{venture.name}</p>
        <span className="shrink-0 text-xs text-neutral-500 tnum">{venture.groups.length ? `${venture.groups.length} group${venture.groups.length === 1 ? "" : "s"}` : "No groups yet"}</span>
      </div>
      <div role="radiogroup" aria-label={`Group access in ${venture.name}`} className="mt-2 grid grid-cols-3 gap-0.5 rounded-lg bg-neutral-100 p-0.5">
        {options.map(({ value, label, icon: OptionIcon }) => {
          // Picking needs something to pick from.
          const disabled = value === "pick" && !venture.groups.length;
          return <label key={value} className={clsx("flex min-h-9 items-center justify-center gap-1.5 rounded-md px-1.5 text-center text-xs font-semibold transition-[background-color,color,box-shadow,transform] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-600", disabled ? "cursor-not-allowed text-neutral-400 opacity-60" : "cursor-pointer active:scale-[0.97]", mode === value ? "bg-white text-neutral-900 shadow-sm" : !disabled && "text-neutral-500 hover:text-neutral-800")}>
            <input type="radio" className="sr-only" name={`group-mode-${venture.id}`} value={value} checked={mode === value} disabled={disabled} onChange={() => onMode(venture.id, value)} />
            <OptionIcon size={14} aria-hidden="true" className="shrink-0 max-[380px]:hidden" />{label}
          </label>;
        })}
      </div>
      <p aria-live="polite" className={clsx("mt-2 text-xs leading-5", note.tone === "good" ? "text-primary-700" : note.tone === "warn" ? "text-warning-text" : "text-neutral-500")}>{note.text}</p>
      {mode === "pick" && <div className="vso-row-enter mt-2 space-y-1.5" role="group" aria-label={`Groups in ${venture.name}`}>
        {venture.groups.map((group) => <label key={group.id} className={checkRow}><input type="checkbox" checked={groupIds.includes(group.id)} onChange={() => onToggleGroup(group.id)} />{group.name}</label>)}
      </div>}
    </div>;
  })}</div>;
}
