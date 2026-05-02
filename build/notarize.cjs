/**
 * electron-builder afterSign hook — submits the signed .app bundle to
 * Apple notarytool, waits for the verdict, and staples the ticket so the
 * .dmg works offline (Gatekeeper does not need to phone home on first
 * launch). Without this hook, macOS shows a scary "cannot verify the
 * developer" dialog that stops most users from installing.
 *
 * Required env (CI secret manager — NEVER on disk):
 *   APPLE_ID                 — Apple ID email tied to the Developer Team
 *   APPLE_APP_SPECIFIC_PASSWORD — app-specific password for the Apple ID
 *   APPLE_TEAM_ID            — 10-character Team ID
 *   APPLE_DEVELOPER_ID_APPLICATION — full identity string from the keychain
 *
 * The hook is intentionally tolerant in dev: if the env vars are missing
 * we skip notarization with a loud warning. CI sets `OMNINITY_REQUIRE_NOTARIZE=1`
 * which turns that warning into a hard failure.
 */
const path = require("node:path");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const required = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    const msg = `[notarize] Skipping — missing env: ${missing.join(", ")}`;
    if (process.env.OMNINITY_REQUIRE_NOTARIZE === "1") {
      throw new Error(msg);
    }
    console.warn(msg);
    return;
  }

  const { notarize } = await import("@electron/notarize");
  console.log(`[notarize] Submitting ${appPath} to Apple notarytool…`);
  await notarize({
    tool: "notarytool",
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log(`[notarize] Notarized + stapled: ${appPath}`);
};
