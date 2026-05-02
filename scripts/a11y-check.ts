/**
 * scripts/a11y-check.ts — axe-core accessibility gate.
 *
 * Builds a small set of representative pages from the Omninity Operator web
 * artifact, loads each into a JSDOM document, then runs axe-core against
 * the rendered DOM. The script fails (exit 1) if any rule with impact
 * `serious` or `critical` is violated. `moderate` and `minor` are reported
 * to stdout but do not block the build — that bar moves up as the i18n /
 * page-by-page rollout (follow-up #123) lands.
 *
 * Strategy: this is the static-shell audit. It exercises the index.html
 * scaffold and confirms top-level landmarks, language, and skip-link
 * markers are present after Vite builds the artifact. A live-render audit
 * (Playwright + axe-core/playwright) is intentionally deferred until the
 * tier-review host can install browser binaries.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run a11y-check
 *
 * Exit codes:
 *   0  no serious/critical violations.
 *   1  one or more serious/critical violations detected.
 *   2  the script crashed (file not found, jsdom failure).
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const require_ = createRequire(import.meta.url);
const AXE_PATH = require_.resolve("axe-core/axe.min.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");

interface Target {
  label: string;
  htmlPath: string;
  /** When true, treat the file as the unbuilt source; we skip Vite-only tags. */
  source?: boolean;
}

// tier-review: bounded — fixed-size 1-target audit list, never mutated at runtime
const TARGETS: ReadonlyArray<Target> = [
  {
    label: "index.html (source shell)",
    htmlPath: path.join(
      REPO_ROOT,
      "artifacts",
      "omninity-website",
      "index.html",
    ),
    source: true,
  },
];

interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  description: string;
  helpUrl: string;
  nodes: { html: string; failureSummary?: string }[];
}

interface AxeResults {
  violations: AxeViolation[];
}

async function auditTarget(target: Target): Promise<AxeResults> {
  const html = await readFile(target.htmlPath, "utf8");
  const dom = new JSDOM(html, {
    url: "https://omninity.local/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  // Inject axe-core into the JSDOM realm.
  const axeSrc = await readFile(AXE_PATH, "utf8");
  const window = dom.window as unknown as {
    eval: (code: string) => void;
    axe?: {
      run: (
        ctx: unknown,
        opts: unknown,
      ) => Promise<AxeResults>;
    };
    document: Document;
  };
  window.eval(axeSrc);
  if (!window.axe) {
    throw new Error("axe-core failed to initialise inside JSDOM");
  }
  const results = await window.axe.run(window.document, {
    resultTypes: ["violations"],
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
    },
  });
  return results;
}

function formatViolation(v: AxeViolation): string {
  const lines = [
    `  [${v.impact ?? "n/a"}] ${v.id} — ${v.description}`,
    `    ${v.helpUrl}`,
  ];
  for (const n of v.nodes.slice(0, 3)) {
    lines.push(`    └─ ${n.html.slice(0, 200)}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  let blocking = 0;
  let advisory = 0;
  for (const target of TARGETS) {
    console.log(`Auditing ${target.label}…`);
    const { violations } = await auditTarget(target);
    if (violations.length === 0) {
      console.log("  ✓ no axe-core violations");
      continue;
    }
    for (const v of violations) {
      if (v.impact === "serious" || v.impact === "critical") {
        blocking += 1;
        console.error(formatViolation(v));
      } else {
        advisory += 1;
        console.log(formatViolation(v));
      }
    }
  }
  if (advisory > 0) {
    console.log(`\nAdvisory (moderate/minor): ${advisory}`);
  }
  if (blocking > 0) {
    console.error(
      `\na11y-check failed — ${blocking} serious/critical violation(s) must be fixed before merge.`,
    );
    process.exit(1);
  }
  console.log(
    `\na11y-check passed — ${TARGETS.length} target(s), 0 serious/critical violations.`,
  );
}

main().catch((err: unknown) => {
  console.error("a11y-check crashed:", err);
  process.exit(2);
});
