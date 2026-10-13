import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { ensureIndexes } from "./indexes.js";
import { backfillMissingHandles } from "./handles.js";

const config = loadConfig();
const database = await connectDatabase(config);
const db = database.db;
const now = new Date("2026-09-23T09:00:00.000Z");
const workspaceId = "workspace-studio";
const ventures = [
  { _id: "venture-buildory", name: "Buildory", slug: "buildory", goal30Day: "Prove one repeatable sales-ready offer", ownerId: "user-adarsh" },
  { _id: "venture-edithood", name: "Editing/EditHood", slug: "editing-edithood", goal30Day: "Stabilize the editing delivery operating loop", ownerId: "user-ashutosh" },
  { _id: "venture-spotlyst", name: "Spotlyst", slug: "spotlyst", goal30Day: "Validate the technical pilot scope", ownerId: "user-adarsh" },
];
const users = [
  { _id: "user-divyansh", email: "divyansh@example.invalid", name: "Divyansh Dwivedi", handle: "divyansh", role: "admin" },
  { _id: "user-adarsh", email: "adarsh@example.invalid", name: "Adarsh Singh", handle: "adarsh", role: "venture_head" },
  { _id: "user-ashutosh", email: "ashutosh@example.invalid", name: "Ashutosh", handle: "ashutosh", role: "contributor" },
  { _id: "user-abhinav", email: "abhinav@example.invalid", name: "Abhinav", handle: "abhinav", role: "contributor" },
  { _id: "user-shubham", email: "shubham@example.invalid", name: "Shubham", handle: "shubham", role: "learner" },
];
try {
  await ensureIndexes(db);
  await db.collection("workspaces").updateOne({ _id: workspaceId }, { $set: { name: "Venture Studio", slug: "venture-studio", createdAt: now } }, { upsert: true });
  for (const venture of ventures) await db.collection("ventures").updateOne({ _id: venture._id }, { $set: { ...venture, workspaceId, status: "active", health: 65, createdAt: now, updatedAt: now } }, { upsert: true });
  for (const venture of ventures) {
    const groupId = `group-${venture.slug}`; const channelId = `channel-${venture.slug}-general`;
    await db.collection("groups").updateOne({ _id: groupId }, { $set: { workspaceId, ventureId: venture._id, name: "Core", createdAt: now } }, { upsert: true });
    await db.collection("channels").updateOne({ _id: channelId }, { $set: { workspaceId, ventureId: venture._id, groupId, name: "general", createdAt: now } }, { upsert: true });
  }
  for (const user of users) {
    await db.collection("users").updateOne({ _id: user._id }, { $set: { workspaceId, email: user.email, name: user.name, status: "active", updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
    const userVentures = user.role === "admin" ? ventures.map((venture) => venture._id) : user._id === "user-adarsh" ? ["venture-buildory", "venture-spotlyst"] : user._id === "user-ashutosh" ? ["venture-edithood"] : user._id === "user-abhinav" ? ["venture-buildory"] : ["venture-buildory"];
    await db.collection("memberships").updateOne({ workspaceId, userId: user._id }, { $set: { _id: `membership-${user.handle}`, workspaceId, userId: user._id, role: user.role, ventureIds: userVentures, allGroupVentureIds: [], groupIds: userVentures.map((id) => `group-${ventures.find((venture) => venture._id === id)!.slug}`), status: "active", createdAt: now, updatedAt: now } }, { upsert: true });
  }
  for (const venture of ventures) {
    const outcomeId = `outcome-${venture.slug}`;
    await db.collection("outcomes").updateOne({ _id: outcomeId }, { $set: { workspaceId, ventureId: venture._id, title: venture.goal30Day, description: `Sanitized demonstration outcome for ${venture.name}.`, ownerId: venture.ownerId, priority: "high", startAt: now, reviewAt: new Date("2026-10-23T09:00:00.000Z"), successEvidence: "Reviewed outcome evidence", status: "active", createdAt: now, updatedAt: now } }, { upsert: true });
    const taskId = `task-${venture.slug}-demo`;
    await db.collection("tasks").updateOne({ _id: taskId }, { $set: { workspaceId, ventureId: venture._id, groupId: `group-${venture.slug}`, channelId: `channel-${venture.slug}-general`, outcomeId, title: `Review ${venture.name} weekly outcome`, outcome: `Produce an evidence-backed weekly outcome review for ${venture.name}.`, assigneeId: venture.ownerId, creatorId: "user-divyansh", reviewerId: "user-divyansh", priority: "high", status: "accepted", dueAt: new Date("2026-09-28T12:00:00.000Z"), reviewAt: new Date("2026-09-28T14:00:00.000Z"), timezone: "Asia/Kolkata", estimatedMinutes: 90, definitionOfDone: "Review records progress, risk, blockers, and source evidence.", evidenceRequirement: "Link the reviewed operating record.", dependencies: [], evidenceLinks: [], tags: ["demo", "weekly-review"], deadlineRisk: false, acceptedAt: now, createdAt: now, updatedAt: now } }, { upsert: true });
    const documentId = `document-${venture.slug}-overview`; const versionId = `document-version-${venture.slug}-1`;
    await db.collection("documents").updateOne({ _id: documentId }, { $set: { workspaceId, ventureId: venture._id, title: `${venture.name} safe overview`, slug: `${venture.slug}-safe-overview`, ownerId: venture.ownerId, status: "approved", evidenceClass: "founder_reported", sensitivity: "venture_restricted", authoritativeRank: 60, currentVersionId: versionId, lastReviewedAt: now, createdAt: now, updatedAt: now } }, { upsert: true });
    const markdown = `# ${venture.name}\n\nThis is sanitized demonstration context for ${venture.name}. It contains no client-private or credential data.`;
    await db.collection("document_versions").updateOne({ _id: versionId }, { $set: { workspaceId, documentId, version: 1, markdown, changeSummary: "Seeded safe overview", createdBy: "user-divyansh", createdAt: now } }, { upsert: true });
    await db.collection("document_chunks").updateOne({ _id: `chunk-${venture.slug}-1` }, { $set: { workspaceId, ventureId: venture._id, documentId, documentVersionId: versionId, headingPath: venture.name, ordinal: 0, plainText: markdown.replace(/^# /, ""), createdAt: now } }, { upsert: true });
  }
  await db.collection("classes").updateOne({ _id: "class-task-ownership" }, { $set: { workspaceId, ventureId: "venture-buildory", title: "Task ownership and definition of done", objective: "Apply complete ownership fields to current work.", scheduledAt: new Date("2026-09-25T10:00:00.000Z"), durationMinutes: 60, facilitatorId: "user-adarsh", participantIds: ["user-abhinav", "user-shubham"], status: "scheduled", createdAt: now, updatedAt: now } }, { upsert: true });
  await db.collection("decisions").updateOne({ _id: "decision-chatgpt-primary" }, { $set: { workspaceId, title: "ChatGPT and Codex remain the primary AI surface", text: "Venture Studio owns data and permissions; MCP exposes bounded read tools.", ownerId: "user-divyansh", decidedAt: now, evidence: ["architecture-pack"], reason: "Avoid duplicating a general AI chat product.", affectedWork: [], reviewTrigger: "Evidence of a workflow that cannot be delivered through MCP and the dashboard", status: "approved", createdAt: now, updatedAt: now } }, { upsert: true });
  await db.collection("information_requests").updateOne({ _id: "request-buildory-proof" }, { $set: { workspaceId, ventureId: "venture-buildory", requesterId: "user-divyansh", respondentId: "user-adarsh", question: "What current evidence supports the first Buildory offer?", purpose: "Close a known context gap without inventing proof.", dueAt: new Date("2026-09-28T10:00:00.000Z"), status: "open", sourceRefs: [], createdAt: now, updatedAt: now } }, { upsert: true });
  await db.collection("pipelines").updateOne({ _id: "pipeline-buildory" }, { $set: { workspaceId, ventureId: "venture-buildory", name: "Buildory opportunities", offerName: "Validated offer", status: "active", createdAt: now, updatedAt: now } }, { upsert: true });
  await backfillMissingHandles(database, Object.fromEntries(users.map((user) => [user._id, user.handle])));
  console.info(`Seeded sanitized workspace. Demo header: x-dev-user-id=user-divyansh`);
} finally { await database.client.close(); }
