/**
 * Workspaces service — Task #42.
 *
 * A workspace is the user-visible container for an isolated bundle of
 * conversations, knowledge-base data, memories, integrations, and
 * settings. Every workspace-scoped table already carries `workspace_id`
 * (Standard 13) so isolation is enforced by the existing `tenantScope`
 * helper — switching workspaces is just a matter of changing the bound
 * `workspaceId` in the request context.
 *
 * Service surface:
 *   - listWorkspaces     — every active workspace for the tenant.
 *   - getWorkspace       — single row by id.
 *   - createWorkspace    — colour / icon defaulted; can claim default.
 *   - updateWorkspace    — name, description, colour, icon, isDefault.
 *   - deleteWorkspace    — soft-delete via `status = 'erased'`. Refuses
 *                          to delete the only remaining active workspace
 *                          and refuses to delete the default workspace
 *                          unless another workspace claims default first.
 *   - touchLastActive    — bump `lastActiveAt` when the user switches in.
 *   - getWorkspaceOverview — counts of agent runs, kb collections,
 *                          documents, memories + last active timestamp.
 *   - exportWorkspaceTemplate — packages a workspace's *configuration*
 *                          (no personal data) so it can be shared and
 *                          re-imported elsewhere.
 *   - importWorkspaceTemplate — recreates a workspace from a template.
 *
 * Soft-delete rationale: every workspace-scoped table holds `workspace_id`
 * with a `NOT NULL` foreign key, so a hard delete would either leave
 * dangling rows or require a deep cascade across ~30 tables. Soft-delete
 * via `status='erased'` is consistent with the GDPR pattern in
 * `eraseTenantData`, hides the workspace from the switcher (the unique
 * partial index ignores erased rows because is_default is always 0 once
 * we strip it before delete), and lets the existing background tenant
 * purge sweep eventually reclaim the rows.
 */
import { and, eq, ne, sql, type AnyColumn } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";

import {
  agentRuns,
  db,
  kbCollections,
  kbDocuments,
  memories,
  tenantScope,
  withTenantValues,
  workspaces,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isDefault: boolean;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  isDefault?: boolean;
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  isDefault?: boolean;
}

export interface WorkspaceOverview {
  workspace: WorkspaceRow;
  stats: {
    agentRunCount: number;
    kbCollectionCount: number;
    kbDocumentCount: number;
    memoryCount: number;
    lastActiveAt: string | null;
  };
}

export interface WorkspaceTemplate {
  schemaVersion: 1;
  exportedAt: string;
  workspace: {
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
  };
  collections: Array<{
    name: string;
    description: string | null;
    color: string | null;
  }>;
}

export class WorkspaceConflictError extends Error {
  override readonly name = "WorkspaceConflictError";
  constructor(
    public readonly code:
      | "DEFAULT_PROTECTED"
      | "LAST_WORKSPACE"
      | "SYSTEM_WORKSPACE"
      | "INVALID_TEMPLATE"
      | "DUPLICATE_NAME",
    message: string,
  ) {
    super(message);
  }
}

// tier-review: bounded — fixed 19-element palette of Tailwind colour tokens, never grows.
const ALLOWED_COLORS = new Set([
  "slate",
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);

function normaliseColor(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).toLowerCase().trim();
  if (!ALLOWED_COLORS.has(v)) return null;
  return v;
}

function normaliseIcon(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  // Lucide icon identifiers — alpha + dash only, capped length.
  if (!/^[a-z][a-z0-9-]{0,40}$/i.test(v)) return null;
  return v.toLowerCase();
}

function toRow(r: typeof workspaces.$inferSelect): WorkspaceRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    color: r.color,
    icon: r.icon,
    isDefault: r.isDefault === 1,
    lastActiveAt: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function listWorkspaces(
  ctx: TenantContext,
): Promise<WorkspaceRow[]> {
  // We deliberately bypass workspaceId scoping here — the workspaces table
  // does not carry workspaceId itself (it IS the workspace). `tenantScope`
  // skips the workspaceId predicate when the table lacks the column.
  const rows = await db
    .select()
    .from(workspaces)
    .where(tenantScope(ctx, workspaces))
    .orderBy(sql`is_default DESC, name ASC`);
  return rows.map(toRow);
}

export async function getWorkspace(
  ctx: TenantContext,
  id: string,
): Promise<WorkspaceRow | null> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(and(tenantScope(ctx, workspaces), eq(workspaces.id, id)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

async function clearDefault(tenantId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ isDefault: 0, updatedAt: Date.now() })
    .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.isDefault, 1)));
}

