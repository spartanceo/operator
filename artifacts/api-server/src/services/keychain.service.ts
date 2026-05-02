/**
 * Keychain / vault service.
 *
 * In production (desktop): credentials live in the OS keychain (Mac
 * Keychain, Windows Credential Manager, Secret Service via libsecret).
 * In dev / tests / server-only deployments: credentials are sealed with
 * AES-256-GCM under a key derived from the master password and stored
 * in `secret_vault_entries`. The same `(namespace, keyName)` lookup
 * works for both backends — the desktop wrapper swaps the implementation
 * by setting `OMNINITY_KEYCHAIN_BACKEND=keytar`.
 *
 * The plaintext is only present in memory for the duration of the call;
 * `secureMemoryWipe` is invoked on every Buffer the service allocates.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  secretVaultEntries,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import {
  deriveVaultKey,
  openSecret,
  sealSecret,
  secureMemoryWipe,
} from "../lib/security-crypto";
import { appendAuditEntry } from "./audit.service";
import { logSecurityEvent } from "./security-events.service";

export class VaultError extends Error {
  override readonly name = "VaultError";
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface VaultPutInput {
  readonly namespace: string;
  readonly keyName: string;
  readonly plaintext: string;
  readonly masterPassword: string;
}

export interface VaultEntrySummary {
  readonly id: string;
  readonly namespace: string;
  readonly keyName: string;
  readonly backend: string;
  readonly updatedAt: string;
}

function activeBackend(): string {
  return process.env["OMNINITY_KEYCHAIN_BACKEND"] ?? "file";
}

export async function putVaultEntry(
  ctx: TenantContext,
  input: VaultPutInput,
): Promise<VaultEntrySummary> {
  if (!input.namespace || !input.keyName) {
    throw new VaultError("namespace and keyName are required", "INVALID_INPUT", 400);
  }
  if (!input.masterPassword) {
    throw new VaultError("masterPassword is required to seal a secret", "MASTER_PASSWORD_REQUIRED", 401);
  }
  const key = deriveVaultKey(input.masterPassword, input.namespace);
  let sealed;
  try {
    sealed = sealSecret(key, input.plaintext);
  } finally {
    secureMemoryWipe(key);
  }
  const existing = await db
    .select()
    .from(secretVaultEntries)
    .where(
      and(
        tenantScope(ctx, secretVaultEntries),
        eq(secretVaultEntries.namespace, input.namespace),
        eq(secretVaultEntries.keyName, input.keyName),
      ),
    )
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    const row = existing[0];
    await db
      .update(secretVaultEntries)
      .set({
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        backend: activeBackend(),
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(secretVaultEntries.id, row.id));
    await appendAuditEntry(ctx, {
      actor: ctx.userId ?? "system",
      action: "vault.update",
      resourceType: "vault_entry",
      resourceId: row.id,
      summary: `Updated ${input.namespace}/${input.keyName}`,
    });
    return {
      id: row.id,
      namespace: input.namespace,
      keyName: input.keyName,
      backend: activeBackend(),
      updatedAt: new Date(now).toISOString(),
    };
  }
  const id = `vlt_${nanoid()}`;
  await db.insert(secretVaultEntries).values(
    withTenantValues(ctx, {
      id,
      namespace: input.namespace,
      keyName: input.keyName,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      backend: activeBackend(),
      createdAt: now,
      updatedAt: now,
    }),
  );
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "system",
    action: "vault.create",
    resourceType: "vault_entry",
    resourceId: id,
    summary: `Stored ${input.namespace}/${input.keyName}`,
  });
  return {
    id,
    namespace: input.namespace,
    keyName: input.keyName,
    backend: activeBackend(),
    updatedAt: new Date(now).toISOString(),
  };
}

export async function getVaultEntry(
  ctx: TenantContext,
  namespace: string,
  keyName: string,
  masterPassword: string,
): Promise<string> {
  if (!masterPassword) {
    throw new VaultError("masterPassword required to unseal", "MASTER_PASSWORD_REQUIRED", 401);
  }
  const rows = await db
    .select()
    .from(secretVaultEntries)
    .where(
      and(
        tenantScope(ctx, secretVaultEntries),
        eq(secretVaultEntries.namespace, namespace),
        eq(secretVaultEntries.keyName, keyName),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new VaultError(`No vault entry for ${namespace}/${keyName}`, "NOT_FOUND", 404);
  }
  const key = deriveVaultKey(masterPassword, namespace);
  try {
    const plaintext = openSecret(key, {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
    });
    await logSecurityEvent(ctx, {
      eventType: "vault.read",
      severity: "info",
      actor: ctx.userId ?? "system",
      target: `${namespace}/${keyName}`,
    });
    return plaintext;
  } catch {
    await logSecurityEvent(ctx, {
      eventType: "vault.unseal.fail",
      severity: "high",
      actor: ctx.userId ?? "system",
      target: `${namespace}/${keyName}`,
    });
    throw new VaultError("Invalid master password or corrupted entry", "UNSEAL_FAILED", 401);
  } finally {
    secureMemoryWipe(key);
  }
}

export async function listVaultEntries(
  ctx: TenantContext,
): Promise<ReadonlyArray<VaultEntrySummary>> {
  const rows = await db
    .select()
    .from(secretVaultEntries)
    .where(tenantScope(ctx, secretVaultEntries));
  return rows.map((r) => ({
    id: r.id,
    namespace: r.namespace,
    keyName: r.keyName,
    backend: r.backend,
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
}

export async function deleteVaultEntry(
  ctx: TenantContext,
  namespace: string,
  keyName: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(secretVaultEntries)
    .where(
      and(
        tenantScope(ctx, secretVaultEntries),
        eq(secretVaultEntries.namespace, namespace),
        eq(secretVaultEntries.keyName, keyName),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  await db
    .delete(secretVaultEntries)
    .where(eq(secretVaultEntries.id, row.id));
  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "system",
    action: "vault.delete",
    resourceType: "vault_entry",
    resourceId: row.id,
    summary: `Deleted ${namespace}/${keyName}`,
  });
  return true;
}
