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

### When checks are skipped

Four checks skip when their prerequisites are not yet present:
- Check 7 skips until the generated client directories exist (required after Task #1)
- Check 8 skips until `artifacts/api-server/src/services/` exists (required after Task #1)
- Check 9 skips until at least one `*.bench.ts` file exists (becomes active when the first task ships a benchmark)
- Check 10 skips until at least one `artifacts/<name>/bundle-budget.json` exists (added by Task #2)

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

### Fixture tests

```
pnpm run tier-review:test           # Check 6 (OpenAPI envelope) — 7 tests
pnpm run tier-review:check9-test    # Check 9 (budget annotation parser) — tests
```

Both test suites exit non-zero on failure so they can be wired into CI.

### Fixing failures

Each check prints the offending file and line number. Fix the issue in the
relevant task, re-run `pnpm run tier-review`, and confirm all checks pass
before starting the next tier.
