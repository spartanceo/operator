/**
 * Skill scanner — pre-flight static analysis of user-submitted skill code.
 *
 * Standard 12 § Skill Sandbox: every skill submitted to the marketplace
 * (and every locally-installed skill on first load) is scanned for
 * patterns that should never appear in trusted skill code. The scanner
 * does not execute anything; it is regex + tokenisation only.
 *
 * Findings are returned with a stable rule id so the marketplace UI can
 * render a deterministic "blocked because" badge.
 */

export type ScannerSeverity = "critical" | "high" | "medium" | "low";

export interface ScannerRule {
  readonly id: string;
  readonly description: string;
  readonly severity: ScannerSeverity;
  readonly pattern: RegExp;
}

export interface ScannerFinding {
  readonly ruleId: string;
  readonly description: string;
  readonly severity: ScannerSeverity;
  readonly line: number;
  readonly snippet: string;
}

export interface ScanResult {
  readonly safe: boolean;
  readonly findings: ReadonlyArray<ScannerFinding>;
}

/**
 * The rule set is a fixed allow-list of forbidden patterns. Adding a new
 * rule is intentionally a code change so a reviewer reads the diff —
 * security policy must not be hot-pluggable from the database.
 *
 * tier-review: bounded — fixed-size rule list, never written to at runtime.
 */
const RULES: ReadonlyArray<ScannerRule> = [
  {
    id: "S001",
    description:
      "Direct call to the JavaScript dynamic-evaluation primitive is forbidden in skills.",
    severity: "critical",
    pattern: /\beval\s*\(/,
  },
  {
    id: "S002",
    description:
      "Construction of a runtime function via the global Function constructor is not permitted in skills.",
    severity: "critical",
    pattern: /\bnew\s+Function\s*\(/,
  },
  {
    id: "S003",
    description: "`vm.runIn*Context` bypasses the sandbox.",
    severity: "critical",
    pattern: /\bvm\.\s*runIn\w*Context\s*\(/,
  },
  {
    id: "S004",
    description: "Direct `require('child_process')` is not permitted.",
    severity: "critical",
    pattern: /require\s*\(\s*['"]child_process['"]\s*\)/,
  },
  {
    id: "S005",
    description: "Dynamic `import('child_process')` is not permitted.",
    severity: "critical",
    pattern: /import\s*\(\s*['"]child_process['"]\s*\)/,
  },
  {
    id: "S006",
    description: "Direct `process.env` access leaks host secrets.",
    severity: "high",
    pattern: /\bprocess\.env\b/,
  },
  {
    id: "S007",
    description: "`process.exit` would terminate the host process.",
    severity: "critical",
    pattern: /\bprocess\.exit\s*\(/,
  },
  {
    id: "S008",
    description: "Direct `node:fs` import bypasses the workspace sandbox.",
    severity: "high",
    pattern: /require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)|import\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/,
  },
  {
    id: "S009",
    description: "Raw network access (`http.request` / `net.connect`) bypasses the egress audit.",
    severity: "high",
    pattern: /\b(?:http|https|net|tls)\.\s*(?:request|connect|createConnection)\s*\(/,
  },
  {
    id: "S010",
    description: "WebAssembly compilation may be used to smuggle native code.",
    severity: "medium",
    pattern: /\bWebAssembly\s*\.\s*(?:compile|instantiate)\b/,
  },
  {
    id: "S011",
    description: "Prototype-pollution sink (`__proto__` / `constructor.prototype`).",
    severity: "high",
    pattern: /__proto__\s*[=:]|constructor\s*\.\s*prototype\s*\[/,
  },
  {
    id: "S012",
    description: "`atob` + `eval` chain is the canonical obfuscation pattern.",
    severity: "critical",
    pattern: /eval\s*\(\s*atob\s*\(/,
  },
  {
    id: "S013",
    description: "Suspicious base64 blob over 4kb — likely packed payload.",
    severity: "medium",
    // Static base64 string literal of >=4kb.
    pattern: /['"][A-Za-z0-9+/=]{4096,}['"]/,
  },
  {
    id: "S014",
    description: "Direct `globalThis` mutation can leak between skills.",
    severity: "medium",
    pattern: /\bglobalThis\s*\[/,
  },
  {
    id: "S015",
    description: "`Buffer.allocUnsafe` returns uninitialised memory.",
    severity: "medium",
    pattern: /Buffer\.\s*allocUnsafe\b/,
  },
];

/**
 * Scan a string of skill source code for malicious patterns. Empty input
 * is treated as safe (the schema enforces a minimum length elsewhere).
 */
export function scanSkillSource(code: string): ScanResult {
  if (typeof code !== "string" || code.length === 0) {
    return { safe: true, findings: [] };
  }
  const findings: ScannerFinding[] = [];
  const lines = code.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (rule.pattern.test(line)) {
        const snippet = line.length > 200 ? line.slice(0, 200) + "…" : line;
        findings.push({
          ruleId: rule.id,
          description: rule.description,
          severity: rule.severity,
          line: i + 1,
          snippet,
        });
      }
    }
  }
  // Critical / high findings always block; medium / low produce findings
  // but allow load (the marketplace UI surfaces them as warnings).
  const safe = !findings.some((f) => f.severity === "critical" || f.severity === "high");
  return { safe, findings };
}

export const SCANNER_RULES = RULES;
