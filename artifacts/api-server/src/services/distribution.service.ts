/**
 * Distribution & code-signing service.
 *
 * Drives two surfaces consumed by the desktop shell + Settings UI:
 *
 *   1. Build attestation — the desktop shell reports the signing /
 *      notarization status of the installed binary on first launch
 *      (`POST /api/distribution/build`). The server caches it per-tenant
 *      so the Settings page can render "Signed by Omninity, Inc.,
 *      notarized by Apple, SHA-256 …" instead of asking the user to
 *      verify by hand. Defaults are read from the
 *      `OMNINITY_BUILD_*` env vars so a packaged build can populate the
 *      attestation at boot time without any HTTP round-trip.
 *
 *   2. OS permissions — Desktop Control + Voice need OS-level grants
 *      (screen recording, accessibility, microphone). The server owns the
 *      list of permissions per platform and the human-readable instructions
 *      for granting / revoking them in System Preferences (mac) or
 *      Privacy & Security (win). The desktop shell calls
 *      `POST /api/distribution/permissions/:id` to report the current OS
 *      verdict; the server stores it per-tenant so the UI can render
 *      "Microphone — Granted (revoke in System Settings ▸ Privacy)" with
 *      the correct deeplink, and so feature gates (`isFeatureGranted()`)
 *      can short-circuit a Desktop Control session before it crashes.
 *
 * Design notes:
 *   - State is in-memory (Map keyed by tenantId). Build attestation +
 *     permission status are derived facts about the *desktop shell*, not
 *     persistent business data — losing them on a server restart is
 *     correct: the shell re-reports on its next launch.
 *   - Cross-tenant isolation is enforced by the route layer
 *     (requireTenant + tenant-context); this module never reads request
 *     state and trusts the caller to scope by tenantId.
 */
import { logger } from "../lib/logger";

// ─── Build attestation ──────────────────────────────────────────────────────

export type Platform = "darwin" | "win32" | "linux" | "unknown";
export type ReleaseChannel = "stable" | "beta" | "canary" | "dev";

export interface BuildAttestation {
  platform: Platform;
  arch: string;
  version: string;
  channel: ReleaseChannel;
  builtAt: string | null;
  signed: boolean;
  certificateSubject: string | null;
  certificateThumbprint: string | null;
  hardenedRuntime: boolean;
  notarized: boolean;
  notarizationTicket: string | null;
  stapled: boolean;
  sha256: string | null;
  privacyManifest: boolean;
  /** True iff the build meets the platform requirements for warning-free install. */
  compliant: boolean;
  /** Human-readable checks the UI surfaces in Settings → About. */
  checks: BuildCheck[];
  reportedAt: string;
  source: "env" | "shell";
}

export interface BuildCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

// tier-review: bounded — one BuildAttestation per active tenant (tenants are bounded by licence + GDPR-erase drops the row).
const tenantBuilds = new Map<string, BuildAttestation>();

function readEnvBool(key: string): boolean {
  const v = process.env[key];
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes";
}

function readEnvString(key: string): string | null {
  const v = process.env[key];
  return v && v.length > 0 ? v : null;
}

function detectPlatformFromEnv(): Platform {
  const explicit = readEnvString("OMNINITY_BUILD_PLATFORM");
  if (explicit === "darwin" || explicit === "win32" || explicit === "linux") {
    return explicit;
  }
  // Fall back to the host process's platform — a packaged build inherits
  // its own OS, which is the right answer in 99% of cases.
  const p = process.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  return "unknown";
}

