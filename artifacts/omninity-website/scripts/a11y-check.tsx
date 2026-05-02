/**
 * Rendered, multi-route axe-core accessibility gate for the Omninity
 * Operator marketing + operator surfaces.
 *
 * Strategy
 * --------
 * The artifact is an SPA, so the file-on-disk `index.html` is just a
 * loader shell. To exercise a meaningful surface we render the actual
 * React tree for each audited route via `react-dom/server`, splice the
 * markup into a JSDOM document, then run axe-core inside that JSDOM.
 *
 * This is not a full browser audit (we don't execute the bundle), but it
 * does catch the static a11y bugs reviewers care about: missing form
 * labels, landmark structure, colour contrast, language metadata, ARIA
 * misuse, viewport zoom suppression, etc. A future Playwright-based gate
 * can layer on top once a browser binary is available in CI.
 *
 * Gate
 * ----
 * Fails (exit 1) on any axe-core violation with impact `moderate`,
 * `serious`, or `critical`. Minor advisories are surfaced but do not
 * block the build, since axe occasionally flags style-system pseudo
 * elements that are not user-visible.
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/omninity-website run a11y-check
 *
 * Exit codes
 * ----------
 *   0  — no blocking violations on any audited route
 *   1  — at least one moderate / serious / critical violation
 *   2  — the harness itself crashed (render or jsdom failure)
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = path.resolve(here, "..");
const SHELL_HTML_PATH = path.join(ARTIFACT_ROOT, "index.html");
const require_ = createRequire(import.meta.url);
const AXE_PATH = require_.resolve("axe-core/axe.min.js");

// ---------------------------------------------------------------------------
// 1. Bootstrap a global JSDOM so React + i18next + ThemeProvider can read
//    `window`, `document`, `localStorage`, `matchMedia`, etc. during their
//    module-load side effects. This MUST happen before any artifact import.
// ---------------------------------------------------------------------------
const bootDom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://omninity.local/",
  pretendToBeVisual: true,
});
const bootWindow = bootDom.window as unknown as Window & typeof globalThis;
type GlobalShim = Record<string, unknown>;
const g = globalThis as unknown as GlobalShim;

// matchMedia isn't part of jsdom by default; install it on the bootstrap
// window before we expose anything to the page tree.
if (!("matchMedia" in bootWindow)) {
  (bootWindow as unknown as GlobalShim)["matchMedia"] = (query: string) => ({
    matches: false,
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  });
}

// Mirror only the globals React + i18next + ThemeProvider read at module
// load. `navigator`, `HTMLElement`, etc. are getter-only on Node 24's
// global object, but they're already wired through the JSDOM realm via
// `window` / `document`, so we don't need to redefine them.
function installGlobal(name: string, value: unknown): void {
  try {
    Object.defineProperty(g, name, {
      value,
      writable: true,
      configurable: true,
    });
  } catch {
    /* read-only on this runtime — skip; jsdom realm already provides it. */
  }
}
installGlobal("window", bootWindow);
installGlobal("document", bootWindow.document);
installGlobal("HTMLElement", bootWindow.HTMLElement);
installGlobal("Element", bootWindow.Element);
installGlobal("Node", bootWindow.Node);
installGlobal("localStorage", bootWindow.localStorage);
installGlobal("sessionStorage", bootWindow.sessionStorage);
installGlobal("getComputedStyle", bootWindow.getComputedStyle.bind(bootWindow));
installGlobal(
  "matchMedia",
  (bootWindow as unknown as GlobalShim)["matchMedia"],
);

// ---------------------------------------------------------------------------
// 2. Shim Vite-only globals (`import.meta.env.BASE_URL`, etc.) before the
//    artifact's modules load. Vite normally inlines these at build time;
//    in this Node harness we provide a static mirror of the dev defaults.
// ---------------------------------------------------------------------------
const meta = (import.meta as unknown as { env?: Record<string, unknown> });
meta.env ??= {};
const env = meta.env as Record<string, unknown>;
env["BASE_URL"] ??= "/";
env["MODE"] ??= "test";
env["DEV"] ??= false;
env["PROD"] ??= false;
env["SSR"] ??= true;

// ---------------------------------------------------------------------------
// 3. Now that browser globals exist, dynamic-import React + the page tree.
// ---------------------------------------------------------------------------
const ReactModule = await import("react");
const React = (ReactModule.default ?? ReactModule) as typeof import("react");
const { renderToString } = await import("react-dom/server");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router: WouterRouter } = await import("wouter");
const { LocaleProvider } = await import("../src/i18n/locale-context");
const { ThemeProvider } = await import("../src/contexts/theme-context");
const { SettingsProvider } = await import("../src/contexts/settings-context");
const { TooltipProvider } = await import("../src/components/ui/tooltip");
const { HelpProvider } = await import("../src/components/help");
const { Layout } = await import("../src/components/layout/layout");
const { default: LandingPage } = await import("../src/pages/landing");
const { default: SettingsPage } = await import("../src/pages/operator/settings");

