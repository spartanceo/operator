# scripts

Utility scripts for the Omninity Operator workspace.

## Tier Review (`pnpm run tier-review`)

Run after every tier of tasks merges and before activating the next tier.
Exits 0 on full pass, 1 on any failure.

```
pnpm run tier-review
```

### What it checks

| # | Check | Catches |
|---|-------|---------|
| 1 | **TypeScript typecheck** | Type errors, bad imports, `any` usage |
| 2 | **All tests passing** | Logic bugs, broken queries, missing tenant isolation |
| 3 | **No `console.log` in source** | Missing Pino logger usage |
| 4 | **No hardcoded hex colours** | Colour values that bypass the design token system (all `.tsx` under `artifacts/` in scope; only `artifacts/frontend/src/design-tokens.ts` is exempt) |
| 5 | **Drizzle tables have required columns** | Missing `id`, `tenantId`, `createdAt`, `updatedAt`, `version` |
| 6 | **API envelope on OpenAPI responses** | Routes missing the `{ success, data, error }` envelope |
| 7 | **OpenAPI codegen in sync** | Spec changes not reflected in generated client code |
| 8 | **No raw `fetch()` without privacy log** | Outbound network calls missing a privacy audit event |
| 9 | **Performance budget compliance** | Latency regressions caught at the task that introduced them, not at Tier 8 |
| 10 | **Frontend bundle size budget** | JS chunk bloat that destroys cold-start performance |
| 11 | **No dangerous code execution primitives** | `eval`, `new Function`, and `vm.runInNewContext` outside the canonical skill sandbox |
| 12 | **No unsanitised `dangerouslySetInnerHTML`** | XSS via React HTML injection without `DOMPurify.sanitize` |
| 13 | **Dependency audit clean of high/critical** | Supply-chain advisories (`pnpm audit --json`) at high or critical severity |
| 14 | **No raw SQL string interpolation** | SQL injection via template literals or `+` concatenation in `db.exec/run/all/get/prepare` |
| 15 | **Tenant scoping helper required** | Service/route files that import `db` from `@workspace/db` without the canonical `tenantScope`/`withTenant` helper |
| 16 | **Pagination on list endpoints** | GET routes whose 2xx response is a bare `type: array` instead of the `{ items, nextCursor }` envelope |
| 17 | **Required indexes on tenant + FK columns** | Drizzle tables with `tenant_id`/`workspace_id` or `.references(...)` columns and no covering `index(...)` entry |
| 18 | **No unbounded module-level caches** | Module-level `new Map()`/`new Set()` not wrapped in `LRUCache` and not annotated with `// tier-review: bounded — <reason>` |

### When checks are skipped

