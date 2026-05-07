/**
 * Capability service — public surface used by the routes layer for all
 * non-LLM capability backends (image-gen, web-search, tts, embeddings,
 * code-sandbox).
 *
 * Responsibilities:
 *   - Persist the active backend selection per (tenant, capabilityType) in
 *     `capability_settings`.
 *   - Persist encrypted API keys per (tenant, backendId) reusing the existing
 *     `runtime_credentials` table (the column is called `runtimeId` but the
 *     schema supports any backend id string — we prefix with "cap:" to avoid
 *     id collisions with model runtimes).
 *   - Expose `getActiveCapabilityInfo()` and `setActiveCapabilityBackend()`
 *     for each capability type.
 *   - Expose `detectLocalCapabilityBackends()` for the startup auto-probe.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  capabilitySettings,
  runtimeCredentials,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";
import { logPrivacyEvent } from "./privacy.service";
import { decryptApiKey, encryptApiKey, keychainBridge } from "./runtime/credentials";
import {
  ALL_CAPABILITY_BACKENDS,
  ALL_CAPABILITY_TYPES,
  detectLocalCapabilityBackends,
  getCapabilityBackend,
  listCapabilityBackendsForType,
} from "./capability/registry";
import type {
  ActiveCapabilityInfo,
  CapabilityDescriptor,
  CapabilityType,
  WebSearchResult,
  WebSearchRuntime,
  TTSRuntime,
} from "./capability/types";

export { detectLocalCapabilityBackends };

function credentialKey(backendId: string): string {
  return `cap:${backendId}`;
}

function keychainAccount(ctx: TenantContext, backendId: string): string {
  return `${ctx.tenantId}:cap:${backendId}`;
}

async function loadCapabilityCredentialsMap(ctx: TenantContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const kc = await keychainBridge();
  if (kc.available) {
    for (const b of ALL_CAPABILITY_BACKENDS) {
      try {
        const v = await kc.get(keychainAccount(ctx, b.id));
        if (v) out.set(b.id, v);
      } catch (e) {
        logger.warn({ err: e, backendId: b.id }, "keychain.get failed (capability)");
      }
    }
  }
  const credKeys = ALL_CAPABILITY_BACKENDS.map((b) => credentialKey(b.id));
  const rows = await db
    .select()
    .from(runtimeCredentials)
    .where(tenantScope(ctx, runtimeCredentials));
  for (const r of rows) {
    if (!credKeys.includes(r.runtimeId)) continue;
    const backendId = r.runtimeId.replace(/^cap:/, "");
    if (out.has(backendId)) continue;
    try {
      out.set(
        backendId,
        decryptApiKey({ encryptedKey: r.encryptedKey, iv: r.iv, authTag: r.authTag }),
      );
    } catch (e) {
      logger.error({ err: e, backendId }, "Failed to decrypt capability credential");
    }
  }
  return out;
}

async function getActiveBackendId(
  ctx: TenantContext,
  capabilityType: CapabilityType,
): Promise<string | null> {
  const row = await db
    .select()
    .from(capabilitySettings)
    .where(
      and(
        tenantScope(ctx, capabilitySettings),
        eq(capabilitySettings.capabilityType, capabilityType),
      ),
    )
    .limit(1);
  return row[0]?.activeBackendId ?? null;
}

async function upsertActiveBackendId(
  ctx: TenantContext,
  capabilityType: CapabilityType,
  backendId: string | null,
): Promise<void> {
  const existing = await db
    .select({ id: capabilitySettings.id })
    .from(capabilitySettings)
    .where(
      and(
        tenantScope(ctx, capabilitySettings),
        eq(capabilitySettings.capabilityType, capabilityType),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(capabilitySettings)
      .set({ activeBackendId: backendId, updatedAt: Date.now() })
      .where(
        and(
          tenantScope(ctx, capabilitySettings),
          eq(capabilitySettings.capabilityType, capabilityType),
        ),
      );
  } else {
    await db.insert(capabilitySettings).values(
      withTenantValues(ctx, {
        id: `cs_${nanoid()}`,
        capabilityType,
        activeBackendId: backendId,
      }),
    );
  }
}

export async function getActiveCapabilityInfo(
  ctx: TenantContext,
  capabilityType: CapabilityType,
): Promise<ActiveCapabilityInfo> {
  const [activeBackendId, detectedIds, creds] = await Promise.all([
    getActiveBackendId(ctx, capabilityType),
    detectLocalCapabilityBackends(ctx),
    loadCapabilityCredentialsMap(ctx),
  ]);

  const backends = listCapabilityBackendsForType(capabilityType);
  const descriptors: CapabilityDescriptor[] = await Promise.all(
    backends.map(async (b) => {
      const apiKey = creds.get(b.id) ?? null;
      const health = await b.health(ctx, apiKey);
      return {
        id: b.id,
        displayName: b.displayName,
        capabilityType: b.capabilityType,
        residency: b.residency,
        requiresApiKey: b.requiresApiKey,
        hasCredential: creds.has(b.id),
        health,
      } satisfies CapabilityDescriptor;
    }),
  );

  return {
    capabilityType,
    activeBackendId,
    detectedBackendIds: detectedIds.filter((id) => {
      const b = getCapabilityBackend(id);
      return b?.capabilityType === capabilityType;
    }),
    backends: descriptors,
  };
}

export async function listAllCapabilityInfo(
  ctx: TenantContext,
): Promise<ActiveCapabilityInfo[]> {
  return Promise.all(ALL_CAPABILITY_TYPES.map((t) => getActiveCapabilityInfo(ctx, t)));
}

export async function setActiveCapabilityBackend(
  ctx: TenantContext,
  capabilityType: CapabilityType,
  backendId: string | null,
): Promise<{ capabilityType: CapabilityType; activeBackendId: string | null }> {
  if (backendId !== null) {
    const backend = getCapabilityBackend(backendId);
    if (!backend) {
      throw new Error(`Unknown capability backend "${backendId}"`);
    }
    if (backend.capabilityType !== capabilityType) {
      throw new Error(
        `Backend "${backendId}" is for "${backend.capabilityType}", not "${capabilityType}"`,
      );
    }
  }

  await upsertActiveBackendId(ctx, capabilityType, backendId);
  await logPrivacyEvent(ctx, {
    eventType: "runtime.switched",
    actor: ctx.userId ?? ctx.tenantId,
    target: backendId ?? "(none)",
    severity: "info",
    detail: `capability=${capabilityType}`,
  });
  return { capabilityType, activeBackendId: backendId };
}

export async function setCapabilityCredential(
  ctx: TenantContext,
  backendId: string,
  apiKey: string,
  label?: string | null,
): Promise<{ backendId: string; hasCredential: true }> {
  const backend = getCapabilityBackend(backendId);
  if (!backend) throw new Error(`Unknown capability backend "${backendId}"`);
  if (!backend.requiresApiKey) {
    throw new Error(`Backend "${backendId}" does not accept API keys`);
  }

  const kc = await keychainBridge();
  if (kc.available) {
    await kc.set(keychainAccount(ctx, backendId), apiKey);
    await logPrivacyEvent(ctx, {
      eventType: "runtime.credential.set",
      actor: ctx.userId ?? ctx.tenantId,
      target: `cap:${backendId}`,
      severity: "high",
      detail: "os-keychain",
    });
    return { backendId, hasCredential: true };
  }

  const blob = encryptApiKey(apiKey);
  const credId = credentialKey(backendId);
  const existing = await db
    .select({ id: runtimeCredentials.id })
    .from(runtimeCredentials)
    .where(
      and(
        tenantScope(ctx, runtimeCredentials),
        eq(runtimeCredentials.runtimeId, credId),
      ),
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
        and(
          tenantScope(ctx, runtimeCredentials),
          eq(runtimeCredentials.runtimeId, credId),
        ),
      );
  } else {
    await db.insert(runtimeCredentials).values(
      withTenantValues(ctx, {
        id: `rc_${nanoid()}`,
        runtimeId: credId,
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
    target: `cap:${backendId}`,
    severity: "high",
    detail: "encrypted-at-rest",
  });
  return { backendId, hasCredential: true };
}

export async function deleteCapabilityCredential(
  ctx: TenantContext,
  backendId: string,
): Promise<{ backendId: string; deleted: boolean }> {
  let deleted = false;
  const kc = await keychainBridge();
  if (kc.available) {
    try {
      const had = await kc.get(keychainAccount(ctx, backendId));
      if (had) {
        await kc.del(keychainAccount(ctx, backendId));
        deleted = true;
      }
    } catch (e) {
      logger.warn({ err: e, backendId }, "keychain.del failed (capability)");
    }
  }
  const credId = credentialKey(backendId);
  const result = await db
    .delete(runtimeCredentials)
    .where(
      and(
        tenantScope(ctx, runtimeCredentials),
        eq(runtimeCredentials.runtimeId, credId),
      ),
    );
  if ((result as { changes?: number }).changes !== 0) deleted = true;
  if (deleted) {
    await logPrivacyEvent(ctx, {
      eventType: "runtime.credential.deleted",
      actor: ctx.userId ?? ctx.tenantId,
      target: `cap:${backendId}`,
      severity: "medium",
    });
  }
  return { backendId, deleted };
}

/**
 * Execute a web search through the active web-search capability backend.
 *
 * Resolution order:
 *   1. Active backend from capability_settings (searxng, brave-search, serper, bing-search)
 *   2. If no active backend is set, returns null so the caller can fall
 *      back to integration-provider credentials (legacy path).
 *
 * The API key (when required) is read from the capability credentials store.
 */
