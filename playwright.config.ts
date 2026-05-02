import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the cold-start regression guard
 * (`e2e/startup-time.spec.ts`) and any future end-to-end specs.
 *
 * The test target is the production build of `artifacts/omninity-website`
 * served by `vite preview`. We build it once per run and let Playwright
 * manage the preview server lifecycle.
 */

const PORT = Number(process.env.E2E_PORT ?? 5180);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `PORT=${PORT} BASE_PATH=/ pnpm --filter @workspace/omninity-website run build && PORT=${PORT} BASE_PATH=/ pnpm --filter @workspace/omninity-website exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