Several checks skip when their prerequisites are not yet present:
- Check 7 skips until the generated client directories exist (required after Task #1)
- Check 8 skips until `artifacts/api-server/src/services/` exists (required after Task #1)
- Check 9 skips until at least one `*.bench.ts` file exists (becomes active when the first task ships a benchmark)
- Check 10 skips until at least one `artifacts/<name>/bundle-budget.json` exists (added by Task #2)
- Check 11 skips when neither `artifacts/` nor `lib/` exists yet
- Check 12 skips when no `.tsx` files exist under `artifacts/`
- Check 13 skips when `pnpm audit` cannot reach the registry (offline development is not blocked) and tolerates pnpm progress / WARN lines emitted before the JSON envelope
- Check 14 skips when neither `artifacts/api-server/` nor `lib/db/` exists yet
- Check 15 skips until `artifacts/api-server/src/services/` or `.../routes/` exists (active from Task #1/#17)
- Check 16 skips when `lib/api-spec/openapi.yaml` does not exist (active from Task #1)
- Check 17 skips when no schema files (`*schema*.ts`) are found under `lib/db/` or `artifacts/api-server/` (active from Task #37 onwards)
- Check 18 skips when neither `artifacts/` nor `lib/` exists yet

All other checks run unconditionally on every tier. Check 2 runs `pnpm test`
which uses `--if-present` so packages without a test script are silently skipped
by pnpm — but the gate always runs and reports pass/fail.

### Check 9 — Performance Budget Compliance

Enforces Standard 11. Discovers every `*.bench.ts` file under `artifacts/` and
`lib/`, parses the `@budget` annotation directly above each `bench()` call,
runs `pnpm run bench` (which delegates to each package's local `bench` script),
parses the JSON output of `vitest bench --reporter=json`, and fails the gate
for any benchmark whose measured time exceeds its declared budget.

**Adding a benchmark to a new task:**
1. Create `artifacts/<artifact>/src/<domain>/<name>.bench.ts` (or `lib/<lib>/src/<name>.bench.ts`)
2. Add a `bench` script to that package's `package.json` — note the `--outputFile` argument is **required** so Check #9 can read clean per-package JSON instead of pnpm's interleaved stdout:
   ```json
   "bench": "vitest bench --run --reporter=json --outputFile=./.bench-results.json"
   ```
   Add `.bench-results.json` to that package's `.gitignore`.
3. Write the benchmark with the required annotation:
   ```typescript
   import { bench, describe } from "vitest";
   import { searchKnowledgeBase } from "./knowledge.service";

   describe("knowledge base search", () => {
     /** @budget 300ms p95 */
     bench("top-10 against 10k-doc corpus", async () => {
       await searchKnowledgeBase({ query: "q", limit: 10 });
     });
   });
   ```

**Annotation format (the contract):**
- `/** @budget <number>[ms] [p95|mean] */` directly above the `bench()` call
- `ms` suffix is optional (`@budget 50ms` and `@budget 50` are equivalent)
- Metric defaults to `mean` when unspecified; `p95` is the only alternative
- Blank lines and additional comments between the JSDoc and the `bench()` call
  are tolerated; the parser walks forward to the first code line

### Check 10 — Frontend Bundle Size

Enforces the bundle-size portion of Standard 11. For every artifact under
`artifacts/` that ships a `bundle-budget.json` at its root, the check builds
the artifact in production mode and verifies the gzipped size of the largest
JS chunk under `dist/assets/` (or `dist/`) is at or below `main_js_gzip_kb`.

**`bundle-budget.json` schema:**
```json
{
  "main_js_gzip_kb": 500,        // required — the enforced limit
  "total_js_gzip_kb": 1500,      // optional — informational only for now
  "css_gzip_kb": 100,            // optional — informational only for now
  "build_command": "pnpm build", // optional override (default: pnpm build)
  "dist_dir": "dist"             // optional override (default: dist)
}
```

The gzipped size is measured with the system `gzip` binary so no extra
JavaScript dependency is needed.

### Checks 11–14 — Standard 12 (Security Patterns)

The four security checks enforce Standard 12 of `OMNINITY_BUG_PREVENTION_STANDARDS.md`. Each is intentionally a syntactic check that runs in milliseconds — semantic security review is the architect subagent's job.

- **Check 11** scans `.ts`/`.tsx` files under `artifacts/` and `lib/` for `eval(`, `new Function(`, and `vm.runInNewContext(`. Only the canonical skill sandbox file (`artifacts/api-server/src/skill-runtime/sandbox.ts`) is allowlisted, and only for `vm.runInNewContext`. Test/spec files and the tier-review script itself are excluded so the checker's own pattern strings don't trigger. Comment-only lines are skipped so example/forbidden-pattern docs don't false-positive.
- **Check 12** scans `.tsx` files under `artifacts/` for `dangerouslySetInnerHTML`. The parser uses bracket matching to extract the full JSX prop expression (across multiple lines if needed) and passes only when `DOMPurify.sanitize` appears **inside** that prop expression. The single allowed escape hatch is binding the `__html` value to a local variable that was assigned from `DOMPurify.sanitize(...)` no more than 3 lines above — any other "nearby" sanitize call on an unrelated variable is correctly flagged.
- **Check 13** runs `pnpm audit --json --prod` at the workspace root, parses the result, and fails on any `high`/`critical` advisory. Moderate counts surface as a non-blocking note. The parser is resilient to several pnpm/npm envelope variants — the legacy `{ advisories, metadata.vulnerabilities }` shape, the newer pnpm `{ vulnerabilities: [...] }` array shape, the npm v7+ `{ vulnerabilities: { "<pkg>": {...} } }` map shape, and a bare `[...]` array — and it scans for the first balanced JSON document inside the output so progress lines / WARN notices emitted before the envelope (or "Done in 2.4s" trailers after it) don't break parsing. When no JSON document can be found anywhere, the check distinguishes "audit could not run — network unreachable (offline, skipped)" from "audit ran but produced no parseable JSON envelope" (failure) so the tier-review banner stays explicit.
- **Check 14** scans `.ts` files under `artifacts/api-server/` and `lib/db/` for `db.exec`, `db.run`, `db.all`, `db.get`, and `db.prepare` calls. The parser captures the full argument list using bracket matching across up to 8 lines, strips any safe `sql\`...\`` tagged-template chunks, and fails if the remaining text contains a backtick template literal with `${...}` or a quoted string immediately followed by `+`. Drizzle's `sql\`...\`` tagged template and the typed query builder (`db.select().from(t).all()`) are the only allowed forms.

### Checks 15–18 — Standard 13 (Scalability & Multi-Tenant Isolation)

The four scalability checks enforce Standard 13 of `OMNINITY_BUG_PREVENTION_STANDARDS.md`. Like the security checks, each is a fast syntactic check — semantic review (e.g. "is this query plan actually fast?") is the architect subagent's job.

- **Check 15** scans `.ts` files under `artifacts/api-server/src/services/` and `.../routes/` and parses every `import` statement from `@workspace/db` (multi-line tolerant). If a file imports the runtime `db` value but does not also import `tenantScope` (or the sanctioned alias `withTenant`), it fails. Type-only imports (`import type { db } from "@workspace/db"`) and aliased imports of unrelated names are correctly ignored. Documented heuristic limit: indirect access via `import * as dbMod` is not detected and is caught by code review.
- **Check 16** parses `lib/api-spec/openapi.yaml` with the same indentation-aware walker used by Check #6. For every `GET` route's 2xx response, the schema (or any `$ref` it points to, up to 3 levels) must mention `nextCursor:` — the canonical envelope marker. A bare `type: array` schema (or a `$ref` to one) fails the check. `oneOf` / `anyOf` schemas are walked branch-by-branch: every branch is classified independently and any bare-array branch fails the route, even if a sibling branch is a valid envelope. Singleton GETs (one object) are not flagged.
- **Check 17** scans schema files (any `*schema*.ts` under `lib/db/` or `artifacts/api-server/`) and parses each `pgTable`/`sqliteTable` declaration. For every column whose JS or SQL name is `tenant_id`/`tenantId`/`workspace_id`/`workspaceId`, OR whose declaration includes `.references(...)`, the table's index callback (`(t) => ({...})` or `(table) => [...]`) must include an `index(...).on(t.<col>, ...)` covering that column. Composite indexes that mention the column count as covered. Block- and line-comments are stripped first so commented-out examples don't trigger.
- **Check 18** scans `.ts`/`.tsx` files under `artifacts/` and `lib/` for module-level (column-0) `const`/`let`/`var` declarations whose RHS is `new Map<...>(...)` or `new Set<...>(...)`. Function-local constructors are ignored. The check passes when the line wraps the structure in `LRUCache(...)` OR when the previous non-blank line carries the explicit annotation `// tier-review: bounded — <reason>`. Test/spec files and the tier-review script itself are excluded.

### Fixture tests

```
pnpm run tier-review:test                # Check 6 (OpenAPI envelope) — 7 tests
pnpm run tier-review:check9-test         # Check 9 (budget annotation parser)
pnpm run tier-review:check11-14-test     # Checks 11–14 (security pattern parsers)
pnpm run tier-review:check15-18-test     # Checks 15–18 (scalability pattern parsers) — 31 tests
```

All test suites exit non-zero on failure so they can be wired into CI.

### Fixing failures

Each check prints the offending file and line number. Fix the issue in the
relevant task, re-run `pnpm run tier-review`, and confirm all checks pass
before starting the next tier.
