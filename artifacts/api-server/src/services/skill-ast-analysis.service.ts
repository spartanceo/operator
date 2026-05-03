/**
 * AST-based dangerous-call detector for the skill moderation pipeline
 * (Task #57). Complements the regex `skill-scanner.service` with a real
 * TypeScript / JavaScript syntax-tree walk so callers cannot evade
 * detection by string concatenation, comments, or whitespace tricks
 * (e.g. `e\u0076al("…")`, `(0, eval)("…")`, `globalThis["e"+"val"]`).
 *
 * Returned findings use the same severity vocabulary as the regex
 * scanner so the orchestrator can fold them into the same risk score.
 */
import * as ts from "typescript";

export interface AstFinding {
  readonly code: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface AstAnalysisReport {
  readonly safe: boolean;
  readonly parsed: boolean;
  readonly findings: ReadonlyArray<AstFinding>;
  readonly nodeCount: number;
}

/** Identifiers that are forbidden as call targets — direct or computed. */
// tier-review: bounded — fixed-size literal allowlist (≤ 20 entries), never grows at runtime.
const BANNED_GLOBALS = new Set<string>([
  "eval",
  "Function",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "WebAssembly",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
]);

/** require("…") targets that are forbidden. */
// tier-review: bounded — fixed-size literal allowlist (≤ 30 entries), never grows at runtime.
const BANNED_REQUIRES = new Set<string>([
  "child_process",
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "vm",
  "node:vm",
  "cluster",
  "node:cluster",
  "worker_threads",
  "node:worker_threads",
  "dgram",
  "node:dgram",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "http",
  "https",
  "node:http",
  "node:https",
  "perf_hooks",
  "node:perf_hooks",
  "inspector",
  "node:inspector",
]);

/** Member-expression chains that imply a forbidden capability. */
const BANNED_MEMBER_CHAINS: ReadonlyArray<{ chain: string[]; severity: AstFinding["severity"]; code: string; message: string }> = [
  { chain: ["process", "exit"], severity: "critical", code: "AST101", message: "Call to process.exit is forbidden in skills" },
  { chain: ["process", "kill"], severity: "critical", code: "AST102", message: "Call to process.kill is forbidden in skills" },
  { chain: ["process", "binding"], severity: "critical", code: "AST103", message: "Call to process.binding is forbidden in skills" },
  { chain: ["process", "dlopen"], severity: "critical", code: "AST104", message: "Call to process.dlopen is forbidden in skills" },
  { chain: ["constructor", "constructor"], severity: "critical", code: "AST105", message: "Indirect Function constructor access is forbidden" },
  { chain: ["Object", "getPrototypeOf"], severity: "low", code: "AST106", message: "Reflection on prototypes — review for prototype-pollution intent" },
];

function getMemberChain(node: ts.Node): string[] {
  const chain: string[] = [];
  let cur: ts.Node = node;
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur)) {
      chain.unshift(cur.name.getText());
      cur = cur.expression;
    } else {
      const arg = cur.argumentExpression;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        chain.unshift(arg.text);
      } else {
        chain.unshift("__dynamic__");
      }
      cur = cur.expression;
    }
  }
  if (ts.isIdentifier(cur)) chain.unshift(cur.text);
  return chain;
}

function pos(source: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const lc = source.getLineAndCharacterOfPosition(node.getStart());
  return { line: lc.line + 1, column: lc.character + 1 };
}

/**
 * Walk the AST of `source` and report any forbidden syntactic patterns.
 * Falls back to `parsed: false` (with a single finding) if the source
 * can't be parsed at all — the regex scanner will still cover that case.
 */
