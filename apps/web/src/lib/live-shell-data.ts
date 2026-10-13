import type { StudioData, TaskStatus } from "./studio-demo";
import { WON_STAGES, type SalesStage } from "@venture-studio/contracts";
import { listLiveClasses, listLiveDecisions, listLiveDocuments, listLiveFocusHistory, listLiveMembers, listLiveNotifications, listLiveOpportunities, listLiveOutcomes, listLiveTasks, loadLiveSession } from "./studio-api";

type Session = Awaited<ReturnType<typeof loadLiveSession>>;
type TaskPage = Awaited<ReturnType<typeof listLiveTasks>>;
type Notifications = Awaited<ReturnType<typeof listLiveNotifications>>;
type Members = Awaited<ReturnType<typeof listLiveMembers>>;
type Outcomes = Awaited<ReturnType<typeof listLiveOutcomes>>;
type Decisions = Awaited<ReturnType<typeof listLiveDecisions>>;
type Documents = Awaited<ReturnType<typeof listLiveDocuments>>;
type Opportunities = Awaited<ReturnType<typeof listLiveOpportunities>>;
type FocusHistory = Awaited<ReturnType<typeof listLiveFocusHistory>>;
type Classes = Awaited<ReturnType<typeof listLiveClasses>>;

/** The demo-shaped deal stage for a Sales (SLS-01) stage: any won stage is Won, replied and thinking are a conversation. */
function dealStage(stage: SalesStage): StudioData["deals"][number]["stage"] {
  if (WON_STAGES.includes(stage)) return "Won";
  if (stage === "qualified" || stage === "discovery_booked") return "Qualified";
  if (stage === "proposal") return "Proposal";
  if (stage === "lost" || stage === "disqualified") return "Lost";
  if (stage === "replied" || stage === "thinking") return "Negotiation";
  return "New";
}

const taskStatus: Record<TaskPage["items"][number]["status"], TaskStatus> = {
  draft: "Backlog", proposed: "Backlog", accepted: "Ready", backlog: "Backlog",
  todo: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review",
  done: "Done", cancelled: "Backlog", parked: "Backlog",
};

export function connectedNotices(notifications: Notifications): StudioData["notices"] {
  return notifications.map((notice) => ({ id: notice.id, title: notice.title, body: notice.body, kind: notice.type === "mention" || notice.type === "message" || notice.type === "channel_message" ? "mention" : notice.type === "reminder" || notice.type === "deadline_warning" ? "reminder" : "task", at: notice.createdAt, read: !!notice.readAt }));
}

export function connectedShellData(session: Session, tasks: TaskPage["items"] = [], notifications: Notifications = [], members: Members["items"] = []): StudioData {
  const ventures = session.hierarchy.ventures;
  const people = members.map((member) => ({
    id: member.id, name: member.name, initials: member.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join(""),
    role: member.role.replaceAll("_", " "), ventureIds: member.id === session.user.id ? session.membership.ventureIds : [], availability: "",
  }));
  if (!people.some((person) => person.id === session.user.id)) people.unshift({
    id: session.user.id, name: session.user.name, initials: session.user.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join(""),
    role: session.membership.role.replaceAll("_", " "), ventureIds: session.membership.ventureIds, availability: "",
  });

  return {
    ventures: ventures.map((venture) => ({ id: venture.id, name: venture.name, short: venture.name.slice(0, 2).toUpperCase(), ownerId: "", stage: venture.status, goal: venture.goal30Day, status: venture.status === "active" ? "active" : "parked", reviewedAt: venture.createdAt, color: "bg-primary-600" })),
    groups: ventures.flatMap((venture) => venture.groups.map((group) => ({ id: group.id, ventureId: venture.id, name: group.name, memberIds: session.membership.groupIds.includes(group.id) ? [session.user.id] : [] }))),
    channels: ventures.flatMap((venture) => venture.groups.flatMap((group) => group.channels.map((channel) => ({ id: channel.id, groupId: group.id, name: channel.name, unread: 0 })))),
    people,
    tasks: tasks.filter((task) => task.status !== "cancelled" && task.status !== "parked").map((task) => ({ id: task.id, ventureId: task.ventureId, groupId: task.groupId, title: task.title, outcome: task.outcome, ownerId: task.assigneeId, reviewerId: task.reviewerId ?? "", priority: task.priority === "urgent" || task.priority === "high" ? "P1" : task.priority === "medium" ? "P2" : "P3", dueAt: task.dueAt, reviewAt: task.reviewAt ?? task.dueAt, effort: `${task.estimatedMinutes} min`, doneWhen: task.definitionOfDone, dependencies: task.dependencies.join(", "), evidence: task.evidenceRequirement, status: taskStatus[task.status], blocker: task.blocker ?? "", accepted: !!task.acceptedAt, tags: task.tags, activity: [] })),
    outcomes: [], knowledge: [], decisions: [], classes: [], requests: [], deals: [], messages: [],
    notices: connectedNotices(notifications),
    focusSessions: [], audit: [], invites: [],
  };
}

