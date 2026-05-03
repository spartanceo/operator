/**
 * Sanctions-list screening (Task #26).
 *
 * In production we call OFAC's Specially Designated Nationals (SDN)
 * search API + the EU consolidated list + UK HMT financial sanctions
 * + Australia DFAT. For the local-first MVP we ship a small
 * deterministic catalogue: comprehensive U.N. sanctioned countries +
 * a tiny synthetic name-match list so the integration boundary and
 * the manual-review flow can be exercised end-to-end on a developer's
 * laptop.
 *
 * Calling code MUST treat this as a pre-screen — a real payout would
 * additionally call the live OFAC API and block disbursement until
 * either confirmed clear or unblocked by a human reviewer. The static
 * list captures the never-allowed cases that matter for a hosted
 * service.
 */

export type SanctionsList =
  | "ofac_sdn"
  | "ofac_consolidated"
  | "uk_hmt"
  | "eu_consolidated";

export type ScreeningResult = "clear" | "hit" | "manual_review";

/**
 * ISO-3166-1 alpha-2 codes for jurisdictions where Omninity cannot
 * disburse direct cash payouts under U.S. sanctions law. Creators
 * located here are forced onto the gift-card / account-credit path.
 */
export const COMPREHENSIVE_SANCTIONED_COUNTRIES: ReadonlyArray<string> = [
  "CU", // Cuba
  "IR", // Iran
  "KP", // North Korea
  "SY", // Syria
  "RU", // Russia (current OFAC posture)
  "BY", // Belarus
];

/**
 * ISO-3166-1 alpha-2 codes where Stripe Connect is unavailable to
 * receive payouts. Creators here are also routed onto the alternative
 * payout method (account credit). Bigger than the sanctions list — it
 * also covers countries that are merely Stripe-unsupported.
 */
export const STRIPE_UNSUPPORTED_COUNTRIES: ReadonlyArray<string> = [
  "AF", // Afghanistan
  "VE", // Venezuela
  "ZW", // Zimbabwe
  "MM", // Myanmar
];

/**
 * Tiny synthetic specially-designated-name list used for local
 * screening tests. A real hit triggers `manual_review`, never an
 * automatic deny — a human always confirms a real-world OFAC match
 * (Standard 12: explicit failure modes, no silent blocks).
 */
const SYNTHETIC_SDN_NAMES: ReadonlySet<string> = new Set([
  "test sanctioned individual",
  "blocked party example",
]);

export interface ScreeningInput {
  readonly fullName: string;
  readonly country: string;
}

export interface ScreeningOutcome {
  readonly list: SanctionsList;
  readonly result: ScreeningResult;
  readonly matchedName: string | null;
  readonly matchedCountry: string | null;
  readonly notes: string;
}

function normaliseName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Run all four screening lists for the given recipient. Returns one
 * row per list — the caller persists each one as an audit record so
 * the regulator can trace which list each decision came from.
 */
export function screenRecipient(input: ScreeningInput): ReadonlyArray<ScreeningOutcome> {
  const country = input.country.trim().toUpperCase();
  const name = normaliseName(input.fullName);
  const sanctionsCountryHit = COMPREHENSIVE_SANCTIONED_COUNTRIES.includes(country);
  const nameHit = SYNTHETIC_SDN_NAMES.has(name);

  const lists: SanctionsList[] = [
    "ofac_sdn",
    "ofac_consolidated",
    "uk_hmt",
    "eu_consolidated",
  ];

  return lists.map((list) => {
    if (sanctionsCountryHit) {
      return {
        list,
        result: "hit" as const,
        matchedName: null,
        matchedCountry: country,
        notes: "Comprehensive country sanction — direct payout prohibited.",
      };
    }
    if (nameHit) {
      return {
        list,
        result: "manual_review" as const,
        matchedName: input.fullName,
        matchedCountry: country,
        notes: "Synthetic SDN match — human reviewer must confirm.",
      };
    }
    return {
      list,
      result: "clear" as const,
      matchedName: null,
      matchedCountry: null,
      notes: "No match.",
    };
  });
}

export function isStripeSupported(country: string): boolean {
  const normalised = country.trim().toUpperCase();
  return (
    !COMPREHENSIVE_SANCTIONED_COUNTRIES.includes(normalised) &&
    !STRIPE_UNSUPPORTED_COUNTRIES.includes(normalised)
  );
}

export function payoutRestrictionFor(
  country: string,
):
  | { restricted: false }
  | { restricted: true; method: "gift_card" | "account_credit" | "restricted"; reason: string } {
  const normalised = country.trim().toUpperCase();
  if (COMPREHENSIVE_SANCTIONED_COUNTRIES.includes(normalised)) {
    return {
      restricted: true,
      method: "restricted",
      reason: `Direct payouts prohibited under U.S. sanctions for country ${normalised}.`,
    };
  }
  if (STRIPE_UNSUPPORTED_COUNTRIES.includes(normalised)) {
    return {
      restricted: true,
      method: "account_credit",
      reason: `Stripe Connect unavailable for country ${normalised}; routed to account credit.`,
    };
  }
  return { restricted: false };
}
