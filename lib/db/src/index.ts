/**
 * `@workspace/db` — the only place `db` is constructed.
 *
 * Exports:
 *   - `db`              — the Drizzle client.
 *   - `pool`            — the underlying pg Pool (for migrations, shutdown).
 *   - `tenantScope`     — Standard 13 canonical scoping helper.
 *   - `withTenant`      — alias for tenantScope.
 *   - `paginated` /
 *     `buildPage` /
 *     `encodeCursor` /
 *     `decodeCursor` /
 *     `normaliseLimit`  — Standard 13 canonical pagination helpers.
 *   - `LRUCache`        — Standard 13 sanctioned bounded-cache primitive.
 *   - schema tables     — re-exported from ./schema.
 *
 * Service and route files MUST import the helper(s) they need from this
 * package alongside `db` — Check #15 fails if `db` is imported without
 * `tenantScope` or `withTenant`.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./helpers";
