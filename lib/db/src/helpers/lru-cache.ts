/**
 * Standard 13 — sanctioned bounded-cache primitive.
 *
 * Module-level `new Map(...)` / `new Set(...)` are forbidden (Check #18)
 * because they grow without bound in a long-running service. Tasks that
 * need a process-local cache use `LRUCache` from this re-export so every
 * cache has an explicit `max` (or `maxSize`) and `ttl` declared at the
 * construction site.
 *
 * Re-exporting from `@workspace/db` rather than from individual services
 * means every cache in the codebase imports from the same module — easy
 * to audit, easy to swap to a different implementation later.
 */
export { LRUCache } from "lru-cache";
