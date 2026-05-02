# `@workspace/db`

The single place `db` is constructed. Every service and route file imports
from here.

## Standard 13 contract — three rules to remember

1. **Always import `tenantScope` (or `withTenant`) alongside `db`.** The
   tier-review gate (Check #15) fails any service or route file that imports
   `db` from `@workspace/db` without one of the helpers.

   ```ts
   import { db, tenantScope } from "@workspace/db";
   import { skills } from "@workspace/db";

   export async function listSkills(ctx: TenantContext) {
     return db.select().from(skills).where(tenantScope(ctx, skills));
   }
   ```

2. **Every list endpoint returns `{ items, nextCursor }`.** Use the
   `paginated()` and `buildPage()` helpers; never hand-roll the envelope.

   ```ts
   import { db, tenantScope, buildPage, decodeCursor, normaliseLimit } from "@workspace/db";
   import { and, gt } from "drizzle-orm";

   export async function listWorkspaces(ctx, q) {
     const limit = normaliseLimit(q.limit);
     const seek = q.cursor ? decodeCursor(q.cursor) : null;
     const rows = await db
       .select()
       .from(workspaces)
       .where(
         and(
           tenantScope(ctx, workspaces),
           seek ? gt(workspaces.id, seek) : undefined,
         ),
       )
       .orderBy(workspaces.id)
       .limit(limit + 1);
     return buildPage(rows, limit, (r) => r.id);
   }
   ```

3. **Module-level caches use `LRUCache`.** A bare `new Map()` / `new Set()`
   at file scope is rejected by Check #18 unless wrapped in `LRUCache` (or
   carrying the explicit `// tier-review: bounded — <reason>` comment).

   ```ts
   import { LRUCache } from "@workspace/db";

   export const fetchCache = new LRUCache<string, Response>({
     max: 1000,
     ttl: 60_000,
   });
   ```

## Canonical schema pattern

Every table you add to `src/schema/` MUST follow this shape. Check #5 enforces
the column set; Check #17 enforces the indexes.

```ts
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";
import { workspaces } from "./workspaces";

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    tenantIdx: index("idx_skills_tenant").on(t.tenantId),
    workspaceIdx: index("idx_skills_workspace").on(t.workspaceId),
    tenantWorkspaceIdx: index("idx_skills_tenant_workspace").on(
      t.tenantId,
      t.workspaceId,
    ),
  }),
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
```

### Why the `tenants` table has its own `tenant_id`

The `tenants` table carries a self-referencing `tenant_id` column equal to
its own `id`. This keeps the `tenantScope` helper uniform across every table
in the schema — no special case for the root table. The insert path enforces
the equality.

## Testing

The pure helpers are covered by `src/helpers.test.ts` — run with
`pnpm --filter @workspace/db run test`. Real DB integration tests land with
Task #37 (Database Schema Migration System), which sets up the migration
runner and the per-test transactional isolation pattern.
