/**
 * Plugin sidecar helper — wraps the boilerplate for hosting a tool
 * implementation that the Operator can invoke. The sidecar is a tiny
 * HTTP server that the Operator POSTs `{input}` to; you implement
 * `handler(input, ctx)` and return `{output}`.
 *
 * This helper is framework-free — it returns a `(req, res)`-style
 * Node listener so it works with raw `http`, `express`, `fastify`,
 * etc.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface PluginHandlerContext {
  tenantId: string;
  workspaceId: string;
}

export type PluginHandler = (
  input: Record<string, unknown>,
  ctx: PluginHandlerContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface CreatePluginSidecarOptions {
  handler: PluginHandler;
  /** Optional bearer token check. */
  authToken?: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      buf += c;
      // Cap at 1 MiB so a hostile caller can't OOM us.
      if (buf.length > 1_048_576) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Returns a listener compatible with `http.createServer(...)`. POSTs
 * are treated as invocations; everything else returns 405.
 */
export function createPluginSidecar(
  opts: CreatePluginSidecarOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        if (req.method !== "POST") {
          send(res, 405, { success: false, error: { code: "METHOD", message: "POST only" } });
          return;
        }
        if (opts.authToken) {
          const expected = `Bearer ${opts.authToken}`;
          if (req.headers["authorization"] !== expected) {
            send(res, 401, {
              success: false,
              error: { code: "AUTH", message: "Bad authorization" },
            });
            return;
          }
        }
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || "{}") as { input?: Record<string, unknown> };
        const ctx: PluginHandlerContext = {
          tenantId: String(req.headers["x-omninity-tenant"] ?? ""),
          workspaceId: String(req.headers["x-omninity-workspace"] ?? ""),
        };
        const output = await opts.handler(parsed.input ?? {}, ctx);
        send(res, 200, { success: true, data: { output } });
      } catch (err) {
        send(res, 500, {
          success: false,
          error: { code: "PLUGIN_ERROR", message: (err as Error).message },
        });
      }
    })();
  };
}
