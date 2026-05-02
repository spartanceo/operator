/**
 * Legal documents catalogue (Task #25).
 *
 * EULA, Privacy Policy, Terms of Service, EU AI Act conformity statement,
 * and the open-source-attribution summary are shipped as code so:
 *  - the document hash is deterministic and verifiable at build time,
 *  - every binary release ships the exact text the user agreed to,
 *  - no live network call is required to display the legal screen.
 *
 * Updates: bumping the `version` field in any entry below counts as a
 * material change. The acceptance gate (`requiresAcceptance`) detects
 * the version delta and re-prompts the user before they can continue.
 *
 * Adding a document type: append to `LEGAL_DOCUMENT_TYPES` and the
 * `LEGAL_DOCUMENTS` array. Both are used by the API surface and the UI;
 * keeping them as data (Standard 12) means the wizard, settings page,
 * and the OpenAPI `enum` stay in lock-step.
 */
import { createHash } from "node:crypto";

export const LEGAL_DOCUMENT_TYPES = [
  "eula",
  "privacy",
  "terms",
  "eu_ai_act",
  "open_source_attribution",
] as const;

export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export interface LegalDocument {
  readonly type: LegalDocumentType;
  readonly title: string;
  readonly version: string;
  readonly effectiveDate: string;
  readonly summary: string;
  readonly body: string;
  /** When false the doc is informational only (e.g. EU AI Act statement). */
  readonly requiresAcceptance: boolean;
}

const EULA_BODY = `OMNINITY OPERATOR — END USER LICENCE AGREEMENT

Effective: 2026-05-01
Version: 1.0

1. Grant of Licence
This End User Licence Agreement ("EULA") is a binding contract between you
("User") and Omninity, PBC ("Omninity") for the Omninity Operator desktop
application, including all bundled local models and skills (the
"Software"). Subject to your compliance with this EULA, Omninity grants
you a worldwide, non-exclusive, non-transferable, revocable licence to
install and use the Software on devices you own or control, for personal
or internal business use.

2. Restrictions
You may not (a) reverse engineer, decompile, or disassemble the Software
except to the extent permitted by applicable law; (b) sublicence, rent,
or resell the Software; (c) remove or alter any proprietary notices; or
(d) use the Software to violate any law, infringe any third-party right,
or operate critical infrastructure where failure could cause physical
harm.

3. Local-First Architecture
The Software is designed to run primarily on your device. Omninity does
not receive your prompts, agent runs, or personal data unless you
explicitly enable a cloud feature, install a third-party skill, or
submit an incident report. Network egress is logged in the in-app
privacy ledger.

4. Bundled Models
The Software ships with or downloads on demand third-party AI models.
Each model is governed by its own licence, surfaced in-app at download
time and on the model licence settings page. Continued use of a model
requires continued compliance with its licence.

5. Open Source Components
The Software incorporates open-source components listed in the open
source attribution document. Those licences are reproduced in the
attribution file shipped with the Software and accessible from settings.

6. No Warranty
THE SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY WARRANTY OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
THE SOFTWARE EXECUTES AUTONOMOUS ACTIONS ON YOUR BEHALF; YOU ARE
RESPONSIBLE FOR REVIEWING ALL APPROVAL GATES BEFORE CONFIRMING.

7. Limitation of Liability
TO THE MAXIMUM EXTENT PERMITTED BY LAW, OMNINITY SHALL NOT BE LIABLE
FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES
ARISING OUT OF OR RELATED TO YOUR USE OF THE SOFTWARE. OMNINITY'S
AGGREGATE LIABILITY IS LIMITED TO THE AMOUNTS YOU PAID FOR THE
SOFTWARE IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR USD $50,
WHICHEVER IS GREATER.

8. Termination
This EULA terminates automatically if you breach its terms. On
termination you must uninstall the Software. Sections 6, 7, 8, and 10
survive termination.

9. Export Control
You agree not to export, re-export, or transfer the Software to any
person or destination prohibited by applicable export control laws,
including the US Export Administration Regulations.

10. Governing Law
This EULA is governed by the laws of the State of Delaware, USA,
without regard to conflict-of-laws rules.

By clicking "I agree" you confirm you have read and accept this EULA.
`;

