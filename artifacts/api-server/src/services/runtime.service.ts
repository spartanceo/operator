/**
 * Runtime service — the public surface used by the routes layer.
 *
 * Responsibilities:
 *   - Persist the active runtime selection per tenant (`runtime_settings`).
 *   - Persist encrypted cloud API keys per tenant (`runtime_credentials`).
 *   - Resolve an active `ModelRuntime` for the current request, applying
 *     auto-detection when the tenant has no explicit pick yet.
 *   - Compute the data-residency signal exposed by the Privacy Meter.
 *   - Hot-switch the active runtime without restarting the process.
 *
 * Cloud-confirmation gating lives in the routes layer (we accept a
 * `cloudConfirmed` boolean here so this service stays Express-agnostic
 * and easy to unit test).
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  runtimeCredentials,
  runtimeSettings,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";
import {
  decryptApiKey,
  encryptApiKey,
  keychainBridge,
} from "./runtime/credentials";
import {
  ALL_RUNTIMES,
  detectLocalRuntimes,
  getRuntime,
  listRuntimes,
} from "./runtime/registry";
import {
  RuntimeUpstreamError,
  type ModelRuntime,
  type RuntimeChatChunk,
  type RuntimeChatRequest,
  type RuntimeChatResult,
  type RuntimeEmbedRequest,
  type RuntimeEmbedResult,
  type RuntimeHealth,
  type RuntimeModel,
  type RuntimeResidency,
} from "./runtime/types";
import { CloudCredentialMissingError } from "./runtime/adapters/openai.adapter";

export interface RuntimeDescriptor {
  id: string;
  displayName: string;
  residency: RuntimeResidency;
  requiresApiKey: boolean;
  hasCredential: boolean;
  capabilities: ModelRuntime["capabilities"];
}

export interface ActiveRuntimeInfo {
  activeRuntimeId: string;
  defaultModel: string | null;
  /**
   * Dynamic residency for the Privacy Meter:
   *   - "local"           — adapter never leaves the device
   *   - "cloud-assist"    — cloud adapter with a *user-supplied* key
   *                         (the user owns the credential path)
   *   - "cloud-required"  — cloud adapter with no key configured yet,
   *                         or one whose contract guarantees no local
   *                         fallback ever
   */
  residency: RuntimeResidency;
  detectedRuntimeIds: string[];
  /** True only when the *active* runtime has been confirmed this session. */
  cloudConfirmedThisSession: boolean;
  /** Full set of runtime ids confirmed this session — feeds the meter UI. */
  confirmedRuntimeIds: string[];
}

export interface RuntimeWithHealth extends RuntimeDescriptor {
  health: RuntimeHealth;
}

async function getOrCreateSettings(ctx: TenantContext): Promise<{
  id: string;
  activeRuntimeId: string;
  defaultModel: string | null;
}> {
  const existing = await db
    .select()
    .from(runtimeSettings)
    .where(tenantScope(ctx, runtimeSettings))
    .limit(1);

  if (existing[0]) {
    return {
      id: existing[0].id,
      activeRuntimeId: existing[0].activeRuntimeId,
      defaultModel: existing[0].defaultModel,
    };
  }

  // Default to ollama — Standard 13: explicit defaults, no implicit cloud.
  const id = `rs_${nanoid()}`;
  await db.insert(runtimeSettings).values(
    withTenantValues(ctx, {
      id,
      activeRuntimeId: "ollama",
      defaultModel: null,
    }),
  );
  return { id, activeRuntimeId: "ollama", defaultModel: null };
}

function keychainAccount(ctx: TenantContext, runtimeId: string): string {
  // tenant + runtime makes the keychain entry unique per workspace so a
  // shared keychain on a multi-user host can't leak credentials across
  // tenants.
  return `${ctx.tenantId}:${runtimeId}`;
}

