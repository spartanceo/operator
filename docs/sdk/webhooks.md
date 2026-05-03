# Webhooks

Webhook subscriptions push event payloads to a local URL whenever the
in-process event bus publishes a matching event. They complement the
polling endpoint (`/api/events/recent`).

## Subscribe

```ts
await op.webhooks.create({
  url: "http://localhost:9000/op-events",
  label: "Local listener",
  eventTypes: ["task_completed", "approval_requested"],
  secret: "a-shared-secret",
});
```

Empty `eventTypes` means *all* events. The URL must be loopback-only.

## Receive

Each delivery includes:

- `Content-Type: application/json`
- `X-Omninity-Event` — the event type
- `X-Omninity-Event-Id` — bus ID, useful for dedup
- `X-Omninity-Signature` — `sha256=<hex>` HMAC of the raw body

```ts
import { createServer } from "node:http";
import { verifyEventSignature } from "@omninity/sdk/webhooks";

createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    try {
      const event = verifyEventSignature(
        process.env.OP_WEBHOOK_SECRET ?? "",
        req.headers["x-omninity-signature"] as string | undefined,
        buf,
      );
      console.log("got", event.type, event.data);
      res.statusCode = 204;
      res.end();
    } catch (err) {
      res.statusCode = 401;
      res.end((err as Error).message);
    }
  });
}).listen(9000, "127.0.0.1");
```

## Reliability

Each delivery has a 5 s timeout. Failures bump `failureCount`; after
**10 consecutive failures** the subscription is auto-disabled so a
dead listener can't hold up the bus. Re-enable it via:

```ts
await op.webhooks.update("whsub_…", { enabled: true });
```

That call also resets the failure counter.
