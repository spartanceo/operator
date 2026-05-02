# End-to-end tests

Playwright suites that gate user-perceived behaviour. The first spec here is
`startup-time.spec.ts`, which enforces the cold-start budget from Standard 11
— Performance & Snappiness.

The Playwright config lives at the repo root (`playwright.config.ts`) and
spins up `vite preview` for `artifacts/omninity-website` automatically. The
spec navigates to `/chat`, mocks the onboarding-profile endpoint to bypass
the wizard, and asserts that `[data-test="chat-ready"]` (stamped from
`ChatPage` itself) appears within 2000 ms of navigation.

## Running locally

```bash
pnpm install
pnpm --filter @workspace/e2e exec playwright install --with-deps chromium
pnpm --filter @workspace/e2e run e2e
```

## CI

The `.github/workflows/e2e-startup.yml` workflow installs Playwright browsers
and runs `pnpm --filter @workspace/e2e run e2e` on every PR and push to
main. The script is intentionally **not** named `test` so the recursive
`pnpm test` invoked by `scripts/tier-review.ts` (Check #2) does not try to
launch Playwright in environments without browsers installed.
