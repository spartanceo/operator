/**
 * Static tax-rate catalogue used for VAT / GST / sales-tax calculation
 * at checkout. Kept as data so the OSS quarterly remittance report and
 * the on-invoice display stay in lock-step.
 *
 * Numbers reflect the standard rate as of 2026-05-01. They are *not*
 * legal advice; in production we would call Stripe Tax / Avalara at
 * point of sale and fall back to this table only if the live call
 * fails. The shape mirrors what those APIs return so swapping in a
 * live provider is a one-file change.
 */

export type RemittanceBucket = "eu_oss" | "uk_vat" | "au_gst" | "us_sales_tax" | "none";
export type TaxType = "vat" | "gst" | "sales_tax" | "none";

export interface TaxJurisdiction {
  readonly country: string;
  readonly name: string;
  readonly taxType: TaxType;
  readonly rateBps: number;
  readonly remittanceBucket: RemittanceBucket;
  /** True if reverse-charge applies for verified business buyers (B2B). */
  readonly reverseChargeForBusiness: boolean;
}

const EU_COUNTRIES: ReadonlyArray<{ code: string; name: string; rateBps: number }> = [
  { code: "AT", name: "Austria", rateBps: 2000 },
  { code: "BE", name: "Belgium", rateBps: 2100 },
  { code: "BG", name: "Bulgaria", rateBps: 2000 },
  { code: "HR", name: "Croatia", rateBps: 2500 },
  { code: "CY", name: "Cyprus", rateBps: 1900 },
  { code: "CZ", name: "Czechia", rateBps: 2100 },
  { code: "DK", name: "Denmark", rateBps: 2500 },
  { code: "EE", name: "Estonia", rateBps: 2200 },
  { code: "FI", name: "Finland", rateBps: 2550 },
  { code: "FR", name: "France", rateBps: 2000 },
  { code: "DE", name: "Germany", rateBps: 1900 },
  { code: "GR", name: "Greece", rateBps: 2400 },
  { code: "HU", name: "Hungary", rateBps: 2700 },
  { code: "IE", name: "Ireland", rateBps: 2300 },
  { code: "IT", name: "Italy", rateBps: 2200 },
  { code: "LV", name: "Latvia", rateBps: 2100 },
  { code: "LT", name: "Lithuania", rateBps: 2100 },
  { code: "LU", name: "Luxembourg", rateBps: 1700 },
  { code: "MT", name: "Malta", rateBps: 1800 },
  { code: "NL", name: "Netherlands", rateBps: 2100 },
  { code: "PL", name: "Poland", rateBps: 2300 },
  { code: "PT", name: "Portugal", rateBps: 2300 },
  { code: "RO", name: "Romania", rateBps: 1900 },
  { code: "SK", name: "Slovakia", rateBps: 2300 },
  { code: "SI", name: "Slovenia", rateBps: 2200 },
  { code: "ES", name: "Spain", rateBps: 2100 },
  { code: "SE", name: "Sweden", rateBps: 2500 },
];

// tier-review: bounded — fixed-size literal jurisdiction table (EU + a handful of others)
const TABLE: ReadonlyMap<string, TaxJurisdiction> = new Map<string, TaxJurisdiction>([
  ...EU_COUNTRIES.map(
    (c): [string, TaxJurisdiction] => [
      c.code,
      {
        country: c.code,
        name: c.name,
        taxType: "vat",
        rateBps: c.rateBps,
        remittanceBucket: "eu_oss",
        reverseChargeForBusiness: true,
      },
    ],
  ),
  [
    "GB",
    {
      country: "GB",
      name: "United Kingdom",
      taxType: "vat",
      rateBps: 2000,
      remittanceBucket: "uk_vat",
      reverseChargeForBusiness: true,
    },
  ],
  [
    "AU",
    {
      country: "AU",
      name: "Australia",
      taxType: "gst",
      rateBps: 1000,
      remittanceBucket: "au_gst",
      reverseChargeForBusiness: true,
    },
  ],
  [
    "US",
    {
      country: "US",
      name: "United States",
      taxType: "sales_tax",
      rateBps: 0,
      remittanceBucket: "us_sales_tax",
      reverseChargeForBusiness: false,
    },
  ],
]);

/**
 * Returns the active tax jurisdiction for the buyer country, or
 * `null` if no tax applies (e.g. unsupported country / offshore).
 */
export function getTaxJurisdiction(country: string): TaxJurisdiction | null {
  const normalised = country.trim().toUpperCase();
  return TABLE.get(normalised) ?? null;
}

export interface TaxQuote {
  readonly buyerCountry: string;
  readonly taxType: TaxType;
  readonly taxRateBps: number;
  readonly netAmountCents: number;
  readonly taxAmountCents: number;
  readonly grossAmountCents: number;
  readonly remittanceBucket: RemittanceBucket;
  readonly isBusiness: boolean;
  readonly reverseCharged: boolean;
  readonly displayLabel: string;
}

/**
 * Quote tax for one transaction. Reverse-charges apply for B2B EU /
 * UK / AU sales when the business has supplied a VAT/GST number.
 */
export function quoteTax(input: {
  buyerCountry: string;
  netAmountCents: number;
  isBusiness?: boolean;
  businessVatNumber?: string | null;
}): TaxQuote {
  const country = input.buyerCountry.trim().toUpperCase();
  const jurisdiction = getTaxJurisdiction(country);
  const isBusiness = Boolean(input.isBusiness);
  const hasVatNumber = Boolean(input.businessVatNumber && input.businessVatNumber.length > 0);

  if (!jurisdiction) {
    return {
      buyerCountry: country,
      taxType: "none",
      taxRateBps: 0,
      netAmountCents: input.netAmountCents,
      taxAmountCents: 0,
      grossAmountCents: input.netAmountCents,
      remittanceBucket: "none",
      isBusiness,
      reverseCharged: false,
      displayLabel: "No tax",
    };
  }

  const reverseCharged =
    jurisdiction.reverseChargeForBusiness && isBusiness && hasVatNumber;

  if (reverseCharged) {
    return {
      buyerCountry: country,
      taxType: jurisdiction.taxType,
      taxRateBps: 0,
      netAmountCents: input.netAmountCents,
      taxAmountCents: 0,
      grossAmountCents: input.netAmountCents,
      remittanceBucket: jurisdiction.remittanceBucket,
      isBusiness: true,
      reverseCharged: true,
      displayLabel: `Reverse charge — ${jurisdiction.taxType.toUpperCase()} payable by recipient`,
    };
  }

  const taxAmount = Math.round((input.netAmountCents * jurisdiction.rateBps) / 10_000);
  return {
    buyerCountry: country,
    taxType: jurisdiction.taxType,
    taxRateBps: jurisdiction.rateBps,
    netAmountCents: input.netAmountCents,
    taxAmountCents: taxAmount,
    grossAmountCents: input.netAmountCents + taxAmount,
    remittanceBucket: jurisdiction.remittanceBucket,
    isBusiness,
    reverseCharged: false,
    displayLabel: `${jurisdiction.taxType.toUpperCase()} ${(jurisdiction.rateBps / 100).toFixed(2)}%`,
  };
}

export const TAX_JURISDICTIONS: ReadonlyArray<TaxJurisdiction> = Array.from(
  TABLE.values(),
);
