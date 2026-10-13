type Issue = { code?: string; path?: readonly PropertyKey[] | string; message?: string; minimum?: number | bigint };

const fieldLabels: Record<string, string> = { contentType: "File type", q: "Search", ventureId: "Venture", groupId: "Group", markdown: "Content", responseMarkdown: "Answer" };

function fieldLabel(path: Issue["path"]): string {
  const parts = typeof path === "string" ? path.split(".") : [...(path ?? [])];
  const field = parts.filter((part): part is string => typeof part === "string" && part.length > 0).at(-1);
  if (!field) return "This value";
  if (fieldLabels[field]) return fieldLabels[field];
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function issueText(issue: Issue): string {
  const field = fieldLabel(issue.path);
  if (field === "File type") return "This file type is not supported.";
  switch (issue.code) {
    case "too_small": return Number(issue.minimum ?? 1) <= 1 ? `${field} is required.` : `${field} is too short.`;
    case "too_big": return `${field} is too long.`;
    case "invalid_value": return `${field} has an unsupported value.`;
    case "invalid_format": return `${field} is not in a valid format.`;
    case "custom": return issue.message?.trim() ? `${issue.message.trim().replace(/\.$/, "")}.` : `${field} is not valid.`;
    default: return `${field} is not valid.`;
  }
}

/** Server validation envelopes carry issue paths; name the fields instead of a generic failure. */
export function validationSummary(issues: ReadonlyArray<{ path: string; message: string }>): string {
  const labels = [...new Set(issues.map((issue) => fieldLabel(issue.path)))];
  return labels.length ? `Please check ${labels.join(", ")}.` : "Please check the form and try again.";
}

/** A short, readable sentence for any failure, never raw validation JSON. */
export function describeError(cause: unknown, fallback = "Something went wrong. Please try again."): string {
  // Client-side schema failures (ZodError) expose an issues array; detect by shape so no second zod copy is needed here.
  const issues = typeof cause === "object" && cause !== null ? (cause as { issues?: unknown }).issues : undefined;
  if (Array.isArray(issues)) return issues.length ? issueText(issues[0] as Issue) : fallback;
  if (cause instanceof Error) {
    const message = cause.message.trim();
    if (message.startsWith("[")) {
      try {
        const issues = JSON.parse(message) as Issue[];
        if (Array.isArray(issues) && issues.length) return issueText(issues[0]);
      } catch { /* Not serialized validation issues; fall through to the message. */ }
    }
    return message || fallback;
  }
  return fallback;
}
