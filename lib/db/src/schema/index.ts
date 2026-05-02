/**
 * Schema barrel — every table the database knows about is exported from here.
 *
 * Conventions enforced by the tier-review gate (Standard 6 / Check #5):
 *  - Every table has columns: `id`, `tenantId`, `createdAt`, `updatedAt`.
 *  - Mutable records also have a `version` column for optimistic concurrency.
 *  - Every `tenant_id` / `workspace_id` / `.references(...)` column has a
 *    matching `index(...)` entry inside the table's index callback
 *    (Standard 13 / Check #17).
 *
 * See `../README.md` for the canonical pattern to copy when adding a table.
 */
export * from "./tenants";
export * from "./workspaces";
