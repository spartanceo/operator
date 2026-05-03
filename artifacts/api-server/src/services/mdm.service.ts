/**
 * Enterprise MDM & silent-deployment service (Task #56).
 *
 * IT departments deploy Omninity Operator at scale via Mobile Device
 * Management platforms — Jamf Pro on macOS (.pkg + .mobileconfig) and
 * Microsoft Intune / SCCM on Windows (.msi + Group Policy / Registry).
 * This service owns four surfaces consumed by the desktop shell, the
 * Settings UI, and the Enterprise Admin portal:
 *
 *   1. Configuration schema (`CONFIG_FIELDS`) — the canonical contract.
 *      Every key, its type, default, whether it is admin-lockable, and
 *      a one-line description IT can paste into their change-control
 *      tickets. The schema is the source of truth for both
 *      `.mobileconfig` and Windows Registry / GPO ADMX generation.
 *
 *   2. Per-tenant MDM profile — exactly one row in `mdm_profiles` per
 *      organisation. The desktop shell reports the profile it read from
 *      the OS at launch (`PUT /mdm/profile`) and the Enterprise Admin
 *      portal can also manage it directly. The profile carries the
 *      organisation name, the JSON-encoded settings bundle, and the
 *      list of admin-locked keys that the local user MUST NOT be able
 *      to override in Settings.
 *
 *   3. Profile generators — `.mobileconfig` (Apple plist), `.reg`
 *      (Windows Registry import), and ADMX (Group Policy template) are
 *      produced deterministically from the active profile so IT can
 *      download a ready-to-deploy artifact straight from the portal
 *      without copy-pasting GUIDs by hand.
 *
 *   4. Fleet beacons (`mdm_fleet_devices`) — every managed install
 *      POSTs a tiny status beacon at launch and every 4 hours. The
 *      Enterprise Admin portal joins this table to render the deployment
 *      health board (count, version distribution, last-seen ages).
 *
 * Storage:
 *   Persistent SQLite (Drizzle) via `tenantScope` — the cross-tenant
 *   isolation invariant is enforced by the helper, never by hand.
 *
 *   Profile generators are pure functions of the profile row plus the
 *   schema; nothing about them touches the database after the fetch, so
 *   they are safe to call from a download handler that streams a file.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import {
  buildPage,
  db,
  decodeCursor,
  mdmFleetDevices,
  mdmProfiles,
  normaliseLimit,
  type PaginatedData,
  tenantScope,
  withTenantValues,
} from "@workspace/db";
import type { TenantContext } from "@workspace/types";

import { logger } from "../lib/logger";

// ─── Configuration schema ────────────────────────────────────────────────────

export type ConfigKind =
  | "string"
  | "url"
  | "boolean"
  | "string-list"
  | "enum";

export interface ConfigFieldDef {
  /** Stable key — used in JSON, Registry, and PayloadContent dictionaries. */
  key: string;
  kind: ConfigKind;
  label: string;
  description: string;
  /** Default applied when the profile omits the field. */
  defaultValue: string | boolean | string[] | null;
  /** Whether IT can set this field as read-only ("admin-locked"). */
  lockable: boolean;
  /** Allowed values for `enum` kind; ignored otherwise. */
  options?: string[];
  /** Plist key under PayloadContent[0] for the Apple .mobileconfig generator. */
  plistKey?: string;
  /** Windows Registry value name under HKLM\SOFTWARE\Omninity\Operator. */
  registryName?: string;
}

