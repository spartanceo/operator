/**
 * Skill static analysis — the first stage of the moderation pipeline
 * (Task #57). Composes four sub-checks into one report:
 *
 *   1. Source pattern scan — wraps `skill-scanner.service` (Standard 12).
 *   2. Manifest validation — declared shape + permission over-claiming.
 *   3. Dependency audit — declared `dependencies` map vs the bundled
 *      vulnerability database (mirrors OSV/Snyk in production).
 *   4. Obfuscation detection — entropy + minification heuristic.
 *
 * Every sub-check is deterministic and synchronous so the whole report
 * fits well inside the 60-second SLA the task requires.
 */
import { runAstAnalysis, type AstAnalysisReport } from "./skill-ast-analysis.service";
import { scanSkillSource, type ScanResult } from "./skill-scanner.service";

export interface SkillManifestInput {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly purpose?: string;
  readonly minOpVersion?: string;
  /** Permissions the skill says it needs at install time. */
  readonly permissions?: ReadonlyArray<string>;
  /** Domains the skill says it will reach. */
  readonly networkHosts?: ReadonlyArray<string>;
  /** Workspace paths the skill says it will read/write. */
  readonly fileScopes?: ReadonlyArray<string>;
  /** name → semver range. */
  readonly dependencies?: Record<string, string>;
}

export interface ManifestIssue {
  readonly code: string;
  readonly field: string;
  readonly message: string;
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
}

export interface ManifestValidationReport {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<ManifestIssue>;
  readonly declaredPermissions: ReadonlyArray<string>;
  readonly declaredHosts: ReadonlyArray<string>;
  readonly declaredScopes: ReadonlyArray<string>;
  readonly minOpVersion: string;
  readonly compatible: boolean;
}

export interface DependencyVulnerability {
  readonly packageName: string;
  readonly installedRange: string;
  readonly cve: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly summary: string;
  readonly fixedIn: string;
}

export interface DependencyAuditReport {
  readonly count: number;
  readonly vulnerabilities: ReadonlyArray<DependencyVulnerability>;
  readonly highestSeverity: "none" | "low" | "medium" | "high" | "critical";
}

export interface ObfuscationReport {
  readonly entropy: number;
  readonly maxLineLength: number;
  readonly avgIdentifierLength: number;
  readonly minifiedLikely: boolean;
  readonly obfuscationScore: number;
  readonly flag: boolean;
}

export interface StaticAnalysisReport {
  readonly safe: boolean;
  readonly riskScore: number;
  readonly scanner: ScanResult;
  readonly ast: AstAnalysisReport;
  readonly manifest: ManifestValidationReport;
  readonly dependencies: DependencyAuditReport;
  readonly obfuscation: ObfuscationReport;
  readonly elapsedMs: number;
  readonly summary: string;
}

/** Permissions OP recognises. Adding a new one is a code change so it
 * passes through reviewer eyes. */
export const KNOWN_PERMISSIONS = [
  "files.read",
  "files.write",
  "network.fetch",
  "memory.read",
  "memory.write",
  "knowledge.read",
  "browser.use",
  "desktop.use",
  "calendar.read",
  "calendar.write",
  "email.read",
  "email.send",
] as const;

/** Permission inferred from the skill source — used to detect
 * over-claiming (manifest declares a permission the source never uses). */
