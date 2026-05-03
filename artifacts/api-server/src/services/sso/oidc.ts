/**
 * OIDC federation helpers (Task #55).
 *
 * Implements the OIDC Authorization-Code-with-PKCE flow against any
 * RFC-compliant identity provider — Google Workspace, Azure AD,
 * Okta, Ping, OneLogin, Auth0.
 *
 *   1. Discovery — `GET {issuer}/.well-known/openid-configuration` and
 *      cache the resulting JSON on `sso_configurations.oidcDiscoveryJson`.
 *   2. Authorization — build the redirect URL with a PKCE `code_verifier`
 *      stashed in the express session.
 *   3. Token exchange — `POST` to the discovered `token_endpoint` with
 *      the auth code + verifier, receive `id_token` + `access_token`.
 *   4. ID token validation — verify signature against JWKS, audience,
 *      issuer, expiry, nonce.
 *   5. UserInfo (optional) — `GET` the discovered `userinfo_endpoint`.
 *
 * `node:crypto` provides everything required — no third-party JWT lib.
 */
import { createHash, randomBytes, createPublicKey, verify as cryptoVerify } from "node:crypto";

export interface OidcDiscoveryDoc {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint?: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
  readonly id_token_signing_alg_values_supported?: ReadonlyArray<string>;
}

export interface OidcAttributes {
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly groups: ReadonlyArray<string>;
  readonly sid: string | null;
  readonly expiresAt: number | null;
}

export interface OidcValidationResult {
  readonly valid: boolean;
  readonly attributes: OidcAttributes | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/**
 * Fetch the well-known discovery doc for an issuer URL. Uses the global
 * `fetch` and a 5s timeout. Errors are returned, never thrown.
 */
export async function discover(issuer: string, fetchFn: typeof fetch = fetch): Promise<{
  doc: OidcDiscoveryDoc | null;
  error: string | null;
}> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetchFn(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { doc: null, error: `discovery returned HTTP ${res.status}` };
    }
    const doc = (await res.json()) as OidcDiscoveryDoc;
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      return { doc: null, error: "discovery doc missing required fields" };
    }
    return { doc, error: null };
  } catch (e) {
    return { doc: null, error: `discovery fetch failed: ${(e as Error).message}` };
  }
}

/**
 * PKCE — generate a verifier + S256 challenge pair.
 */
export function pkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/**
 * Build the authorization redirect URL. Caller is expected to stash
 * `state`, `nonce`, and `verifier` in the session so the callback
 * handler can complete the flow.
 */
export function buildAuthorizationUrl(input: {
  doc: OidcDiscoveryDoc;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  scopes?: ReadonlyArray<string>;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? ["openid", "email", "profile", "groups"]).join(" "),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  const sep = input.doc.authorization_endpoint.includes("?") ? "&" : "?";
  return `${input.doc.authorization_endpoint}${sep}${params.toString()}`;
}

export interface OidcTokenResponse {
  readonly access_token?: string;
  readonly id_token?: string;
  readonly token_type?: string;
  readonly expires_in?: number;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(input: {
  doc: OidcDiscoveryDoc;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchFn?: typeof fetch;
}): Promise<{ tokens: OidcTokenResponse | null; error: string | null }> {
  const fetchFn = input.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.verifier,
  });
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetchFn(input.doc.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { tokens: null, error: `token endpoint returned HTTP ${res.status}` };
    }
    const tokens = (await res.json()) as OidcTokenResponse;
    return { tokens, error: null };
  } catch (e) {
    return { tokens: null, error: `token exchange failed: ${(e as Error).message}` };
  }
}

/**
 * Decode the JWT header + payload (base64url) without verification.
 */
export function decodeJwt(token: string): {
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { header: null, payload: null, signingInput: "", signature: Buffer.alloc(0) };
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2]!, "base64url"),
    };
  } catch {
    return { header: null, payload: null, signingInput: "", signature: Buffer.alloc(0) };
  }
}