const CONFIG_FIELDS: readonly ConfigFieldDef[] = [
  {
    key: "organisationName",
    kind: "string",
    label: "Organisation name",
    description:
      "Human-readable organisation name shown in Settings as 'Managed by …'.",
    defaultValue: "",
    lockable: true,
    plistKey: "OrganisationName",
    registryName: "OrganisationName",
  },
  {
    key: "enterpriseAdminUrl",
    kind: "url",
    label: "Enterprise Admin portal URL",
    description:
      "Base URL of the Enterprise Admin portal where this install reports beacons and fetches policy.",
    defaultValue: "",
    lockable: true,
    plistKey: "EnterpriseAdminUrl",
    registryName: "EnterpriseAdminUrl",
  },
  {
    key: "ssoProvider",
    kind: "enum",
    label: "SSO provider",
    description:
      "Identity provider users authenticate against on first launch.",
    defaultValue: "none",
    lockable: true,
    options: ["none", "google", "microsoft", "okta", "saml"],
    plistKey: "SSOProvider",
    registryName: "SSOProvider",
  },
  {
    key: "approvedSkillIds",
    kind: "string-list",
    label: "Approved skill whitelist",
    description:
      "List of skill ids the organisation has approved. Empty means unrestricted.",
    defaultValue: [],
    lockable: true,
    plistKey: "ApprovedSkillIds",
    registryName: "ApprovedSkillIds",
  },
  {
    key: "airGapMode",
    kind: "boolean",
    label: "Air-gap mode",
    description:
      "Disable every outbound network call beyond the Enterprise Admin portal.",
    defaultValue: false,
    lockable: true,
    plistKey: "AirGapMode",
    registryName: "AirGapMode",
  },
  {
    key: "disabledFeatures",
    kind: "string-list",
    label: "Disabled features",
    description:
      "Feature ids the organisation has disabled (e.g. 'voice', 'desktop-control', 'marketplace').",
    defaultValue: [],
    lockable: true,
    plistKey: "DisabledFeatures",
    registryName: "DisabledFeatures",
  },
  {
    key: "allowAutoUpdate",
    kind: "boolean",
    label: "Allow automatic updates",
    description:
      "When false, the desktop auto-updater is disabled — IT controls rollouts via MDM.",
    defaultValue: true,
    lockable: true,
    plistKey: "AllowAutoUpdate",
    registryName: "AllowAutoUpdate",
  },
  {
    key: "telemetryOptOut",
    kind: "boolean",
    label: "Force telemetry opt-out",
    description:
      "When true, telemetry consent is forced off and cannot be re-enabled by the user.",
    defaultValue: false,
    lockable: true,
    plistKey: "TelemetryOptOut",
    registryName: "TelemetryOptOut",
  },
];

// tier-review: bounded — index built from the fixed-size CONFIG_FIELDS array literal
const CONFIG_INDEX: Map<string, ConfigFieldDef> = new Map(
  CONFIG_FIELDS.map((f) => [f.key, f]),
);

export function listConfigSchema(): readonly ConfigFieldDef[] {
  return CONFIG_FIELDS;
}

// ─── Profile types ───────────────────────────────────────────────────────────

export type MdmSource = "manual" | "jamf" | "intune" | "gpo" | "sccm";

export type ConfigValue = string | boolean | string[] | null;

export interface MdmProfileView {
  id: string;
  source: MdmSource;
  organisationName: string;
  profileVersion: number;
  values: Record<string, ConfigValue>;
  lockedKeys: string[];
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProfileInput {
  source?: MdmSource;
  organisationName: string;
  profileVersion?: number;
  values: Record<string, unknown>;
  lockedKeys?: string[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

function coerceValue(field: ConfigFieldDef, raw: unknown): ConfigValue {
  switch (field.kind) {
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === 1) return true;
      if (raw === "false" || raw === 0) return false;
      throw new MdmValidationError(
        `${field.key}: expected boolean, got ${typeof raw}`,
      );
    case "string":
    case "url": {
      if (raw === null || raw === undefined) return "";
      if (typeof raw !== "string") {
        throw new MdmValidationError(
          `${field.key}: expected string, got ${typeof raw}`,
        );
      }
      if (field.kind === "url" && raw.length > 0) {
        try {
          // URL constructor throws on invalid input.
          new URL(raw);
        } catch {
          throw new MdmValidationError(
            `${field.key}: expected absolute URL`,
          );
        }
      }
      if (raw.length > 2048) {
        throw new MdmValidationError(`${field.key}: value exceeds 2048 chars`);
      }
      return raw;
    }
    case "enum": {
      if (typeof raw !== "string") {
        throw new MdmValidationError(
          `${field.key}: expected enum string, got ${typeof raw}`,
        );
      }
      if (!field.options?.includes(raw)) {
        throw new MdmValidationError(
          `${field.key}: '${raw}' not in ${JSON.stringify(field.options)}`,
        );
      }
      return raw;
    }
    case "string-list": {
      if (!Array.isArray(raw)) {
        throw new MdmValidationError(
          `${field.key}: expected array of strings`,
        );
      }
      if (raw.length > 512) {
        throw new MdmValidationError(
          `${field.key}: list exceeds 512 entries`,
        );
      }
      const out: string[] = [];
      for (const v of raw) {
        if (typeof v !== "string" || v.length === 0 || v.length > 256) {
          throw new MdmValidationError(
            `${field.key}: every list entry must be a 1..256-char string`,
          );
        }
        out.push(v);
      }
      return out;
    }
  }
}

export class MdmValidationError extends Error {
  readonly code = "MDM_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "MdmValidationError";
  }
}

function normaliseValues(input: Record<string, unknown>): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(input)) {
    const def = CONFIG_INDEX.get(k);
    if (!def) {
      throw new MdmValidationError(`Unknown configuration key '${k}'`);
    }
    out[k] = coerceValue(def, v);
  }
  return out;
}

