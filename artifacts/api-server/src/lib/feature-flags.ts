/**
 * Feature flag registry — env-driven booleans that gate in-flight features.
 *
 * Each flag is read from a single named environment variable so operators
 * can flip behaviour at deploy time without a code change. Defaults are
 * chosen so the production behaviour matches the shipped task spec; tests
 * (or rollback scenarios) can opt out by exporting the env var as `false`.
 *
 * Adding a new flag: add a row to `FLAG_DEFAULTS` and a key to the
 * `FeatureFlagKey` union. Read it via `isFeatureEnabled("...")`.
 */

// tier-review: bounded — fixed-size token whitelist (7 entries), never written to at runtime.
const TRUE_TOKENS = new Set(["1", "true", "TRUE", "on", "ON", "yes", "YES"]);
// tier-review: bounded — fixed-size token whitelist (7 entries), never written to at runtime.
const FALSE_TOKENS = new Set([
  "0",
  "false",
  "FALSE",
  "off",
  "OFF",
  "no",
  "NO",
]);

export type FeatureFlagKey = "feature.hardware_aware_recommendation";

interface FlagSpec {
  /** Environment variable that controls this flag. */
  readonly envVar: string;
  /** Default when the env var is unset or empty. */
  readonly defaultValue: boolean;
}

const FLAG_DEFAULTS: Readonly<Record<FeatureFlagKey, FlagSpec>> = {
  // Task #64 ships hardware-aware recommendation enabled by default. An
  // operator can disable it (e.g. for a forced rollback) by exporting
  // OMNINITY_FEATURE_HARDWARE_AWARE_RECOMMENDATION=false. The new
  // /api/models/{catalogue,recommended,select} routes return 404 with
  // FEATURE_DISABLED when the flag is off; the wizard then falls back to
  // the legacy /api/onboarding/hardware recommendation.
  "feature.hardware_aware_recommendation": {
    envVar: "OMNINITY_FEATURE_HARDWARE_AWARE_RECOMMENDATION",
    defaultValue: true,
  },
};

export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  const spec = FLAG_DEFAULTS[key];
  const raw = process.env[spec.envVar];
  if (raw === undefined || raw === "") return spec.defaultValue;
  if (TRUE_TOKENS.has(raw)) return true;
  if (FALSE_TOKENS.has(raw)) return false;
  // Garbage value — treat as the default rather than silently flipping.
  return spec.defaultValue;
}