export function runAstAnalysis(source: string): AstAnalysisReport {
  const findings: AstFinding[] = [];
  let nodeCount = 0;
  let parsed = true;

  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile("skill.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  } catch (e) {
    return {
      safe: false,
      parsed: false,
      nodeCount: 0,
      findings: [
        {
          code: "AST000",
          severity: "high",
          message: `Skill source could not be parsed: ${e instanceof Error ? e.message : String(e)}`,
          line: 1,
          column: 1,
        },
      ],
    };
  }
  const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    parsed = false;
    findings.push({
      code: "AST001",
      severity: "medium",
      message: `Skill source has ${diagnostics.length} parse diagnostic(s) — analysis may be partial`,
      line: 1,
      column: 1,
    });
  }

  function visit(node: ts.Node): void {
    nodeCount++;

    // Direct identifier in call position: forbidden globals listed above.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && BANNED_GLOBALS.has(callee.text)) {
        const p = pos(sf, callee);
        findings.push({
          code: "AST010",
          severity: callee.text === "eval" || callee.text === "Function" ? "critical" : "high",
          message: `Direct call to forbidden global "${callee.text}"`,
          line: p.line,
          column: p.column,
        });
      }
      // (0, eval)("…") pattern.
      if (ts.isParenthesizedExpression(callee) || ts.isCommaListExpression?.(callee as never)) {
        const text = callee.getText();
        if (/\beval\b|\bFunction\b/.test(text)) {
          const p = pos(sf, callee);
          findings.push({
            code: "AST011",
            severity: "critical",
            message: "Indirect eval / Function via comma operator",
            line: p.line,
            column: p.column,
          });
        }
      }
      // require("child_process") and friends.
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1
      ) {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          if (BANNED_REQUIRES.has(arg.text)) {
            const p = pos(sf, node);
            findings.push({
              code: "AST020",
              severity: "critical",
              message: `Forbidden require("${arg.text}") — module is not allowed in skills`,
              line: p.line,
              column: p.column,
            });
          }
        } else {
          const p = pos(sf, node);
          findings.push({
            code: "AST021",
            severity: "high",
            message: "Dynamic require() with non-literal target — cannot statically verify safety",
            line: p.line,
            column: p.column,
          });
        }
      }
      // Member-chain patterns (process.exit, etc.).
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const chain = getMemberChain(callee);
        for (const rule of BANNED_MEMBER_CHAINS) {
          if (
            chain.length >= rule.chain.length &&
            rule.chain.every((part, i) => chain[chain.length - rule.chain.length + i] === part)
          ) {
            const p = pos(sf, callee);
            findings.push({
              code: rule.code,
              severity: rule.severity,
              message: rule.message,
              line: p.line,
              column: p.column,
            });
          }
        }
        // Reflect.apply / Reflect.construct.
        if (chain[0] === "Reflect" && (chain[1] === "apply" || chain[1] === "construct")) {
          const p = pos(sf, callee);
          findings.push({
            code: "AST030",
            severity: "high",
            message: `Reflect.${chain[1]} can be used to bypass syntactic checks`,
            line: p.line,
            column: p.column,
          });
        }
      }
      // globalThis[…] / window[…] dynamic computed access in call position.
      if (ts.isElementAccessExpression(callee)) {
        const owner = callee.expression;
        if (
          ts.isIdentifier(owner) &&
          (owner.text === "globalThis" || owner.text === "global" || owner.text === "window")
        ) {
          const p = pos(sf, callee);
          findings.push({
            code: "AST031",
            severity: "high",
            message: `Computed access on ${owner.text}[…] — possible eval-by-name`,
            line: p.line,
            column: p.column,
          });
        }
      }
    }

    // import("…") — dynamic module loading.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        if (BANNED_REQUIRES.has(arg.text)) {
          const p = pos(sf, node);
          findings.push({
            code: "AST040",
            severity: "critical",
            message: `Forbidden dynamic import("${arg.text}")`,
            line: p.line,
            column: p.column,
          });
        }
      } else {
        const p = pos(sf, node);
        findings.push({
          code: "AST041",
          severity: "high",
          message: "Dynamic import() with non-literal target",
          line: p.line,
          column: p.column,
        });
      }
    }

    // Object.assign(globalThis, …) / overwriting prototype.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "assign"
    ) {
      const target = node.arguments[0];
      if (
        target &&
        ts.isIdentifier(target) &&
        (target.text === "globalThis" || target.text === "global" || target.text === "window")
      ) {
        const p = pos(sf, node);
        findings.push({
          code: "AST050",
          severity: "high",
          message: `Object.assign(${target.text}, …) — global pollution attempt`,
          line: p.line,
          column: p.column,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);

  const safe = !findings.some((f) => f.severity === "critical" || f.severity === "high");
  return { safe, parsed, findings, nodeCount };
}
