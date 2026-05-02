/**
 * Prompt-injection scanner.
 *
 * Standard 12 § "Untrusted input": every chunk of web content / document
 * text the agent ingests is scanned for canonical prompt-injection
 * markers ("ignore previous instructions", "you are now …", embedded
 * tool-call syntax, etc). The scanner is intentionally a regex pass —
 * machine-learning detectors live in the downstream "Skill Content
 * Moderation" task; this is the local-first first line.
 */

export interface InjectionFinding {
  readonly ruleId: string;
  readonly description: string;
  readonly snippet: string;
}

interface InjectionRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

// tier-review: bounded — fixed-size rule list, never written to at runtime.
const RULES: ReadonlyArray<InjectionRule> = [
  {
    id: "PI001",
    description: "'ignore previous instructions' override marker",
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)/i,
  },
  {
    id: "PI002",
    description: "'you are now …' role-rewriting marker",
    pattern: /\byou\s+are\s+now\b/i,
  },
  {
    id: "PI003",
    description: "Embedded system / assistant tag attempting to spoof a turn",
    pattern: /<\s*\|?\s*(?:system|assistant)\s*\|?\s*>/i,
  },
  {
    id: "PI004",
    description: "Embedded tool-call JSON in untrusted content",
    pattern: /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:/i,
  },
  {
    id: "PI005",
    description: "Markdown image with javascript: scheme",
    pattern: /!\[[^\]]*\]\(\s*javascript:/i,
  },
  {
    id: "PI006",
    description: "Direct exfiltration request ('print your prompt')",
    pattern: /(?:print|reveal|leak|show)\s+(?:your\s+)?(?:system\s+)?prompt/i,
  },
  {
    id: "PI007",
    description: "Hidden zero-width characters (often used to smuggle text)",
    pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]{3,}/,
  },
];

export interface InjectionScanResult {
  readonly safe: boolean;
  readonly findings: ReadonlyArray<InjectionFinding>;
}

export function scanForPromptInjection(text: string): InjectionScanResult {
  if (typeof text !== "string" || text.length === 0) {
    return { safe: true, findings: [] };
  }
  const findings: InjectionFinding[] = [];
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match) {
      const idx = match.index ?? 0;
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + match[0].length + 40);
      const snippet = text.slice(start, end).replace(/\s+/g, " ");
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        snippet,
      });
    }
  }
  return { safe: findings.length === 0, findings };
}
