#!/bin/bash
set -e
pnpm install --frozen-lockfile
mkdir -p artifacts/api-server/data
# Use the api-server's own migration runner (drizzle-kit push has a known
# introspection bug against the routed_skill_id column added by migration 17,
# so it cannot be used here). The api-server runs the same migration runner
# at boot; running it explicitly here keeps post-merge idempotent.
SQLITE_PATH="$(pwd)/artifacts/api-server/data/omninity.db" \
  pnpm --filter @workspace/db exec tsx -e "import('@workspace/db').then(async m => { const { runMigrations } = await import('@workspace/db/migrate'); const r = runMigrations(m.getRawSqlite()); console.log('migrations:', JSON.stringify({ applied: r.applied, currentVersion: r.currentVersion })); });"