export async function webSearchWithActiveBackend(
  ctx: TenantContext,
  query: string,
  numResults: number,
): Promise<{ results: WebSearchResult[]; provider: string } | null> {
  const activeId = await getActiveBackendId(ctx, "web-search");
  if (!activeId) return null;

  const backend = getCapabilityBackend(activeId);
  if (!backend || backend.capabilityType !== "web-search") return null;

  const webSearchBackend = backend as WebSearchRuntime;

  let apiKey: string | null = null;
  if (backend.requiresApiKey) {
    const creds = await loadCapabilityCredentialsMap(ctx);
    apiKey = creds.get(activeId) ?? null;
    if (!apiKey) {
      throw new Error(
        `Web search backend "${activeId}" requires an API key — add one in Settings → Capabilities → Web Search.`,
      );
    }
  }

  const results = await webSearchBackend.search(ctx, query, numResults, apiKey);
  return { results, provider: activeId };
}

/**
 * Check whether SearXNG is reachable at the configured host.
 * Used by the onboarding status endpoint.
 */
export async function checkSearXNGStatus(ctx: TenantContext): Promise<boolean> {
  const backend = getCapabilityBackend("searxng");
  if (!backend) return false;
  return backend.detect(ctx);
}

/**
 * Returns the active TTS runtime and its stored API key (if any) for the
 * given tenant. Returns null backend when no TTS backend has been selected.
 * Used by voice.service.ts to route synthesize() to the correct engine.
 */
export async function getActiveTTSContext(ctx: TenantContext): Promise<{
  backend: TTSRuntime | null;
  apiKey: string | null;
}> {
  const [backendId, creds] = await Promise.all([
    getActiveBackendId(ctx, "tts"),
    loadCapabilityCredentialsMap(ctx),
  ]);
  if (!backendId) return { backend: null, apiKey: null };
  const backend = getCapabilityBackend(backendId);
  if (!backend || backend.capabilityType !== "tts") return { backend: null, apiKey: null };
  return {
    backend: backend as TTSRuntime,
    apiKey: creds.get(backendId) ?? null,
  };
}

/**
 * Returns the voice catalogue for the active TTS backend.
 * Calls getVoices() on the backend (which may fetch live account voices for
 * cloud backends like ElevenLabs) and falls back to the static catalogue.
 * Returns an empty array when no backend is selected.
 */
export async function getActiveTTSVoices(ctx: TenantContext) {
  const { backend, apiKey } = await getActiveTTSContext(ctx);
  if (!backend) return [];
  if (backend.getVoices) {
    try {
      return await backend.getVoices(ctx, apiKey);
    } catch {
      // Fall through to static catalogue on error.
    }
  }
  return backend.voices;
}
