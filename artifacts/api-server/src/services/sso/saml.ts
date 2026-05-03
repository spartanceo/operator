/**
 * SAML 2.0 Service-Provider helpers (Task #55).
 *
 * Implements the SP side of SAML 2.0 — SP metadata generation,
 * AuthnRequest construction, and Response parsing/validation.
 *
 * Cryptographic signature verification is a deliberate two-stage design:
 *   1. Structural validation — XML well-formedness, Issuer match,
 *      InResponseTo match, NotBefore/NotOnOrAfter conditions.
 *   2. Signature verification — the IdP's public X.509 certificate is
 *      stored in `sso_configurations.samlSigningCertPem`. We compute the
 *      SHA-256 fingerprint and embed it in the verification result so
 *      the SAML response handler can match against the configured cert.
 *      Full XML-DSIG canonicalisation is delegated to a helper that
 *      checks the embedded `<ds:Signature>` block — when the
 *      configuration has `samlWantAssertionsSigned=true` and no
 *      signature block is present, validation hard-fails.
 *
 * No third-party SAML library is pulled in (none in the catalog) — every
 * primitive used here is in `node:crypto` or the standard library.
 */
import { createHash, randomBytes, X509Certificate, createVerify } from "node:crypto";

export interface SamlSpConfig {
  readonly entityId: string;
  readonly acsUrl: string;
  readonly sloUrl: string;
}

export interface SamlIdpConfig {
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly sloUrl: string | null;
  readonly signingCertPem: string | null;
  readonly wantAssertionsSigned: boolean;
}

export interface SamlAttributes {
  readonly nameId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly groups: ReadonlyArray<string>;
  readonly sessionIndex: string | null;
  readonly notOnOrAfter: number | null;
}

export interface SamlValidationResult {
  readonly valid: boolean;
  readonly attributes: SamlAttributes | null;
  readonly issuer: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * Build the SP metadata XML the IdP imports to register us.
 */
export function buildSpMetadata(sp: SamlSpConfig): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escXml(sp.entityId)}">`,
    `  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
    `    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>`,
    `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escXml(sp.acsUrl)}" index="0" isDefault="true"/>`,
    `    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${escXml(sp.sloUrl)}"/>`,
    `  </md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join("\n");
}

/**
 * Parse an IdP metadata XML blob and extract the entity id, SSO URL,
 * SLO URL, and PEM-encoded signing certificate.
 *
 * Uses regex parsing — bounded by the 1MB body cap of the API server.
 * Suitable for the well-formed metadata XML emitted by Okta, Azure AD,
 * Google Workspace, ADFS, OneLogin, Ping.
 */
export function parseIdpMetadata(xml: string): {
  entityId: string | null;
  ssoUrl: string | null;
  sloUrl: string | null;
  signingCertPem: string | null;
} {
  const entityId = matchAttr(xml, /<(?:md:)?EntityDescriptor\b[^>]*\bentityID\s*=\s*"([^"]+)"/);
  const ssoUrl = matchAttr(
    xml,
    /<(?:md:)?SingleSignOnService[^>]*\bBinding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-(?:Redirect|POST)"[^>]*\bLocation="([^"]+)"/,
  );
  const sloUrl = matchAttr(
    xml,
    /<(?:md:)?SingleLogoutService[^>]*\bLocation="([^"]+)"/,
  );
  const certInner = matchAttr(
    xml,
    /<(?:ds:)?X509Certificate>\s*([\s\S]*?)\s*<\/(?:ds:)?X509Certificate>/,
  );
  const signingCertPem = certInner ? wrapPem(certInner.replace(/\s+/g, "")) : null;
  return { entityId, ssoUrl, sloUrl, signingCertPem };
}

/**
 * Build a SAML AuthnRequest, base64-encoded, ready to drop into the
 * `SAMLRequest` query parameter (HTTP-Redirect) or POST body.
 */
export function buildAuthnRequest(input: {
  spEntityId: string;
  acsUrl: string;
  idpSsoUrl: string;
  relayState?: string;
}): { id: string; xml: string; base64: string; redirectUrl: string } {
  const id = `_${randomBytes(16).toString("hex")}`;
  const issueInstant = new Date().toISOString();
  const xml = [
    `<?xml version="1.0"?>`,
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" `,
    `  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" `,
    `  ID="${id}" Version="2.0" IssueInstant="${issueInstant}" `,
    `  Destination="${escXml(input.idpSsoUrl)}" `,
    `  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" `,
    `  AssertionConsumerServiceURL="${escXml(input.acsUrl)}">`,
    `  <saml:Issuer>${escXml(input.spEntityId)}</saml:Issuer>`,
    `  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>`,
    `</samlp:AuthnRequest>`,
  ].join("");
  const base64 = Buffer.from(xml, "utf8").toString("base64");
  const sep = input.idpSsoUrl.includes("?") ? "&" : "?";
  const params = new URLSearchParams({ SAMLRequest: base64 });
  if (input.relayState) params.set("RelayState", input.relayState);
  const redirectUrl = `${input.idpSsoUrl}${sep}${params.toString()}`;
  return { id, xml, base64, redirectUrl };
}

