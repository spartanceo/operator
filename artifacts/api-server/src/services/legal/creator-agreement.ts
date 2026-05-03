/**
 * Creator Agreement catalogue (Task #26).
 *
 * Versioned text — bumping `version` flags every existing creator as
 * needing to re-sign before publishing their next skill. The hash is
 * derived from `body` so an accidental edit without a version bump is
 * detected by the gate (the previous signature's hash will not match).
 *
 * Kept as data (Standard 12 / 1) so the OpenAPI enum, the in-app
 * dashboard, and the marketing-site preview all stay in lock-step.
 */
import { createHash } from "node:crypto";

export interface CreatorAgreement {
  readonly version: string;
  readonly effectiveDate: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

const CREATOR_AGREEMENT_BODY = `OMNINITY OPERATOR — CREATOR AGREEMENT

Effective: 2026-05-01
Version: 1.0

By submitting a skill to the Omninity Operator Skills Marketplace
("Marketplace") you ("Creator") agree to be bound by this Creator
Agreement with Omninity, PBC ("Omninity").

1. Eligibility
You represent that you are at least 18 years old, have authority to
enter this agreement, and are not a resident of any jurisdiction
subject to comprehensive U.S. or U.N. trade sanctions.

2. Content Ownership and Licence
You retain all right, title and interest in and to your skills. By
publishing a skill you grant Omninity a worldwide, non-exclusive,
royalty-free licence to host, distribute, copy, display, transmit,
sublicense to end users, and create necessary technical derivatives
(format conversion, version pins, vulnerability patches) of the skill
for the limited purpose of operating the Marketplace and delivering
your skill to users who install it.

3. Representations and Warranties
You represent and warrant that (a) you own or have a sufficient
licence to every component of the skill, (b) the skill does not
infringe any third-party copyright, trademark, patent, trade secret,
right of publicity, or privacy right, (c) the skill complies with all
applicable laws, and (d) the skill is free of malware, hidden network
egress, prompt-injection payloads aimed at OP, or any concealed
monetisation.

4. Prohibited Content
You will not publish skills that (a) sexualise minors; (b) facilitate
unauthorised access to computer systems; (c) generate weapons of mass
destruction or dual-use chemistry/biology/radiology/nuclear content;
(d) impersonate Omninity, OP staff, or another creator; (e) bypass
OP's approval gates or auto-lock; (f) collect end-user secrets,
passwords, or session cookies; (g) violate Omninity's Acceptable Use
Policy as amended.

5. Revenue Share
For premium skills sold via the Marketplace you receive eighty-five
percent (85%) of the net revenue (gross less payment processor fees,
applicable taxes, refunds and chargebacks). Omninity retains the
remaining fifteen percent (15%). Payouts are subject to Section 8.

6. Removal Rights
Omninity may suspend, remove, or refuse to distribute any skill at
any time, with or without notice, where Omninity determines in good
faith that the skill violates this agreement, is the subject of a
valid legal complaint (including DMCA notices), or poses a security
or safety risk. Omninity will use commercially reasonable efforts to
notify you and offer a path to cure where appropriate.

7. DMCA and Repeat Infringer Policy
Omninity follows a notice-and-takedown process under 17 USC § 512.
You may submit a counter-notice via the in-app DMCA portal. Creators
who incur multiple valid takedowns will be permanently banned from
the Marketplace.

8. Tax and Payouts
Before your first payout you must submit a valid IRS Form W-9 (US
persons) or W-8BEN / W-8BEN-E (non-US persons). If a valid tax
identification number is not on file, U.S. backup withholding of 24%
will be applied to all payouts. Omninity will issue Form 1099-K to
US creators whose annual gross exceeds the IRS threshold and file the
corresponding return. Payouts are made via Stripe Connect; payment is
subject to sanctions screening and to the payout terms disclosed in
the Creator Dashboard, including the minimum payout threshold and
processing schedule.

9. Indemnity
You will defend, indemnify, and hold Omninity, its officers,
directors, employees, and end users harmless from any claim, demand,
loss, or damage (including attorneys' fees) arising out of (a) your
breach of this agreement, (b) any claim that your skill infringes a
third-party right, or (c) your violation of any applicable law.

10. Disclaimer and Liability Cap
YOUR PARTICIPATION IN THE MARKETPLACE IS PROVIDED "AS IS". TO THE
MAXIMUM EXTENT PERMITTED BY LAW, OMNINITY DISCLAIMS ALL WARRANTIES
REGARDING THE MARKETPLACE. OMNINITY'S AGGREGATE LIABILITY TO YOU
ARISING OUT OF THIS AGREEMENT WILL NOT EXCEED THE TOTAL AMOUNTS PAID
TO YOU IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR USD $100,
WHICHEVER IS GREATER.

11. Termination
You may terminate by withdrawing every published skill and notifying
Omninity. Omninity may terminate immediately for material breach.
Sections 2 (final-sentence licence to maintain installed copies for
existing users), 3, 9, 10, and 12 survive termination.

12. Governing Law
This agreement is governed by the laws of the State of Delaware,
USA, without regard to its conflict-of-laws principles. Disputes
will be resolved exclusively in the state or federal courts located
in Wilmington, Delaware.

By clicking "I agree", typing your full legal name in the signature
field, and submitting the form, you (a) confirm you have read and
agree to this Creator Agreement, (b) consent to electronic signature
under the U.S. E-SIGN Act and equivalent foreign laws, and (c)
authorise Omninity to record your IP address, user agent, and
timestamp as evidence of execution.
`;

export const CREATOR_AGREEMENT: CreatorAgreement = {
  version: "1.0",
  effectiveDate: "2026-05-01",
  title: "Omninity Creator Agreement",
  summary:
    "Defines the terms under which creators publish skills to the Omninity Marketplace, including content ownership, the 85/15 revenue share, prohibited content, DMCA, tax compliance, and payout terms.",
  body: CREATOR_AGREEMENT_BODY,
};

export function hashCreatorAgreement(agreement: CreatorAgreement): string {
  return createHash("sha256")
    .update(`${agreement.version}\n${agreement.body}`)
    .digest("hex");
}

export function currentCreatorAgreementHash(): string {
  return hashCreatorAgreement(CREATOR_AGREEMENT);
}