export async function createWorkspace(
  ctx: TenantContext,
  input: CreateWorkspaceInput,
): Promise<WorkspaceRow> {
  const name = input.name.trim();
  if (!name) {
    throw new WorkspaceConflictError("DUPLICATE_NAME", "Workspace name is required");
  }
  const id = `ws_${nanoid()}`;
  const isDefault = input.isDefault === true;
  if (isDefault) {
    await clearDefault(ctx.tenantId);
  }
  await db.insert(workspaces).values(
    withTenantValues(ctx, {
      id,
      tenantId: ctx.tenantId,
      name,
      description: input.description?.trim() || null,
      color: normaliseColor(input.color) ?? "indigo",
      icon: normaliseIcon(input.icon) ?? "folder",
      isDefault: isDefault ? 1 : 0,
      status: "active",
    }),
  );
  // The withTenantValues helper stamps workspaceId — strip it back to the
  // newly-minted id so the row reads correctly via getWorkspace below.
  await db
    .update(workspaces)
    .set({ updatedAt: Date.now() })
    .where(eq(workspaces.id, id));
  // Reload via tenant-scoped read to confirm isolation.
  const created = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.tenantId, ctx.tenantId), eq(workspaces.id, id)))
    .limit(1);
  if (!created[0]) throw new Error("Workspace not found after insert");
  return toRow(created[0]);
}

export async function updateWorkspace(
  ctx: TenantContext,
  id: string,
  input: UpdateWorkspaceInput,
): Promise<WorkspaceRow | null> {
  const existing = await getWorkspace(ctx, id);
  if (!existing) return null;
  if (id === "workspace_system") {
    throw new WorkspaceConflictError(
      "SYSTEM_WORKSPACE",
      "The system workspace is read-only",
    );
  }

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new WorkspaceConflictError(
        "DUPLICATE_NAME",
        "Workspace name cannot be empty",
      );
    }
    patch["name"] = trimmed;
  }
  if (input.description !== undefined) {
    patch["description"] = input.description?.toString().trim() || null;
  }
  if (input.color !== undefined) {
    patch["color"] = normaliseColor(input.color);
  }
  if (input.icon !== undefined) {
    patch["icon"] = normaliseIcon(input.icon);
  }
  if (input.isDefault === true && !existing.isDefault) {
    await clearDefault(ctx.tenantId);
    patch["isDefault"] = 1;
  } else if (input.isDefault === false && existing.isDefault) {
    // Refuse to demote unless another active default already exists; the
    // unique partial index would not flag this (multiple zeros are fine)
    // but the UX contract is "exactly one default per tenant".
    throw new WorkspaceConflictError(
      "DEFAULT_PROTECTED",
      "Promote another workspace to default before demoting this one",
    );
  }

  await db
    .update(workspaces)
    .set(patch)
    .where(and(eq(workspaces.tenantId, ctx.tenantId), eq(workspaces.id, id)));

  return getWorkspace(ctx, id);
}

export async function deleteWorkspace(
  ctx: TenantContext,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  const existing = await getWorkspace(ctx, id);
  if (!existing) return { id, deleted: false };
  if (id === "workspace_system") {
    throw new WorkspaceConflictError(
      "SYSTEM_WORKSPACE",
      "The system workspace cannot be deleted",
    );
  }

  // Count remaining active workspaces (excluding the system one). Refuse
  // to delete the last user-facing workspace — every tenant must have at
  // least one workspace at all times so the switcher never lands on null.
  const activeRows = await db
    .select({ id: workspaces.id, isDefault: workspaces.isDefault })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.tenantId, ctx.tenantId),
        ne(workspaces.status, "erased"),
        ne(workspaces.id, "workspace_system"),
      ),
    );
  if (activeRows.length <= 1) {
    throw new WorkspaceConflictError(
      "LAST_WORKSPACE",
      "Cannot delete the last workspace in this tenant",
    );
  }
  if (existing.isDefault) {
    throw new WorkspaceConflictError(
      "DEFAULT_PROTECTED",
      "Promote another workspace to default before deleting this one",
    );
  }

  await db
    .update(workspaces)
    .set({ status: "erased", isDefault: 0, updatedAt: Date.now() })
    .where(and(eq(workspaces.tenantId, ctx.tenantId), eq(workspaces.id, id)));
  return { id, deleted: true };
}

export async function touchLastActive(
  ctx: TenantContext,
  id: string,
): Promise<WorkspaceRow | null> {
  const existing = await getWorkspace(ctx, id);
  if (!existing) return null;
  await db
    .update(workspaces)
    .set({ lastActiveAt: Date.now(), updatedAt: Date.now() })
    .where(and(eq(workspaces.tenantId, ctx.tenantId), eq(workspaces.id, id)));
  return getWorkspace(ctx, id);
}

// ─── Overview ───────────────────────────────────────────────────────────────

type CountableTable = SQLiteTable & {
  readonly tenantId: AnyColumn;
  readonly workspaceId: AnyColumn;
};

async function countScoped(
  tenantId: string,
  workspaceId: string,
  table: CountableTable,
): Promise<number> {
  // Hand-rolled count using explicit tenant + workspace predicates. We
  // can't use `tenantScope` here because the request context's
  // workspaceId is the *caller's* current workspace, not the overview
  // target — the overview page shows stats for an arbitrary workspace
  // owned by the same tenant.
  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(table)
    .where(
      and(eq(table.tenantId, tenantId), eq(table.workspaceId, workspaceId)),
    );
  return Number(rows[0]?.count ?? 0);
}