function normaliseLockedKeys(keys: readonly string[] | undefined): string[] {
  if (!keys || keys.length === 0) return [];
  const seen = new Set<string>();
  for (const k of keys) {
    const def = CONFIG_INDEX.get(k);
    if (!def) {
      throw new MdmValidationError(`Cannot lock unknown key '${k}'`);
    }
    if (!def.lockable) {
      throw new MdmValidationError(`Key '${k}' is not admin-lockable`);
    }
    seen.add(k);
  }
  return Array.from(seen).sort();
}

// ─── Storage helpers ─────────────────────────────────────────────────────────

function rowToView(
  row: typeof mdmProfiles.$inferSelect,
): MdmProfileView {
  let parsedValues: Record<string, ConfigValue>;
  try {
    parsedValues = JSON.parse(row.valuesJson) as Record<string, ConfigValue>;
  } catch {
    parsedValues = {};
  }
  let lockedKeys: string[];
  try {
    lockedKeys = JSON.parse(row.lockedKeysJson) as string[];
  } catch {
    lockedKeys = [];
  }
  return {
    id: row.id,
    source: row.source as MdmSource,
    organisationName: row.organisationName,
    profileVersion: row.profileVersion,
    values: parsedValues,
    lockedKeys,
    lastAppliedAt: row.lastAppliedAt
      ? new Date(row.lastAppliedAt).toISOString()
      : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function getProfile(
  ctx: TenantContext,
): Promise<MdmProfileView | null> {
  const [row] = await db
    .select()
    .from(mdmProfiles)
    .where(tenantScope(ctx, mdmProfiles))
    .limit(1);
  return row ? rowToView(row) : null;
}

export async function upsertProfile(
  ctx: TenantContext,
  input: UpsertProfileInput,
): Promise<MdmProfileView> {
  if (!input.organisationName || input.organisationName.length === 0) {
    throw new MdmValidationError("organisationName is required");
  }
  if (input.organisationName.length > 256) {
    throw new MdmValidationError("organisationName exceeds 256 chars");
  }
  const values = normaliseValues(input.values ?? {});
  const lockedKeys = normaliseLockedKeys(input.lockedKeys);
  const source: MdmSource = input.source ?? "manual";
  const now = Date.now();

  const existing = await db
    .select()
    .from(mdmProfiles)
    .where(tenantScope(ctx, mdmProfiles))
    .limit(1);

  if (existing.length > 0) {
    const current = existing[0];
    const nextProfileVersion =
      input.profileVersion ?? current.profileVersion + 1;
    await db
      .update(mdmProfiles)
      .set({
        source,
        organisationName: input.organisationName,
        profileVersion: nextProfileVersion,
        valuesJson: JSON.stringify(values),
        lockedKeysJson: JSON.stringify(lockedKeys),
        lastAppliedAt: now,
        updatedAt: now,
        version: current.version + 1,
      })
      .where(and(tenantScope(ctx, mdmProfiles), eq(mdmProfiles.id, current.id)));
    logger.info(
      {
        tenantId: ctx.tenantId,
        source,
        profileVersion: nextProfileVersion,
        lockedCount: lockedKeys.length,
      },
      "MDM profile updated",
    );
  } else {
    await db.insert(mdmProfiles).values(
      withTenantValues(ctx, {
        id: `mdm_${nanoid(16)}`,
        source,
        organisationName: input.organisationName,
        profileVersion: input.profileVersion ?? 1,
        valuesJson: JSON.stringify(values),
        lockedKeysJson: JSON.stringify(lockedKeys),
        lastAppliedAt: now,
      }),
    );
    logger.info(
      {
        tenantId: ctx.tenantId,
        source,
        lockedCount: lockedKeys.length,
      },
      "MDM profile installed",
    );
  }

  const view = await getProfile(ctx);
  if (!view) {
    throw new Error("MDM profile vanished immediately after upsert");
  }
  return view;
}

export async function deleteProfile(ctx: TenantContext): Promise<boolean> {
  const result = await db
    .delete(mdmProfiles)
    .where(tenantScope(ctx, mdmProfiles));
  const changes = (result as unknown as { changes?: number }).changes ?? 0;
  if (changes > 0) {
    logger.info({ tenantId: ctx.tenantId }, "MDM profile removed");
  }
  return changes > 0;
}

// ─── Effective settings + admin lock ─────────────────────────────────────────

export interface EffectiveSetting {
  key: string;
  value: ConfigValue;
  source: "mdm" | "default";
  locked: boolean;
}

/**
 * Merge the active profile with the schema defaults and surface every
 * field's `(value, source, locked)` tuple. Settings UI consumers iterate
 * this list and grey out any field whose `locked === true`.
 */
export async function getEffectiveSettings(
  ctx: TenantContext,
): Promise<{
  managed: boolean;
  organisationName: string | null;
  profileVersion: number;
  settings: EffectiveSetting[];
}> {
  const profile = await getProfile(ctx);
  const lockedSet = new Set(profile?.lockedKeys ?? []);
  const settings: EffectiveSetting[] = CONFIG_FIELDS.map((field) => {
    const provided = profile?.values[field.key];
    const hasMdmValue = provided !== undefined;
    return {
      key: field.key,
      value: hasMdmValue ? (provided as ConfigValue) : field.defaultValue,
      source: hasMdmValue ? "mdm" : "default",
      locked: lockedSet.has(field.key),
    };
  });
  return {
    managed: !!profile,
    organisationName: profile?.organisationName ?? null,
    profileVersion: profile?.profileVersion ?? 0,
    settings,
  };
}

/**
 * Used by callers outside the MDM surface (Settings PUT handlers) to
 * reject a write that would override an admin-locked key.
 */
export async function isLocked(
  ctx: TenantContext,
  key: string,
): Promise<boolean> {
  const profile = await getProfile(ctx);
  if (!profile) return false;
  return profile.lockedKeys.includes(key);
}

// ─── Profile artifact generators ─────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistValue(field: ConfigFieldDef, raw: ConfigValue): string {
  switch (field.kind) {
    case "boolean":
      return raw === true ? "<true/>" : "<false/>";
    case "string":
    case "url":
    case "enum":
      return `<string>${escapeXml(typeof raw === "string" ? raw : "")}</string>`;
    case "string-list": {
      const items = Array.isArray(raw) ? raw : [];
      const inner = items
        .map((v) => `        <string>${escapeXml(v)}</string>`)
        .join("\n");
      return `<array>\n${inner}\n      </array>`;
    }
  }
}

/**
 * Generate an Apple Configuration Profile (.mobileconfig) for the active
 * profile. Returns the XML plist as a UTF-8 string ready to be served
 * with `Content-Type: application/x-apple-aspen-config`.
 *
 * The PayloadType `com.omninity.operator.policy` is the namespace IT
 * sees in Profile Manager / Jamf and matches the desktop shell's MDM
 * reader.
 */
export async function generateMobileConfig(ctx: TenantContext): Promise<string> {
  const profile = await getProfile(ctx);
  if (!profile) {
    throw new MdmValidationError("No MDM profile configured for this tenant");
  }
  const payloadEntries: string[] = [];
  for (const field of CONFIG_FIELDS) {
    const value = profile.values[field.key];
    if (value === undefined) continue;
    const key = field.plistKey ?? field.key;
    payloadEntries.push(
      `      <key>${escapeXml(key)}</key>\n      ${plistValue(field, value)}`,
    );
  }
  if (profile.lockedKeys.length > 0) {
    const inner = profile.lockedKeys
      .map((k) => `        <string>${escapeXml(k)}</string>`)
      .join("\n");
    payloadEntries.push(
      `      <key>LockedKeys</key>\n      <array>\n${inner}\n      </array>`,
    );
  }
  const payloadUuid = `omninity-${ctx.tenantId}`.toUpperCase();
  const profileUuid = `${payloadUuid}-PROFILE`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.omninity.operator.policy</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.omninity.operator.policy.${escapeXml(ctx.tenantId)}</string>
      <key>PayloadUUID</key>
      <string>${escapeXml(payloadUuid)}</string>
      <key>PayloadDisplayName</key>
      <string>Omninity Operator Policy</string>
      <key>PayloadOrganization</key>
      <string>${escapeXml(profile.organisationName)}</string>
      <key>ProfileVersion</key>
      <integer>${profile.profileVersion}</integer>
${payloadEntries.join("\n")}
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Omninity Operator — ${escapeXml(profile.organisationName)}</string>
  <key>PayloadIdentifier</key>
  <string>com.omninity.operator.${escapeXml(ctx.tenantId)}</string>
  <key>PayloadOrganization</key>
  <string>${escapeXml(profile.organisationName)}</string>
  <key>PayloadRemovalDisallowed</key>
  <true/>
  <key>PayloadScope</key>
  <string>System</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${escapeXml(profileUuid)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

function regEscape(value: string): string {
  // .reg files use backslash + double-quote escaping inside REG_SZ values.
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Generate a Windows Registry import (`.reg`) file matching the active
 * profile. IT pushes this either via `reg import` in an SCCM script or
 * by translating it into a GPO ADMX template (also generated below).
 *
 * Layout matches the Windows reader: every value lives under
 * `HKLM\SOFTWARE\Policies\Omninity\Operator`. Boolean values use REG_DWORD
 * (`0x00000001` / `0x00000000`); string lists are stored as REG_MULTI_SZ
 * with NUL terminators encoded as `\0`.
 */
export async function generateRegistryReg(ctx: TenantContext): Promise<string> {
  const profile = await getProfile(ctx);
  if (!profile) {
    throw new MdmValidationError("No MDM profile configured for this tenant");
  }
  const lines: string[] = [
    "Windows Registry Editor Version 5.00",
    "",
    "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Omninity\\Operator]",
    `"OrganisationName"="${regEscape(profile.organisationName)}"`,
    `"ProfileVersion"=dword:${profile.profileVersion.toString(16).padStart(8, "0")}`,
  ];
  for (const field of CONFIG_FIELDS) {
    const value = profile.values[field.key];
    if (value === undefined) continue;
    const name = field.registryName ?? field.key;
    switch (field.kind) {
      case "boolean":
        lines.push(`"${name}"=dword:${value === true ? "00000001" : "00000000"}`);
        break;
      case "string":
      case "url":
      case "enum":
        lines.push(
          `"${name}"="${regEscape(typeof value === "string" ? value : "")}"`,
        );
        break;
      case "string-list": {
        const arr = Array.isArray(value) ? value : [];
        // Multi-string written as comma-joined to keep the .reg readable;
        // the desktop reader splits on NUL or comma.
        lines.push(
          `"${name}"="${regEscape(arr.join(","))}"`,
        );
        break;
      }
    }
  }
  if (profile.lockedKeys.length > 0) {
    lines.push(
      `"LockedKeys"="${regEscape(profile.lockedKeys.join(","))}"`,
    );
  }
  lines.push("");
  return lines.join("\r\n");
}

/**
 * Generate a Group Policy ADMX template describing every supported key.
 *
 * Unlike `.reg`, the ADMX is *schema-only* — it does not embed the
 * tenant's current values. IT imports it once into the Group Policy
 * Central Store and then sets values for the whole forest from
 * gpedit.msc. This makes the file safe to serve unauthenticated for
 * marketing pages too.
 */
export function generateAdmxTemplate(): string {
  const policies = CONFIG_FIELDS.map((field) => {
    const presentation =
      field.kind === "boolean"
        ? `      <enabledList><item>EnableOmninityOperator</item></enabledList>`
        : `      <elements><text id="${field.key}" valueName="${field.registryName ?? field.key}" /></elements>`;
    return `    <policy name="${field.key}" class="Machine" displayName="$(string.${field.key}_label)" explainText="$(string.${field.key}_explain)" key="SOFTWARE\\Policies\\Omninity\\Operator" valueName="${field.registryName ?? field.key}">
      <parentCategory ref="OmninityOperator" />
      <supportedOn ref="windows:SUPPORTED_Windows10" />
${presentation}
    </policy>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="omninity" namespace="Omninity.Operator" />
    <using prefix="windows" namespace="Microsoft.Policies.Windows" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <categories>
    <category name="OmninityOperator" displayName="$(string.OmninityOperator)" />
  </categories>
  <policies>
${policies}
  </policies>
</policyDefinitions>
`;
}

/**
 * Generate the Microsoft Intune Win32 detection script (PowerShell). IT
 * uploads this alongside the wrapped `.intunewin` package; Intune runs
 * it on each device to confirm OP installed successfully.
 */
export function generateIntuneDetectionScript(version: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$keyPath = 'HKLM:\\SOFTWARE\\Omninity\\Operator'",
    "if (-not (Test-Path $keyPath)) { exit 1 }",
    "$installed = (Get-ItemProperty $keyPath -ErrorAction Stop).Version",
    `if ($installed -eq '${version}') { Write-Output 'Detected'; exit 0 }`,
    "exit 1",
    "",
  ].join("\r\n");
}

/**
 * Catalog of installer artifacts available for download. The Enterprise
 * Admin portal uses this to populate the deployment toolbox; the values
 * are read from `OMNINITY_INSTALLER_*` env vars when set, falling back
 * to deterministic placeholders for development.
 */
export interface InstallerArtifact {
  id: string;
  platform: "darwin" | "win32" | "linux";
  format: string;
  filename: string;
  description: string;
  silentInstallCommand: string | null;
  downloadUrl: string | null;
  sha256: string | null;
  signed: boolean;
  notarized: boolean;
}

function envOr(key: string, fallback: string | null): string | null {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

export function listInstallerArtifacts(version?: string): InstallerArtifact[] {
  const v = version ?? process.env["OMNINITY_BUILD_VERSION"] ?? "0.1.0";
  return [
    {
      id: "macos-pkg",
      platform: "darwin",
      format: "pkg",
      filename: `OmninityOperator-${v}.pkg`,
      description:
        "macOS Installer Package — required for Jamf Pro deployment. Signed with Developer ID and notarised by Apple.",
      silentInstallCommand: `sudo installer -pkg OmninityOperator-${v}.pkg -target /`,
      downloadUrl: envOr("OMNINITY_INSTALLER_PKG_URL", null),
      sha256: envOr("OMNINITY_INSTALLER_PKG_SHA256", null),
      signed: true,
      notarized: true,
    },
    {
      id: "windows-msi",
      platform: "win32",
      format: "msi",
      filename: `OmninityOperator-${v}.msi`,
      description:
        "Windows MSI — supports `msiexec /i ... /quiet /norestart` out of the box. Signed with EV certificate.",
      silentInstallCommand: `msiexec /i OmninityOperator-${v}.msi /quiet /norestart`,
      downloadUrl: envOr("OMNINITY_INSTALLER_MSI_URL", null),
      sha256: envOr("OMNINITY_INSTALLER_MSI_SHA256", null),
      signed: true,
      notarized: false,
    },
    {
      id: "windows-mst",
      platform: "win32",
      format: "mst",
      filename: `OmninityOperator-${v}.mst`,
      description:
        "Windows Installer Transform — apply via `msiexec /i ... TRANSFORMS=OmninityOperator.mst` for SCCM customisation.",
      silentInstallCommand: `msiexec /i OmninityOperator-${v}.msi TRANSFORMS=OmninityOperator-${v}.mst /quiet /norestart`,
      downloadUrl: envOr("OMNINITY_INSTALLER_MST_URL", null),
      sha256: envOr("OMNINITY_INSTALLER_MST_SHA256", null),
      signed: true,
      notarized: false,
    },
    {
      id: "windows-intunewin",
      platform: "win32",
      format: "intunewin",
      filename: `OmninityOperator-${v}.intunewin`,
      description:
        "Microsoft Win32 Content Prep wrapper — upload directly to Intune. Detection script provided by GET /mdm/installers/intune-detection.",
      silentInstallCommand: null,
      downloadUrl: envOr("OMNINITY_INSTALLER_INTUNEWIN_URL", null),
      sha256: envOr("OMNINITY_INSTALLER_INTUNEWIN_SHA256", null),
      signed: true,
      notarized: false,
    },
  ];
}

// ─── Fleet beacons ───────────────────────────────────────────────────────────

export interface FleetBeaconInput {
  machineId: string;
  hostname?: string | null;
  platform: "darwin" | "win32" | "linux" | "unknown";
  osVersion?: string | null;
  appVersion: string;
  channel?: "stable" | "beta" | "canary" | "dev";
  profileVersion?: number;
}

export interface FleetDeviceView {
  id: string;
  machineId: string;
  hostname: string | null;
  platform: string;
  osVersion: string | null;
  appVersion: string;
  channel: string;
  profileVersion: number;
  enrolledAt: string;
  lastSeenAt: string;
}

function fleetRowToView(
  row: typeof mdmFleetDevices.$inferSelect,
): FleetDeviceView {
  return {
    id: row.id,
    machineId: row.machineId,
    hostname: row.hostname,
    platform: row.platform,
    osVersion: row.osVersion,
    appVersion: row.appVersion,
    channel: row.channel,
    profileVersion: row.profileVersion,
    enrolledAt: new Date(row.enrolledAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
  };
}

export async function recordFleetBeacon(
  ctx: TenantContext,
  input: FleetBeaconInput,
): Promise<FleetDeviceView> {
  if (!input.machineId || input.machineId.length === 0) {
    throw new MdmValidationError("machineId is required");
  }
  if (input.machineId.length > 128) {
    throw new MdmValidationError("machineId exceeds 128 chars");
  }
  if (!input.appVersion || input.appVersion.length > 64) {
    throw new MdmValidationError(
      "appVersion is required and must be ≤ 64 chars",
    );
  }
  const now = Date.now();
  const existing = await db
    .select()
    .from(mdmFleetDevices)
    .where(
      and(
        tenantScope(ctx, mdmFleetDevices),
        eq(mdmFleetDevices.machineId, input.machineId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const cur = existing[0];
    await db
      .update(mdmFleetDevices)
      .set({
        hostname: input.hostname ?? cur.hostname,
        platform: input.platform ?? cur.platform,
        osVersion: input.osVersion ?? cur.osVersion,
        appVersion: input.appVersion,
        channel: input.channel ?? cur.channel,
        profileVersion: input.profileVersion ?? cur.profileVersion,
        lastSeenAt: now,
        updatedAt: now,
        version: cur.version + 1,
      })
      .where(
        and(
          tenantScope(ctx, mdmFleetDevices),
          eq(mdmFleetDevices.id, cur.id),
        ),
      );
    const [refreshed] = await db
      .select()
      .from(mdmFleetDevices)
      .where(
        and(
          tenantScope(ctx, mdmFleetDevices),
          eq(mdmFleetDevices.id, cur.id),
        ),
      )
      .limit(1);
    return fleetRowToView(refreshed);
  }

  const id = `fleet_${nanoid(16)}`;
  await db.insert(mdmFleetDevices).values(
    withTenantValues(ctx, {
      id,
      machineId: input.machineId,
      hostname: input.hostname ?? null,
      platform: input.platform,
      osVersion: input.osVersion ?? null,
      appVersion: input.appVersion,
      channel: input.channel ?? "stable",
      profileVersion: input.profileVersion ?? 0,
      enrolledAt: now,
      lastSeenAt: now,
    }),
  );
  const [created] = await db
    .select()
    .from(mdmFleetDevices)
    .where(
      and(tenantScope(ctx, mdmFleetDevices), eq(mdmFleetDevices.id, id)),
    )
    .limit(1);
  logger.info(
    {
      tenantId: ctx.tenantId,
      machineId: input.machineId,
      platform: input.platform,
      appVersion: input.appVersion,
    },
    "MDM fleet device enrolled",
  );
  return fleetRowToView(created);
}

export interface FleetSummary {
  totalDevices: number;
  byPlatform: Record<string, number>;
  byVersion: Record<string, number>;
  activeWithin24h: number;
  staleOver7d: number;
  oldestLastSeen: string | null;
  newestEnrolledAt: string | null;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

export async function listFleet(
  ctx: TenantContext,
  cursor: string | null,
  limit: number,
): Promise<PaginatedData<FleetDeviceView>> {
  const pageLimit = normaliseLimit(limit);
  const cursorTs = cursor ? Number(decodeCursor(cursor)) : null;

  const baseScope = tenantScope(ctx, mdmFleetDevices);
  const where =
    cursorTs !== null && Number.isFinite(cursorTs)
      ? and(baseScope, lt(mdmFleetDevices.lastSeenAt, cursorTs))
      : baseScope;

  const rows = await db
    .select()
    .from(mdmFleetDevices)
    .where(where)
    .orderBy(desc(mdmFleetDevices.lastSeenAt), desc(mdmFleetDevices.id))
    .limit(pageLimit + 1);

  return buildPage(
    rows.map(fleetRowToView),
    pageLimit,
    (row) => String(new Date(row.lastSeenAt).getTime()),
  );
}

export async function getFleetSummary(
  ctx: TenantContext,
): Promise<FleetSummary> {
  const rows = await db
    .select()
    .from(mdmFleetDevices)
    .where(tenantScope(ctx, mdmFleetDevices));
  const now = Date.now();
  const byPlatform: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  let activeWithin24h = 0;
  let staleOver7d = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const row of rows) {
    byPlatform[row.platform] = (byPlatform[row.platform] ?? 0) + 1;
    byVersion[row.appVersion] = (byVersion[row.appVersion] ?? 0) + 1;
    const age = now - row.lastSeenAt;
    if (age <= ONE_DAY_MS) activeWithin24h++;
    if (age > SEVEN_DAYS_MS) staleOver7d++;
    if (oldest === null || row.lastSeenAt < oldest) oldest = row.lastSeenAt;
    if (newest === null || row.enrolledAt > newest) newest = row.enrolledAt;
  }
  return {
    totalDevices: rows.length,
    byPlatform,
    byVersion,
    activeWithin24h,
    staleOver7d,
    oldestLastSeen: oldest ? new Date(oldest).toISOString() : null,
    newestEnrolledAt: newest ? new Date(newest).toISOString() : null,
  };
}

// ─── Deployment guides ───────────────────────────────────────────────────────

export const JAMF_DEPLOYMENT_GUIDE = `# Deploying Omninity Operator via Jamf Pro

This guide walks Jamf admins through silent deployment of Omninity Operator
to managed Macs.

## 1. Upload the package
1. Download \`OmninityOperator-<version>.pkg\` from the Enterprise Admin
   portal (Deployment Toolbox → macOS).
2. In Jamf Pro: **Settings → Computer Management → Packages → New**.
3. Upload the .pkg. Jamf verifies the Apple Developer ID signature and
   the notarisation ticket automatically.

## 2. Create the configuration profile
1. In the Enterprise Admin portal: **MDM → Generate Profile → macOS**.
2. Download \`omninity-operator.mobileconfig\`.
3. In Jamf Pro: **Computers → Configuration Profiles → Upload**.
4. Scope the profile to the same smart group you will deploy the .pkg to.

## 3. Deploy
1. **Computers → Policies → New** with the trigger of your choice
   (\`Recurring Check-in\` for fleet rollout).
2. Add the package payload (Action: **Install**) and the profile payload.
3. Run a recon to confirm enrolment in **Inventory → Search**.

## 4. Confirm fleet status
The OP installer registers a launch-daemon that beacons in to your
Enterprise Admin portal at first launch and every 4 hours. Within a few
minutes of deployment you will see each device in **MDM → Fleet** with
its installed version and last-seen timestamp.
`;

export const INTUNE_DEPLOYMENT_GUIDE = `# Deploying Omninity Operator via Microsoft Intune / SCCM

## 1. Wrap the installer
1. Download \`OmninityOperator-<version>.msi\` from the Enterprise Admin
   portal (Deployment Toolbox → Windows).
2. Run the Microsoft Win32 Content Prep Tool:
   \`IntuneWinAppUtil.exe -c <src> -s OmninityOperator.msi -o <out>\`
   This produces \`OmninityOperator.intunewin\`.

## 2. Add the app to Intune
1. **Intune Admin Center → Apps → Windows → Add → Windows app (Win32)**.
2. Upload \`OmninityOperator.intunewin\`.
3. Install command: \`msiexec /i OmninityOperator.msi /quiet /norestart\`.
4. Uninstall command: \`msiexec /x {OMNINITY-PRODUCT-CODE} /quiet /norestart\`.
5. Detection rule: paste the PowerShell from
   \`GET /mdm/installers/intune-detection\`.
6. Assign to the device groups you want.

## 3. Push policy via Group Policy / Intune
You have two options for pushing OP configuration:

**Group Policy (Active Directory):**
1. Download the ADMX template from \`GET /mdm/profile/admx\`.
2. Copy it into your Group Policy Central Store
   (\`%SYSTEMROOT%\\PolicyDefinitions\` on the domain controller).
3. Open \`gpedit.msc\` → **Computer Configuration → Administrative
   Templates → Omninity → Operator** and configure each setting.

**Intune Configuration Profile (Settings Catalog):**
1. **Devices → Configuration profiles → Create profile** → Windows 10/11 →
   **Settings catalog**.
2. Search "Omninity" and add the keys you want to enforce.
3. Assign the profile to the same group as the app.

## 4. Confirm fleet status
The MSI registers a Windows Service that beacons in to your Enterprise
Admin portal at first launch and every 4 hours. **MDM → Fleet** in the
portal shows each device's installed version and last-seen time.
`;

// ─── Test helpers ────────────────────────────────────────────────────────────

export function __mdmConfigKeysForTests(): string[] {
  return CONFIG_FIELDS.map((f) => f.key);
}