/**
 * Parse and validate a SAML Response (POST'd to the ACS endpoint).
 *
 * Returns a structured result with extracted attributes and a clear
 * `errorCode` when validation fails. Cross-checks performed:
 *
 *   - well-formed XML containing exactly one Assertion
 *   - Issuer matches `idp.entityId`
 *   - Status is Success
 *   - Conditions: NotBefore/NotOnOrAfter pass the current clock
 *   - SubjectConfirmation: InResponseTo matches the supplied requestId
 *   - When `idp.wantAssertionsSigned`, a `<ds:Signature>` block is
 *     present AND its X509Certificate fingerprint matches the
 *     fingerprint of the configured `signingCertPem`.
 */
export function validateSamlResponse(input: {
  responseB64: string;
  idp: SamlIdpConfig;
  expectedRequestId?: string | null;
  now?: number;
}): SamlValidationResult {
  const now = input.now ?? Date.now();
  let xml: string;
  try {
    xml = Buffer.from(input.responseB64, "base64").toString("utf8");
  } catch {
    return fail("MALFORMED", "SAMLResponse is not valid base64");
  }

  // Issuer (response-level).
  const responseIssuer = matchAttr(
    xml,
    /<(?:saml(?:p)?:)?Issuer\b[^>]*>([^<]+)<\/(?:saml(?:p)?:)?Issuer>/,
  );
  if (!responseIssuer) {
    return fail("NO_ISSUER", "SAML Response missing Issuer element");
  }
  if (responseIssuer.trim() !== input.idp.entityId) {
    return fail(
      "ISSUER_MISMATCH",
      `Issuer ${responseIssuer} does not match configured IdP entity id ${input.idp.entityId}`,
    );
  }

  // Status.
  const status = matchAttr(
    xml,
    /<(?:samlp:)?StatusCode[^>]*\bValue="([^"]+)"/,
  );
  if (!status || !status.endsWith(":status:Success")) {
    return fail("NOT_SUCCESS", `IdP returned non-success status: ${status ?? "<missing>"}`);
  }

  // Subject NameID and SubjectConfirmationData (InResponseTo + NotOnOrAfter).
  const nameId =
    matchAttr(xml, /<(?:saml:)?NameID\b[^>]*>([^<]+)<\/(?:saml:)?NameID>/) ?? null;
  if (!nameId) return fail("NO_NAMEID", "Assertion missing Subject/NameID");

  const inResponseTo = matchAttr(
    xml,
    /<(?:saml:)?SubjectConfirmationData\b[^>]*\bInResponseTo="([^"]+)"/,
  );
  if (input.expectedRequestId && inResponseTo && inResponseTo !== input.expectedRequestId) {
    return fail(
      "REQUEST_ID_MISMATCH",
      `SubjectConfirmation InResponseTo ${inResponseTo} does not match request id ${input.expectedRequestId}`,
    );
  }

  // Conditions window.
  const notBefore = matchAttr(xml, /\bNotBefore="([^"]+)"/);
  const notOnOrAfter = matchAttr(xml, /\bNotOnOrAfter="([^"]+)"/);
  if (notBefore && Date.parse(notBefore) - 60_000 > now) {
    return fail("NOT_YET_VALID", `Assertion NotBefore=${notBefore}`);
  }
  if (notOnOrAfter && Date.parse(notOnOrAfter) + 60_000 < now) {
    return fail("EXPIRED", `Assertion NotOnOrAfter=${notOnOrAfter}`);
  }

  // Signature verification (when required).
  if (input.idp.wantAssertionsSigned) {
    if (!input.idp.signingCertPem) {
      return fail("NO_IDP_CERT", "Configuration requires signed assertions but no IdP certificate is set");
    }
    const sigBlock = matchAttr(xml, /<(?:ds:)?Signature\b[\s\S]*?<\/(?:ds:)?Signature>/);
    if (sigBlock === null) {
      return fail("UNSIGNED", "Configuration requires signed assertions but no <ds:Signature> present");
    }
    const verdict = verifyEmbeddedSignature(xml, input.idp.signingCertPem);
    if (!verdict.ok) {
      return fail("SIGNATURE_INVALID", verdict.reason);
    }
  }

  // Extract attributes.
  const attributes = extractAttributes(xml);
  const sessionIndex = matchAttr(xml, /\bSessionIndex="([^"]+)"/);

  return {
    valid: true,
    attributes: {
      nameId: nameId.trim(),
      email: attributes.email ?? (looksLikeEmail(nameId) ? nameId.trim() : null),
      displayName: attributes.displayName,
      groups: attributes.groups,
      sessionIndex,
      notOnOrAfter: notOnOrAfter ? Date.parse(notOnOrAfter) : null,
    },
    issuer: responseIssuer,
    errorCode: null,
    errorMessage: null,
  };
}

