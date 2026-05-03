# SDK Recipes

Short, copy-pasteable snippets for the most common Operator SDK
workflows.

## Run a task and stream events

```ts
import { OmninityClient } from "@omninity/sdk";

const op = new OmninityClient({ tenantId: "ws_local" });
const run = await op.runs.create({ goal: "Triage today's email" });

const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 30_000);
for await (const ev of op.events.stream({ signal: ctrl.signal })) {
  if (ev.type === "task_completed" && ev.data.runId === run.id) break;
  if (ev.type === "approval_requested") console.warn("Needs approval", ev.data);
}
```

## Custom tool: send a Slack DM

```ts
import { createServer } from "node:http";
import { createPluginSidecar } from "@omninity/sdk/plugins";

createServer(
  createPluginSidecar({
    async handler({ to, message }) {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.SLACK_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: to, text: message }),
      });
      return { delivered: true };
    },
  }),
).listen(7077, "127.0.0.1");
```

Then register from the CLI:

```bash
op plugin register ./slack-dm.tool.json
```

## React to an approval and decide programmatically

```ts
for await (const ev of op.events.stream()) {
  if (ev.type !== "approval_requested") continue;
  const id = String(ev.data.id);
  // Auto-approve low-risk reads, prompt the user otherwise.
  await fetch(`${op.baseUrl}/api/agent/approvals/${id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant-id": "ws_local" },
    body: JSON.stringify({ decision: "approved", note: "auto: low-risk" }),
  });
}
```