const PERMISSION_HINTS: ReadonlyArray<{ permission: string; pattern: RegExp }> = [
  { permission: "files.read", pattern: /\bhost\.\s*readFile\b/ },
  { permission: "files.write", pattern: /\bhost\.\s*writeFile\b/ },
  { permission: "network.fetch", pattern: /\bhost\.\s*fetch\b/ },
  { permission: "memory.read", pattern: /\bhost\.\s*recallMemory\b/ },
  { permission: "memory.write", pattern: /\bhost\.\s*writeMemory\b/ },
  { permission: "knowledge.read", pattern: /\bhost\.\s*searchKnowledge\b/ },
  { permission: "browser.use", pattern: /\bhost\.\s*browser\b/ },
  { permission: "desktop.use", pattern: /\bhost\.\s*desktop\b/ },
  { permission: "calendar.read", pattern: /\bhost\.\s*listEvents\b/ },
  { permission: "calendar.write", pattern: /\bhost\.\s*createEvent\b/ },
  { permission: "email.read", pattern: /\bhost\.\s*listEmails\b/ },
  { permission: "email.send", pattern: /\bhost\.\s*sendEmail\b/ },
];

/**
 * Bundled vulnerability database — a small mirror of the kind of feed
 * OSV/Snyk would supply. In production this is refreshed by a daily
 * cron pulling the OSV JSON dump; here we keep a hand-curated set so
 * the pipeline produces real findings without an external dependency.
 *
 * Adding to this list is intentionally a code change — the security
 * team must review every entry.
 */
const VULN_DB: ReadonlyArray<{
  packageName: string;
  vulnerableRange: RegExp;
  cve: string;
  severity: DependencyVulnerability["severity"];
  summary: string;
  fixedIn: string;
}> = [
  {
    packageName: "lodash",
    vulnerableRange: /^[~^]?(?:[0-3]\.|4\.(?:[0-9]|1[0-6])\.|4\.17\.(?:[0-9]|1[01])(?:\D|$))/,
    cve: "CVE-2019-10744",
    severity: "high",
    summary: "Prototype pollution in defaultsDeep",
    fixedIn: "4.17.12",
  },
  {
    packageName: "minimist",
    vulnerableRange: /^[~^]?(?:0\.|1\.(?:[0-1]\.|2\.[0-5]))/,
    cve: "CVE-2020-7598",
    severity: "high",
    summary: "Prototype pollution via constructor / __proto__ keys",
    fixedIn: "1.2.6",
  },
  {
    packageName: "axios",
    vulnerableRange: /^[~^]?0\./,
    cve: "CVE-2023-45857",
    severity: "high",
    summary: "CSRF token leak via withCredentials",
    fixedIn: "1.6.0",
  },
  {
    packageName: "node-fetch",
    vulnerableRange: /^[~^]?(?:1\.|2\.[0-5]\.)/,
    cve: "CVE-2022-0235",
    severity: "high",
    summary: "Cross-origin redirect leaks Authorization header",
    fixedIn: "2.6.7",
  },
  {
    packageName: "ws",
    vulnerableRange: /^[~^]?(?:[0-6]\.|7\.[0-3]\.)/,
    cve: "CVE-2021-32640",
    severity: "medium",
    summary: "ReDoS in Sec-Websocket-Protocol header parsing",
    fixedIn: "7.4.6",
  },
  {
    packageName: "tar",
    vulnerableRange: /^[~^]?(?:[0-5]\.|6\.[0-1]\.0|6\.0\.)/,
    cve: "CVE-2021-37701",
    severity: "high",
    summary: "Arbitrary file overwrite via path traversal",
    fixedIn: "6.1.9",
  },
  {
    packageName: "left-pad",
    vulnerableRange: /./,
    cve: "OP-2024-0001",
    severity: "low",
    summary: "Unmaintained package — superseded by String.prototype.padStart",
    fixedIn: "use String.prototype.padStart",
  },
];

