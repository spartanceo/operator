/**
 * @workspace/types — Single Source of Truth for shared interfaces (Standard 10).
 *
 * This package is dependency-free and runtime-free; it ships only TypeScript
 * type and interface declarations that every other package can import.
 *
 * Domains kept here (each forward-referenced by tasks that fill in behaviour):
 *  - Tenancy & request context  (Task #17 — this file)
 *  - API envelope shapes        (Task #17 — this file; mirrors openapi.yaml)
 *  - Hardware / runtime modes   (Task #17 — this file; cross-cuts Tasks #30/#36)
 *  - Agent loop primitives      (Task #4  — declared as TODOs to be filled in)
 *  - Skill runtime contracts    (Task #6  — declared as TODOs to be filled in)
 *
 * Anything that gains a runtime implementation (helpers, validators,
 * fetchers) belongs in a different package — never here.
 */

export * from "./tenant-context";
export * from "./api-envelope";
export * from "./runtime-modes";
export * from "./agent-loop";
// `./skill-runtime` was the original Task #6 placeholder. Task #39 replaces
// it with the formal execution contract in `./skill-execution`; the
// placeholder is no longer exported to avoid name collisions on
// SkillPermission / SkillContext / SkillResult / SkillManifest.
export * from "./skill-execution";
export * from "./model-catalogue";