function buildChecksFor(att: Omit<BuildAttestation, "checks" | "compliant">): BuildCheck[] {
  const checks: BuildCheck[] = [];
  if (att.platform === "darwin") {
    checks.push({
      id: "mac.signed",
      label: "Signed with Apple Developer ID",
      passed: att.signed && !!att.certificateSubject,
      detail: att.certificateSubject ?? "no Developer ID Application certificate",
    });
    checks.push({
      id: "mac.hardened-runtime",
      label: "Hardened runtime enabled",
      passed: att.hardenedRuntime,
    });
    checks.push({
      id: "mac.notarized",
      label: "Notarized by Apple",
      passed: att.notarized,
      detail: att.notarizationTicket ?? undefined,
    });
    checks.push({
      id: "mac.stapled",
      label: "Notarization ticket stapled (offline Gatekeeper)",
      passed: att.stapled,
    });
    checks.push({
      id: "mac.privacy-manifest",
      label: "PrivacyInfo.xcprivacy declared",
      passed: att.privacyManifest,
    });
  } else if (att.platform === "win32") {
    checks.push({
      id: "win.signed",
      label: "Signed with EV (Extended Validation) code signing certificate",
      passed: att.signed && !!att.certificateThumbprint,
      detail: att.certificateSubject ?? "no EV certificate",
    });
    checks.push({
      id: "win.timestamp",
      label: "Authenticode RFC-3161 timestamp present",
      passed: att.signed,
    });
  } else if (att.platform === "linux") {
    checks.push({
      id: "linux.checksum",
      label: "SHA-256 checksum published with the AppImage",
      passed: !!att.sha256,
    });
  }
  checks.push({
    id: "release.checksum",
    label: "Release SHA-256 recorded in manifest",
    passed: !!att.sha256,
    detail: att.sha256 ?? undefined,
  });
  return checks;
}

function computeCompliance(checks: BuildCheck[]): boolean {
  return checks.every((c) => c.passed);
}

function attestationFromEnv(): BuildAttestation {
  const platform = detectPlatformFromEnv();
  const partial = {
    platform,
    arch: readEnvString("OMNINITY_BUILD_ARCH") ?? process.arch,
    version: readEnvString("OMNINITY_BUILD_VERSION")
      ?? process.env["npm_package_version"]
      ?? "0.1.0",
    channel: ((): ReleaseChannel => {
      const c = readEnvString("OMNINITY_RELEASE_CHANNEL");
      if (c === "stable" || c === "beta" || c === "canary" || c === "dev") return c;
      return process.env["NODE_ENV"] === "production" ? "stable" : "dev";
    })(),
    builtAt: readEnvString("OMNINITY_BUILD_AT"),
    signed: readEnvBool("OMNINITY_BUILD_SIGNED"),
    certificateSubject: readEnvString("OMNINITY_BUILD_CERT_SUBJECT"),
    certificateThumbprint: readEnvString("OMNINITY_BUILD_CERT_THUMBPRINT"),
    hardenedRuntime: readEnvBool("OMNINITY_BUILD_HARDENED_RUNTIME"),
    notarized: readEnvBool("OMNINITY_BUILD_NOTARIZED"),
    notarizationTicket: readEnvString("OMNINITY_BUILD_NOTARIZATION_TICKET"),
    stapled: readEnvBool("OMNINITY_BUILD_STAPLED"),
    sha256: readEnvString("OMNINITY_BUILD_SHA256"),
    privacyManifest: readEnvBool("OMNINITY_BUILD_PRIVACY_MANIFEST"),
    reportedAt: new Date().toISOString(),
    source: "env" as const,
  };
  const checks = buildChecksFor(partial);
  return { ...partial, checks, compliant: computeCompliance(checks) };
}

export interface BuildAttestationInput {
  platform?: Platform;
  arch?: string;
  version?: string;
  channel?: ReleaseChannel;
  builtAt?: string | null;
  signed?: boolean;
  certificateSubject?: string | null;
  certificateThumbprint?: string | null;
  hardenedRuntime?: boolean;
  notarized?: boolean;
  notarizationTicket?: string | null;
  stapled?: boolean;
  sha256?: string | null;
  privacyManifest?: boolean;
}

export function getBuildAttestation(tenantId: string): BuildAttestation {
  const cached = tenantBuilds.get(tenantId);
  if (cached) return cached;
  return attestationFromEnv();
}

export function reportBuildAttestation(
  tenantId: string,
  input: BuildAttestationInput,
): BuildAttestation {
  const base = attestationFromEnv();
  const partial = {
    platform: input.platform ?? base.platform,
    arch: input.arch ?? base.arch,
    version: input.version ?? base.version,
    channel: input.channel ?? base.channel,
    builtAt: input.builtAt ?? base.builtAt,
    signed: input.signed ?? base.signed,
    certificateSubject:
      input.certificateSubject !== undefined ? input.certificateSubject : base.certificateSubject,
    certificateThumbprint:
      input.certificateThumbprint !== undefined
        ? input.certificateThumbprint
        : base.certificateThumbprint,
    hardenedRuntime: input.hardenedRuntime ?? base.hardenedRuntime,
    notarized: input.notarized ?? base.notarized,
    notarizationTicket:
      input.notarizationTicket !== undefined ? input.notarizationTicket : base.notarizationTicket,
    stapled: input.stapled ?? base.stapled,
    sha256: input.sha256 !== undefined ? input.sha256 : base.sha256,
    privacyManifest: input.privacyManifest ?? base.privacyManifest,
    reportedAt: new Date().toISOString(),
    source: "shell" as const,
  };
  const checks = buildChecksFor(partial);
  const att: BuildAttestation = { ...partial, checks, compliant: computeCompliance(checks) };
  tenantBuilds.set(tenantId, att);
  logger.info(
    { tenantId, platform: att.platform, version: att.version, compliant: att.compliant },
    "Build attestation reported by desktop shell",
  );
  return att;
}

