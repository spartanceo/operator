/**
 * Skill-permission service — list and toggle individual permissions for
 * each installed skill without uninstalling the skill.
 */
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  db,
  skillPermissions,
  skills,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { appendAuditEntry } from "./audit.service";
import { logPrivacyEvent } from "./privacy.service";

/**
 * Catalogue of permission keys we expose to the user. Coarse-grained on
 * purpose — the dashboard shows plain English, not OS capability strings.
 */
export const PERMISSION_CATALOGUE = [
  "filesystem.read",
  "filesystem.write",
  "network.outbound",
  "integration.read",
  "integration.write",
  "desktop.control",
  "memory.read",
  "memory.write",
  "shell.exec",
] as const;

export type PermissionKey = (typeof PERMISSION_CATALOGUE)[number];

export interface SkillPermissionRow {
  readonly id: string;
  readonly skillId: string;
  readonly skillSlug: string;
  readonly permission: string;
  readonly granted: boolean;
  readonly grantedAt: string | null;
  readonly revokedAt: string | null;
  readonly updatedAt: string;
}

export interface SkillPermissionsForSkill {
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly permissions: ReadonlyArray<SkillPermissionRow>;
}

function toRow(r: typeof skillPermissions.$inferSelect): SkillPermissionRow {
  return {
    id: r.id,
    skillId: r.skillId,
    skillSlug: r.skillSlug,
    permission: r.permission,
    granted: r.granted === 1,
    grantedAt: r.grantedAt ? new Date(r.grantedAt).toISOString() : null,
    revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listSkillPermissions(
  ctx: TenantContext,
): Promise<ReadonlyArray<SkillPermissionsForSkill>> {
  const installed = await db
    .select({ id: skills.id, slug: skills.slug, name: skills.name })
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.isInstalled, true)))
    .orderBy(desc(skills.updatedAt))
    .limit(500);

  if (installed.length === 0) return [];

  const grants = await db
    .select()
    .from(skillPermissions)
    .where(tenantScope(ctx, skillPermissions));

  const byId = new Map<string, Map<string, SkillPermissionRow>>();
  for (const g of grants) {
    if (!byId.has(g.skillId)) byId.set(g.skillId, new Map());
    byId.get(g.skillId)!.set(g.permission, toRow(g));
  }

  return installed.map((s) => {
    const known = byId.get(s.id) ?? new Map<string, SkillPermissionRow>();
    const permissions = PERMISSION_CATALOGUE.map((p): SkillPermissionRow => {
      const existing = known.get(p);
      if (existing) return existing;
      return {
        id: "",
        skillId: s.id,
        skillSlug: s.slug,
        permission: p,
        granted: false,
        grantedAt: null,
        revokedAt: null,
        updatedAt: new Date(0).toISOString(),
      };
    });
    return {
      skillId: s.id,
      slug: s.slug,
      name: s.name,
      permissions,
    };
  });
}

export async function setSkillPermission(
  ctx: TenantContext,
  skillId: string,
  permission: string,
  granted: boolean,
): Promise<SkillPermissionRow> {
  const skillRows = await db
    .select({ id: skills.id, slug: skills.slug })
    .from(skills)
    .where(and(tenantScope(ctx, skills), eq(skills.id, skillId)))
    .limit(1);
  const skill = skillRows[0];
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }
  if (!(PERMISSION_CATALOGUE as readonly string[]).includes(permission)) {
    throw new Error(`Unknown permission: ${permission}`);
  }

  const existing = await db
    .select()
    .from(skillPermissions)
    .where(
      and(
        tenantScope(ctx, skillPermissions),
        eq(skillPermissions.skillId, skillId),
        eq(skillPermissions.permission, permission),
      ),
    )
    .limit(1);

  const now = Date.now();
  const row = existing[0];
  if (row) {
    await db
      .update(skillPermissions)
      .set({
        granted: granted ? 1 : 0,
        grantedAt: granted ? now : row.grantedAt,
        revokedAt: granted ? row.revokedAt : now,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(
        and(
          tenantScope(ctx, skillPermissions),
          eq(skillPermissions.id, row.id),
        ),
      );
  } else {
    await db.insert(skillPermissions).values(
      withTenantValues(ctx, {
        id: `sp_${nanoid()}`,
        skillId,
        skillSlug: skill.slug,
        permission,
        granted: granted ? 1 : 0,
        grantedAt: granted ? now : null,
        revokedAt: granted ? null : now,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  await appendAuditEntry(ctx, {
    actor: ctx.userId ?? "user",
    action: granted ? "skill.permission.granted" : "skill.permission.revoked",
    resourceType: "skill",
    resourceId: skillId,
    summary: `${skill.slug} ${permission} -> ${granted ? "granted" : "revoked"}`,
  });
  await logPrivacyEvent(ctx, {
    eventType: granted ? "skill.permission.granted" : "skill.permission.revoked",
    actor: ctx.userId ?? "user",
    target: `${skill.slug}:${permission}`,
    severity: granted ? "low" : "info",
  });

  const refreshed = await db
    .select()
    .from(skillPermissions)
    .where(
      and(
        tenantScope(ctx, skillPermissions),
        eq(skillPermissions.skillId, skillId),
        eq(skillPermissions.permission, permission),
      ),
    )
    .limit(1);
  return toRow(refreshed[0]!);
}
