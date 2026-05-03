# Omninity Operator SDK — Getting Started

`@omninity/sdk` is a local-first JS/TS client for the Omninity Operator
API. It speaks to the same HTTP routes the desktop app uses — there is
no remote service. Everything runs against `http://localhost:3001` by
default, so your data never leaves the machine.

## Install (workspace-local)

The SDK ships inside this monorepo. Add it to a workspace package with:

```jsonc
// your-package/package.json
{
  "dependencies": {
    "@omninity/sdk": "workspace:*"
  }
}
```

Then `pnpm install` from the repo root.

## Hello, Operator

```ts
import { OmninityClient } from "@omninity/sdk";

const op = new OmninityClient({ tenantId: "ws_local" });

const run = await op.runs.create({ goal: "Summarise my inbox" });
console.log(run.id, run.status);
```

The client throws `ApiError` for any non-2xx response. The `code` field
mirrors the API's error envelope (`ApiError#code`) so you can branch
without parsing strings.

## Streaming events

```ts
const ctrl = new AbortController();
process.once("SIGINT", () => ctrl.abort());

for await (const ev of op.events.stream({ signal: ctrl.signal })) {
  console.log(ev.type, ev.data);
}
```

`stream()` is a long-poll wrapper around `/api/events/recent`. For
push-based delivery, register a webhook subscription (see
[`webhooks.md`](./webhooks.md)).

## CLI

The same primitives are exposed by the `op` CLI in
`@omninity/sdk-cli`:

```bash
pnpm --filter @omninity/sdk-cli op run "Plan my week"
pnpm --filter @omninity/sdk-cli op status run_abc123
pnpm --filter @omninity/sdk-cli op events tail
```

Set `OMNINITY_TENANT_ID` and `OMNINITY_BASE_URL` to skip the
`--tenant` / `--baseUrl` flags.
