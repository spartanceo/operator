/**
 * `@omninity/sdk` — local-first JS/TS client for the Omninity Operator API.
 *
 * The SDK is a thin wrapper over the Operator's HTTP routes. It assumes
 * the API is running at `http://localhost:3001` (overridable). Every
 * call sends the tenant header so multi-workspace separation is honoured.
 *
 * Usage:
 *   import { OmninityClient } from "@omninity/sdk";
 *   const op = new OmninityClient({ tenantId: "ws_local" });
 *   const run = await op.runs.create({ goal: "Summarise inbox" });
 *   for await (const evt of op.events.stream()) handle(evt);
 */
export { OmninityClient } from "./client";
export type {
  OmninityClientOptions,
  AgentRun,
  CreateRunInput,
  PluginTool,
  RegisterPluginToolInput,
  PluginInvokeInput,
  PluginInvokeResult,
  WebhookSubscription,
  CreateWebhookSubscriptionInput,
  OpEvent,
  OpEventType,
} from "./types";
export { ApiError } from "./errors";