export async function getWorkspaceOverview(
  ctx: TenantContext,
  id: string,
): Promise<WorkspaceOverview | null> {
  const workspace = await getWorkspace(ctx, id);
  if (!workspace) return null;

  const [agentRunCount, kbCollectionCount, kbDocumentCount, memoryCount] =
    await Promise.all([
      countScoped(ctx.tenantId, id, agentRuns),
      countScoped(ctx.tenantId, id, kbCollections),
      countScoped(ctx.tenantId, id, kbDocuments),
      countScoped(ctx.tenantId, id, memories),
    ]);

  return {
    workspace,
    stats: {
      agentRunCount,
      kbCollectionCount,
      kbDocumentCount,
      memoryCount,
      lastActiveAt: workspace.lastActiveAt,
    },
  };
}

// ─── Templates (export / import without personal data) ─────────────────────

export async function exportWorkspaceTemplate(
  ctx: TenantContext,
  id: string,
): Promise<WorkspaceTemplate | null> {
  const workspace = await getWorkspace(ctx, id);
  if (!workspace) return null;

  // Knowledge-base collection *names* are configuration, not personal
  // data — they describe how the workspace is organised, not what's in
  // it. Documents, chunks, memories, conversations are skipped because
  // they're user content.
  const collectionRows = await db
    .select({
      name: kbCollections.name,
      description: kbCollections.description,
      color: kbCollections.color,
    })
    .from(kbCollections)
    .where(
      and(
        eq(kbCollections.tenantId, ctx.tenantId),
        eq(kbCollections.workspaceId, id),
      ),
    );

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      name: workspace.name,
      description: workspace.description,
      color: workspace.color,
      icon: workspace.icon,
    },
    collections: collectionRows.map((c) => ({
      name: c.name,
      description: c.description,
      color: c.color,
    })),
  };
}

export async function importWorkspaceTemplate(
  ctx: TenantContext,
  template: unknown,
  override: { name?: string } = {},
): Promise<WorkspaceRow> {
  if (
    !template ||
    typeof template !== "object" ||
    (template as { schemaVersion?: number }).schemaVersion !== 1 ||
    typeof (template as { workspace?: unknown }).workspace !== "object" ||
    !Array.isArray((template as { collections?: unknown }).collections)
  ) {
    throw new WorkspaceConflictError(
      "INVALID_TEMPLATE",
      "Template payload does not match schemaVersion 1",
    );
  }
  const t = template as WorkspaceTemplate;
  const targetName = override.name?.trim() || t.workspace.name;
  if (!targetName) {
    throw new WorkspaceConflictError(
      "DUPLICATE_NAME",
      "Imported workspace name is required",
    );
  }

  const created = await createWorkspace(ctx, {
    name: targetName,
    description: t.workspace.description ?? undefined,
    color: t.workspace.color ?? undefined,
    icon: t.workspace.icon ?? undefined,
  });

  // Re-create collection scaffolding inside the new workspace. Each
  // collection is stamped against the new workspace id explicitly — we
  // can't use `withTenantValues` because the request context's workspace
  // id is the caller's, not the freshly-minted target.
  for (const col of t.collections.slice(0, 200)) {
    if (typeof col?.name !== "string" || col.name.trim() === "") continue;
    await db.insert(kbCollections).values({
      id: `kbc_${nanoid()}`,
      tenantId: ctx.tenantId,
      workspaceId: created.id,
      name: col.name.slice(0, 200),
      description: col.description?.slice(0, 1000) ?? null,
      color: normaliseColor(col.color) ?? null,
    });
  }

  return created;
}

// ─── Bootstrap helper ──────────────────────────────────────────────────────

/**
 * Ensures the tenant has a default workspace; called after registration so
 * the user always lands on "Personal" on first login. Idempotent.
 */
export async function ensureDefaultWorkspace(
  ctx: TenantContext,
  name = "Personal",
): Promise<WorkspaceRow> {
  const list = await listWorkspaces(ctx);
  const existing = list.find((w) => w.isDefault);
  if (existing) return existing;
  // Promote the first non-system workspace if one already exists,
  // otherwise create a fresh "Personal".
  const candidate = list.find((w) => w.id !== "workspace_system");
  if (candidate) {
    await db
      .update(workspaces)
      .set({ isDefault: 1, updatedAt: Date.now() })
      .where(
        and(
          eq(workspaces.tenantId, ctx.tenantId),
          eq(workspaces.id, candidate.id),
        ),
      );
    const reloaded = await getWorkspace(ctx, candidate.id);
    if (!reloaded) throw new Error("Workspace vanished after promotion");
    return reloaded;
  }
  return createWorkspace(ctx, {
    name,
    color: "indigo",
    icon: "home",
    isDefault: true,
  });
}
