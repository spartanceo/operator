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
| 4 | **No hardcoded hex colours** | Colour values that bypass the design token system |
| 5 | **Drizzle tables have required columns** | Missing `id`, `tenantId`, `createdAt`, `updatedAt`, `version` |
| 6 | **API envelope on OpenAPI responses** | Routes missing the `{ success, data, error }` envelope |
| 7 | **OpenAPI codegen in sync** | Spec changes not reflected in generated client code |
| 8 | **No raw `fetch()` without privacy log** | Outbound network calls missing a privacy audit event |

### When checks are skipped

Some checks are skipped (shown with `~`) when the relevant code does not exist
yet. For example, Check 2 is skipped if no test files exist (Tier 0), and
Check 7 is skipped if the generated client directory does not exist yet.
Skipped checks become active automatically once the relevant files are created
by downstream tasks.

### Fixing failures

Each check prints the offending file and line number. Fix the issue in the
relevant task, re-run `pnpm run tier-review`, and confirm all checks pass
before starting the next tier.
