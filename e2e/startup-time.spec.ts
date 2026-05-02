import { test, expect, type Route } from "@playwright/test";

/**
 * Cold-start regression guard for the Omninity Operator renderer.
 *
 * Budget: < 2000 ms from navigation start to a ready, interactive **chat
 * interface** — the row "Cold start → ready chat interface" of the
 * Performance Budget Table in Standard 11. The marker
 * `[data-test="chat-ready"]` is stamped by `ChatPage` itself (see
 * `artifacts/omninity-website/src/pages/operator/chat.tsx`) so this gate
 * fails the moment the operator chat route stops rendering for any
 * reason — bundle bloat, slow lazy chunk, profile-fetch regression,
 * or a route-level crash.
 *
 * The marketing artifact's OperatorShell gates `/chat` on a completed
 * onboarding profile; we deterministically mock that endpoint here so the
 * spec measures chat startup, not the onboarding wizard's. Other API
 * calls fired by ChatPage (models list, agent runs, etc.) are stubbed
 * with empty payloads so the spec is self-contained and never depends on
 * the real api-server being up.
 */

const COLD_START_BUDGET_MS = 2000;
// "DOMContentLoaded" — not first paint. We check it as a cheap early
// canary so a regression that breaks parsing/script loading fails fast
// rather than burning the full cold-start budget waiting for the
// chat-ready marker that will never arrive.
const DOMCONTENTLOADED_BUDGET_MS = 1500;

const completedProfile = {
  data: {
    profile: {
      completed: true,
      approvalTooltipSeen: true,
      firstTaskCompleted: true,
    },
  },
};

const emptyList = { data: { items: [], nextCursor: null } };

async function jsonRoute(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test.describe("cold start", () => {
  test("chat interface is interactive within budget", async ({ page }) => {
    // Playwright evaluates the *most recently registered* matching handler
    // first, so the catch-all stub MUST be registered before the specific
    // onboarding-profile stub or the catch-all would swallow it and the
    // OperatorShell would render the onboarding wizard instead of ChatPage.
    await page.route(/\/api\/.*/, (route) => jsonRoute(route, emptyList));
    await page.route("**/api/onboarding/profile", (route) =>
      jsonRoute(route, completedProfile),
    );

    const navigationStart = Date.now();

    await page.goto("/chat", { waitUntil: "domcontentloaded" });

    const domContentLoadedAt = Date.now();
    expect(domContentLoadedAt - navigationStart).toBeLessThan(
      DOMCONTENTLOADED_BUDGET_MS,
    );

    const ready = page.locator('[data-test="chat-ready"]');
    await ready.waitFor({ state: "attached", timeout: COLD_START_BUDGET_MS });

    const readyAt = Date.now();
    expect(readyAt - navigationStart).toBeLessThan(COLD_START_BUDGET_MS);
  });
});
