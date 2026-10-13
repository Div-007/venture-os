export type Venture = { id: string; name: string; short: string; ownerId: string; stage: string; goal: string; status: "active" | "parked"; reviewedAt: string; color: string };
export type Group = { id: string; ventureId: string; name: string; memberIds: string[] };
export type Channel = { id: string; groupId: string; name: string; unread: number };
export type Person = { id: string; name: string; initials: string; role: string; ventureIds: string[]; availability: string };
export type TaskStatus = "Backlog" | "Ready" | "In progress" | "In review" | "Blocked" | "Done";
export type Task = { id: string; ventureId: string; groupId: string; title: string; outcome: string; ownerId: string; reviewerId: string; priority: "P1" | "P2" | "P3"; dueAt: string; reviewAt: string; effort: string; doneWhen: string; dependencies: string; evidence: string; status: TaskStatus; blocker: string; accepted: boolean; tags: string[]; activity: string[]; reminderAt?: string; snoozedUntil?: string };
export type Outcome = { id: string; ventureId: string; title: string; ownerId: string; dueAt: string; progress: number; status: string; evidence: string; week: number };
export type Knowledge = { id: string; ventureId: string; title: string; body: string; ownerId: string; evidenceClass: "Verified fact" | "Founder-reported" | "Approved decision" | "Planning assumption" | "Hypothesis" | "Open question" | "Historical"; sensitivity: "Team" | "Venture head" | "Founder private"; source: string; version: number; reviewedAt: string; tags: string[]; relatedIds: string[]; history?: { version: number; body: string; editedAt: string }[] };
export type Decision = { id: string; ventureId: string; title: string; ownerId: string; date: string; status: "Approved" | "Draft" | "Review due"; reason: string; evidence: string; affects: string; trigger: string };
export type StudioClass = { id: string; ventureId: string; title: string; objective: string; date: string; participantIds: string[]; material: string; practice: string; assignment: string; assessment: string; gap: string; nextLesson: string };
export type Request = { id: string; ventureId: string; requesterId: string; responderId: string; question: string; dueAt: string; answer: string; sources: string; unresolved: string; status: "Open" | "Answered" | "Needs review" };
export type Deal = { id: string; ventureId: string; lead: string; offer: string; stage: "New" | "Qualified" | "Proposal" | "Negotiation" | "Won" | "Lost"; ownerId: string; lastAction: string; nextAction: string; nextAt: string; evidence: string; result: string };
export type Message = { id: string; channelId: string; authorId: string; body: string; at: string; parentId?: string; reactions: string[]; pinned: boolean; saved: boolean };
export type Notice = { id: string; title: string; body: string; kind: "mention" | "task" | "review" | "reminder"; at: string; read: boolean; taskId?: string; snoozedUntil?: string };
export type FocusSession = { id: string; taskId: string; minutes: number; endedAt: string };
export type AuditEntry = { id: string; actorId: string; action: string; at: string; scope: string };
export type Invite = { id: string; email: string; role: string; ventureId: string; status: "Draft" | "Sent" };

export type StudioData = {
  ventures: Venture[]; groups: Group[]; channels: Channel[]; people: Person[]; tasks: Task[];
  outcomes: Outcome[]; knowledge: Knowledge[]; decisions: Decision[]; classes: StudioClass[];
  requests: Request[]; deals: Deal[]; messages: Message[]; notices: Notice[]; focusSessions: FocusSession[]; audit: AuditEntry[]; invites: Invite[];
};