export function connectedDashboardData(session: Session, input: {
  tasks: TaskPage["items"]; notifications: Notifications; members: Members["items"];
  outcomes: Outcomes; decisions: Decisions; documents: Documents["items"];
  opportunities: Opportunities; focusHistory: FocusHistory["items"]; classes: Classes;
}): StudioData {
  const base = connectedShellData(session, input.tasks, input.notifications, input.members);
  const evidenceClass = (value: string): StudioData["knowledge"][number]["evidenceClass"] => ({
    verified_fact: "Verified fact", founder_reported: "Founder-reported", approved_decision: "Approved decision",
    planning_assumption: "Planning assumption", hypothesis: "Hypothesis", open_question: "Open question", historical: "Historical",
  } as Record<string, StudioData["knowledge"][number]["evidenceClass"]>)[value] ?? "Historical";
  return {
    ...base,
    outcomes: input.outcomes.filter((item) => !!item.ventureId).map((item) => ({
      id: item.id, ventureId: item.ventureId, title: item.title, ownerId: item.ownerId,
      dueAt: item.reviewAt, progress: item.status === "achieved" ? 100 : 0,
      status: item.status === "at_risk" ? "At risk" : item.status === "achieved" ? "Achieved" : item.status,
      evidence: item.successEvidence, week: 0,
    })),
    decisions: input.decisions.filter((item) => !!item.ventureId).map((item) => ({
      id: item.id, ventureId: item.ventureId!, title: item.title, ownerId: item.ownerId,
      date: item.decidedAt, status: item.status === "approved" ? "Approved" : item.status === "draft" ? "Draft" : "Review due",
      reason: item.reason, evidence: item.evidence.join(", "), affects: item.affectedWork.join(", "), trigger: item.reviewTrigger,
    })),
    knowledge: input.documents.filter((item) => !!item.ventureId).map((item) => ({
      id: item.id, ventureId: item.ventureId!, title: item.title, body: "", ownerId: item.ownerId,
      evidenceClass: evidenceClass(item.evidenceClass), sensitivity: item.sensitivity === "founder_private" ? "Founder private" : item.sensitivity === "team" ? "Team" : "Venture head",
      source: "", version: 1, reviewedAt: item.lastReviewedAt ?? item.updatedAt, tags: [], relatedIds: [],
    })),
    deals: input.opportunities.map((item) => ({
      id: item.id, ventureId: item.ventureId, lead: item.companyName, offer: item.observedSignal,
      stage: dealStage(item.stage),
      ownerId: item.ownerId, lastAction: "", nextAction: item.nextAction, nextAt: item.nextActionAt ?? item.updatedAt,
      evidence: item.fitReason, result: "",
    })),
    classes: input.classes.filter((item) => !!item.ventureId && item.status === "scheduled").map((item) => ({
      id: item.id, ventureId: item.ventureId!, title: item.title, objective: item.objective,
      date: item.scheduledAt, participantIds: item.participantIds, material: item.materialDocumentId ?? "",
      practice: "", assignment: "", assessment: "", gap: "", nextLesson: "",
    })),
    focusSessions: input.focusHistory.filter((item) => !!item.completedAt).map((item) => ({
      id: item.id, taskId: item.taskId ?? "", minutes: item.plannedMinutes, endedAt: item.completedAt!,
    })),
  };
}