async function loadCredentialsMap(ctx: TenantContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const kc = await keychainBridge();
  // Prefer OS keychain when available — load every runtime id we know
  // about and skip the SQLite path entirely for ones that resolve.
  if (kc.available) {
    for (const r of ALL_RUNTIMES) {
      try {
        const v = await kc.get(keychainAccount(ctx, r.id));
        if (v) out.set(r.id, v);
      } catch (e) {
        logger.warn({ err: e, runtimeId: r.id }, "keychain.get failed");
      }
    }
  }
  // Fall back to encrypted SQLite for runtimes the keychain didn't have.
  const rows = await db
    .select()
    .from(runtimeCredentials)
    .where(tenantScope(ctx, runtimeCredentials));
  for (const r of rows) {
    if (out.has(r.runtimeId)) continue;
    try {
      out.set(
        r.runtimeId,
        decryptApiKey({ encryptedKey: r.encryptedKey, iv: r.iv, authTag: r.authTag }),
      );
    } catch (e) {
      logger.error({ err: e, runtimeId: r.runtimeId }, "Failed to decrypt runtime credential");
    }
  }
  return out;
}

export async function listRuntimeDescriptors(ctx: TenantContext): Promise<RuntimeDescriptor[]> {
  const creds = await loadCredentialsMap(ctx);
  return ALL_RUNTIMES.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    residency: r.residency,
    requiresApiKey: r.requiresApiKey,
    hasCredential: creds.has(r.id),
    capabilities: r.capabilities,
  }));
}

export async function listRuntimesWithHealth(ctx: TenantContext): Promise<RuntimeWithHealth[]> {
  const creds = await loadCredentialsMap(ctx);
  const items = await Promise.all(
    ALL_RUNTIMES.map(async (r) => {
      const apiKey = creds.get(r.id) ?? null;
      const health = await r.health(ctx, apiKey);
      return {
        id: r.id,
        displayName: r.displayName,
        residency: r.residency,
        requiresApiKey: r.requiresApiKey,
        hasCredential: creds.has(r.id),
        capabilities: r.capabilities,
        health,
      } satisfies RuntimeWithHealth;
    }),
  );
  return items;
}

/**
 * Compute the residency signal exposed by the Privacy Meter.
 *
 * Architecture contract: the meter can land in three states:
 *   - "local"          — adapter is on-device, no traffic leaves
 *   - "cloud-assist"   — cloud adapter with a user-owned API key
 *                        (user retains control of the credential path)
 *   - "cloud-required" — cloud adapter with no key configured (the
 *                        request CANNOT proceed without operator
 *                        intervention) OR an adapter whose contract
 *                        precludes local fallback entirely
 */
function dynamicResidency(adapter: ModelRuntime, hasCredential: boolean): RuntimeResidency {
  if (adapter.residency === "local") return "local";
  // Cloud adapter with a user-supplied key → cloud-assist (user owns the
  // credential path). Without a key, every chat call would 412 — surface
  // that as "cloud-required" to flag the missing operator approval.
  return hasCredential ? "cloud-assist" : "cloud-required";
}

export async function getActiveRuntimeInfo(
  ctx: TenantContext,
  confirmedRuntimeIds: string[],
): Promise<ActiveRuntimeInfo> {
  const settings = await getOrCreateSettings(ctx);
  const detected = await detectLocalRuntimes(ctx);
  const adapter = getRuntime(settings.activeRuntimeId);
  const creds = await loadCredentialsMap(ctx);
  const hasCredential = adapter ? creds.has(adapter.id) : false;
  const residency: RuntimeResidency = adapter
    ? dynamicResidency(adapter, hasCredential)
    : "local";
  return {
    activeRuntimeId: settings.activeRuntimeId,
    defaultModel: settings.defaultModel,
    residency,
    detectedRuntimeIds: detected,
    cloudConfirmedThisSession: confirmedRuntimeIds.includes(settings.activeRuntimeId),
    confirmedRuntimeIds,
  };
}

export async function setActiveRuntime(
  ctx: TenantContext,
  runtimeId: string,
  defaultModel: string | null,
): Promise<{ activeRuntimeId: string; defaultModel: string | null }> {
  const adapter = getRuntime(runtimeId);
  if (!adapter) {
    throw new Error(`Unknown runtime "${runtimeId}"`);
  }
  await getOrCreateSettings(ctx);
  await db
    .update(runtimeSettings)
    .set({
      activeRuntimeId: runtimeId,
      defaultModel,
      updatedAt: Date.now(),
    })
    .where(tenantScope(ctx, runtimeSettings));
  await logPrivacyEvent(ctx, {
    eventType: "runtime.switched",
    actor: ctx.userId ?? ctx.tenantId,
    target: runtimeId,
    severity: adapter.residency === "local" ? "info" : "medium",
    detail: `defaultModel=${defaultModel ?? "(unset)"}`,
  });
  return { activeRuntimeId: runtimeId, defaultModel };
}

