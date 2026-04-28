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

### When checks are skipped

Only two checks ever skip:
- Check 7 skips until the generated client directories exist (required after Task #1)
- Check 8 skips until `artifacts/api-server/src/services/` exists (required after Task #1)

All other checks run unconditionally on every tier. Check 2 runs `pnpm test`
which uses `--if-present` so packages without a test script are silently skipped
by pnpm — but the gate always runs and reports pass/fail.

### Fixture tests for Check 6

```
pnpm run tier-review:test
```

Runs 7 fixture tests against the OpenAPI envelope parser to verify correct
pass/fail behavior for $ref schemas, inline schemas, non-2xx responses, and
responses without a content body.

### Fixing failures

Each check prints the offending file and line number. Fix the issue in the
relevant task, re-run `pnpm run tier-review`, and confirm all checks pass
before starting the next tier.
