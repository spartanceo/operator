/**
 * Agent-loop primitives (Task #4 fills in the runtime).
 *
 * Declared here so route schemas, persistence layers, and the UI all refer
 * to the same shapes from day one. Field semantics:
 *
 *  - `AgentMessage` — one turn in the conversation log.
 *  - `AgentTask`    — a goal the agent decomposes into ordered steps.
 *  - `AgentStep`    — one tool/skill invocation inside a task.
 *  - `ApprovalRequest` — pause point where the user must approve a step
 *    that crosses a privacy / cost / external-write boundary.
 */

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly role: AgentRole;
  readonly content: string;
  readonly createdAt: string;
}

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTask {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly goal: string;
  readonly status: AgentTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentStep {
  readonly id: string;
  readonly taskId: string;
  readonly index: number;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export type ApprovalReason =
  | "external_write"
  | "spend"
  | "data_egress"
  | "elevated_permission";

export interface ApprovalRequest {
  readonly id: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly reason: ApprovalReason;
  readonly summary: string;
  readonly createdAt: string;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
  readonly note?: string;
  readonly decidedAt: string;
}
