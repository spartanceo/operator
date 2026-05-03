#!/usr/bin/env tsx
/**
 * Fixture tests for Checks 15–18 (Standard 13 — Scalability & Multi-Tenant
 * Isolation) in tier-review.ts.
 *
 * Exercises the four exported parser functions with synthetic source/YAML to
 * prove the rules described in Standard 13 of the bug-prevention standards
 * are enforced exactly:
 *  - findUnscopedDbAccess     (Check 15)
 *  - findUnpaginatedListRoutes (Check 16)
 *  - findMissingIndexes       (Check 17)
 *  - findUnboundedCaches      (Check 18)
 *
 * Usage: pnpm run tier-review:check15-18-test
 */

import assert from "assert";
import {
  findMissingIndexes,
  findUnboundedCaches,
  findUnpaginatedListRoutes,
  findUnscopedDbAccess,
} from "./tier-review.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    const err = e instanceof assert.AssertionError ? e.message : String(e);
    console.log(`  ✗  ${name}\n     ${err}`);
    failed++;
  }
}

// ─── Check 15: findUnscopedDbAccess ───────────────────────────────────────────

test("flags a service file that imports db without tenantScope", () => {
  const src = [
    `import { db } from "@workspace/db";`,
    `import { eq } from "drizzle-orm";`,
    `export async function listSkills() {`,
    `  return db.select().from(skills).all();`,
    `}`,
  ].join("\n");
  const out = findUnscopedDbAccess(src, "skills.service.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].line, 1);
});

test("does NOT flag when tenantScope is also imported", () => {
  const src = [
    `import { db, tenantScope } from "@workspace/db";`,
    `export async function listSkills(ctx) {`,
    `  return db.select().from(skills).where(tenantScope(ctx, skills)).all();`,
    `}`,
  ].join("\n");
  const out = findUnscopedDbAccess(src, "skills.service.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("accepts withTenant as the sanctioned alias", () => {
  const src = `import { db, withTenant } from "@workspace/db";`;
  const out = findUnscopedDbAccess(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("handles multi-line imports", () => {
  const src = [
    `import {`,
    `  db,`,
    `  tenantScope,`,
    `  type DbClient,`,
    `} from "@workspace/db";`,
  ].join("\n");
  const out = findUnscopedDbAccess(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("flags multi-line import that has db but no helper", () => {
  const src = [
    `import {`,
    `  db,`,
    `  type DbClient,`,
    `} from "@workspace/db";`,
  ].join("\n");
  const out = findUnscopedDbAccess(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

test("does NOT flag a type-only import of db", () => {
  const src = `import type { db } from "@workspace/db";`;
  const out = findUnscopedDbAccess(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("flags runtime db + type-only tenantScope (helper must be runtime)", () => {
  const src = [
    `import { db } from "@workspace/db";`,
    `import type { tenantScope } from "@workspace/db";`,
    `export async function listSkills() {`,
    `  return db.select().from(skills).all();`,
    `}`,
  ].join("\n");
  const out = findUnscopedDbAccess(src, "skills.service.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

test("does NOT flag a file that imports neither db nor the helper", () => {
  const src = `import { sql } from "drizzle-orm";`;
  const out = findUnscopedDbAccess(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("handles aliased named imports (db as database)", () => {
  // The detector matches the original name, not the alias — `db` not present
  // in import → no flag.
  const src = `import { database as db } from "@workspace/db";`;
  const out = findUnscopedDbAccess(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// Architect-style edge: a service file that gets db via the canonical name and
// uses Drizzle's sql tagged template — still must import tenantScope.
test("flags service file using db.execute(sql`...`) without tenantScope", () => {
  const src = [
    `import { db } from "@workspace/db";`,
    `import { sql } from "drizzle-orm";`,
    `export async function rawCount() {`,
    "  return db.execute(sql`SELECT COUNT(*) FROM skills`);",
    `}`,
  ].join("\n");
  const out = findUnscopedDbAccess(src, "skills.service.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

// ─── Check 16: findUnpaginatedListRoutes ──────────────────────────────────────

test("flags a GET endpoint returning a bare type:array", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          description: List`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                type: array`,
    `                items:`,
    `                  $ref: "#/components/schemas/Skill"`,
    `components:`,
    `  schemas:`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].path, "/skills");
  assert.strictEqual(out[0].method, "GET");
});

test("passes a GET endpoint with the canonical {items, nextCursor} envelope", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          description: List`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                type: object`,
    `                properties:`,
    `                  success: { type: boolean }`,
    `                  data:`,
    `                    type: object`,
    `                    properties:`,
    `                      items:`,
    `                        type: array`,
    `                        items: { $ref: "#/components/schemas/Skill" }`,
    `                      nextCursor:`,
    `                        type: string`,
    `components:`,
    `  schemas:`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("does NOT flag a singleton GET (200 returns one object)", () => {
  const yaml = [
    `paths:`,
    `  /skills/{id}:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                $ref: "#/components/schemas/Skill"`,
    `components:`,
    `  schemas:`,
    `    Skill:`,
    `      type: object`,
    `      properties:`,
    `        id: { type: string }`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// Architect-style edge: a singleton response that legitimately contains a
// nested array property must NOT be flagged. The previous global-text
// classifier failed this test (false positive).
test("does NOT flag a singleton GET that has a nested array property", () => {
  const yaml = [
    `paths:`,
    `  /users/{id}:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                type: object`,
    `                properties:`,
    `                  id: { type: string }`,
    `                  friends:`,
    `                    type: array`,
    `                    items:`,
    `                      $ref: "#/components/schemas/User"`,
    `components:`,
    `  schemas:`,
    `    User:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("does NOT flag non-GET methods even when bare array", () => {
  const yaml = [
    `paths:`,
    `  /bulk:`,
    `    post:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                type: array`,
    `                items: { type: string }`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("follows $ref to detect envelope wrapper", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                $ref: "#/components/schemas/SkillListResponse"`,
    `components:`,
    `  schemas:`,
    `    SkillListResponse:`,
    `      type: object`,
    `      properties:`,
    `        success: { type: boolean }`,
    `        data:`,
    `          type: object`,
    `          properties:`,
    `            items:`,
    `              type: array`,
    `              items: { $ref: "#/components/schemas/Skill" }`,
    `            nextCursor: { type: string }`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// Architect-flagged fragility: a oneOf/anyOf response that mixes one
// envelope branch with one bare-array branch used to slip past the gate
// because only one branch won classification. The branch walker now
// validates every branch independently; ANY bare-array branch fails the route.
test("flags a GET endpoint whose oneOf has one envelope and one bare-array branch", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                oneOf:`,
    `                  - type: object`,
    `                    properties:`,
    `                      items:`,
    `                        type: array`,
    `                        items: { $ref: "#/components/schemas/Skill" }`,
    `                      nextCursor: { type: string }`,
    `                  - type: array`,
    `                    items: { $ref: "#/components/schemas/Skill" }`,
    `components:`,
    `  schemas:`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].path, "/skills");
});

test("flags a GET endpoint whose anyOf branches include a bare-array $ref", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                anyOf:`,
    `                  - $ref: "#/components/schemas/SkillEnvelope"`,
    `                  - $ref: "#/components/schemas/SkillBareArray"`,
    `components:`,
    `  schemas:`,
    `    SkillEnvelope:`,
    `      type: object`,
    `      properties:`,
    `        items:`,
    `          type: array`,
    `          items: { $ref: "#/components/schemas/Skill" }`,
    `        nextCursor: { type: string }`,
    `    SkillBareArray:`,
    `      type: array`,
    `      items: { $ref: "#/components/schemas/Skill" }`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

// Coexisting oneOf + anyOf at the same level: the walker must aggregate
// branches from BOTH combinators. A bare-array branch hidden inside a
// sibling anyOf must still fail the route.
test("flags a GET endpoint with coexisting oneOf and anyOf when one anyOf branch is bare-array", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                oneOf:`,
    `                  - type: object`,
    `                    properties:`,
    `                      items:`,
    `                        type: array`,
    `                        items: { $ref: "#/components/schemas/Skill" }`,
    `                      nextCursor: { type: string }`,
    `                anyOf:`,
    `                  - $ref: "#/components/schemas/SkillBareArray"`,
    `components:`,
    `  schemas:`,
    `    SkillBareArray:`,
    `      type: array`,
    `      items: { $ref: "#/components/schemas/Skill" }`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].path, "/skills");
});

test("does NOT flag a oneOf where every branch is the envelope shape", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                oneOf:`,
    `                  - type: object`,
    `                    properties:`,
    `                      items:`,
    `                        type: array`,
    `                        items: { $ref: "#/components/schemas/Skill" }`,
    `                      nextCursor: { type: string }`,
    `                  - $ref: "#/components/schemas/SkillEnvelope"`,
    `components:`,
    `  schemas:`,
    `    SkillEnvelope:`,
    `      type: object`,
    `      properties:`,
    `        items:`,
    `          type: array`,
    `          items: { $ref: "#/components/schemas/Skill" }`,
    `        nextCursor: { type: string }`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("flags $ref pointing at a bare-array schema", () => {
  const yaml = [
    `paths:`,
    `  /skills:`,
    `    get:`,
    `      responses:`,
    `        "200":`,
    `          content:`,
    `            application/json:`,
    `              schema:`,
    `                $ref: "#/components/schemas/SkillList"`,
    `components:`,
    `  schemas:`,
    `    SkillList:`,
    `      type: array`,
    `      items: { $ref: "#/components/schemas/Skill" }`,
    `    Skill:`,
    `      type: object`,
  ].join("\n");
  const out = findUnpaginatedListRoutes(yaml);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

// ─── Check 17: findMissingIndexes ─────────────────────────────────────────────

test("flags a table with tenant_id but no index", () => {
  const src = [
    `export const skills = sqliteTable("skills", {`,
    `  id: text("id").primaryKey(),`,
    `  tenantId: text("tenant_id").notNull(),`,
    `  name: text("name").notNull(),`,
    `});`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].column, "tenantId");
});

test("passes a table that indexes its tenant_id column", () => {
  const src = [
    `export const skills = sqliteTable("skills", {`,
    `  id: text("id").primaryKey(),`,
    `  tenantId: text("tenant_id").notNull(),`,
    `  name: text("name").notNull(),`,
    `}, (t) => ({`,
    `  tenantIdx: index("skills_tenant_idx").on(t.tenantId),`,
    `}));`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("flags a foreign-key column with no index", () => {
  const src = [
    `export const skillVersions = sqliteTable("skill_versions", {`,
    `  id: text("id").primaryKey(),`,
    `  skillId: text("skill_id").notNull().references(() => skills.id),`,
    `});`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].column, "skillId");
});

test("passes a foreign-key column when the index callback covers it", () => {
  const src = [
    `export const skillVersions = sqliteTable("skill_versions", {`,
    `  id: text("id").primaryKey(),`,
    `  skillId: text("skill_id").notNull().references(() => skills.id),`,
    `}, (t) => ({`,
    `  skillIdx: index("sv_skill_idx").on(t.skillId),`,
    `}));`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// Architect-style edge: composite index covering tenant + workspace counts
test("composite index covers both tenant_id and workspace_id", () => {
  const src = [
    `export const conversations = sqliteTable("conversations", {`,
    `  id: text("id").primaryKey(),`,
    `  tenantId: text("tenant_id").notNull(),`,
    `  workspaceId: text("workspace_id").notNull(),`,
    `}, (t) => ({`,
    `  tenantWorkspaceIdx: index("conv_tw_idx").on(t.tenantId, t.workspaceId),`,
    `}));`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("missing workspace_id index is flagged even when tenant_id is indexed", () => {
  const src = [
    `export const conversations = sqliteTable("conversations", {`,
    `  id: text("id").primaryKey(),`,
    `  tenantId: text("tenant_id").notNull(),`,
    `  workspaceId: text("workspace_id").notNull(),`,
    `}, (t) => ({`,
    `  tenantIdx: index("conv_t_idx").on(t.tenantId),`,
    `}));`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].column, "workspaceId");
});

test("ignores commented-out tenant_id columns", () => {
  const src = [
    `// Example: tenantId: text("tenant_id"),`,
    `export const seedRunner = sqliteTable("seed_runner", {`,
    `  id: text("id").primaryKey(),`,
    `});`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("supports the array-shape index callback (table) => [...]", () => {
  const src = [
    `export const skills = sqliteTable("skills", {`,
    `  id: text("id").primaryKey(),`,
    `  tenantId: text("tenant_id").notNull(),`,
    `}, (t) => [`,
    `  index("skills_tenant_idx").on(t.tenantId),`,
    `]);`,
  ].join("\n");
  const out = findMissingIndexes(src, "schema.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// ─── Check 18: findUnboundedCaches ────────────────────────────────────────────

test("flags a module-level new Map() with no LRU and no annotation", () => {
  const src = [
    `import { something } from "./x";`,
    `const cache = new Map<string, number>();`,
    `export function get(k: string) { return cache.get(k); }`,
  ].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].line, 2);
});

test("flags a module-level new Set() too", () => {
  const src = [`export const seen = new Set<string>();`].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

test("does NOT flag function-local new Map()", () => {
  const src = [
    `export function build() {`,
    `  const local = new Map<string, number>();`,
    `  return local;`,
    `}`,
  ].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("does NOT flag a module-level LRUCache wrapper", () => {
  const src = [
    `import { LRUCache } from "lru-cache";`,
    `const cache = new LRUCache<string, number>({ max: 1000 });`,
  ].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("does NOT flag when the previous line carries the bounded annotation", () => {
  const src = [
    `// tier-review: bounded — fixed enum keys, never grows`,
    `const STATUS_LABELS = new Map([["a", 1], ["b", 2]]);`,
  ].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// Architect-style edge: LRUCache aliased through a barrel re-export
test("does NOT flag LRUCache imported from a barrel re-export", () => {
  const src = [
    `import { LRUCache } from "@workspace/db";`,
    `const c = new LRUCache({ max: 100 });`,
  ].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test("flags export const new Map() with no LRU/annotation", () => {
  const src = [`export const cache = new Map<string, number>();`].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 1, JSON.stringify(out));
});

test("does NOT flag indented (function-body) export-style construction", () => {
  // A constructor inside a function body — first char is whitespace.
  const src = [
    `function make() {`,
    `  const local = new Map();`,
    `  return local;`,
    `}`,
  ].join("\n");
  const out = findUnboundedCaches(src, "f.ts");
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log();
console.log(`Checks 15–18 fixture tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
