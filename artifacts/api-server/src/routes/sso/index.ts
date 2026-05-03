/**
 * /api/sso — SAML 2.0 + OIDC Service Provider endpoints (Task #55).
 *
 * SAML routes:
 *   GET  /sso/saml/metadata      — SP metadata XML for IdP import.
 *   GET  /sso/saml/login         — SP-initiated AuthnRequest redirect.
 *   POST /sso/saml/acs           — Assertion Consumer Service (IdP→SP).
 *   POST /sso/saml/slo           — Single Logout endpoint.
 *
 * OIDC routes:
 *   GET  /sso/oidc/login         — Authorization redirect with PKCE.
 *   GET  /sso/oidc/callback      — Code exchange + id_token validation.
 *   POST /sso/oidc/logout        — Local + RP-initiated end_session.
 *
 * Break-glass:
 *   POST /sso/break-glass/login  — Emergency local-admin auth.
 *
 * The session middleware (express-session) is already mounted globally
 * by `app.ts`; we attach `req.session.sso` for the in-flight SAML/OIDC
 * state and `req.session.user` after successful login.
 */
import { Router, type IRouter, type Request } from "express";
import { randomBytes } from "node:crypto";

import { err, ok } from "../../lib/api-envelope";
import { requireTenantContext } from "../../lib/tenant-context";
import { authLimiter } from "../../middlewares/auth-rate-limit";
import { requireTenant } from "../../middlewares/tenant-context";
import { verifyBreakGlass } from "../../services/break-glass.service";
import {
  buildSamlSloRedirect,
  createSsoSession,
  findSessionsForSlo,
  getOidcClientSecret,
  getSamlSigningCertPem,
  getSsoConfig,
  jitProvisionSeat,
  recordLoginEvent,
  terminateSsoSession,
} from "../../services/sso";
import {
  buildAuthorizationUrl,
  discover,
  exchangeCode,
  pkcePair,
  validateIdToken,
} from "../../services/sso/oidc";
import {
  buildAuthnRequest,
  buildSpMetadata,
  validateSamlResponse,
} from "../../services/sso/saml";

const router: IRouter = Router();

interface SsoSessionState {
  saml?: { requestId: string; relayState?: string };
  oidc?: { state: string; nonce: string; verifier: string };
  user?: { seatId: string; email: string; role: string; protocol: string };
}

interface SessionWithSso {
  sso?: SsoSessionState;
  user?: { seatId: string; email: string; role: string; protocol: string };
  destroy(cb: (err: unknown) => void): void;
  id: string;
}

function sess(req: Request): SessionWithSso {
  const s = (req as unknown as { session?: SessionWithSso }).session;
  if (!s) throw new Error("session middleware missing");
  if (!s.sso) s.sso = {};
  return s;
}

function spBaseUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/api/sso`;
}

function clientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  return req.ip ?? null;
}

// ─────────── SAML ────────────────────────────────────────────────────────

router.get("/saml/metadata", requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cfg = await getSsoConfig(ctx);
  const entityId = cfg?.saml.entityId ?? `${spBaseUrl(req)}/saml/metadata`;
  const xml = buildSpMetadata({
    entityId: `${spBaseUrl(req)}/saml/metadata`,
    acsUrl: `${spBaseUrl(req)}/saml/acs`,
    sloUrl: `${spBaseUrl(req)}/saml/slo`,
  });
  res.setHeader("Content-Type", "application/samlmetadata+xml");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="omninity-sp-metadata-${entityId.replace(/[^A-Za-z0-9]/g, "_")}.xml"`,
  );
  res.send(xml);
});

router.get("/saml/login", authLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cfg = await getSsoConfig(ctx);
  if (!cfg || cfg.protocol !== "saml" || !cfg.saml.ssoUrl) {
    res.status(400).json(err("SSO_NOT_CONFIGURED", "SAML SSO is not configured for this tenant"));
    return;
  }
  const relayState = typeof req.query["relay"] === "string" ? req.query["relay"] : undefined;
  const built = buildAuthnRequest({
    spEntityId: `${spBaseUrl(req)}/saml/metadata`,
    acsUrl: `${spBaseUrl(req)}/saml/acs`,
    idpSsoUrl: cfg.saml.ssoUrl,
    ...(relayState !== undefined ? { relayState } : {}),
  });
  const state = sess(req);
  state.sso = state.sso ?? {};
  state.sso.saml = { requestId: built.id, ...(relayState !== undefined ? { relayState } : {}) };
  res.redirect(302, built.redirectUrl);
});