export async function setRuntimeCredential(
  ctx: TenantContext,
  runtimeId: string,
  apiKey: string,
  label?: string | null,
): Promise<{ runtimeId: string; hasCredential: true }> {
  const adapter = getRuntime(runtimeId);
  if (!adapter) throw new Error(`Unknown runtime "${runtimeId}"`);
  if (!adapter.requiresApiKey) {
    throw new Error(`Runtime "${runtimeId}" does not accept API keys`);
  }

  // Prefer OS keychain when present — record only a non-secret marker
  // row in SQLite so `hasCredential` UX stays accurate without storing
  // ciphertext alongside the keychain entry.
  const kc = await keychainBridge();
  if (kc.available) {
    await kc.set(keychainAccount(ctx, runtimeId), apiKey);
    await logPrivacyEvent(ctx, {
      eventType: "runtime.credential.set",
      actor: ctx.userId ?? ctx.tenantId,
      target: runtimeId,
      severity: "high",
      detail: "os-keychain",
    });
    return { runtimeId, hasCredential: true };
  }

  const blob = encryptApiKey(apiKey);
  const existing = await db
    .select({ id: runtimeCredentials.id })
    .from(runtimeCredentials)
    .where(
      and(tenantScope(ctx, runtimeCredentials), eq(runtimeCredentials.runtimeId, runtimeId)),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(runtimeCredentials)
      .set({
        encryptedKey: blob.encryptedKey,
        iv: blob.iv,
        authTag: blob.authTag,
        label: label ?? null,
        updatedAt: Date.now(),
      })
      .where(
        and(tenantScope(ctx, runtimeCredentials), eq(runtimeCredentials.runtimeId, runtimeId)),
      );
  } else {
    await db.insert(runtimeCredentials).values(
      withTenantValues(ctx, {
        id: `rc_${nanoid()}`,
        runtimeId,
        encryptedKey: blob.encryptedKey,
        iv: blob.iv,
        authTag: blob.authTag,
        label: label ?? null,
      }),
    );
  }
  await logPrivacyEvent(ctx, {
    eventType: "runtime.credential.set",
    actor: ctx.userId ?? ctx.tenantId,
    target: runtimeId,
    severity: "high",
    detail: "encrypted-at-rest",
  });
  return { runtimeId, hasCredential: true };
}

export async function deleteRuntimeCredential(
  ctx: TenantContext,
  runtimeId: string,
): Promise<{ runtimeId: string; deleted: boolean }> {
  let deleted = false;
  const kc = await keychainBridge();
  if (kc.available) {
    try {
      const had = await kc.get(keychainAccount(ctx, runtimeId));
      if (had) {
        await kc.del(keychainAccount(ctx, runtimeId));
        deleted = true;
      }
    } catch (e) {
      logger.warn({ err: e, runtimeId }, "keychain.del failed");
    }
  }
  const result = await db
    .delete(runtimeCredentials)
    .where(
      and(tenantScope(ctx, runtimeCredentials), eq(runtimeCredentials.runtimeId, runtimeId)),
    );
  if ((result as { changes?: number }).changes !== 0) deleted = true;
  if (deleted) {
    await logPrivacyEvent(ctx, {
      eventType: "runtime.credential.deleted",
      actor: ctx.userId ?? ctx.tenantId,
      target: runtimeId,
      severity: "medium",
    });
  }
  return { runtimeId, deleted };
}

async function resolveActiveAdapter(
  ctx: TenantContext,
): Promise<{ adapter: ModelRuntime; apiKey: string | null; defaultModel: string | null }> {
  const settings = await getOrCreateSettings(ctx);
  let adapter = getRuntime(settings.activeRuntimeId);
  if (!adapter) {
    // Settings row references an unknown runtime — fall back to ollama
    // rather than failing the request. The user can re-pick from Settings.
    adapter = getRuntime("ollama");
    if (!adapter) throw new Error("Default runtime adapter missing — broken install");
  }
  const creds = await loadCredentialsMap(ctx);
  return { adapter, apiKey: creds.get(adapter.id) ?? null, defaultModel: settings.defaultModel };
}