const PRIVACY_BODY = `OMNINITY OPERATOR — PRIVACY POLICY

Effective: 2026-05-01
Version: 1.0

Omninity Operator is local-first. We collect the minimum amount of
information required to operate the Software and never sell personal
data.

1. Data Stored On Your Device
The Software stores onboarding answers, agent run history, knowledge
base entries, skill state, model preferences, and the in-app privacy
ledger in an encrypted SQLite database in your local profile directory.
This data never leaves your device unless you explicitly enable a
cloud feature.

2. Data Transmitted To Omninity
We collect the following only when you opt in:
  (a) crash reports — anonymous stack traces, app version, OS version;
  (b) telemetry — anonymous usage counters, never prompts or contents;
  (c) incident reports — the title, description, and metadata you submit
      via Settings → Legal → Report an Incident.
You can disable telemetry and crash reports at any time in Settings.

3. Data Transmitted To Third Parties
The Software calls third-party services only when you (a) install a
skill that requires the integration, (b) use a model hosted by a third
party (off by default — local models are the default), or (c) connect
an account in the Communications Hub. Every outbound network call is
logged in the in-app privacy ledger with the destination, the reason,
and the bytes sent.

4. Data Subject Rights
You can export every byte of your data via Settings → Privacy →
Export, and you can erase your tenant via Settings → Privacy → Erase.
GDPR, CCPA, and similar rights of access, rectification, portability,
and erasure are honoured by these in-app controls.

5. Children's Privacy
The Software is not directed to children. We do not knowingly collect
personal data from anyone under 13 (US — COPPA) or under 16 (EU —
GDPR-K). The age gate at account creation enforces this. If you
believe a child has provided us data, contact privacy@omninity.example
and we will erase it.

6. Security
Local data is encrypted at rest using OS-level keychain integration.
Sessions are bound to your device. Outbound traffic uses TLS with
certificate pinning for first-party endpoints.

7. Updates
Material changes to this Privacy Policy will trigger a re-acceptance
prompt the next time you launch the Software.

8. Contact
Questions: privacy@omninity.example
EU representative: eu-rep@omninity.example
`;

const TERMS_BODY = `OMNINITY OPERATOR — TERMS OF SERVICE

Effective: 2026-05-01
Version: 1.0

These Terms of Service ("Terms") govern your use of the Omninity
Operator marketplace, creator program, subscription services, and any
hosted features ("Services") provided by Omninity, PBC. Your use of the
desktop Software is governed separately by the EULA.

1. Account Eligibility
You must be at least 13 years old (16 in the EU) to use the Services.
Business accounts must be created by an authorised representative.

2. Marketplace
The Skills Marketplace lets independent creators publish skills you
can install into the Software. Skills run locally with the same
permissions as the Software. Omninity reviews skills for safety but
does not warrant their fitness for any purpose; install only skills
from creators you trust.

3. Subscriptions and Billing
Paid plans renew automatically until cancelled. You can cancel any
time from Settings; the change takes effect at the end of the current
billing period. Refunds are governed by the refund policy linked from
your account settings.

4. Acceptable Use
You agree not to use the Services to (a) infringe any third party's
rights, (b) generate or distribute illegal content, (c) attack, probe,
or overload Omninity's infrastructure, (d) bypass paywalls or rate
limits, or (e) violate any applicable export control or sanctions law.

5. Intellectual Property
You retain ownership of the content you create. By submitting a skill
to the marketplace you grant Omninity a worldwide, royalty-free
licence to host, display, and distribute it through the marketplace.

6. Termination
We may suspend or terminate your account if you breach these Terms,
violate applicable law, or place the Services at risk. We will provide
notice and a cure period when reasonably possible.

7. Disclaimers and Limitation of Liability
The Services are provided "as is". Aggregate liability is capped at
the greater of (a) USD $100 or (b) amounts paid to Omninity in the
twelve months preceding the claim.

8. Changes
Material changes to these Terms will trigger a re-acceptance prompt
the next time you launch the Software.

9. Governing Law and Dispute Resolution
These Terms are governed by the laws of the State of Delaware. Any
dispute will be resolved by binding arbitration under the AAA
Commercial Rules, except for claims that may be brought in small
claims court.
`;

const EU_AI_ACT_BODY = `OMNINITY OPERATOR — EU AI ACT CONFORMITY STATEMENT

Effective: 2026-05-01
Version: 1.0

This statement summarises Omninity Operator's compliance posture with
respect to Regulation (EU) 2024/1689 (the "EU AI Act").

1. Risk Classification
Omninity Operator is a general-purpose AI assistant that controls a
user's own desktop on their behalf. Under Article 6 and Annex III of
the AI Act, the Software is classified as a LIMITED-RISK system
(category: AI system that interacts with natural persons, generates
synthetic content, and assists with workplace tasks). It is NOT
classified as a high-risk system because:
  - it does not perform employment, credit, education, immigration,
    or law-enforcement decision-making;
  - it does not operate safety components of critical infrastructure;
  - it requires explicit human approval before any action with
    real-world side effects (filesystem writes, network calls,
    payments, communications).

2. Human Oversight (Article 14)
Every autonomous action passes through an in-app approval gate. The
user can: review the planned action, see the destination and payload,
approve, deny, or pause the agent run. Risk-tiered tools require
elevated approval. The Software cannot complete a destructive action
without an explicit human decision recorded in the audit log.

3. Transparency (Article 50)
  - Users are informed they are interacting with an AI system at the
    first launch and on every chat surface.
  - AI-generated content is marked as such in exports.
  - The system's intended purpose, capabilities, and known limitations
    are documented in the in-app help and on the public website.

4. Technical Documentation (Article 11 / Annex IV)
A technical documentation pack is maintained in
\`docs/legal/eu-ai-act-technical-documentation.md\` covering: system
architecture, training-data sources for bundled models, accuracy and
robustness metrics, known limitations, risk-mitigation measures, and
the post-market monitoring plan.

5. Incident Reporting (Article 73)
Users can report unexpected autonomous behaviour from Settings →
Legal → Report an Incident. Reports are triaged within 7 days; serious
incidents are reported to the relevant national competent authority
within 15 days as required by the regulation.

6. Bundled Models — General Purpose AI
The bundled foundation models (Llama 3, Mistral, Qwen, LLaVA, Whisper,
Stable Diffusion, FLUX, MusicGen, Kokoro) are general-purpose AI
models supplied by upstream providers. Omninity reproduces each
model's licence and intended-use statement at download time and
maintains a model licence summary in Settings.

7. Conformity Assessment
Limited-risk systems do not require third-party conformity assessment
under the AI Act. Omninity self-attests via this statement, the in-app
disclosures, and the technical documentation pack.

For questions, contact: ai-compliance@omninity.example
`;

