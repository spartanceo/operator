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
  ImageGenRequest,
  ImageGenResult,
  ImageGenRuntime,
} from "./capability/types";

export { detectLocalCapabilityBackends };

function credentialKey(backendId: string): string {
  return `cap:${backendId}`;
}

function keychainAccount(ctx: TenantContext, backendId: string): string {
  return `${ctx.tenantId}:cap:${backendId}`;
}

/**
 * OpenAI-family capability backends that share the same API key as the
 * LLM "openai" runtime. When a user saves their OpenAI key for chat, these
 * backends inherit it automatically — the fallback is never written back to
 * the credential store and never overwrites an explicitly stored cap key.
 */
// tier-review: bounded — static 3-element constant, never mutated
const OPENAI_FAMILY_BACKENDS: readonly string[] = ["dalle", "openai-tts", "openai-embed"];

/**
 * Keychain account for a cloud LLM runtime credential.
 * Mirrors the convention used by runtime.service.ts so both services resolve
 * the same keychain slot when looking up the "openai" runtime key.
 */
function llmKeychainAccount(ctx: TenantContext, runtimeId: string): string {
  return `${ctx.tenantId}:${runtimeId}`;
}

async function loadCapabilityCredentialsMap(ctx: TenantContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const kc = await keychainBridge();

  // --- Phase 1: explicit capability keys from OS keychain ---
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

  // --- Phase 2: explicit capability keys from encrypted SQLite ---
  // Also collect the LLM "openai" row here so the fallback (Phase 3) can use it.
  const credKeys = ALL_CAPABILITY_BACKENDS.map((b) => credentialKey(b.id));
  const rows = await db
    .select()
    .from(runtimeCredentials)
    .where(tenantScope(ctx, runtimeCredentials));

  let openaiLlmDbKey: string | null = null;
  for (const r of rows) {
    if (r.runtimeId === "openai") {
      try {
        openaiLlmDbKey = decryptApiKey({ encryptedKey: r.encryptedKey, iv: r.iv, authTag: r.authTag });
      } catch (e) {
        logger.error({ err: e }, "Failed to decrypt openai LLM credential for capability fallback");
      }
      continue;
    }
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

  // --- Phase 3: OpenAI-family fallback (applied AFTER all explicit keys) ---
  // For any OpenAI-family backend still without a credential, reuse the LLM
  // "openai" runtime key. This lets a user who saved their key once for chat
  // immediately use DALL-E / TTS / embeddings without re-entering the key.
  // The fallback never overwrites an explicitly stored capability key.
  const needsFallback = OPENAI_FAMILY_BACKENDS.some((id) => !out.has(id));
  if (needsFallback) {
    let openaiLlmKey = openaiLlmDbKey;
    if (openaiLlmKey === null && kc.available) {
      try {
        openaiLlmKey = await kc.get(llmKeychainAccount(ctx, "openai"));
      } catch (e) {
        logger.warn({ err: e }, "keychain.get failed (openai LLM fallback for capabilities)");
      }
    }
    if (openaiLlmKey) {
      for (const id of OPENAI_FAMILY_BACKENDS) {
        if (!out.has(id)) out.set(id, openaiLlmKey);
      }
    }
  }

  return out;
}

/**
 * Auto-activate a capability backend when it is the first credential saved
 * for that capability type. This prevents users from having to visit
 * Settings → Capability Backends to click a separate "Set as active" control.
 * The auto-activation is logged with a distinct detail string so it is
 * distinguishable from a manual switch in the privacy audit log.
 */
async function autoActivateIfFirstCredential(
  ctx: TenantContext,
  capabilityType: CapabilityType,
  backendId: string,
): Promise<void> {
  const currentActive = await getActiveBackendId(ctx, capabilityType);
  if (currentActive === null) {
    await upsertActiveBackendId(ctx, capabilityType, backendId);
    await logPrivacyEvent(ctx, {
      eventType: "runtime.switched",
      actor: ctx.userId ?? ctx.tenantId,
      target: backendId,
      severity: "info",
      detail: `capability=${capabilityType} auto-activated-on-first-credential`,
    });
    logger.info({ backendId, capabilityType }, "Auto-activated capability backend on first credential save");
  }
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
    await autoActivateIfFirstCredential(ctx, backend.capabilityType, backendId);
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
  await autoActivateIfFirstCredential(ctx, backend.capabilityType, backendId);
  return { backendId, hasCredential: true };
}

/**
 * Generate an image via the currently active image-gen backend for the tenant.
 *
 * Resolution order:
 *   1. Explicitly active backend from capability_settings.
 *   2. DALL-E ("dalle") when no backend is active but an OpenAI credential is
 *      available (either via an explicit cap:dalle key or the LLM "openai"
 *      runtime key fallback). This lets users who saved their OpenAI key for
 *      chat generate images immediately without a separate settings step.
 *
 * Throws "NO_IMAGE_GEN_BACKEND" when no backend resolves.
 */
export async function generateImage(
  ctx: TenantContext,
  req: ImageGenRequest,
): Promise<ImageGenResult> {
  const [storedActiveId, creds] = await Promise.all([
    getActiveBackendId(ctx, "image-gen"),
    loadCapabilityCredentialsMap(ctx),
  ]);

  // Derive the active backend: prefer the explicitly stored selection, fall
  // back to DALL-E when a credential is available via the LLM key fallback.
  const activeBackendId = storedActiveId ?? (creds.has("dalle") ? "dalle" : null);

  if (!activeBackendId) {
    throw new Error("NO_IMAGE_GEN_BACKEND: No image-gen backend is configured. Select one in Settings → Capability Backends.");
  }

  const backend = getCapabilityBackend(activeBackendId);
  if (!backend || backend.capabilityType !== "image-gen") {
    throw new Error(`Unknown image-gen backend "${activeBackendId}"`);
  }

  const imageGenBackend = backend as ImageGenRuntime;
  if (typeof imageGenBackend.generate !== "function") {
    throw new Error(`Backend "${activeBackendId}" does not implement generate()`);
  }

  const apiKey = creds.get(activeBackendId) ?? null;
  return imageGenBackend.generate(ctx, req, apiKey);
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
 * given tenant. Returns null backend when no TTS backend has been selected
 * and no credential-based fallback is available.
 *
 * Resolution order:
 *   1. Explicitly active backend from capability_settings.
 *   2. OpenAI TTS ("openai-tts") when no backend is active but an OpenAI
 *      credential is available (either via an explicit cap:openai-tts key or
 *      the LLM "openai" runtime key fallback). This lets users who saved their
 *      OpenAI key for chat generate audio immediately without a separate step.
 *
 * Used by voice.service.ts and media.service.ts to route synthesize() to the
 * correct engine.
 */
export async function getActiveTTSContext(ctx: TenantContext): Promise<{
  backend: TTSRuntime | null;
  apiKey: string | null;
}> {
  const [storedBackendId, creds] = await Promise.all([
    getActiveBackendId(ctx, "tts"),
    loadCapabilityCredentialsMap(ctx),
  ]);

  // Derive the active backend: prefer the explicitly stored selection, fall
  // back to OpenAI TTS when a credential is available via the LLM key fallback.
  const backendId = storedBackendId ?? (creds.has("openai-tts") ? "openai-tts" : null);

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