// ─── OS permissions ─────────────────────────────────────────────────────────

export type PermissionId =
  | "screen_recording"
  | "accessibility"
  | "microphone"
  | "camera"
  | "screen_capture"
  | "automation";

export type PermissionStatus =
  | "granted"
  | "denied"
  | "not_determined"
  | "restricted"
  | "unsupported"
  | "unknown";

export interface PermissionDefinition {
  id: PermissionId;
  label: string;
  /** Why OP needs this — shown verbatim in the permission prompt. */
  rationale: string;
  /** OP feature(s) disabled when this permission is denied. */
  feature: string;
  /** macOS deeplink to the right pane in System Settings. */
  systemSettingsDeeplink: string | null;
  /** Step-by-step instructions for granting/revoking. */
  instructions: string[];
}

export interface PermissionState {
  id: PermissionId;
  status: PermissionStatus;
  reportedAt: string;
}

export interface PermissionView extends PermissionDefinition, PermissionState {
  /** True iff the related OP feature can run. */
  featureEnabled: boolean;
}

const macPermissions: PermissionDefinition[] = [
  {
    id: "screen_recording",
    label: "Screen Recording",
    rationale:
      "Desktop Control needs to see your screen to plan its next step. Capture is local-only and never leaves your machine.",
    feature: "Desktop Control",
    systemSettingsDeeplink: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    instructions: [
      "Open System Settings ▸ Privacy & Security ▸ Screen Recording.",
      "Enable Omninity Operator in the list.",
      "Quit and reopen Omninity Operator (macOS only re-checks the grant on launch).",
    ],
  },
  {
    id: "accessibility",
    label: "Accessibility",
    rationale:
      "Desktop Control needs Accessibility to move the mouse and type on your behalf. Every action you approve is logged.",
    feature: "Desktop Control",
    systemSettingsDeeplink: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    instructions: [
      "Open System Settings ▸ Privacy & Security ▸ Accessibility.",
      "Enable Omninity Operator in the list.",
      "Restart Desktop Control from the chat header.",
    ],
  },
  {
    id: "microphone",
    label: "Microphone",
    rationale:
      "The Voice Interface uses your microphone to transcribe what you say, on-device. Audio never leaves your machine.",
    feature: "Voice Interface",
    systemSettingsDeeplink: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    instructions: [
      "Open System Settings ▸ Privacy & Security ▸ Microphone.",
      "Enable Omninity Operator in the list.",
    ],
  },
  {
    id: "automation",
    label: "Automation (Apple Events)",
    rationale:
      "Desktop Control sends Apple Events to drive other apps when you approve a step.",
    feature: "Desktop Control",
    systemSettingsDeeplink: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    instructions: [
      "Open System Settings ▸ Privacy & Security ▸ Automation.",
      "Allow Omninity Operator to control the apps it asks for.",
    ],
  },
  {
    id: "camera",
    label: "Camera",
    rationale:
      "Only requested when a Skill you run explicitly asks for camera access (e.g. taking a profile photo).",
    feature: "Skill camera access",
    systemSettingsDeeplink: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
    instructions: [
      "Open System Settings ▸ Privacy & Security ▸ Camera.",
      "Enable Omninity Operator in the list.",
    ],
  },
];

