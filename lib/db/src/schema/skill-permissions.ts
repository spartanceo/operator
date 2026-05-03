/**
 * `skill_permissions` — granular permission grants per installed skill.
 *
 * One row per (tenant, skill, permission) tuple. The Privacy Dashboard's
 * per-skill permission review reads this table; revoking a permission flips
 * `granted = 0` instead of deleting the row so the audit trail of "you
 * revoked X on Y" is preserved.
 *
 * Permission keys are coarse-grained categories the user understands:
 *   - "filesystem.read"  / "filesystem.write"
 *   - "network.outbound"
 *   - "integration.read" / "integration.write"
 *   - "desktop.control"
 *   - "memory.read"      / "memory.write"
 *   - "shell.exec"
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skillPermissions = sqliteTable(
  "skill_permissions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    skillId: text("skill_id").notNull(),
    skillSlug: text("skill_slug").notNull(),
    permission: text("permission").notNull(),
    granted: integer("granted").notNull().default(0),
    grantedAt: integer("granted_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skill_permissions_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skill_permissions_workspace").on(t.workspaceId),
    skillIdx: index("idx_skill_permissions_skill").on(t.tenantId, t.skillId),
    uniqGrant: uniqueIndex("idx_skill_permissions_unique").on(
      t.tenantId,
      t.skillId,
      t.permission,
    ),
  }),
);

export type SkillPermission = typeof skillPermissions.$inferSelect;
export type NewSkillPermission = typeof skillPermissions.$inferInsert;
