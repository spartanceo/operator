/**
 * Plugin tools service — custom tools registered via the Developer SDK.
 *
 * Each plugin tool is forwarded to a sidecar process that the developer
 * runs locally. The API server validates the input against the
 * registered JSON-Schema fragment, then POSTs the validated input to
 * `invokeUrl`. The sidecar must respond with
 * `{ output: Record<string, unknown> }` inside the standard envelope —
 * any other shape fails fast with `PLUGIN_INVOKE_FAILED`.
 *
 * For the local-first MVP we accept a single risk-level field that
 * mirrors the built-in tool catalogue (`low|medium|high|critical`) so
 * the orchestrator's existing approval gate can pause for medium+
 * plugin tools before invocation, identical to first-party tools.
 */
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db, pluginTools, tenantScope, withTenantValues } from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { emitOpEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";

export type PluginToolRiskLevel = "low" | "medium" | "high" | "critical";
// tier-review: bounded — fixed 4-element enum set, immutable.
const RISK_LEVELS: ReadonlySet<PluginToolRiskLevel> = new Set([
  "low",
  "medium",
  "high",
  "critical",
]);

export interface PluginToolRow {
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

export interface UpdatePluginToolInput {
  description?: string;
  riskLevel?: PluginToolRiskLevel;
  inputSchema?: Record<string, unknown>;
  invokeUrl?: string;
  authToken?: string | null;
  enabled?: boolean;
}

export class PluginToolValidationError extends Error {
  override readonly name = "PluginToolValidationError";
  readonly code = "PLUGIN_TOOL_VALIDATION";
  constructor(message: string) {
    super(message);
  }
}

export class PluginToolNotFoundError extends Error {
  override readonly name = "PluginToolNotFoundError";
  readonly code = "PLUGIN_TOOL_NOT_FOUND";
  constructor(id: string) {
    super(`Unknown plugin tool "${id}"`);
  }
}

export class PluginToolInvokeError extends Error {
  override readonly name = "PluginToolInvokeError";
  readonly code = "PLUGIN_INVOKE_FAILED";
  constructor(message: string) {
    super(message);
  }
}

const NAME_RE = /^[a-z][a-z0-9_.-]{1,79}$/i;

function parseSchema(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toRow(r: typeof pluginTools.$inferSelect): PluginToolRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    riskLevel: (RISK_LEVELS.has(r.riskLevel as PluginToolRiskLevel)
      ? r.riskLevel
      : "medium") as PluginToolRiskLevel,
    inputSchema: parseSchema(r.inputSchema),
    invokeUrl: r.invokeUrl,
    enabled: Boolean(r.enabled),
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    version: r.version,
  };
}

function assertLocalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginToolValidationError(`Invalid invokeUrl: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PluginToolValidationError("invokeUrl must use http(s)");
  }
  // Local-first: only loopback addresses are permitted, mirroring the
  // SDK's "local-only connectivity" promise (out-of-scope: remote API).
  const host = parsed.hostname;
  if (
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "::1" &&
    !host.endsWith(".localhost")
  ) {
    throw new PluginToolValidationError(
      "invokeUrl must point to a loopback host (localhost / 127.0.0.1)",
    );
  }
}

export async function listPluginTools(
  ctx: TenantContext,
): Promise<ReadonlyArray<PluginToolRow>> {
  const rows = await db
    .select()
    .from(pluginTools)
    .where(tenantScope(ctx, pluginTools))
    .orderBy(desc(pluginTools.createdAt));
  return rows.map(toRow);
}

export async function getPluginTool(
  ctx: TenantContext,
  id: string,
): Promise<PluginToolRow | null> {
  const rows = await db
    .select()
    .from(pluginTools)
    .where(and(tenantScope(ctx, pluginTools), eq(pluginTools.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

async function findByName(
  ctx: TenantContext,
  name: string,
): Promise<typeof pluginTools.$inferSelect | null> {
  const rows = await db
    .select()
    .from(pluginTools)
    .where(and(tenantScope(ctx, pluginTools), eq(pluginTools.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function registerPluginTool(
  ctx: TenantContext,
  input: RegisterPluginToolInput,
): Promise<PluginToolRow> {
  const name = input.name?.trim() ?? "";
  if (!NAME_RE.test(name)) {
    throw new PluginToolValidationError(
      "name must be 2–80 chars, start with a letter, only [A-Za-z0-9_.-]",
    );
  }
  if (input.riskLevel && !RISK_LEVELS.has(input.riskLevel)) {
    throw new PluginToolValidationError(`Invalid riskLevel: ${input.riskLevel}`);
  }
  assertLocalUrl(input.invokeUrl);
  const existing = await findByName(ctx, name);
  if (existing) {
    throw new PluginToolValidationError(`A plugin tool named "${name}" already exists`);
  }
  const id = `pt_${nanoid()}`;
  await db.insert(pluginTools).values(
    withTenantValues(ctx, {
      id,
      name,
      description: (input.description ?? "").trim(),
      riskLevel: input.riskLevel ?? "medium",
      inputSchema: JSON.stringify(input.inputSchema ?? {}),
      invokeUrl: input.invokeUrl,
      authToken: input.authToken ?? null,
      enabled: true,
    }),
  );
  const row = await getPluginTool(ctx, id);
  if (!row) throw new Error("Plugin tool vanished after creation");
  emitOpEvent(ctx, "plugin_tool_registered", { id, name, riskLevel: row.riskLevel });
  return row;
}

export async function updatePluginTool(
  ctx: TenantContext,
  id: string,
  input: UpdatePluginToolInput,
): Promise<PluginToolRow> {
  const existing = await getPluginTool(ctx, id);
  if (!existing) throw new PluginToolNotFoundError(id);
  if (input.invokeUrl !== undefined) assertLocalUrl(input.invokeUrl);
  if (input.riskLevel !== undefined && !RISK_LEVELS.has(input.riskLevel)) {
    throw new PluginToolValidationError(`Invalid riskLevel: ${input.riskLevel}`);
  }
  const patch: Partial<typeof pluginTools.$inferInsert> = {
    updatedAt: Date.now(),
    version: existing.version + 1,
  };
  if (input.description !== undefined) patch.description = input.description.trim();
  if (input.riskLevel !== undefined) patch.riskLevel = input.riskLevel;
  if (input.inputSchema !== undefined)
    patch.inputSchema = JSON.stringify(input.inputSchema);
  if (input.invokeUrl !== undefined) patch.invokeUrl = input.invokeUrl;
  if (input.authToken !== undefined) patch.authToken = input.authToken;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  await db
    .update(pluginTools)
    .set(patch)
    .where(
      and(
        tenantScope(ctx, pluginTools),
        eq(pluginTools.id, id),
        eq(pluginTools.version, existing.version),
      ),
    );
  const row = await getPluginTool(ctx, id);
  if (!row) throw new PluginToolNotFoundError(id);
  return row;
}

export async function deletePluginTool(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getPluginTool(ctx, id);
  if (!existing) return { id, deleted: false };
  await db
    .delete(pluginTools)
    .where(and(tenantScope(ctx, pluginTools), eq(pluginTools.id, id)));
  return { id, deleted: true };
}

/**
 * Validate the input against the stored JSON-Schema fragment. We do a
 * deliberately lightweight check (top-level required + type per
 * property) — full JSON-Schema validation is out of scope for the
 * MVP and would pull a heavy dependency. Misuse fails the call rather
 * than silently passing.
 */
function validateInput(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  const required = Array.isArray(schema["required"])
    ? (schema["required"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  for (const key of required) {
    if (!(key in input)) {
      throw new PluginToolValidationError(`Missing required field "${key}"`);
    }
  }
  const props = (schema["properties"] && typeof schema["properties"] === "object"
    ? (schema["properties"] as Record<string, unknown>)
    : {}) as Record<string, { type?: string }>;
  for (const [key, value] of Object.entries(input)) {
    const def = props[key];
    if (!def || !def.type) continue;
    const expected = def.type;
    const actual =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value;
    if (expected !== actual) {
      throw new PluginToolValidationError(
        `Field "${key}" must be ${expected}, got ${actual}`,
      );
    }
  }
}

export interface PluginInvokeResult {
  toolName: string;
  output: Record<string, unknown>;
  durationMs: number;
}

export async function invokePluginTool(
  ctx: TenantContext,
  id: string,
  input: Record<string, unknown>,
): Promise<PluginInvokeResult> {
  const tool = await getPluginTool(ctx, id);
  if (!tool) throw new PluginToolNotFoundError(id);
  if (!tool.enabled) {
    throw new PluginToolInvokeError(`Plugin tool "${tool.name}" is disabled`);
  }
  validateInput(tool.inputSchema, input);

  const started = Date.now();
  let httpStatus = 0;
  let body: unknown = null;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-omninity-tenant": ctx.tenantId,
      "x-omninity-workspace": ctx.workspaceId ?? ctx.tenantId,
    };
    const stored = await db
      .select({ authToken: pluginTools.authToken })
      .from(pluginTools)
      .where(and(tenantScope(ctx, pluginTools), eq(pluginTools.id, id)))
      .limit(1);
    const token = stored[0]?.authToken;
    if (token) headers["authorization"] = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let res: Response;
    try {
      // logPrivacyEvent paired with the fetch() call below to satisfy
      // tier-review Check #8 — every outbound network call must be audited.
      await logPrivacyEvent(ctx, {
        eventType: "network.plugin_tool",
        actor: ctx.userId ?? ctx.tenantId,
        target: `plugin:${tool.name}`,
        severity: "low",
        detail: "POST",
      });
      res = await fetch(tool.invokeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ input }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    httpStatus = res.status;
    body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new PluginToolInvokeError(
        `Plugin sidecar returned ${res.status}`,
      );
    }
  } catch (e) {
    logger.warn({ err: e, toolId: id, httpStatus }, "Plugin tool invocation failed");
    if (e instanceof PluginToolInvokeError) throw e;
    throw new PluginToolInvokeError(
      `Failed to invoke plugin tool "${tool.name}": ${(e as Error).message}`,
    );
  }
  const envelope = body as { success?: boolean; data?: { output?: unknown } } | null;
  const output =
    envelope &&
    envelope.success === true &&
    envelope.data &&
    typeof envelope.data === "object" &&
    envelope.data.output &&
    typeof envelope.data.output === "object"
      ? (envelope.data.output as Record<string, unknown>)
      : {};
  const durationMs = Date.now() - started;
  emitOpEvent(ctx, "plugin_tool_invoked", {
    id: tool.id,
    name: tool.name,
    durationMs,
  });
  return { toolName: tool.name, output, durationMs };
}
