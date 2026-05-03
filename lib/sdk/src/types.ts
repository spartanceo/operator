/**
 * Shared types for the SDK. We re-declare the wire shapes here rather
 * than importing from `@workspace/api-zod` so consumers can install
 * `@omninity/sdk` without pulling the whole monorepo in their type
 * graph. The shapes intentionally mirror the OpenAPI schemas.
 */
export interface OmninityClientOptions {
  /** Loopback base URL of the Operator API. Default: `http://localhost:3001`. */
  baseUrl?: string;
  /** Tenant / workspace identifier. Forwarded as `X-Tenant-ID`. */
  tenantId: string;
  /** Optional fetch override (testing). */
  fetch?: typeof fetch;
  /** Default per-request timeout, ms. Default 30 000. */
  timeoutMs?: number;
}

export interface AgentRun {
  id: string;
  goal: string;
  status: string;
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreateRunInput {
  goal: string;
  modelName?: string;
  conversationId?: string;
  skillId?: string;
  useKnowledgeBase?: boolean;
}

export type PluginToolRiskLevel = "low" | "medium" | "high" | "critical";

export interface PluginTool {
  id: string;
  name: string;
  description: string;
  riskLevel: PluginToolRiskLevel;
  inputSchema: Record<string, unknown>;
  invokeUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface RegisterPluginToolInput {
  name: string;
  description?: string;
  riskLevel?: PluginToolRiskLevel;
  inputSchema?: Record<string, unknown>;
  invokeUrl: string;
  authToken?: string;
}

export interface PluginInvokeInput {
  input: Record<string, unknown>;
}

export interface PluginInvokeResult {
  toolName: string;
  output: Record<string, unknown>;
  durationMs: number;
}

export interface WebhookSubscription {
  id: string;
  url: string;
  label: string;
  eventTypes: string[];
  enabled: boolean;
  hasSecret: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: number | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreateWebhookSubscriptionInput {
  url: string;
  label?: string;
  eventTypes?: string[];
  secret?: string;
}

export type OpEventType =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "tool_called"
  | "approval_requested"
  | "approval_resolved"
  | "skill_installed"
  | "skill_uninstalled"
  | "skill_invoked"
  | "plugin_tool_registered"
  | "plugin_tool_invoked";

export interface OpEvent {
  id: string;
  type: OpEventType;
  tenantId: string;
  workspaceId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}
