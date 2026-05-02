/**
 * Skill runtime contracts (Task #6 fills in the sandbox + invocation layer).
 *
 * The shapes declared here are the public boundary skills see. A skill is
 * third-party code that runs only inside the canonical sandbox file
 * `artifacts/api-server/src/skill-runtime/sandbox.ts` (Standard 12).
 *
 * Skills declare permissions in their manifest at install time; the runtime
 * refuses tool invocations not in the manifest (Section 12 of the project
 * context).
 */

export type SkillPermission =
  | "filesystem:read"
  | "filesystem:write"
  | "network:fetch"
  | "ollama:invoke"
  | "clipboard:read"
  | "clipboard:write"
  | "shell:execute";

export interface SkillManifest {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly entrypoint: string;
  readonly permissions: ReadonlyArray<SkillPermission>;
  /** SHA-256 of the bundled skill source — verified at load time. */
  readonly contentHash: string;
}

/**
 * Per-invocation context the sandbox passes to a skill. Carries the tenant
 * context, a sandboxed logger, and references to the proxied tools the
 * skill is allowed to call.
 */
export interface SkillContext {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly invocationId: string;
  readonly deadline: number;
  readonly log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface SkillResult {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly tokensUsed?: number;
  readonly elapsedMs: number;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly invocationId: string;
}