// ---------------------------------------------------------------------------
// 3. Per-route harness: wrap the page in every provider it expects, render
//    it to an HTML string, then run axe over a fresh JSDOM containing the
//    full document (the existing index.html shell + our rendered markup).
// ---------------------------------------------------------------------------

interface Target {
  label: string;
  pathname: string;
  render: () => string;
}

function withProviders(node: React.ReactNode, pathname: string): string {
  // tier-review: bounded — fresh QueryClient per render; not retained across calls
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return renderToString(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(
        LocaleProvider,
        null,
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            SettingsProvider,
            null,
            React.createElement(
              HelpProvider,
              null,
              React.createElement(
                TooltipProvider,
                null,
                React.createElement(
                  WouterRouter,
                  { ssrPath: pathname },
                  node,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

const TARGETS: ReadonlyArray<Target> = [
  {
    label: "/ (marketing landing)",
    pathname: "/",
    render: () =>
      withProviders(
        React.createElement(Layout, null, React.createElement(LandingPage)),
        "/",
      ),
  },
  {
    label: "/settings (operator settings)",
    pathname: "/settings",
    render: () =>
      withProviders(React.createElement(SettingsPage), "/settings"),
  },
];

interface AxeNode {
  html: string;
  failureSummary?: string;
  target?: string[];
}
interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  description: string;
  helpUrl: string;
  nodes: AxeNode[];
}
interface AxeResults {
  violations: AxeViolation[];
}

async function auditTarget(
  target: Target,
  shellHtml: string,
  axeSrc: string,
): Promise<AxeResults> {
  const rendered = target.render();
  // Splice the rendered tree into the real shell so audited <html lang>,
  // <meta>, and other head-level concerns are evaluated.
  const html = shellHtml.replace(
    /<div id="root"><\/div>/,
    `<div id="root">${rendered}</div>`,
  );
  const dom = new JSDOM(html, {
    url: `https://omninity.local${target.pathname}`,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  type AxeWindow = {
    eval: (code: string) => void;
    axe?: {
      run: (ctx: unknown, opts: unknown) => Promise<AxeResults>;
    };
    document: Document;
  };
  const win = dom.window as unknown as AxeWindow;
  win.eval(axeSrc);
  if (!win.axe) {
    throw new Error("axe-core failed to initialise inside JSDOM");
  }
  return win.axe.run(win.document, {
    resultTypes: ["violations"],
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
    },
  });
}

function formatViolation(v: AxeViolation): string {
  const lines = [
    `  [${v.impact ?? "n/a"}] ${v.id} — ${v.description}`,
    `    ${v.helpUrl}`,
  ];
  for (const n of v.nodes.slice(0, 3)) {
    lines.push(`    └─ ${n.html.slice(0, 220)}`);
    if (n.failureSummary) {
      for (const line of n.failureSummary.split("\n").slice(0, 4)) {
        lines.push(`       ${line}`);
      }
    }
  }
  return lines.join("\n");
}

// tier-review: bounded — fixed three-element WCAG impact set, never mutated
const BLOCKING: ReadonlySet<string> = new Set(["moderate", "serious", "critical"]);

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<void> {
  const [shellHtml, axeSrc] = await Promise.all([
    readFile(SHELL_HTML_PATH, "utf8"),
    readFile(AXE_PATH, "utf8"),
  ]);
  let blocking = 0;
  let advisory = 0;
  for (const target of TARGETS) {
    out(`Auditing ${target.label}…`);
    let results: AxeResults;
    try {
      results = await auditTarget(target, shellHtml, axeSrc);
    } catch (e) {
      err(`  ✗ render failed: ${(e as Error).message}`);
      blocking += 1;
      continue;
    }
    if (results.violations.length === 0) {
      out("  ✓ no axe-core violations");
      continue;
    }
    for (const v of results.violations) {
      const impact = v.impact ?? "minor";
      if (BLOCKING.has(impact)) {
        blocking += 1;
        err(formatViolation(v));
      } else {
        advisory += 1;
        out(formatViolation(v));
      }
    }
  }
  if (advisory > 0) {
    out(`\nAdvisory (minor): ${advisory}`);
  }
  if (blocking > 0) {
    err(
      `\na11y-check failed — ${blocking} moderate/serious/critical violation(s) must be fixed before merge.`,
    );
    process.exit(1);
  }
  out(
    `\na11y-check passed — ${TARGETS.length} route(s), 0 blocking violations.`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`a11y-check crashed: ${String(e)}\n`);
  process.exit(2);
});
