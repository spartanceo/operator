/**
 * scripts/i18n-check.ts — Translation key parity gate.
 *
 * Loads every locale bundle declared by the omninity-website artifact and
 * fails (exit 1) if any key present in the English source-of-truth bundle
 * is missing from another locale, OR if a non-English locale carries an
 * unknown key. This is the CI half of Task #28's "missing translation key
 * detection" requirement — the runtime half (i18next fallback) ships in
 * `artifacts/omninity-website/src/i18n/index.ts`.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run i18n-check
 *
 * Exit codes:
 *   0  every locale has the same key set as English.
 *   1  one or more locales are missing keys, or have stray keys.
 *   2  a locale bundle failed to load (import error / file missing).
 *
 * Implementation notes:
 *   - We import the TypeScript source directly via `tsx`. No JSON files,
 *     no build step. The English bundle drives the schema.
 *   - Keys are flattened to dot-paths (`footer.columns.product`).
 *   - A bounded recursion guard caps depth at 8 to prevent runaway crashes
 *     if a locale ships a self-referential structure.
 */

import { loadAllForCI } from "../artifacts/omninity-website/src/i18n/translations/index";

const MAX_DEPTH = 8;

function flattenKeys(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  if (value === null || typeof value !== "object") {
    return prefix ? [prefix] : [];
  }
  const keys: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      keys.push(...flattenKeys(v, next, depth + 1));
    } else {
      keys.push(next);
    }
  }
  return keys;
}

function diff(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((k) => !set.has(k));
}

async function main(): Promise<void> {
  const resources = await loadAllForCI();
  const englishKeys = flattenKeys(resources.en.translation).sort();
  const englishSet = new Set(englishKeys);

  let failed = false;

  for (const [code, bundle] of Object.entries(resources)) {
    if (code === "en") continue;
    const localeKeys = flattenKeys(bundle.translation).sort();
    const missing = diff(englishKeys, localeKeys);
    const stray = localeKeys.filter((k) => !englishSet.has(k));

    if (missing.length === 0 && stray.length === 0) {
      console.log(`✓ ${code}: ${localeKeys.length} keys, parity with en`);
      continue;
    }

    failed = true;
    console.error(`✗ ${code}: parity mismatch with en`);
    if (missing.length > 0) {
      console.error(`  missing keys (${missing.length}):`);
      for (const k of missing) console.error(`    - ${k}`);
    }
    if (stray.length > 0) {
      console.error(`  stray keys (${stray.length}, not in en):`);
      for (const k of stray) console.error(`    - ${k}`);
    }
  }

  if (failed) {
    console.error(
      "\ni18n-check failed — every locale must mirror the English key set exactly.",
    );
    process.exit(1);
  }

  console.log(
    `\ni18n-check passed — ${englishKeys.length} keys × ${Object.keys(resources).length} locales.`,
  );
}

main().catch((err: unknown) => {
  console.error("i18n-check crashed:", err);
  process.exit(2);
});