const ATTRIBUTION_BODY = `OMNINITY OPERATOR — OPEN SOURCE ATTRIBUTIONS

Effective: 2026-05-01
Version: 1.0

Omninity Operator is built on the open source community. The full,
machine-generated attribution file (\`THIRD_PARTY_LICENCES.md\`) is
shipped with the Software and accessible from Settings → Legal →
Open source licences. It enumerates every npm dependency, its version,
its SPDX licence identifier, and the upstream copyright notice.

Licence policy
  - We ship code under the MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
    ISC, 0BSD, CC0-1.0, and Unlicense licences.
  - GPL and AGPL packages are FORBIDDEN in production dependencies of
    distributed binaries because they would force the entire Omninity
    Operator binary under copyleft terms (which conflicts with the
    proprietary EULA).
  - LGPL packages may be used only as dynamically linked dependencies
    of stand-alone binaries the user runs out-of-process (e.g. system
    libraries).
  - The CI \`pnpm run check-licences\` step enforces this allow-list and
    fails the build on any violation. New violations require an
    explicit waiver in \`scripts/licence-allowlist.ts\`.

Attribution generation
The attribution file is regenerated by \`pnpm run generate-attribution\`
which walks the production dependency tree, reads each package's
declared SPDX licence, and emits the canonical
\`THIRD_PARTY_LICENCES.md\` shipped with releases.

Notices
Where an upstream package requires a specific notice (e.g. NOTICE for
Apache-2.0 components), the notice is reproduced verbatim in the
generated file.
`;

export const LEGAL_DOCUMENTS: ReadonlyArray<LegalDocument> = [
  {
    type: "eula",
    title: "End User Licence Agreement",
    version: "1.0",
    effectiveDate: "2026-05-01",
    summary:
      "The contract that governs your use of the Omninity Operator desktop app and bundled models.",
    body: EULA_BODY,
    requiresAcceptance: true,
  },
  {
    type: "privacy",
    title: "Privacy Policy",
    version: "1.0",
    effectiveDate: "2026-05-01",
    summary:
      "What data we collect (almost nothing), where it lives (your device), and your rights.",
    body: PRIVACY_BODY,
    requiresAcceptance: true,
  },
  {
    type: "terms",
    title: "Terms of Service",
    version: "1.0",
    effectiveDate: "2026-05-01",
    summary:
      "Rules for the marketplace, creator program, subscriptions, and any hosted services.",
    body: TERMS_BODY,
    requiresAcceptance: true,
  },
  {
    type: "eu_ai_act",
    title: "EU AI Act Conformity Statement",
    version: "1.0",
    effectiveDate: "2026-05-01",
    summary:
      "Risk classification, human oversight, transparency, and incident reporting commitments.",
    body: EU_AI_ACT_BODY,
    requiresAcceptance: false,
  },
  {
    type: "open_source_attribution",
    title: "Open Source Attributions",
    version: "1.0",
    effectiveDate: "2026-05-01",
    summary:
      "Our open-source licence policy and pointer to the generated attribution file.",
    body: ATTRIBUTION_BODY,
    requiresAcceptance: false,
  },
];

// tier-review: bounded — keyed by `${type}:${version}` for the static LEGAL_DOCUMENTS catalogue (5 entries, never grows at runtime).
const HASH_CACHE = new Map<string, string>();

export function hashDocument(doc: LegalDocument): string {
  const cacheKey = `${doc.type}:${doc.version}`;
  const existing = HASH_CACHE.get(cacheKey);
  if (existing) return existing;
  const hash = createHash("sha256")
    .update(`${doc.type}\n${doc.version}\n${doc.body}`)
    .digest("hex");
  HASH_CACHE.set(cacheKey, hash);
  return hash;
}

export function getLegalDocument(
  type: LegalDocumentType,
): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((d) => d.type === type);
}

export interface LegalDocumentSummary {
  type: LegalDocumentType;
  title: string;
  version: string;
  effectiveDate: string;
  summary: string;
  requiresAcceptance: boolean;
  hash: string;
}

export function summariseDocument(doc: LegalDocument): LegalDocumentSummary {
  return {
    type: doc.type,
    title: doc.title,
    version: doc.version,
    effectiveDate: doc.effectiveDate,
    summary: doc.summary,
    requiresAcceptance: doc.requiresAcceptance,
    hash: hashDocument(doc),
  };
}
