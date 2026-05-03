# Omninity Operator — Developer SDK

| File | What's inside |
|------|---------------|
| [`getting-started.md`](./getting-started.md) | Install, first run, CLI overview |
| [`plugin-api.md`](./plugin-api.md) | Custom tool registration & sidecar pattern |
| [`webhooks.md`](./webhooks.md) | Subscriptions, signature verification |
| [`examples.md`](./examples.md) | Copy-paste recipes |

The SDK lives in `lib/sdk` (`@omninity/sdk`); the CLI lives in
`lib/sdk-cli` (`@omninity/sdk-cli`, binary `op`). Both target the local
Operator API at `http://localhost:3001` and never reach the public
internet.