export const demoData: StudioData = {
  ventures: [
    { id: "buildory", name: "Buildory", short: "BU", ownerId: "adarsh", stage: "Validate", goal: "Approve three evidence-backed offers and begin qualified outreach", status: "active", reviewedAt: "2026-09-22", color: "bg-primary-600" },
    { id: "edithood", name: "Editing / EditHood", short: "EH", ownerId: "ashutosh", stage: "Operate", goal: "Prove a repeatable editing delivery and review loop", status: "active", reviewedAt: "2026-09-21", color: "bg-emerald-600" },
    { id: "spotlyst", name: "Spotlyst", short: "SP", ownerId: "adarsh", stage: "Explore", goal: "Validate the first customer problem and record interview evidence", status: "active", reviewedAt: "2026-09-19", color: "bg-amber-500" },
  ],
  groups: [
    { id: "buildory-core", ventureId: "buildory", name: "Core team", memberIds: ["divyansh", "adarsh", "abhinav", "shubham"] },
    { id: "buildory-growth", ventureId: "buildory", name: "Growth", memberIds: ["divyansh", "adarsh", "shubham"] },
    { id: "edithood-delivery", ventureId: "edithood", name: "Delivery", memberIds: ["divyansh", "ashutosh", "abhinav"] },
    { id: "spotlyst-product", ventureId: "spotlyst", name: "Product", memberIds: ["divyansh", "adarsh", "abhinav"] },
  ],
  channels: [
    { id: "buildory-general", groupId: "buildory-core", name: "general", unread: 0 },
    { id: "buildory-product", groupId: "buildory-core", name: "product", unread: 2 },
    { id: "buildory-outreach", groupId: "buildory-growth", name: "outreach", unread: 0 },
    { id: "edithood-general", groupId: "edithood-delivery", name: "general", unread: 0 },
    { id: "edithood-reviews", groupId: "edithood-delivery", name: "reviews", unread: 1 },
    { id: "spotlyst-general", groupId: "spotlyst-product", name: "general", unread: 0 },
  ],
  people: [
    { id: "divyansh", name: "Divyansh Dwivedi", initials: "DD", role: "Founder / admin", ventureIds: ["buildory", "edithood", "spotlyst"], availability: "Available" },
    { id: "adarsh", name: "Adarsh Singh", initials: "AS", role: "Venture head", ventureIds: ["buildory", "spotlyst"], availability: "In review" },
    { id: "ashutosh", name: "Ashutosh", initials: "AT", role: "Delivery operator", ventureIds: ["edithood"], availability: "Available" },
    { id: "abhinav", name: "Abhinav", initials: "AB", role: "Contributor / QA", ventureIds: ["buildory", "edithood", "spotlyst"], availability: "Available" },
    { id: "shubham", name: "Shubham", initials: "SH", role: "Research trainee", ventureIds: ["buildory"], availability: "Learning" },
  ],
  tasks: [
    { id: "task-review-offers", ventureId: "buildory", groupId: "buildory-core", title: "Decide which Buildory offers can ship", outcome: "Approve or return each of the three candidate offers", ownerId: "divyansh", reviewerId: "adarsh", priority: "P1", dueAt: "2026-09-23", reviewAt: "2026-09-24", effort: "45 minutes", doneWhen: "Decision record names approved offers and cites delivery proof", dependencies: "Adarsh's offer audit", evidence: "", status: "Ready", blocker: "", accepted: true, tags: ["offers", "decision"], activity: ["Founder accepted review"] },
    { id: "task-weekly", ventureId: "edithood", groupId: "edithood-delivery", title: "Review this week's editing outcome", outcome: "Approve the next delivery improvement based on two reviewed examples", ownerId: "divyansh", reviewerId: "ashutosh", priority: "P2", dueAt: "2026-09-25", reviewAt: "2026-09-26", effort: "30 minutes", doneWhen: "Record the decision and link the two delivery examples", dependencies: "Review handoff sample", evidence: "", status: "Backlog", blocker: "", accepted: true, tags: ["delivery", "review"], activity: ["Weekly review scheduled"] },
    { id: "task-offers", ventureId: "buildory", groupId: "buildory-core", title: "Review Buildory service offers", outcome: "Three approved offers with a clear buyer, deliverable and proof for each", ownerId: "adarsh", reviewerId: "divyansh", priority: "P1", dueAt: "2026-09-23", reviewAt: "2026-09-24", effort: "2 hours", doneWhen: "Founder approves the offer matrix and every claim links to evidence", dependencies: "Current website and service notes", evidence: "Offer audit draft · /knowledge/buildory-offers", status: "In review", blocker: "", accepted: true, tags: ["offers", "review"], activity: ["Adarsh accepted the assignment", "Offer audit attached for review"] },
    { id: "task-editing", ventureId: "edithood", groupId: "edithood-delivery", title: "Document editing review handoff", outcome: "One repeatable handoff from first cut to approval", ownerId: "ashutosh", reviewerId: "divyansh", priority: "P1", dueAt: "2026-09-24", reviewAt: "2026-09-25", effort: "90 minutes", doneWhen: "Checklist covers version, reviewer, deadline and client approval evidence", dependencies: "One recent delivery example", evidence: "", status: "Blocked", blocker: "Waiting for an approved sample project", accepted: true, tags: ["delivery", "process"], activity: ["Blocker raised: approved sample project missing"] },
    { id: "task-spotlyst", ventureId: "spotlyst", groupId: "spotlyst-product", title: "Prepare five customer interview questions", outcome: "A short interview guide that tests the actual customer problem", ownerId: "abhinav", reviewerId: "adarsh", priority: "P2", dueAt: "2026-09-25", reviewAt: "2026-09-25", effort: "60 minutes", doneWhen: "Questions are neutral and each maps to a hypothesis", dependencies: "Problem statement review", evidence: "", status: "Ready", blocker: "", accepted: false, tags: ["research"], activity: ["Assigned by Adarsh"] },
    { id: "task-crm", ventureId: "buildory", groupId: "buildory-growth", title: "Clean the first CRM research batch", outcome: "Ten qualified lead records with source and next action", ownerId: "shubham", reviewerId: "adarsh", priority: "P2", dueAt: "2026-09-26", reviewAt: "2026-09-27", effort: "2 hours", doneWhen: "Each lead has buyer fit, source, owner and an evidence-backed next step", dependencies: "Approved buyer definition", evidence: "", status: "Backlog", blocker: "", accepted: false, tags: ["sales", "research"], activity: ["Draft assignment created"] },
  ],
  outcomes: [
    { id: "outcome-buildory", ventureId: "buildory", title: "Make Buildory ready for qualified conversations", ownerId: "adarsh", dueAt: "2026-10-22", progress: 42, status: "At risk", evidence: "Approved offer matrix and first ten qualified leads", week: 1 },
    { id: "outcome-editing", ventureId: "edithood", title: "Make editing delivery repeatable", ownerId: "ashutosh", dueAt: "2026-10-22", progress: 58, status: "On track", evidence: "Completed handoff checklist and two reviewed deliveries", week: 2 },
    { id: "outcome-spotlyst", ventureId: "spotlyst", title: "Validate the customer problem", ownerId: "adarsh", dueAt: "2026-10-22", progress: 22, status: "Needs evidence", evidence: "Five interview notes and a decision on the problem statement", week: 3 },
  ],
  knowledge: [
    { id: "buildory-offers", ventureId: "buildory", title: "Buildory offer audit", body: "# Buildory offer audit\n\nThe three candidate services are under review. Buyer, deliverables and proof must be confirmed before outreach.\n\n## Current gap\nNo approved case study has been linked yet.", ownerId: "adarsh", evidenceClass: "Planning assumption", sensitivity: "Venture head", source: "Discovery notes · 22 Sep", version: 2, reviewedAt: "2026-09-22", tags: ["offers", "sales"], relatedIds: ["task-offers"] },
    { id: "editing-handoff", ventureId: "edithood", title: "Editing delivery handoff", body: "# Editing delivery handoff\n\nA review handoff should identify the cut version, reviewer, due time and approval evidence.\n\nA real sample is still needed before calling this process verified.", ownerId: "ashutosh", evidenceClass: "Hypothesis", sensitivity: "Team", source: "Operator working draft", version: 1, reviewedAt: "2026-09-21", tags: ["delivery", "playbook"], relatedIds: ["task-editing"] },
    { id: "spotlyst-problem", ventureId: "spotlyst", title: "Spotlyst customer problem", body: "# Problem statement\n\nThe first customer problem is still an open question. Interview evidence should precede a product commitment.", ownerId: "adarsh", evidenceClass: "Open question", sensitivity: "Team", source: "Founder discovery brief", version: 1, reviewedAt: "2026-09-19", tags: ["research"], relatedIds: ["task-spotlyst"] },
  ],
  decisions: [
    { id: "decision-context", ventureId: "buildory", title: "Use evidence labels for durable context", ownerId: "divyansh", date: "2026-09-22", status: "Approved", reason: "Separate confirmed facts from assumptions before context moves into AI tools", evidence: "Venture Studio OS discovery brief", affects: "Knowledge records and context packets", trigger: "Review after first team pilot" },
    { id: "decision-offers", ventureId: "buildory", title: "Approve first Buildory offers", ownerId: "divyansh", date: "2026-09-24", status: "Review due", reason: "Offer audit and proof are still being reviewed", evidence: "task-offers", affects: "Outreach readiness", trigger: "Offer matrix submitted" },
  ],
  classes: [
    { id: "class-evidence", ventureId: "buildory", title: "Evidence-led CRM research", objective: "Qualify a lead without inventing buyer intent", date: "2026-09-24T15:00:00+05:30", participantIds: ["shubham", "adarsh"], material: "Buyer-fit checklist", practice: "Classify two example leads", assignment: "Complete ten sourced CRM records", assessment: "Reviewer checks source and next action", gap: "Qualification evidence is inconsistent", nextLesson: "Writing a useful outreach brief" },
    { id: "class-review", ventureId: "edithood", title: "Review-ready editing handoff", objective: "Deliver an edit with unambiguous version and feedback", date: "2026-09-26T11:00:00+05:30", participantIds: ["ashutosh", "abhinav"], material: "Handoff checklist draft", practice: "Mark up a sample first cut", assignment: "Apply the checklist to one delivery", assessment: "Reviewer signs off on handoff evidence", gap: "Sample project approval pending", nextLesson: "Client feedback triage" },
  ],
  requests: [
    { id: "request-proof", ventureId: "buildory", requesterId: "divyansh", responderId: "adarsh", question: "Which existing Buildory offers have delivery proof?", dueAt: "2026-09-24", answer: "", sources: "", unresolved: "Case-study links not yet supplied", status: "Open" },
  ],
  deals: [
    { id: "deal-1", ventureId: "buildory", lead: "Northwind pilot", offer: "Workflow audit", stage: "Qualified", ownerId: "adarsh", lastAction: "Discovery call · 21 Sep", nextAction: "Validate decision maker", nextAt: "2026-09-25", evidence: "Call notes pending review", result: "" },
    { id: "deal-2", ventureId: "edithood", lead: "Studio retainer enquiry", offer: "Short-form editing", stage: "Proposal", ownerId: "ashutosh", lastAction: "Scope received · 22 Sep", nextAction: "Review capacity and quote", nextAt: "2026-09-24", evidence: "Client brief", result: "" },
  ],
  messages: [
    { id: "msg-1", channelId: "buildory-product", authorId: "adarsh", body: "The offer audit is ready for review. @Divyansh, the proof column still needs your call.", at: "2026-09-23T09:20:00+05:30", reactions: ["👍 2"], pinned: true, saved: false },
    { id: "msg-2", channelId: "buildory-product", authorId: "divyansh", body: "Please separate what we can verify from what is still an assumption. Link the source before the decision.", at: "2026-09-23T09:32:00+05:30", reactions: [], pinned: false, saved: true },
    { id: "msg-3", channelId: "edithood-reviews", authorId: "ashutosh", body: "The handoff is blocked until we have one approved sample project.", at: "2026-09-23T10:10:00+05:30", reactions: [], pinned: false, saved: false },
  ],
  notices: [
    { id: "notice-1", title: "Offer audit needs review", body: "Adarsh submitted the Buildory offer matrix.", kind: "review", at: "2026-09-23T09:20:00+05:30", read: false, taskId: "task-offers" },
    { id: "notice-2", title: "You were mentioned in #product", body: "The proof column still needs your call.", kind: "mention", at: "2026-09-23T09:20:00+05:30", read: false },
    { id: "notice-3", title: "Editing handoff is blocked", body: "An approved sample project is needed.", kind: "task", at: "2026-09-23T10:10:00+05:30", read: false, taskId: "task-editing" },
  ],
  focusSessions: [{ id: "focus-1", taskId: "task-offers", minutes: 25, endedAt: "2026-09-22T16:30:00+05:30" }],
  audit: [
    {id:"audit-1",actorId:"adarsh",action:"Submitted offer audit for review",at:"2026-09-23T09:20:00+05:30",scope:"Buildory · Tasks"},
    {id:"audit-2",actorId:"ashutosh",action:"Raised editing handoff blocker",at:"2026-09-23T10:10:00+05:30",scope:"Editing / EditHood · Tasks"},
  ],
  invites: [],
};

export const displayDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
export const personName = (data: StudioData, id: string) => data.people.find((person) => person.id === id)?.name ?? "Unknown member";
export const ventureName = (data: StudioData, id: string) => data.ventures.find((venture) => venture.id === id)?.name ?? "Unknown venture";