export async function listActiveRuntimeModels(ctx: TenantContext): Promise<RuntimeModel[]> {
  const { adapter, apiKey } = await resolveActiveAdapter(ctx);
  try {
    return await adapter.listModels(ctx, apiKey);
  } catch (e) {
    if (e instanceof CloudCredentialMissingError) return [];
    throw e;
  }
}

export async function listRuntimeModels(
  ctx: TenantContext,
  runtimeId: string,
): Promise<RuntimeModel[]> {
  const adapter = getRuntime(runtimeId);
  if (!adapter) return [];
  const creds = await loadCredentialsMap(ctx);
  try {
    return await adapter.listModels(ctx, creds.get(runtimeId) ?? null);
  } catch (e) {
    if (e instanceof CloudCredentialMissingError) return [];
    throw e;
  }
}

export async function pullActiveRuntimeModel(
  ctx: TenantContext,
  name: string,
): Promise<{ name: string; status: string; scheduledAt: string }> {
  const { adapter } = await resolveActiveAdapter(ctx);
  if (!adapter.pullModel) {
    return { name, status: "unsupported", scheduledAt: new Date().toISOString() };
  }
  return adapter.pullModel(ctx, name);
}

export class CloudConsentRequiredError extends Error {
  readonly code = "CLOUD_CONSENT_REQUIRED";
  constructor(public readonly runtimeId: string, public readonly residency: RuntimeResidency) {
    super(
      `Runtime "${runtimeId}" residency=${residency} requires per-session cloud confirmation`,
    );
  }
}

export class RuntimeUnavailableError extends Error {
  readonly code = "RUNTIME_UNAVAILABLE";
  constructor(
    public readonly runtimeId: string,
    public readonly health: RuntimeHealth,
  ) {
    super(`Runtime "${runtimeId}" is ${health.status}: ${health.detail ?? "no detail"}`);
  }
}

export class EmbeddingsUnsupportedError extends Error {
  readonly code = "EMBEDDINGS_UNSUPPORTED";
  constructor(public readonly runtimeId: string) {
    super(`Runtime "${runtimeId}" does not expose an embeddings API`);
  }
}

/**
 * Pre-flight that the active adapter can serve the request — used by
 * chat/stream/embed to surface a clean RUNTIME_UNAVAILABLE rather than
 * an opaque downstream failure when the runtime has gone offline
 * mid-task.
 */
async function ensureHealthy(adapter: ModelRuntime, ctx: TenantContext, apiKey: string | null): Promise<void> {
  // Uniform pre-flight for local AND cloud adapters: a quick health
  // probe so a runtime that has gone offline mid-task surfaces a
  // clean RUNTIME_UNAVAILABLE rather than an opaque downstream
  // failure. Cloud adapters implement health() against their provider
  // (OpenAI: GET /v1/models, Anthropic: 1-token /v1/messages probe);
  // failed probes raise the same pause-and-notify path as local ones.
  const h = await adapter.health(ctx, apiKey);
  if (h.status === "unreachable") {
    await logPrivacyEvent(ctx, {
      eventType: "runtime.unavailable",
      actor: ctx.userId ?? ctx.tenantId,
      target: adapter.id,
      severity: "high",
      detail: h.detail ?? "unreachable",
    });
    throw new RuntimeUnavailableError(adapter.id, h);
  }
}

/**
 * Normalizes errors raised by adapter chat / stream / embed calls so
 * the routes layer always sees a recognised runtime error. Without
 * this, an upstream cloud outage during a chat request would either
 * bubble up as a generic 500 or (in the old design) silently produce
 * a stub assistant message that the orchestrator would treat as real.
 */
function normalizeRuntimeError(adapter: ModelRuntime, e: unknown): never {
  if (e instanceof RuntimeUpstreamError) {
    throw new RuntimeUnavailableError(adapter.id, {
      status: "unreachable",
      detail: e.detail,
      detectedAt: new Date().toISOString(),
    });
  }
  throw e;
}

/** True iff the active adapter has been opted-in for this session. */
function isConfirmed(adapter: ModelRuntime, confirmedRuntimeIds: string[]): boolean {
  if (adapter.residency === "local") return true;
  return confirmedRuntimeIds.includes(adapter.id);
}