router.post("/saml/acs", authLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cfg = await getSsoConfig(ctx);
  if (!cfg || cfg.protocol !== "saml" || !cfg.saml.entityId) {
    res.status(400).json(err("SSO_NOT_CONFIGURED", "SAML SSO is not configured"));
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const samlResponse = body["SAMLResponse"];
  if (typeof samlResponse !== "string") {
    res.status(400).json(err("INVALID_BODY", "SAMLResponse field required"));
    return;
  }
  const state = sess(req);
  const expectedRequestId = state.sso?.saml?.requestId ?? null;
  const signingCertPem = await getSamlSigningCertPem(ctx);
  const verdict = validateSamlResponse({
    responseB64: samlResponse,
    idp: {
      entityId: cfg.saml.entityId,
      ssoUrl: cfg.saml.ssoUrl ?? "",
      sloUrl: cfg.saml.sloUrl,
      signingCertPem,
      wantAssertionsSigned: cfg.saml.wantAssertionsSigned,
    },
    expectedRequestId,
  });
  if (!verdict.valid || !verdict.attributes) {
    await recordLoginEvent(ctx, {
      protocol: "saml",
      outcome: "failure",
      failureCode: verdict.errorCode,
      failureMessage: verdict.errorMessage,
      sourceIp: clientIp(req),
      userAgent: req.headers["user-agent"] ?? null,
    });
    res
      .status(401)
      .json(err(verdict.errorCode ?? "SAML_INVALID", verdict.errorMessage ?? "SAML validation failed"));
    return;
  }
  const attrs = verdict.attributes;
  if (!attrs.email) {
    await recordLoginEvent(ctx, {
      protocol: "saml",
      outcome: "failure",
      failureCode: "NO_EMAIL",
      sourceIp: clientIp(req),
    });
    res.status(400).json(err("NO_EMAIL", "Assertion did not include an email attribute"));
    return;
  }
  let seat;
  if (cfg.jitProvisioning) {
    seat = await jitProvisionSeat(ctx, "sso:saml", {
      protocol: "saml",
      email: attrs.email,
      displayName: attrs.displayName,
      groups: attrs.groups,
      subject: attrs.nameId,
    });
  } else {
    res.status(403).json(err("JIT_DISABLED", "JIT provisioning disabled and user not provisioned"));
    return;
  }
  // Bind the OP session
  const expiresAtMs = attrs.notOnOrAfter ?? Date.now() + cfg.sessionTimeoutMinutes * 60_000;
  await createSsoSession(ctx, {
    userId: seat.seatId,
    sessionId: state.id,
    idpSubject: attrs.nameId,
    idpSessionIndex: attrs.sessionIndex,
    expiresAtMs,
  });
  state.user = { seatId: seat.seatId, email: seat.email, role: seat.role, protocol: "saml" };
  await recordLoginEvent(ctx, {
    protocol: "saml",
    outcome: "success",
    subject: attrs.nameId,
    email: attrs.email,
    sourceIp: clientIp(req),
    userAgent: req.headers["user-agent"] ?? null,
  });
  res.json(
    ok({
      seatId: seat.seatId,
      email: seat.email,
      role: seat.role,
      created: seat.created,
      relayState: state.sso?.saml?.relayState ?? null,
    }),
  );
});

router.post("/saml/slo", authLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Accept SAMLRequest (IdP-initiated) or SAMLResponse (SP-initiated reply).
  const sessionIndex = typeof body["SessionIndex"] === "string" ? body["SessionIndex"] : null;
  const nameId = typeof body["NameID"] === "string" ? body["NameID"] : null;
  const sessions = await findSessionsForSlo(ctx, {
    idpSessionIndex: sessionIndex,
    idpSubject: nameId,
  });
  for (const s of sessions) await terminateSsoSession(ctx, s.id);
  const sessAny = sess(req);
  sessAny.destroy(() => {
    res.json(ok({ terminated: sessions.length }));
  });
});

router.get("/saml/slo/initiate", requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cfg = await getSsoConfig(ctx);
  const state = sess(req);
  if (!cfg?.saml.sloUrl || !state.user) {
    res.status(400).json(err("SLO_UNAVAILABLE", "No active SAML session or SLO URL not set"));
    return;
  }
  const url = buildSamlSloRedirect({
    spEntityId: `${spBaseUrl(req)}/saml/metadata`,
    idpSloUrl: cfg.saml.sloUrl,
    nameId: state.user.email,
    sessionIndex: null,
  });
  res.redirect(302, url);
});

// ─────────── OIDC ─────────────────────────────────────────────────────────

router.get("/oidc/login", authLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cfg = await getSsoConfig(ctx);
  if (!cfg || cfg.protocol !== "oidc" || !cfg.oidc.issuer || !cfg.oidc.clientId) {
    res.status(400).json(err("SSO_NOT_CONFIGURED", "OIDC SSO is not configured for this tenant"));
    return;
  }
  const { doc, error } = await discover(cfg.oidc.issuer);
  if (!doc) {
    res.status(502).json(err("DISCOVERY_FAILED", error ?? "OIDC discovery failed"));
    return;
  }
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const pk = pkcePair();
  const session = sess(req);
  session.sso = session.sso ?? {};
  session.sso.oidc = { state, nonce, verifier: pk.verifier };
  const url = buildAuthorizationUrl({
    doc,
    clientId: cfg.oidc.clientId,
    redirectUri: `${spBaseUrl(req)}/oidc/callback`,
    state,
    nonce,
    challenge: pk.challenge,
  });
  res.redirect(302, url);
});

