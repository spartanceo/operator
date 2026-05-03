/**
 * Migration 0025 — Skill Execution Manifest (Task #39).
 *
 * Adds a JSON-encoded `execution_manifest` column to `skills` and
 * `skill_versions` so every published skill ships with the formal
 * input/output contract defined in `lib/types/src/skill-execution.ts`.
 *
 * The column is nullable to remain backwards-compatible with skills
 * created before the contract existed; the runtime treats `NULL` as
 * "legacy text-prompt skill" and runs them through the deterministic
 * agent loop instead of the sandboxed executor.
 */
import type { SchemaMigration } from "./types";

const up = `
  ALTER TABLE skills ADD COLUMN execution_manifest TEXT;
  ALTER TABLE skill_versions ADD COLUMN execution_manifest TEXT;
`;

const down = `
  ALTER TABLE skills DROP COLUMN execution_manifest;
  ALTER TABLE skill_versions DROP COLUMN execution_manifest;
`;

export const migration: SchemaMigration = {
  id: 34,
  name: "skill_execution_manifest",
  up,
  down,
};
