/**
 * electron-builder Windows `sign` hook — drives signtool with the EV
 * (Extended Validation) certificate stored on the CI signing host.
 *
 * EV certificates live on a FIPS-140 hardware token (USB or HSM) and the
 * private key is non-exportable. We invoke signtool with the certificate
 * thumbprint so it picks the cert out of the Windows cert store; the
 * token PIN is supplied by the CI secret manager via the
 * `OMNINITY_EV_TOKEN_PIN` env var, NOT written to disk.
 *
 * EV is mandatory: standard OV (Organization Validation) certificates do
 * not get instant SmartScreen reputation, and an unsigned-or-OV-signed
 * installer is blocked by Microsoft Defender SmartScreen with a red
 * "Windows protected your PC" dialog that stops virtually all installs.
 *
 * Required env (CI secret manager):
 *   OMNINITY_EV_CERT_THUMBPRINT   — SHA-1 thumbprint of the EV cert
 *   OMNINITY_EV_TOKEN_PIN         — PIN for the hardware token
 *   OMNINITY_EV_TIMESTAMP_URL     — RFC-3161 timestamp authority
 */
const { execFileSync } = require("node:child_process");

exports.default = async function sign(configuration) {
  const thumb = process.env.OMNINITY_EV_CERT_THUMBPRINT;
  if (!thumb) {
    const msg = "[sign-windows] OMNINITY_EV_CERT_THUMBPRINT not set";
    if (process.env.OMNINITY_REQUIRE_EV_SIGN === "1") throw new Error(msg);
    console.warn(`${msg} — skipping (dev mode)`);
    return;
  }
  const ts = process.env.OMNINITY_EV_TIMESTAMP_URL || "http://timestamp.digicert.com";
  const args = [
    "sign",
    "/sha1", thumb,
    "/fd", "sha256",
    "/td", "sha256",
    "/tr", ts,
    "/d", "Omninity Operator",
    "/du", "https://omninity.example",
    configuration.path,
  ];
  // `signtool` reads the token PIN from the OMNINITY_EV_TOKEN_PIN env var
  // through a credential provider configured on the signing host. Never
  // log the value or include it in argv.
  execFileSync("signtool", args, { stdio: "inherit" });
  console.log(`[sign-windows] Signed: ${configuration.path}`);
};