router.get("/oidc/callback", authLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const cfg = await getSsoConfig(ctx);
  if (!cfg || cfg.protocol !== "oidc" || !cfg.oidc.issuer || !cfg.oidc.clientId) {
    res.status(400).json(err("SSO_NOT_CONFIGURED", "OIDC SSO not configured"));
    return;
  }
  const { code, state } = req.query as { code?: string; state?: string };
  const session = sess(req);
  const expected = session.sso?.oidc;
  if (!code || !state || !expected || expected.state !== state) {
    res.status(400).json(err("INVALID_STATE", "OIDC state mismatch or missing code"));
    return;
  }
  const { doc } = await discover(cfg.oidc.issuer);
  if (!doc) {
    res.status(502).json(err("DISCOVERY_FAILED", "OIDC discovery failed"));
    return;
  }
  // Token exchange — read the raw client secret via a service helper so
  // it never appears on the public config-read response.
  const fullCfg = await getOidcClientSecret(ctx);
  if (!fullCfg) {
    res.status(500).json(err("MISSING_SECRET", "OIDC client secret not configured"));
    return;
  }
  const { tokens, error: tokErr } = await exchangeCode({
    doc,
    clientId: cfg.oidc.clientId,
    clientSecret: fullCfg,
    redirectUri: `${spBaseUrl(req)}/oidc/callback`,
    code,
    verifier: expected.verifier,
  });
  if (!tokens?.id_token) {
    await recordLoginEvent(ctx, {
      protocol: "oidc",
      outcome: "failure",
      failureCode: "TOKEN_EXCHANGE",
      failureMessage: tokErr,
      sourceIp: clientIp(req),
    });
    res.status(401).json(err("TOKEN_EXCHANGE", tokErr ?? "Token exchange failed"));
    return;
  }
  const verdict = await validateIdToken({
    idToken: tokens.id_token,
    doc,
    clientId: cfg.oidc.clientId,
    expectedNonce: expected.nonce,
  });
  if (!verdict.valid || !verdict.attributes) {
    await recordLoginEvent(ctx, {
      protocol: "oidc",
      outcome: "failure",
      failureCode: verdict.errorCode,
      failureMessage: verdict.errorMessage,
      sourceIp: clientIp(req),
    });
    res
      .status(401)
      .json(err(verdict.errorCode ?? "OIDC_INVALID", verdict.errorMessage ?? "id_token invalid"));
    return;
  }
  const attrs = verdict.attributes;
  if (!attrs.email) {
    res.status(400).json(err("NO_EMAIL", "id_token did not contain an email claim"));
    return;
  }
  const seat = await jitProvisionSeat(ctx, "sso:oidc", {
    protocol: "oidc",
    email: attrs.email,
    displayName: attrs.displayName,
    groups: attrs.groups,
    subject: attrs.subject,
  });
  const expiresAtMs = attrs.expiresAt ?? Date.now() + cfg.sessionTimeoutMinutes * 60_000;
  await createSsoSession(ctx, {
    userId: seat.seatId,
    sessionId: session.id,
    idpSubject: attrs.subject,
    idpSessionIndex: attrs.sid,
    expiresAtMs,
  });
  session.user = { seatId: seat.seatId, email: seat.email, role: seat.role, protocol: "oidc" };
  await recordLoginEvent(ctx, {
    protocol: "oidc",
    outcome: "success",
    subject: attrs.subject,
    email: attrs.email,
    sourceIp: clientIp(req),
    userAgent: req.headers["user-agent"] ?? null,
  });
  res.json(ok({ seatId: seat.seatId, email: seat.email, role: seat.role, created: seat.created }));
});

router.post("/oidc/logout", requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const session = sess(req);
  if (session.user) {
    const sessions = await findSessionsForSlo(ctx, { idpSubject: session.user.email });
    for (const s of sessions) await terminateSsoSession(ctx, s.id);
  }
  session.destroy(() => res.json(ok({ loggedOut: true })));
});

// ─────────── Break-glass ─────────────────────────────────────────────────

router.post("/break-glass/login", authLimiter, requireTenant(), async (req, res) => {
  const ctx = requireTenantContext();
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body["email"] !== "string" || typeof body["passphrase"] !== "string") {
    res.status(400).json(err("INVALID_BODY", "email and passphrase required"));
    return;
  }
  const verdict = await verifyBreakGlass(ctx, {
    email: body["email"],
    passphrase: body["passphrase"],
    ...(clientIp(req) !== null ? { sourceIp: clientIp(req)! } : {}),
    ...(req.headers["user-agent"] ? { userAgent: String(req.headers["user-agent"]) } : {}),
  });
  if (!verdict.ok) {
    res.status(401).json(err(verdict.reason ?? "AUTH_FAILED", "Break-glass authentication failed"));
    return;
  }
  const session = sess(req);
  session.user = {
    seatId: "break_glass",
    email: body["email"],
    role: "admin",
    protocol: "break_glass",
  };
  res.json(ok({ loggedIn: true, role: "admin" }));
});

export default router;