export async function chatWithActiveRuntime(
  ctx: TenantContext,
  req: RuntimeChatRequest,
  confirmedRuntimeIds: string[],
): Promise<RuntimeChatResult> {
  const { adapter, apiKey, defaultModel } = await resolveActiveAdapter(ctx);
  if (!isConfirmed(adapter, confirmedRuntimeIds)) {
    throw new CloudConsentRequiredError(adapter.id, adapter.residency);
  }
  // Health preflight applies to every chat path so a runtime that
  // disappears mid-task surfaces a clean 503 RUNTIME_UNAVAILABLE
  // (pause and notify) instead of falling back to a stub message.
  await ensureHealthy(adapter, ctx, apiKey);
  const model = req.model || defaultModel || (adapter.id === "ollama" ? "llama3" : "");
  try {
    return await adapter.chat(ctx, { ...req, model }, apiKey);
  } catch (e) {
    // Cloud adapters raise RuntimeUpstreamError on provider failures;
    // local adapters on socket errors. Normalize both to
    // RuntimeUnavailableError so /api/chat answers 503 RUNTIME_UNAVAILABLE
    // and the agent orchestrator pauses (tool_validation envelope).
    if (e instanceof RuntimeUpstreamError) {
      await logPrivacyEvent(ctx, {
        eventType: "runtime.unavailable",
        actor: ctx.userId ?? ctx.tenantId,
        target: adapter.id,
        severity: "high",
        detail: e.detail,
      });
    }
    normalizeRuntimeError(adapter, e);
  }
}

export async function* streamChatWithActiveRuntime(
  ctx: TenantContext,
  req: RuntimeChatRequest,
  confirmedRuntimeIds: string[],
): AsyncGenerator<RuntimeChatChunk> {
  const { adapter, apiKey, defaultModel } = await resolveActiveAdapter(ctx);
  if (!isConfirmed(adapter, confirmedRuntimeIds)) {
    throw new CloudConsentRequiredError(adapter.id, adapter.residency);
  }
  await ensureHealthy(adapter, ctx, apiKey);
  const model = req.model || defaultModel || (adapter.id === "ollama" ? "llama3" : "");
  try {
    if (adapter.chatStream) {
      yield* adapter.chatStream(ctx, { ...req, model }, apiKey);
      return;
    }
    // Adapters without a streaming impl: synthesise a single-chunk stream
    // from the batch chat response so callers get a uniform contract.
    const r = await adapter.chat(ctx, { ...req, model }, apiKey);
    yield { delta: r.message.content, done: true, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  } catch (e) {
    if (e instanceof RuntimeUpstreamError) {
      await logPrivacyEvent(ctx, {
        eventType: "runtime.unavailable",
        actor: ctx.userId ?? ctx.tenantId,
        target: adapter.id,
        severity: "high",
        detail: e.detail,
      });
    }
    normalizeRuntimeError(adapter, e);
  }
}

export async function embedWithActiveRuntime(
  ctx: TenantContext,
  req: RuntimeEmbedRequest,
  confirmedRuntimeIds: string[],
): Promise<RuntimeEmbedResult> {
  const { adapter, apiKey } = await resolveActiveAdapter(ctx);
  if (!isConfirmed(adapter, confirmedRuntimeIds)) {
    throw new CloudConsentRequiredError(adapter.id, adapter.residency);
  }
  if (!adapter.capabilities.embeddings || !adapter.embed) {
    throw new EmbeddingsUnsupportedError(adapter.id);
  }
  await ensureHealthy(adapter, ctx, apiKey);
  try {
    return await adapter.embed(ctx, req, apiKey);
  } catch (e) {
    if (e instanceof RuntimeUpstreamError) {
      await logPrivacyEvent(ctx, {
        eventType: "runtime.unavailable",
        actor: ctx.userId ?? ctx.tenantId,
        target: adapter.id,
        severity: "high",
        detail: e.detail,
      });
    }
    normalizeRuntimeError(adapter, e);
  }
}

export {
  ALL_RUNTIMES,
  CloudCredentialMissingError,
  detectLocalRuntimes,
  getRuntime,
  listRuntimes,
};
export type { RuntimeChatRequest, RuntimeChatResult, RuntimeHealth, RuntimeModel } from "./runtime/types";
