/**
 * Top-level `OmninityClient` — groups resource namespaces so callers
 * write `op.runs.create(...)` rather than `createRun(http, ...)`.
 *
 * Every namespace is a stateless object that closes over the shared
 * HTTP context resolved in the constructor.
 */
import { request, resolveOptions, type InternalHttpOptions } from "./http";
import type {
  AgentRun,
  CreateRunInput,
  CreateWebhookSubscriptionInput,
  OmninityClientOptions,
  OpEvent,
  OpEventType,
  PluginInvokeInput,
  PluginInvokeResult,
  PluginTool,
  RegisterPluginToolInput,
  WebhookSubscription,
} from "./types";

interface ListEventsOptions {
  limit?: number;
  afterId?: string;
  type?: OpEventType;
}

export class OmninityClient {
  private readonly http: InternalHttpOptions;

  constructor(opts: OmninityClientOptions) {
    this.http = resolveOptions(opts);
  }

  /** Direct access to the resolved base URL (handy for diagnostics). */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  readonly runs = {
    create: (input: CreateRunInput): Promise<AgentRun> =>
      request<AgentRun>(this.http, "POST", "/api/agent/runs", input),
    get: (id: string): Promise<AgentRun> =>
      request<AgentRun>(this.http, "GET", `/api/agent/runs/${encodeURIComponent(id)}`),
    cancel: (id: string): Promise<AgentRun> =>
      request<AgentRun>(
        this.http,
        "POST",
        `/api/agent/runs/${encodeURIComponent(id)}/cancel`,
      ),
  };

  readonly plugins = {
    list: async (): Promise<PluginTool[]> => {
      const data = await request<{ items: PluginTool[] }>(
        this.http,
        "GET",
        "/api/plugins/tools",
      );
      return data.items;
    },
    register: (input: RegisterPluginToolInput): Promise<PluginTool> =>
      request<PluginTool>(this.http, "POST", "/api/plugins/tools", input),
    get: (id: string): Promise<PluginTool> =>
      request<PluginTool>(
        this.http,
        "GET",
        `/api/plugins/tools/${encodeURIComponent(id)}`,
      ),
    update: (
      id: string,
      patch: Partial<RegisterPluginToolInput> & { enabled?: boolean },
    ): Promise<PluginTool> =>
      request<PluginTool>(
        this.http,
        "PATCH",
        `/api/plugins/tools/${encodeURIComponent(id)}`,
        patch,
      ),
    delete: (id: string): Promise<{ id: string; deleted: boolean }> =>
      request(
        this.http,
        "DELETE",
        `/api/plugins/tools/${encodeURIComponent(id)}`,
      ),
    invoke: (id: string, body: PluginInvokeInput): Promise<PluginInvokeResult> =>
      request<PluginInvokeResult>(
        this.http,
        "POST",
        `/api/plugins/tools/${encodeURIComponent(id)}/invoke`,
        body,
      ),
  };

  readonly webhooks = {
    list: async (): Promise<WebhookSubscription[]> => {
      const data = await request<{ items: WebhookSubscription[] }>(
        this.http,
        "GET",
        "/api/webhooks/subscriptions",
      );
      return data.items;
    },
    create: (input: CreateWebhookSubscriptionInput): Promise<WebhookSubscription> =>
      request<WebhookSubscription>(
        this.http,
        "POST",
        "/api/webhooks/subscriptions",
        input,
      ),
    get: (id: string): Promise<WebhookSubscription> =>
      request<WebhookSubscription>(
        this.http,
        "GET",
        `/api/webhooks/subscriptions/${encodeURIComponent(id)}`,
      ),
    update: (
      id: string,
      patch: Partial<CreateWebhookSubscriptionInput> & { enabled?: boolean },
    ): Promise<WebhookSubscription> =>
      request<WebhookSubscription>(
        this.http,
        "PATCH",
        `/api/webhooks/subscriptions/${encodeURIComponent(id)}`,
        patch,
      ),
    delete: (id: string): Promise<{ id: string; deleted: boolean }> =>
      request(
        this.http,
        "DELETE",
        `/api/webhooks/subscriptions/${encodeURIComponent(id)}`,
      ),
  };

  readonly events = {
    recent: (opts: ListEventsOptions = {}): Promise<OpEvent[]> =>
      this.recentEvents(opts),
    /**
     * Long-poll iterator. Yields events as they arrive on the bus.
     * Cancellation: pass an `AbortSignal`; loop exits cleanly on abort.
     */
    stream: (
      options: ListEventsOptions & {
        signal?: AbortSignal;
        pollIntervalMs?: number;
      } = {},
    ): AsyncGenerator<OpEvent> => this.streamEvents(options),
  };

  private async recentEvents(opts: ListEventsOptions): Promise<OpEvent[]> {
    const data = await request<{ items: OpEvent[] }>(
      this.http,
      "GET",
      "/api/events/recent",
      undefined,
      { limit: opts.limit, afterId: opts.afterId, type: opts.type },
    );
    return data.items;
  }

  private async *streamEvents(
    options: ListEventsOptions & {
      signal?: AbortSignal;
      pollIntervalMs?: number;
    },
  ): AsyncGenerator<OpEvent> {
    const interval = Math.max(options.pollIntervalMs ?? 1_000, 100);
    let cursor: string | undefined = options.afterId;
    while (!options.signal?.aborted) {
      const opts: ListEventsOptions = {
        limit: options.limit ?? 50,
        ...(cursor ? { afterId: cursor } : {}),
        ...(options.type ? { type: options.type } : {}),
      };
      const items = await this.recentEvents(opts);
      for (const ev of items) {
        cursor = ev.id;
        yield ev;
      }
      if (options.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}
