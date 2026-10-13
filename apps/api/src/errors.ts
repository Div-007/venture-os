import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import type { ErrorCode } from "@venture-studio/contracts";
import type { AppDb } from "./db.js";
import { audit } from "./audit.js";

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: ErrorCode, message: string) { super(message); }
}

/** Client-caused failures raised outside route code, mapped to the safe envelope instead of a 500. */
function clientError(error: unknown): AppError | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { type?: unknown; status?: unknown; expose?: unknown; code?: unknown };
  // body-parser rejections such as malformed JSON (400) or an oversized body (413).
  if (candidate.expose === true && typeof candidate.type === "string" && typeof candidate.status === "number" && candidate.status >= 400 && candidate.status < 500) {
    return new AppError(candidate.status, "BAD_REQUEST", candidate.type === "entity.too.large" ? "Request body is too large" : candidate.type === "entity.parse.failed" ? "Request body is not valid JSON" : "Request body could not be read");
  }
  // A unique-index violation that a route did not translate itself.
  if (candidate.code === 11000) return new AppError(409, "CONFLICT", "A record with the same unique value already exists");
  return undefined;
}

export function createErrorHandler(db: AppDb) { return async function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): Promise<void> {
  if (!(error instanceof AppError) && !(error instanceof ZodError)) {
    const mapped = clientError(error);
    if (mapped?.status === 409) console.warn(JSON.stringify({ level: "warn", requestId: req.id, event: "duplicate_key", path: req.path }));
    error = mapped ?? error;
  }
  const auditIdentity = req.actor ? { workspaceId: req.actor.membership.workspaceId, actorId: req.actor.id } : req.identity && req.auditWorkspaceId ? { workspaceId: req.auditWorkspaceId, actorId: req.identity.id } : undefined;
  if (error instanceof ZodError) {
    if (auditIdentity) await audit(db, { ...auditIdentity, channel: req.interfaceChannel, action: `${req.method} ${req.path}`, objectType: "request", result: "validation_failure", metadata: { issueCount: error.issues.length } });
    res.status(400).json({ ok: false, error: { code: "BAD_REQUEST", message: "Request validation failed", requestId: req.id, issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
    return;
  }
  if (error instanceof AppError) {
    if (auditIdentity && [400, 401, 403, 404, 409, 429].includes(error.status)) await audit(db, { ...auditIdentity, channel: req.interfaceChannel, action: `${req.method} ${req.path}`, objectType: "request", result: [401, 403, 429].includes(error.status) ? "denied" : "failure", metadata: { code: error.code } });
    res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message, requestId: req.id } });
    return;
  }
  console.error(JSON.stringify({ level: "error", requestId: req.id, error: error instanceof Error ? error.message : "unknown" }));
  res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "An internal error occurred", requestId: req.id } });
}; }