const SEVERITY_RANK: Record<DependencyVulnerability["severity"] | "none", number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function shannonEntropy(input: string): number {
  if (input.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (const ch of input) counts[ch] = (counts[ch] ?? 0) + 1;
  let entropy = 0;
  for (const ch of Object.keys(counts)) {
    const p = counts[ch]! / input.length;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(3));
}

function detectObfuscation(source: string): ObfuscationReport {
  const lines = source.split(/\r?\n/);
  const maxLineLength = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const idents: string[] = source.match(/[A-Za-z_$][A-Za-z0-9_$]{0,40}/g) ?? [];
  const totalLen = idents.reduce<number>((s, t) => s + t.length, 0);
  const avgIdentifierLength = idents.length > 0 ? totalLen / idents.length : 0;
  const entropy = shannonEntropy(source);

  // Minification heuristics: very long lines + short identifiers + low
  // line count relative to total size.
  const sizeBytes = source.length;
  const linesCount = lines.length;
  const bytesPerLine = sizeBytes / Math.max(1, linesCount);
  const minifiedLikely =
    (maxLineLength > 500 && avgIdentifierLength < 3 && bytesPerLine > 200) ||
    (sizeBytes > 4_000 && linesCount < 5);

  // Score 0..100 — combination of entropy, minified-likely flag, and
  // base64 blob density.
  const base64Hits = (source.match(/[A-Za-z0-9+/]{200,}={0,2}/g) ?? []).length;
  let score = 0;
  if (entropy > 5.5) score += 25;
  if (entropy > 6.0) score += 25;
  if (minifiedLikely) score += 30;
  score += Math.min(20, base64Hits * 5);
  score = Math.min(100, score);

  return {
    entropy,
    maxLineLength,
    avgIdentifierLength: Number(avgIdentifierLength.toFixed(2)),
    minifiedLikely,
    obfuscationScore: score,
    flag: score >= 50,
  };
}

function validateManifest(
  manifest: SkillManifestInput,
  source: string,
  currentOpVersion: string,
): ManifestValidationReport {
  const issues: ManifestIssue[] = [];
  const declaredPermissions = manifest.permissions ?? [];
  const declaredHosts = manifest.networkHosts ?? [];
  const declaredScopes = manifest.fileScopes ?? [];
  const knownSet = new Set<string>(KNOWN_PERMISSIONS);

  if (!manifest.name || manifest.name.length < 2) {
    issues.push({
      code: "M001",
      field: "name",
      message: "Manifest is missing a usable `name` field",
      severity: "critical",
    });
  }
  if (!manifest.version) {
    issues.push({
      code: "M002",
      field: "version",
      message: "Manifest is missing a `version` field",
      severity: "high",
    });
  }
  if (!manifest.description || manifest.description.length < 10) {
    issues.push({
      code: "M003",
      field: "description",
      message: "Manifest description is too short for the marketplace listing (>= 10 chars)",
      severity: "medium",
    });
  }
  if (!manifest.purpose || manifest.purpose.length < 10) {
    issues.push({
      code: "M004",
      field: "purpose",
      message: "Manifest is missing a `purpose` statement — required to detect permission over-claiming",
      severity: "high",
    });
  }

  // Unknown permissions.
  for (const p of declaredPermissions) {
    if (!knownSet.has(p)) {
      issues.push({
        code: "M005",
        field: "permissions",
        message: `Unknown permission requested: "${p}"`,
        severity: "high",
      });
    }
  }

  // Permission OVER-claiming — declared but not used in source.
  for (const p of declaredPermissions) {
    const hint = PERMISSION_HINTS.find((h) => h.permission === p);
    if (hint && !hint.pattern.test(source)) {
      issues.push({
        code: "M006",
        field: "permissions",
        message: `Permission "${p}" is declared but never used by the source — over-claim`,
        severity: "medium",
      });
    }
  }
  // Permission UNDER-claiming — used in source but not declared.
  for (const hint of PERMISSION_HINTS) {
    if (hint.pattern.test(source) && !declaredPermissions.includes(hint.permission)) {
      issues.push({
        code: "M007",
        field: "permissions",
        message: `Source uses ${hint.permission} but the manifest does not declare it`,
        severity: "high",
      });
    }
  }

  // Compatibility check.
  const minOpVersion = manifest.minOpVersion ?? "0.0.0";
  const compatible = compareSemver(minOpVersion, currentOpVersion) <= 0;
  if (!compatible) {
    issues.push({
      code: "M008",
      field: "minOpVersion",
      message: `Skill requires OP >= ${minOpVersion} but current is ${currentOpVersion}`,
      severity: "high",
    });
  }

  const valid = !issues.some((i) => i.severity === "critical" || i.severity === "high");
  return {
    valid,
    issues,
    declaredPermissions,
    declaredHosts,
    declaredScopes,
    minOpVersion,
    compatible,
  };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number(p.replace(/[^0-9]/g, "")) || 0);
  const pb = b.split(".").map((p) => Number(p.replace(/[^0-9]/g, "")) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function auditDependencies(
  dependencies: Record<string, string> = {},
): DependencyAuditReport {
  const vulnerabilities: DependencyVulnerability[] = [];
  for (const [name, range] of Object.entries(dependencies)) {
    for (const v of VULN_DB) {
      if (v.packageName === name && v.vulnerableRange.test(range)) {
        vulnerabilities.push({
          packageName: name,
          installedRange: range,
          cve: v.cve,
          severity: v.severity,
          summary: v.summary,
          fixedIn: v.fixedIn,
        });
      }
    }
  }
  let highestSeverity: DependencyAuditReport["highestSeverity"] = "none";
  for (const v of vulnerabilities) {
    if (SEVERITY_RANK[v.severity] > SEVERITY_RANK[highestSeverity]) {
      highestSeverity = v.severity;
    }
  }
  return {
    count: vulnerabilities.length,
    vulnerabilities,
    highestSeverity,
  };
}

/** Compose the four sub-checks into a single static-analysis report. */
export function runStaticAnalysis(input: {
  source: string;
  manifest: SkillManifestInput;
  currentOpVersion?: string;
}): StaticAnalysisReport {
  const start = Date.now();
  const scanner = scanSkillSource(input.source);
  const ast = runAstAnalysis(input.source);
  const manifest = validateManifest(
    input.manifest,
    input.source,
    input.currentOpVersion ?? "1.0.0",
  );
  const dependencies = auditDependencies(input.manifest.dependencies ?? {});
  const obfuscation = detectObfuscation(input.source);

  // Risk score: weighted combination of every signal. Caps at 100.
  let risk = 0;
  for (const f of scanner.findings) {
    risk +=
      f.severity === "critical"
        ? 30
        : f.severity === "high"
          ? 15
          : f.severity === "medium"
            ? 6
            : 2;
  }
  for (const f of ast.findings) {
    risk +=
      f.severity === "critical"
        ? 30
        : f.severity === "high"
          ? 15
          : f.severity === "medium"
            ? 6
            : 2;
  }
  for (const i of manifest.issues) {
    risk +=
      i.severity === "critical"
        ? 25
        : i.severity === "high"
          ? 12
          : i.severity === "medium"
            ? 5
            : 1;
  }
  for (const v of dependencies.vulnerabilities) {
    risk +=
      v.severity === "critical"
        ? 30
        : v.severity === "high"
          ? 15
          : v.severity === "medium"
            ? 6
            : 2;
  }
  risk += Math.round(obfuscation.obfuscationScore * 0.3);
  risk = Math.min(100, risk);

  const safe =
    scanner.safe &&
    ast.safe &&
    manifest.valid &&
    dependencies.highestSeverity !== "critical" &&
    dependencies.highestSeverity !== "high" &&
    !obfuscation.flag;

  const summary = safe
    ? "Static analysis passed — no blocking findings"
    : `Static analysis surfaced ${
        scanner.findings.length +
        ast.findings.length +
        manifest.issues.length +
        dependencies.vulnerabilities.length
      } findings (risk score ${risk})`;

  return {
    safe,
    riskScore: risk,
    scanner,
    ast,
    manifest,
    dependencies,
    obfuscation,
    elapsedMs: Date.now() - start,
    summary,
  };
}
