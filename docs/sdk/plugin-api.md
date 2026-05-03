# Plugin Tools

Plugin tools are custom tool implementations the Operator can call from
the agent loop. You host the implementation as a tiny HTTP sidecar on
loopback; the Operator validates the input, POSTs it to your sidecar,
and threads the output back into the run.

## 1. Build a sidecar

```ts
import { createServer } from "node:http";
import { createPluginSidecar } from "@omninity/sdk/plugins";

const handler = createPluginSidecar({
  authToken: "shh",
  async handler(input, ctx) {
    return { greeting: `Hello, ${String(input.name ?? "world")}` };
  },
});

createServer(handler).listen(8765, "127.0.0.1");
```

The sidecar receives the validated input plus tenant headers
(`x-omninity-tenant`, `x-omninity-workspace`). Return a plain object —
the SDK helper wraps it in the standard `{success, data: { output }}`
envelope.

## 2. Register the tool

```ts
import { OmninityClient } from "@omninity/sdk";

const op = new OmninityClient({ tenantId: "ws_local" });

await op.plugins.register({
  name: "greeter",
  description: "Returns a friendly greeting",
  riskLevel: "low",
  invokeUrl: "http://localhost:8765",
  authToken: "shh",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  },
});
```

`invokeUrl` **must** point to a loopback host — `localhost`,
`127.0.0.1`, `::1`, or `*.localhost`. Any other host is rejected with
`PLUGIN_TOOL_VALIDATION` so a misconfigured tool can't leak data.

## 3. Risk levels & approvals

`riskLevel` mirrors the built-in tool catalogue:

| Level    | Behaviour                                                                |
|----------|--------------------------------------------------------------------------|
| `low`    | Invoked freely.                                                          |
| `medium` | Invoked freely (logged).                                                 |
| `high`   | The orchestrator inserts an approval row before invoking.                |
| `critical` | Same as `high`, plus the privacy log records a high-severity event.    |

## 4. Invoke directly

```ts
const result = await op.plugins.invoke("pt_…", { input: { name: "Ada" } });
console.log(result.output.greeting);
```

The CLI mirrors this with `op plugin invoke <id> '<json>'`.