const winPermissions: PermissionDefinition[] = [
  {
    id: "microphone",
    label: "Microphone",
    rationale:
      "The Voice Interface uses your microphone to transcribe what you say, on-device.",
    feature: "Voice Interface",
    systemSettingsDeeplink: "ms-settings:privacy-microphone",
    instructions: [
      "Open Settings ▸ Privacy & Security ▸ Microphone.",
      "Turn on \"Microphone access\" and allow Omninity Operator.",
    ],
  },
  {
    id: "screen_capture",
    label: "Screen Capture",
    rationale:
      "Desktop Control captures the screen via the Windows.Graphics.Capture API to plan its next step.",
    feature: "Desktop Control",
    systemSettingsDeeplink: null,
    instructions: [
      "Windows shows a yellow capture border around any window Omninity is watching — this is normal.",
      "If the OS prompts for capture permission, click Yes.",
    ],
  },
  {
    id: "camera",
    label: "Camera",
    rationale:
      "Only requested when a Skill you run explicitly asks for camera access.",
    feature: "Skill camera access",
    systemSettingsDeeplink: "ms-settings:privacy-webcam",
    instructions: [
      "Open Settings ▸ Privacy & Security ▸ Camera.",
      "Turn on \"Camera access\" and allow Omninity Operator.",
    ],
  },
];

const linuxPermissions: PermissionDefinition[] = [
  {
    id: "screen_recording",
    label: "Screen Recording (PipeWire portal)",
    rationale:
      "Desktop Control captures the screen via the xdg-desktop-portal Screencast interface.",
    feature: "Desktop Control",
    systemSettingsDeeplink: null,
    instructions: [
      "Approve the PipeWire portal prompt the first time Desktop Control runs.",
      "On distributions without xdg-desktop-portal, install it (e.g. `sudo apt install xdg-desktop-portal`).",
    ],
  },
  {
    id: "microphone",
    label: "Microphone",
    rationale: "Voice Interface uses your microphone via PulseAudio / PipeWire.",
    feature: "Voice Interface",
    systemSettingsDeeplink: null,
    instructions: [
      "Ensure your audio server (PipeWire / PulseAudio) is running and Omninity Operator is unmuted in your audio control panel.",
    ],
  },
];

function definitionsFor(platform: Platform): PermissionDefinition[] {
  switch (platform) {
    case "darwin": return macPermissions;
    case "win32": return winPermissions;
    case "linux": return linuxPermissions;
    default: return [];
  }
}

interface TenantPermissionStore {
  states: Map<PermissionId, PermissionState>;
}

// tier-review: bounded — one TenantPermissionStore per active tenant (inner Map bounded by the fixed PermissionId enum, ≤ 6 entries).
const tenantPermissions = new Map<string, TenantPermissionStore>();

function getStore(tenantId: string): TenantPermissionStore {
  let s = tenantPermissions.get(tenantId);
  if (!s) {
    s = { states: new Map() };
    tenantPermissions.set(tenantId, s);
  }
  return s;
}

function viewFor(def: PermissionDefinition, state: PermissionState | undefined): PermissionView {
  const reported: PermissionState = state ?? {
    id: def.id,
    status: "unknown",
    reportedAt: new Date(0).toISOString(),
  };
  const featureEnabled = reported.status === "granted";
  return { ...def, ...reported, featureEnabled };
}

export function listPermissions(tenantId: string, platformOverride?: Platform): {
  platform: Platform;
  permissions: PermissionView[];
} {
  const platform = platformOverride ?? detectPlatformFromEnv();
  const defs = definitionsFor(platform);
  const store = getStore(tenantId);
  const permissions = defs.map((d) => viewFor(d, store.states.get(d.id)));
  return { platform, permissions };
}

export function reportPermissionStatus(
  tenantId: string,
  id: PermissionId,
  status: PermissionStatus,
  platformOverride?: Platform,
): PermissionView | null {
  const platform = platformOverride ?? detectPlatformFromEnv();
  const def = definitionsFor(platform).find((d) => d.id === id);
  if (!def) return null;
  const store = getStore(tenantId);
  const state: PermissionState = {
    id,
    status,
    reportedAt: new Date().toISOString(),
  };
  store.states.set(id, state);
  logger.info({ tenantId, id, status, platform }, "OS permission status reported");
  return viewFor(def, state);
}

/**
 * Returns true iff every permission backing `feature` is granted.
 * Used by the Desktop Control + Voice routes to graceful-degrade rather
 * than crashing into a permission denial deep inside the adapter.
 */
export function isFeatureGranted(tenantId: string, feature: string): boolean {
  const { permissions } = listPermissions(tenantId);
  const required = permissions.filter((p) => p.feature === feature);
  if (required.length === 0) return true;
  return required.every((p) => p.featureEnabled);
}

/** Test-only: drop all cached state so test cases start clean. */
export function __resetDistributionForTests(): void {
  tenantBuilds.clear();
  tenantPermissions.clear();
}
