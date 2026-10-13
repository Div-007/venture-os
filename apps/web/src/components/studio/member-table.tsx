import clsx from "clsx";

export type MemberRow = {
  id: string;
  name: string;
  /** Second line under the name, e.g. "@handle". */
  detail?: string;
  you?: boolean;
  /** Plain text role, or a control (the demo edits roles inline). */
  role: React.ReactNode;
  /** Admin roles read as "All ventures" instead of a list. */
  allVentures?: boolean;
  ventures: string[];
  groups: number | null;
  /** Every group in each of their ventures, including groups created later. */
  allGroups?: boolean;
  action?: React.ReactNode;
  flashId?: string;
};

const columns = "md:grid md:grid-cols-[minmax(0,1.5fr)_11rem_minmax(0,1.4fr)_4rem_4.5rem] md:items-center md:gap-4";
// Phones: line one is the member and their action (name block flexes, Edit sits at the right); line two is role, ventures, groups.
// Every row uses the same two lines, so row heights match whatever a member has.
const phoneRow = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2";
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";

/** The gradient class for a role: admins violet, venture heads green, operators amber, reviewers blue, contributors teal, learners pink. */
export function roleTone(role: string) {
  const tone = /admin|founder/i.test(role) ? "admin" : /head/i.test(role) ? "head" : /operator|ops/i.test(role) ? "ops" : /review/i.test(role) ? "review" : /contributor|qa/i.test(role) ? "contrib" : /learn|trainee/i.test(role) ? "learn" : "other";
  return `vso-role vso-role-${tone}`;
}

export function RolePill({ role }: { role: string }) {
  return <span className={clsx("inline-flex max-w-full items-center truncate rounded-full px-2.5 py-1 text-xs font-semibold capitalize", roleTone(role))}>{role}</span>;
}

/** Workspace members as a table on wide screens and two-line rows on phones. */
export function MemberTable({ rows }: { rows: MemberRow[] }) {
  return <div role="table" aria-label="Workspace members" className="min-w-0">
    <div role="row" className={clsx("hidden border-b border-neutral-100 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[.06em] text-neutral-400", columns)}>
      <span role="columnheader">Member</span><span role="columnheader">Role</span><span role="columnheader">Ventures</span><span role="columnheader">Groups</span><span role="columnheader" className="sr-only">Actions</span>
    </div>
    <div className="divide-y divide-neutral-100">{rows.map((row) => <div key={row.id} role="row" data-flash-id={row.flashId} className={clsx(phoneRow, "px-5 py-3 transition-colors duration-150 hover:bg-neutral-50/70", columns)}>
      <div role="cell" className="flex min-w-0 items-center gap-3 max-md:col-span-2 max-md:col-start-1 max-md:row-start-1">
        <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-50 text-xs font-semibold text-primary-700">{initialsOf(row.name)}</span>
        <div className="min-w-0"><p className="truncate text-sm font-semibold text-neutral-800">{row.name}{row.you && <span className="font-normal text-neutral-400"> · you</span>}</p>{row.detail && <p className="truncate text-xs text-neutral-500">{row.detail}</p>}</div>
      </div>
      <div role="cell" className="min-w-0 max-md:col-start-1 max-md:row-start-2">{typeof row.role === "string" ? <RolePill role={row.role} /> : row.role}</div>
      <div role="cell" className="flex min-w-0 gap-1 max-md:col-start-2 max-md:row-start-2 max-md:overflow-hidden md:flex-wrap">
        {row.allVentures ? <span className="text-xs text-neutral-500">All ventures</span>
          : row.ventures.length ? <>{row.ventures.slice(0, 2).map((name) => <span key={name} className="max-w-36 truncate rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">{name}</span>)}{row.ventures.length > 2 && <span title={row.ventures.slice(2).join(", ")} className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">+{row.ventures.length - 2}</span>}</>
          : <span className="text-xs text-neutral-400">No ventures</span>}
      </div>
      <div role="cell" className="text-xs text-neutral-500 tnum max-md:col-start-3 max-md:row-start-2 max-md:justify-self-end max-md:whitespace-nowrap">{row.allGroups ? <span title="Every group in their ventures, including new ones"><span className="hidden md:inline">All</span><span className="md:hidden">All groups</span></span> : <><span className="hidden md:inline">{row.groups ?? "—"}</span>{row.groups !== null && <span className="md:hidden">{row.groups} group{row.groups === 1 ? "" : "s"}</span>}</>}</div>
      <div role="cell" className="flex justify-end max-md:col-start-3 max-md:row-start-1">{row.action}</div>
    </div>)}</div>
  </div>;
}