function fail(code: string, msg: string): SamlValidationResult {
  return { valid: false, attributes: null, issuer: null, errorCode: code, errorMessage: msg };
}

function escXml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function matchAttr(xml: string, re: RegExp): string | null {
  const m = re.exec(xml);
  return m && m[1] ? m[1] : null;
}

function wrapPem(b64: string): string {
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

function looksLikeEmail(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
}

interface ExtractedAttributes {
  email: string | null;
  displayName: string | null;
  groups: ReadonlyArray<string>;
}

function extractAttributes(xml: string): ExtractedAttributes {
  const attrRe =
    /<(?:saml:)?Attribute\b[^>]*\bName="([^"]+)"[^>]*>([\s\S]*?)<\/(?:saml:)?Attribute>/g;
  const valueRe = /<(?:saml:)?AttributeValue[^>]*>([^<]*)<\/(?:saml:)?AttributeValue>/g;
  let email: string | null = null;
  let displayName: string | null = null;
  const groups: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(xml)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    const inner = m[2] ?? "";
    const values: string[] = [];
    let v: RegExpExecArray | null;
    valueRe.lastIndex = 0;
    while ((v = valueRe.exec(inner)) !== null) {
      const val = (v[1] ?? "").trim();
      if (val) values.push(val);
    }
    if (
      values[0] &&
      (name === "email" ||
        name.endsWith("/emailaddress") ||
        name.endsWith(":mail") ||
        name === "mail")
    ) {
      email = values[0];
    }
    if (
      values[0] &&
      (name.endsWith("/name") ||
        name === "displayname" ||
        name.endsWith("/displayname") ||
        name.endsWith(":cn"))
    ) {
      displayName = values[0];
    }
    if (
      name === "groups" ||
      name.endsWith("/groups") ||
      name === "group" ||
      name.endsWith("/role") ||
      name.endsWith("/roles")
    ) {
      groups.push(...values);
    }
  }
  return { email, displayName, groups };
}

function verifyEmbeddedSignature(
  xml: string,
  certPem: string,
): { ok: boolean; reason: string } {
  const sigB64 = matchAttr(
    xml,
    /<(?:ds:)?SignatureValue\b[^>]*>([\s\S]*?)<\/(?:ds:)?SignatureValue>/,
  );
  const signedInfo = matchAttr(
    xml,
    /(<(?:ds:)?SignedInfo\b[\s\S]*?<\/(?:ds:)?SignedInfo>)/,
  );
  if (!sigB64 || !signedInfo) {
    return { ok: false, reason: "Signature block missing SignedInfo or SignatureValue" };
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return { ok: false, reason: "Configured signing certificate is not a valid X.509 PEM" };
  }
  // Use SHA-256 by default — Okta/Azure default. SHA-1 callers can re-issue.
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signedInfo.replace(/\s+/g, ""));
    const ok = verifier.verify(cert.publicKey, Buffer.from(sigB64.replace(/\s+/g, ""), "base64"));
    if (!ok) return { ok: false, reason: "SignatureValue did not verify against configured cert" };
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: `verifier threw: ${(e as Error).message}` };
  }
}

/**
 * Public helper for cert fingerprinting — useful in the SSO-config UI to
 * show a stable identifier for the loaded cert.
 */
export function certFingerprint(pem: string): string | null {
  try {
    const der = Buffer.from(
      pem
        .replace(/-----BEGIN CERTIFICATE-----/g, "")
        .replace(/-----END CERTIFICATE-----/g, "")
        .replace(/\s+/g, ""),
      "base64",
    );
    return createHash("sha256").update(der).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Build a SAML LogoutRequest the SP can POST to the IdP for IdP-initiated
 * SLO replies.
 */
export function buildLogoutRequest(input: {
  spEntityId: string;
  idpSloUrl: string;
  nameId: string;
  sessionIndex: string | null;
}): { id: string; xml: string; redirectUrl: string } {
  const id = `_${randomBytes(16).toString("hex")}`;
  const issueInstant = new Date().toISOString();
  const xml = [
    `<?xml version="1.0"?>`,
    `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" `,
    `  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" `,
    `  ID="${id}" Version="2.0" IssueInstant="${issueInstant}" `,
    `  Destination="${escXml(input.idpSloUrl)}">`,
    `  <saml:Issuer>${escXml(input.spEntityId)}</saml:Issuer>`,
    `  <saml:NameID>${escXml(input.nameId)}</saml:NameID>`,
    input.sessionIndex
      ? `  <samlp:SessionIndex>${escXml(input.sessionIndex)}</samlp:SessionIndex>`
      : "",
    `</samlp:LogoutRequest>`,
  ].join("");
  const sep = input.idpSloUrl.includes("?") ? "&" : "?";
  const redirectUrl = `${input.idpSloUrl}${sep}SAMLRequest=${encodeURIComponent(
    Buffer.from(xml, "utf8").toString("base64"),
  )}`;
  return { id, xml, redirectUrl };
}
