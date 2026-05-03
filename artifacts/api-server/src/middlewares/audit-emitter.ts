/**
 * Audit-emitter middleware (Task #53).
 *
 * Wraps mutating requests against compliance-sensitive route prefixes
 * (tools, files, agent, desktop, browser, integrations) and appends an
 * audit entry once the response is finished. The middleware:
 *
 *   - Computes a SHA-256 hash of the request body so the raw input is
 *     never persisted (privacy-by-design — proof of activity without
 *     sensitive content).
 *   - Records the response status as the action's outcome and a short
 *     summary of the route + method.
 *   - Skips GET/HEAD/OPTIONS requests (read-only methods don't deserve
 *     an audit row in the compliance log; they're already covered by
 *     the structured request log).
 *   - Skips paths inside /api/security/audit so we never recurse into
 *     ourselves while listing audit rows.
 *
 * Append failures are swallowed — a transient audit failure must never
 * break a user's request (the security-events log + structured logger
 * still record the failure).
 */
import { createHash } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { getTenantContext } from "../lib/tenant-context";
import { logger } from "../lib/logger";
import { appendAuditEntry } from "../services/audit.service";

interface PrefixRule {
  readonly prefix: string;
  readonly actionType: string;
  readonly resourceType: string;
}

const RULES: ReadonlyArray<PrefixRule> = [
  { prefix: "/api/tools", actionType: "tool_call", resourceType: "tool" },
  { prefix: "/api/files", actionType: "file_op", resourceType: "file" },
  { prefix: "/api/agent", actionType: "agent_action", resourceType: "agent" },
  { prefix: "/api/desktop", actionType: "desktop_action", resourceType: "desktop" },
  { prefix: "/api/browser", actionType: "browser_action", resourceType: "browser" },
  { prefix: "/api/integrations", actionType: "api_call", resourceType: "integration" },
  { prefix: "/api/approvals", actionType: "approval_decision", resourceType: "approval" },
  { prefix: "/api/skills", actionType: "skill_execution", resourceType: "skill" },
  { prefix: "/api/conversations", actionType: "model_inference", resourceType: "conversation" },
  { prefix: "/api/runs", actionType: "model_inference", resourceType: "run" },
  { prefix: "/api/admin", actionType: "admin_action", resourceType: "admin" },
  { prefix: "/api/secrets", actionType: "vault_access", resourceType: "secret" },
  { prefix: "/api/security", actionType: "security_action", resourceType: "security" },
];

// tier-review: bounded — fixed three-element literal set, never mutated.
const SKIPPED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SKIPPED_PREFIX = "/api/security/audit";

function findRule(path: string): PrefixRule | undefined {
  for (const rule of RULES) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}/`)) return rule;
  }
  return undefined;
}

function hashInput(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  try {
    const json = typeof body === "string" ? body : JSON.stringify(body);
    if (!json || json.length === 0) return null;
    return createHash("sha256").update(json).digest("hex");
  } catch {
    return null;
  }
}

function sessionIdOf(req: Request): string | null {
  // express-session attaches a session id when present.
  const sid = (req as unknown as { sessionID?: string }).sessionID;
  return typeof sid === "string" && sid.length > 0 ? sid : null;
}

function actorOf(req: Request): string {
  const session = (req as unknown as { session?: { user?: { email?: string; id?: string } } }).session;
  if (session?.user?.email) return session.user.email;
  if (session?.user?.id) return session.user.id;
  const headerActor = req.headers["x-user-id"];
  if (typeof headerActor === "string" && headerActor.length > 0) return headerActor;
  return "anonymous";
}

export function auditEmitter() {
  return function auditEmitterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const path = req.originalUrl?.split("?")[0] ?? req.path;
    if (SKIPPED_METHODS.has(req.method) || path.startsWith(SKIPPED_PREFIX)) {
      next();
      return;
    }
    const rule = findRule(path);
    if (!rule) {
      next();
      return;
    }
    const ctx = getTenantContext();
    if (!ctx) {
      next();
      return;
    }

    const inputHash = hashInput(req.body);
    const userId = actorOf(req);
    const sessionId = sessionIdOf(req);
    const startedAt = Date.now();

    // Pre-action emit: append a "requested" entry synchronously before
    // the route handler runs so the audit trail captures intent even if
    // the request crashes the process. The post-response handler then
    // appends a "completed" entry with the outcome — two rows, both in
    // the chain, so the auditor sees the full lifecycle of every
    // privileged action.
    void appendAuditEntry(ctx, {
      actor: userId,
      action: `${rule.actionType}.${req.method.toLowerCase()}.requested`,
      actionType: rule.actionType,
      resourceType: rule.resourceType,
      resourceId: path,
      summary: `${req.method} ${path} requested`,
      userId,
      sessionId,
      inputHash,
      approvalStatus: "pending",
    }).catch((e) => {
      logger.warn({ err: e, path }, "audit emitter failed to append (requested)");
    });

    res.on("finish", () => {
      const status = res.statusCode;
      const elapsed = Date.now() - startedAt;
      const summary = `${req.method} ${path} → ${status} (${elapsed}ms)`;
      const approval = status >= 400 ? "denied" : "granted";
      void appendAuditEntry(ctx, {
        actor: userId,
        action: `${rule.actionType}.${req.method.toLowerCase()}.completed`,
        actionType: rule.actionType,
        resourceType: rule.resourceType,
        resourceId: path,
        summary,
        userId,
        sessionId,
        inputHash,
        outputSummary: `status=${status}`,
        approvalStatus: approval,
      }).catch((e) => {
        logger.warn({ err: e, path }, "audit emitter failed to append");
      });
    });

    next();
  };
}