interface JwksKey {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

/**
 * Validate an OIDC `id_token` against the IdP's JWKS.
 */
export async function validateIdToken(input: {
  idToken: string;
  doc: OidcDiscoveryDoc;
  clientId: string;
  expectedNonce: string;
  now?: number;
  fetchFn?: typeof fetch;
}): Promise<OidcValidationResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const decoded = decodeJwt(input.idToken);
  if (!decoded.header || !decoded.payload) {
    return failOidc("MALFORMED", "id_token is not a parseable JWT");
  }
  const alg = String(decoded.header["alg"] ?? "");
  if (!alg.startsWith("RS") && !alg.startsWith("PS") && !alg.startsWith("ES")) {
    return failOidc("BAD_ALG", `id_token alg ${alg} is not asymmetric`);
  }
  // Issuer + audience checks first — cheap and non-cryptographic.
  if (decoded.payload["iss"] !== input.doc.issuer) {
    return failOidc("ISS_MISMATCH", `iss=${String(decoded.payload["iss"])} expected ${input.doc.issuer}`);
  }
  const aud = decoded.payload["aud"];
  const audMatches = Array.isArray(aud) ? aud.includes(input.clientId) : aud === input.clientId;
  if (!audMatches) {
    return failOidc("AUD_MISMATCH", `aud=${JSON.stringify(aud)} expected ${input.clientId}`);
  }
  const exp = Number(decoded.payload["exp"] ?? 0);
  if (!Number.isFinite(exp) || exp + 60 < now) {
    return failOidc("EXPIRED", `id_token exp=${exp} now=${now}`);
  }
  if (decoded.payload["nonce"] !== input.expectedNonce) {
    return failOidc("NONCE_MISMATCH", "id_token nonce does not match issued nonce");
  }

  // Fetch JWKS, find the key by kid.
  const jwks = await fetchJwks(input.doc.jwks_uri, input.fetchFn ?? fetch);
  if (!jwks) return failOidc("JWKS_FETCH", "could not load IdP JWKS");
  const kid = String(decoded.header["kid"] ?? "");
  const key = jwks.keys.find((k) => (kid ? k.kid === kid : true));
  if (!key) return failOidc("KEY_NOT_FOUND", `no matching JWKS key for kid=${kid}`);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: key as never, format: "jwk" });
  } catch (e) {
    return failOidc("BAD_KEY", `JWKS key not importable: ${(e as Error).message}`);
  }
  const okSig = cryptoVerify(
    algToHash(alg),
    Buffer.from(decoded.signingInput),
    publicKey,
    decoded.signature,
  );
  if (!okSig) return failOidc("SIGNATURE_INVALID", "id_token signature did not verify");

  const groups = extractGroups(decoded.payload);
  return {
    valid: true,
    attributes: {
      subject: String(decoded.payload["sub"] ?? ""),
      email:
        typeof decoded.payload["email"] === "string"
          ? (decoded.payload["email"] as string)
          : null,
      displayName:
        typeof decoded.payload["name"] === "string"
          ? (decoded.payload["name"] as string)
          : typeof decoded.payload["preferred_username"] === "string"
            ? (decoded.payload["preferred_username"] as string)
            : null,
      groups,
      sid: typeof decoded.payload["sid"] === "string" ? (decoded.payload["sid"] as string) : null,
      expiresAt: exp * 1000,
    },
    errorCode: null,
    errorMessage: null,
  };
}

function failOidc(code: string, msg: string): OidcValidationResult {
  return { valid: false, attributes: null, errorCode: code, errorMessage: msg };
}

function extractGroups(payload: Record<string, unknown>): ReadonlyArray<string> {
  const candidates = [payload["groups"], payload["roles"], payload["group"]];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((v): v is string => typeof v === "string");
    if (typeof c === "string") return c.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

function algToHash(alg: string): string {
  switch (alg) {
    case "RS256":
    case "PS256":
    case "ES256":
      return "sha256";
    case "RS384":
    case "PS384":
    case "ES384":
      return "sha384";
    case "RS512":
    case "PS512":
    case "ES512":
      return "sha512";
    default:
      return "sha256";
  }
}

async function fetchJwks(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ keys: JwksKey[] } | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetchFn(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as { keys: JwksKey[] };
  } catch {
    return null;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
